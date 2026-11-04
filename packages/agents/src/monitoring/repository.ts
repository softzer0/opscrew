/**
 * The repository's monitoring server: the plan that holds it, the plans that send to it, and the
 * copies of its settings a sender keeps.
 */
import { join } from "node:path";
import { OpsCrewError } from "@opscrew/core";
import {
  type DeployPlan,
  type MonitoringSettings,
  monitoringOf,
  readOptionalArtifact,
} from "@opscrew/plan-schema";
import { repositoryEnvironments } from "../apps/names";
import type { PhaseDeps } from "../context";
import { commandFlags } from "../environments/choice";
import { planFile } from "../runners/words";

/** Every designed plan of the repository's apps and environments. */
async function repositoryPlans(deps: Pick<PhaseDeps, "paths">): Promise<DeployPlan[]> {
  return (await repositoryEnvironments(deps.paths)).flatMap((entry) =>
    entry.plan === undefined ? [] : [entry.plan],
  );
}

/**
 * The repository's monitoring server, when a plan holds one (`where.kind` "server"): that plan's
 * file and the server's name. The first such plan when there are several.
 */
export async function repositoryMonitoring(
  deps: Pick<PhaseDeps, "paths">,
): Promise<{ plan: string; server: string } | undefined> {
  for (const plan of await repositoryPlans(deps)) {
    const where = monitoringOf(plan)?.where;
    if (where?.kind === "server") return { plan: planFile(plan), server: where.server };
  }
  return undefined;
}

/** The plans of the environments that send to the monitoring server of `ownerPlan`. */
export async function senderPlans(
  deps: Pick<PhaseDeps, "paths">,
  ownerPlan: DeployPlan,
): Promise<DeployPlan[]> {
  const owner = planFile(ownerPlan);
  return (await repositoryPlans(deps)).filter((plan) => {
    const where = monitoringOf(plan)?.where;
    return where?.kind === "shared" && where.owner.plan === owner;
  });
}

/** The plan files of the environments that send to the monitoring server of `ownerPlan`. */
export async function monitoringSenders(
  deps: Pick<PhaseDeps, "paths">,
  ownerPlan: DeployPlan,
): Promise<string[]> {
  return (await senderPlans(deps, ownerPlan)).map(planFile);
}

/**
 * The plan of `plan`'s shared monitoring server, read from the repository.
 * @throws OpsCrewError `PHASE_PRECONDITION` when that plan is gone or no longer runs the server,
 * with what to do; `end` closes the message.
 */
export async function readOwnerPlan(
  deps: Pick<PhaseDeps, "paths">,
  owner: { plan: string; server: string },
  end: string,
): Promise<DeployPlan> {
  const plan = await readOptionalArtifact("plan", join(deps.paths.root, owner.plan));
  const where = plan === undefined ? undefined : monitoringOf(plan)?.where;
  if (plan !== undefined && where?.kind === "server" && where.server === owner.server) return plan;
  const flag = await commandFlags(deps.paths.root, deps.paths.environment, deps.paths.app);
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    `This environment sends to server ${owner.server} of ${owner.plan}, but ${plan === undefined ? "that plan is gone" : "that plan no longer runs it as its monitoring server"}. ${end}`,
    {
      hint: `Run \`opscrew addon disable monitoring${flag}\` and then \`opscrew addon enable monitoring${flag}\`, which uses the repository's monitoring server or plans a new one.`,
    },
  );
}

/**
 * Design's check of a sender (`where.kind` "shared"): its copies of `versions` and `retention`
 * must be its owner's, which the stack runs with.
 * @throws OpsCrewError `INVALID_INPUT` naming the owner's plan and the field that differs, or
 * `PHASE_PRECONDITION` when the owner no longer runs the server; plan.yaml unchanged.
 */
export async function requireOwnerCopies(
  deps: Pick<PhaseDeps, "paths">,
  plan: DeployPlan,
): Promise<void> {
  const monitoring = monitoringOf(plan);
  if (monitoring?.where.kind !== "shared") return;
  const { owner } = monitoring.where;
  const ownerPlan = await readOwnerPlan(deps, owner, "plan.yaml was not changed.");
  const kept = monitoringOf(ownerPlan) as MonitoringSettings;
  const differs = (["versions", "retention"] as const).flatMap((group) =>
    Object.entries(kept[group])
      .filter(([key, value]) => (monitoring[group] as Record<string, unknown>)[key] !== value)
      .map(([key, value]) => `${group}.${key} is ${value} there`),
  );
  if (differs.length === 0) return;
  const flag = await commandFlags(deps.paths.root, deps.paths.environment, deps.paths.app);
  throw new OpsCrewError(
    "INVALID_INPUT",
    `This environment sends to the monitoring server of ${owner.plan}, so its observability.monitoring versions and retention must be that plan's, which the stack runs with, and ${differs.join(", ")}. plan.yaml was not changed.`,
    {
      hint: `Run \`opscrew addon enable monitoring${flag}\` again, which copies them, or copy them from ${owner.plan} by hand, then run \`opscrew design${flag}\` again.`,
    },
  );
}
