/**
 * `opscrew vpn add` and `vpn remove` on an environment that sends to another environment's
 * monitoring server (feature 020, US3, US5 #5): that server's interface for this network learns of
 * the device too, over its owner's login, so the device reaches Grafana at once.
 */
import { type DeployPlan, MONITORING_GRAFANA_PORT, networkInterface } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { readOwnerPlan } from "../monitoring/repository";
import { monitoringOwner } from "../network";
import type { NetworkServer } from "../provision/network";
import { networkServer, type VpnServices } from "./servers";

/** The monitoring server another environment owns, as `opscrew vpn` changes it. */
export interface SharedMonitoringServer {
  /** The server, inspected now over its owner's login. */
  server: NetworkServer;
  /** `server monitoring of opscrew/plan.yaml`. */
  words: string;
  /** Grafana's address for the devices on this plan's network. */
  grafana: string;
}

/**
 * The monitoring server another environment owns that `plan` sends to (`where.kind` "shared"),
 * inspected read-only now over its owner's login, when it has this network's interface already;
 * `undefined` for every other plan, and before provision has joined that server (provision adds
 * the interface with the network's devices then).
 * @throws OpsCrewError `PHASE_PRECONDITION` before any change when the owner's plan is gone or no
 * longer runs that server, or when its login is not on this computer.
 */
export async function sharedMonitoringServer(
  deps: PhaseDeps,
  plan: DeployPlan,
  services: Pick<VpnServices, "remote" | "host">,
): Promise<SharedMonitoringServer | undefined> {
  const owner = monitoringOwner(deps.paths, plan);
  const member = plan.network?.members.find((m) => m.name === owner?.server);
  if (owner === undefined || member === undefined) return undefined;
  const ownerPlan = await readOwnerPlan(deps, owner, "Nothing was changed.");
  const server = await networkServer(
    { ...deps, paths: owner.paths },
    ownerPlan,
    owner.server,
    services,
  );
  if (!server.facts.wireguardInterfaces.includes(networkInterface(member))) return undefined;
  return {
    server,
    words: `server ${owner.server} of ${owner.plan}`,
    grafana: `http://${member.address}:${MONITORING_GRAFANA_PORT}`,
  };
}
