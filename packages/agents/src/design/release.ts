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
 * that `app.releaseCommand` in `opscrew/plan.yaml` changes or removes it, followed by detection's
 * note when it skipped a package script (then a warning). Without a command in the
 * plan: why a detected command was left out (a warning: the image lacks the tool, as the Next.js
 * standalone image lacks Drizzle or Prisma, or OpsCrew cannot build an image that runs it yet, as
 * for Rails or Diesel); else detection's note (`facts.build.releaseNote`: the app migrates when it
 * starts, which needs no attention, or the tool is missing, a warning); else a hint when the plan
 * has a database. `undefined` when there is nothing to say.
 */
export function releaseCommandNote(
  plan: Pick<DeployPlan, "app" | "services">,
  facts?: ProjectFacts,
): ReleaseCommandNote | undefined {
  const command = plan.app.releaseCommand;
  const detected = facts?.build.releaseNote;
  if (command !== undefined) {
    const runs = `Every deploy runs \`${command}\` (database migrations) in a one-off container of the new version before it takes traffic. If the command fails, the deploy stops and the previous version keeps serving. To run another command, or none, change or remove \`app.releaseCommand\` in opscrew/plan.yaml (running \`opscrew design\` again sets the detected command back).`;
    // A note next to a command says what OpsCrew chose not to run (a skipped package script).
    return detected === undefined || detected.atStartup
      ? { warning: false, text: runs }
      : { warning: true, text: `${runs} ${detected.text}` };
  }
  const notRun = facts === undefined ? undefined : imageReleaseCommand(facts).notRun;
  if (notRun !== undefined) {
    const extra = detected === undefined || detected.atStartup ? "" : ` ${detected.text}`;
    return { warning: true, text: `${notRun}${extra}` };
  }
  if (detected !== undefined) return { warning: !detected.atStartup, text: detected.text };
  if (!plan.services.postgres) return undefined;
  return {
    warning: false,
    text: "OpsCrew found no database migration command for this app, so deploys run none. If the app creates or updates its tables with a command, set it as `app.releaseCommand` in opscrew/plan.yaml: every deploy then runs it before the new version takes traffic.",
  };
}
