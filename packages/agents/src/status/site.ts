/**
 * What `opscrew status` shows of a site on the server-less targets (feature 016, FR-1608), read
 * from the provider each time and never stored (data-model.md "The running version"): on
 * Cloudflare's hosting the version running and the one before, with when each was deployed, the
 * run each came from and the rollback command, and the custom domains' state; on GitHub Pages the
 * site, its certificate, HTTPS, and the last Pages run and the one before.
 */
import type {
  CloudflareClient,
  WorkerDeployment,
  WorkerVersion,
} from "@opscrew/connector-cloudflare";
import type { GitHubClient } from "@opscrew/connector-github";
import { errorText, isUserFacingError } from "@opscrew/core";
import type { CloudflareWorkersDeployTarget, DeployPlan } from "@opscrew/plan-schema";
import { formatUtc } from "@opscrew/secops";
import { appFlag } from "../apps/choice";
import type { PhaseDeps } from "../context";
import { commandFlags } from "../environments/choice";
import { setupCloudflare } from "../provision/credentials";
import { sharedCloudflareClient } from "../provision/shared-cloudflare";
import type { ProvisionServices } from "../provision/types";
import { gitClient, githubClientFromToken, githubCoordinates } from "../shared";
import { verifyHosts } from "../verify/checks";

/** Options of {@link siteStatusReport}. */
export interface SiteStatusOptions {
  /** Cloudflare's checks and OpsCrew's own Cloudflare client (fakes in tests). */
  services?: Pick<ProvisionServices, "cloudflare" | "sharedCloudflare">;
}

/** The run and build of a version's message, `opscrew <run id> <sha256>`, as the deploy job writes it. */
const BUILT_BY = /^opscrew (\d+) ([0-9a-f]{64})$/;

/**
 * The run id and build SHA-256 OpsCrew's deploy job wrote into a version's message
 * (`opscrew <run id> <sha256>`); `undefined` for a version OpsCrew's workflow did not upload.
 */
export function versionBuild(
  version: Pick<WorkerVersion, "message"> | undefined,
): { runId: number; sha256: string } | undefined {
  const match = BUILT_BY.exec(version?.message?.trim() ?? "");
  return match?.[1] === undefined || match[2] === undefined
    ? undefined
    : { runId: Number(match[1]), sha256: match[2] };
}

/**
 * The version a deployment serves all traffic with (the one with the largest share); `undefined`
 * for a deployment without versions.
 */
function servedVersion(deployment: WorkerDeployment): string | undefined {
  return [...deployment.versions].sort((a, b) => b.percentage - a.percentage)[0]?.id;
}

/**
 * The version running (the latest deployment's) and the one before it: the latest earlier
 * deployment of another version, where a rollback goes.
 */
export function runningVersions(deployments: readonly WorkerDeployment[]): {
  running?: { versionId: string; deployedAt: string };
  before?: { versionId: string; deployedAt: string };
} {
  const [latest, ...earlier] = deployments;
  const running = latest === undefined ? undefined : servedVersion(latest);
  if (latest === undefined || running === undefined) return {};
  const previous = earlier.find((d) => {
    const id = servedVersion(d);
    return id !== undefined && id !== running;
  });
  const beforeId = previous === undefined ? undefined : servedVersion(previous);
  return {
    running: { versionId: running, deployedAt: latest.createdOn },
    ...(previous !== undefined && beforeId !== undefined
      ? { before: { versionId: beforeId, deployedAt: previous.createdOn } }
      : {}),
  };
}

/** A workflow run's page at GitHub; just its id without the repository. */
function runLink(repo: { owner: string; repo: string } | undefined, runId: number): string {
  return repo === undefined
    ? `run ${runId}`
    : `https://github.com/${repo.owner}/${repo.repo}/actions/runs/${runId}`;
}

/** The repository of the `origin` remote; `undefined` without one. */
async function repositoryOf(deps: PhaseDeps): Promise<{ owner: string; repo: string } | undefined> {
  return githubCoordinates(gitClient(deps)).catch(() => undefined);
}

/** `opscrew promote --to <env> --version <id>`, the rollback of the environment to `id`. */
async function rollbackCommand(deps: PhaseDeps, plan: DeployPlan, id: string): Promise<string> {
  const app = await appFlag(deps.paths.root, deps.paths.app);
  return `opscrew promote${app} --to ${plan.environment?.name ?? "prod"} --version ${id}`;
}

/** The lines of a site on Cloudflare's hosting: its versions and custom domains. */
async function cloudflareLines(
  deps: PhaseDeps,
  plan: DeployPlan,
  target: CloudflareWorkersDeployTarget,
  options: SiteStatusOptions,
): Promise<string[]> {
  const services = options.services ?? {};
  const { worker } = target;
  const flag = await commandFlags(deps.paths.root, deps.paths.environment, deps.paths.app);
  const cloudflare = await setupCloudflare(deps, plan, services, { foreignRecords: "report" });
  // The schema gives every plan on Cloudflare's hosting a domain on Cloudflare.
  if (cloudflare === undefined) throw new Error("A Cloudflare hosting plan without a domain.");
  const client: CloudflareClient = sharedCloudflareClient(deps, services);
  const { accountId } = cloudflare;
  deps.reporter.step(
    "Reading the Worker's deployments and custom domains at Cloudflare (read-only)",
  );
  const deployments = await client.listWorkerDeployments(accountId, worker);
  const head = `Cloudflare hosting, the Worker ${worker} (read from Cloudflare now):`;
  if (deployments === undefined) {
    return [
      head,
      `  The Worker is not in the Cloudflare account: run \`opscrew provision${flag}\` to create it again (it shows the plan first).`,
    ];
  }
  const versions = (await client.listWorkerVersions(accountId, worker)) ?? [];
  const domains = await client.listWorkerCustomDomains(accountId, worker);
  const repo = await repositoryOf(deps);
  const { running, before } = runningVersions(deployments);
  const describe = (entry: { versionId: string; deployedAt: string }) => {
    const version = versions.find((v) => v.id === entry.versionId);
    const build = versionBuild(version);
    const from =
      build === undefined
        ? `not uploaded by OpsCrew's deploy workflow (by ${version?.source ?? "an unknown tool"})`
        : `built by ${runLink(repo, build.runId)}`;
    return `version ${entry.versionId}, deployed ${formatUtc(entry.deployedAt)}, ${from}`;
  };
  const lines = [head];
  lines.push(
    running === undefined
      ? "  Running: nothing deployed yet. Merge OpsCrew's deploy-setup pull request: its workflow deploys the site."
      : `  Running: ${describe(running)}`,
  );
  if (running !== undefined) {
    lines.push(
      before === undefined
        ? "  Before it: none, so there is nothing to roll back to yet."
        : `  Before it: ${describe(before)}`,
    );
  }
  if (before !== undefined) {
    lines.push(`  Roll back to it: ${await rollbackCommand(deps, plan, before.versionId)}`);
  }
  const listed = new Set(domains.map((d) => d.hostname.toLowerCase()));
  const states = verifyHosts(plan).map((hostname) =>
    listed.has(hostname.toLowerCase()) ? `${hostname} (set up)` : `${hostname} (missing)`,
  );
  lines.push(`  Custom domains: ${states.join(", ")}`);
  if (states.some((state) => state.endsWith("(missing)"))) {
    lines.push(
      `  A missing custom domain does not answer: run \`opscrew provision${flag}\` to set it up again (it shows the plan first).`,
    );
  }
  return lines;
}

/** The lines of a site on GitHub Pages: the site, its certificate, HTTPS and its last runs. */
async function pagesLines(deps: PhaseDeps, plan: DeployPlan): Promise<string[]> {
  const flag = await commandFlags(deps.paths.root, deps.paths.environment, deps.paths.app);
  const repo = await githubCoordinates(gitClient(deps));
  const head = `GitHub Pages, ${repo.owner}/${repo.repo} (read from GitHub now):`;
  const client: GitHubClient | undefined = await githubClientFromToken(deps);
  if (client === undefined) {
    return [
      head,
      "  OpsCrew could not read the site: no GitHub token is available (set GITHUB_TOKEN or run `gh auth login`).",
    ];
  }
  deps.reporter.step("Reading the GitHub Pages site and its runs (read-only)");
  const site = await client.getPages(repo.owner, repo.repo);
  if (site === undefined) {
    return [
      head,
      `  Site: GitHub Pages is off. Run \`opscrew provision${flag}\` to set it up again (it shows the Pages plan first).`,
    ];
  }
  const health =
    site.cname === undefined ? undefined : await client.pagesHealth(repo.owner, repo.repo);
  const runs = await client.pagesRuns(repo.owner, repo.repo, plan.cicd.workflowPath);
  const lines = [
    head,
    `  Site: ${site.buildType === "workflow" ? "published by OpsCrew's workflow" : "published from a branch, not OpsCrew's workflow"}, at ${site.cname === undefined ? "no custom domain" : `https://${site.cname}`}`,
    `  Certificate: ${
      health?.certificate === "issued"
        ? "issued by GitHub"
        : health?.certificate === "error"
          ? `GitHub cannot issue it: the DNS records do not point at GitHub Pages, or Cloudflare's proxy is on for them. Run \`opscrew drift${flag}\` to see what changed.`
          : `pending: GitHub has not issued it yet, which usually takes up to an hour once the DNS records point at it. Look again with \`opscrew status${flag}\` in an hour.`
    }`,
    `  HTTPS: ${
      site.httpsEnforced
        ? "enforced"
        : `not enforced yet. Once the certificate is issued, run \`opscrew provision${flag}\`: it enforces HTTPS.`
    }`,
  ];
  const [last, previous] = runs;
  const describe = (run: NonNullable<typeof last>) =>
    `${runLink(repo, run.runId)}, started ${formatUtc(run.startedAt)}, commit ${run.headSha.slice(0, 7)}`;
  lines.push(
    last === undefined
      ? "  Last Pages run: none yet. Merge OpsCrew's deploy-setup pull request: its workflow publishes the site."
      : `  Last Pages run: ${describe(last)}`,
  );
  if (last !== undefined) {
    lines.push(
      previous === undefined
        ? "  The one before: none, so there is nothing to roll back to yet."
        : `  The one before: ${describe(previous)}`,
    );
  }
  if (previous !== undefined) {
    lines.push(`  Roll back to it: ${await rollbackCommand(deps, plan, String(previous.runId))}`);
  }
  return lines;
}

/**
 * The status lines of a site on Cloudflare's hosting or GitHub Pages (FR-1608), read-only and
 * redacted; when the provider cannot be read, a line that says why instead.
 */
export async function siteStatusReport(
  deps: PhaseDeps,
  plan: DeployPlan,
  options: SiteStatusOptions = {},
): Promise<{ lines: string[] }> {
  const { target } = plan;
  try {
    const lines =
      target.provider === "cloudflare-workers"
        ? await cloudflareLines(deps, plan, target, options)
        : await pagesLines(deps, plan);
    return { lines: lines.map((line) => deps.redactor.redact(line)) };
  } catch (error) {
    if (!isUserFacingError(error)) throw error;
    const where = target.provider === "cloudflare-workers" ? "Cloudflare" : "GitHub";
    return {
      lines: [
        deps.redactor.redact(`OpsCrew could not read the site at ${where}. ${errorText(error)}`),
      ],
    };
  }
}
