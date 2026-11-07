/**
 * The machines whose `snapshot.sh` holds the app's snapshots (024 plan.md 3.): the app's server and
 * each extra server with data (018), through the access `opscrew logs` uses ({@link serverShell}),
 * or this computer through the local executor. Every command runs in the app's folder as the
 * deploy user, its folder's owner, and its output is never shown as it is.
 */
import type { CommandResult } from "@opscrew/contracts";
import { OpsCrewError, upperFirst } from "@opscrew/core";
import { appDir, SNAPSHOT_SCRIPT, shellQuote, snapshotParts } from "@opscrew/iac-templates";
import { APP_SERVER, type DeployPlan } from "@opscrew/plan-schema";
import { computer, localShell, requireShell } from "../localhost/services";
import { serverWords } from "../shared/server-address";
import { serverShell } from "../status/servers";
import { type SnapshotRun, snapshotTarget } from "./run";

/** One machine with the app's folder: a server, or this computer. */
export interface ScriptHost {
  /** The server's name in the plan: `app` or an extra server's (`app` on this computer). */
  server: string;
  /** It in words: `the app's server`, `server data`, `this computer`. */
  name: string;
  /** Where it is, in words: `on the app's server`, `on server data`, `on this computer`. */
  where: string;
  /** The audit entry's target, never an address. */
  audit: string;
  /** True for this computer, whose parts belong to no server. */
  local: boolean;
  /** Runs `command` (POSIX sh) in the app's folder as the deploy user. */
  run(command: string, timeoutMs: number): Promise<CommandResult>;
}

/** The exit code of a command whose machine has no app's folder. */
const NO_FOLDER = 3;
/** The exit code of a script command whose app's folder has no `snapshot.sh`. */
const NO_SCRIPT = 4;

/** How long a read or a deletion may take. */
export const READ_TIMEOUT_MS = 2 * 60_000;

/**
 * `command` as the deploy user: through `runuser` in a root shell (the user's own server through
 * its admin login, as root or through `sudo -n`), as it is otherwise (`deploy` itself).
 */
function asDeploy(command: string): string {
  const quoted = shellQuote(command);
  return `if [ "$(id -u)" = 0 ]; then runuser -u deploy -- sh -c ${quoted}; else sh -c ${quoted}; fi`;
}

/** `sh snapshot.sh <args>`, stopping with {@link NO_SCRIPT} when the deploy has not uploaded it. */
export function scriptCommand(args: readonly string[]): string {
  return `[ -f ${SNAPSHOT_SCRIPT} ] || exit ${NO_SCRIPT}; sh ${SNAPSHOT_SCRIPT} ${args.map(shellQuote).join(" ")}`;
}

/** The servers with data, whose `snapshot.sh` the deploy uploads: the app's first. */
export function dataServers(plan: DeployPlan): string[] {
  return [APP_SERVER, ...(plan.servers ?? []).map((server) => server.name)].filter(
    (server) => snapshotParts(plan, server).length > 0,
  );
}

/**
 * The server `server` of `run`'s plan, as the deploy user: its address is registered with the
 * redactor, so no output or error shows it.
 */
export async function serverHost(run: SnapshotRun, server: string): Promise<ScriptHost> {
  const { deps, plan, services } = run;
  const { docker, login } = await serverShell(deps, plan, server, services);
  deps.redactor.addName(login.host, "server-address");
  const dir = appDir(plan);
  return {
    server,
    name: serverWords(server),
    where: `on ${serverWords(server)}`,
    audit: `server ${server}`,
    local: false,
    run: (command, timeoutMs) =>
      docker.run(`cd ${shellQuote(dir)} || exit ${NO_FOLDER}; ${asDeploy(command)}`, {
        timeoutMs,
      }),
  };
}

/** This computer's app's folder, through the local executor. */
export async function computerHost(run: SnapshotRun): Promise<ScriptHost> {
  const { deps, plan, services } = run;
  const exec = await localShell(deps, await requireShell(computer(deps, services.localhost)));
  const dir = `"$OPSCREW_APPS_DIR"/${shellQuote(plan.app.name)}`;
  return {
    server: APP_SERVER,
    name: "this computer",
    where: "on this computer",
    audit: "this computer",
    local: true,
    run: (command, timeoutMs) =>
      exec.run(`cd ${dir} || exit ${NO_FOLDER}; ${command}`, { timeoutMs }),
  };
}

/**
 * The machines with data of `run`'s target, by server: this computer alone (as `app`), or each
 * of `servers` (every server with data by default, the app's first).
 */
export async function dataHosts(
  run: SnapshotRun,
  servers: readonly string[] = dataServers(run.plan),
): Promise<Map<string, ScriptHost>> {
  if (snapshotTarget(run) === "computer") return new Map([[APP_SERVER, await computerHost(run)]]);
  const hosts = new Map<string, ScriptHost>();
  for (const server of servers) hosts.set(server, await serverHost(run, server));
  return hosts;
}

/** The last lines `snapshot.sh` wrote on stderr, redacted: its messages never quote data. */
export function scriptSaid(result: CommandResult, redact: (text: string) => string): string {
  const lines = result.stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return redact(lines.slice(-3).join(" ")).slice(0, 600);
}

/**
 * The plain error of a command on `host` that failed: the machine did not answer, has no app's
 * folder or no `snapshot.sh`, or what the script said. `what` follows "could not" (`take the
 * snapshot`); `command` is the one to run again.
 */
export function hostFailure(
  run: SnapshotRun,
  host: ScriptHost,
  result: CommandResult,
  what: string,
): OpsCrewError {
  const { deps, plan, flags } = run;
  const where = host.where;
  if (result.exitCode === 255 || result.timedOut === true) {
    return new OpsCrewError(
      "COMMAND_FAILED",
      `${upperFirst(host.name)} did not answer${host.local ? "" : " over SSH"}, so OpsCrew could not ${what}.`,
      { hint: "Check that it is on and reachable (`opscrew status`), then try again." },
    );
  }
  if (result.exitCode === NO_FOLDER || result.exitCode === NO_SCRIPT) {
    return new OpsCrewError(
      "PHASE_PRECONDITION",
      result.exitCode === NO_FOLDER
        ? `There is no folder of ${plan.app.name} ${where}, so OpsCrew could not ${what}.`
        : `The app's folder ${where} has no ${SNAPSHOT_SCRIPT}, which each deploy uploads, so OpsCrew could not ${what}.`,
      {
        hint: `Deploy the app again (push to ${plan.cicd.branch}, or run \`opscrew provision${flags}\`), then try again.`,
      },
    );
  }
  const said = scriptSaid(result, deps.redactor.redact);
  return new OpsCrewError(
    "COMMAND_FAILED",
    `OpsCrew could not ${what} ${where} (exit code ${result.exitCode})${said === "" ? "." : `: ${said}`}`,
    { hint: "Fix what it names, then try again." },
  );
}
