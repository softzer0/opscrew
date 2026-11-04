import { cronMemoryMb } from "@opscrew/iac-templates";
import {
  APP_SERVER,
  type DeployPlan,
  monitoringOf,
  monitoringServerName,
} from "@opscrew/plan-schema";

/** Memory left to the operating system, Docker and the shell on every server. */
export const SYSTEM_RESERVE_MB = 384;

/** Below this share of the server's memory (after the system's) left free, design warns. */
const MIN_HEADROOM = 0.15;

/** A container's (or a group's) memory limit in MB, with its name in messages. */
export interface MemoryLimit {
  name: string;
  memoryMb: number;
}

/**
 * What the memory limits of an app's containers are read from: a plan or design's components (with
 * the plan's add-ons when it has them).
 */
export type AppMemoryInput = {
  app: Pick<DeployPlan["app"], "memoryMb">;
} & Pick<DeployPlan, "processes" | "services"> &
  Partial<Pick<DeployPlan, "observability" | "servers">>;

/**
 * The self-hosted monitoring's containers on the server `server` (`app` or an extra server) of a
 * plan with monitoring on: Grafana Alloy with its Docker proxy on every server of the environment
 * (at `monitoring.memoryMb`, also when Grafana Cloud is on: it is the same Alloy), and Prometheus,
 * Loki, Grafana and the front on the server the stack runs on (never for a shared one, which is
 * another plan's). None without monitoring.
 */
export function monitoringLimits(
  plan: Pick<AppMemoryInput, "observability" | "servers">,
  server: string,
): MemoryLimit[] {
  const monitoring = monitoringOf(plan);
  if (monitoring === undefined) return [];
  const { memoryMb } = monitoring;
  const stack =
    monitoring.where.kind !== "shared" && monitoringServerName(plan) === server
      ? [
          { name: "Prometheus", memoryMb: memoryMb.prometheus },
          { name: "Loki", memoryMb: memoryMb.loki },
          { name: "Grafana", memoryMb: memoryMb.grafana },
          { name: "the monitoring front", memoryMb: memoryMb.front },
        ]
      : [];
  return [{ name: "Grafana Alloy", memoryMb: memoryMb.alloy + memoryMb.proxy }, ...stack];
}

/**
 * Each running container's memory limit in MB with its name, the web process first: each enabled
 * worker times its copies, the cron container when a cron job is enabled (its limit from
 * `cronMemoryMb`), each enabled service, then each enabled add-on with all its containers (Beszel:
 * its hub in hub mode, its agent and its Docker proxy; Grafana Alloy: Alloy and its Docker proxy,
 * once, at monitoring's limits when monitoring is on), and with monitoring on the app's server the
 * stack ({@link monitoringLimits}).
 */
export function appMemoryLimits(plan: AppMemoryInput): MemoryLimit[] {
  const cron = cronMemoryMb(plan);
  const beszel = plan.observability?.beszel;
  const grafana = plan.observability?.grafanaCloud;
  const monitoring = monitoringLimits(plan, APP_SERVER);
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
    ...(grafana?.enabled && monitoring.length === 0
      ? [{ name: "Grafana Alloy", memoryMb: grafana.memoryMb.alloy + grafana.memoryMb.proxy }]
      : []),
    ...monitoring,
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
