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
import { appServerShell, privateReach, serverLogin, serverWords } from "../shared";

/** One of the app's servers as a move reaches it. */
export interface MoveShell {
  /** `app` or an extra server's name. */
  name: string;
  /** The deploy user's shell there. */
  remote: RemoteExec;
  /** The SSH port OpsCrew connects to there, with `remote.host`. */
  port: number;
}

/**
 * The deploy user's shell on the server `name` (`app` or an extra server), where the deploy logs
 * in, with the project's deploy key (`appServerShell`): at its login's address and port, or once
 * public SSH is closed at its private address and the port sshd listens on there
 * (`privateReach`), its host key pinned under it, saying when this computer's tunnel looks down.
 * `services.remote` stands in for ssh in tests.
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
  const { port } = (await privateReach(deps, plan, name, login)) ?? login;
  const remote = await appServerShell(deps, plan, login, services, name);
  return { name, remote, port };
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
