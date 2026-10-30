import { OpsCrewError } from "@opscrew/core";
import { APP_SERVER, type DeployPlan } from "@opscrew/plan-schema";
import type { EngineDeps } from "../shared/engine";
import { serverAddress } from "../shared/server-address";
import { readServerAddresses } from "../shared/server-record";

/**
 * True when the server has a public address WireGuard can reach: every extra server, and the
 * app's server unless it is the user's own behind a Cloudflare Tunnel (`access: tunnel`).
 */
export function hasPublicAddress(plan: Pick<DeployPlan, "target">, server: string): boolean {
  return server !== APP_SERVER || plan.target.provider !== "own" || plan.target.access === "public";
}

/**
 * The public address of each of the app's servers that has one ({@link hasPublicAddress}), by
 * server name, from this computer's server record: the endpoints of the network's peers. A server
 * the user owns is reached at the public address it was given (else the address OpsCrew logs in
 * at).
 * @throws OpsCrewError `PHASE_PRECONDITION` when a server's public address is not on this computer.
 */
export async function publicEndpoints(
  deps: EngineDeps,
  plan: DeployPlan,
): Promise<Record<string, string>> {
  const record = await readServerAddresses(deps.paths);
  const endpoints: Record<string, string> = {};
  for (const name of [APP_SERVER, ...(plan.servers ?? []).map((s) => s.name)]) {
    if (!hasPublicAddress(plan, name)) continue;
    const address =
      name === APP_SERVER && plan.target.provider === "own"
        ? (record.own?.publicIpv4 ?? record.own?.host)
        : (await serverAddress(deps, plan, name))?.ipv4;
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
  return endpoints;
}
