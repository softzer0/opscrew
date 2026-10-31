/**
 * How a move reaches the app's servers (feature 018): as `deploy` with the project's deploy key on
 * each one, as the deploy does, so the database dump each server writes is the one `scp -3` reads.
 */
import type { RemoteExec } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { appDir } from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import type { ProvisionServices } from "../provision/types";
import { SshRemoteExec, serverLogin, serverRemote, serverWords } from "../shared";

/** One of the app's servers as a move reaches it. */
export interface MoveShell {
  /** `app` or an extra server's name. */
  name: string;
  /** The deploy user's shell there. */
  remote: RemoteExec;
  /** Its SSH port. */
  port: number;
}

/**
 * The deploy user's shell on the server `name` (`app` or an extra server), where the deploy logs
 * in: the project's deploy key, the login's SSH port, and the address OpsCrew connects to there
 * (`serverRemote`'s: the private one once public SSH is closed, its host key pinned under it).
 * `services.remote` stands in for it in tests.
 * @throws OpsCrewError `PHASE_PRECONDITION` when the server's address or login is not on this
 * computer.
 */
export async function moveShell(
  deps: PhaseDeps,
  plan: DeployPlan,
  services: Pick<ProvisionServices, "remote">,
  name: string,
): Promise<MoveShell> {
  const login = await serverLogin(deps, plan, name);
  const { host } = await serverRemote(deps, plan, name);
  const remote =
    services.remote?.(host) ??
    new SshRemoteExec({
      host,
      port: login.port,
      keyFile: deps.paths.files.deployKey,
      knownHostsFile: deps.paths.files.knownHosts,
      runner: deps.runner,
    });
  return { name, remote, port: login.port };
}

/**
 * The services of the app's Compose project running on `shell`'s server (read-only); none when the
 * project is not there yet.
 * @throws OpsCrewError `COMMAND_FAILED` when the server does not answer over SSH.
 */
export async function runningServices(shell: MoveShell, plan: DeployPlan): Promise<string[]> {
  const result = await shell.remote.run(
    `cd ${appDir(plan)} && docker compose ps --status running --services`,
    { timeoutMs: 60_000 },
  );
  if (result.exitCode === 255 || result.timedOut === true) {
    throw new OpsCrewError(
      "COMMAND_FAILED",
      `OpsCrew could not reach ${serverWords(shell.name)} over SSH to see what runs there.`,
      { hint: "Check that it is on and reachable, then run `opscrew provision` again." },
    );
  }
  if (result.exitCode !== 0) return [];
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
}
