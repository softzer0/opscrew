/**
 * The app's deploys, paused during a move's maintenance window (feature 018): the repository
 * variable `OPSCREW_DEPLOY_PAUSED` names the app's environment, so the deploy workflow skips its
 * deploy job while the window runs, and the window starts only once no deploy of the app runs.
 */
import { posix } from "node:path";
import { OpsCrewError, realSleep } from "@opscrew/core";
import { checkEnvironmentKey, DEPLOY_PAUSED_VARIABLE } from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import { z } from "zod";
import type { PhaseDeps } from "../context";
import { failureReason } from "../destroy/deletion";
import type { GitHubSetup } from "../provision/credentials";
import type { ProvisionServices } from "../provision/types";
import { pollUntil } from "../shared";

/** `OPSCREW_DEPLOY_PAUSED`: `{ "<app>/<env>": { reason, since } }`, as the check's pauses. */
const PausedSchema = z.record(z.string(), z.looseObject({ reason: z.string(), since: z.string() }));

/** How long the window waits for a running deploy of the app, and how often it looks. */
const WAIT_MS = 30 * 60_000;
const POLL_MS = 10_000;

type Deps = Pick<PhaseDeps, "audit" | "clock" | "reporter">;
type GitHub = Pick<GitHubSetup, "api" | "owner" | "repo">;

/**
 * Adds (`pause`) or removes the app's environment (`checkEnvironmentKey`) in the variable, under
 * the window's approval, which lists it; audited. Other environments' entries stay.
 * @throws OpsCrewError `INVALID_INPUT` when the variable is not OpsCrew's JSON (nothing changes).
 */
async function changeDeployPause(
  deps: Deps,
  github: GitHub,
  plan: DeployPlan,
  pause: boolean,
): Promise<void> {
  const { api, owner, repo } = github;
  const key = checkEnvironmentKey(plan);
  const text = await api.getRepoVariable(owner, repo, DEPLOY_PAUSED_VARIABLE);
  let paused: z.infer<typeof PausedSchema> = {};
  if (text !== undefined) {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    const parsed = PausedSchema.safeParse(json);
    if (!parsed.success) {
      throw new OpsCrewError(
        "INVALID_INPUT",
        `The repository variable ${DEPLOY_PAUSED_VARIABLE} of ${owner}/${repo} is not the JSON OpsCrew writes, so OpsCrew changed nothing.`,
        {
          hint: `Delete the variable in the repository's Settings → Secrets and variables → Actions → Variables (it only pauses OpsCrew's deploys), then run \`opscrew provision\` again.`,
        },
      );
    }
    paused = parsed.data;
  }
  if (pause === (paused[key] !== undefined)) return;
  const { [key]: _old, ...others } = paused;
  const next = pause
    ? { ...others, [key]: { reason: "move", since: deps.clock.now().toISOString() } }
    : others;
  if (Object.keys(next).length === 0) {
    await api.deleteRepoVariable(owner, repo, DEPLOY_PAUSED_VARIABLE);
  } else {
    await api.setRepoVariable(owner, repo, DEPLOY_PAUSED_VARIABLE, JSON.stringify(next));
  }
  await deps.audit.append({
    kind: "provider-call",
    actor: "opscrew",
    action: `${pause ? "pause" : "resume"} the deploys of ${key}`,
    phase: "provision",
    target: `${owner}/${repo}`,
    decision: "approved",
  });
}

/**
 * Waits until no run of the app's deploy workflow is queued or in progress, looking first one
 * poll interval after the pause was set.
 * @throws OpsCrewError `COMMAND_FAILED` when one still runs after 30 minutes.
 */
async function waitForDeploys(
  deps: Deps,
  github: GitHub,
  plan: DeployPlan,
  services: Pick<ProvisionServices, "sleep" | "now">,
): Promise<void> {
  const workflowFile = posix.basename(plan.cicd.workflowPath);
  // A run that started just before the pause may not be listed yet.
  await (services.sleep ?? realSleep)(POLL_MS);
  let said = false;
  const idle = await pollUntil(
    async () => {
      const runs = await github.api.listWorkflowRuns(github.owner, github.repo, {
        workflowFile,
        perPage: 20,
      });
      if (runs.every((run) => run.status === "completed")) return true;
      if (!said) deps.reporter.step(`Waiting for the running deploy of ${plan.app.name} to end`);
      said = true;
      return undefined;
    },
    {
      timeoutMs: WAIT_MS,
      intervalMs: POLL_MS,
      ...(services.sleep !== undefined ? { sleep: services.sleep } : {}),
      ...(services.now !== undefined ? { now: services.now } : {}),
    },
  );
  if (idle) return;
  throw new OpsCrewError(
    "COMMAND_FAILED",
    `A deploy of ${plan.app.name} (${workflowFile}) still runs after 30 minutes, so the maintenance window did not start. Nothing was changed on the servers.`,
    {
      hint: `Let it end (https://github.com/${github.owner}/${github.repo}/actions), then run \`opscrew provision\` again.`,
    },
  );
}

/**
 * Runs `window` with the app's deploys paused: the variable set, then a wait for the deploys that
 * run, and the variable cleared however `window` ends (a failure to clear it is a warning saying
 * how to clear it by hand).
 */
export async function withDeploysPaused<T>(
  deps: Deps,
  github: GitHub,
  plan: DeployPlan,
  services: Pick<ProvisionServices, "sleep" | "now">,
  window: () => Promise<T>,
): Promise<T> {
  await changeDeployPause(deps, github, plan, true);
  try {
    await waitForDeploys(deps, github, plan, services);
    return await window();
  } finally {
    await resumeDeploys(deps, github, plan);
  }
}

/**
 * Removes the app's environment from `OPSCREW_DEPLOY_PAUSED` when it is there (after a window, or
 * one an earlier run left when it was stopped); a failure is a warning saying how to remove it by
 * hand.
 */
export async function resumeDeploys(deps: Deps, github: GitHub, plan: DeployPlan): Promise<void> {
  await changeDeployPause(deps, github, plan, false).catch((error: unknown) =>
    deps.reporter.warn(
      `OpsCrew could not resume the deploys of ${checkEnvironmentKey(plan)} (${failureReason(error)}). Remove ${checkEnvironmentKey(plan)} from the repository variable ${DEPLOY_PAUSED_VARIABLE} (Settings → Secrets and variables → Actions → Variables), or the deploys stay paused.`,
    ),
  );
}
