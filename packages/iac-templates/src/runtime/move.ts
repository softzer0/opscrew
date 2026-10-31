/**
 * A live service's move between the app's servers (`plan.move`, feature 018, ADR 0022). Until its
 * switch the service runs on both servers: the new copy where `services[].server` places it
 * (`move.to`), and the old copy on `move.from`, which the app still uses. Once switched, only the
 * new copy is rendered and the app uses it; the old copy's data folder stays on `move.from`.
 */
import { APP_SERVER, type DeployPlan, type PlanService, servicesOn } from "@opscrew/plan-schema";

/** The plan's move of `service` while it waits for its switch; else undefined. */
function beforeSwitch(plan: Pick<DeployPlan, "move">, service: string) {
  const { move } = plan;
  return move !== undefined && move.step !== "switched" && move.service === service
    ? move
    : undefined;
}

/**
 * The server the app reaches `service` on: during its move until the switch the old copy's
 * (`move.from`), else the server it is placed on ({@link APP_SERVER} when absent).
 */
export function appServerOf(plan: Pick<DeployPlan, "move">, service: PlanService): string {
  return beforeSwitch(plan, service.name)?.from ?? service.server ?? APP_SERVER;
}

/**
 * The enabled services that run on `server` ({@link APP_SERVER} or an extra server's name), in the
 * plan's order: those placed there and, during a move until its switch, the moved service's old
 * copy on `move.from` (its entry placed there).
 */
export function servicesRunningOn(
  plan: Pick<DeployPlan, "services" | "move">,
  server: string,
): PlanService[] {
  const placed = servicesOn(plan, server);
  const { move } = plan;
  if (move === undefined || move.from !== server) return placed;
  return plan.services.flatMap((service) => {
    if (placed.includes(service)) return [service];
    if (!service.enabled || beforeSwitch(plan, service.name) === undefined) return [];
    const { server: _to, ...rest } = service;
    return [server === APP_SERVER ? rest : { ...rest, server }];
  });
}
