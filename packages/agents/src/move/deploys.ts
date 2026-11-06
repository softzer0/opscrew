/**
 * The app's deploys, paused during a move's maintenance window (feature 018): the repository
 * variable `OPSCREW_DEPLOY_PAUSED` names the app's environment with reason `move`, so the deploy
 * workflow skips its deploy job while the window runs, and the window starts only once no deploy
 * of the app runs.
 */
import { checkEnvironmentKey, DEPLOY_PAUSED_VARIABLE } from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { failureReason } from "../destroy/deletion";
import type { GitHubSetup } from "../provision/credentials";
import type { ProvisionServices } from "../provision/types";
import { clearDeployPause, setDeployPause, waitForDeploys } from "../shared/deploy-pause";

type Deps = Pick<PhaseDeps, "audit" | "clock" | "reporter">;
type GitHub = Pick<GitHubSetup, "api" | "owner" | "repo">;

/**
 * Runs `window` with the app's deploys paused: the variable set, then a wait for the deploys that
 * run, and the variable cleared however `window` ends (a failure to clear it is a warning saying
 * how to clear it by hand). `command` holds the pause (`opscrew retarget` in a move between
 * targets, else `opscrew provision`): a deploy that still runs says to run it again.
 */
export async function withDeploysPaused<T>(
  deps: Deps,
  github: GitHub,
  plan: DeployPlan,
  services: Pick<ProvisionServices, "sleep" | "now">,
  command: string,
  window: () => Promise<T>,
): Promise<T> {
  await setDeployPause(deps, github, plan, {
    reason: "move",
    since: deps.clock.now().toISOString(),
  });
  try {
    await waitForDeploys(deps, github, plan, services, {
      outcome: "the maintenance window did not start. Nothing was changed on the servers.",
      hint: `Let it end (https://github.com/${github.owner}/${github.repo}/actions), then run \`${command}\` again.`,
    });
    return await window();
  } finally {
    await resumeDeploys(deps, github, plan);
  }
}

/**
 * Removes the app's environment's `move` entry from `OPSCREW_DEPLOY_PAUSED` when it is there
 * (after a window, or one an earlier run left when it was stopped), never a rollback's; a failure
 * is a warning saying how to remove it by hand.
 */
export async function resumeDeploys(deps: Deps, github: GitHub, plan: DeployPlan): Promise<void> {
  await clearDeployPause(deps, github, plan, "move").catch((error: unknown) =>
    deps.reporter.warn(
      `OpsCrew could not resume the deploys of ${checkEnvironmentKey(plan)} (${failureReason(error)}). Remove ${checkEnvironmentKey(plan)} from the repository variable ${DEPLOY_PAUSED_VARIABLE} (Settings → Secrets and variables → Actions → Variables), or the deploys stay paused.`,
    ),
  );
}
