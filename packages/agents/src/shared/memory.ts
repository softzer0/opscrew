import { cronMemoryMb, EDGE_MEMORY_MB } from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";

/** Memory left to the operating system, Docker and the shell on every server. */
export const SYSTEM_RESERVE_MB = 384;

/** Below this share of the server's memory (after the system's) left free, design warns. */
const MIN_HEADROOM = 0.15;

/** What the memory limits of an app's containers are read from: a plan or design's components. */
export type AppMemoryInput = {
  app: Pick<DeployPlan["app"], "memoryMb">;
} & Pick<DeployPlan, "processes" | "services">;

/**
 * Each running container's memory limit in MB with its name, the web process first: each enabled
 * worker times its copies, the cron container when a cron job is enabled (its limit from
 * `cronMemoryMb`), then each enabled service.
 */
export function appMemoryLimits(plan: AppMemoryInput): { name: string; memoryMb: number }[] {
  const cron = cronMemoryMb(plan);
  return [
    { name: "the app", memoryMb: plan.app.memoryMb },
    ...plan.processes.workers
      .filter((worker) => worker.enabled)
      .map((worker) => ({ name: worker.name, memoryMb: worker.memoryMb * worker.count })),
    ...(cron === undefined ? [] : [{ name: "cron", memoryMb: cron }]),
    ...plan.services
      .filter((service) => service.enabled)
      .map((service) => ({ name: service.name, memoryMb: service.memoryMb })),
  ];
}

/** The sum of the memory limits of the app's containers in MB ({@link appMemoryLimits}). */
export function appMemoryMb(plan: AppMemoryInput): number {
  return appMemoryLimits(plan).reduce((sum, limit) => sum + limit.memoryMb, 0);
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
