import type { DeployPlan, DesignOption } from "@opscrew/plan-schema";

/** FR-1217: what a redeploy in the user's Portainer does. */
export const PORTAINER_RECREATE_NOTE =
  "Portainer recreates the stack on each redeploy, so the app is unreachable for a few seconds while the new version starts.";

/** What design says about a rolling deploy (the plan records no reason for it). */
export const ROLLING_NOTE =
  "New versions start next to the running one and take traffic only once their health check passes, so deploys have no downtime.";

/** Memory below which the server cannot run two copies of the app during a deploy. */
const ROLLING_MIN_MEMORY_GB = 1;

/**
 * How a new version replaces the running one (FR-1215, FR-1217): `recreate` in a Portainer, which
 * recreates the stack, and on a server with less than 1 GiB of memory (the provider's server
 * type, or what inspection read on the user's own server); `rolling` otherwise. The reason is
 * present only for `recreate`.
 */
export function deployStrategyFor(
  option: Pick<DesignOption, "target">,
): Pick<DeployPlan["deploy"], "strategy" | "reason"> {
  const { target } = option;
  if (target.provider === "portainer") {
    return { strategy: "recreate", reason: PORTAINER_RECREATE_NOTE };
  }
  if (target.memoryGb >= ROLLING_MIN_MEMORY_GB) return { strategy: "rolling" };
  const mb = Math.round(target.memoryGb * 1024);
  // The own-server option records a placeholder when inspection could not read the memory.
  const why =
    mb < 100
      ? "OpsCrew could not read how much memory the server has"
      : `the server has ${mb} MB of memory, too little for two copies of the app`;
  return {
    strategy: "recreate",
    reason: `Each deploy stops the old version before the new one starts, because ${why}.`,
  };
}

type PlanDeploy = Pick<DeployPlan, "target" | "deploy">;

/** The server a plan runs on: the provider, and a cloud server's type. */
function serverOf({ target }: PlanDeploy): string {
  return target.provider === "hetzner" || target.provider === "digitalocean"
    ? `${target.provider}/${target.serverType}`
    : target.provider;
}

/**
 * The new plan's deploy settings on a later design: the previous drain time, and the previous
 * strategy when the user changed it, that is when it differs from the fresh one on the same server
 * (the user's own server counts as the same one whatever its memory). A recreate with the reason
 * design wrote is design's own and gives way to the fresh strategy. A Portainer always recreates.
 */
export function keptDeploy(fresh: PlanDeploy, previous: PlanDeploy): DeployPlan["deploy"] {
  const before = previous.deploy;
  const designWrote = before.strategy === "recreate" && before.reason !== undefined;
  const userStrategy =
    fresh.target.provider !== "portainer" &&
    !designWrote &&
    serverOf(fresh) === serverOf(previous) &&
    before.strategy !== fresh.deploy.strategy;
  return userStrategy
    ? { strategy: before.strategy, drainSeconds: before.drainSeconds }
    : { ...fresh.deploy, drainSeconds: before.drainSeconds };
}

/**
 * What design says about the plan's deploy strategy: the user's choice when it differs from what
 * design chose (`designed`), else {@link ROLLING_NOTE} or the reason for recreating.
 */
export function deploySentence(
  deploy: DeployPlan["deploy"],
  designed: Pick<DeployPlan["deploy"], "strategy" | "reason">,
): string {
  if (deploy.strategy !== designed.strategy) {
    return `You chose ${deploy.strategy} in opscrew/plan.yaml (deploy.strategy).`;
  }
  // Design gives every recreate its reason.
  return deploy.strategy === "rolling" ? ROLLING_NOTE : (designed.reason ?? "");
}
