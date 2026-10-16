import { BlockList, isIPv6 } from "node:net";
import type { CheckResult, FetchLike, Severity } from "@opscrew/contracts";
import { tunnelMode } from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import type { TcpConnect } from "@opscrew/secops";
import { type ProviderProfile, planProvider, providerProfile } from "../providers";
import type { AddressRecordLookup } from "../provision/portainer";
import { providerConsole, type ServerAddress } from "../shared";
import { type DnsResolver, hasIpv6Route, type TlsCertificateInfo, type TlsConnect } from "./net";

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
  /**
   * The address to check instead of the plan's: the user's own route to the app (the user's
   * Portainer in web mode `proxy` without a domain in the plan).
   */
  url?: string;
  /**
   * Whether this computer can reach IPv6 addresses (default: it has a global IPv6 address);
   * without it the IPv6 probe of a server the user owns is skipped with a note.
   */
  ipv6Route?: () => Promise<boolean>;
  /**
   * Asks a public resolver whether a host has a record (for the user's Portainer: Cloudflare's DNS
   * over HTTPS). When this computer finds none but the public resolver does, the DNS check and the
   * site checks that fail with ENOTFOUND say this computer still holds an older answer. Absent:
   * no public lookup and no such note.
   */
  publicDns?: (host: string) => Promise<AddressRecordLookup>;
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

/** The user's Portainer, and how visitors reach the app there (`undefined` for other targets). */
function portainerWeb(plan: DeployPlan): "tunnel" | "proxy" | "caddy" | undefined {
  return plan.target.provider === "portainer" ? plan.target.web.mode : undefined;
}

/** Where the app's logs are in the user's Portainer (never its address). */
function portainerLogs(plan: DeployPlan): string {
  return `the app's logs in your Portainer (Stacks → opscrew-${plan.app.name} → the app container → Logs)`;
}

/** Where to look when the server seems down: the provider's console, or the user's own server. */
function serverRunningHint(plan: DeployPlan): string {
  if (plan.target.provider === "portainer") {
    const stack = `the stack opscrew-${plan.app.name} runs in your Portainer`;
    const web = plan.target.web;
    return web.mode === "tunnel"
      ? `that ${stack}, with its cloudflared container connected`
      : web.mode === "proxy"
        ? `that ${stack} and your reverse proxy forwards to port ${web.port} of the host`
        : `that ${stack} and ports 80 and 443 of the host are reachable from the internet`;
  }
  if (plan.target.provider !== "own") {
    const profile = profileOf(plan);
    return `that the ${profile.serverNoun} is running (${providerConsole(profile)})`;
  }
  return tunnelMode(plan)
    ? "that your server is running and its Cloudflare Tunnel connector is up (`docker compose -p opscrew-tunnel ps` on the server)"
    : "that your server is running";
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause;
    const detail = cause instanceof Error && cause.message ? ` (${cause.message})` : "";
    return `${error.message}${detail}`;
  }
  return String(error);
}

/** Why this computer cannot find a record that exists publicly (a cached negative answer). */
const STALE_LOCAL_DNS =
  "The record exists publicly (a public resolver has it), but this computer still holds an older answer that says there is none; it clears within about 15 minutes.";

/** How to clear a cached negative answer on this computer. */
const FLUSH_DNS =
  "Wait about 15 minutes, or flush this computer's DNS cache (`ipconfig /flushdns` on Windows, `sudo resolvectl flush-caches` on Linux, `sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder` on macOS), then run `opscrew verify` again.";

/** True when `error` (or its cause) says the host name was not found (`ENOTFOUND`). */
function isNotFound(error: unknown): boolean {
  let current = error;
  for (let depth = 0; current instanceof Error && depth < 3; depth++) {
    const code = (current as NodeJS.ErrnoException).code;
    if (code === "ENOTFOUND" || /\bENOTFOUND\b/.test(current.message)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** Whether the public resolver (when injected) has a record for `host`; any failure is "no". */
async function publiclyFound(host: string, ctx: VerifyCheckContext): Promise<boolean> {
  if (!ctx.publicDns) return false;
  try {
    return (await ctx.publicDns(host)).state === "found";
  } catch {
    return false;
  }
}

/**
 * The note a site check adds when it failed with ENOTFOUND although `host` has a public record
 * (with a leading space), or an empty string.
 */
async function staleNote(error: unknown, host: string, ctx: VerifyCheckContext): Promise<string> {
  return isNotFound(error) && (await publiclyFound(host, ctx))
    ? ` ${STALE_LOCAL_DNS} ${FLUSH_DNS}`
    : "";
}

/** Asks the public resolver at most once per host during one verify run. */
function oncePerHost(ctx: VerifyCheckContext): VerifyCheckContext {
  const lookup = ctx.publicDns;
  if (!lookup) return ctx;
  const answers = new Map<string, Promise<AddressRecordLookup>>();
  return {
    ...ctx,
    publicDns: (host) => {
      const key = host.toLowerCase();
      let answer = answers.get(key);
      if (!answer) {
        answer = lookup(host);
        answers.set(key, answer);
      }
      return answer;
    },
  };
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

/**
 * The site's public hosts: the domain (and `www.` when configured); empty without a domain. In the
 * user's Portainer the domain may be on any DNS (the user creates its record for `proxy` and
 * `caddy`).
 */
export function verifyHosts(plan: DeployPlan): string[] {
  const domain =
    plan.dns.provider === "cloudflare" || plan.target.provider === "portainer"
      ? plan.dns.domain
      : undefined;
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

/**
 * True when web traffic may reach the server only through Cloudflare: behind Cloudflare's proxy
 * with `security.httpAllowedFrom: cloudflare`, the cloud firewall (Hetzner, DigitalOcean) or, on a
 * server the user owns in public mode, OpsCrew's web filter in Docker's DOCKER-USER chain lets
 * ports 80/443 in only from Cloudflare's IP ranges. Never in tunnel mode, where no web port is open.
 */
export function originIsCloudflareOnly(plan: DeployPlan): boolean {
  return (
    !(plan.target.provider === "own" && plan.target.access === "tunnel") &&
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
  return (await dnsCheck(host, ctx)).check;
}

/** {@link checkDns}, and whether this computer holds an older answer than the public resolver. */
async function dnsCheck(
  host: string,
  ctx: VerifyCheckContext,
): Promise<{ check: CheckResult; stale: boolean }> {
  const check = await dnsRecords(host, ctx);
  if (check !== "none") return { check, stale: false };
  const id = host.startsWith("www.") ? "dns-records-www" : "dns-records";
  const title = `DNS for ${host} points to the right place`;
  if (await publiclyFound(host, ctx)) {
    return {
      check: result(
        id,
        title,
        "high",
        "fail",
        `${host} has no A or AAAA record through this computer's DNS resolver. ${STALE_LOCAL_DNS}`,
        { remediation: FLUSH_DNS, target: host },
      ),
      stale: true,
    };
  }
  const tunnel = tunnelMode(ctx.plan) || portainerWeb(ctx.plan) === "tunnel";
  return {
    check: result(id, title, "high", "fail", `${host} has no A or AAAA record.`, {
      remediation:
        ctx.plan.target.provider === "portainer" && !tunnel
          ? `OpsCrew creates no DNS record for ${host} in this setup: create one that points it at your Portainer host (an A record, and AAAA for IPv6, to its public address, or a CNAME to its dynamic-DNS name).`
          : "Run `opscrew dns` to create the records, and check that the domain's nameservers point to Cloudflare.",
      target: host,
    }),
    stale: false,
  };
}

/** The DNS check's result, or `none` when this computer's resolver finds no A or AAAA record. */
async function dnsRecords(host: string, ctx: VerifyCheckContext): Promise<CheckResult | "none"> {
  const id = host.startsWith("www.") ? "dns-records-www" : "dns-records";
  const title = `DNS for ${host} points to the right place`;
  const { plan } = ctx;
  // Through a Cloudflare Tunnel the records are always proxied CNAMEs: they resolve to Cloudflare.
  const tunnel = tunnelMode(plan) || portainerWeb(plan) === "tunnel";
  // A server the user owns: the messages say "your server" and never list its addresses.
  const own = plan.target.provider === "own";
  // The user's Portainer: OpsCrew never knows the host's public address, nor shows what it resolves to.
  const portainer = plan.target.provider === "portainer";
  const ipv4 = tunnel ? undefined : ctx.server?.ipv4;
  const ipv6 = tunnel ? undefined : ctx.server?.ipv6;
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
  if (a.length === 0 && aaaa.length === 0) return "none";
  const addresses = [...a, ...aaaa];
  if (portainer && !tunnel && !plan.dns.proxied) {
    // The host's public address is the user's (often a home connection): never printed.
    return result(
      id,
      title,
      "high",
      "pass",
      `${host} has DNS records; OpsCrew does not know your Portainer host's public address, so the checks below show whether they reach the app.`,
      { target: host },
    );
  }
  if (plan.dns.proxied || tunnel) {
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
        own
          ? `${host} resolves to your server itself, so Cloudflare's proxy is bypassed and your server's address is public.`
          : `${host} resolves to the server itself (${exposed.join(", ")}), so Cloudflare's proxy is bypassed and the server's IP is public.`,
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
          own
            ? `${host} resolves to an address that is not a Cloudflare address.`
            : `${host} resolves to ${outside.join(", ")}, which is not a Cloudflare address.`,
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
      tunnel
        ? `${host} resolves to Cloudflare (${addresses.join(", ")}); the app is served through the Cloudflare Tunnel.`
        : portainer
          ? `${host} resolves to Cloudflare (${addresses.join(", ")}); your Portainer host's address stays hidden.`
          : own
            ? `${host} resolves to Cloudflare (${addresses.join(", ")}); your server's address stays hidden.`
            : `${host} resolves to Cloudflare (${addresses.join(", ")}); the server's IP stays hidden.`,
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
      own
        ? `${host} has DNS records, but OpsCrew does not know your server's address on this computer, so it cannot tell whether they point to your server.`
        : `${host} resolves to ${addresses.join(", ")}, but OpsCrew does not know the server's address on this computer, so it cannot tell whether that is the server.`,
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
      own
        ? wrong.length > 0
          ? `${host} resolves not only to your server's address: ${wrong.length} record${wrong.length === 1 ? " points" : "s point"} somewhere else.`
          : `${host} has no A record for your server's IPv4 address.`
        : `${host} resolves to ${addresses.join(", ")} but the server is ${expected}.`,
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
    own
      ? `${host} resolves to your server's address.`
      : `${host} resolves to the server (${addresses.join(", ")}).`,
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
              portainerWeb(ctx.plan) !== undefined
                ? `Look at ${portainerLogs(ctx.plan)} and the latest deploy run.`
                : "Look at the app's logs on the server (`docker compose logs --tail 200 app`) and the latest deploy run.",
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
        `Could not reach ${target}: ${errorText(error)}.${await staleNote(error, new URL(target).hostname, ctx)}`,
        {
          remediation: `Check that the latest deploy run succeeded and ${serverRunningHint(ctx.plan)}.`,
          target,
        },
      ),
    };
  }
}

/** The certificate covers the host, is valid for at least {@link MIN_CERT_DAYS} days, and names its issuer. */
export async function checkTls(
  host: string,
  ctx: VerifyCheckContext,
  port = 443,
): Promise<CheckResult> {
  const id = "tls-certificate";
  const title = `HTTPS certificate for ${host} is valid`;
  let cert: TlsCertificateInfo;
  try {
    cert = await ctx.tlsConnect(host, { port, timeoutMs: ctx.timeoutMs ?? 10_000 });
  } catch (error) {
    return result(
      id,
      title,
      "high",
      "fail",
      `Could not open an HTTPS connection to ${host}: ${errorText(error)}.${await staleNote(error, host, ctx)}`,
      {
        remediation:
          tunnelMode(ctx.plan) || portainerWeb(ctx.plan) === "tunnel"
            ? "Cloudflare answers HTTPS for the tunnel: check that the domain uses Cloudflare's nameservers and that the record is proxied, then run `opscrew provision` to see what is missing."
            : portainerWeb(ctx.plan) === "proxy"
              ? "Your reverse proxy answers HTTPS for the app and manages its certificate: check that it serves this name."
              : portainerWeb(ctx.plan) === "caddy"
                ? `Check that ports 80 and 443 of your Portainer host are reachable from the internet and that Caddy runs (its logs in your Portainer: Stacks → opscrew-${ctx.plan.app.name} → the caddy container).`
                : "Check that ports 80 and 443 are open and that Caddy is running (`docker compose logs caddy`).",
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
          portainerWeb(ctx.plan) === "proxy"
            ? "Your reverse proxy serves the app: make it redirect HTTP to HTTPS for this name."
            : 'Caddy redirects automatically when the site address is the domain; check the Caddyfile (and Cloudflare\'s SSL/TLS mode "Full (strict)").',
        target,
      },
    );
  } catch (error) {
    const note = await staleNote(error, host, ctx);
    return result(
      id,
      title,
      "medium",
      "fail",
      `Could not reach ${target}: ${errorText(error)}.${note}`,
      {
        remediation: "Make sure port 80 is open in the firewall; Caddy needs it for redirects.",
        target,
      },
    );
  }
}

/** The health endpoint answers 200. */
export async function checkHealth(url: string, ctx: VerifyCheckContext): Promise<CheckResult> {
  const id = "health-endpoint";
  const title = "Health endpoint answers 200";
  const target = `${url}${ctx.plan.app.healthPath}`;
  const remediation =
    portainerWeb(ctx.plan) !== undefined
      ? `Make sure the app serves ${ctx.plan.app.healthPath} with status 200, then look at ${portainerLogs(ctx.plan)}.`
      : `Make sure the app serves ${ctx.plan.app.healthPath} with status 200, then look at \`docker compose logs --tail 200 app\` on the server.`;
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
    const note = await staleNote(error, new URL(target).hostname, ctx);
    return result(
      id,
      title,
      "high",
      "fail",
      `Could not reach ${target}: ${errorText(error)}.${note}`,
      {
        remediation,
        target,
      },
    );
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
      `Could not request ${target}: ${errorText(error)}.${await staleNote(error, new URL(target).hostname, ctx)}`,
      {
        target,
      },
    );
  }
}

const OWN_ORIGIN_REMEDIATION =
  "Run `opscrew drift` to see whether OpsCrew's web filter (in Docker's DOCKER-USER chain) is missing or was changed, then `opscrew provision`: it shows the change that lets only Cloudflare's IP ranges reach ports 80 and 443 (published on IPv4 only). If a rule of your own in DOCKER-USER comes before OpsCrew's (`sudo iptables -S DOCKER-USER`), or another program listens on port 443 over IPv6, remove it.";

/**
 * The origin check on a server the user owns behind OpsCrew's web filter: 443 must not answer on
 * its IPv4 address (already probed: `open4`) nor, when it has one and this computer can reach
 * IPv6, on its IPv6 address (the site is published on IPv4 only). The addresses never appear in
 * the result (FR-902).
 */
async function ownOriginResult(
  ctx: VerifyCheckContext,
  open4: boolean,
  timeout: number,
): Promise<CheckResult> {
  const id = "origin-not-direct";
  const title = "The server is not reachable around Cloudflare";
  const ipv6 = ctx.server?.ipv6;
  const canTryIpv6 = ipv6 !== undefined && (await (ctx.ipv6Route ?? hasIpv6Route)());
  const open6 = canTryIpv6 ? await ctx.tcpConnect(ipv6, 443, timeout) : false;
  if (open4 || open6) {
    const where =
      open4 && open6 ? "IPv4 and IPv6 addresses" : open4 ? "IPv4 address" : "IPv6 address";
    return result(
      id,
      title,
      "medium",
      "fail",
      `Port 443 on your server's ${where} answers directly, so visitors can reach it around Cloudflare's protection.`,
      { remediation: OWN_ORIGIN_REMEDIATION },
    );
  }
  const note =
    ipv6 === undefined
      ? ""
      : canTryIpv6
        ? " (IPv4 and IPv6)"
        : ". OpsCrew could not try its IPv6 address: this computer has no IPv6 route; run `opscrew verify` from a network with IPv6 to check it too";
  return result(
    id,
    title,
    "medium",
    "pass",
    `Port 443 on your server is closed to direct visitors${note}; only Cloudflare reaches it.`,
  );
}

/** When only Cloudflare may reach the origin, TCP 443 on the server IP is filtered. */
export async function checkOriginBlocked(ctx: VerifyCheckContext): Promise<CheckResult> {
  const id = "origin-not-direct";
  const title = "The server is not reachable around Cloudflare";
  const { plan } = ctx;
  const ip = ctx.server?.ipv4;
  const web = portainerWeb(plan);
  if (web !== undefined) {
    return result(
      id,
      title,
      "medium",
      "skip",
      web === "tunnel"
        ? "Skipped: the app is served through a Cloudflare Tunnel, and its stack in your Portainer publishes no port on the host."
        : "Skipped: OpsCrew does not change your Portainer host (its firewall stays yours) and does not know its public address, so it cannot check whether the app can be reached around Cloudflare.",
    );
  }
  if (tunnelMode(plan)) {
    return result(
      id,
      title,
      "medium",
      "skip",
      "Skipped: the app is served through a Cloudflare Tunnel, so the server opens no web port that could be reached around Cloudflare (`opscrew secure` checks that from outside).",
    );
  }
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
  const timeout = Math.min(ctx.timeoutMs ?? 3000, 3000);
  const open = await ctx.tcpConnect(ip, 443, timeout);
  if (plan.target.provider === "own") return ownOriginResult(ctx, open, timeout);
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
 * The user's Portainer behind their own reverse proxy: OpsCrew creates no DNS record for the
 * domain (it prints the one the user creates) and the proxy manages its certificate and redirect,
 * so a failed domain check is a warning that says so. Other targets and modes are unchanged.
 */
function userDomain(
  check: CheckResult,
  host: string,
  plan: DeployPlan,
  stale = false,
): CheckResult {
  if (portainerWeb(plan) !== "proxy" || check.status !== "fail") return check;
  return {
    ...check,
    status: "warn",
    message: `${check.message} Behind your own reverse proxy the DNS record and the certificate for ${host} are yours, so this is a warning.`,
    // This computer holds an older answer for a record that exists: clearing it is what helps.
    remediation: stale
      ? FLUSH_DNS
      : `The record and the certificate are yours: create the record OpsCrew printed and route ${host} in your proxy (it serves HTTPS and redirects HTTP), then run \`opscrew verify\` again.`,
  };
}

/**
 * Runs every verify check from plan.md in report order. Without a domain the DNS and TLS checks
 * warn (the site is served over plain HTTP on the server IP) instead of failing.
 */
export async function runVerifyChecks(context: VerifyCheckContext): Promise<VerifyChecksOutcome> {
  const ctx = oncePerHost(context);
  const { plan } = ctx;
  // Hosts this computer cannot find although a public resolver has their record.
  const stale = new Set<string>();
  const hosts = verifyHosts(plan);
  const url = ctx.url ?? siteUrl(plan, ctx.server);
  const checks: CheckResult[] = [];
  const [domain] = hosts;
  // The user's Portainer behind their own reverse proxy, without a domain: their route is checked,
  // and its DNS and certificate are the proxy's.
  const userRoute = domain === undefined && plan.target.provider === "portainer";

  if (userRoute) {
    checks.push(
      result(
        "dns-records",
        "DNS points to the right place",
        "medium",
        "skip",
        `Skipped: opscrew/plan.yaml has no domain; OpsCrew checks your reverse proxy's route to the app (${url ?? "not given"}), whose DNS your proxy setup manages.`,
      ),
    );
  } else if (domain === undefined) {
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
    for (const host of hosts) {
      const dns = await dnsCheck(host, ctx);
      if (dns.stale) stale.add(host);
      checks.push(userDomain(dns.check, host, plan, dns.stale));
    }
  }

  if (url === undefined) {
    throw new Error("runVerifyChecks needs a domain or the server's address.");
  }
  const site = await checkSiteReachable(url, ctx);
  checks.push(site.check);

  if (userRoute) {
    const route = new URL(url);
    if (route.protocol === "https:") {
      checks.push(await checkTls(route.hostname, ctx, Number(route.port || 443)));
      checks.push(
        route.port === ""
          ? await checkHttpRedirect(route.hostname, ctx)
          : result(
              "http-redirect",
              "HTTP redirects to HTTPS",
              "medium",
              "skip",
              "Skipped: the route uses a port of its own, so there is no plain-HTTP address to try.",
            ),
      );
    } else {
      checks.push(
        result(
          "tls-certificate",
          "HTTPS certificate is valid",
          "medium",
          "warn",
          "Your reverse proxy's route to the app is plain HTTP: traffic to the app is not encrypted.",
          {
            remediation:
              "Serve the app over HTTPS in your reverse proxy (it manages the certificate), then run `opscrew verify` again with the https:// address.",
          },
        ),
        result(
          "http-redirect",
          "HTTP redirects to HTTPS",
          "medium",
          "skip",
          "Skipped: the route is not HTTPS.",
        ),
      );
    }
  } else if (domain === undefined) {
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
    const domainStale = stale.has(domain);
    checks.push(userDomain(await checkTls(domain, ctx), domain, plan, domainStale));
    checks.push(userDomain(await checkHttpRedirect(domain, ctx), domain, plan, domainStale));
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
