/**
 * What every path of `opscrew rollback` shares (plan.md 2.): the environment its deps belong to,
 * read once with the command its hints name, the repository with every call a rollback makes, and
 * the checks of its plan that need no network.
 */
import { OpsCrewError } from "@opscrew/core";
import { type DeployPlan, isServerlessProvider, readArtifact } from "@opscrew/plan-schema";
import { appFlag } from "../apps/choice";
import type { PhaseDeps } from "../context";
import { FINISH_COMMAND, MOVE_COMMAND } from "../move/window";
import { githubRepository, NOTHING_CHANGED, type PromoteRepository } from "../promote/shared";
import { moveInProgress } from "../provision/guard";
import { hasDeployment } from "../shared";
import type { RollbackGitHubApi, RollbackOptions, RollbackServices } from "./index";

/** One run of `opscrew rollback`, on the environment its deps belong to. */
export interface RollbackRun {
  deps: PhaseDeps;
  options: RollbackOptions;
  services: RollbackServices;
  /** The environment's plan, read from `deps.paths`. */
  plan: DeployPlan;
  /** The environment's name. */
  environment: string;
  /** ` [--app <key>] --env <env>`: the app's and the environment's flags of the commands named. */
  flags: string;
  /** `opscrew rollback` with {@link flags}. */
  command: string;
}

/** The repository a rollback runs in, with every call it makes. */
export type RollbackRepository = PromoteRepository<RollbackGitHubApi>;

/** The GitHub repository the environment deploys from, with its default branch. */
export function rollbackRepository(
  deps: PhaseDeps,
  services: RollbackServices,
): Promise<RollbackRepository> {
  return githubRepository(deps, services);
}

/**
 * The run of `options` on the environment `deps` belong to: its plan, and the command the hints
 * name.
 * @throws OpsCrewError `PHASE_PRECONDITION` for a preview environment, `INVALID_INPUT` for
 * `allowOldSecrets` anywhere but Cloudflare's hosting and for a site's `--database snapshot` or
 * `migrations`.
 */
export async function rollbackRun(deps: PhaseDeps, options: RollbackOptions): Promise<RollbackRun> {
  const plan = await readArtifact("plan", deps.paths.files.plan);
  const environment = deps.paths.environment;
  const flags = `${await appFlag(deps.paths.root, deps.paths.app)} --env ${environment}`;
  const command = `opscrew rollback${flags}`;
  if (plan.environment?.previews !== undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `${environment} is a preview environment: each preview runs its pull request's latest push, so there is no version to roll back to. ${NOTHING_CHANGED}`,
      {
        hint: `To run an earlier version in a preview, revert the change in its pull request and push; \`opscrew preview destroy <number>${flags}\` removes a preview.`,
      },
    );
  }
  if (
    options.database !== undefined &&
    options.database !== "keep" &&
    isServerlessProvider(plan.target.provider)
  ) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `${environment} is a site on ${plan.target.provider === "github-pages" ? "GitHub Pages" : "Cloudflare's hosting"}: it has no database OpsCrew snapshots or migrates, so its rollback changes only the site's version. ${NOTHING_CHANGED}`,
      { hint: `Leave --database out, then run \`${command}\` again.` },
    );
  }
  if (options.allowOldSecrets !== undefined && plan.target.provider !== "cloudflare-workers") {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `--allow-old-secrets goes only with a rollback on Cloudflare's hosting: it lets that rollback activate a Worker version older than a change to the secrets it names. ${NOTHING_CHANGED}`,
      { hint: `Leave --allow-old-secrets out, then run \`${command}\` again.` },
    );
  }
  return { deps, options, services: options.services ?? {}, plan, environment, flags, command };
}

/**
 * Stops (`PHASE_PRECONDITION`, nothing changed) unless the environment can roll back now, as its
 * plan shows (FR-1907): it is provisioned (`hasDeployment`), and neither moves to another provider
 * (`retarget`) nor moves a service between the app's servers (`move`).
 */
export function requireRollbackable(run: RollbackRun): void {
  const { plan, environment, flags, command } = run;
  if (!hasDeployment(plan)) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `The ${environment} environment is not provisioned, so there is nothing to roll back. ${NOTHING_CHANGED}`,
      {
        hint: `Run \`opscrew provision${flags}\` first; once a second version has deployed, \`${command}\` can go back to the first.`,
      },
    );
  }
  const retarget = moveInProgress(plan);
  if (retarget !== undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `${retarget.message} OpsCrew rolls back an app only where it stays. ${NOTHING_CHANGED}`,
      { hint: retarget.hint },
    );
  }
  if (plan.move !== undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `${plan.move.service} moves between the app's servers, and the move needs the app's deploys until it is finished. ${NOTHING_CHANGED}`,
      {
        hint: `Finish the move first: \`${MOVE_COMMAND}${flags}\` takes it on, and \`${FINISH_COMMAND}${flags}\` ends it once the app runs on the new copy. Then run \`${command}\` again.`,
      },
    );
  }
}
