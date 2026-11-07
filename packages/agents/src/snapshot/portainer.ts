/**
 * The app's snapshots in the user's Portainer (024 plan.md 1. and 4.): its snapshots volume, read
 * and changed through Portainer's Docker proxy, 023's path. The online kinds are copied by one-off
 * containers of each service's own image, with the service's secrets in a mode-600 file put through
 * the archive API (never in the container's environment or command); a stop-only service is
 * stopped alone with 023's clean stop and its volumes tarred by the pinned busybox, which also
 * lists, deletes and finishes each snapshot (`about.json`, written last).
 */
import {
  ContainerLeftError,
  type DockerClient,
  type DockerContainer,
  dockerClient,
  type MountSpec,
  type OneOffResult,
  runOneOff,
  tarStream,
} from "@opscrew/connector-docker";
import { COMPOSE_PROJECT_LABEL, COMPOSE_SERVICE_LABEL } from "@opscrew/connector-portainer";
import { OpsCrewError } from "@opscrew/core";
import {
  IMAGES,
  PORTAINER_STACK_VARIABLES,
  type PortainerSnapshotPart,
  portainerSecretVariables,
  portainerServiceEnvironment,
  portainerSnapshotParts,
  portainerSnapshotsVolume,
  portainerStackName,
  portainerTarget,
  type SnapshotPart,
  shellQuote,
  snapshotParts,
} from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import { requirePortainerConnection, requirePortainerToken } from "../provision/portainer";
import { STOP_SECONDS } from "../retarget/sides/types";
import { pollUntil, portainerClientFor, readValidJson } from "../shared";
import { GeneratedValuesSchema, generatedValuesFile } from "../shared/app-secrets";
import { type Disk, readDisk } from "./disk";
import type { SnapshotRun } from "./run";
import { type Listing, offsiteLines, readListing, versionLine } from "./store";

/** Where every container of a snapshot mounts the snapshots volume. */
export const DIR = "/snapshots";
/** The label on every one-off container of a snapshot, with the snapshots volume's name. */
export const ONE_OFF_LABEL = "opscrew.snapshot";
/** Where an online part's container finds its service's secrets (mode 600, root's). */
const SECRETS_FILE = "/tmp/opscrew-snapshot.env";
/** Docker's exit code of a container it killed: at the end of its stop timeout, or out of memory. */
const KILLED = 137;
/** The exit code of a one-off whose snapshot folder is not there. */
const MISSING = 5;
/** A part with nothing to copy (an empty SQLite volume), listed as skipped. */
const NOTHING = 3;

/** The app's snapshots volume in the user's Portainer, and the Docker API that reaches it. */
export interface PortainerPlace {
  docker: DockerClient;
  plan: DeployPlan;
  /** The app's stack: its containers' Compose project. */
  stack: string;
  /** The snapshots volume ({@link portainerSnapshotsVolume}). */
  volume: string;
  /** The stack's volumes the last apply recorded (destroy `--delete-data` deletes exactly these). */
  recorded: readonly string[];
}

/**
 * The app's snapshots volume through Portainer's Docker proxy, with the confirmed certificate and
 * `PORTAINER_API_KEY`; Portainer's address is registered with the redactor.
 */
export async function portainerPlace(run: SnapshotRun): Promise<PortainerPlace> {
  const { deps, plan, services } = run;
  const connection = await requirePortainerConnection(deps, plan);
  const client = portainerClientFor(deps, {
    connection,
    token: requirePortainerToken(deps),
    client: services.portainer?.client,
  });
  const environment = portainerTarget(plan.target).environmentId;
  return {
    docker: dockerClient(client.dockerProxyTransport(environment)),
    plan,
    stack: portainerStackName(plan),
    volume: portainerSnapshotsVolume(plan),
    recorded: connection.created.volumes,
  };
}

/** A pinned busybox with the snapshots volume (read-only with `readOnly`) and `mounts`, no network. */
export function box(
  place: PortainerPlace,
  script: string,
  options: { readOnly?: boolean; mounts?: MountSpec[] } = {},
): Promise<OneOffResult> {
  return runOneOff(place.docker, {
    image: IMAGES.busybox.ref,
    cmd: ["sh", "-c", script],
    labels: { [ONE_OFF_LABEL]: place.volume },
    mounts: [
      { type: "volume", source: place.volume, target: DIR, readOnly: options.readOnly === true },
      ...(options.mounts ?? []),
    ],
    network: "none",
  });
}

/** The plain error of a step in the user's Portainer that exited `exitCode`. */
export function failed(what: string, exitCode: number, hint?: string): OpsCrewError {
  return new OpsCrewError(
    "COMMAND_FAILED",
    `OpsCrew could not ${what} in your Portainer (exit code ${exitCode}).`,
    {
      hint: hint ?? "Check that your Portainer environment runs and has free disk, then try again.",
    },
  );
}

/**
 * The snapshots in the volume: each complete one's `about.json` and its `offsite.done`. None
 * before the volume exists, which a list never creates.
 */
export async function portainerListing(place: PortainerPlace): Promise<Listing> {
  if (!(await place.docker.volumeExists(place.volume))) {
    return { abouts: [], offsite: new Set(), unreadable: 0 };
  }
  const script = [
    `for d in ${DIR}/*; do`,
    '  case "$d" in *.partial | *.taking) continue ;; esac',
    '  if [ -f "$d"/about.json ]; then cat "$d"/about.json; fi',
    "done",
    offsiteLines(DIR),
  ].join("\n");
  const result = await box(place, script, { readOnly: true });
  if (result.exitCode !== 0) throw failed("list the snapshots", result.exitCode);
  return readListing(result.stdout);
}

/** Deletes the snapshot `id` (checked letters and digits); `already gone` when it is not there. */
export async function portainerDelete(
  place: PortainerPlace,
  id: string,
): Promise<"deleted" | "already gone"> {
  const result = await box(place, `[ -d ${DIR}/${id} ] || exit ${MISSING}; rm -rf ${DIR}/${id}`);
  if (result.exitCode === MISSING) return "already gone";
  if (result.exitCode !== 0) throw failed(`delete the snapshot ${id}`, result.exitCode);
  return "deleted";
}

/** What a snapshot by hand needs to know first: the volume's disk, the version, a free id. */
export interface PortainerProbe {
  disk: Disk;
  /** The running image's digest (`sha256:<hex>`, the stamp's `.running`), or empty. */
  version: string;
  /** True when a snapshot `id` is there already. */
  taken: boolean;
}

/** Reads the snapshots volume's disk, the running version and whether `id` is taken. */
export async function portainerProbe(place: PortainerPlace, id: string): Promise<PortainerProbe> {
  const script = [
    `df -Pk ${DIR} | awk 'NR == 2 { print "disk", $2, $4 }'`,
    `sed -n 's/^.*@sha256:\\([0-9a-f]\\{64\\}\\)$/version \\1/p' ${DIR}/.running 2> /dev/null`,
    `if [ -e ${DIR}/${id} ]; then echo taken; fi`,
    "exit 0",
  ].join("\n");
  const result = await box(place, script, { readOnly: true });
  const disk = result.exitCode === 0 ? readDisk(result.stdout) : undefined;
  if (disk === undefined) {
    throw failed("read the free disk of its snapshots volume", result.exitCode);
  }
  return { disk, version: versionLine(result.stdout), taken: /^taken$/m.test(result.stdout) };
}

/**
 * The stack variables' values the services' secrets come from, from this computer's generated
 * values, each registered with the redactor; the database and user are the catalog's `app`, as
 * the stack's are.
 */
export async function stackValues(run: SnapshotRun): Promise<Map<string, string>> {
  const { deps, plan } = run;
  const generated = await readValidJson(generatedValuesFile(deps), GeneratedValuesSchema);
  const values = new Map<string, string>([
    [PORTAINER_STACK_VARIABLES.dbUser, "app"],
    [PORTAINER_STACK_VARIABLES.dbName, "app"],
  ]);
  for (const { service, secret, variable } of portainerSecretVariables(plan)) {
    const value =
      variable === PORTAINER_STACK_VARIABLES.dbPassword
        ? generated?.dbPassword
        : generated?.services?.[service]?.[secret];
    if (value === undefined) continue;
    deps.redactor.addLiteral(value, "service-secret");
    values.set(variable, value);
  }
  return values;
}

/** A shell variable's name: what an env file a shell reads may set. */
const SHELL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The secrets file of `service`'s part: its stack environment with each `${VARIABLE}` filled in,
 * one `NAME='value'` line each.
 * @throws OpsCrewError `PHASE_PRECONDITION` when this computer lacks one of its secrets.
 */
export function secretsFile(
  run: SnapshotRun,
  environment: Record<string, string>,
  values: Map<string, string>,
  service: string,
): string {
  const lines: string[] = [];
  for (const [name, value] of Object.entries(environment)) {
    if (!SHELL_NAME.test(name)) continue;
    const filled = value.replace(/\$\{([A-Za-z0-9_]+)\}/g, (_reference, variable: string) => {
      const known = values.get(variable);
      if (known === undefined) {
        throw new OpsCrewError(
          "PHASE_PRECONDITION",
          `OpsCrew does not have the secrets of ${service} on this computer, so it can't copy it. Nothing was changed.`,
          {
            hint: `Run \`opscrew snapshot${run.flags}\` on the computer that provisioned the app (it keeps them in OpsCrew's folder there).`,
          },
        );
      }
      return known;
    });
    lines.push(`${name}=${shellQuote(filled)}`);
  }
  return `${lines.join("\n")}\n`;
}

/** The volume mounts of the containers `of`, at the same places, read-only. */
export function volumesOf(of: readonly DockerContainer[]): MountSpec[] {
  return of.flatMap((container) =>
    container.mounts.flatMap((mount): MountSpec[] =>
      mount.type === "volume" && mount.name !== undefined
        ? [{ type: "volume", source: mount.name, target: mount.destination, readOnly: true }]
        : [],
    ),
  );
}

/** The stack's containers of the service `name` among `containers`. */
export function ofService(containers: readonly DockerContainer[], name: string): DockerContainer[] {
  return containers.filter((container) => container.labels[COMPOSE_SERVICE_LABEL] === name);
}

/** The app stack's containers. */
export function stackContainers(place: PortainerPlace): Promise<DockerContainer[]> {
  return place.docker.listContainers([`${COMPOSE_PROJECT_LABEL}=${place.stack}`]);
}

/**
 * Each stop-only part's data in bytes, by its name: its containers' volumes, from Docker's disk
 * usage (a volume Docker can't measure counts as nothing).
 */
export async function stopOnlySizes(
  place: PortainerPlace,
  parts: readonly SnapshotPart[],
): Promise<Map<string, number>> {
  const stopOnly = parts.filter((part) => !part.online);
  if (stopOnly.length === 0) return new Map();
  const containers = await stackContainers(place);
  const sizes = await place.docker.volumeSizes();
  return new Map(
    stopOnly.map((part) => [
      part.name,
      volumesOf(ofService(containers, part.name)).reduce(
        (total, mount) => total + (sizes.get(mount.source) ?? 0),
        0,
      ),
    ]),
  );
}

/** What a snapshot by hand in the user's Portainer copies. */
export interface PortainerTake {
  id: string;
  /** The running version ({@link PortainerProbe}). */
  version: string;
  /** The parts to copy, in the plan's order; the others are listed as skipped. */
  parts: readonly SnapshotPart[];
}

/**
 * Takes the snapshot `take.id` in the snapshots volume (plan.md 1.): into `<id>.taking`, an online
 * part at a time by a one-off of its own image ({@link portainerSnapshotParts}) and a stop-only one
 * by stopping it cleanly alone, tarring its volumes and starting it again; then `about.json`,
 * last, and the folder renamed `<id>`. A failure removes the partial folder and stops, with every
 * stopped service started again.
 */
export async function portainerTake(
  run: SnapshotRun,
  place: PortainerPlace,
  take: PortainerTake,
): Promise<void> {
  const { plan } = place;
  const folder = `${DIR}/${take.id}.taking`;
  // Each online part's copy and secrets file, before anything changes.
  const taken = new Set(take.parts.map((part) => part.name));
  const online = portainerSnapshotParts(plan).filter((part) => taken.has(part.name));
  const values = await stackValues(run);
  const copies = new Map(
    online.map((part) => {
      const { service } = part;
      const secrets =
        service === undefined
          ? "\n"
          : secretsFile(run, portainerServiceEnvironment(plan, service), values, service.name);
      return [part.name, { part, secrets }];
    }),
  );
  const begun = await box(
    place,
    `rm -rf ${DIR}/*.taking && mkdir ${folder} && chmod 1777 ${folder}`,
  );
  if (begun.exitCode !== 0) throw failed("start the snapshot", begun.exitCode);
  try {
    const containers = await stackContainers(place);
    const copied = new Map<string, boolean>();
    for (const part of take.parts) {
      if (!part.online) {
        await stopAndTar(run, place, part, ofService(containers, part.name), folder);
        copied.set(part.name, true);
        continue;
      }
      const copy = copies.get(part.name);
      if (copy === undefined) {
        throw new OpsCrewError("INTERNAL", `The stack has no online copy of ${part.name}.`, {
          hint: "This is a bug in OpsCrew; please report it.",
        });
      }
      copied.set(part.name, await copyOnline(place, copy.part, copy.secrets, folder));
    }
    const all = snapshotParts(plan).map((part) => ({ ...part, copied: copied.get(part.name) }));
    const finished = await box(place, finishScript(take.id, take.version, all));
    if (finished.exitCode !== 0) throw failed("finish the snapshot", finished.exitCode);
  } catch (error) {
    await box(place, `rm -rf ${folder}`).catch(() => undefined);
    throw error;
  }
}

/**
 * One online part's copy into `folder`, by a one-off of its image with the part's own mounts and
 * the snapshots volume, on the stack's internal network (none for SQLite); `secrets` (its
 * service's, filled in) at {@link SECRETS_FILE}, put before it starts and removed once read. Its
 * output can quote data, so it is never shown. Returns false when there was nothing to copy.
 */
async function copyOnline(
  place: PortainerPlace,
  part: PortainerSnapshotPart,
  secrets: string,
  folder: string,
): Promise<boolean> {
  const { service } = part;
  const file = `${folder}/${part.file}`;
  const script = [
    `t=${file}.tmp`,
    `(umask 077 && ${part.copy}); r=$?`,
    `if [ "$r" = 0 ] && mv "$t" ${file}; then exit 0; fi`,
    'rm -f "$t"',
    `if [ "$r" = ${NOTHING} ]; then exit ${NOTHING}; fi`,
    "exit 1",
  ].join("\n");
  const result = await serviceOneOff(place, {
    name: part.name,
    image: part.image,
    script,
    secrets,
    mounts: [
      ...part.mounts.map(
        (mount): MountSpec => ({
          type: "volume",
          source: `${place.stack}_${mount.volume}`,
          target: mount.target,
          readOnly: mount.readOnly,
        }),
      ),
      { type: "volume", source: place.volume, target: DIR },
    ],
    network: service === undefined ? "none" : `${place.stack}_internal`,
  });
  if (result.exitCode === NOTHING) return false;
  if (result.exitCode !== 0) {
    throw failed(
      `copy ${part.name} (its output can quote data, so it is not shown)`,
      result.exitCode,
      `Check that ${part.name} runs in your Portainer (the stack ${place.stack}), then try again.`,
    );
  }
  return true;
}

/** A one-off of a service's own image: `script` (sh) with the service's secrets, filled in. */
export interface ServiceOneOff {
  /** The part's name, for messages. */
  name: string;
  image: string;
  script: string;
  /** The env file of the service's secrets ({@link secretsFile}), read before `script`. */
  secrets: string;
  mounts: MountSpec[];
  network: string;
}

/**
 * Runs `input.script` in a one-off of `input.image` with `input.mounts`, on `input.network`, after
 * the secrets file (mode 600, root's, at {@link SECRETS_FILE}) is put into it before it starts and
 * read and removed first thing. Its output can quote data: callers never show it.
 * @throws OpsCrewError `COMMAND_FAILED` that names the secrets file when the container could not
 * be removed.
 */
export async function serviceOneOff(
  place: PortainerPlace,
  input: ServiceOneOff,
): Promise<OneOffResult> {
  const secretsEntry = {
    name: SECRETS_FILE.slice(1),
    type: "file",
    mode: 0o600,
    uid: 0,
    gid: 0,
    data: Buffer.from(input.secrets),
  } as const;
  return runOneOff(
    place.docker,
    {
      image: input.image,
      cmd: ["sh", "-c", `. ${SECRETS_FILE} && rm -f ${SECRETS_FILE}\n${input.script}`],
      labels: { [ONE_OFF_LABEL]: place.volume },
      mounts: input.mounts,
      network: input.network,
    },
    (id) => place.docker.putArchive(id, "/", tarStream([secretsEntry])),
  ).catch((error: unknown) => {
    // A container left behind may hold the service's secrets file: never silently.
    if (!(error instanceof ContainerLeftError)) throw error;
    throw new OpsCrewError(
      "COMMAND_FAILED",
      `${error.message} It may hold the secrets file of ${input.name}.`,
      { ...(error.hint === undefined ? {} : { hint: error.hint }) },
    );
  });
}

/**
 * Stops each of `ran` (a part's running containers) with {@link STOP_SECONDS} to stop cleanly
 * (023's clean stop), and waits for each to exit.
 * @throws OpsCrewError `COMMAND_FAILED` when Docker killed one (exit 137): its files are not whole,
 * so OpsCrew does not `what` (`copy its files`).
 */
export async function stopCleanly(
  place: PortainerPlace,
  part: Pick<SnapshotPart, "name">,
  ran: readonly DockerContainer[],
  what: string,
): Promise<void> {
  for (const container of ran) await place.docker.stopContainer(container.id, STOP_SECONDS);
  for (const container of ran) {
    if ((await place.docker.waitContainer(container.id)) === KILLED) {
      throw new OpsCrewError(
        "COMMAND_FAILED",
        `${part.name} did not stop cleanly within ${STOP_SECONDS} seconds (Docker killed it when the time ran out, or it ran out of memory), so OpsCrew did not ${what}.`,
        {
          hint: "Check its logs in Portainer and give it more memory if it ran out, then try again.",
        },
      );
    }
  }
}

/**
 * A stop-only part (023's clean stop): each of its running containers stopped with
 * {@link STOP_SECONDS} to stop cleanly, its volumes tarred into `<folder>/<file>` from their places
 * in the container (as on servers), and started again; a container Docker killed (exit 137) is not
 * copied.
 */
async function stopAndTar(
  run: SnapshotRun,
  place: PortainerPlace,
  part: SnapshotPart,
  containers: readonly DockerContainer[],
  folder: string,
): Promise<void> {
  const { docker } = place;
  const volumes = volumesOf(containers);
  if (volumes.length === 0) {
    throw new OpsCrewError(
      "COMMAND_FAILED",
      `Your Portainer has no container of ${part.name} with its data in the stack ${place.stack}, so OpsCrew could not copy it.`,
      { hint: "Run `opscrew status` to see what runs there, then try again." },
    );
  }
  const ran = containers.filter((container) => container.state === "running");
  let copyError: unknown;
  try {
    await stopCleanly(place, part, ran, "copy its files");
    const dirs = volumes.map((mount) => shellQuote(mount.target.replace(/^\//, ""))).join(" ");
    const tarred = await box(place, `umask 077 && tar -C / -cf ${folder}/${part.file} ${dirs}`, {
      mounts: volumes,
    });
    if (tarred.exitCode !== 0) throw failed(`copy the files of ${part.name}`, tarred.exitCode);
  } catch (error) {
    copyError = error;
  }
  try {
    for (const container of ran) await docker.startContainer(container.id);
  } catch {
    throw new OpsCrewError(
      "COMMAND_FAILED",
      `${part.name} did not start again after its copy in your Portainer.`,
      { hint: `Start it in Portainer (the stack ${place.stack}), then run \`opscrew status\`.` },
    );
  }
  await waitReady(run, place, part, ran);
  if (copyError !== undefined) throw copyError;
}

/** How long a stop-only service has to run again after its copy, healthy where it has a check. */
const READY_TIMEOUT_MS = 5 * 60_000;

/**
 * Waits until each of `started` (a stop-only service's containers) runs again, and answers its
 * health check where it has one, so the next service stops only once this one serves again.
 * @throws OpsCrewError `COMMAND_FAILED` when it does not within {@link READY_TIMEOUT_MS}.
 */
export async function waitReady(
  run: SnapshotRun,
  place: PortainerPlace,
  part: SnapshotPart,
  started: readonly DockerContainer[],
): Promise<void> {
  if (started.length === 0) return;
  const ids = new Set(started.map((container) => container.id));
  const wait = run.services.portainer?.wait;
  const ready = await pollUntil(
    async () => {
      const now = (await stackContainers(place)).filter((container) => ids.has(container.id));
      const up = now.every(
        (container) =>
          container.state === "running" &&
          (container.health === undefined || container.health === "healthy"),
      );
      return now.length === ids.size && up ? true : undefined;
    },
    {
      timeoutMs: READY_TIMEOUT_MS,
      intervalMs: 5_000,
      ...(wait?.sleep === undefined ? {} : { sleep: wait.sleep }),
      ...(wait?.now === undefined ? {} : { now: wait.now }),
    },
  );
  if (ready !== undefined) return;
  throw new OpsCrewError(
    "COMMAND_FAILED",
    `${part.name} did not run again and answer its health check within 5 minutes of its copy in your Portainer, so OpsCrew stopped no other service.`,
    {
      hint: `See why in Portainer (the stack ${place.stack}, the ${part.name} container's logs), then run \`opscrew status\`.`,
    },
  );
}

/**
 * The busybox script that writes `about.json` in `<id>.taking` (plan.md 1.: each part's kind, file,
 * size and image (a service's, the catalog's pin the stack runs), or `skipped`), makes it root's
 * with files 600 and the folder 700, and renames it `<id>`. Every name, kind and file is the plan's
 * (checked letters, digits and hyphens), the id letters and digits, the version a checked digest.
 */
function finishScript(
  id: string,
  version: string,
  parts: readonly (SnapshotPart & { copied?: boolean })[],
): string {
  const folder = `${DIR}/${id}.taking`;
  const entries = parts.flatMap((part, index) => [
    ...(index > 0 ? ["  printf ,"] : []),
    part.copied === true
      ? `  printf '{"name":"${part.name}","kind":"${part.kind}","file":"${part.file}","size":%s${part.image === undefined ? "" : `,"image":"${part.image}"`}}' "$(stat -c %s ${folder}/${part.file})"`
      : `  printf '{"name":"${part.name}","kind":"${part.kind}","skipped":true}'`,
  ]);
  return [
    "set -e",
    "{",
    `  printf '{"id":"${id}","kind":"manual","taken":"%s","version":"${version}","services":[' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"`,
    ...entries,
    "  printf ']}\\n'",
    `} > ${folder}/.about`,
    `mv ${folder}/.about ${folder}/about.json`,
    `chown -R 0:0 ${folder} && chmod 600 ${folder}/* && chmod 700 ${folder}`,
    `rm -rf ${DIR}/${id} && mv ${folder} ${DIR}/${id}`,
  ].join("\n");
}
