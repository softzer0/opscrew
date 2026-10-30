import { publishedOnNetwork } from "@opscrew/iac-templates";
import { APP_SERVER, type DeployPlan } from "@opscrew/plan-schema";

/**
 * What a server's `network` and `network-filter` steps are planned from besides the plan, as
 * provision and drift both plan them:
 * - `dashboardsOnNetwork`: Beszel's and Portainer's dashboards are published on the app server's
 *   private address for the devices, only when the network has devices and that server hosts this
 *   app alone (`alone`: always on a server OpsCrew created);
 * - `published`: each port published on the server's private address (`publishedOnNetwork`);
 * - `localPorts`: the services' TCP ports among them (not the dashboards'), which the server's own
 *   Docker networks may reach.
 */
export function serverNetworkInputs(
  plan: DeployPlan,
  server: string,
  alone: boolean,
): {
  dashboardsOnNetwork: boolean;
  published: ReturnType<typeof publishedOnNetwork>;
  localPorts: number[];
} {
  const dashboardsOnNetwork =
    server === APP_SERVER && (plan.network?.devices.length ?? 0) > 0 && alone;
  const published = publishedOnNetwork(plan, server, { dashboardsOnNetwork });
  const localPorts = [
    ...new Set(published.filter((entry) => entry.dashboard !== true).map((entry) => entry.port)),
  ];
  return { dashboardsOnNetwork, published, localPorts };
}
