import { OpsCrewError, readTextIfExists } from "@opscrew/core";
import { APP_SERVER, type DeployPlan } from "@opscrew/plan-schema";
import type { EngineDeps } from "../shared/engine";
import { privateReach, serverLogin } from "../shared/server-address";
import { keysFor, knownHostsName } from "../shared/wait";
import type { CheckServerReach } from "./secrets";

/** An entry of an environment's server secret: the server's name in the plan and its reach. */
export interface CheckServerEntry extends CheckServerReach {
  /** `app`, or an extra server's name. */
  id: string;
}

/**
 * Every server of `plan`'s environment the scheduled check reads over SSH, as its server secret
 * lists them (feature 018, FR-1811): the app's (`app`, when it is read over SSH), then each extra
 * server in plan order as `deploy` with the host key pinned on this computer. With public SSH
 * closed (`network.publicSsh: false`) each entry is the server's private address on the port sshd
 * listens on there (`privateReach`), which the environment's runner inside the private network
 * reaches, with the same host key.
 * @throws OpsCrewError `PHASE_PRECONDITION` when an extra server's login or host key is not on
 * this computer.
 */
export async function checkServerEntries(
  deps: EngineDeps,
  plan: DeployPlan,
  app: CheckServerReach | undefined,
): Promise<CheckServerEntry[]> {
  /**
   * The entry for `id` (`own`: a server the user owns), with `keys` (`type key`) pinned under the
   * address the check connects to: the private one once public SSH is closed.
   */
  const entry = async (
    id: string,
    own: boolean,
    reach: Omit<CheckServerReach, "knownHosts">,
    keys: string[],
  ): Promise<CheckServerEntry> => {
    const at = (await privateReach(deps, plan, id, { port: reach.port, own })) ?? reach;
    const name = knownHostsName(at.host, at.port);
    return {
      id,
      ...reach,
      host: at.host,
      port: at.port,
      knownHosts: `${keys.map((key) => `${name} ${key}`).join("\n")}\n`,
    };
  };
  const entries: CheckServerEntry[] =
    app === undefined
      ? []
      : [
          await entry(
            APP_SERVER,
            plan.target.provider === "own",
            app,
            keysFor(app.knownHosts, knownHostsName(app.host, app.port)),
          ),
        ];
  const pinned = (await readTextIfExists(deps.paths.files.knownHosts)) ?? "";
  for (const server of plan.servers ?? []) {
    const login = await serverLogin(deps, plan, server.name);
    const keys = keysFor(pinned, knownHostsName(login.host, login.port));
    if (keys.length === 0) {
      throw new OpsCrewError(
        "PHASE_PRECONDITION",
        `The SSH host key of server ${server.name} is not pinned on this computer, so the scheduled check can't be told which server it reads.`,
        {
          hint: "Run `opscrew provision` on the computer that set up the servers; it pins each server's host key.",
        },
      );
    }
    entries.push(
      await entry(
        server.name,
        login.own,
        { host: login.host, port: login.port, user: "deploy" },
        keys,
      ),
    );
  }
  return entries;
}
