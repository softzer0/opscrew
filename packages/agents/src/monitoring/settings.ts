/**
 * Self-hosted monitoring's settings in the plan: the pinned versions, where it may run, and the
 * plan with its settings checked by the plan's schema.
 */
import { OpsCrewError } from "@opscrew/core";
import { IMAGES } from "@opscrew/iac-templates";
import {
  type DeployPlan,
  DeployPlanSchema,
  type MonitoringSettings,
  onOneServer,
} from "@opscrew/plan-schema";
import { ALLOY_VERSION, pinnedVersion } from "../addons/settings";

/** The stack's and Alloy's versions OpsCrew pins. */
export const MONITORING_VERSIONS: MonitoringSettings["versions"] = {
  prometheus: pinnedVersion(IMAGES.prometheus.ref),
  loki: pinnedVersion(IMAGES.loki.ref),
  grafana: pinnedVersion(IMAGES.grafana.ref),
  alloy: ALLOY_VERSION,
};

/** How long figures and logs are kept unless the plan says. */
export const DEFAULT_RETENTION = { metricsDays: 15, logsDays: 7 } as const;

/**
 * Stops unless the app runs on a server OpsCrew deploys to (a cloud server or the user's own),
 * saying why the target has no place for the stack (FR-2007).
 */
export function requireMonitoringTarget(plan: DeployPlan, command: string): void {
  const provider = plan.target.provider;
  if (onOneServer(provider)) return;
  const where =
    provider === "portainer"
      ? "in your Portainer, where OpsCrew does not add containers of its own"
      : provider === "localhost"
        ? "on this computer, which OpsCrew does not keep running for you"
        : "on a host without a server of its own";
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    `Self-hosted monitoring runs on servers OpsCrew deploys to (a cloud server or your own), and this app runs ${where}, so \`${command}\` changes nothing. Nothing was changed.`,
    {
      hint: "`opscrew logs` shows the app's log lines and `opscrew status` its figures on every target.",
    },
  );
}

/**
 * `plan` with `fields` replaced (a field given as `undefined` goes) and the monitoring settings set
 * (or removed with `undefined`; an `observability` left empty goes too), checked by the plan's
 * schema.
 * @throws OpsCrewError `INVALID_INPUT` naming the field the schema refuses; nothing changed.
 */
export function withMonitoring(
  plan: DeployPlan,
  monitoring: MonitoringSettings | undefined,
  fields: Partial<Pick<DeployPlan, "servers" | "network" | "cost">> = {},
): DeployPlan {
  const { monitoring: _old, ...others } = plan.observability ?? {};
  const observability = monitoring === undefined ? others : { ...others, monitoring };
  const merged: Record<string, unknown> = { ...plan, ...fields };
  for (const [field, value] of Object.entries(fields)) {
    if (value === undefined) delete merged[field];
  }
  const { observability: _previous, ...rest } = merged;
  const parsed = DeployPlanSchema.safeParse(
    Object.keys(observability).length === 0 ? rest : { ...rest, observability },
  );
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  throw new OpsCrewError(
    "INVALID_INPUT",
    `OpsCrew cannot write these monitoring settings into the plan: ${issue?.path.join(".") || "plan"} ${issue?.message ?? "is not valid"}. Nothing was changed.`,
    { hint: "Correct the field named above in opscrew/plan.yaml, then run the command again." },
  );
}
