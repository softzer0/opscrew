/**
 * `status`'s line of self-hosted monitoring (feature 020, FR-2021): this environment's servers and
 * whether each still sends, read from the stack read-only.
 */
import { errorText, isUserFacingError } from "@opscrew/core";
import { type DeployPlan, monitoringOf } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import {
  type MonitoringReading,
  type MonitoringStatusServices,
  monitoringStatus,
  monitoringStatusLine,
} from "../monitoring/status";
import { hasDeployment } from "../shared";

/**
 * One line for a monitored environment once provision ran (`monitoringStatusLine`), or why the
 * stack could not be read; nothing without monitoring. Redacted.
 */
export async function monitoringStatusReport(
  deps: PhaseDeps,
  plan: DeployPlan,
  services: MonitoringStatusServices = {},
): Promise<{ lines: string[]; monitoring?: MonitoringReading }> {
  if (monitoringOf(plan) === undefined || !hasDeployment(plan)) return { lines: [] };
  try {
    const monitoring = await monitoringStatus(deps, plan, services);
    return { lines: [deps.redactor.redact(monitoringStatusLine(monitoring, plan))], monitoring };
  } catch (error) {
    if (!isUserFacingError(error)) throw error;
    const note = `Monitoring: OpsCrew could not read the monitoring stack. ${errorText(error)}`;
    return { lines: [deps.redactor.redact(note)] };
  }
}
