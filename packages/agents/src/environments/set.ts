import { canonicalJson } from "@opscrew/core";
import { type DeployPlan, readArtifact, writeArtifact } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { gitClient } from "../shared/github";
import { requireBranch } from "./branches";
import { type RunnerAnswer, withRunner } from "./runner";
import { withDeploySource } from "./source";

/** What `opscrew env set <name>` changes: any of these. */
export interface EnvironmentSettings {
  /** `main`, or the environment it is promoted from ({@link withDeploySource}). */
  from?: string;
  /**
   * The branch whose pushes build and deploy it (its `cicd.branch`, {@link requireBranch}); a
   * promoted environment keeps it for when it is deployed from main again.
   */
  branch?: string;
  /** Where its deploy job runs, and its build ({@link withRunner}). */
  runner?: RunnerAnswer;
}

/**
 * `opscrew env set <name>`: the settings given for the environment `deps.paths` belong to, each
 * checked (the branch with the project's git, then the source with that branch, then the runner
 * for that source) before the plan is written, once and only when it changes, so a refused
 * setting saves nothing. Its next provision shows and applies the change. Returns the plan.
 */
export async function setEnvironment(
  deps: Pick<PhaseDeps, "paths" | "runner" | "env" | "redactor">,
  settings: EnvironmentSettings,
): Promise<DeployPlan> {
  const { paths } = deps;
  const before = await readArtifact("plan", paths.files.plan);
  let plan = before;
  if (settings.branch !== undefined) {
    const branch = await requireBranch(paths, gitClient(deps), settings.branch);
    plan = { ...plan, cicd: { ...plan.cicd, branch } };
  }
  if (settings.from !== undefined) {
    plan = await withDeploySource(paths.root, paths.environment, plan, settings.from);
  }
  if (settings.runner !== undefined) plan = await withRunner(paths, plan, settings.runner);
  if (canonicalJson(plan) === canonicalJson(before)) return before;
  await writeArtifact("plan", paths.files.plan, plan);
  return plan;
}
