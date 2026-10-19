import type { DeployPlan } from "@opscrew/plan-schema";

/**
 * Memory OpsCrew's edge takes on a server (research R7, data-model.md "Sizing figures"): Caddy
 * 64 MB, kamal-proxy 32 MB and cloudflared 32 MB.
 */
export const EDGE_MEMORY_MB = 128;

/** Memory left to the operating system, Docker and the shell on every server. */
export const SYSTEM_RESERVE_MB = 384;

/** Below this share of the server's memory (after the system's) left free, design warns. */
const MIN_HEADROOM = 0.15;

/** What the memory limits of an app's containers are read from: a plan or design's components. */
export type AppMemoryInput = {
  app: Pick<DeployPlan["app"], "memoryMb">;
} & Pick<DeployPlan, "processes" | "services">;

/**
 * The sum of the memory limits of the app's containers in MB: the web process, each enabled
 * worker times its copies, each enabled service, and the cron container when a cron job is enabled
 * (it runs the app's image with the web process's limit).
 */
export function appMemoryMb(plan: AppMemoryInput): number {
  const workers = plan.processes.workers
    .filter((worker) => worker.enabled)
    .reduce((sum, worker) => sum + worker.memoryMb * worker.count, 0);
  const services = plan.services
    .filter((service) => service.enabled)
    .reduce((sum, service) => sum + service.memoryMb, 0);
  const cron = plan.processes.cron.some((job) => job.enabled) ? plan.app.memoryMb : 0;
  return plan.app.memoryMb + workers + services + cron;
}

/**
 * How a server of `serverMb` holds containers with `limitsMb` of limits next to the edge: the
 * share of its memory after the system's reserve that is left free (negative when they do not
 * fit), and whether that is below {@link MIN_HEADROOM}.
 */
export function memoryHeadroom(
  serverMb: number,
  limitsMb: number,
): { free: number; low: boolean; fits: boolean } {
  const usable = serverMb - SYSTEM_RESERVE_MB;
  const free = usable <= 0 ? -1 : (usable - limitsMb - EDGE_MEMORY_MB) / usable;
  return { free, fits: free >= 0, low: free < MIN_HEADROOM };
}
