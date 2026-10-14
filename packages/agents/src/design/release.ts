import { imageReleaseCommand } from "@opscrew/iac-templates";
import type { DeployPlan, ProjectFacts } from "@opscrew/plan-schema";

/** The database-migrations note and whether it needs the user's attention. */
export interface ReleaseCommandNote {
  text: string;
  /** True when OpsCrew found migrations that deploys will not run. */
  warning: boolean;
}

/**
 * The plain-English note on database migrations (FR-813) for `design` and the adapt pull request:
 * which command every deploy runs before the new version takes traffic, what a failure does, and
 * that `app.releaseCommand` in `opscrew/plan.yaml` changes or removes it. Without a command in the
 * plan: why a detected command was left out (a warning), else a hint when the plan has a database.
 * `undefined` when there is nothing to say.
 */
export function releaseCommandNote(
  plan: Pick<DeployPlan, "app" | "services">,
  facts?: ProjectFacts,
): ReleaseCommandNote | undefined {
  const command = plan.app.releaseCommand;
  if (command !== undefined) {
    return {
      warning: false,
      text: `Every deploy runs \`${command}\` (database migrations) in a one-off container of the new version before it takes traffic. If the command fails, the deploy stops and the previous version keeps serving. To run another command, or none, change or remove \`app.releaseCommand\` in opscrew/plan.yaml (running \`opscrew design\` again sets the detected command back).`,
    };
  }
  const notRun = facts === undefined ? undefined : imageReleaseCommand(facts).notRun;
  if (notRun !== undefined) return { warning: true, text: notRun };
  if (!plan.services.postgres) return undefined;
  return {
    warning: false,
    text: "OpsCrew found no database migration command for this app, so deploys run none. If the app creates or updates its tables with a command, set it as `app.releaseCommand` in opscrew/plan.yaml: every deploy then runs it before the new version takes traffic.",
  };
}
