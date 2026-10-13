import { BlockList, isIPv6 } from "node:net";
import type { CheckResult, FetchLike, Severity } from "@opscrew/contracts";
import type { DeployPlan } from "@opscrew/plan-schema";
import type { TcpConnect } from "@opscrew/secops";
import { type ProviderProfile, planProvider, providerProfile } from "../providers";
import { providerConsole, type ServerAddress } from "../shared";
import type { DnsResolver, TlsCertificateInfo, TlsConnect } from "./net";

/** Cloudflare edge ranges (CIDRs) used to confirm proxied DNS records. */
export interface CloudflareRanges {
  ipv4: readonly string[];
  ipv6: readonly string[];
}

/** A finished GitHub Actions run, as far as verify cares. */
export interface DeployRunInfo {
  status: string;
  conclusion: string | null;
  htmlUrl: string;
  createdAt: string;
}

/** Everything the verify checks need; every network function is injected. */
export interface VerifyCheckContext {
  plan: DeployPlan;
  /** The server's address from OpsCrew's local state (`serverAddress`); absent when unknown. */
  server?: ServerAddress;
  resolver: DnsResolver;
  fetch: FetchLike;
  tlsConnect: TlsConnect;
  tcpConnect: TcpConnect;
  now: Date;
  /** Cloudflare edge ranges; when absent, proxied records are only checked not to expose the origin. */
  cloudflareRanges?: CloudflareRanges;
  /**
   * Latest runs of the deploy workflow on the deploy branch, newest first. Return `undefined`
   * (or throw) when they cannot be read, for example without a GitHub token.
   */
  deployRuns: () => Promise<DeployRunInfo[] | undefined>;
  /** Per-request timeout. Default 10 s (3 s for TCP). */
  timeoutMs?: number;
}

/**
 * What to do when the server's address is not on this computer (a fresh clone): it is kept in the
 * `.opscrew/` folder where the server was provisioned, never in the repository.
 */
const UNKNOWN_ADDRESS_REMEDIATION =
  "Run `opscrew verify` where the server was provisioned (its .opscrew/ folder holds the address).";

/** Certificates that expire sooner than this fail the TLS check (Caddy renews 30 days ahead). */
export const MIN_CERT_DAYS = 14;

/** Headers Caddy sets on every response (see the rendered Caddyfile). */
const SECURITY_HEADERS: readonly { name: string; httpsOnly?: boolean; expect?: RegExp }[] = [
  { name: "strict-transport-security", httpsOnly: true, expect: /max-age=\d+/i },
  { name: "x-content-type-options", expect: /nosniff/i },
  { name: "x-frame-options" },
  { name: "referrer-policy" },
];

function result(
  id: string,
  title: string,
  severity: Severity,
  status: CheckResult["status"],
  message: string,
  extra: { remediation?: string; target?: string } = {},
): CheckResult {
  return {
    id,
    title,
    severity,
    status,
    message,
    ...(extra.remediation !== undefined ? { remediation: extra.remediation } : {}),
    ...(extra.target !== undefined ? { target: extra.target } : {}),
  };
}

/** The plan provider's names and links for remediation text. */
function profileOf(plan: DeployPlan): ProviderProfile {
  return providerProfile(planProvider(plan));
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause;
    const detail = cause instanceof Error && cause.message ? ` (${cause.message})` : "";
    return `${error.message}${detail}`;
  }
  return String(error);
}

function day(iso: string): string {
  return iso.slice(0, 10);
}

/** Drops a response body without reading it (lets the connection be reused or closed). */
async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Nothing to clean up.
  }
}

/** The site's public hosts: the domain (and `www.` when configured); empty without a domain. */
export function verifyHosts(plan: DeployPlan): string[] {
  const domain = plan.dns.provider === "cloudflare" ? plan.dns.domain : undefined;
  if (!domain) return [];
  return plan.dns.www ? [domain, `www.${domain}`] : [domain];
}

/**
 * `https://<domain>` with a domain, `http://<server IPv4>` without (`server` from OpsCrew's local
 * state); undefined when neither is known.
 */
export function siteUrl(plan: DeployPlan, server?: ServerAddress): string | undefined {
  const [host] = verifyHosts(plan);
  if (host) return `https://${host}`;
  return server ? `http://${server.ipv4}` : undefined;
}

/** True when web traffic may reach the server only through Cloudflare. */
export function originIsCloudflareOnly(plan: DeployPlan): boolean {
  return (
    plan.dns.provider === "cloudflare" &&
    plan.dns.proxied &&
    plan.security.httpAllowedFrom === "cloudflare"
  );
}

function rangeList(ranges: CloudflareRanges): BlockList {
  const list = new BlockList();
  for (const [cidrs, type] of [
    [ranges.ipv4, "ipv4"],
    [ranges.ipv6, "ipv6"],
  ] as const) {
    for (const cidr of cidrs) {
      const [network, prefix] = cidr.split("/");
      if (network && prefix !== undefined) list.addSubnet(network, Number(prefix), type);
    }
  }
  return list;
}

function sameAddress(a: string, b: string): boolean {
  const type = isIPv6(a) ? "ipv6" : "ipv4";
  if ((isIPv6(b) ? "ipv6" : "ipv4") !== type) return false;
  const list = new BlockList();
  list.addAddress(b, type);
  return list.check(a, type);
}

/** Certificate name matching with single-label wildcards (`*.example.com`). */
export function certificateCoversHost(host: string, names: readonly string[]): boolean {
  const wanted = host.toLowerCase().replace(/\.$/, "");
  return names.some((raw) => {
    const name = raw.toLowerCase().replace(/\.$/, "");
    if (name === wanted) return true;
    if (!name.startsWith("*.")) return false;
    const suffix = name.slice(1);
    return wanted.endsWith(suffix) && !wanted.slice(0, -suffix.length).includes(".");
  });
}

/** DNS A/AAAA records for `host`: Cloudflare edge addresses when proxied, the server otherwise. */
export async function checkDns(host: string, ctx: VerifyCheckContext): Promise<CheckResult> {
  const id = host.startsWith("www.") ? "dns-records-www" : "dns-records";
  const title = `DNS for ${host} points to the right place`;
  const { plan } = ctx;
  const ipv4 = ctx.server?.ipv4;
  const ipv6 = ctx.server?.ipv6;
  let a: string[];
  let aaaa: string[];
  try {
    [a, aaaa] = await Promise.all([ctx.resolver.resolve4(host), ctx.resolver.resolve6(host)]);
  } catch (error) {
    return result(id, title, "high", "fail", `Could not look up ${host}: ${errorText(error)}.`, {
      remediation:
        "Check that the domain's nameservers point to Cloudflare, then try again in a few minutes.",
      target: host,
    });
  }
  if (a.length === 0 && aaaa.length === 0) {
    return result(id, title, "high", "fail", `${host} has no A or AAAA record.`, {
      remediation:
        "Run `opscrew dns` to create the records, and check that the domain's nameservers point to Cloudflare.",
      target: host,
    });
  }
  const addresses = [...a, ...aaaa];
  if (plan.dns.proxied) {
    const exposed = addresses.filter(
      (address) =>
        (ipv4 !== undefined && sameAddress(address, ipv4)) ||
        (ipv6 !== undefined && sameAddress(address, ipv6)),
    );
    if (exposed.length > 0) {
      return result(
        id,
        title,
        "high",
        "fail",
        `${host} resolves to the server itself (${exposed.join(", ")}), so Cloudflare's proxy is bypassed and the server's IP is public.`,
        {
          remediation:
            "Turn the proxy (orange cloud) back on for the record, or run `opscrew dns`.",
          target: host,
        },
      );
    }
    if (ctx.cloudflareRanges) {
      const list = rangeList(ctx.cloudflareRanges);
      const outside = addresses.filter(
        (address) => !list.check(address, isIPv6(address) ? "ipv6" : "ipv4"),
      );
      if (outside.length > 0) {
        return result(
          id,
          title,
          "high",
          "fail",
          `${host} resolves to ${outside.join(", ")}, which is not a Cloudflare address.`,
          {
            remediation:
              "Make sure the domain uses Cloudflare's nameservers and the record is proxied, then run `opscrew dns`.",
            target: host,
          },
        );
      }
    }
    return result(
      id,
      title,
      "high",
      "pass",
      `${host} resolves to Cloudflare (${addresses.join(", ")}); the server's IP stays hidden.`,
      { target: host },
    );
  }
  if (ipv4 === undefined) {
    // A fresh clone: the address lives in the `.opscrew/` folder of the computer that provisioned
    // the server, so the records cannot be compared here (and `opscrew dns` would not help).
    return result(
      id,
      title,
      "high",
      "warn",
      `${host} resolves to ${addresses.join(", ")}, but OpsCrew does not know the server's address on this computer, so it cannot tell whether that is the server.`,
      { remediation: UNKNOWN_ADDRESS_REMEDIATION, target: host },
    );
  }
  const wrong = [
    ...a.filter((address) => !sameAddress(address, ipv4)),
    ...aaaa.filter((address) => ipv6 === undefined || !sameAddress(address, ipv6)),
  ];
  if (wrong.length > 0 || a.length === 0) {
    const expected = [ipv4, ipv6].filter((x): x is string => x !== undefined).join(" / ");
    return result(
      id,
      title,
      "high",
      "fail",
      `${host} resolves to ${addresses.join(", ")} but the server is ${expected}.`,
      {
        remediation:
          "Run `opscrew dns` to point the records at the server (DNS changes can take a few minutes).",
        target: host,
      },
    );
  }
  return result(
    id,
    title,
    "high",
    "pass",
    `${host} resolves to the server (${addresses.join(", ")}).`,
    {
      target: host,
    },
  );
}

/** GET `/` answers with a status below 500. Returns the response headers for the header check. */
export async function checkSiteReachable(
  url: string,
  ctx: VerifyCheckContext,
): Promise<{ check: CheckResult; headers?: Headers }> {
  const title = "The site answers";
  const target = `${url}/`;
  try {
    const response = await ctx.fetch(target, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(ctx.timeoutMs ?? 10_000),
    });
    await discard(response);
    if (response.status >= 500) {
      return {
        check: result(
          "site-reachable",
          title,
          "high",
          "fail",
          `${target} answered with HTTP ${response.status}.`,
          {
            remediation:
              "Look at the app's logs on the server (`docker compose logs --tail 200 app`) and the latest deploy run.",
            target,
          },
        ),
        headers: response.headers,
      };
    }
    return {
      check: result(
        "site-reachable",
        title,
        "high",
        "pass",
        `${target} answered with HTTP ${response.status}.`,
        { target },
      ),
      headers: response.headers,
    };
  } catch (error) {
    return {
      check: result(
        "site-reachable",
        title,
        "high",
        "fail",
        `Could not reach ${target}: ${errorText(error)}.`,
        {
          remediation: `Check that the latest deploy run succeeded and that the ${profileOf(ctx.plan).serverNoun} is running (${providerConsole(profileOf(ctx.plan))}).`,
          target,
        },
      ),
    };
  }
}

/** The certificate covers the host, is valid for at least {@link MIN_CERT_DAYS} days, and names its issuer. */
export async function checkTls(host: string, ctx: VerifyCheckContext): Promise<CheckResult> {
  const id = "tls-certificate";
  const title = `HTTPS certificate for ${host} is valid`;
  let cert: TlsCertificateInfo;
  try {
    cert = await ctx.tlsConnect(host, { port: 443, timeoutMs: ctx.timeoutMs ?? 10_000 });
  } catch (error) {
    return result(
      id,
      title,
      "high",
      "fail",
      `Could not open an HTTPS connection to ${host}: ${errorText(error)}.`,
      {
        remediation:
          "Check that ports 80 and 443 are open and that Caddy is running (`docker compose logs caddy`).",
        target: host,
      },
    );
  }
  const names =
    cert.subjectAltNames.length > 0 ? cert.subjectAltNames : [cert.subjectCommonName ?? ""];
  if (!certificateCoversHost(host, names)) {
    return result(
      id,
      title,
      "high",
      "fail",
      `The certificate is for ${names.filter(Boolean).join(", ") || "no names"}, not ${host} (issued by ${cert.issuer}).`,
      {
        remediation:
          "Check that the domain in opscrew/plan.yaml matches the site address in the Caddyfile and redeploy; Caddy then requests a matching certificate.",
        target: host,
      },
    );
  }
  const now = ctx.now.getTime();
  const validFrom = new Date(cert.validFrom).getTime();
  const validTo = new Date(cert.validTo).getTime();
  if (Number.isNaN(validTo) || Number.isNaN(validFrom)) {
    return result(id, title, "high", "fail", `The certificate's validity dates cannot be read.`, {
      target: host,
    });
  }
  if (validTo <= now) {
    return result(
      id,
      title,
      "critical",
      "fail",
      `The certificate expired on ${day(cert.validTo)} (issued by ${cert.issuer}); browsers refuse the site.`,
      {
        remediation:
          "Check Caddy's logs (`docker compose logs caddy`) for renewal errors; renewal needs port 80 or 443 reachable from the internet.",
        target: host,
      },
    );
  }
  if (validFrom > now) {
    return result(
      id,
      title,
      "high",
      "fail",
      `The certificate is not valid until ${day(cert.validFrom)}; check the server's clock.`,
      { target: host },
    );
  }
  const days = Math.floor((validTo - now) / 86_400_000);
  if (days < MIN_CERT_DAYS) {
    return result(
      id,
      title,
      "medium",
      "fail",
      `The certificate expires on ${day(cert.validTo)} (${days} days left) and has not been renewed (issued by ${cert.issuer}).`,
      {
        remediation:
          "Caddy renews 30 days ahead, so renewal is failing: check `docker compose logs caddy` on the server.",
        target: host,
      },
    );
  }
  return result(
    id,
    title,
    "high",
    "pass",
    `Valid for ${host} until ${day(cert.validTo)} (${days} days left), issued by ${cert.issuer}.`,
    { target: host },
  );
}

/** Plain HTTP redirects to HTTPS. */
export async function checkHttpRedirect(
  host: string,
  ctx: VerifyCheckContext,
): Promise<CheckResult> {
  const id = "http-redirect";
  const title = "HTTP redirects to HTTPS";
  const target = `http://${host}/`;
  try {
    const response = await ctx.fetch(target, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(ctx.timeoutMs ?? 10_000),
    });
    await discard(response);
    const location = response.headers.get("location") ?? "";
    if (response.status >= 300 && response.status < 400 && location.startsWith("https://")) {
      return result(id, title, "medium", "pass", `${target} redirects to ${location}.`, { target });
    }
    return result(
      id,
      title,
      "medium",
      "fail",
      `${target} answered with HTTP ${response.status}${location ? ` → ${location}` : ""} instead of redirecting to HTTPS.`,
      {
        remediation:
          'Caddy redirects automatically when the site address is the domain; check the Caddyfile (and Cloudflare\'s SSL/TLS mode "Full (strict)").',
        target,
      },
    );
  } catch (error) {
    return result(id, title, "medium", "fail", `Could not reach ${target}: ${errorText(error)}.`, {
      remediation: "Make sure port 80 is open in the firewall; Caddy needs it for redirects.",
      target,
    });
  }
}

/** The health endpoint answers 200. */
export async function checkHealth(url: string, ctx: VerifyCheckContext): Promise<CheckResult> {
  const id = "health-endpoint";
  const title = "Health endpoint answers 200";
  const target = `${url}${ctx.plan.app.healthPath}`;
  const remediation = `Make sure the app serves ${ctx.plan.app.healthPath} with status 200, then look at \`docker compose logs --tail 200 app\` on the server.`;
  try {
    const response = await ctx.fetch(target, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(ctx.timeoutMs ?? 10_000),
    });
    await discard(response);
    return response.status === 200
      ? result(id, title, "high", "pass", `${target} answered 200.`, { target })
      : result(id, title, "high", "fail", `${target} answered with HTTP ${response.status}.`, {
          remediation,
          target,
        });
  } catch (error) {
    return result(id, title, "high", "fail", `Could not reach ${target}: ${errorText(error)}.`, {
      remediation,
      target,
    });
  }
}

/** Security headers set by Caddy are present (HSTS only over HTTPS). */
export function checkSecurityHeaders(headers: Headers | undefined, url: string): CheckResult {
  const id = "security-headers";
  const title = "Security headers are set";
  const target = `${url}/`;
  if (headers === undefined) {
    return result(id, title, "medium", "skip", "Skipped because the site did not answer.", {
      target,
    });
  }
  const https = url.startsWith("https://");
  const missing = SECURITY_HEADERS.filter((header) => !header.httpsOnly || https)
    .filter((header) => {
      const value = headers.get(header.name);
      return value === null || (header.expect !== undefined && !header.expect.test(value));
    })
    .map((header) => header.name);
  if (missing.length === 0) {
    return result(id, title, "medium", "pass", "All expected security headers are present.", {
      target,
    });
  }
  return result(id, title, "medium", "fail", `Missing or weak headers: ${missing.join(", ")}.`, {
    remediation:
      "Restore the `header` block in opscrew/runtime/Caddyfile (re-run `opscrew provision` to regenerate it) and redeploy.",
    target,
  });
}

/** `.env` and `.git/config` are not served (a SPA fallback page is fine; the real file is not). */
export async function checkSensitiveFile(
  url: string,
  path: "/.env" | "/.git/config",
  ctx: VerifyCheckContext,
): Promise<CheckResult> {
  const id = path === "/.env" ? "env-file-not-served" : "git-config-not-served";
  const title = `${path} is not served`;
  const target = `${url}${path}`;
  try {
    const response = await ctx.fetch(target, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(ctx.timeoutMs ?? 10_000),
    });
    if (response.status !== 200) {
      await discard(response);
      return result(
        id,
        title,
        "critical",
        "pass",
        `${target} answered with HTTP ${response.status}.`,
        {
          target,
        },
      );
    }
    // Look at the start of the body only to tell a fallback HTML page from the real file; the
    // content is never stored or printed.
    const body = (await response.text()).slice(0, 4096);
    const looksReal =
      path === "/.env"
        ? /^\s*(export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=/m.test(body) && !/<html|<!doctype/i.test(body)
        : /^\s*\[core\]/m.test(body);
    if (!looksReal) {
      return result(
        id,
        title,
        "critical",
        "pass",
        `${target} answered 200 with a page that is not the file (an app fallback page).`,
        { target },
      );
    }
    return result(
      id,
      title,
      "critical",
      "fail",
      path === "/.env"
        ? `${target} serves the app's environment file: anyone can read its secrets.`
        : `${target} serves the git repository: anyone can download the source code and its history.`,
      {
        remediation:
          path === "/.env"
            ? "Remove the file from the public directory and the Docker image (add it to .dockerignore), redeploy, then rotate every secret it contained."
            : "Add .git to .dockerignore so it is not copied into the image, then redeploy.",
        target,
      },
    );
  } catch (error) {
    return result(
      id,
      title,
      "critical",
      "warn",
      `Could not request ${target}: ${errorText(error)}.`,
      {
        target,
      },
    );
  }
}

/** When only Cloudflare may reach the origin, TCP 443 on the server IP is filtered. */
export async function checkOriginBlocked(ctx: VerifyCheckContext): Promise<CheckResult> {
  const id = "origin-not-direct";
  const title = "The server is not reachable around Cloudflare";
  const { plan } = ctx;
  const ip = ctx.server?.ipv4;
  if (plan.dns.provider !== "cloudflare" || !plan.dns.proxied) {
    return result(
      id,
      title,
      "medium",
      "skip",
      "Skipped: the site is not behind Cloudflare's proxy.",
    );
  }
  if (plan.security.httpAllowedFrom !== "cloudflare") {
    return result(
      id,
      title,
      "medium",
      "skip",
      'Skipped: the firewall is configured to accept web traffic from anywhere (security.httpAllowedFrom is "any").',
    );
  }
  if (!ip) {
    return result(
      id,
      title,
      "medium",
      "skip",
      "Skipped: OpsCrew does not know the server's address on this computer.",
      { remediation: UNKNOWN_ADDRESS_REMEDIATION },
    );
  }
  const open = await ctx.tcpConnect(ip, 443, Math.min(ctx.timeoutMs ?? 3000, 3000));
  return open
    ? result(
        id,
        title,
        "medium",
        "fail",
        `Port 443 on the server (${ip}) answers directly, so Cloudflare's protection can be bypassed.`,
        {
          remediation: `Re-run \`opscrew provision\` so the ${profileOf(plan).displayName} firewall only allows Cloudflare's IP ranges on ports 80 and 443.`,
          target: ip,
        },
      )
    : result(id, title, "medium", "pass", `Port 443 on ${ip} is closed to direct visitors.`, {
        target: ip,
      });
}

/** The latest run of the deploy workflow on the deploy branch succeeded. */
export async function checkDeployRun(ctx: VerifyCheckContext): Promise<{
  check: CheckResult;
  lastDeployAt?: string;
}> {
  const id = "deploy-run";
  const { workflowPath, branch } = ctx.plan.cicd;
  const workflow = workflowPath.split("/").pop() ?? workflowPath;
  const title = `Latest ${workflow} run on ${branch} succeeded`;
  let runs: DeployRunInfo[] | undefined;
  let reason = "no GitHub token is available (set GITHUB_TOKEN or run `gh auth login`)";
  try {
    runs = await ctx.deployRuns();
  } catch (error) {
    reason = errorText(error);
  }
  if (runs === undefined) {
    return {
      check: result(id, title, "high", "warn", `Could not read the deploy runs: ${reason}.`, {
        remediation: "Check the latest run in GitHub → Actions yourself.",
      }),
    };
  }
  const latest = runs[0];
  if (latest === undefined) {
    return {
      check: result(id, title, "high", "fail", `${workflow} has not run on ${branch} yet.`, {
        remediation: `Merge the OpsCrew pull request into ${branch} (or push to it) to start the first deploy.`,
      }),
    };
  }
  if (latest.status !== "completed") {
    return {
      check: result(
        id,
        title,
        "high",
        "warn",
        `The latest deploy is still ${latest.status.replace(/_/g, " ")}: ${latest.htmlUrl}`,
        {
          remediation: "Wait for it to finish, then run `opscrew verify` again.",
          target: latest.htmlUrl,
        },
      ),
    };
  }
  if (latest.conclusion !== "success") {
    return {
      check: result(
        id,
        title,
        "high",
        "fail",
        `The latest deploy ended with "${latest.conclusion ?? "unknown"}": ${latest.htmlUrl}`,
        {
          remediation:
            "Open the run, read the failed step and fix it; the previous version keeps running after an automatic rollback.",
          target: latest.htmlUrl,
        },
      ),
    };
  }
  const at = new Date(latest.createdAt);
  return {
    check: result(id, title, "high", "pass", `The latest deploy succeeded: ${latest.htmlUrl}`, {
      target: latest.htmlUrl,
    }),
    ...(Number.isNaN(at.getTime()) ? {} : { lastDeployAt: at.toISOString() }),
  };
}

/** Result of {@link runVerifyChecks}. */
export interface VerifyChecksOutcome {
  checks: CheckResult[];
  /** When the latest deploy run succeeded, the time it started. */
  lastDeployAt?: string;
}

/**
 * Runs every verify check from plan.md in report order. Without a domain the DNS and TLS checks
 * warn (the site is served over plain HTTP on the server IP) instead of failing.
 */
export async function runVerifyChecks(ctx: VerifyCheckContext): Promise<VerifyChecksOutcome> {
  const { plan } = ctx;
  const hosts = verifyHosts(plan);
  const url = siteUrl(plan, ctx.server);
  const checks: CheckResult[] = [];
  const [domain] = hosts;

  if (domain === undefined) {
    const addDomain =
      "Add a domain with `opscrew dns --domain <your-domain>` to get HTTPS, a certificate and a stable address.";
    checks.push(
      result(
        "dns-records",
        "DNS points to the right place",
        "medium",
        "warn",
        "No domain is configured: the app is served over plain HTTP on the server's IP address.",
        { remediation: addDomain },
      ),
    );
  } else {
    for (const host of hosts) checks.push(await checkDns(host, ctx));
  }

  if (url === undefined) {
    throw new Error("runVerifyChecks needs a domain or the server's address.");
  }
  const site = await checkSiteReachable(url, ctx);
  checks.push(site.check);

  if (domain === undefined) {
    checks.push(
      result(
        "tls-certificate",
        "HTTPS certificate is valid",
        "medium",
        "warn",
        "No domain, so there is no HTTPS certificate: traffic to the app is not encrypted.",
        {
          remediation:
            "Add a domain with `opscrew dns --domain <your-domain>`; Caddy then gets a certificate automatically.",
        },
      ),
      result(
        "http-redirect",
        "HTTP redirects to HTTPS",
        "medium",
        "skip",
        "Skipped: no domain, so no HTTPS.",
      ),
    );
  } else {
    checks.push(await checkTls(domain, ctx));
    checks.push(await checkHttpRedirect(domain, ctx));
  }

  checks.push(await checkHealth(url, ctx));
  checks.push(checkSecurityHeaders(site.headers, url));
  checks.push(await checkSensitiveFile(url, "/.env", ctx));
  checks.push(await checkSensitiveFile(url, "/.git/config", ctx));
  checks.push(await checkOriginBlocked(ctx));
  const deploy = await checkDeployRun(ctx);
  checks.push(deploy.check);
  return {
    checks,
    ...(deploy.lastDeployAt !== undefined ? { lastDeployAt: deploy.lastDeployAt } : {}),
  };
}
