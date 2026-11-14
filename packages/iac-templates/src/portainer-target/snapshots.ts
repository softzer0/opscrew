// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are Compose and shell syntax, not JavaScript templates.

import {
  type DeployPlan,
  keepSnapshotsOf,
  type PlanService,
  snapshotOffsiteOf,
  snapshotScheduleOf,
  snapshotsOn,
} from "@opscrew/plan-schema";
import { dataDirs, serviceSpec } from "../catalog";
import { offsiteExpires } from "../infra/storage";
import {
  AGE_BINARY,
  ageFunctions,
  offsiteLogin,
  offsiteRetention,
  offsiteRoot,
  PORTAINER_OFFSITE_VARIABLES,
  rcloneSettings,
} from "../offsite";
import { IMAGES } from "../pins";
import { portainerTarget } from "../providers";
import {
  FILES_VOLUME,
  memoryLimit,
  type RenderedServices,
  SQLITE_VOLUME,
} from "../runtime/components";
import { composeLiteral, hardened, shellQuote } from "../runtime/services";
import {
  DRAGONFLY_SAVE,
  filesTar,
  onlineCopy,
  REDIS_CLIENTS,
  type SnapshotPart,
  SQLITE_COPY,
  scheduleHours,
  snapshotParts,
} from "../workflow/snapshots";

/** The snapshots volume's key in the stack (`opscrew-<app>_snapshots`, D12), and where every snapshot service mounts it. */
export const SNAPSHOTS_VOLUME = "snapshots";
const DIR = "/snapshots";

/**
 * The file in the snapshots volume that names the image running now (`ghcr.io/…@sha256:<hex>`):
 * the stamp writes it once a new version started, so before a release it still names the
 * outgoing one, and a failed release leaves it as it was.
 */
export const RUNNING_IMAGE_FILE = `${DIR}/.running`;

/**
 * The file in the snapshots volume that names, on its first line, the image
 * (`ghcr.io/…@sha256:<hex>`) whose data `opscrew rollback` restored there (024 plan.md D19), and on
 * its second the `opscrew restore` of the copy taken just before, the way out of a stuck rollback.
 * While it names another image, the snapshot before a release fails, so neither the release
 * command nor the app, its workers or cron of another version start on that data, the workflow's
 * revert after a failed health check included. The rollback removes it once its run succeeded, or
 * once it put the data from before back; so does that restore.
 */
export const RESTORED_IMAGE_FILE = `${DIR}/.restored`;

/** The snapshots volume's mount in a service of the stack. */
export const SNAPSHOTS_MOUNT = `${SNAPSHOTS_VOLUME}:${DIR}`;

/** The off-server copy's tools volume, where it keeps age's release archive. */
const TOOLS_VOLUME = "snapshot_tools";

/**
 * The stack's volumes for its snapshots, by their keys: `snapshots` whenever the plan has data (a
 * stateful service, the `sqlite` volume or the `files` volume), which `opscrew snapshot` can copy
 * by hand, or the off-server copy is on, and the off-server copy's `snapshot_tools`; none
 * otherwise. With the `snapshots` volume, the stamp writes the running image there, so every
 * snapshot knows its version.
 */
export function snapshotVolumes(plan: DeployPlan): string[] {
  const offsite = snapshotOffsiteOf(plan) !== undefined;
  if (snapshotParts(plan).length === 0 && !offsite) return [];
  return [SNAPSHOTS_VOLUME, ...(offsite ? [TOOLS_VOLUME] : [])];
}

/**
 * One file of a snapshot on Portainer: an online part of the servers' ({@link snapshotParts}; its
 * name also its markers' name), a service's dump or the tar of the app's SQLite volume or kept
 * folder. The stack's scheduled and pre-release parts run `copy`, and so can a one-off by hand.
 */
export interface PortainerSnapshotPart extends SnapshotPart {
  /** The service it copies; undefined for the app's volumes. */
  service?: PlanService;
  /**
   * The image that runs `copy`: the service's own pinned image, the pinned python for SQLite, the
   * pinned busybox for the kept folder.
   */
  image: string;
  /**
   * The part's mounts besides the snapshots volume, by the stack's volume key, the only ones its
   * container gets: SQLite's `sqlite` volume read-write at `/sqlite`; the kept folder's `files`
   * read-only at `/files`; a service's data volumes read-only at its data folders (`queue_data` at
   * `/data`).
   */
  mounts: { volume: string; target: string; readOnly: boolean }[];
  /**
   * Writes the copy to the file `"$t"` (sh, as root), inside the part's container: a service's
   * part with the service's environment (`portainerServiceEnvironment`) on the stack's network
   * and its data volumes read-only; SQLite with the `sqlite` volume read-write at `/sqlite`; the
   * kept folder as one tar of `/files`. Exit 3: nothing to copy yet (an empty SQLite volume), the
   * part is skipped.
   */
  copy: string;
}

/** Where the SQLite part mounts the app's `sqlite` volume. */
const SQLITE_MOUNT = "/sqlite";

/** Where the kept folder's part mounts the app's `files` volume. */
const FILES_MOUNT = "/files";

/** A part's own mounts as Compose `volumes:` entries. */
function mountEntries(part: PortainerSnapshotPart): string[] {
  return part.mounts.map(
    ({ volume, target, readOnly }) => `${volume}:${target}${readOnly ? ":ro" : ""}`,
  );
}

/**
 * The copies a snapshot of `plan` makes on Portainer while everything runs: the online parts of
 * {@link snapshotParts}, in the plan's order, each from a container of its own image with the
 * service's environment (research R2 and R7, S1), no password in an argument. The databases,
 * Valkey and Redis copy as on servers ({@link onlineCopy}); Dragonfly saves the file itself (it has
 * no SYNC for `--rdb`), which the part reads from its data volume; the app's SQLite volume runs the
 * servers' program (plan.md D6): the whole volume as one tar, exit 3 when it is empty, which `take`
 * records as skipped; the kept folder is one tar of its volume, as on servers. The stack's parts
 * run these.
 */
export function portainerSnapshotParts(plan: DeployPlan): PortainerSnapshotPart[] {
  return snapshotParts(plan)
    .filter((part) => part.online)
    .map((part): PortainerSnapshotPart => {
      if (part.kind === "files") {
        return {
          ...part,
          image: IMAGES.busybox.ref,
          mounts: [{ volume: FILES_VOLUME, target: FILES_MOUNT, readOnly: true }],
          copy: `${filesTar(FILES_MOUNT)} > "$t"`,
        };
      }
      const service = plan.services.find((each) => each.name === part.name);
      if (part.kind === "sqlite" || service === undefined) {
        return {
          ...part,
          image: IMAGES.python.ref,
          mounts: [{ volume: SQLITE_VOLUME, target: SQLITE_MOUNT, readOnly: false }],
          copy: `python3 -c ${shellQuote(SQLITE_COPY)} ${SQLITE_MOUNT} > "$t"`,
        };
      }
      const { cli, password } = REDIS_CLIENTS.dragonfly;
      return {
        ...part,
        service,
        image: IMAGES[serviceSpec(service.kind).image].ref,
        // The service's data volumes, as the stack names them (so Docker adds no anonymous ones
        // for the image's; Dragonfly's part reads its saved file there).
        mounts: dataDirs(serviceSpec(service.kind)).map(([name, dir]) => ({
          volume: `${service.name}_${name}`,
          target: dir,
          readOnly: true,
        })),
        // redis-cli answers an error with exit code 0, so Dragonfly's reply is read.
        copy:
          onlineCopy(part, '"$t"') ??
          `REDISCLI_AUTH="$${password}" ${cli} -h ${service.name} SAVE RDB ${DRAGONFLY_SAVE} | grep -qx OK && cat /data/${DRAGONFLY_SAVE}.rdb > "$t"`,
      };
    });
}

/**
 * The shell function `take <folder>` of one part (R7, S2), as root: makes the folder, writes the
 * copy as `<file>.tmp`, renames it, then touches
 * `<name>.done`; `<name>.skipped` when the copy exits 3 (nothing to copy yet), and
 * `<name>.failed` (returning 1) when it failed.
 */
function takeFunction(part: PortainerSnapshotPart): string[] {
  const marker = (end: string) => `"$1"/${part.name}.${end}`;
  return [
    "take() {",
    `  mkdir -p "$1" && rm -f ${marker("done")} ${marker("failed")} ${marker("skipped")} || return 1`,
    `  t="$1"/${part.file}.tmp`,
    `  (umask 077 && ${part.copy}); r=$?`,
    `  if [ "$r" = 0 ] && mv "$t" "$1"/${part.file}; then`,
    `    touch ${marker("done")}`,
    `  elif [ "$r" = 3 ]; then`,
    `    rm -f "$t"; touch ${marker("skipped")}`,
    "  else",
    `    rm -f "$t"; touch ${marker("failed")}`,
    `    echo ${shellQuote(`OpsCrew: the snapshot of ${part.name} failed; its output is above.`)} >&2`,
    "    return 1",
    "  fi",
    "}",
  ];
}

/**
 * The outgoing version before a release, as `$hex`, or an exit: none in a rollback (whose release
 * switch is `skip`), before the stamp named any running image, or when the image doesn't change.
 */
const OUTGOING = [
  `if [ "$OPSCREW_RELEASE" = skip ] || [ ! -f ${RUNNING_IMAGE_FILE} ]; then exit 0; fi`,
  `out=$(cat ${RUNNING_IMAGE_FILE})`,
  'if [ "$out" = "$OPSCREW_APP_IMAGE" ]; then exit 0; fi',
  "hex=${out##*@sha256:}",
  'case "$hex" in *[!0-9a-f]*) hex= ;; esac',
  'if [ "${#hex}" -ne 64 ]; then',
  `  echo ${shellQuote(`OpsCrew: ${RUNNING_IMAGE_FILE} in the snapshots volume names no image pinned by digest, so the snapshot before this release can't be taken.`)} >&2`,
  "  exit 1",
  "fi",
];

/**
 * Fails while {@link RESTORED_IMAGE_FILE} names another image than the one deployed, by its digest:
 * a rollback restored the data for that one.
 */
const RESTORED_GUARD = [
  `if [ -f ${RESTORED_IMAGE_FILE} ] && [ "$(sed -n '1s/.*@//p' ${RESTORED_IMAGE_FILE})" != "\${OPSCREW_APP_IMAGE##*@}" ]; then`,
  `  echo "OpsCrew: opscrew rollback restored this stack's data for $(sed -n 1p ${RESTORED_IMAGE_FILE}), so no other version starts on it until that rollback ends (${RESTORED_IMAGE_FILE} names it). If that rollback is stuck, run $(sed -n 2p ${RESTORED_IMAGE_FILE}) on the computer that ran it; it finishes the rollback and removes ${RESTORED_IMAGE_FILE}." >&2`,
  "  exit 1",
  "fi",
];

/** A scheduled slot that hasn't finished is given up after this long, at most the slot's length. */
const GIVE_UP_SECONDS = 6 * 3600;

/**
 * The finalizers' functions (busybox sh, as root):
 * - `finish <folder> <id> <kind>`: writes `about.json` (plan.md 1.: the id, the kind, when, the
 *   running version's digest and each part's kind, file, size and image (a service's), or
 *   `skipped` or `failed`), drops the markers, makes the files 600 and the folder 700, root's, and
 *   renames `<id>.partial` to `<id>`;
 * - `prune <kind> <n>`: keeps only the newest `n` finished snapshots of that kind, never one being
 *   written (`.partial`, or `.taking` by hand).
 */
function finalizerFunctions(all: PortainerSnapshotPart[]): string[] {
  const entries = all.flatMap((part, index) => [
    ...(index > 0 ? ["    printf ,"] : []),
    `    if [ -f "$1"/${part.name}.done ] && [ -f "$1"/${part.file} ]; then`,
    `      printf '{"name":"${part.name}","kind":"${part.kind}","file":"${part.file}","size":%s${part.service === undefined ? "" : `,"image":"${part.image}"`}}' "$(stat -c %s "$1"/${part.file})"`,
    `    elif [ -f "$1"/${part.name}.skipped ]; then`,
    `      printf '{"name":"${part.name}","kind":"${part.kind}","skipped":true}'`,
    "    else",
    `      printf '{"name":"${part.name}","kind":"${part.kind}","failed":true}'`,
    "    fi",
  ]);
  return [
    "finish() {",
    `  img=$(cat ${RUNNING_IMAGE_FILE} 2> /dev/null)`,
    "  {",
    `    printf '{"id":"%s","kind":"%s","taken":"%s","version":"%s","services":[' "$2" "$3" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "\${img##*@}"`,
    ...entries,
    "    printf ']}\\n'",
    '  } > "$1"/.about || return 1',
    '  rm -f "$1"/*.done "$1"/*.failed "$1"/*.skipped "$1"/*.tmp',
    '  mv "$1"/.about "$1"/about.json && chown -R 0:0 "$1" && chmod 600 "$1"/* && chmod 700 "$1" || return 1',
    `  rm -rf ${DIR}/"$2" && mv "$1" ${DIR}/"$2"`,
    "}",
    "prune() {",
    `  for d in ${DIR}/*; do`,
    '    case "$d" in *.partial|*.taking) continue ;; esac',
    `    if [ -f "$d"/about.json ] && grep -q "\\"kind\\":\\"$1\\"" "$d"/about.json; then echo "$(sed -n 's/.*"taken":"\\([^"]*\\)".*/\\1/p' "$d"/about.json) $d"; fi`,
    `  done | sort -r | sed "1,$2d" | while read -r _ d; do rm -rf "$d"; done`,
    "}",
  ];
}

/**
 * The placeholders the deploy workflow fills in the stack: the image it deploys, and the release
 * switch (`run`, or `skip` in a rollback).
 */
export interface DeployFilled {
  image: string;
  release: string;
}

/** What the snapshots add to the app's stack. */
export interface StackSnapshots {
  services: Record<string, object>;
  /** What the release command and the app wait for: the snapshot before the release. */
  ready: Record<string, { condition: string }>;
  /** True when the stamp writes the running image into the snapshots volume. */
  stamp: boolean;
}

/** The SQLite part's memory limit: Python and SQLite's page cache. */
const SQLITE_MEMORY_MB = 128;

/** The kept folder's part's memory limit: busybox's tar. */
const FILES_MEMORY_MB = 32;

/** The finalizers' memory limit: a busybox shell loop. */
const FINALIZER_MEMORY_MB = 16;

/** The off-server copy's memory limit: age and rclone's multipart upload buffers. */
const OFFSITE_MEMORY_MB = 256;

/**
 * A container that runs `part`'s `script`, as root, with the part's `mounts` and the snapshots
 * volume: a service's part on the service's own pinned image, with its environment, on the
 * stack's network; the parts of the app's volumes (SQLite on the pinned python image, the kept
 * folder on busybox) with no network.
 */
function partContainer(
  part: PortainerSnapshotPart,
  backing: RenderedServices,
  restart: "no" | "unless-stopped",
  environment: Record<string, string>,
  script: string[],
): object {
  const run = { entrypoint: ["sh", "-c", composeLiteral(script.join("\n"))] };
  if (part.service === undefined) {
    return {
      image: part.image,
      restart,
      user: "0:0",
      network_mode: "none",
      environment,
      ...run,
      volumes: [...mountEntries(part), SNAPSHOTS_MOUNT],
      ...memoryLimit(part.kind === "files" ? FILES_MEMORY_MB : SQLITE_MEMORY_MB),
      ...hardened(),
    };
  }
  const service = backing.services[part.service.name] as { environment?: Record<string, string> };
  return {
    image: part.image,
    restart,
    user: "0:0",
    environment: { ...service.environment, ...environment },
    ...run,
    volumes: [...mountEntries(part), SNAPSHOTS_MOUNT],
    depends_on: { [part.service.name]: { condition: "service_healthy" } },
    ...memoryLimit(part.service.memoryMb),
    ...hardened({ internal: true }),
  };
}

/** A busybox container as root with the snapshots volume only, running `script`. */
function finalizer(script: string[], fields: object): object {
  return {
    image: IMAGES.busybox.ref,
    user: "0:0",
    network_mode: "none",
    ...fields,
    entrypoint: ["sh", "-c", composeLiteral(script.join("\n"))],
    volumes: [SNAPSHOTS_MOUNT],
    ...memoryLimit(FINALIZER_MEMORY_MB),
    ...hardened(),
  };
}

/**
 * The scheduled snapshots (`snapshots.schedule`, R7 S2): one service per part, each a loop that
 * sleeps to the next slot of `every` (slots counted from the epoch, in UTC) and copies into
 * `<id>.partial`, the id the slot's UTC time (`20261106T190000Z`); and the `snapshots` service,
 * which finishes a slot once every part is done or failed, or the slot is older than the give-up
 * time, then keeps the last `keep`.
 */
function scheduled(
  plan: DeployPlan,
  all: PortainerSnapshotPart[],
  backing: RenderedServices,
): Record<string, object> {
  const schedule = snapshotScheduleOf(plan);
  if (schedule === undefined) return {};
  const every = scheduleHours(schedule.every) * 3600;
  const services: Record<string, object> = {};
  for (const part of all) {
    services[`snapshots-${part.name}`] = partContainer(
      part,
      backing,
      "unless-stopped",
      { OPSCREW_SNAPSHOT_EVERY: String(every) },
      [
        ...takeFunction(part),
        "while :; do",
        "  now=$(date +%s)",
        "  slot=$(( (now / $OPSCREW_SNAPSHOT_EVERY + 1) * $OPSCREW_SNAPSHOT_EVERY ))",
        "  sleep $(( slot - now ))",
        `  take ${DIR}/"$(date -u -d "@$slot" +%Y%m%dT%H%M%SZ)".partial`,
        "done",
      ],
    );
  }
  const settled = all
    .map(
      (part) =>
        `{ [ -e "$d"/${part.name}.done ] || [ -e "$d"/${part.name}.failed ] || [ -e "$d"/${part.name}.skipped ]; }`,
    )
    .join(" && ");
  services.snapshots = finalizer(
    [
      ...finalizerFunctions(all),
      "while :; do",
      "  now=$(date +%s)",
      `  for d in ${DIR}/*T*Z.partial; do`,
      '    [ -d "$d" ] || continue',
      "    id=${d##*/}; id=${id%.partial}",
      // A part that finished after its slot was given up: the slot is already written.
      `    if [ -e ${DIR}/"$id" ]; then rm -rf "$d"; continue; fi`,
      '    start=$(date -u -D %Y%m%dT%H%M%SZ -d "$id" +%s) || continue',
      `    if ${settled} || [ "$now" -ge $(( start + $OPSCREW_SNAPSHOT_GIVE_UP )) ]; then`,
      `      finish "$d" "$id" scheduled && prune scheduled ${schedule.keep}`,
      "    fi",
      "  done",
      "  sleep 10",
      "done",
    ],
    {
      restart: "unless-stopped",
      environment: { OPSCREW_SNAPSHOT_GIVE_UP: String(Math.min(every, GIVE_UP_SECONDS)) },
    },
  );
  return services;
}

/**
 * The snapshot before each release (019's, on Portainer): a one-off per part copying into
 * `<hex>.partial`, `hex` the outgoing image's digest, then the one-off `snapshot`, which finishes
 * it once every part succeeded and keeps the newest `deploy.keepSnapshots`. A failed part stops
 * the deploy before the release command and the new version, and the previous version keeps
 * serving. The finalizer first refuses an image other than the one a rollback restored the data
 * for ({@link RESTORED_IMAGE_FILE}). Each deploy recreates them, the image in their environment
 * being new.
 */
function beforeRelease(
  plan: DeployPlan,
  all: PortainerSnapshotPart[],
  backing: RenderedServices,
  deploy: DeployFilled,
): Record<string, object> {
  const services: Record<string, object> = {};
  const parts: Record<string, { condition: string }> = {};
  const environment = { OPSCREW_RELEASE: deploy.release, OPSCREW_APP_IMAGE: deploy.image };
  for (const part of all) {
    const name = `snapshot-${part.name}`;
    services[name] = partContainer(part, backing, "no", environment, [
      ...takeFunction(part),
      ...OUTGOING,
      `take ${DIR}/"$hex".partial`,
    ]);
    parts[name] = { condition: "service_completed_successfully" };
  }
  services.snapshot = finalizer(
    [
      ...finalizerFunctions(all),
      ...RESTORED_GUARD,
      ...OUTGOING,
      `finish ${DIR}/"$hex".partial "$hex" release && prune release ${keepSnapshotsOf(plan)}`,
    ],
    { restart: "no", environment, depends_on: parts },
  );
  return services;
}

/**
 * The off-server copy (`snapshots.offsite`, plan.md 7., R7 S2) on the pinned rclone image: it
 * fetches the pinned age's release archive with `rclone copyurl` and keeps it in its tools volume,
 * checking its SHA-256 and unpacking the binary before each use ({@link ageFunctions}). Every minute, each
 * finished snapshot without `offsite.done` streams file by file through `age -r <recipient>` into
 * `rclone rcat` (`backups/<id>/<file>.age` under {@link offsiteRoot}), `about.json` last, then gets
 * `offsite.done`; the snapshots before a release (named by their digest) stay here for the
 * rollback (D16). The login ({@link offsiteLogin}) and the recipient are stack variables. Where the
 * storage expires nothing itself ({@link offsiteExpires}: Spaces, the user's own bucket or SFTP
 * machine), a pass that copied a snapshot then deletes the copies older than `snapshots.offsite.days` (and on SFTP the folders that leaves
 * empty); a failed deletion only warns, and the next copy tries again.
 */
function offsite(plan: DeployPlan): Record<string, object> {
  const copy = snapshotOffsiteOf(plan);
  if (copy === undefined) return {};
  const { arch } = portainerTarget(plan.target);
  const v = PORTAINER_OFFSITE_VARIABLES;
  const root = offsiteRoot(plan, copy);
  // Where the storage expires nothing itself: Spaces, the user's own bucket or SFTP machine.
  const prunes = !offsiteExpires(copy.provider);
  const script = [
    "set -o pipefail",
    ...ageFunctions(arch),
    "put() {",
    "  age_ready || return 1",
    `  ${AGE_BINARY} -r "$${v.recipient}" < "$1" | rclone rcat ${shellQuote(`${root}/`)}"$2"`,
    "}",
    "umask 077",
    "while :; do",
    ...(prunes ? ["  copied=0"] : []),
    `  for d in ${DIR}/*; do`,
    // A snapshot being written: the schedule's and a release's `.partial`, one by hand `.taking`.
    '    case "$d" in *.partial|*.taking) continue ;; esac',
    // A snapshot before a release, named by its 64-hex digest, stays here for the rollback (D16).
    '    case "${d##*/}" in *[!0-9a-f]*) ;; *) continue ;; esac',
    '    if [ ! -f "$d"/about.json ] || [ -e "$d"/offsite.done ]; then continue; fi',
    "    id=${d##*/}; ok=1",
    '    for f in "$d"/*; do',
    '      case "${f##*/}" in about.json|offsite.done) continue ;; esac',
    '      put "$f" "$id/${f##*/}.age" || ok=0',
    "    done",
    '    if [ "$ok" = 1 ] && put "$d"/about.json "$id"/about.json.age; then',
    '      touch "$d"/offsite.done',
    ...(prunes ? ["      copied=1"] : []),
    "    else",
    '      echo "OpsCrew: the off-server copy of the snapshot $id failed; trying again in a minute." >&2',
    "    fi",
    "  done",
    ...(prunes
      ? [
          `  if [ "$copied" = 1 ] && ! ${offsiteRetention(copy, root)}; then`,
          `    echo "OpsCrew: the off-server copies older than ${copy.days} days could not be deleted; the next copy tries again." >&2`,
          "  fi",
        ]
      : []),
    "  sleep 60",
    "done",
  ];
  return {
    offsite: {
      image: IMAGES.rclone.ref,
      restart: "unless-stopped",
      user: "0:0",
      environment: {
        ...Object.fromEntries(
          Object.entries(rcloneSettings(copy)).map(([name, value]) => [
            name,
            composeLiteral(value),
          ]),
        ),
        ...Object.fromEntries(
          Object.entries(offsiteLogin(copy)).map(([name, variable]) => [name, `\${${variable}}`]),
        ),
        [v.recipient]: `\${${v.recipient}}`,
      },
      entrypoint: ["/bin/sh", "-c", composeLiteral(script.join("\n"))],
      volumes: [SNAPSHOTS_MOUNT, `${TOOLS_VOLUME}:/tools`],
      ...memoryLimit(OFFSITE_MEMORY_MB),
      ...hardened({ internal: true }),
    },
  };
}

/**
 * The snapshots of the app's stack (plan.md 4.): the scheduled services, the snapshot before each
 * release and the off-server copy, each only when the plan asks for it, all writing into the
 * stack's `snapshots` volume ({@link snapshotVolumes}). Stop-only kinds are never scheduled here (Decision D3).
 */
export function stackSnapshots(
  plan: DeployPlan,
  backing: RenderedServices,
  deploy: DeployFilled,
): StackSnapshots {
  const all = portainerSnapshotParts(plan);
  // Only the online parts: Portainer stops no service (D3), so a stop-only service alone gets none.
  const release = all.length > 0 && snapshotsOn(plan);
  const services = {
    ...(all.length > 0 ? scheduled(plan, all, backing) : {}),
    ...(release ? beforeRelease(plan, all, backing, deploy) : {}),
    ...offsite(plan),
  };
  return {
    services,
    ready: release ? { snapshot: { condition: "service_completed_successfully" } } : {},
    stamp: snapshotVolumes(plan).length > 0,
  };
}
