// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are bash and GitHub Actions syntax, not JavaScript templates.
import type { DeployPlan } from "@opscrew/plan-schema";
import { checkEnvironmentKey } from "../check";
import { job, opscrew, promoteCommand, promoted, provisionCommand, run } from "./shared";

/**
 * The repository variable that pauses an environment's deploys: JSON,
 * `{ "<app>/<env>": entry }`, one entry per environment ({@link checkEnvironmentKey}). A move's
 * maintenance window writes `{ reason: "move", since }`, a credential rotation
 * `{ reason: "rotation", since, hash }`, and `opscrew rollback`
 * `{ reason: "rollback", since, image, commit, from }`. GitHub reads it when it creates a run.
 */
export const DEPLOY_PAUSED_VARIABLE = "OPSCREW_DEPLOY_PAUSED";

/** True when {@link DEPLOY_PAUSED_VARIABLE} names the plan's environment (an expression). */
function pausedTest(plan: DeployPlan): string {
  return `contains(vars.${DEPLOY_PAUSED_VARIABLE}, '"${checkEnvironmentKey(plan)}"')`;
}

/**
 * The deploy job's condition (an expression): the environment is not paused ({@link pausedTest}),
 * or the run is `exempt` from the pause (an expression).
 */
export function unpaused(plan: DeployPlan, exempt?: string): string {
  return `${exempt === undefined ? "" : `${exempt} || `}!${pausedTest(plan)}`;
}

/**
 * The `paused` job, which runs when the environment is paused and the run is not `exempt` (an
 * expression; see {@link unpaused}): on GitHub's machines with no permission, it reads the
 * environment's entry in {@link DEPLOY_PAUSED_VARIABLE} with jq and says in a notice and the run's
 * summary why the deploy job is skipped and how deploys resume, for a rollback's pin, a credential
 * rotation's window or a move's.
 */
export function pausedJob(plan: DeployPlan, exempt?: string): string[] {
  const rollback = opscrew(plan, "rollback");
  const deploys = promoted(plan)
    ? `This run didn't deploy. \\\`${rollback} --resume\\\` resumes them; then \\\`${promoteCommand(plan)}\\\` deploys.`
    : `This run built \${GITHUB_SHA:0:7} but didn't deploy it. \\\`${rollback} --resume --deploy\\\` deploys the branch's latest commit.`;
  return job({
    id: "paused",
    name: "Report the deploy pause",
    if: `\${{ ${exempt === undefined ? "" : `!(${exempt}) && `}${pausedTest(plan)} }}`,
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
        'elif [[ "$(field reason)" == rotation ]]; then',
        `  text="Deploys of $KEY are paused since $since for a credential rotation's window: \\\`${opscrew(plan, "rotate")}\\\` with its services, or with \\\`--undo\\\`, ends it."`,
        "else",
        `  text="Deploys of $KEY are paused since $since while a service moves between the app's servers; \\\`${provisionCommand(plan)}\\\` resumes them."`,
        "fi",
        'echo "::notice::$text"',
        'echo "$text" >> "$GITHUB_STEP_SUMMARY"',
      ]),
    ],
  });
}
