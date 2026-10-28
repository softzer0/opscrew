import { cronMemoryMb } from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";

/** Memory left to the operating system, Docker and the shell on every server. */
export const SYSTEM_RESERVE_MB = 384;

/** Below this share of the server's memory (after the system's) left free, design warns. */
const MIN_HEADROOM = 0.15;

/**
 * What the memory limits of an app's containers are read from: a plan or design's components (with
 * the plan's add-ons when it has them).
 */
export type AppMemoryInput = {
  app: Pick<DeployPlan["app"], "memoryMb">;
} & Pick<DeployPlan, "processes" | "services"> &
  Partial<Pick<DeployPlan, "observability">>;

/**
 * Each running container's memory limit in MB with its name, the web process first: each enabled
 * worker times its copies, the cron container when a cron job is enabled (its limit from
 * `cronMemoryMb`), each enabled service, then each enabled add-on with all its containers (Beszel:
 * its hub in hub mode, its agent and its Docker proxy; Grafana Alloy: Alloy and its Docker proxy).
 */
export function appMemoryLimits(plan: AppMemoryInput): { name: string; memoryMb: number }[] {
  const cron = cronMemoryMb(plan);
  const beszel = plan.observability?.beszel;
  const grafana = plan.observability?.grafanaCloud;
  return [
    { name: "the app", memoryMb: plan.app.memoryMb },
    ...plan.processes.workers
      .filter((worker) => worker.enabled)
      .map((worker) => ({ name: worker.name, memoryMb: worker.memoryMb * worker.count })),
    ...(cron === undefined ? [] : [{ name: "cron", memoryMb: cron }]),
    ...plan.services
      .filter((service) => service.enabled)
      .map((service) => ({ name: service.name, memoryMb: service.memoryMb })),
    ...(beszel?.enabled
      ? [
          {
            name: "Beszel",
            memoryMb:
              (beszel.mode === "hub" ? beszel.memoryMb.hub : 0) +
              beszel.memoryMb.agent +
              beszel.memoryMb.proxy,
          },
        ]
      : []),
    ...(grafana?.enabled
      ? [{ name: "Grafana Alloy", memoryMb: grafana.memoryMb.alloy + grafana.memoryMb.proxy }]
      : []),
  ];
}

/** The sum of the memory limits of the app's containers in MB ({@link appMemoryLimits}). */
export function appMemoryMb(plan: AppMemoryInput): number {
  return appMemoryLimits(plan).reduce((sum, limit) => sum + limit.memoryMb, 0);
}

/**
 * How a server of `serverMb` holds containers with `limitsMb` of limits next to the edge's
 * `edgeMb`: the share of its memory after the system's reserve that is left free (negative when
 * they do not fit), and whether that is below {@link MIN_HEADROOM}.
 */
export function memoryHeadroom(
  serverMb: number,
  limitsMb: number,
  edgeMb: number,
): { free: number; low: boolean; fits: boolean } {
  const usable = serverMb - SYSTEM_RESERVE_MB;
  const free = usable <= 0 ? -1 : (usable - limitsMb - edgeMb) / usable;
  return { free, fits: free >= 0, low: free < MIN_HEADROOM };
}
