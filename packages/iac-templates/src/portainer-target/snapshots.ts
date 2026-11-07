// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are Compose and shell syntax, not JavaScript templates.

import {
  DATABASE_KINDS,
  type DeployPlan,
  keepSnapshotsOf,
  ONLINE_SNAPSHOT_KINDS,
  type PlanService,
  snapshotOffsiteOf,
  snapshotScheduleOf,
  snapshotsOn,
} from "@opscrew/plan-schema";
import { dataDirs, enabledServices, serviceSpec } from "../catalog";
import { ageFunctions, OFFSITE_PREFIX, RCLONE_PROVIDERS } from "../offsite";
import { IMAGES } from "../pins";
import { portainerTarget } from "../providers";
import { memoryLimit, type RenderedServices, SQLITE_VOLUME } from "../runtime/components";
import { composeLiteral, hardened, shellQuote } from "../runtime/services";
import { SQLITE_COPY, snapshotParts } from "../workflow/snapshots";

/** The snapshots volume's key in the stack (`opscrew-<app>_snapshots`, D12), and where every snapshot service mounts it. */
export const SNAPSHOTS_VOLUME = "snapshots";
const DIR = "/snapshots";

/**
 * The file in the snapshots volume that names the image running now (`ghcr.io/…@sha256:<hex>`):
 * the stamp writes it once a new version started, so before a release it still names the
 * outgoing one, and a failed release leaves it as it was.
 */
export const RUNNING_IMAGE_FILE = `${DIR}/.running`;

/** The snapshots volume's mount in a service of the stack. */
export const SNAPSHOTS_MOUNT = `${SNAPSHOTS_VOLUME}:${DIR}`;

/** The off-server copy's tools volume, where it keeps the checked age binary. */
const TOOLS_VOLUME = "snapshot_tools";

/**
 * The stack's volumes for its snapshots, by their keys: `snapshots` whenever the plan has data (a
 * stateful service or the `sqlite` volume), which `opscrew snapshot` can copy by hand, or the
 * off-server copy is on, and the off-server copy's `snapshot_tools`; none otherwise. With the
 * `snapshots` volume, the stamp writes the running image there, so every snapshot knows its
 * version.
 */
export function snapshotVolumes(plan: DeployPlan): string[] {
  const offsite = snapshotOffsiteOf(plan) !== undefined;
  if (snapshotParts(plan).length === 0 && !offsite) return [];
  return [SNAPSHOTS_VOLUME, ...(offsite ? [TOOLS_VOLUME] : [])];
}

/**
 * One file of a snapshot on Portainer: a service's dump, or the tar of the app's SQLite volume. The
 * stack's scheduled and pre-release parts run `copy`, and so can a one-off by hand.
 */
export interface PortainerSnapshotPart {
  /** The service's name (`sqlite` for the app's SQLite volume), also its markers' name. */
  name: string;
  kind: string;
  /** The file in the snapshot's folder. */
  file: string;
  /** The service it copies; undefined for SQLite. */
  service?: PlanService;
  /** The image that runs `copy`: the service's own pinned image, the pinned python for SQLite. */
  image: string;
  /**
   * The part's mounts besides the snapshots volume, by the stack's volume key, the only ones its
   * container gets: SQLite's `sqlite` volume read-write at `/sqlite`; a service's data volumes
   * read-only at its data folders (`queue_data` at `/data`).
   */
  mounts: { volume: string; target: string; readOnly: boolean }[];
  /**
   * Writes the copy to the file `"$t"` (sh, as root), inside the part's container: a service's
   * part with the service's environment (`portainerServiceEnvironment`) on the stack's network
   * and its data volumes read-only; SQLite with the `sqlite` volume read-write at `/sqlite`. Exit
   * 3: nothing to copy yet (an empty SQLite volume), the part is skipped.
   */
  copy: string;
}

/** The MongoDB tools' settings file inside the part's container, with the root password. */
const MONGO_CONFIG = "/tmp/opscrew-mongo.yaml";

/** The file name Dragonfly's `SAVE RDB` writes in its data folder, never a `dump*` it would load. */
const DRAGONFLY_SAVE = "opscrew-snapshot";

/**
 * Each online kind's copy of the running service `host` (research R2 and R7, S1), from a container
 * of its own image with the service's environment: no password in an argument. PostgreSQL's user
 * and database come from the stack's variables, as the service's own.
 */
const COPIES: Record<(typeof ONLINE_SNAPSHOT_KINDS)[number], (host: string) => string> = {
  postgres: (host) =>
    `PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -h ${host} -U "$POSTGRES_USER" -Fc -f "$t" "$POSTGRES_DB"`,
  mysql: (host) =>
    `MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysqldump -h ${host} -u root --single-transaction --routines --events --triggers --no-tablespaces app > "$t"`,
  mariadb: (host) =>
    `MYSQL_PWD="$MARIADB_ROOT_PASSWORD" mariadb-dump -h ${host} -u root --single-transaction --routines --events --triggers --no-tablespaces app > "$t"`,
  mongodb: (host) =>
    `printf "password: '%s'\\n" "$MONGO_INITDB_ROOT_PASSWORD" > ${MONGO_CONFIG} && mongodump --host ${host} --username app --authenticationDatabase admin --config ${MONGO_CONFIG} --db app --archive="$t" --gzip`,
  valkey: (host) => `REDISCLI_AUTH="$VALKEY_PASSWORD" valkey-cli -h ${host} --rdb "$t"`,
  redis: (host) => `REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli -h ${host} --rdb "$t"`,
  // Dragonfly has no SYNC for --rdb: it saves the file itself, which the part reads from its
  // data volume, mounted read-only (redis-cli answers an error with exit code 0, so the reply is read).
  dragonfly: (host) =>
    `REDISCLI_AUTH="$DFLY_requirepass" redis-cli -h ${host} SAVE RDB ${DRAGONFLY_SAVE} | grep -qx OK && cat /data/${DRAGONFLY_SAVE}.rdb > "$t"`,
};

/** Where the SQLite part mounts the app's `sqlite` volume. */
const SQLITE_MOUNT = "/sqlite";

/** A part's own mounts as Compose `volumes:` entries. */
function mountEntries(part: PortainerSnapshotPart): string[] {
  return part.mounts.map(
    ({ volume, target, readOnly }) => `${volume}:${target}${readOnly ? ":ro" : ""}`,
  );
}

/**
 * The copies a snapshot of `plan` makes on Portainer while everything runs, in the plan's order:
 * each service of the online kinds, then the app's SQLite volume. The stack's parts run these.
 */
export function portainerSnapshotParts(plan: DeployPlan): PortainerSnapshotPart[] {
  const services = enabledServices(plan).flatMap((service): PortainerSnapshotPart[] => {
    const kind = ONLINE_SNAPSHOT_KINDS.find((online) => online === service.kind);
    if (kind === undefined) return [];
    const database = DATABASE_KINDS.some((db) => db === kind);
    return [
      {
        name: service.name,
        kind,
        file: `${service.name}.${database ? "dump" : "rdb"}`,
        service,
        image: IMAGES[serviceSpec(kind).image].ref,
        // The service's data volumes, as the stack names them (so Docker adds no anonymous ones
        // for the image's; Dragonfly's part reads its saved file there).
        mounts: dataDirs(serviceSpec(kind)).map(([name, dir]) => ({
          volume: `${service.name}_${name}`,
          target: dir,
          readOnly: true,
        })),
        copy: COPIES[kind](service.name),
      },
    ];
  });
  const sqlite: PortainerSnapshotPart[] =
    plan.storage?.sqlite === undefined
      ? []
      : [
          {
            name: "sqlite",
            kind: "sqlite",
            file: "sqlite.tar",
            image: IMAGES.python.ref,
            mounts: [{ volume: SQLITE_VOLUME, target: SQLITE_MOUNT, readOnly: false }],
            // The servers' program (plan.md D6): the whole volume as one tar, every database copied
            // online; exit 3 when the volume is empty, which `take` records as skipped.
            copy: `python3 -c ${shellQuote(SQLITE_COPY)} ${SQLITE_MOUNT} > "$t"`,
          },
        ];
  return [...services, ...sqlite];
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

/** `every` in seconds: `daily`, `weekly` or `<n>h`. */
function everySeconds(every: string): number {
  if (every === "daily") return 86_400;
  if (every === "weekly") return 604_800;
  return Number.parseInt(every, 10) * 3600;
}

/** A scheduled slot that hasn't finished is given up after this long, at most the slot's length. */
const GIVE_UP_SECONDS = 6 * 3600;

/**
 * The finalizers' functions (busybox sh, as root):
 * - `finish <folder> <id> <kind>`: writes `about.json` (plan.md 1.: the id, the kind, when, the
 *   running version's digest and each part's kind, file and size, or `skipped` or `failed`), drops the markers,
 *   makes the files 600 and the folder 700, root's, and renames `<id>.partial` to `<id>`;
 * - `prune <kind> <n>`: keeps only the newest `n` finished snapshots of that kind, never one being
 *   written (`.partial`, or `.taking` by hand).
 */
function finalizerFunctions(all: PortainerSnapshotPart[]): string[] {
  const entries = all.flatMap((part, index) => [
    ...(index > 0 ? ["    printf ,"] : []),
    `    if [ -f "$1"/${part.name}.done ] && [ -f "$1"/${part.file} ]; then`,
    `      printf '{"name":"${part.name}","kind":"${part.kind}","file":"${part.file}","size":%s}' "$(stat -c %s "$1"/${part.file})"`,
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

/** The finalizers' memory limit: a busybox shell loop. */
const FINALIZER_MEMORY_MB = 16;

/** The off-server copy's memory limit: age and rclone's multipart upload buffers. */
const OFFSITE_MEMORY_MB = 256;

/**
 * A container that runs `part`'s `script`, as root, with the part's `mounts` and the snapshots
 * volume: a service's part on the service's own pinned image, with its environment, on the
 * stack's network; the SQLite part on the pinned python image with no network.
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
      ...memoryLimit(SQLITE_MEMORY_MB),
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
  const every = everySeconds(schedule.every);
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
 * serving. Each deploy recreates them, the image in their environment being new.
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
      ...OUTGOING,
      `finish ${DIR}/"$hex".partial "$hex" release && prune release ${keepSnapshotsOf(plan)}`,
    ],
    { restart: "no", environment, depends_on: parts },
  );
  return services;
}

/**
 * The stack variables of the off-server copy (`snapshots.offsite`), set like the services'
 * secrets: its bucket's S3 endpoint, the key, and the recovery copy's age recipient. The region
 * is the plan's (`snapshots.offsite.region`).
 */
export const PORTAINER_OFFSITE_VARIABLES = {
  endpoint: "OPSCREW_OFFSITE_ENDPOINT",
  accessKeyId: "OPSCREW_OFFSITE_ACCESS_KEY_ID",
  secretAccessKey: "OPSCREW_OFFSITE_SECRET_ACCESS_KEY",
  recipient: "OPSCREW_OFFSITE_RECIPIENT",
} as const;

/** The stack variables {@link offsite} reads, sorted; none without `snapshots.offsite`. */
export function offsiteVariables(plan: DeployPlan): string[] {
  if (snapshotOffsiteOf(plan) === undefined) return [];
  return Object.values(PORTAINER_OFFSITE_VARIABLES).sort();
}

/**
 * The off-server copy (`snapshots.offsite`, plan.md 7., R7 S2) on the pinned rclone image: it
 * fetches the pinned age with `rclone copyurl`, checks the archive's and the binary's SHA-256 and
 * keeps the binary in its tools volume, checking it again before each use. Every minute, each
 * finished snapshot without `offsite.done` streams file by file through `age -r <recipient>` into
 * `rclone rcat` (`backups/<id>/<file>.age`), `about.json` last, then gets `offsite.done`; the
 * snapshots before a release (named by their digest) stay here for the rollback (D16). The
 * bucket's endpoint, key and the recipient are stack variables.
 */
function offsite(plan: DeployPlan): Record<string, object> {
  const copy = snapshotOffsiteOf(plan);
  if (copy === undefined) return {};
  const { arch } = portainerTarget(plan.target);
  const v = PORTAINER_OFFSITE_VARIABLES;
  const script = [
    "set -o pipefail",
    ...ageFunctions(arch),
    "put() {",
    "  age_ok || age_fetch || { echo 'OpsCrew: age could not be fetched and checked against its pinned SHA-256.' >&2; return 1; }",
    `  /tools/age -r "$${v.recipient}" < "$1" | rclone rcat ${shellQuote(`offsite:${copy.bucket}/${OFFSITE_PREFIX}/`)}"$2"`,
    "}",
    "umask 077",
    "while :; do",
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
    "    else",
    '      echo "OpsCrew: the off-server copy of the snapshot $id failed; trying again in a minute." >&2',
    "    fi",
    "  done",
    "  sleep 60",
    "done",
  ];
  return {
    offsite: {
      image: IMAGES.rclone.ref,
      restart: "unless-stopped",
      user: "0:0",
      environment: {
        RCLONE_CONFIG_OFFSITE_TYPE: "s3",
        RCLONE_CONFIG_OFFSITE_PROVIDER: RCLONE_PROVIDERS[copy.provider],
        RCLONE_CONFIG_OFFSITE_ENDPOINT: `\${${v.endpoint}}`,
        RCLONE_CONFIG_OFFSITE_REGION: composeLiteral(copy.region),
        RCLONE_CONFIG_OFFSITE_ACCESS_KEY_ID: `\${${v.accessKeyId}}`,
        RCLONE_CONFIG_OFFSITE_SECRET_ACCESS_KEY: `\${${v.secretAccessKey}}`,
        // The bucket exists: rclone never tries to create it.
        RCLONE_CONFIG_OFFSITE_NO_CHECK_BUCKET: "true",
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
