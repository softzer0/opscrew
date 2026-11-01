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
import type { GitHubClient, PagesRun } from "@opscrew/connector-github";
import { errorText, isUserFacingError } from "@opscrew/core";
import { PAGES_PUBLISH_JOB } from "@opscrew/iac-templates";
import type { CloudflareWorkersDeployTarget, DeployPlan } from "@opscrew/plan-schema";
import { formatUtc } from "@opscrew/secops";
import type { PhaseDeps } from "../context";
import { commandFlags } from "../environments/choice";
import { setupCloudflare } from "../provision/credentials";
import { sharedCloudflareClient } from "../provision/shared-cloudflare";
import type { ProvisionServices } from "../provision/types";
import type { VersionView } from "../rollback/types";
import { gitClient, githubClientFromToken, githubCoordinates } from "../shared";
import type { DeployPause } from "../shared/deploy-pause";
import { verifyHosts } from "../verify/checks";
import type { DeployState } from "./deploys";

/** Options of {@link siteStatusReport}. */
export interface SiteStatusOptions {
  /** Cloudflare's checks and OpsCrew's own Cloudflare client (fakes in tests). */
  services?: Pick<ProvisionServices, "cloudflare" | "sharedCloudflare">;
  /** The environment's deploy pause, which tells which GitHub Pages run is running. */
  pause?: DeployPause;
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

/**
 * The version a rollback on Cloudflare's hosting goes back to by default (ADR 0023 D4), as on a
 * server: the version served before the one `running` (`before`, {@link runningVersions}) when it
 * was uploaded before it; otherwise, as after a rollback, the newest one uploaded before `running`
 * (Cloudflare lists them newest first), so a rollback of a rollback goes further back and never to
 * the version it went back from.
 */
export function previousWorkerVersion(
  versions: readonly WorkerVersion[],
  running: string | undefined,
  before: string | undefined,
): WorkerVersion | undefined {
  const at = versions.findIndex((version) => version.id === running);
  const now = versions[at];
  if (now === undefined) return undefined;
  const served = versions.find((version) => version.id === before);
  if (served !== undefined && Date.parse(served.createdOn) < Date.parse(now.createdOn)) {
    return served;
  }
  return versions[at + 1];
}

/** The repository, with the GitHub call that tells whether a Pages run published the site. */
export interface PagesRepository {
  api: Pick<GitHubClient, "runAttemptJobs">;
  owner: string;
  repo: string;
}

/** A site's GitHub Pages runs as {@link pagesMarks} marks them. */
export interface PagesMarks {
  /** The run that published the site now. */
  running?: PagesRun;
  /** The run that published the site before it. */
  before?: PagesRun;
  /** The run a rollback re-runs by default (ADR 0023 D4). */
  previous?: PagesRun;
  /** The runs read on the way whose publish job did not run (pushed while deploys were paused). */
  skipped: PagesRun[];
}

/**
 * Of a site's successful GitHub Pages runs (`runs`, the latest started first), the one that
 * published the site now (`running`), the one that published it before (`before`), and the run a
 * rollback re-runs by default (`previous`, ADR 0023 D4). A run also succeeds when its job
 * {@link PAGES_PUBLISH_JOB} was skipped, as a push's is while a rollback pauses deploys. So while
 * a rollback pins a run (`pinned`, its id), that one runs; otherwise the latest started run whose
 * publish job succeeded does. `before` is the next one started after it whose publish job
 * succeeded. `previous` is `before` when it was created before the running run (a re-run keeps its
 * id, so ids give the creation order), as a server's `-previous`; otherwise, as after a rollback,
 * the run with the highest id below the running one's whose publish job succeeded. Each run's
 * jobs are read at most once, newest first, and only as far as needed.
 */
export async function pagesMarks(
  github: PagesRepository,
  runs: readonly PagesRun[],
  pinned: string | undefined,
): Promise<PagesMarks> {
  const published = new Map<PagesRun, boolean>();
  const firstPublished = async (candidates: readonly PagesRun[]) => {
    for (const run of candidates) {
      let answer = published.get(run);
      if (answer === undefined) {
        const jobs = await github.api.runAttemptJobs(
          github.owner,
          github.repo,
          run.runId,
          run.attempt,
        );
        answer = jobs.some((job) => job.name === PAGES_PUBLISH_JOB && job.conclusion === "success");
        published.set(run, answer);
      }
      if (answer) return run;
    }
    return undefined;
  };
  const skippedRuns = () => runs.filter((run) => published.get(run) === false);
  const running =
    pinned === undefined
      ? await firstPublished(runs)
      : runs.find((run) => String(run.runId) === pinned);
  if (running === undefined) return { skipped: skippedRuns() };
  const before = await firstPublished(runs.slice(runs.indexOf(running) + 1));
  const previous =
    before !== undefined && before.runId < running.runId
      ? before
      : await firstPublished(
          runs.filter((run) => run.runId < running.runId).sort((a, b) => b.runId - a.runId),
        );
  return {
    running,
    ...(before !== undefined ? { before } : {}),
    ...(previous !== undefined ? { previous } : {}),
    skipped: skippedRuns(),
  };
}

/**
 * The GitHub Pages run `run` that `opscrew rollback` pinned the site of `environment` to has not
 * succeeded, so it is not listed: why (`why`, starting lower case), and the next step with
 * `command`, the rollback's.
 */
export function pinnedRunFailed(
  run: string,
  environment: string,
  command: string,
): { why: string; next: string } {
  return {
    why: `the run ${run} that \`opscrew rollback\` pinned ${environment}'s site to has not succeeded: it is still running, waits for a reviewer, or failed.`,
    next: `Roll back to another run with \`${command} --to <run id>\` (\`${command} --list\` lists the runs), or run \`${command} --resume\` to deploy forward again.`,
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

/** The lines of a site's section, and its version running and the one before (`deploys`). */
interface SiteSection {
  lines: string[];
  versions: Pick<DeployState, "running" | "previous">;
}

/** The lines of a site on Cloudflare's hosting: its versions and custom domains. */
async function cloudflareLines(
  deps: PhaseDeps,
  plan: DeployPlan,
  target: CloudflareWorkersDeployTarget,
  options: SiteStatusOptions,
): Promise<SiteSection> {
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
    return {
      lines: [
        head,
        `  The Worker is not in the Cloudflare account: run \`opscrew provision${flag}\` to create it again (it shows the plan first).`,
      ],
      versions: {},
    };
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
  const view = (entry: { versionId: string }): VersionView => {
    const createdOn = versions.find((v) => v.id === entry.versionId)?.createdOn;
    return { version: entry.versionId, ...(createdOn !== undefined ? { builtAt: createdOn } : {}) };
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
  const back = previousWorkerVersion(versions, running?.versionId, before?.versionId);
  if (back !== undefined) {
    lines.push(
      back.id === before?.versionId
        ? `  Roll back to it: opscrew rollback${flag} --to ${back.id}`
        : `  Roll back: opscrew rollback${flag} --to ${back.id} (the newest version uploaded before the one running)`,
    );
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
  return {
    lines,
    versions: {
      ...(running !== undefined ? { running: view(running) } : {}),
      ...(before !== undefined ? { previous: view(before) } : {}),
    },
  };
}

/**
 * The lines of a site on GitHub Pages: the site, its certificate, HTTPS, the run running
 * ({@link pagesMarks}, with the environment's `pause`) and the one before.
 */
async function pagesLines(
  deps: PhaseDeps,
  plan: DeployPlan,
  pause: DeployPause | undefined,
): Promise<SiteSection> {
  const flag = await commandFlags(deps.paths.root, deps.paths.environment, deps.paths.app);
  const repo = await githubCoordinates(gitClient(deps));
  const head = `GitHub Pages, ${repo.owner}/${repo.repo} (read from GitHub now):`;
  const client: GitHubClient | undefined = await githubClientFromToken(deps);
  if (client === undefined) {
    return {
      lines: [
        head,
        "  OpsCrew could not read the site: no GitHub token is available (set GITHUB_TOKEN or run `gh auth login`).",
      ],
      versions: {},
    };
  }
  deps.reporter.step("Reading the GitHub Pages site and its runs (read-only)");
  const site = await client.getPages(repo.owner, repo.repo);
  if (site === undefined) {
    return {
      lines: [
        head,
        `  Site: GitHub Pages is off. Run \`opscrew provision${flag}\` to set it up again (it shows the Pages plan first).`,
      ],
      versions: {},
    };
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
  const pin = pause?.reason === "rollback" ? pause : undefined;
  let marks: PagesMarks;
  try {
    marks = await pagesMarks({ api: client, owner: repo.owner, repo: repo.repo }, runs, pin?.image);
  } catch (error) {
    if (!isUserFacingError(error)) throw error;
    lines.push(
      `  Running: OpsCrew could not read which run published the site. ${errorText(error)}`,
    );
    return { lines, versions: {} };
  }
  const last = marks.running;
  const previous = marks.before;
  const describe = (run: PagesRun) =>
    `${runLink(repo, run.runId)}, started ${formatUtc(run.startedAt)}, commit ${run.headSha.slice(0, 7)}`;
  if (last === undefined) {
    // The pinned run's latest attempt did not succeed, so it is not listed.
    const failed =
      pin === undefined
        ? undefined
        : pinnedRunFailed(pin.image, deps.paths.environment, `opscrew rollback${flag}`);
    lines.push(
      failed === undefined
        ? "  Running: nothing yet. Merge OpsCrew's deploy-setup pull request: its workflow publishes the site."
        : `  Running: unknown: ${failed.why} ${failed.next}`,
    );
  } else {
    lines.push(
      `  Running: ${describe(last)}`,
      previous === undefined
        ? "  Before it: none, so there is nothing to roll back to yet."
        : `  Before it: ${describe(previous)}`,
    );
  }
  const target = marks.previous;
  if (target !== undefined) {
    lines.push(
      target === previous
        ? `  Roll back to it: opscrew rollback${flag} --to ${target.runId}`
        : `  Roll back: opscrew rollback${flag} --to ${target.runId} (the newest run created before the one running)`,
    );
  }
  const view = (run: PagesRun): VersionView => ({
    version: String(run.runId),
    commit: run.headSha,
    builtAt: run.startedAt,
  });
  return {
    lines,
    versions: {
      ...(last !== undefined ? { running: view(last) } : {}),
      ...(previous !== undefined ? { previous: view(previous) } : {}),
    },
  };
}

/**
 * The status lines of a site on Cloudflare's hosting or GitHub Pages (FR-1608), read-only and
 * redacted, with the version running and the one before (`deploys`, FR-1913); when the provider
 * cannot be read, a line that says why instead.
 */
export async function siteStatusReport(
  deps: PhaseDeps,
  plan: DeployPlan,
  options: SiteStatusOptions = {},
): Promise<SiteSection> {
  const { target } = plan;
  try {
    const section =
      target.provider === "cloudflare-workers"
        ? await cloudflareLines(deps, plan, target, options)
        : await pagesLines(deps, plan, options.pause);
    return { ...section, lines: section.lines.map((line) => deps.redactor.redact(line)) };
  } catch (error) {
    if (!isUserFacingError(error)) throw error;
    const where = target.provider === "cloudflare-workers" ? "Cloudflare" : "GitHub";
    return {
      lines: [
        deps.redactor.redact(`OpsCrew could not read the site at ${where}. ${errorText(error)}`),
      ],
      versions: {},
    };
  }
}
