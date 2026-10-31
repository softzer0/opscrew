// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are bash and GitHub Actions syntax, not JavaScript templates.
import type { DeployPlan } from "@opscrew/plan-schema";
import { checkEnvironmentKey } from "../check";
import { appFlag, job, promoteCommand, promoted, provisionCommand, run } from "./shared";

/**
 * The repository variable that pauses an environment's deploys: JSON,
 * `{ "<app>/<env>": entry }`, one entry per environment ({@link checkEnvironmentKey}). A move's
 * maintenance window writes `{ reason: "move", since }`, and `opscrew rollback` writes
 * `{ reason: "rollback", since, image, commit, from }`. GitHub reads it when it creates a run.
 */
export const DEPLOY_PAUSED_VARIABLE = "OPSCREW_DEPLOY_PAUSED";

/** True when {@link DEPLOY_PAUSED_VARIABLE} names the plan's environment (an expression). */
export function pausedTest(plan: DeployPlan): string {
  return `contains(vars.${DEPLOY_PAUSED_VARIABLE}, '"${checkEnvironmentKey(plan)}"')`;
}

/** `opscrew rollback` for the plan's app and environment, with `args`, as `provisionCommand`. */
function rollbackCommand(plan: DeployPlan, args: string): string {
  const env = plan.environment?.name;
  return `opscrew rollback${appFlag(plan)}${env === undefined ? "" : ` --env ${env}`} ${args}`;
}

/**
 * The `paused` job, which runs when `condition` holds (the environment is paused and the run is
 * not exempt): on GitHub's machines with no permission, it reads the environment's entry in
 * {@link DEPLOY_PAUSED_VARIABLE} with jq and says in a notice and the run's summary why the
 * deploy job is skipped and how deploys resume, for a rollback's pin or a move's window.
 */
export function pausedJob(plan: DeployPlan, condition: string): string[] {
  const deploys = promoted(plan)
    ? `This run didn't deploy. \\\`${rollbackCommand(plan, "--resume")}\\\` resumes them; then \\\`${promoteCommand(plan)}\\\` deploys.`
    : `This run built \${GITHUB_SHA:0:7} but didn't deploy it. \\\`${rollbackCommand(plan, "--resume --deploy")}\\\` deploys the branch's latest commit.`;
  return job({
    id: "paused",
    name: "Report the deploy pause",
    if: condition,
    permissions: [],
    steps: [
      "- name: Say why this run does not deploy",
      "  env:",
      `    KEY: ${JSON.stringify(checkEnvironmentKey(plan))}`,
      `    PAUSED: \${{ vars.${DEPLOY_PAUSED_VARIABLE} }}`,
      ...run([
        "set -euo pipefail",
        'field() { jq -r --arg key "$KEY" --arg field "$1" \'.[$key][$field] // empty\' <<< "$PAUSED"; }',
        'since="$(field since)"',
        'if [[ "$(field reason)" == rollback ]]; then',
        '  commit="$(field commit)"',
        '  image="$(field image)"',
        // A digest is shortened; a site's version (a Worker version id, a Pages run id) is not.
        '  if [[ "$image" == sha256:* ]]; then image="${image:0:19}"; fi',
        `  text="Deploys of $KEY are paused since $since: \\\`opscrew rollback\\\` pinned it to \${commit:0:7} (\${image}). ${deploys}"`,
        "else",
        `  text="Deploys of $KEY are paused since $since while a service moves between the app's servers; \\\`${provisionCommand(plan)}\\\` resumes them."`,
        "fi",
        'echo "::notice::$text"',
        'echo "$text" >> "$GITHUB_STEP_SUMMARY"',
      ]),
    ],
  });
}
