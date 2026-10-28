/**
 * The scheduled check's state in `status` (feature 017, FR-1708): whether GitHub runs its
 * workflow, and the repository's open alerts, read from GitHub when the command runs.
 */
import type { CheckWorkflowState } from "@opscrew/connector-github";
import { errorText, isUserFacingError } from "@opscrew/core";
import { CHECK_LABEL, CHECK_WORKFLOW_FILE } from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import type { GitHubApi } from "../provision/types";
import { gitClient, githubClientFromToken, githubCoordinates } from "../shared";

/** The check's workflow state and the repository's open alerts (issues labelled `opscrew-check`). */
export interface CheckState {
  workflow: CheckWorkflowState;
  alerts: { number: number; title: string; url: string; createdAt: string }[];
}

/** `gh workflow enable` and the Actions page that turn the check on again. */
function enableAgain(actions: string): string {
  return `Turn it on again on the Actions page, ${actions} ("Enable workflow"), or with \`gh workflow enable ${CHECK_WORKFLOW_FILE}\`.`;
}

/** The line of the check's workflow state. */
function stateLine(state: CheckWorkflowState, actions: string): string {
  switch (state) {
    case "active":
      return "  State: on";
    case "disabled_inactivity":
      return `  State: off. GitHub turned it off after 60 days without activity in the repository, so nothing checks the app now. ${enableAgain(actions)} A commit within every 60 days keeps it on.`;
    case "disabled_manually":
      return `  State: off, turned off in GitHub. ${enableAgain(actions)}`;
    case "disabled_fork":
      return "  State: off: GitHub keeps scheduled workflows off in a fork.";
    case "missing":
      return "  State: not set up yet. Merge OpsCrew's deploy-setup pull request: it adds the check.";
  }
}

/**
 * The scheduled check's state and its lines, when `plan` has the check on: the workflow's state
 * (`checkWorkflowState`), with how to turn it on again when GitHub turned it off, and the open
 * alerts with their links (`openIssues`). A line that says why instead when GitHub cannot be read.
 * `github` is the client (`null`: no token; default: the user's token).
 */
export async function checkStateReport(
  deps: PhaseDeps,
  plan: DeployPlan,
  github?: Pick<GitHubApi, "checkWorkflowState" | "openIssues"> | null,
): Promise<{ lines: string[]; check?: CheckState }> {
  if (plan.observability?.check?.enabled !== true) return { lines: [] };
  const head = `Scheduled check (.github/workflows/${CHECK_WORKFLOW_FILE}, read from GitHub now):`;
  try {
    const api = github === undefined ? await githubClientFromToken(deps) : github;
    if (api === null || api === undefined) {
      return {
        lines: [
          head,
          "  OpsCrew could not read it: no GitHub token is available (set GITHUB_TOKEN or run `gh auth login`).",
        ],
      };
    }
    const { owner, repo } = await githubCoordinates(gitClient(deps));
    deps.reporter.step("Reading the scheduled check's state and alerts at GitHub (read-only)");
    const workflow = await api.checkWorkflowState(owner, repo, CHECK_WORKFLOW_FILE);
    const alerts = (await api.openIssues(owner, repo, CHECK_LABEL)).map(
      ({ number, title, url, createdAt }) => ({ number, title, url, createdAt }),
    );
    const actions = `https://github.com/${owner}/${repo}/actions/workflows/${CHECK_WORKFLOW_FILE}`;
    const lines = [
      head,
      stateLine(workflow, actions),
      ...(alerts.length === 0
        ? ["  Open alerts: none"]
        : [
            "  Open alerts:",
            ...alerts.map((alert) => `    #${alert.number} ${alert.title}: ${alert.url}`),
          ]),
    ];
    return {
      lines: lines.map((line) => deps.redactor.redact(line)),
      check: { workflow, alerts },
    };
  } catch (error) {
    if (!isUserFacingError(error)) throw error;
    return {
      lines: [head, deps.redactor.redact(`  OpsCrew could not read it. ${errorText(error)}`)],
    };
  }
}
