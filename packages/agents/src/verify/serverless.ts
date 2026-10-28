/**
 * `opscrew verify` for the server-less targets (feature 016, FR-1608): per hostname its DNS, its
 * certificate, an answer, and on Cloudflare's hosting OpsCrew's security headers (with server
 * rendering, also on an answer of the Worker itself); on GitHub Pages the site's certificate and
 * HTTPS as GitHub reports them. Read-only: it changes nothing at Cloudflare or GitHub; the only file
 * it writes is the runbook.
 */
import { isIPv6 } from "node:net";
import type { GitHubClient, PagesHealth, PagesSite } from "@opscrew/connector-github";
import type { CheckResult, FetchLike } from "@opscrew/contracts";
import { isUserFacingError, toPosixRelative, errorText as userErrorText } from "@opscrew/core";
import { renderSiteRunbook } from "@opscrew/iac-templates";
import {
  type DeployPlan,
  environmentsOf,
  isServerlessProvider,
  type ServerlessProvider,
} from "@opscrew/plan-schema";
import { daysLeft } from "@opscrew/secops";
import type { PhaseDeps } from "../context";
import { checkResult, editCheckText, summarizeChecks, writeRenderedFiles } from "../shared";
import {
  type CloudflareRanges,
  certificateCoversHost,
  errorText,
  MIN_CERT_DAYS,
  rangeList,
  SECURITY_HEADERS,
  verifyHosts,
} from "./checks";
import type { DnsResolver, TlsCertificateInfo, TlsConnect } from "./net";
import type { VerifyResult } from "./run";

/** GitHub Pages' published addresses (its A and AAAA records for an apex domain). */
const GITHUB_PAGES_RANGES: CloudflareRanges = {
  ipv4: ["185.199.108.0/22"],
  ipv6: ["2606:50c0:8000::/46"],
};

/**
 * A path no static file of the site has, so the Worker of a server-rendered site answers it: its
 * answer shows whether the Worker's own responses carry OpsCrew's headers.
 */
export const WORKER_PATH = "/opscrew-worker-check";

/** What the placeholder Worker the infrastructure creates answers until the first deploy. */
const PLACEHOLDER = "Not deployed yet";

/** The repository verify reads GitHub Pages of, and a client when a token is available. */
export interface SiteGitHub {
  client?: GitHubClient;
  repo?: { owner: string; repo: string };
}

/** What {@link verifySite} needs; every network function is injected. */
export interface VerifySiteInput {
  resolver: DnsResolver;
  fetch: FetchLike;
  tlsConnect: TlsConnect;
  /** Cloudflare's edge ranges; without them, Cloudflare's addresses are not checked. */
  cloudflareRanges?: CloudflareRanges;
  timeoutMs?: number;
  /** GitHub Pages only: where its site is read. */
  github: SiteGitHub;
  /** ` --app <key> --env <name>` for the commands the checks name. */
  flag: string;
}

/** GET `url` within the timeout (default 10 s). */
function get(input: Pick<VerifySiteInput, "fetch" | "timeoutMs">, url: string): Promise<Response> {
  return input.fetch(url, {
    method: "GET",
    redirect: "follow",
    signal: AbortSignal.timeout(input.timeoutMs ?? 10_000),
  });
}

/** The site's host on Cloudflare's hosting, or GitHub Pages. */
function cloudflare(plan: DeployPlan): boolean {
  return plan.target.provider === "cloudflare-workers";
}

/** The target in a sentence: "Cloudflare" or "GitHub Pages". */
export function siteHost(provider: ServerlessProvider): string {
  return provider === "cloudflare-workers" ? "Cloudflare" : "GitHub Pages";
}

/** The DNS records of `host` point to Cloudflare (proxied) or GitHub Pages (DNS only). */
async function dnsCheck(
  host: string,
  plan: DeployPlan,
  input: VerifySiteInput,
  where: string,
): Promise<CheckResult> {
  const id = host.startsWith("www.") ? "dns-records-www" : "dns-records";
  const title = `DNS for ${host} points to ${where}`;
  const provision = `\`opscrew provision${input.flag}\``;
  let addresses: string[];
  try {
    const [a, aaaa] = await Promise.all([
      input.resolver.resolve4(host),
      input.resolver.resolve6(host),
    ]);
    addresses = [...a, ...aaaa];
  } catch (error) {
    return checkResult(
      id,
      title,
      "high",
      "fail",
      `Could not look up ${host}: ${errorText(error)}.`,
      {
        remediation:
          "Check that the domain's nameservers point to Cloudflare, then try again in a few minutes.",
        target: host,
      },
    );
  }
  if (addresses.length === 0) {
    return checkResult(id, title, "high", "fail", `${host} has no A or AAAA record.`, {
      remediation: `Run ${provision}: it creates the ${cloudflare(plan) ? "custom domain" : "DNS records"} again (it shows the plan first).`,
      target: host,
    });
  }
  const outside = (ranges: CloudflareRanges) => {
    const list = rangeList(ranges);
    return addresses.filter((address) => !list.check(address, isIPv6(address) ? "ipv6" : "ipv4"));
  };
  const list = addresses.join(", ");
  if (cloudflare(plan)) {
    const elsewhere = input.cloudflareRanges ? outside(input.cloudflareRanges) : [];
    return elsewhere.length > 0
      ? checkResult(
          id,
          title,
          "high",
          "fail",
          `${host} resolves to ${elsewhere.join(", ")}, which is not a Cloudflare address.`,
          {
            remediation: `Run \`opscrew drift${input.flag}\` to see what changed at Cloudflare, then ${provision} to put the custom domain back.`,
            target: host,
          },
        )
      : checkResult(id, title, "high", "pass", `${host} resolves to Cloudflare (${list}).`, {
          target: host,
        });
  }
  const proxied =
    input.cloudflareRanges !== undefined &&
    outside(input.cloudflareRanges).length < addresses.length;
  if (proxied) {
    return checkResult(
      id,
      title,
      "high",
      "fail",
      `${host} resolves to Cloudflare: Cloudflare's proxy is on for it, so GitHub cannot issue or renew the site's certificate.`,
      {
        remediation: `Turn the proxy off (grey cloud) for its record in the Cloudflare dashboard (DNS → Records), or run ${provision}, which puts the record back as DNS only.`,
        target: host,
      },
    );
  }
  const elsewhere = outside(GITHUB_PAGES_RANGES);
  return elsewhere.length > 0
    ? checkResult(
        id,
        title,
        "high",
        "fail",
        `${host} resolves to ${elsewhere.join(", ")}, which is not GitHub Pages' address.`,
        {
          remediation: `Run \`opscrew drift${input.flag}\` to see what changed, then ${provision} to put the DNS records back.`,
          target: host,
        },
      )
    : checkResult(
        id,
        title,
        "high",
        "pass",
        `${host} resolves to GitHub Pages (${list}), DNS only.`,
        {
          target: host,
        },
      );
}

/**
 * The certificate of `host` covers it and is valid for at least {@link MIN_CERT_DAYS} days.
 * `pending`: GitHub has not issued the site's certificate yet, so a failure is a warning that says
 * so.
 */
async function tlsCheck(
  host: string,
  plan: DeployPlan,
  input: VerifySiteInput,
  now: Date,
  pending: string | undefined,
): Promise<CheckResult> {
  const id = "tls-certificate";
  const title = `HTTPS certificate for ${host} is valid`;
  const fix = cloudflare(plan)
    ? `Cloudflare issues the custom domain's certificate: run \`opscrew status${input.flag}\` to see the custom domains' state, and \`opscrew provision${input.flag}\` when one is missing.`
    : `GitHub issues the site's certificate once the DNS records point at it: run \`opscrew drift${input.flag}\` to see what changed, then \`opscrew provision${input.flag}\`.`;
  const failed = (message: string, severity: "high" | "critical" = "high") =>
    pending === undefined
      ? checkResult(id, title, severity, "fail", message, { remediation: fix, target: host })
      : checkResult(id, title, "medium", "warn", `${message} ${pending}`, { target: host });
  let cert: TlsCertificateInfo;
  try {
    cert = await input.tlsConnect(host, { timeoutMs: input.timeoutMs ?? 10_000 });
  } catch (error) {
    return failed(`Could not open an HTTPS connection to ${host}: ${errorText(error)}.`);
  }
  const names =
    cert.subjectAltNames.length > 0 ? cert.subjectAltNames : [cert.subjectCommonName ?? ""];
  if (!certificateCoversHost(host, names)) {
    return failed(
      `The certificate is for ${names.filter(Boolean).join(", ") || "no names"}, not ${host} (issued by ${cert.issuer}).`,
    );
  }
  const until = cert.validTo.slice(0, 10);
  if (Date.parse(cert.validTo) <= now.getTime()) {
    return failed(`The certificate expired on ${until}; browsers refuse the site.`, "critical");
  }
  const days = daysLeft(cert.validTo, now);
  if (days < MIN_CERT_DAYS) {
    return failed(
      `The certificate expires on ${until} (${days} days left) and has not been renewed (issued by ${cert.issuer}).`,
    );
  }
  return checkResult(
    id,
    title,
    "high",
    "pass",
    `Valid for ${host} until ${until} (${days} days left), issued by ${cert.issuer}.`,
    { target: host },
  );
}

/**
 * `https://<host>/` answers below 500 (following redirects: `www` to the domain). The placeholder
 * Worker's answer before the first deploy says so.
 */
async function answerCheck(
  host: string,
  plan: DeployPlan,
  input: VerifySiteInput,
  pending: string | undefined,
): Promise<CheckResult> {
  const id = "site-reachable";
  const title = `The site answers at ${host}`;
  const target = `https://${host}/`;
  const logs = cloudflare(plan)
    ? `the latest deploy run in GitHub → Actions, and the Worker's logs (\`opscrew logs${input.flag}\`)`
    : "the latest Pages run in GitHub → Actions";
  let response: Response;
  try {
    response = await get(input, target);
  } catch (error) {
    const message = `Could not reach ${target}: ${errorText(error)}.`;
    return pending === undefined
      ? checkResult(id, title, "high", "fail", message, { remediation: `Look at ${logs}.`, target })
      : checkResult(id, title, "medium", "warn", `${message} ${pending}`, { target });
  }
  let body = "";
  if (response.status === 503) body = await response.text();
  else await response.body?.cancel();
  if (cloudflare(plan) && body.trim() === PLACEHOLDER) {
    return checkResult(
      id,
      title,
      "high",
      "fail",
      `${target} answers with OpsCrew's placeholder: the deploy workflow has not deployed the site yet.`,
      {
        remediation: `Merge OpsCrew's deploy-setup pull request (or push to ${plan.cicd.branch}), wait for its run in GitHub → Actions, then run \`opscrew verify${input.flag}\` again.`,
        target,
      },
    );
  }
  return response.status >= 500
    ? checkResult(id, title, "high", "fail", `${target} answered with HTTP ${response.status}.`, {
        remediation: `Look at ${logs}.`,
        target,
      })
    : checkResult(id, title, "high", "pass", `${target} answered with HTTP ${response.status}.`, {
        target,
      });
}

/**
 * OpsCrew's security headers on an answer of a site on Cloudflare's hosting (`headers`, from
 * `url`); `worker`: the answer came from the Worker of a server-rendered site.
 */
function siteHeadersCheck(
  url: string,
  headers: Headers | undefined,
  flag: string,
  worker = false,
): CheckResult {
  const id = worker ? "security-headers-worker" : "security-headers";
  const title = worker
    ? "Security headers are set on the Worker's own answers"
    : `Security headers are set at ${new URL(url).host}`;
  if (headers === undefined) {
    return checkResult(id, title, "medium", "skip", "Skipped because the site did not answer.", {
      target: url,
    });
  }
  const missing = SECURITY_HEADERS.filter((header) => {
    const value = headers.get(header.name);
    return value === null || (header.expect !== undefined && !header.expect.test(value));
  }).map((header) => header.name);
  if (missing.length === 0) {
    return checkResult(id, title, "medium", "pass", "All expected security headers are present.", {
      target: url,
    });
  }
  return checkResult(
    id,
    title,
    "medium",
    "fail",
    `Missing or weak headers: ${missing.join(", ")}.`,
    {
      remediation: worker
        ? `OpsCrew's headers wrapper (opscrew/cloudflare/headers-entry.js, the Worker's main) adds them to the Worker's answers: run \`opscrew provision${flag}\` to put it back, merge its pull request and let the deploy run.`
        : `OpsCrew's deploy job adds them to the site's _headers file, where a rule of the site's own that sets or removes one (\`! Name\`) wins: check the site's _headers, then run \`opscrew provision${flag}\`, merge its pull request and let the deploy run.`,
      target: url,
    },
  );
}

/**
 * OpsCrew's security headers on Cloudflare's hosting: on the domain's front page and, for a
 * server-rendered site, on an answer of the Worker itself ({@link WORKER_PATH}).
 */
export async function siteHeaderChecks(
  plan: DeployPlan,
  input: Pick<VerifySiteInput, "fetch" | "timeoutMs" | "flag">,
): Promise<CheckResult[]> {
  const [domain] = verifyHosts(plan);
  if (domain === undefined || plan.target.provider !== "cloudflare-workers") return [];
  const read = async (url: string) => {
    try {
      const response = await get(input, url);
      await response.body?.cancel();
      return response.status >= 500 ? undefined : response.headers;
    } catch {
      return undefined;
    }
  };
  const front = `https://${domain}/`;
  const checks = [siteHeadersCheck(front, await read(front), input.flag)];
  if (plan.target.render === "ssr") {
    const url = `https://${domain}${WORKER_PATH}`;
    checks.push(siteHeadersCheck(url, await read(url), input.flag, true));
  }
  return checks;
}

/**
 * GitHub Pages' site and its custom domain's health, or why they could not be read (in sentences)
 * and what to do.
 */
type PagesState =
  | { unreadable: string; hint: string }
  | { site: PagesSite | undefined; health: PagesHealth | undefined };

async function readPages(github: SiteGitHub, flag: string): Promise<PagesState> {
  const { client, repo } = github;
  const again = `run \`opscrew verify${flag}\` again`;
  if (repo === undefined) {
    return {
      unreadable: "The repository has no GitHub remote named origin.",
      hint: `Add the repository on GitHub as the remote origin, then ${again}.`,
    };
  }
  if (client === undefined) {
    return {
      unreadable: "No GitHub token is available.",
      hint: `Set GITHUB_TOKEN or run \`gh auth login\`, then ${again}.`,
    };
  }
  try {
    const site = await client.getPages(repo.owner, repo.repo);
    const health =
      site?.cname === undefined ? undefined : await client.pagesHealth(repo.owner, repo.repo);
    return { site, health };
  } catch (error) {
    if (!isUserFacingError(error)) throw error;
    // Its message and hint (what to do), then the check again.
    return { unreadable: userErrorText(error), hint: `Then ${again}.` };
  }
}

/** What to say while GitHub has not issued the site's certificate: when to look again. */
function pendingText(domain: string, flag: string): string {
  return `GitHub has not issued the certificate for ${domain} yet; it usually does within an hour of seeing the DNS records. Run \`opscrew verify${flag}\` again in an hour, then \`opscrew provision${flag}\`: it enforces HTTPS once the certificate is there.`;
}

/**
 * GitHub serves the site over HTTPS: Pages is on with the domain, its certificate issued and HTTPS
 * enforced. A pending certificate, or an issued one with HTTPS not enforced yet, is a warning that
 * names `opscrew provision`, which enforces it (verify never does).
 */
function pagesCheck(state: PagesState, domain: string, flag: string): CheckResult {
  const id = "pages-https";
  const title = "GitHub serves the site over HTTPS";
  const provision = `\`opscrew provision${flag}\``;
  if ("unreadable" in state) {
    return checkResult(
      id,
      title,
      "high",
      "warn",
      `OpsCrew could not read the GitHub Pages site. ${state.unreadable}`,
      { remediation: state.hint },
    );
  }
  const { site, health } = state;
  if (site === undefined || site.cname?.toLowerCase() !== domain.toLowerCase()) {
    return checkResult(
      id,
      title,
      "high",
      "fail",
      site === undefined
        ? "GitHub Pages is off for the repository, while the domain's DNS records still point at GitHub."
        : `GitHub Pages serves the custom domain ${site.cname ?? "(none)"}, not ${domain}.`,
      {
        remediation: `Run ${provision}: it sets the site up again with ${domain} (it shows the Pages plan first).`,
      },
    );
  }
  if (health?.certificate === "error") {
    return checkResult(
      id,
      title,
      "high",
      "fail",
      `GitHub cannot issue the certificate for ${domain}: its DNS records do not point at GitHub Pages, or Cloudflare's proxy is on for them.`,
      { remediation: `Run \`opscrew drift${flag}\` to see what changed, then ${provision}.` },
    );
  }
  if (health?.certificate !== "issued") {
    return checkResult(id, title, "medium", "warn", pendingText(domain, flag));
  }
  if (!site.httpsEnforced) {
    return checkResult(
      id,
      title,
      "medium",
      "warn",
      `GitHub has issued the certificate for ${domain}, but HTTPS is not enforced yet: visitors who type http:// are not sent to https://.`,
      { remediation: `Run ${provision}: it enforces HTTPS (it shows the Pages plan first).` },
    );
  }
  return checkResult(
    id,
    title,
    "high",
    "pass",
    `GitHub has issued the certificate for ${domain} and enforces HTTPS.`,
  );
}

/**
 * Checks a site on Cloudflare's hosting or GitHub Pages (FR-1608): for each hostname its DNS, its
 * certificate and an answer; on Cloudflare OpsCrew's headers ({@link siteHeaderChecks}); on GitHub
 * Pages its certificate and HTTPS ({@link pagesCheck}), and that GitHub sets no headers. While
 * GitHub has not issued the certificate, the hostnames' certificate and answer checks warn instead
 * of failing. Changes nothing anywhere, writes the runbook (`renderSiteRunbook`) beside the plan,
 * and marks `verify`.
 */
export async function verifySite(
  deps: PhaseDeps,
  plan: DeployPlan,
  input: VerifySiteInput,
): Promise<VerifyResult> {
  const { reporter } = deps;
  const { provider } = plan.target;
  if (!isServerlessProvider(provider)) throw new Error("verifySite is for a server-less target.");
  const where = siteHost(provider);
  const hosts = verifyHosts(plan);
  const [domain] = hosts;
  // The schema gives every server-less plan a domain on Cloudflare.
  if (domain === undefined) throw new Error("A server-less plan without a domain.");
  const url = `https://${domain}`;
  const now = deps.clock.now();
  const pages = cloudflare(plan) ? undefined : await readPages(input.github, input.flag);
  const pending =
    pages !== undefined && !("unreadable" in pages) && pages.health?.certificate !== "issued"
      ? pendingText(domain, input.flag)
      : undefined;

  const checked: CheckResult[] = [];
  for (const host of hosts) {
    checked.push(await dnsCheck(host, plan, input, where));
    checked.push(await tlsCheck(host, plan, input, now, pending));
    checked.push(await answerCheck(host, plan, input, pending));
  }
  if (pages === undefined) {
    checked.push(...(await siteHeaderChecks(plan, input)));
  } else {
    checked.push(
      pagesCheck(pages, domain, input.flag),
      checkResult(
        "security-headers",
        "Security headers are set",
        "low",
        "skip",
        "GitHub Pages cannot set security headers; `opscrew secure` says what that means.",
      ),
    );
  }

  const checks = checked.map((check) => editCheckText(check, (t) => deps.redactor.redact(t)));
  for (const check of checks) {
    const line = `${check.title}: ${check.message}`;
    if (check.status === "pass") reporter.success(line);
    else if (check.status === "fail") reporter.error(line);
    else if (check.status === "warn") reporter.warn(line);
    else reporter.info(line);
  }
  const passed = checks.every((check) => check.status !== "fail");
  const summary = summarizeChecks(checks);

  // The environment's own runbook, beside its plan (prod's `opscrew/RUNBOOK.md`).
  const { paths } = deps;
  const owner = input.github.repo?.owner;
  const runbook = renderSiteRunbook(plan, {
    opscrewVersion: deps.version,
    environments: await environmentsOf(paths.root, paths.app),
    ...(owner !== undefined ? { owner } : {}),
  });
  const runbookPath = toPosixRelative(paths.root, paths.files.runbook);
  await writeRenderedFiles(paths.root, [{ ...runbook, path: runbookPath }]);

  if (passed && pending !== undefined) {
    reporter.warn(
      `${url} is set up on GitHub Pages, but GitHub has not issued its certificate yet (${summary}). Run \`opscrew verify${input.flag}\` again later; once it is issued, \`opscrew provision${input.flag}\` enforces HTTPS.`,
    );
    reporter.info(`Runbook: ${runbookPath}`);
  } else if (passed) {
    reporter.success(`${url} is live on ${where} (${summary}). Runbook: ${runbookPath}`);
  } else {
    reporter.error(
      `Verification found problems (${summary}). Fix them and run \`opscrew verify${input.flag}\` again.`,
    );
    reporter.info(`Runbook: ${runbookPath}`);
  }
  await deps.state.markPhase("verify", passed ? "ok" : "failed", summary);
  return { checks, passed, url, runbookPath, plan };
}
