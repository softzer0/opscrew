import { imageReleaseCommand, serviceSpec } from "@opscrew/iac-templates";
import type { DeployPlan, ProjectFacts } from "@opscrew/plan-schema";
import { planFile } from "../runners/words";

/** The database-migrations note and whether it needs the user's attention. */
export interface ReleaseCommandNote {
  text: string;
  /** True when OpsCrew found migrations that deploys will not run. */
  warning: boolean;
}

/**
 * The plain-English note on database migrations (FR-813) for `design` and the adapt pull request:
 * which command every deploy runs before the new version takes traffic, what a failure does, and
 * that `app.releaseCommand` in the app's plan (`opscrew/plan.yaml`, a further app's
 * `opscrew/apps/<key>/plan.yaml`) changes or removes it, followed by detection's
 * note when it skipped a package script (then a warning). Without a command in the
 * plan: why a detected command was left out (a warning: the image lacks the tool, as the Next.js
 * standalone image lacks a tool OpsCrew does not install, such as KeystoneJS or AdonisJS, or OpsCrew
 * cannot build an image that runs it yet, as for Rails or Diesel); else detection's note (`facts.build.releaseNote`: the app migrates when it
 * starts, which needs no attention, or the tool is missing, a warning); else a hint when the plan
 * has a database. `undefined` when there is nothing to say. `app` is the app's flag for the
 * command it names (`appFlag`); the plan it names is the app's prod's, as imageReleaseCommand's.
 */
export function releaseCommandNote(
  plan: Pick<DeployPlan, "app" | "services">,
  facts?: ProjectFacts,
  app = "",
): ReleaseCommandNote | undefined {
  const command = plan.app.releaseCommand;
  const detected = facts?.build.releaseNote;
  const file = planFile({ app: plan.app });
  if (command !== undefined) {
    const runs = `Every deploy runs \`${command}\` (database migrations) in a one-off container of the new version before it takes traffic. If the command fails, the deploy stops and the previous version keeps serving. To run none, remove \`app.releaseCommand\` in ${file} (running \`opscrew design${app}\` again sets the detected command back). To run another command, change it there: a later design keeps your command.`;
    // A note next to a command says what OpsCrew chose not to run (a skipped package script).
    return detected === undefined || detected.atStartup
      ? { warning: false, text: runs }
      : { warning: true, text: `${runs} ${detected.text}` };
  }
  const notRun = facts === undefined ? undefined : imageReleaseCommand(facts, plan.app.key).notRun;
  if (notRun !== undefined) {
    const extra = detected === undefined || detected.atStartup ? "" : ` ${detected.text}`;
    return { warning: true, text: `${notRun}${extra}` };
  }
  if (detected !== undefined) return { warning: !detected.atStartup, text: detected.text };
  const database = plan.services.find((s) => s.enabled && DATABASES.has(s.kind));
  if (database === undefined) return undefined;
  return {
    warning: false,
    text: `OpsCrew found no database migration command for this app's ${serviceSpec(database.kind).title}, so deploys run none. If the app creates or updates its tables with a command, set it as \`app.releaseCommand\` in ${file}: every deploy then runs it before the new version takes traffic.`,
  };
}

/** The services whose tables an app migrates. */
const DATABASES: ReadonlySet<string> = new Set(["postgres", "mysql", "mariadb", "mongodb"]);
