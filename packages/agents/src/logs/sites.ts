/**
 * `logs` on the server-less targets (FR-1701): GitHub Pages, and a static site on Cloudflare's
 * hosting, run none of the site's code, so they log no requests (research R2). `logs` says so in
 * one sentence and shows the last deploy runs instead. A server-rendered app on Cloudflare has its
 * requests' logs, which a later task reads.
 */
import { OpsCrewError } from "@opscrew/core";
import type { DeployPlan } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { gitClient, githubClientFromToken, githubCoordinates } from "../shared";
import type { LogLine } from "./lines";

/** How many of the last deploy runs a site's `logs` shows. */
const DEPLOY_RUNS = 10;

/** The refusal for a server-rendered app on Cloudflare's hosting, until its logs are read. */
export function cloudflareLogsNotYet(worker: string): OpsCrewError {
  return new OpsCrewError(
    "PHASE_PRECONDITION",
    "Reading a server-rendered app's logs on Cloudflare's hosting is not available in OpsCrew yet.",
    {
      hint: `Cloudflare's dashboard shows them: Workers & Pages, the Worker ${worker}, then Logs.`,
    },
  );
}

/** A run's result in words: how it ended, or that it has not. */
function runResult(run: { status: string; conclusion: string | null }): string {
  if (run.status !== "completed") return `Not finished (${run.status.replaceAll("_", " ")})`;
  if (run.conclusion === "success") return "Succeeded";
  if (run.conclusion === "failure") return "Failed";
  return `Ended: ${run.conclusion ?? "no result"}`;
}

/**
 * The sentence that the site's host keeps no request logs, and the last deploy runs of the plan's
 * workflow, oldest first, each with its result and link. Read with the user's GitHub token.
 * @throws OpsCrewError `CREDENTIALS_MISSING` without a GitHub token.
 */
export async function siteDeployRuns(
  deps: PhaseDeps,
  plan: DeployPlan,
): Promise<{ first: string; lines: LogLine[] }> {
  const host = plan.target.provider === "github-pages" ? "GitHub Pages" : "Cloudflare";
  const first = `${host} keeps no request logs for this site: its files are served without running any code.`;
  const repo = await githubCoordinates(gitClient(deps));
  const client = await githubClientFromToken(deps);
  if (client === undefined) {
    throw new OpsCrewError(
      "CREDENTIALS_MISSING",
      `${first} OpsCrew could not read its deploy runs either: no GitHub token is available.`,
      { hint: "Set GITHUB_TOKEN or run `gh auth login`, then try again." },
    );
  }
  deps.reporter.step("Reading the site's deploy runs at GitHub (read-only)");
  const runs = await client.listWorkflowRuns(repo.owner, repo.repo, {
    workflowFile: plan.cicd.workflowPath,
    perPage: DEPLOY_RUNS,
  });
  const lines = runs.reverse().map(
    (run): LogLine => ({
      time: run.createdAt,
      service: "deploy",
      stream: "stdout",
      text: `${runResult(run)}, commit ${run.headSha.slice(0, 7)}: ${run.htmlUrl}`,
    }),
  );
  return { first, lines };
}
