/**
 * Self-hosted monitoring in the plan: turning it on and off, its estimate, and the repository's
 * monitoring server. A stub until the monitoring task fills it.
 */
import type { DeployPlan } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";

export * from "./status";

/** A change to the plan's monitoring: only the plan is written. */
export interface MonitoringChange {
  /** The plan with the change. */
  plan: DeployPlan;
  /** What changes, with the price, memory, retention, disk and licences, in plain words. */
  summary: string;
}

/** The stack's size estimate, summed across the environments that send to it. */
export interface MonitoringEstimate {
  /** The figures' series. */
  series: number;
  /** The figures' disk use over their retention, in GB. */
  figuresGb: number;
  /** The logs' disk use over their retention, in GB. */
  logsGb: number;
  /** Prometheus's size cap, in GB. */
  metricsMaxGb: number;
}

/** Turns monitoring on in the plan: on its own server (the default) or the app's (`on: "app"`). */
export async function monitoringEnable(
  _deps: PhaseDeps,
  _plan: DeployPlan,
  _options: { on?: "app" | "server"; newServer?: boolean },
): Promise<MonitoringChange> {
  throw new Error("monitoringEnable is not implemented yet.");
}

/** Turns monitoring off in the plan. */
export async function monitoringDisable(
  _deps: PhaseDeps,
  _plan: DeployPlan,
): Promise<MonitoringChange> {
  throw new Error("monitoringDisable is not implemented yet.");
}

/** The stack's size estimate for the plans that send to it. */
export async function monitoringEstimate(
  _deps: PhaseDeps,
  _plans: readonly DeployPlan[],
): Promise<MonitoringEstimate> {
  throw new Error("monitoringEstimate is not implemented yet.");
}

/** The repository's monitoring server, when one plan holds it: that plan's file and server. */
export async function repositoryMonitoring(
  _deps: PhaseDeps,
): Promise<{ plan: string; server: string } | undefined> {
  throw new Error("repositoryMonitoring is not implemented yet.");
}

/** The plan files of the environments that send to the owner's monitoring server. */
export async function monitoringSenders(
  _deps: PhaseDeps,
  _ownerPlan: DeployPlan,
): Promise<string[]> {
  throw new Error("monitoringSenders is not implemented yet.");
}
