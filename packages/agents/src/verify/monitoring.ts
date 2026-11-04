/**
 * `verify`'s checks of self-hosted monitoring (feature 020, US6): the stack's containers run and
 * are healthy, and every server of this environment sent figures in the last 5 minutes. Read-only.
 */
import type { CheckResult } from "@opscrew/contracts";
import { errorText, isUserFacingError, listText } from "@opscrew/core";
import { type DeployPlan, monitoringOf } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import {
  type MonitoringReading,
  type MonitoringStatusServices,
  monitoringStatus,
  silentText,
} from "../monitoring/status";
import { checkResult } from "../shared";

const STACK = { id: "monitoring-stack", title: "The monitoring stack runs" };
const DATA = { id: "monitoring-data", title: "Every server's figures reach the monitoring stack" };

/** The stack's four services, by the name Compose gives their container. */
const SERVICES = ["prometheus", "loki", "grafana", "front"];

/** The stack's containers: all four running, none unhealthy. */
function stackCheck(reading: MonitoringReading, flag: string): CheckResult {
  const where = `on server ${reading.stack.server}`;
  const missing = SERVICES.filter(
    (service) => !reading.containers.some((c) => c.name.includes(`-${service}-`) && c.running),
  );
  const unhealthy = reading.containers.filter((c) => c.healthy === false).map((c) => c.name);
  if (missing.length === 0 && unhealthy.length === 0) {
    return checkResult(
      STACK.id,
      STACK.title,
      "high",
      "pass",
      `Prometheus, Loki, Grafana and the front run ${where}.`,
    );
  }
  const problems = [
    ...(missing.length === 0
      ? []
      : [`${listText(missing)} ${missing.length === 1 ? "is" : "are"} not running`]),
    ...(unhealthy.length === 0
      ? []
      : [`${listText(unhealthy)} ${unhealthy.length === 1 ? "is" : "are"} unhealthy`]),
  ];
  return checkResult(
    STACK.id,
    STACK.title,
    "high",
    "fail",
    `The monitoring stack ${where}: ${problems.join("; ")}.`,
    {
      remediation: `Run \`opscrew provision${flag}\`: it shows the stack's host plan and starts it again. \`opscrew addon status${flag}\` shows each container.`,
    },
  );
}

/** This environment's servers: each sent figures in the last 5 minutes. */
function dataCheck(reading: MonitoringReading, plan: DeployPlan, flag: string): CheckResult {
  const env = plan.environment?.name ?? "prod";
  const mine = reading.servers.filter((s) => s.app === plan.app.name && s.env === env);
  if (reading.unanswered.includes("figures")) {
    return checkResult(
      DATA.id,
      DATA.title,
      "high",
      "fail",
      "Prometheus did not answer, so the servers' figures could not be checked.",
      {
        remediation: `Run \`opscrew provision${flag}\` to start the stack again, then \`opscrew verify${flag}\`.`,
      },
    );
  }
  const silent = mine.filter((s) => s.silent);
  if (silent.length === 0) {
    return checkResult(
      DATA.id,
      DATA.title,
      "high",
      "pass",
      `${listText(mine.map((s) => `server ${s.server}`))} sent figures in the last 5 minutes.`,
    );
  }
  return checkResult(
    DATA.id,
    DATA.title,
    "high",
    "fail",
    silent.map((s) => `Server ${s.server}: ${silentText(s, reading.stack)}`).join(" "),
    {
      remediation: `Run \`opscrew provision${flag}\`: it shows the agents' and the network's host plans and sets them up again. Then run \`opscrew verify${flag}\` again.`,
    },
  );
}

/**
 * The monitoring checks of a plan with monitoring on (none without): the stack's containers, read
 * from its server (a sender's: the owner's), and this environment's servers' last figures. A stack
 * that could not be read fails the stack's check, with the reason.
 */
export async function monitoringChecks(
  deps: PhaseDeps,
  plan: DeployPlan,
  options: MonitoringStatusServices & { flag: string },
): Promise<CheckResult[]> {
  if (monitoringOf(plan) === undefined) return [];
  const { flag, ...services } = options;
  let reading: MonitoringReading;
  try {
    reading = await monitoringStatus(deps, plan, services);
  } catch (error) {
    if (!isUserFacingError(error)) throw error;
    return [
      checkResult(
        STACK.id,
        STACK.title,
        "high",
        "fail",
        `OpsCrew could not read the monitoring stack. ${errorText(error)}`,
        {
          remediation: `Check that the stack's server is on and reachable over SSH, then run \`opscrew verify${flag}\` again.`,
        },
      ),
    ];
  }
  return [stackCheck(reading, flag), dataCheck(reading, plan, flag)];
}
