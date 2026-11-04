/**
 * The self-hosted monitoring stack's files (`opscrew-monitoring`): Prometheus, Loki, Grafana and
 * the front, rendered from the owner's plan. A stub until the stack's task fills it.
 */
import type { DeployPlan, MonitoringSettings } from "@opscrew/plan-schema";

export * from "./dashboards";

/** The stack's directory, under the deploy user's home on its server. */
export const MONITORING_DIR = "opscrew/addons/monitoring";

/** What the stack's files are rendered from. */
export interface MonitoringStackInput {
  /** The owner's settings. */
  settings: MonitoringSettings;
  /** One per network the stack's server is on; empty for kind "app" with no network. */
  networks: {
    /** The monitoring server's address on that network. */
    address: string;
    /** The members that send (private addresses). */
    servers: string[];
    /** The devices' private addresses. */
    devices: string[];
  }[];
  hasDevices: boolean;
  /** The owner's plan, for headers and labels. */
  plan: DeployPlan;
}

/** The stack's files, each with its path under {@link MONITORING_DIR}. */
export function renderMonitoringStack(
  _input: MonitoringStackInput,
): { path: string; content: string }[] {
  throw new Error("renderMonitoringStack is not implemented yet.");
}
