import { readFile } from "node:fs/promises";
import { CloudflareClient } from "@opscrew/connector-cloudflare";
import {
  GitClient,
  GitHubClient,
  parseGitHubRepo,
  resolveGitHubToken,
} from "@opscrew/connector-github";
import type { CheckResult, FetchLike } from "@opscrew/contracts";
import { isUserFacingError, OpsCrewError, toPosixRelative } from "@opscrew/core";
import { renderRunbook } from "@opscrew/iac-templates";
import { type DeployPlan, readArtifact, writeArtifact } from "@opscrew/plan-schema";
import { defaultTcpConnect, type TcpConnect } from "@opscrew/secops";
import type { PhaseDeps } from "../context";
import {
  committableUrl,
  hasDeployment,
  hidesServerAddress,
  serverAddress,
  writeRenderedFiles,
} from "../shared";
import { type CloudflareRanges, type DeployRunInfo, runVerifyChecks, siteUrl } from "./checks";
import { type DnsResolver, defaultDnsResolver, defaultTlsConnect, type TlsConnect } from "./net";

/** Network functions for `opscrew verify`; each defaults to a Node built-in adapter. */
export interface RunVerifyOptions {
  /** DNS lookups (default `node:dns/promises`). */
  resolver?: DnsResolver;
  /** HTTP client for the site and the GitHub/Cloudflare APIs (default `deps.fetch`). */
  fetch?: FetchLike;
  /** Certificate reader (default `node:tls`). */
  tlsConnect?: TlsConnect;
  /** TCP probe (default `node:net`). */
  tcpConnect?: TcpConnect;
  /** Cloudflare edge ranges (default: read from Cloudflare's public `/ips` endpoint when proxied). */
  cloudflareRanges?: CloudflareRanges;
  /** Request timeout in milliseconds (default 10 s). */
  timeoutMs?: number;
}

/** Outcome of {@link runVerify}. */
export interface VerifyResult {
  checks: CheckResult[];
  /** True when no check failed (warnings and skips are allowed). */
  passed: boolean;
  /** The site address that was checked. */
  url: string;
  /** Repo-relative path of the runbook that was written. */
  runbookPath: string;
  /** The plan after verification (with `deployment.url`/`lastDeployAt` when passed). */
  plan: DeployPlan;
}

function countBy(checks: readonly CheckResult[], status: CheckResult["status"]): number {
  return checks.filter((check) => check.status === status).length;
}

/** One-line summary, e.g. `9 passed, 1 failed, 1 warning, 0 skipped`. */
export function summarizeChecks(checks: readonly CheckResult[]): string {
  const warn = countBy(checks, "warn");
  return `${countBy(checks, "pass")} passed, ${countBy(checks, "fail")} failed, ${warn} warning${warn === 1 ? "" : "s"}, ${countBy(checks, "skip")} skipped`;
}

/**
 * The verify phase: checks DNS, HTTPS and the certificate, the HTTP→HTTPS redirect, the health
 * endpoint, security headers, that `.env`/`.git` are not served, that the origin cannot be reached
 * around Cloudflare, and the latest deploy run. The server's address comes from OpsCrew's local
 * state (`serverAddress`). Writes `opscrew/RUNBOOK.md` (without the address behind Cloudflare's
 * proxy); when nothing fails, records `deployment.lastDeployAt` and, with a domain,
 * `deployment.url` in `opscrew/plan.yaml`. Marks `verify`.
 */
export async function runVerify(
  deps: PhaseDeps,
  options: RunVerifyOptions = {},
): Promise<VerifyResult> {
  try {
    return await verify(deps, options);
  } catch (error) {
    await deps.state.markPhase(
      "verify",
      "failed",
      isUserFacingError(error) ? deps.redactor.redact(error.message) : undefined,
    );
    throw error;
  }
}

async function verify(deps: PhaseDeps, options: RunVerifyOptions): Promise<VerifyResult> {
  const { paths, reporter } = deps;
  const say = (text: string) => deps.redactor.redact(text);
  reporter.step("Verifying the deployment");

  const plan = await readArtifact("plan", paths.files.plan);
  const server = await serverAddress(deps, plan);
  const url = siteUrl(plan, server);
  if (url === undefined) {
    // Deployed, but not from here (a fresh clone): provisioning here would create a second server.
    throw hasDeployment(plan)
      ? new OpsCrewError(
          "PHASE_PRECONDITION",
          "OpsCrew does not know the server's address on this computer, and without a domain there is nothing else to verify.",
          {
            hint: "Run `opscrew verify` on the computer that provisioned the server (its .opscrew/ folder holds the address).",
          },
        )
      : new OpsCrewError(
          "PHASE_PRECONDITION",
          "OpsCrew does not know the server's address on this computer yet, so there is nothing to verify.",
          {
            hint: "Run `opscrew provision` first (on this computer, it records the address), merge its pull request, then run `opscrew verify`.",
          },
        );
  }
  const fetch = options.fetch ?? deps.fetch;
  const github = await githubContext(deps, fetch);

  const { checks, lastDeployAt } = await runVerifyChecks({
    plan,
    ...(server !== undefined ? { server } : {}),
    resolver: options.resolver ?? defaultDnsResolver,
    fetch,
    tlsConnect: options.tlsConnect ?? defaultTlsConnect,
    tcpConnect: options.tcpConnect ?? defaultTcpConnect,
    now: deps.clock.now(),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(await cloudflareRanges(deps, plan, fetch, options)),
    deployRuns: async () => {
      if (!github.client || !github.repo) return undefined;
      const runs = await github.client.listWorkflowRuns(github.repo.owner, github.repo.repo, {
        workflowFile: plan.cicd.workflowPath,
        branch: plan.cicd.branch,
        perPage: 1,
      });
      return runs.map(
        (run): DeployRunInfo => ({
          status: run.status,
          conclusion: run.conclusion,
          htmlUrl: run.htmlUrl,
          createdAt: run.createdAt,
        }),
      );
    },
  });

  for (const check of checks) {
    const line = say(`${check.title}: ${check.message}`);
    if (check.status === "pass") reporter.success(line);
    else if (check.status === "fail") reporter.error(line);
    else if (check.status === "warn") reporter.warn(line);
    else reporter.info(line);
  }
  const passed = checks.every((check) => check.status !== "fail");

  let current = plan;
  if (passed) {
    const now = deps.clock.now().toISOString();
    // Only a domain URL is committed; without a domain the URL is the server's IP address.
    const { url: _url, ...deployment } = plan.deployment;
    const committed = committableUrl(url);
    current = {
      ...plan,
      updatedAt: now,
      deployment: {
        ...deployment,
        ...(committed !== undefined ? { url: committed } : {}),
        lastCompletedPhase: "verify",
        ...(lastDeployAt !== undefined ? { lastDeployAt } : {}),
      },
    };
    await writeArtifact("plan", paths.files.plan, current);
  }

  // The runbook is committed: it shows the address only when the domain is not behind
  // Cloudflare's proxy (or there is no domain, so the app is served on the address).
  const shown = server !== undefined && !hidesServerAddress(current) ? server : undefined;
  const runbook = renderRunbook(current, {
    opscrewVersion: deps.version,
    github: github.repo ?? { owner: "<owner>", repo: "<repo>" },
    deploySshPublicKey: await readOptional(paths.files.deployKeyPub),
    projectId: paths.projectId,
    ...(shown !== undefined ? { serverIpv4: shown.ipv4 } : {}),
    ...(shown?.ipv6 !== undefined ? { serverIpv6: shown.ipv6 } : {}),
  });
  await writeRenderedFiles(paths.root, [runbook]);
  const runbookPath = toPosixRelative(paths.root, paths.files.runbook);

  const summary = summarizeChecks(checks);
  if (passed) {
    reporter.success(say(`${url} is live and healthy (${summary}). Runbook: ${runbookPath}`));
  } else {
    reporter.error(
      say(`Verification found problems (${summary}). Fix them and run \`opscrew verify\` again.`),
    );
    reporter.info(say(`Runbook: ${runbookPath}`));
  }
  await deps.state.markPhase("verify", passed ? "ok" : "failed", say(summary));
  return { checks, passed, url, runbookPath, plan: current };
}

async function readOptional(file: string): Promise<string> {
  try {
    return (await readFile(file, "utf8")).trim();
  } catch {
    return "";
  }
}

interface GitHubContext {
  client?: GitHubClient;
  repo?: { owner: string; repo: string };
}

/** GitHub repository (from the `origin` remote) and an API client when a token is available. */
async function githubContext(deps: PhaseDeps, fetch: FetchLike): Promise<GitHubContext> {
  const out: GitHubContext = {};
  try {
    const git = new GitClient({
      cwd: deps.paths.root,
      runner: deps.runner,
      env: deps.env,
      redactor: deps.redactor,
    });
    const remote = await git.remoteUrl();
    const repo = remote ? parseGitHubRepo(remote) : undefined;
    if (repo) out.repo = repo;
  } catch {
    // Not a git repository or git is missing: the deploy-run check reports it.
  }
  const token = await resolveGitHubToken(deps.env, deps.runner);
  if (token) {
    deps.redactor.addLiteral(token, "github-token");
    out.client = new GitHubClient({ token, fetch, version: deps.version });
  }
  return out;
}

/** Cloudflare edge ranges for the proxied DNS check; omitted (with a note) when unavailable. */
async function cloudflareRanges(
  deps: PhaseDeps,
  plan: DeployPlan,
  fetch: FetchLike,
  options: RunVerifyOptions,
): Promise<{ cloudflareRanges?: CloudflareRanges }> {
  if (options.cloudflareRanges) return { cloudflareRanges: options.cloudflareRanges };
  if (plan.dns.provider !== "cloudflare" || !plan.dns.proxied) return {};
  try {
    const ranges = await new CloudflareClient({ fetch, version: deps.version }).getIpRanges();
    return { cloudflareRanges: ranges };
  } catch {
    deps.reporter.info(
      "Could not read Cloudflare's IP ranges; the DNS check only makes sure the server's IP is not published.",
    );
    return {};
  }
}
