import { OpsCrewError } from "@opscrew/core";
import { APP_SERVER, type DeployPlan } from "@opscrew/plan-schema";
import type { EngineDeps } from "../shared/engine";
import { serverAddress } from "../shared/server-address";
import { readServerAddresses } from "../shared/server-record";
import { appServers } from "../shared/servers";
import { monitoringOwner } from "./owner";

/**
 * The old app server's name on the private network while a move to another app server runs
 * (`retarget.from.member`): the name `servers` may never use.
 */
export const PREVIOUS_MEMBER = "previous";

/**
 * True when the server has a public address WireGuard can reach: every extra server, and the
 * app's server unless it is the user's own behind a Cloudflare Tunnel (`access: tunnel`).
 */
export function hasPublicAddress(
  plan: { target: Pick<DeployPlan["target"], "provider"> & { access?: string } },
  server: string,
): boolean {
  return server !== APP_SERVER || plan.target.provider !== "own" || plan.target.access === "public";
}

/**
 * The public address of each of the app's servers that has one ({@link hasPublicAddress}), by
 * server name, from this computer's server record: the endpoints of the network's peers. A server
 * the user owns is reached at the public address it was given (else the address OpsCrew logs in
 * at). The monitoring server another environment owns, when the plan sends to it, is reached at
 * the address in that environment's record, which is never in the plan. During a move to another
 * app server (`plan.retarget`), `app` is the new one (the move's record of its address, or the
 * user's own server's login) and, while the old app server is still a member
 * (`retarget.from.member`), it is {@link PREVIOUS_MEMBER} at its address in the move's record.
 * @throws OpsCrewError `PHASE_PRECONDITION` when a server's public address is not on this computer.
 */
export async function publicEndpoints(
  deps: EngineDeps,
  plan: DeployPlan,
): Promise<Record<string, string>> {
  const record = await readServerAddresses(deps.paths);
  const move = plan.retarget;
  const endpoints: Record<string, string> = {};
  for (const name of appServers(plan)) {
    if (!hasPublicAddress(plan, name)) continue;
    const address =
      name !== APP_SERVER
        ? record.servers?.[name]?.ipv4
        : plan.target.provider === "own"
          ? (record.own?.publicIpv4 ?? record.own?.host)
          : move !== undefined
            ? record.retarget?.next?.ipv4
            : (await serverAddress(deps, plan))?.ipv4;
    if (address === undefined) {
      throw new OpsCrewError(
        "PHASE_PRECONDITION",
        `OpsCrew does not know the public address of server ${name} on this computer, so it cannot link the app's servers.`,
        {
          hint: "Run the command on the computer that ran `opscrew provision` (it keeps the servers' addresses in .opscrew/server.json).",
        },
      );
    }
    endpoints[name] = address;
  }
  const from = move?.from.member === undefined ? undefined : move.from.target;
  if (from !== undefined && hasPublicAddress({ target: from }, APP_SERVER)) {
    const old = record.retarget;
    const address =
      from.provider === "own" ? (old?.fromOwn?.publicIpv4 ?? old?.fromOwn?.host) : old?.from?.ipv4;
    // The old app server keeps its links up from its side: its endpoint is only a help.
    if (address !== undefined) endpoints[PREVIOUS_MEMBER] = address;
  }
  const owner = monitoringOwner(deps.paths, plan);
  if (owner === undefined) return endpoints;
  const address = (await readServerAddresses(owner.paths)).servers?.[owner.server]?.ipv4;
  if (address === undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `OpsCrew does not know the public address of the monitoring server ${owner.server} on this computer, so it cannot link the app's servers to it.`,
      {
        hint: `Run the command on the computer that ran \`opscrew provision\` for the plan ${owner.plan} (it keeps that server's address in its .opscrew/ folder).`,
      },
    );
  }
  endpoints[owner.server] = address;
  return endpoints;
}
