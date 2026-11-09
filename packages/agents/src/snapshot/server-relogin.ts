/**
 * Whole-server restores after a rotation (025 plan.md 12., FR-2512, T2520). A provider's image of a
 * whole server holds every service's data and the env files of then, which agree with each other,
 * but the next deploy writes the current values, which the restored data of a service rotated since
 * doesn't accept. So once `opscrew restore --server` rebuilt the server, with the app's deploys
 * paused in GitHub from before the rebuild, OpsCrew reads the generation of each such service's
 * values from the restored server's own `.snapshots/generations` (none there: the first), and runs
 * `rotate.sh` there from that generation's values, which this computer keeps, to the current ones
 * (MySQL's and MariaDB's root first), under the restore's hash. On the app's server, the app's
 * settings also get the current values of the services elsewhere rotated since, and the app's
 * switch. A service still on a start command from before 0.2.6 is first started on the current one
 * through an override of the restored Compose file. A rotated deploy key is refused before the
 * approval (the restored server would lock OpsCrew out); the check key, the network's keys, the
 * devices' keys and the device logins rotated since are named, for a provision after. The values
 * reach the server only on SSH's stdin; nothing it prints, audits or asks holds one.
 */
import { posix } from "node:path";
import type { CommandResult } from "@opscrew/contracts";
import { listText, OpsCrewError, sha256Hex } from "@opscrew/core";
import {
  ROTATE_DIR,
  ROTATE_LOG,
  renderCompose,
  renderRuntimeFiles,
  renderServerCompose,
  runtimeDir,
  SNAPSHOT_GENERATIONS,
  serviceSpec,
  shellQuote,
} from "@opscrew/iac-templates";
import { APP_SERVER, type DeployPlan, type PlanService } from "@opscrew/plan-schema";
import { parse, stringify } from "yaml";
import type { z } from "zod";
import { NOTHING_CHANGED } from "../promote/shared";
import type { GitHubSetup } from "../provision/credentials";
import type { ProvisionServices } from "../provision/types";
import { serviceSteps } from "../rotate/plan";
import { assertValuesCurrent, readCredentialsRecord } from "../rotate/record";
import { rotateOnServer, startStates } from "../rotate/server";
import { type HistorySchema, type ServiceValues, serviceValues } from "../rotate/values";
import type { RotationValues } from "../rotate/values-pending";
import { registerAppSecrets } from "../shared/app-secrets";
import { serverWords } from "../shared/server-address";
import { cloudServerName, extraServers } from "../shared/servers";
import { pollUntil } from "../shared/wait";
import { bootSeconds, keptHistory, requireNotAhead, rootFirst } from "./generations";
import { hostFailure, READ_TIMEOUT_MS, type ScriptHost, serverHost } from "./hosts";
import type { SnapshotRun } from "./run";
import type { SnapshotEntry } from "./types";

type History = z.infer<typeof HistorySchema>;

/** The exit code of a command whose services did not come up healthy. */
const NOT_UP = 5;
/** How long a rebuilt server may take to answer over SSH, and how often it is tried. */
const SSH_WAIT_MS = 5 * 60_000;
const SSH_INTERVAL_MS = 10_000;
/** What is true once the server was rebuilt, for the refusals after it. */
export const REBUILT = "The server was rebuilt from the snapshot.";
/** The line before the app's settings in the read of the restored server. */
const APP_ENV_MARK = "--- app.env ---";
/** The override of the restored Compose file with the current start commands. */
const STARTS_FILE = `${ROTATE_DIR}/starts.yaml`;

/** A whole-server restore's services rotated since its snapshot, and what reaches them. */
export interface ServerRelogin {
  /** The server's name in the plan: `app`, or an extra server's. */
  server: string;
  /** Its services with a rotation recipe that the record says were rotated after the snapshot. */
  services: PlanService[];
  /**
   * On the app's server, those of the other servers, whose values of then the restored app's
   * settings hold; none on an extra server.
   */
  elsewhere: PlanService[];
  /** The record's generation of each of them, by name. */
  generations: Record<string, number>;
  host: ScriptHost;
  /** The repository whose deploy pause holds the app's deploys until they are done. */
  github: Pick<GitHubSetup, "api" | "owner" | "repo">;
  /** The earlier generations' values this computer keeps, and the current ones; never shown. */
  history: History;
  current: ServiceValues;
}

/** The plan's name of the server OpsCrew created as `name` at its provider, if it is one. */
function planServer(plan: DeployPlan, name: string): string | undefined {
  return [APP_SERVER, ...extraServers(plan)].find(
    (server) => (server === APP_SERVER ? plan.app.name : cloudServerName(plan, server)) === name,
  );
}

/** `was` or `were`, `it` or `they`, `its` or `their` for `count` services. */
function words(count: number) {
  const one = count === 1;
  return { was: one ? "was" : "were", it: one ? "it" : "they", its: one ? "its" : "their" };
}

/** The server a service of the plan runs on. */
const serverOf = (service: PlanService) => service.server ?? APP_SERVER;

/** The credentials of the environment the record says were rotated after `entry` was taken. */
async function rotatedSince(run: SnapshotRun, entry: SnapshotEntry) {
  const record = (await readCredentialsRecord(run.deps)).environments[run.environment] ?? {};
  const taken = Date.parse(entry.taken);
  return {
    record,
    since: (name: string) => {
      const at = record[name]?.rotatedAt;
      return at !== undefined && taken < Date.parse(at);
    },
  };
}

/** A credential the restored server holds as it was then, in words. */
function keyWords(name: string): string {
  if (name === "check-key") return "the scheduled check's SSH key";
  if (name === "network") return "the private network's keys";
  if (name.startsWith("device:")) return `device ${name.slice("device:".length)}'s key`;
  const [device, service] = name.slice("grant:".length).split("/");
  return `${device}'s login to ${service}`;
}

/**
 * Before the approval of the restore of the whole-server snapshot `entry`: the credentials the
 * restored server holds as they were then that were rotated since, which a provision after the
 * restore brings back in line (the check key, the network's keys, the devices' keys and logins),
 * by name.
 * @throws OpsCrewError `PHASE_PRECONDITION`, before any change, when the deploy key was rotated
 * since: the restored server lets only the old key in, which is gone, so OpsCrew would be locked
 * out of it.
 */
export async function restoredKeys(run: SnapshotRun, entry: SnapshotEntry): Promise<string[]> {
  const { flags } = run;
  const { record, since } = await rotatedSince(run, entry);
  if (since("deploy-key")) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `The deploy key was rotated after the snapshot ${entry.id} was taken: the restored server would let only the old key in, whose private half OpsCrew no longer keeps, so OpsCrew and the deploys would be locked out of it. ${NOTHING_CHANGED}`,
      {
        hint: `Provision a fresh server instead and restore the app's data snapshots there: \`opscrew snapshot list${flags}\` lists them, and \`opscrew restore <id>${flags}\` restores one.`,
      },
    );
  }
  return Object.keys(record).filter(
    (name) =>
      (name === "check-key" ||
        name === "network" ||
        name.startsWith("device:") ||
        name.startsWith("grant:")) &&
      since(name),
  );
}

/** The restore's approval line on `keys` ({@link restoredKeys}); none without one. */
export function restoredKeyLines(keys: readonly string[], flags: string): string[] {
  if (keys.length === 0) return [];
  return [
    `${upper(listText(keys.map(keyWords)))} ${keys.length === 1 ? "was" : "were"} rotated after the snapshot was taken, and the restored server holds ${keys.length === 1 ? "it" : "them"} as ${keys.length === 1 ? "it was" : "they were"} then: run \`opscrew provision${flags}\` after the restore to bring ${keys.length === 1 ? "it" : "them"} back in line.`,
  ];
}

/** The note once the restore is done, when it restored `keys` ({@link restoredKeys}). */
export function restoredKeysNote(keys: readonly string[], flags: string): string | undefined {
  if (keys.length === 0) return undefined;
  return `Run \`opscrew provision${flags}\` next: the restored server holds ${listText(keys.map(keyWords))} as before ${keys.length === 1 ? "its" : "their"} rotation.`;
}

/** `text` with its first letter upper-case. */
function upper(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/**
 * Before the approval of the restore of the whole-server snapshot `entry`: the services with a
 * rotation recipe that the rotation record says were rotated after it was taken, on its server and
 * (for the app's server) elsewhere, with the server's shell, the repository (`repository`) and the
 * values this computer keeps; `undefined` when there are none.
 * @throws OpsCrewError `PHASE_PRECONDITION`, before any change, when this computer's values are
 * older than the record's (another computer rotated), it keeps none of a service's earlier values
 * or no current value of a running service; `ARTIFACT_INVALID` when the generated values are
 * damaged.
 */
export async function plannedRelogin(
  run: SnapshotRun,
  entry: SnapshotEntry,
  repository: () => Promise<ServerRelogin["github"]>,
): Promise<ServerRelogin | undefined> {
  const { deps, plan, flags } = run;
  const server = entry.server === undefined ? undefined : planServer(plan, entry.server.name);
  if (server === undefined) return undefined;
  const { record, since } = await rotatedSince(run, entry);
  const rotated = plan.services.filter(
    (service) =>
      service.enabled &&
      serviceSpec(service.kind).rotation.secrets.length > 0 &&
      since(service.name),
  );
  const services = rotated.filter((service) => serverOf(service) === server);
  const elsewhere =
    server === APP_SERVER ? rotated.filter((service) => serverOf(service) !== server) : [];
  if (services.length === 0 && elsewhere.length === 0) return undefined;
  await assertValuesCurrent(deps);
  await registerAppSecrets(deps, plan);
  const history = (await keptHistory(deps, true)) ?? {};
  const current = await serviceValues(deps, plan, { names: [], services: {} }, "new");
  const lost = [...services, ...elsewhere].filter(
    (service) => Object.keys(history[service.name] ?? {}).length === 0,
  );
  if (lost.length > 0) {
    const { was, its } = words(lost.length);
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `${listText(lost.map((service) => service.name))} ${was} rotated after the snapshot ${entry.id} was taken, and this computer keeps none of ${its} earlier values, which the restored server holds, so OpsCrew could not give ${lost.length === 1 ? "it its" : "them their"} current values again after the restore. ${NOTHING_CHANGED}`,
      {
        hint: `Bring OpsCrew's generated values from your recovery copy (\`opscrew secrets restore${flags}\`), which keeps them, then run the command again.`,
      },
    );
  }
  return {
    server,
    services,
    elsewhere,
    generations: Object.fromEntries(
      [...services, ...elsewhere].map((service) => [
        service.name,
        record[service.name]?.generation ?? 1,
      ]),
    ),
    host: await serverHost(run, server),
    github: await repository(),
    history,
    current,
  };
}

/**
 * What the restore's hash binds of `relogin`: each named service, its record's generation and the
 * fingerprints of its current values, never the values themselves.
 */
export function reloginBinding(relogin: ServerRelogin) {
  return [...relogin.services, ...relogin.elsewhere].map((service) => ({
    service: service.name,
    generation: relogin.generations[service.name],
    values: Object.entries(relogin.current[service.name] ?? {}).map(([secret, value]) => ({
      secret,
      current: sha256Hex(value),
    })),
  }));
}

/** The restore's approval lines on `relogin`. */
export function serverReloginLines(relogin: ServerRelogin): string[] {
  const names = relogin.services.map((service) => service.name);
  const others = relogin.elsewhere.map(
    (service) => `${service.name} (on ${serverWords(serverOf(service))})`,
  );
  const app = relogin.server === APP_SERVER;
  const steps = app
    ? "the change of each, the new env files, the app's switch to them, then the old values dropped"
    : "the change of each and the new env files, then the old values dropped (the app runs on the current values already)";
  const here = words(names.length);
  const there = words(others.length);
  return [
    ...(names.length === 0
      ? []
      : [
          `${listText(names)} ${here.was} rotated after the snapshot was taken, so the restored data logs in with the values of then: once ${serverWords(relogin.server)} is back, OpsCrew reads the generation of the values ${here.it} had then from it, and runs rotate.sh there from those values, which this computer keeps, to the current ones (${steps}). A service there still on a start command from before OpsCrew 0.2.6 is first started again on the current one, with the image and env files it has: the restored compose.yaml stays, and ${STARTS_FILE} overrides only its start command and the settings files that command reads, which are written as a deploy writes them. The app switches on the restored compose.yaml, and the next deploy writes the current one.`,
        ]),
    ...(others.length === 0
      ? []
      : [
          `${listText(others)} ${there.was} rotated after the snapshot was taken, so the restored app's settings hold ${there.its} values of then: rotate.sh on the app's server gives the app's settings the current ones, as the deploy writes them, and switches the app to them.`,
        ]),
    "The app's deploys are paused in GitHub (the repository variable OPSCREW_DEPLOY_PAUSED) from before the rebuild until this is done, under this restore's hash. Then deploys resume.",
  ];
}

/** `command` on `host`, a machine that does not answer counting as exit code 255. */
function runOn(host: ScriptHost, command: string, timeoutMs: number): Promise<CommandResult> {
  return host
    .run(command, timeoutMs)
    .catch(
      (error: unknown): CommandResult => ({ exitCode: 255, stdout: "", stderr: String(error) }),
    );
}

/** The error of `services` that did not start and pass their health checks on `host`. */
function notUp(host: ScriptHost, services: readonly string[], what: string): OpsCrewError {
  const one = services.length === 1;
  return new OpsCrewError(
    "COMMAND_FAILED",
    `${listText(services)} did not start and pass ${one ? "its health check" : "their health checks"} on ${host.name} ${what}, so OpsCrew could not give ${one ? "it its" : "them their"} current values again. Docker Compose's output is in ${ROTATE_LOG} in the app's folder there. ${REBUILT}`,
    { hint: "Check the services there (`opscrew status`, `opscrew logs`)." },
  );
}

/** What the restored server holds, as {@link readRestored} reads it. */
interface Restored {
  /** The generation of each service's values its {@link SNAPSHOT_GENERATIONS} names. */
  generations: Map<string, number>;
  /** The services its Compose file names: a service added since the snapshot is not there. */
  services: Set<string>;
  /** The app's settings, on the app's server; never shown. */
  appEnv: string | undefined;
}

/**
 * Once the server answers over SSH (tried again for up to 5 minutes), and those of its services
 * of `relogin` that its restored Compose file names run and pass their health checks (for at most
 * their boot times, {@link bootSeconds}): what it holds ({@link Restored}).
 * @throws OpsCrewError `COMMAND_FAILED` when the server doesn't answer, or a service is not up.
 */
async function readRestored(
  run: SnapshotRun,
  relogin: ServerRelogin,
  services: Pick<ProvisionServices, "sleep" | "now">,
): Promise<Restored> {
  const { plan } = run;
  const { host } = relogin;
  const names = relogin.services.map((service) => service.name);
  const seconds = relogin.services.reduce((sum, service) => sum + bootSeconds(plan, service), 0);
  const app = relogin.server === APP_SERVER;
  const command = [
    `mkdir -p ${ROTATE_DIR} || exit 1`,
    'rot_have="$(docker compose config --services)" || exit 1',
    `printf '%s\\n' "$rot_have" | sed 's/^/service /'`,
    ...(names.length === 0
      ? []
      : [
          'rot_up=""',
          `for s in ${names.map(shellQuote).join(" ")}; do if printf '%s\\n' "$rot_have" | grep -qx "$s"; then rot_up="$rot_up $s"; fi; done`,
          `if [ -n "$rot_up" ]; then docker compose up -d --no-deps --wait $rot_up >> ${ROTATE_LOG} 2>&1 || exit ${NOT_UP}; fi`,
        ]),
    `if [ -f ${SNAPSHOT_GENERATIONS} ]; then cat ${SNAPSHOT_GENERATIONS}; fi`,
    ...(app ? [`printf '%s\\n' ${shellQuote(APP_ENV_MARK)}`, "cat app.env || exit 1"] : []),
  ].join("\n");
  let last: CommandResult = { exitCode: 255, stdout: "", stderr: "" };
  await pollUntil(
    async () => {
      last = await runOn(host, command, seconds * 1000 + READ_TIMEOUT_MS);
      return last.exitCode === 255 && last.timedOut !== true ? undefined : true;
    },
    {
      timeoutMs: SSH_WAIT_MS,
      intervalMs: SSH_INTERVAL_MS,
      ...(services.sleep === undefined ? {} : { sleep: services.sleep }),
      ...(services.now === undefined ? {} : { now: services.now }),
    },
  );
  if (last.exitCode === NOT_UP) throw notUp(host, names, "after the rebuild");
  if (last.exitCode !== 0) {
    throw hostFailure(run, host, last, "read what the restored server holds");
  }
  const at = last.stdout.indexOf(`${APP_ENV_MARK}\n`);
  const head = at < 0 ? last.stdout : last.stdout.slice(0, at);
  return {
    generations: new Map(
      [...head.matchAll(/^([a-z0-9-]+) ([1-9][0-9]*)$/gm)].map(
        (match) => [match[1] ?? "", Number(match[2])] as const,
      ),
    ),
    services: new Set(
      [...head.matchAll(/^service ([a-z0-9-]+)$/gm)].map((match) => match[1] ?? ""),
    ),
    appEnv: at < 0 ? undefined : last.stdout.slice(at + APP_ENV_MARK.length + 1),
  };
}

/**
 * Starts each of `stale` (on the restored server of `relogin`) that still runs on a start command
 * from before 0.2.6 ({@link startStates}) on the current one, keeping its image and env files: the
 * restored `compose.yaml` stays, and {@link STARTS_FILE} overrides only each one's `entrypoint` and
 * `command` and mounts the settings files they read, as the plan's Compose file has them; those
 * files are written as a deploy writes them, then each is created again and waited for until
 * healthy. The next deploy writes the current Compose file as always.
 * @throws OpsCrewError when the read, the write or a service's start fails.
 */
async function startCurrent(
  run: SnapshotRun,
  relogin: ServerRelogin,
  stale: readonly PlanService[],
): Promise<void> {
  if (stale.length === 0) return;
  const { deps, plan } = run;
  const { host, server } = relogin;
  const states = await startStates(
    deps,
    plan,
    {
      words: host.name,
      run: (command, options) => runOn(host, command, options.timeoutMs ?? READ_TIMEOUT_MS),
    },
    stale,
    REBUILT,
  );
  const outdated = stale.filter((service) => states.get(service.name) === "outdated");
  if (outdated.length === 0) return;
  const names = outdated.map((service) => service.name);
  deps.reporter.step(
    `Starting ${listText(names)} on ${host.name} on the start command of this version of OpsCrew first`,
  );
  const dir = runtimeDir(plan);
  const compose = server === APP_SERVER ? renderCompose(plan) : renderServerCompose(plan, server);
  const rendered = parse(compose.content) as {
    services: Record<string, { entrypoint?: unknown; command?: unknown; volumes?: string[] }>;
  };
  const override = {
    services: Object.fromEntries(
      names.map((name) => {
        const { entrypoint, command, volumes = [] } = rendered.services[name] ?? {};
        const settings = volumes.filter((volume) => volume.startsWith(`./services/${name}/`));
        return [
          name,
          {
            ...(entrypoint === undefined ? {} : { entrypoint }),
            ...(command === undefined ? {} : { command }),
            ...(settings.length === 0 ? {} : { volumes: settings }),
          },
        ];
      }),
    ),
  };
  const files = [
    { path: STARTS_FILE, content: stringify(override, { lineWidth: 0 }) },
    ...renderRuntimeFiles(plan)
      .filter((file) => names.some((name) => file.path.startsWith(`${dir}/services/${name}/`)))
      .map((file) => ({ path: file.path.slice(dir.length + 1), content: file.content })),
  ];
  const command = [
    ...files.map(
      ({ path, content }) =>
        `mkdir -p ${shellQuote(posix.dirname(path))} && printf '%s' ${shellQuote(content)} > ${shellQuote(`${path}.new`)} && mv -f ${shellQuote(`${path}.new`)} ${shellQuote(path)} || exit 1`,
    ),
    `docker compose -f compose.yaml -f ${STARTS_FILE} up -d --no-deps --wait ${names.map(shellQuote).join(" ")} >> ${ROTATE_LOG} 2>&1 || exit ${NOT_UP}`,
  ].join("\n");
  const seconds = outdated.reduce((sum, service) => sum + bootSeconds(plan, service), 0);
  const result = await runOn(host, command, seconds * 1000 + READ_TIMEOUT_MS);
  if (result.exitCode === NOT_UP) {
    throw notUp(host, names, "on the start command of this version of OpsCrew");
  }
  if (result.exitCode !== 0) {
    throw hostFailure(run, host, result, "write the services' current start commands");
  }
}

/**
 * The values of `service` (elsewhere) of then that the restored app's settings `appEnv` hold, paired
 * with the current ones; `undefined` when they hold the current ones, or none this computer keeps
 * (a service added since the snapshot, which the next deploy gives the current ones).
 */
function heldValues(
  relogin: ServerRelogin,
  service: PlanService,
  appEnv: string,
): Record<string, { old: string; new: string }> | undefined {
  const now = relogin.current[service.name] ?? {};
  const holds = (secrets: Record<string, string>) =>
    Object.values(secrets).some((value) => appEnv.includes(value));
  if (holds(now)) return undefined;
  const then = Object.values(relogin.history[service.name] ?? {}).find(holds);
  if (then === undefined) return undefined;
  return Object.fromEntries(
    Object.entries(now).map(([secret, value]) => [
      secret,
      { old: then[secret] ?? value, new: value },
    ]),
  );
}

/**
 * Once the server of `relogin` was rebuilt from the snapshot `id` (`hash`, the restore's): each of
 * its services that the restored Compose file names and that is behind the record by the
 * generation the restored server names ({@link readRestored}), first started on the current start
 * command where it still runs on one from before 0.2.6 ({@link startCurrent}), gets its current
 * values again through {@link rotateOnServer}, from the values of that generation, the root
 * password's step first; the restored server's generations then name the current ones. On the
 * app's server the app's settings get the current values of the services elsewhere too
 * ({@link heldValues}), with the app's switch. A service added since the snapshot is left to the
 * next deploy. `again` is the restore's command. Returns the services it gave their current values.
 * @throws OpsCrewError `PHASE_PRECONDITION` when the server holds a later generation than the
 * record, or this computer no longer keeps the values of then; the failed step's error otherwise.
 */
export async function reloginRestoredServer(
  run: SnapshotRun,
  relogin: ServerRelogin,
  input: { id: string; hash: string; again: string },
  services: Pick<ProvisionServices, "sleep" | "now" | "remote">,
): Promise<string[]> {
  const { deps, plan, flags } = run;
  const { id, hash, again } = input;
  const { server, host, history, current } = relogin;
  deps.reporter.step(`Reading what the restored ${host.name} holds, once it answers`);
  const restored = await readRestored(run, relogin, services);
  const stale: { service: PlanService; from: number; to: number }[] = [];
  for (const service of relogin.services) {
    if (!restored.services.has(service.name)) continue;
    const from = restored.generations.get(service.name) ?? 1;
    const to = relogin.generations[service.name] ?? 1;
    requireNotAhead(service.name, id, from, to, flags, REBUILT);
    if (from < to) stale.push({ service, from, to });
  }
  const values: RotationValues = { names: [], services: {} };
  for (const { service, from } of stale) {
    const then = history[service.name]?.[String(from)];
    const secrets: RotationValues["services"][string] = {};
    for (const { name } of serviceSpec(service.kind).secrets) {
      const old = then?.[name];
      const now = current[service.name]?.[name];
      if (old === undefined || now === undefined) {
        throw new OpsCrewError(
          "PHASE_PRECONDITION",
          `The restored server holds the values of ${service.name} of its generation ${from}, which its data logs in with, and this computer no longer keeps them. ${REBUILT}`,
          {
            hint: `Bring OpsCrew's generated values from your recovery copy (\`opscrew secrets restore${flags}\`), which keeps them, then run \`${again}\` again.`,
          },
        );
      }
      secrets[name] = { old, new: now };
    }
    values.services[service.name] = secrets;
    values.names.push(service.name);
  }
  for (const service of relogin.elsewhere) {
    const held = heldValues(relogin, service, restored.appEnv ?? "");
    if (held === undefined) continue;
    values.services[service.name] = held;
    values.names.push(service.name);
  }
  if (values.names.length === 0) return [];
  await startCurrent(
    run,
    relogin,
    stale.map(({ service }) => service),
  );
  const generations = new Map(stale.map(({ service, to }) => [service.name, to]));
  const steps = rootFirst(
    serviceSteps(
      plan,
      stale.map(({ service }) => service),
    ),
  ).map((step) => ({
    ...step,
    step: { ...step.step, generation: generations.get(step.service.name) as number },
  }));
  deps.reporter.step(
    `Giving ${listText(values.names)} ${words(values.names.length).its} current values again on ${host.name} (rotate.sh)`,
  );
  await rotateOnServer(
    deps,
    plan,
    { server, steps, values, hash, again, appEnv: restored.appEnv },
    services.remote === undefined ? {} : { remote: services.remote },
  );
  return values.names;
}
