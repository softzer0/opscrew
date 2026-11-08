/**
 * `opscrew rotate <service>…` on servers, cloud and the user's own (025 plan.md 3., US1, FR-2501 to
 * FR-2505, FR-2512): new values for the services' generated secrets, kept beside the old ones on
 * this computer until done; one plan approved by its hash (`remote-exec`, as 024's restore); then,
 * with the app's deploys paused in GitHub, GitHub's secrets replaced and each server's `rotate.sh`
 * run over SSH with the env files and values on its stdin (the extra servers' `begin` before the
 * app's server's whole run and their `finish` after); the record and the recovery copy after.
 * A failure keeps the values and the deploys paused, and says the step and how to go on or put the
 * old values back (`--undo`). Nothing it prints, audits or asks holds a value or a server's address.
 */
import { isDeepStrictEqual } from "node:util";
import type { CommandResult, RemoteRunOptions } from "@opscrew/contracts";
import { isUserFacingError, listText, OpsCrewError, upperFirst } from "@opscrew/core";
import {
  appDir,
  checkEnvironmentKey,
  DEPLOY_PAUSED_VARIABLE,
  DEPLOY_SECRETS,
  deploySecretName,
  hasLogin,
  ROTATE_APPROVAL_FILE,
  ROTATE_DIR,
  rotateApprovalLine,
  rotateInput,
  serviceEnvSecret,
  serviceSpec,
  shellQuote,
} from "@opscrew/iac-templates";
import { APP_SERVER, type DeployPlan, onOneServer, type PlanService } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { commandFlags } from "../environments/choice";
import { withDeploysPausedUntilDone } from "../move/deploys";
import type { GitHubSetup } from "../provision/credentials";
import { type SecretPlace, secretsEnvironment } from "../provision/secrets";
import type { ProvisionServices } from "../provision/types";
import { APPROVAL_SECONDS } from "../rollback/database";
import { type RefreshRecoveryResult, refreshRecoveryCopy } from "../secrets/copy";
import { registerAppSecrets } from "../shared/app-secrets";
import { deployPauseOf, pinnedText, rotationWindowText } from "../shared/deploy-pause";
import { codeOf } from "../shared/errors";
import { serverWords } from "../shared/server-address";
import { READ_TIMEOUT_MS, scriptSaid } from "../snapshot/hosts";
import { requireNoDeployOrMove } from "../snapshot/run";
import { serverShell } from "../status/servers";
import { passwordKey } from "../vpn/grants";
import {
  approveRotation,
  approveUndo,
  grantSteps,
  type RotationPlan,
  rotationContext,
  rotationHash,
  type ServerRun,
  serverRuns,
  serviceSteps,
  stepValues,
} from "./plan";
import { assertValuesCurrent, readCredentialsRecord, recordRotation } from "./record";
import {
  completePendingRotation,
  type GrantLogin,
  grantName,
  newRotationValues,
  serviceEnvTexts,
  serviceValues,
  swapAppEnv,
} from "./values";
import {
  dropPendingRotation,
  keepPendingRotation,
  type PendingRotation,
  type RotationValues,
  readPendingRotation,
} from "./values-pending";

/** What {@link rotateServices} reaches besides this computer. */
export interface RotateServicesOptions {
  /** The repository: its deploy pause, its deploy runs and its secrets. */
  github: Pick<GitHubSetup, "api" | "owner" | "repo">;
  /** `--undo`: puts the old values of the unfinished rotation back instead. */
  undo?: boolean;
  /** Tests: a server's shell, given its address (default: ssh with the login `opscrew logs` uses). */
  remote?: ProvisionServices["remote"];
  /** Tests: the wait for a running deploy. */
  sleep?: ProvisionServices["sleep"];
  now?: ProvisionServices["now"];
}

/** A finished rotation, or its undo. */
export interface ServicesRotation {
  /** The hash its plan was approved by. */
  hash: string;
  /** The recovery copy, refreshed: its files for the caller's pull request. */
  copy: RefreshRecoveryResult;
}

/** A finished rotation of a device's login, or its undo. */
export interface DeviceLoginRotation extends ServicesRotation {
  /** The login's new password, to show once and never log; absent after an undo. */
  password?: string;
}

/** What one rotation changes: the services' generated secrets and the device logins. */
interface RotationRequest {
  services: readonly PlanService[];
  grants: readonly GrantLogin[];
}

/** The exit code of a command whose server has no app's folder. */
const NO_FOLDER = 3;
/** The exit code of the read of the app's settings on a server that has none. */
const NO_APP_ENV = 4;
/** How long one run of `rotate.sh` may take: its restarts and the app's switch, each waited for. */
const RUN_TIMEOUT_MS = 30 * 60_000;
/** `rotate.sh` in the rotation's folder on each server. */
const SCRIPT = `${ROTATE_DIR}/rotate.sh`;
/** What a refusal before any change ends with. */
const UNCHANGED = "Nothing was changed.";

/** What `rotate.sh` is asked to do (`rotateApprovalLine`'s runs). */
type RotateAction = Parameters<typeof rotateApprovalLine>[1];

/** One server of the rotation, as the deploy user in the app's folder. */
interface RotateHost {
  server: string;
  /** `the app's server`, `server data`. */
  words: string;
  run(command: string, options: RemoteRunOptions): Promise<CommandResult>;
}

/**
 * `command` as the deploy user, the app's folder's owner: through `runuser` in a root shell (the
 * user's own server through its admin login), as it is otherwise (`deploy` itself). Its stdin
 * stays the command's.
 */
function asDeploy(command: string): string {
  const quoted = shellQuote(command);
  return `if [ "$(id -u)" = 0 ]; then runuser -u deploy -- sh -c ${quoted}; else sh -c ${quoted}; fi`;
}

/** The server `server` of `plan` through the login `opscrew logs` uses; its address redacted. */
async function rotateHost(
  deps: PhaseDeps,
  plan: DeployPlan,
  server: string,
  options: RotateServicesOptions,
): Promise<RotateHost> {
  const { docker, login } = await serverShell(
    deps,
    plan,
    server,
    options.remote === undefined ? {} : { remote: options.remote },
  );
  deps.redactor.addName(login.host, "server-address");
  const dir = appDir(plan);
  return {
    server,
    words: serverWords(server),
    run: (command, runOptions) =>
      docker.run(`cd ${shellQuote(dir)} || exit ${NO_FOLDER}; ${asDeploy(command)}`, runOptions),
  };
}

/**
 * The plain error of a command on `host` that failed (`what` follows "could not"), with `after`
 * (`Nothing was changed.` before the rotation began).
 */
function hostFailure(
  deps: PhaseDeps,
  host: RotateHost,
  result: CommandResult,
  what: string,
  after = "",
): OpsCrewError {
  const tail = after === "" ? "" : ` ${after}`;
  if (result.exitCode === 255 || result.timedOut === true) {
    return new OpsCrewError(
      "COMMAND_FAILED",
      `${upperFirst(host.words)} did not answer over SSH, so OpsCrew could not ${what}.${tail}`,
      { hint: "Check that it is on and reachable (`opscrew status`)." },
    );
  }
  if (result.exitCode === NO_FOLDER) {
    return new OpsCrewError(
      "PHASE_PRECONDITION",
      `There is no folder of the app on ${host.words}, so OpsCrew could not ${what}.${tail}`,
      { hint: "Deploy the app first (`opscrew provision`)." },
    );
  }
  const said = scriptSaid(result, deps.redactor.redact);
  return new OpsCrewError(
    "COMMAND_FAILED",
    `OpsCrew could not ${what} on ${host.words} (exit code ${result.exitCode})${said === "" ? "." : `: ${said.replace(/\.?$/, ".")}`}${tail}`,
    { hint: "Fix what it names." },
  );
}

/**
 * The named services of `plan`, in the plan's order.
 * @throws OpsCrewError `INVALID_INPUT` for a name of no service, or of one without a login OpsCrew
 * made (Kafka and Redpanda without theirs).
 */
function namedServices(plan: DeployPlan, names: readonly string[], flags: string): PlanService[] {
  const unknown = names.filter((name) => !plan.services.some((s) => s.name === name));
  const list = `\`opscrew rotate${flags}\` lists what can be rotated.`;
  if (unknown.length > 0) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `${listText(unknown)} ${unknown.length === 1 ? "is no service" : "are no services"} of ${plan.app.name}. Nothing was changed.`,
      { hint: list },
    );
  }
  const services = plan.services.filter((service) => names.includes(service.name));
  for (const service of services) {
    if (serviceSpec(service.kind).secrets.length > 0 && hasLogin(service)) continue;
    throw new OpsCrewError(
      "INVALID_INPUT",
      `${service.name} has no login OpsCrew made, so there is nothing of it to rotate. Nothing was changed.`,
      { hint: list },
    );
  }
  if (services.length === 0) throw new Error("rotateServices needs a service to rotate.");
  return services;
}

/**
 * Refuses, before any change, while a move or another credential rotation pauses the app's
 * deploys in GitHub (`OPSCREW_DEPLOY_PAUSED`), and while a rollback pins them: the rotation pauses
 * them itself and resumes them at its end, which would end the pin. Only the pause of this
 * rotation, once it began (`began`: its hash), is its own, kept since it stopped.
 */
async function requireNoPause(
  deps: PhaseDeps,
  github: RotateServicesOptions["github"],
  plan: DeployPlan,
  again: string,
  flags: string,
  began: string | undefined,
): Promise<void> {
  const pause = await deployPauseOf(github, plan);
  if (pause === undefined || (pause.reason === "rotation" && pause.hash === began)) return;
  const key = checkEnvironmentKey(plan);
  if (pause.reason === "rotation") {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `The deploys of ${key} are paused since ${pause.since} for ${await rotationWindowText(deps, flags, pause.hash)}, so this rotation can't begin. Nothing was changed.`,
      { hint: `Finish or undo that rotation first, then run \`${again}\` again.` },
    );
  }
  if (pause.reason === "move") {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `The deploys of ${key} are paused for a move since ${pause.since} (the repository variable ${DEPLOY_PAUSED_VARIABLE}), and OpsCrew does not rotate credentials while the app moves. Nothing was changed.`,
      {
        hint: `Let the move finish, then run \`${again}\` again. If no move runs (an earlier run of OpsCrew was stopped), remove ${key} from ${DEPLOY_PAUSED_VARIABLE} in the repository's Settings → Secrets and variables → Actions → Variables first.`,
      },
    );
  }
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    `The deploys of ${key} are paused since ${pause.since}: ${pinnedText(pause)}. A rotation pauses the deploys itself and resumes them at its end, which would end that pin. Nothing was changed.`,
    { hint: `Run \`opscrew rollback${flags} --resume\` first, then \`${again}\` again.` },
  );
}

/** The read-only script that prints each running service's start command, by service. */
function startsScript(services: readonly string[]): string {
  return [
    `for s in ${services.join(" ")}; do`,
    '  c="$(docker compose ps -q "$s" 2> /dev/null | head -n 1)"',
    '  if [ -z "$c" ]; then continue; fi',
    `  printf 'entrypoint %s %s\\n' "$s" "$(docker inspect --format '{{json .Config.Entrypoint}}' "$c")"`,
    `  printf 'cmd %s %s\\n' "$s" "$(docker inspect --format '{{json .Config.Cmd}}' "$c")"`,
    "done",
  ].join("\n");
}

/** {@link startsScript}'s answer: each service's entrypoint and command, as Docker holds them. */
function readStarts(stdout: string): Map<string, { entrypoint?: unknown; cmd?: unknown }> {
  const starts = new Map<string, { entrypoint?: unknown; cmd?: unknown }>();
  for (const match of stdout.matchAll(/^(entrypoint|cmd) ([a-z0-9-]+) (.*)$/gm)) {
    const service = match[2] ?? "";
    let value: unknown;
    try {
      value = JSON.parse(match[3] ?? "");
    } catch {
      value = match[3];
    }
    starts.set(service, { ...starts.get(service), [match[1] ?? ""]: value });
  }
  return starts;
}

/**
 * Refuses, before any change, a rotated service that does not run on its server, or runs on a
 * start command other than the catalog's (one from before 025, which keeps no copy of its value in
 * its container, so a restart would put the old value back): a deploy first starts it on the new
 * one. Read-only, one command per server.
 */
async function requireCurrentStarts(
  deps: PhaseDeps,
  plan: DeployPlan,
  runs: readonly ServerRun[],
  hosts: ReadonlyMap<string, RotateHost>,
  again: string,
  flags: string,
): Promise<void> {
  for (const run of runs) {
    const services = [
      ...new Map(run.steps.map((step) => [step.service.name, step.service])).values(),
    ];
    if (services.length === 0) continue;
    const host = hosts.get(run.server) as RotateHost;
    deps.reporter.step(`Reading what runs on ${host.words}`);
    const result = await host.run(startsScript(services.map((s) => s.name)), {
      timeoutMs: READ_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) {
      throw hostFailure(deps, host, result, "read the services' start commands", UNCHANGED);
    }
    const starts = readStarts(result.stdout);
    for (const service of services) {
      const spec = serviceSpec(service.kind);
      const found = starts.get(service.name);
      if (found === undefined) {
        throw new OpsCrewError(
          "PHASE_PRECONDITION",
          `${service.name} (${spec.title}) is not running on ${host.words}, so OpsCrew can't change its value. Nothing was changed.`,
          {
            hint: `Start it with a deploy (push to ${plan.cicd.branch}, or run \`opscrew provision${flags}\`), then run \`${again}\` again.`,
          },
        );
      }
      const ctx = rotationContext(plan, service);
      const entrypoint = spec.entrypoint?.(ctx);
      const command = spec.command?.(ctx);
      if (
        (entrypoint === undefined || isDeepStrictEqual(found.entrypoint, entrypoint)) &&
        (command === undefined || isDeepStrictEqual(found.cmd, command))
      ) {
        continue;
      }
      throw new OpsCrewError(
        "PHASE_PRECONDITION",
        `${service.name} (${spec.title}) on ${host.words} still runs on a start command from before this version of OpsCrew, which keeps no copy of its value in the container: a restart would bring the old value back. Nothing was changed.`,
        {
          hint: `Run \`opscrew provision${flags}\` and let its deploy finish, which starts ${service.name} on its new start command, then run \`${again}\` again.`,
        },
      );
    }
  }
}

/**
 * The app's settings (`app.env`) on the app's server, as the deploy wrote them; never shown.
 * @throws OpsCrewError `PHASE_PRECONDITION` when the server has none (no deploy finished there).
 */
async function readAppEnv(
  deps: PhaseDeps,
  host: RotateHost,
  plan: DeployPlan,
  again: string,
  flags: string,
): Promise<string> {
  const result = await host.run(`[ -f app.env ] || exit ${NO_APP_ENV}; cat app.env`, {
    timeoutMs: READ_TIMEOUT_MS,
  });
  if (result.exitCode === NO_APP_ENV) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `The app's server has no app.env in the app's folder (each deploy writes it), so OpsCrew can't give the app its new values. Nothing was changed.`,
      {
        hint: `Deploy the app (push to ${plan.cicd.branch}, or run \`opscrew provision${flags}\`), then run \`${again}\` again.`,
      },
    );
  }
  if (result.exitCode !== 0) {
    throw hostFailure(deps, host, result, "read the app's settings (app.env)", UNCHANGED);
  }
  return result.stdout;
}

/** Where GitHub holds the deploy secret `name` of `plan`'s environment. */
function secretPlace(plan: DeployPlan, name: string): SecretPlace {
  const environment = secretsEnvironment(plan);
  const stored = deploySecretName(plan, name);
  return environment === undefined ? { name: stored } : { name: stored, environment };
}

/**
 * The deploy secrets a rotation of `services` replaces, by their unprefixed names: the app's
 * settings and each running one's env file.
 */
function rotatedSecrets(services: readonly PlanService[]): string[] {
  return [
    DEPLOY_SECRETS.appEnv,
    ...services.filter((s) => s.enabled).map((s) => serviceEnvSecret(s.name)),
  ];
}

/** Sets each of `secrets` (unprefixed name → value) where GitHub holds it; audited by name. */
async function replaceSecrets(
  deps: PhaseDeps,
  github: RotateServicesOptions["github"],
  plan: DeployPlan,
  secrets: Readonly<Record<string, string>>,
): Promise<void> {
  const { api, owner, repo } = github;
  for (const [name, value] of Object.entries(secrets)) {
    const place = secretPlace(plan, name);
    if (place.environment === undefined) {
      await api.setActionsSecret(owner, repo, place.name, value);
    } else {
      await api.setEnvironmentSecret(owner, repo, place.environment, place.name, value);
    }
    await deps.audit.append({
      kind: "secret-set",
      actor: "opscrew",
      action: `set secret ${place.name}${place.environment === undefined ? "" : ` in the environment ${place.environment}`}`,
      target: `${owner}/${repo}`,
      decision: "approved",
    });
  }
}

/** One rotation's facts the runs on the servers need. */
interface Rotation {
  deps: PhaseDeps;
  plan: DeployPlan;
  hash: string;
  pending: PendingRotation;
  /** How far the rotation had got before this run (`planned` for a new one). */
  from: PendingRotation["step"];
  runs: readonly ServerRun[];
  hosts: ReadonlyMap<string, RotateHost>;
  /** The new env files by file name: the app's settings and every running service's. */
  envFiles: Readonly<Record<string, string>>;
  /** `opscrew rotate <names> [flags]`. */
  again: string;
}

/**
 * `rotate.sh <action>` of `run`, after writing it with its one-time approval of exactly this run
 * and hash (the deploy user's, owner-only), with its env files and values on stdin; audited. The
 * approval is removed again when the run failed, should it not have been read.
 * @throws OpsCrewError when the approval can't be left, or the run fails, with what it said.
 */
async function runScript(rotation: Rotation, run: ServerRun, action: RotateAction): Promise<void> {
  const { deps, hash, pending } = rotation;
  const host = rotation.hosts.get(run.server) as RotateHost;
  const expiry = Math.floor(deps.clock.now().getTime() / 1000) + APPROVAL_SECONDS;
  const line = rotateApprovalLine(hash, action, expiry);
  const left = await host.run(
    `umask 077 && mkdir -p ${ROTATE_DIR} && cat > ${SCRIPT} && printf '%s\\n' ${shellQuote(line)} > ${ROTATE_APPROVAL_FILE}`,
    { input: run.script, timeoutMs: READ_TIMEOUT_MS },
  );
  if (left.exitCode !== 0) {
    throw hostFailure(deps, host, left, "leave the rotation's script and its one-time approval");
  }
  const steps = run.steps.map((step) => step.step);
  const input = rotateInput(
    steps,
    { envFiles: rotation.envFiles, values: run.steps.map((step) => stepValues(step, pending)) },
    run.server,
  );
  const args = action === "rotate" ? [hash] : [action === "undo" ? "--undo" : action, hash];
  const result = await host.run(`sh ${SCRIPT} ${args.join(" ")}`, {
    input,
    timeoutMs: RUN_TIMEOUT_MS,
  });
  if (result.exitCode !== 0) {
    await host
      .run(`rm -f ${ROTATE_APPROVAL_FILE}`, { timeoutMs: READ_TIMEOUT_MS })
      .catch(() => undefined);
  }
  const services = [...new Set(run.steps.map((step) => step.service.name))];
  await deps.audit.append({
    kind: "remote-exec",
    actor: "opscrew",
    action: `rotate credentials (rotate.sh ${action})`,
    target: `${deps.paths.environment} server ${run.server}`,
    decision: "approved",
    detail: `rotation ${hash}${services.length === 0 ? "" : `: ${services.join(", ")}`}: ${result.exitCode === 0 ? "done" : `exit code ${result.exitCode}`}`,
  });
  if (result.exitCode === 0) return;
  if (result.exitCode === 255 || result.timedOut === true) {
    throw new OpsCrewError(
      "COMMAND_FAILED",
      `${upperFirst(host.words)} did not answer over SSH during its rotate.sh ${action}, so OpsCrew does not know how far it got there.`,
      { hint: "Check that it is on and reachable (`opscrew status`)." },
    );
  }
  const said = scriptSaid(result, deps.redactor.redact);
  throw new OpsCrewError(
    "COMMAND_FAILED",
    `The rotation's rotate.sh ${action} stopped on ${host.words} (exit code ${result.exitCode})${said === "" ? "." : `: ${said}`}`,
  );
}

/**
 * `error` of the rotation's `stage` with what is true after it and how to go on: until the app's
 * server finished its run the rotation goes on or is undone; after it (`finish`, or a run that
 * found it `switched`) it only goes on.
 */
function stopped(error: unknown, rotation: Rotation, stage: "secrets" | "servers" | "finish") {
  if (!isUserFacingError(error)) return error;
  const { again, from } = rotation;
  const forward = stage === "finish" || from === "switched";
  const said = error.message.replace(/\s+$/, "");
  const message =
    stage === "secrets"
      ? `OpsCrew could not replace the deploy secrets in GitHub: ${said}${from === "planned" ? " No server was changed yet." : ""}`
      : said;
  const until = forward ? `\`${again}\`` : `\`${again}\` or \`${again} --undo\``;
  return new OpsCrewError(
    codeOf(error),
    `${message} The old and the new values stay on this computer until the rotation is done or undone, and the app's deploys stay paused (${DEPLOY_PAUSED_VARIABLE}) until ${until} finishes.`,
    {
      hint: forward
        ? `The app runs on the new values, so the rotation only goes forward: fix what it names, then run \`${again}\` again to finish it.`
        : `${error.hint ? `${error.hint} ` : "Fix what it names. "}Then run \`${again}\` again to go on from where it stopped, or \`${again} --undo\` to put the old values back.`,
      cause: error,
    },
  );
}

/**
 * The rotation's changes, with the app's deploys paused: GitHub's secrets, each extra server's
 * `begin`, the app's server's whole run (then the rotation is kept as `switched`: it only goes
 * forward), each extra server's `finish`.
 */
async function rotateOnServers(
  rotation: Rotation,
  secrets: Readonly<Record<string, string>>,
  github: RotateServicesOptions["github"],
): Promise<void> {
  const { deps, plan, runs } = rotation;
  const app = runs.find((run) => run.server === APP_SERVER) as ServerRun;
  const extras = runs.filter((run) => run.server !== APP_SERVER);
  let stage: "secrets" | "servers" | "finish" = "secrets";
  try {
    deps.reporter.step("Replacing the deploy secrets in GitHub with the new values");
    await replaceSecrets(deps, github, plan, secrets);
    stage = "servers";
    for (const run of extras) {
      deps.reporter.step(`Giving the services on ${serverWords(run.server)} their new values`);
      await runScript(rotation, run, "begin");
    }
    deps.reporter.step(
      "Rotating on the app's server: the services, the env files, the app's switch",
    );
    await runScript(rotation, app, "rotate");
    await keepPendingRotation(deps, { ...rotation.pending, step: "switched" });
    stage = "finish";
    for (const run of extras) {
      deps.reporter.step(`Dropping the old values on ${serverWords(run.server)}`);
      await runScript(rotation, run, "finish");
    }
  } catch (error) {
    throw stopped(error, rotation, stage);
  }
}

/**
 * The undo of the unfinished rotation, with the app's deploys paused: the app's server's
 * `--undo` first (it refuses once its run finished, as the old values may be gone), then each
 * extra server's, then GitHub's secrets with the old values.
 */
async function undoOnServers(
  rotation: Rotation,
  secrets: Readonly<Record<string, string>>,
  github: RotateServicesOptions["github"],
): Promise<void> {
  const { deps, plan, runs, again } = rotation;
  try {
    for (const run of runs) {
      deps.reporter.step(`Putting the old values back on ${serverWords(run.server)}`);
      await runScript(rotation, run, "undo");
    }
    deps.reporter.step("Putting the old values back in GitHub's deploy secrets");
    await replaceSecrets(deps, github, plan, secrets);
  } catch (error) {
    if (!isUserFacingError(error)) throw error;
    throw new OpsCrewError(
      codeOf(error),
      `${error.message.replace(/\s+$/, "")} The old and the new values stay on this computer until the rotation is done or undone, and the app's deploys stay paused (${DEPLOY_PAUSED_VARIABLE}) until \`${again} --undo\` or \`${again}\` finishes.`,
      {
        hint: `Fix what it names, then run \`${again} --undo\` again to finish the undo. If it says the rotation finished on the app's server, it can only go forward: run \`${again}\` to finish it.`,
        cause: error,
      },
    );
  }
}

/** The env files on the servers and in GitHub with `side`'s values, by file name. */
async function envFilesWith(
  deps: PhaseDeps,
  plan: DeployPlan,
  values: RotationValues,
  appEnv: string | undefined,
  side: "old" | "new",
): Promise<Record<string, string>> {
  const other = side === "new" ? "old" : "new";
  const from = await serviceValues(deps, plan, values, other);
  const to = await serviceValues(deps, plan, values, side);
  return {
    ...serviceEnvTexts(plan, to),
    ...(appEnv === undefined ? {} : { "app.env": swapAppEnv(plan, appEnv, values, from, to) }),
  };
}

/** The deploy secrets of {@link rotatedSecrets} with the env files `files`. */
function secretValues(
  services: readonly PlanService[],
  files: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(
    rotatedSecrets(services).map((name) => {
      const file =
        name === DEPLOY_SECRETS.appEnv
          ? "app.env"
          : `${services.find((s) => serviceEnvSecret(s.name) === name)?.name}.env`;
      return [name, files[file] as string];
    }),
  );
}

/**
 * Rotates the generated secrets of the services `names` of `plan`'s environment (`deps.paths`;
 * on its servers, cloud or the user's own), or with `options.undo` puts the old values of the
 * unfinished rotation of them back. Refused before any change, with the next step: for a name of
 * no rotatable service, a preview environment, by the two-computer guard, while another rotation
 * is unfinished, while a deploy runs or a move is in progress or pauses the deploys, while a
 * rollback pins them, and when a service does not run or runs on a start command from before 025.
 * New values (the catalog's formats) are registered with the redactor and kept beside the old in
 * the environment's unfinished rotation (`pending_rotation.json`, with the plan's hash and how far
 * it got) until done; an unfinished rotation's are reused, so its plan has the same hash (one only
 * planned, of other services, is replaced and its undo only forgets it; one that began under another
 * plan is refused, and so is the undo of one the app's server finished). After the approval, with
 * the deploys paused until the rotation or its undo is run to its end: GitHub's secrets (the app's
 * settings and the services' env files, as provision renders them), each extra server's
 * `rotate.sh begin`, the app's server's `rotate.sh`, each extra server's `rotate.sh finish`, each
 * after its one-time approval, all with the env files and values on stdin. Then the new values
 * become the services' own (the old kept by generation), the rotation is recorded and the recovery
 * copy refreshed. An off service changes on this computer only.
 * @throws OpsCrewError `INVALID_INPUT`, `PHASE_PRECONDITION` for the refusals, `APPROVAL_REFUSED`,
 * and the failed step's error, saying how to go on or undo.
 */
export async function rotateServices(
  deps: PhaseDeps,
  plan: DeployPlan,
  names: readonly string[],
  options: RotateServicesOptions,
): Promise<ServicesRotation> {
  const { root, environment, app } = deps.paths;
  const flags = await commandFlags(root, environment, app);
  const services = namedServices(plan, names, flags);
  const { values: _values, ...rotation } = await runRotation(
    deps,
    plan,
    { services, grants: [] },
    flags,
    options,
  );
  return rotation;
}

/**
 * Rotates the password of `grant`, a device's own login to a Valkey, Redis or Dragonfly service of
 * `plan` (018's grants), or with `options.undo` puts the old one back: {@link rotateServices}'s
 * flow, refusals, approval, pause, resume and undo, with the catalog's `rotation.grant` as the
 * only step (the new password added beside the old, the service's env file with the new one's
 * SHA-256, the app's switch, then the old one dropped). Returns the new password, to show once.
 * @throws OpsCrewError as {@link rotateServices}, and `PHASE_PRECONDITION` when this computer keeps
 * no password of the login.
 */
export async function rotateDeviceLogin(
  deps: PhaseDeps,
  plan: DeployPlan,
  grant: GrantLogin,
  options: RotateServicesOptions,
): Promise<DeviceLoginRotation> {
  const { root, environment, app } = deps.paths;
  const flags = await commandFlags(root, environment, app);
  const { values, ...rotation } = await runRotation(
    deps,
    plan,
    { services: [], grants: [grant] },
    flags,
    options,
  );
  const password =
    options.undo === true
      ? undefined
      : values.grants?.[passwordKey(grant.device, grant.service.name)]?.new;
  return { ...rotation, ...(password === undefined ? {} : { password }) };
}

/**
 * The rotation of `request` ({@link rotateServices}, {@link rotateDeviceLogin}), with its values.
 */
async function runRotation(
  deps: PhaseDeps,
  plan: DeployPlan,
  request: RotationRequest,
  flags: string,
  options: RotateServicesOptions,
): Promise<ServicesRotation & { values: RotationValues }> {
  const { environment } = deps.paths;
  const { services, grants } = request;
  const named = [...services.map((service) => service.name), ...grants.map(grantName)];
  // The services whose env files change: those rotated, and those of the device logins.
  const changed = plan.services.filter(
    (s) => services.includes(s) || grants.some((grant) => grant.service.name === s.name),
  );
  const again = `opscrew rotate ${named.join(" ")}${flags}`;
  if (!onOneServer(plan.target.provider)) {
    throw new Error(`rotateServices rotates on servers, not on ${plan.target.provider}.`);
  }
  if (plan.environment?.previews !== undefined) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `${environment} is a preview environment: each preview makes its own values on the preview server, so OpsCrew keeps none to rotate. Nothing was changed.`,
      { hint: `Only its preview key is OpsCrew's: \`opscrew rotate preview-key${flags}\`.` },
    );
  }
  await assertValuesCurrent(deps);
  await registerAppSecrets(deps, plan);
  const existing = await readPendingRotation(deps);
  const sorted = (list: readonly string[]) => [...list].sort();
  const reused =
    existing !== undefined && isDeepStrictEqual(sorted(existing.names), sorted(named))
      ? existing
      : undefined;
  // A rotation only planned changed nothing yet: one of other services replaces it.
  if (existing !== undefined && reused === undefined && existing.step !== "planned") {
    const theirs = `opscrew rotate ${existing.names.join(" ")}${flags}`;
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `The rotation of ${listText(existing.names)} in ${environment} is unfinished: its new values are on this computer, and maybe on the servers. Nothing was changed.`,
      {
        hint: `Finish it with \`${theirs}\`, or put the old values back with \`${theirs} --undo\`, then run this command again.`,
      },
    );
  }
  if (options.undo === true && reused === undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `No rotation of ${listText(named)} is unfinished in ${environment}, so there is nothing to undo. Nothing was changed.`,
    );
  }
  if (options.undo === true && reused?.step === "planned") {
    // Never approved: nothing but this computer's file holds its new values.
    await dropPendingRotation(deps);
    deps.reporter.success(
      `Forgot the rotation of ${listText(named)} in ${environment}: it was never approved, so nothing else had changed.`,
    );
    return { hash: reused.hash, copy: { changed: false }, values: reused };
  }
  if (options.undo === true && reused?.step === "switched") {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `The app's server finished the rotation of ${listText(named)}: the app runs on the new values and the old ones may be gone, so it can't be undone. Nothing was changed.`,
      { hint: `It only goes forward: run \`${again}\` to finish it.` },
    );
  }
  await requireNoDeployOrMove(
    { deps, plan, environment, flags, services: { github: options.github.api } },
    "rotate credentials",
  );
  await requireNoPause(
    deps,
    options.github,
    plan,
    again,
    flags,
    reused !== undefined && reused.step !== "planned" ? reused.hash : undefined,
  );
  const runs = serverRuns(plan, [...serviceSteps(plan, services), ...grantSteps(grants)]);
  const hosts = new Map<string, RotateHost>();
  for (const run of runs) hosts.set(run.server, await rotateHost(deps, plan, run.server, options));
  if (options.undo !== true) await requireCurrentStarts(deps, plan, runs, hosts, again, flags);
  const appEnv =
    runs.length === 0
      ? undefined
      : await readAppEnv(deps, hosts.get(APP_SERVER) as RotateHost, plan, again, flags);
  const values = reused ?? (await newRotationValues(deps, services, grants));
  const envFiles = await envFilesWith(deps, plan, values, appEnv, "new");
  const input: RotationPlan = {
    services,
    values,
    runs,
    secrets: runs.length === 0 ? [] : rotatedSecrets(changed).map((n) => secretPlace(plan, n)),
  };
  const hash = rotationHash(deps, plan, input);
  // The servers' state of a rotation that began is bound to its hash.
  if (reused !== undefined && reused.step !== "planned" && reused.hash !== hash) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `The rotation of ${listText(named)} began under another plan (the plan, its servers or the version of OpsCrew changed since), and its servers hold that rotation's state. Nothing was changed.`,
      {
        hint: `Put opscrew/ back as it was when the rotation began and use the same version of OpsCrew, then run \`${again}\` again.`,
      },
    );
  }
  const from = reused?.step ?? "planned";
  // Kept before the approval, so a run approved by the hash shown reuses the same values.
  const pending: PendingRotation = { ...values, hash, step: from };
  await keepPendingRotation(deps, pending);
  const paused = {
    ...(options.sleep ? { sleep: options.sleep } : {}),
    ...(options.now ? { now: options.now } : {}),
  };
  const rotation: Rotation = { deps, plan, hash, pending, from, runs, hosts, envFiles, again };

  if (options.undo === true) {
    const undo = await approveUndo(deps, input, hash, again);
    if (runs.length > 0) {
      const old = await envFilesWith(deps, plan, values, appEnv, "old");
      await withDeploysPausedUntilDone(
        deps,
        options.github,
        plan,
        paused,
        { command: `${again} --undo`, hash },
        () => undoOnServers(rotation, secretValues(changed, old), options.github),
      );
    }
    await dropPendingRotation(deps);
    deps.reporter.success(
      `Put the old values of ${listText(named)} back in ${environment}: the app runs on them again, and the new ones are forgotten.`,
    );
    return { hash: undo, copy: await refreshRecoveryCopy(deps, plan), values };
  }

  await approveRotation(deps, plan, input, again);
  if (runs.length > 0) {
    rotation.pending = { ...pending, step: from === "planned" ? "started" : from };
    await keepPendingRotation(deps, rotation.pending);
    await withDeploysPausedUntilDone(
      deps,
      options.github,
      plan,
      paused,
      { command: again, hash },
      () => rotateOnServers(rotation, secretValues(changed, envFiles), options.github),
    );
  }
  const record = (await readCredentialsRecord(deps)).environments[environment] ?? {};
  await completePendingRotation(
    deps,
    plan,
    values,
    Object.fromEntries(named.map((name) => [name, record[name]?.generation ?? 1])),
  );
  await recordRotation(deps, named);
  deps.reporter.success(
    runs.length === 0
      ? `Made new values for ${listText(named)} in ${environment} on this computer: ${named.length === 1 ? "it is" : "they are"} off and start with them.`
      : `Rotated the credentials of ${listText(named)} in ${environment}: the app runs on the new values, and the old ones no longer work.`,
  );
  return { hash, copy: await refreshRecoveryCopy(deps, plan), values };
}
