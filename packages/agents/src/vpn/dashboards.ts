import type { HostFacts } from "@opscrew/connector-ssh-host";
import { APP_SERVER, type DeployPlan, networkInterface } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { serverNetworkInputs } from "../network";
import { readServerAddresses } from "../shared/server-record";

/** A dashboard on the app's server's private address, for this computer's device. */
export interface DashboardOnNetwork {
  /** This computer's device (`thisDevice`). */
  device: string;
  /** The app's server's private address. */
  address: string;
  port: number;
}

/**
 * Where Beszel's hub or Portainer's web UI answers for this computer on the app's private network:
 * when this computer is a device on it (`thisDevice`), the app's server is one OpsCrew created
 * (so it has a public address and hosts this app alone) and the dashboard is published on its
 * private address (`publishedOnNetwork` with the network's devices). `undefined` otherwise, so the
 * SSH tunnel is used (it works over the network too), and when this computer's server record
 * can't be read.
 */
export async function dashboardOnNetwork(
  deps: Pick<PhaseDeps, "paths">,
  plan: DeployPlan,
  dashboard: "beszel" | "portainer",
): Promise<DashboardOnNetwork | undefined> {
  // The user's own server may be shared or have no public address (only an own server lacks one).
  if (plan.network === undefined || plan.target.provider === "own") return undefined;
  const device = (await readServerAddresses(deps.paths).catch(() => undefined))?.thisDevice;
  if (device === undefined) return undefined;
  const entry = serverNetworkInputs(plan, APP_SERVER, true).published.find(
    (item) => item.dashboard === true && item.service === dashboard,
  );
  return entry === undefined ? undefined : { device, address: entry.address, port: entry.port };
}

/**
 * True when the app's server has the app's WireGuard interface already (`facts.network`): Docker
 * publishes a dashboard only on an address the server has.
 */
export function hasAppInterface(
  plan: Pick<DeployPlan, "network">,
  facts: Pick<HostFacts, "network">,
): boolean {
  const member = plan.network?.members.find((m) => m.name === APP_SERVER);
  if (member === undefined) return false;
  return facts.network?.interfaces.some((i) => i.name === networkInterface(member)) ?? false;
}
