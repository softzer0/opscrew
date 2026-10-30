/**
 * Where the app's services and dashboards are published on the private network (ADR 0022): each
 * server's private address is its member's in `plan.network`.
 */
import { APP_SERVER, type DeployPlan, type PlanService } from "@opscrew/plan-schema";
import type { RenderContext } from "../types";

/**
 * The private address of `server` ({@link APP_SERVER} or an extra server's name) on the plan's
 * network.
 * @throws Error when the plan's network has no such member (a plan the schema refuses).
 */
export function privateAddress(plan: DeployPlan, server: string): string {
  const member = plan.network?.members.find((m) => m.name === server);
  if (member === undefined) {
    throw new Error(`The plan's network has no member ${server} with a private address.`);
  }
  return member.address;
}

/**
 * The private address `service` is published on, or undefined: on an extra server always that
 * server's, so the app reaches it; on the app's server only with a device's grant, the app's
 * server's own.
 */
export function publishedAddress(plan: DeployPlan, service: PlanService): string | undefined {
  const server = service.server ?? APP_SERVER;
  if (server !== APP_SERVER) return privateAddress(plan, server);
  const granted = plan.network?.grants.some((grant) => grant.service === service.name);
  return granted ? privateAddress(plan, APP_SERVER) : undefined;
}

/**
 * The app's server's private address with `ctx.dashboardsOnNetwork`, where Beszel's hub and
 * Portainer's web UI are then also published for the devices; else undefined.
 */
export function dashboardAddress(
  plan: DeployPlan,
  ctx: Pick<RenderContext, "dashboardsOnNetwork">,
): string | undefined {
  return ctx.dashboardsOnNetwork ? privateAddress(plan, APP_SERVER) : undefined;
}
