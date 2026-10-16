import type { LookupFunction } from "node:net";
import { CloudflareClient } from "@opscrew/connector-cloudflare";
import {
  GitClient,
  GitHubClient,
  parseGitHubRepo,
  resolveGitHubToken,
} from "@opscrew/connector-github";
import type { CheckResult, FetchLike } from "@opscrew/contracts";
import { isUserFacingError, OpsCrewError, toPosixRelative } from "@opscrew/core";
import { renderRunbook, tunnelMode } from "@opscrew/iac-templates";
import { type DeployPlan, readArtifact, writeArtifact } from "@opscrew/plan-schema";
import { defaultTcpConnect, type TcpConnect } from "@opscrew/secops";
import type { PhaseDeps } from "../context";
import { readOwnServerRecord } from "../provision";
import { committedTfvars, ownRenderFromTfvars } from "../provision/render";
import { withoutOwnServer } from "../secure/own";
import {
  committableUrl,
  hasDeployment,
  hidesServerAddress,
  lookupPublicAddresses,
  readIfExists,
  type ServerAddress,
  serverAddress,
  writeRenderedFiles,
} from "../shared";
import {
  type CloudflareRanges,
  type DeployRunInfo,
  editCheckText,
  runVerifyChecks,
  siteUrl,
  summarizeChecks,
} from "./checks";
import {
  type DnsResolver,
  defaultDnsResolver,
  defaultTlsConnect,
  type FetchWithLookup,
  nodeFetchWithLookup,
  type TlsConnect,
} from "./net";
import {
  hideRecordedPortainerAddress,
  hideRoute,
  portainerVerifyUrl,
  renderPortainerRunbook,
  withoutRoute,
} from "./portainer";

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
  /** Whether this computer can reach IPv6 addresses (default: it has a global IPv6 address). */
  ipv6Route?: () => Promise<boolean>;
  /** Cloudflare edge ranges (default: read from Cloudflare's public `/ips` endpoint when proxied). */
  cloudflareRanges?: CloudflareRanges;
  /** Request timeout in milliseconds (default 10 s). */
  timeoutMs?: number;
  /**
   * The user's Portainer in web mode `proxy` only (refused otherwise): the address their reverse
   * proxy serves the app on, checked instead of the domain (needed when the plan has none). Never
   * committed: `deployment.url` is only ever `https://<domain>`.
   */
  url?: string;
  /**
   * The user's Portainer only: builds the fetch for a host this computer still holds an older
   * "no such name" answer for, connecting through the public resolver's addresses (default
   * `node:http`/`node:https` with a custom lookup; the host name stays for SNI and certificates).
   */
  fetchWithLookup?: FetchWithLookup;
  /** This computer's own host name lookup, asked first for such a host (default `dns.lookup`). */
  lookup?: LookupFunction;
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
  reporter.step("Verifying the deployment");

  const plan = await readArtifact("plan", paths.files.plan);
  const portainer = plan.target.provider === "portainer";
  const ownProxy = plan.target.provider === "portainer" && plan.target.web.mode === "proxy";
  if (!ownProxy && options.url !== undefined) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      portainer
        ? "An address to check is only for an app in your Portainer behind your own reverse proxy; this app is served through its domain, which OpsCrew checks. Nothing was checked."
        : "An address to check is only for an app in your Portainer behind your own reverse proxy; OpsCrew checks this deployment through its domain or its server. Nothing was checked.",
      { hint: "Run `opscrew verify` without it." },
    );
  }
  // The user's Portainer: no server address (OpsCrew never knows the host's), and its own address
  // is never printed, not even inside the route the user gave.
  if (portainer) await hideRecordedPortainerAddress(deps);
  // Through a Cloudflare Tunnel only the domain is checked: the server has no address to probe.
  const server = tunnelMode(plan) || portainer ? undefined : await serverAddress(deps, plan);
  // A server the user owns: terminal lines say "your server", never its addresses or login host.
  const hidden = plan.target.provider === "own" ? await ownServerNames(deps, server) : [];
  const url = portainer ? portainerVerifyUrl(plan, options.url) : siteUrl(plan, server);
  // The user's own route (`--url`): registered before any check, so no output or result shows
  // it; messages call it "your route".
  const route =
    portainer && options.url !== undefined && url !== undefined
      ? hideRoute(deps.redactor, url, plan.dns.domain)
      : [];
  const say = (text: string) =>
    deps.redactor.redact(withoutRoute(withoutOwnServer(text, hidden), route));
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

  const { checks: checked, lastDeployAt } = await runVerifyChecks({
    plan,
    ...(server !== undefined ? { server } : {}),
    resolver: options.resolver ?? defaultDnsResolver,
    fetch,
    tlsConnect: options.tlsConnect ?? defaultTlsConnect,
    tcpConnect: options.tcpConnect ?? defaultTcpConnect,
    ...(options.ipv6Route !== undefined ? { ipv6Route: options.ipv6Route } : {}),
    now: deps.clock.now(),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(portainer && url !== undefined ? { url } : {}),
    // The user's Portainer: a host this computer cannot find yet is looked up publicly (read-only
    // DNS over HTTPS), and the checks reach the site through that answer. Its addresses are
    // registered with the redactor, so no output or result names them.
    ...(portainer
      ? {
          publicDns: async (host: string) => {
            const answer = await lookupPublicAddresses(fetch, host);
            if (answer.state === "found") {
              for (const address of [...(answer.ipv4 ?? []), ...(answer.ipv6 ?? [])]) {
                deps.redactor.addName(address, "public-address");
              }
            }
            return answer;
          },
          fetchWithLookup: options.fetchWithLookup ?? nodeFetchWithLookup,
          ...(options.lookup !== undefined ? { lookup: options.lookup } : {}),
        }
      : {}),
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

  // The route reads as "your route"; addresses a public resolver gave (and other registered
  // names) are masked.
  const checks = checked.map((check) =>
    editCheckText(check, (text) => deps.redactor.redact(withoutRoute(text, route))),
  );
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
    // Only a domain URL is committed; without a domain the URL is the server's IP address (or, in
    // the user's Portainer, their own route, which is never committed).
    const { url: _url, ...deployment } = plan.deployment;
    const committed = portainer
      ? plan.dns.domain !== undefined
        ? `https://${plan.dns.domain}`
        : undefined
      : committableUrl(url);
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
  // A server the user owns never has its address committed, in any mode (FR-902).
  const shown =
    server !== undefined && current.target.provider !== "own" && !hidesServerAddress(current)
      ? server
      : undefined;
  // A server the user owns: the SSH port provision used. Public mode logs in on the recorded
  // login port, which differs from sshd's when a router forwards it (2222 to 22); tunnel mode
  // uses sshd's own port, as the last provision committed it (`ssh_port`, written only there).
  const sshPort = current.target.provider === "own" ? await ownSshPort(deps, current) : undefined;
  const repo = github.repo ?? { owner: "<owner>", repo: "<repo>" };
  const runbook = portainer
    ? renderPortainerRunbook(current, { opscrewVersion: deps.version, github: repo })
    : renderRunbook(current, {
        opscrewVersion: deps.version,
        github: repo,
        deploySshPublicKey: (await readIfExists(paths.files.deployKeyPub))?.trim() ?? "",
        projectId: paths.projectId,
        ...(shown !== undefined ? { serverIpv4: shown.ipv4 } : {}),
        ...(shown?.ipv6 !== undefined ? { serverIpv6: shown.ipv6 } : {}),
        ...(sshPort !== undefined ? { sshPort } : {}),
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

/** The SSH port the runbook names for a server the user owns (never its address, FR-902). */
async function ownSshPort(deps: PhaseDeps, plan: DeployPlan): Promise<number | undefined> {
  const committed = async () =>
    ownRenderFromTfvars(await committedTfvars(deps.paths.root, plan)).sshPort;
  if (tunnelMode(plan)) return committed();
  const connection = await readOwnServerRecord(deps.paths).catch(() => undefined);
  return connection?.port ?? (await committed());
}

/** The addresses and login host name of a server the user owns, from OpsCrew's local state. */
async function ownServerNames(
  deps: PhaseDeps,
  server: ServerAddress | undefined,
): Promise<string[]> {
  const connection = await readOwnServerRecord(deps.paths).catch(() => undefined);
  return [
    server?.ipv4,
    server?.ipv6,
    connection?.host,
    connection?.publicIpv4,
    connection?.publicIpv6,
  ].filter((name): name is string => name !== undefined && name !== "");
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
