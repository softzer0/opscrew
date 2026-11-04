/**
 * The monitoring stack's state on its server: containers, each server's last data, disk and
 * retention. A stub until the status task fills it.
 */
import type { DeployPlan, MonitoringSettings } from "@opscrew/plan-schema";
import type { AddonContainer } from "../addons";
import type { PhaseDeps } from "../context";

/** What the monitoring stack reports. Never a secret or a public address. */
export interface MonitoringReading {
  containers: AddonContainer[];
  /** Each monitored server, by its labels. */
  servers: {
    app: string;
    env: string;
    server: string;
    /** When its last figures arrived (ISO 8601). */
    lastFigures?: string;
    /** When its last log line arrived (ISO 8601). */
    lastLog?: string;
    /** Nothing arrived for 5 minutes. */
    silent: boolean;
  }[];
  /** The stack's volumes' sizes. */
  disk: { figuresBytes: number; logsBytes: number };
  retention: MonitoringSettings["retention"];
}

/** Reads the monitoring stack's state on its server. */
export async function monitoringStatus(
  _deps: PhaseDeps,
  _plan: DeployPlan,
): Promise<MonitoringReading> {
  throw new Error("monitoringStatus is not implemented yet.");
}
