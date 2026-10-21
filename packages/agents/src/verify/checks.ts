import { BlockList, isIP, isIPv6, type LookupFunction } from "node:net";
import { tunnelProject } from "@opscrew/connector-ssh-host";
import type { CheckResult, FetchLike } from "@opscrew/contracts";
import { normalizeHostName, upperFirst } from "@opscrew/core";
import { tunnelMode } from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import { CERTIFICATE_WARN_DAYS, daysLeft, type TcpConnect } from "@opscrew/secops";
import { type ProviderProfile, planProvider, providerProfile } from "../providers";
import {
  checkResult,
  ipv6HttpsAnswers,
  providerConsole,
  provisionedElsewhereHint,
  type ServerAddress,
  sameIp,
} from "../shared";
import type { PublicAddressLookup } from "../shared/public-dns";
import { proxyCertificateHosts, proxyRenewalAdvice } from "../status/certificates";
import {
  type DnsResolver,
  type FetchWithLookup,
  type PublicAddresses,
  publicAnswerLookup,
  type TlsCertificateInfo,
  type TlsConnect,
} from "./net";

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
   * Asks a public resolver about a host this computer cannot resolve (for the user's Portainer:
   * Cloudflare's DNS over HTTPS), once per host; the caller registers the addresses it returns
   * with the redactor. With addresses and {@link fetchWithLookup}, the DNS, site and TLS checks of
   * that host use them, and the DNS check says this computer still holds an older answer. Absent:
   * no public lookup.
   */
  publicDns?: (host: string) => Promise<PublicAddressLookup>;
  /**
   * Builds the fetch the site checks use for a host checked through the public answer (the lookup
   * asks this computer first). Absent: no host is checked through a public answer.
   */
  fetchWithLookup?: FetchWithLookup;
  /** This computer's own host name lookup, asked first (default `dns.lookup`). */
  lookup?: LookupFunction;
  /**
   * certbot's reason when its last renewal of the app's certificate failed, read from the server
   * only when a DNS-only certificate is not renewed in time; absent: no reason is given.
   */
  renewalFailure?: () => Promise<string | undefined>;
}

/** What `opscrew verify` says to do when the server's address is not on this computer. */
export const UNKNOWN_ADDRESS_REMEDIATION = `${upperFirst(provisionedElsewhereHint("opscrew verify"))}.`;

/** Certificates that expire sooner than this fail the TLS check (Caddy renews 30 days ahead). */
export const MIN_CERT_DAYS = 14;

/** Headers Caddy sets on every response (see the rendered Caddyfile). */
const SECURITY_HEADERS: readonly { name: string; httpsOnly?: boolean; expect?: RegExp }[] = [
  { name: "strict-transport-security", httpsOnly: true, expect: /max-age=\d+/i },
  { name: "x-content-type-options", expect: /nosniff/i },
  { name: "x-frame-options" },
  { name: "referrer-policy" },
];

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
    ? `that your server is running and the app's Cloudflare Tunnel connector is up (\`docker compose -p ${tunnelProject(plan.app.name)} ps\` on the server)`
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

/** How to clear a cached negative answer on this computer. */
const FLUSH_DNS =
  "Flush this computer's DNS cache (`ipconfig /flushdns` on Windows, `sudo resolvectl flush-caches` on Linux, `sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder` on macOS); if it still finds no record, your router or internet provider keeps the older answer for up to about 30 minutes (restarting the router clears its copy). Then run `opscrew verify` again.";

/** What verify did when this computer holds an older answer but the public resolver has the record. */
const CHECKED_PUBLICLY =
  "This computer's DNS still holds an older answer that says there is no record, so OpsCrew checked the site through a public resolver's answer, as visitors reach it.";

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

/**
 * The public addresses to check `host` through: the public resolver has its record with at least
 * one address and the site checks can connect through them (`fetchWithLookup`); otherwise none.
 */
async function publicAddresses(
  host: string,
  ctx: VerifyCheckContext,
): Promise<PublicAddresses | undefined> {
  if (!ctx.publicDns || !ctx.fetchWithLookup) return undefined;
  const answer = await ctx.publicDns(host);
  if (answer.state !== "found") return undefined;
  const ipv4 = answer.ipv4 ?? [];
  const ipv6 = answer.ipv6 ?? [];
  return ipv4.length + ipv6.length > 0 ? { ipv4, ipv6 } : undefined;
}

/** A resolver that answers with `addresses` for every name (the public answer for one host). */
function fixedResolver(addresses: PublicAddresses): DnsResolver {
  return { resolve4: async () => [...addresses.ipv4], resolve6: async () => [...addresses.ipv6] };
}

/**
 * The context for the site checks when hosts are checked through their public answer: requests
 * and TLS connections to those hosts find addresses with a lookup that asks this computer first
 * and then the public answer (the URL, SNI and certificate check keep the host name); other hosts
 * are unchanged.
 */
function throughPublicAnswers(
  ctx: VerifyCheckContext,
  answers: ReadonlyMap<string, PublicAddresses>,
): VerifyCheckContext {
  const build = ctx.fetchWithLookup;
  if (answers.size === 0 || !build) return ctx;
  const lookup = publicAnswerLookup(answers, ctx.lookup);
  const viaLookup = build(lookup);
  const pinned = (host: string) => answers.has(normalizeHostName(host));
  return {
    ...ctx,
    fetch: (input, init) =>
      pinned(new URL(String(input)).hostname) ? viaLookup(input, init) : ctx.fetch(input, init),
    tlsConnect: (host, options) =>
      ctx.tlsConnect(host, pinned(host) ? { ...options, lookup } : options),
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

/** Certificate name matching with single-label wildcards (`*.example.com`). */
export function certificateCoversHost(host: string, names: readonly string[]): boolean {
  const wanted = normalizeHostName(host);
  return names.some((raw) => {
    const name = normalizeHostName(raw);
    if (name === wanted) return true;
    if (!name.startsWith("*.")) return false;
    const suffix = name.slice(1);
    return wanted.endsWith(suffix) && !wanted.slice(0, -suffix.length).includes(".");
  });
}

/**
 * DNS A/AAAA records for `host`: Cloudflare edge addresses when proxied, the server otherwise.
 * When this computer finds none, a public resolver is asked once ({@link publicAddresses}): with
 * its addresses the check runs on them, says this computer still holds an older answer (a pass
 * becomes a warning with how to clear it), and `answers` gets them for the site and TLS checks.
 */
async function dnsCheck(
  host: string,
  ctx: VerifyCheckContext,
  answers: Map<string, PublicAddresses>,
): Promise<CheckResult> {
  const local = await dnsRecords(host, ctx);
  if (local !== "none") return local;
  const answer = await publicAddresses(host, ctx);
  const checked =
    answer === undefined
      ? "none"
      : await dnsRecords(host, { ...ctx, resolver: fixedResolver(answer) }, true);
  if (answer !== undefined && checked !== "none") {
    answers.set(normalizeHostName(host), answer);
    const message = `Through a public resolver, ${checked.message} ${CHECKED_PUBLICLY}`;
    return checked.status === "pass"
      ? { ...checked, status: "warn", message, remediation: FLUSH_DNS }
      : { ...checked, message };
  }
  const tunnel = tunnelMode(ctx.plan) || portainerWeb(ctx.plan) === "tunnel";
  return checkResult(
    host.startsWith("www.") ? "dns-records-www" : "dns-records",
    `DNS for ${host} points to the right place`,
    "high",
    "fail",
    `${host} has no A or AAAA record.`,
    {
      remediation:
        ctx.plan.target.provider === "portainer" && !tunnel
          ? `OpsCrew creates no DNS record for ${host} in this setup: create one that points it at your Portainer host (an A record, and AAAA for IPv6, to its public address, or a CNAME to its dynamic-DNS name).`
          : "Run `opscrew dns` to create the records, and check that the domain's nameservers point to Cloudflare.",
      target: host,
    },
  );
}

/**
 * The DNS check's result, or `none` when this computer's resolver finds no A or AAAA record.
 * `quiet`: the messages name no address (for the public resolver's answer).
 */
async function dnsRecords(
  host: string,
  ctx: VerifyCheckContext,
  quiet = false,
): Promise<CheckResult | "none"> {
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
  if (a.length === 0 && aaaa.length === 0) return "none";
  const addresses = [...a, ...aaaa];
  // The addresses in a message (none for the public resolver's answer).
  const shown = (list: readonly string[]) => (quiet ? "" : ` (${list.join(", ")})`);
  if (portainer && !tunnel && !plan.dns.proxied) {
    // The host's public address is the user's (often a home connection): never printed.
    return checkResult(
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
        (ipv4 !== undefined && sameIp(address, ipv4)) ||
        (ipv6 !== undefined && sameIp(address, ipv6)),
    );
    if (exposed.length > 0) {
      return checkResult(
        id,
        title,
        "high",
        "fail",
        own
          ? `${host} resolves to your server itself, so Cloudflare's proxy is bypassed and your server's address is public.`
          : `${host} resolves to the server itself${shown(exposed)}, so Cloudflare's proxy is bypassed and the server's IP is public.`,
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
        return checkResult(
          id,
          title,
          "high",
          "fail",
          own || quiet
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
    return checkResult(
      id,
      title,
      "high",
      "pass",
      tunnel
        ? `${host} resolves to Cloudflare${shown(addresses)}; the app is served through the Cloudflare Tunnel.`
        : portainer
          ? `${host} resolves to Cloudflare${shown(addresses)}; your Portainer host's address stays hidden.`
          : own
            ? `${host} resolves to Cloudflare${shown(addresses)}; your server's address stays hidden.`
            : `${host} resolves to Cloudflare${shown(addresses)}; the server's IP stays hidden.`,
      { target: host },
    );
  }
  if (ipv4 === undefined) {
    // A fresh clone: the address lives in the `.opscrew/` folder of the computer that provisioned
    // the server, so the records cannot be compared here (and `opscrew dns` would not help).
    return checkResult(
      id,
      title,
      "high",
      "warn",
      own
        ? `${host} has DNS records, but OpsCrew does not know your server's address on this computer, so it cannot tell whether they point to your server.`
        : `${host} ${quiet ? "has DNS records" : `resolves to ${addresses.join(", ")}`}, but OpsCrew does not know the server's address on this computer, so it cannot tell whether that is the server.`,
      { remediation: UNKNOWN_ADDRESS_REMEDIATION, target: host },
    );
  }
  const wrong = [
    ...a.filter((address) => !sameIp(address, ipv4)),
    ...aaaa.filter((address) => ipv6 === undefined || !sameIp(address, ipv6)),
  ];
  if (wrong.length > 0 || a.length === 0) {
    const expected = [ipv4, ipv6].filter((x): x is string => x !== undefined).join(" / ");
    return checkResult(
      id,
      title,
      "high",
      "fail",
      own
        ? wrong.length > 0
          ? `${host} resolves not only to your server's address: ${wrong.length} record${wrong.length === 1 ? " points" : "s point"} somewhere else.`
          : `${host} has no A record for your server's IPv4 address.`
        : quiet
          ? `${host} resolves to an address that is not the server's.`
          : `${host} resolves to ${addresses.join(", ")} but the server is ${expected}.`,
      {
        remediation:
          "Run `opscrew dns` to point the records at the server (DNS changes can take a few minutes).",
        target: host,
      },
    );
  }
  return checkResult(
    id,
    title,
    "high",
    "pass",
    own
      ? `${host} resolves to your server's address.`
      : `${host} resolves to the server${shown(addresses)}.`,
    {
      target: host,
    },
  );
}

/** GET `target`, following redirects or not, within the check's timeout (default 10 s). */
function get(
  ctx: Pick<VerifyCheckContext, "fetch" | "timeoutMs">,
  target: string,
  redirect: "follow" | "manual",
): Promise<Response> {
  return ctx.fetch(target, {
    method: "GET",
    redirect,
    signal: AbortSignal.timeout(ctx.timeoutMs ?? 10_000),
  });
}

/**
 * GET `/` answers with a status below 500. Returns the response headers for the header check, or
 * the error when the site could not be reached.
 */
async function siteReachable(
  url: string,
  ctx: VerifyCheckContext,
): Promise<{ check: CheckResult; headers?: Headers; error?: unknown }> {
  const title = "The site answers";
  const target = `${url}/`;
  try {
    const response = await get(ctx, target, "follow");
    await discard(response);
    if (response.status >= 500) {
      return {
        check: checkResult(
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
      check: checkResult(
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
      check: checkResult(
        "site-reachable",
        title,
        "high",
        "fail",
        `Could not reach ${target}: ${errorText(error)}.`,
        {
          remediation: `Check that the latest deploy run succeeded and ${serverRunningHint(ctx.plan)}.`,
          target,
        },
      ),
      error,
    };
  }
}

/**
 * The certificate covers the host, is valid for at least {@link MIN_CERT_DAYS} days, and names its
 * issuer. The certificate of a DNS-only hostname, which the server's proxy gets, is warned about
 * below 30 days, with what to do and certbot's reason (`renewalFailure`).
 */
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
    return checkResult(
      id,
      title,
      "high",
      "fail",
      `Could not open an HTTPS connection to ${host}: ${errorText(error)}.`,
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
    return checkResult(
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
    return checkResult(
      id,
      title,
      "high",
      "fail",
      `The certificate's validity dates cannot be read.`,
      {
        target: host,
      },
    );
  }
  // A DNS-only hostname's certificate is the server's proxy's own (FR-1406, FR-1445).
  const managed = proxyCertificateHosts(ctx.plan).includes(host);
  const renewal = async () => proxyRenewalAdvice(ctx.plan, await ctx.renewalFailure?.());
  if (validTo <= now) {
    return checkResult(
      id,
      title,
      "critical",
      "fail",
      `The certificate expired on ${day(cert.validTo)} (issued by ${cert.issuer}); browsers refuse the site.`,
      {
        remediation: managed
          ? await renewal()
          : "Check Caddy's logs (`docker compose logs caddy`) for renewal errors; renewal needs port 80 or 443 reachable from the internet.",
        target: host,
      },
    );
  }
  if (validFrom > now) {
    return checkResult(
      id,
      title,
      "high",
      "fail",
      `The certificate is not valid until ${day(cert.validFrom)}; check the server's clock.`,
      { target: host },
    );
  }
  const days = daysLeft(cert.validTo, ctx.now);
  if (days < MIN_CERT_DAYS || (managed && days < CERTIFICATE_WARN_DAYS)) {
    return checkResult(
      id,
      title,
      "medium",
      days < MIN_CERT_DAYS ? "fail" : "warn",
      `The certificate expires on ${day(cert.validTo)} (${days} days left) and has not been renewed (issued by ${cert.issuer}).`,
      {
        remediation: managed
          ? await renewal()
          : "Caddy renews 30 days ahead, so renewal is failing: check `docker compose logs caddy` on the server.",
        target: host,
      },
    );
  }
  return checkResult(
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
    const response = await get(ctx, target, "manual");
    await discard(response);
    const location = response.headers.get("location") ?? "";
    if (response.status >= 300 && response.status < 400 && location.startsWith("https://")) {
      return checkResult(id, title, "medium", "pass", `${target} redirects to ${location}.`, {
        target,
      });
    }
    return checkResult(
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
    return checkResult(
      id,
      title,
      "medium",
      "fail",
      `Could not reach ${target}: ${errorText(error)}.`,
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
    const response = await get(ctx, target, "follow");
    await discard(response);
    return response.status === 200
      ? checkResult(id, title, "high", "pass", `${target} answered 200.`, { target })
      : checkResult(id, title, "high", "fail", `${target} answered with HTTP ${response.status}.`, {
          remediation,
          target,
        });
  } catch (error) {
    return checkResult(
      id,
      title,
      "high",
      "fail",
      `Could not reach ${target}: ${errorText(error)}.`,
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
    return checkResult(id, title, "medium", "skip", "Skipped because the site did not answer.", {
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
    return checkResult(id, title, "medium", "pass", "All expected security headers are present.", {
      target,
    });
  }
  return checkResult(
    id,
    title,
    "medium",
    "fail",
    `Missing or weak headers: ${missing.join(", ")}.`,
    {
      remediation:
        "Restore the `header` block in opscrew/runtime/Caddyfile (re-run `opscrew provision` to regenerate it) and redeploy.",
      target,
    },
  );
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
    const response = await get(ctx, target, "manual");
    if (response.status !== 200) {
      await discard(response);
      return checkResult(
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
      return checkResult(
        id,
        title,
        "critical",
        "pass",
        `${target} answered 200 with a page that is not the file (an app fallback page).`,
        { target },
      );
    }
    return checkResult(
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
    return checkResult(
      id,
      title,
      "critical",
      "warn",
      `Could not request ${target}: ${errorText(error)}.`,
      { target },
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
  // `undefined`: this computer cannot try the IPv6 address.
  const open6 =
    ipv6 === undefined
      ? false
      : await ipv6HttpsAnswers(ipv6, ctx.tcpConnect, timeout, ctx.ipv6Route);
  if (open4 || open6 === true) {
    const where =
      open4 && open6 ? "IPv4 and IPv6 addresses" : open4 ? "IPv4 address" : "IPv6 address";
    return checkResult(
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
      : open6 === undefined
        ? ". OpsCrew could not try its IPv6 address: this computer has no IPv6 route; run `opscrew verify` from a network with IPv6 to check it too"
        : " (IPv4 and IPv6)";
  return checkResult(
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
    return checkResult(
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
    return checkResult(
      id,
      title,
      "medium",
      "skip",
      "Skipped: the app is served through a Cloudflare Tunnel, so the server opens no web port that could be reached around Cloudflare (`opscrew secure` checks that from outside).",
    );
  }
  if (plan.dns.provider !== "cloudflare" || !plan.dns.proxied) {
    return checkResult(
      id,
      title,
      "medium",
      "skip",
      "Skipped: the site is not behind Cloudflare's proxy.",
    );
  }
  if (plan.security.httpAllowedFrom !== "cloudflare") {
    return checkResult(
      id,
      title,
      "medium",
      "skip",
      'Skipped: the firewall is configured to accept web traffic from anywhere (security.httpAllowedFrom is "any").',
    );
  }
  if (!ip) {
    return checkResult(
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
    ? checkResult(
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
    : checkResult(id, title, "medium", "pass", `Port 443 on ${ip} is closed to direct visitors.`, {
        target: ip,
      });
}

/** The latest run of the deploy workflow on the deploy branch succeeded. */
export async function checkDeployRun(ctx: VerifyCheckContext): Promise<{
  check: CheckResult;
  latestDeployAt?: string;
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
      check: checkResult(id, title, "high", "warn", `Could not read the deploy runs: ${reason}.`, {
        remediation: "Check the latest run in GitHub → Actions yourself.",
      }),
    };
  }
  const latest = runs[0];
  if (latest === undefined) {
    return {
      check: checkResult(id, title, "high", "fail", `${workflow} has not run on ${branch} yet.`, {
        remediation: `Merge the OpsCrew pull request into ${branch} (or push to it) to start the first deploy.`,
      }),
    };
  }
  if (latest.status !== "completed") {
    return {
      check: checkResult(
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
      check: checkResult(
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
    check: checkResult(
      id,
      title,
      "high",
      "pass",
      `The latest deploy succeeded: ${latest.htmlUrl}`,
      {
        target: latest.htmlUrl,
      },
    ),
    ...(Number.isNaN(at.getTime()) ? {} : { latestDeployAt: at.toISOString() }),
  };
}

/** Result of {@link runVerifyChecks}. */
export interface VerifyChecksOutcome {
  checks: CheckResult[];
  /** When the latest deploy run succeeded, the time it started. */
  latestDeployAt?: string;
}

/**
 * The user's Portainer behind their own reverse proxy: OpsCrew creates no DNS record for the
 * domain (it prints the one the user creates) and the proxy manages its certificate and redirect,
 * so a failed domain check is a warning that says so. Other targets and modes are unchanged.
 */
function userDomain(check: CheckResult, host: string, plan: DeployPlan): CheckResult {
  if (portainerWeb(plan) !== "proxy" || check.status !== "fail") return check;
  return {
    ...check,
    status: "warn",
    message: `${check.message} Behind your own reverse proxy the DNS record and the certificate for ${host} are yours, so this is a warning.`,
    remediation: `The record and the certificate are yours: create the record OpsCrew printed and route ${host} in your proxy (it serves HTTPS and redirects HTTP), then run \`opscrew verify\` again.`,
  };
}

/**
 * Runs every verify check from plan.md in report order. Without a domain the DNS and TLS checks
 * warn (the site is served over plain HTTP on the server IP) instead of failing. A host this
 * computer cannot resolve is looked up once through the public resolver; with its addresses, every
 * check of that host connects through them (see {@link dnsCheck}).
 */
export async function runVerifyChecks(base: VerifyCheckContext): Promise<VerifyChecksOutcome> {
  const { plan } = base;
  // Hosts this computer cannot find, with the public resolver's addresses to check them through.
  const answers = new Map<string, PublicAddresses>();
  const hosts = verifyHosts(plan);
  const url = base.url ?? siteUrl(plan, base.server);
  const checks: CheckResult[] = [];
  const [domain] = hosts;
  // The user's Portainer behind their own reverse proxy, without a domain: their route is checked,
  // and its DNS and certificate are the proxy's.
  const userRoute = domain === undefined && plan.target.provider === "portainer";

  if (userRoute) {
    checks.push(
      checkResult(
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
      checkResult(
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
      checks.push(userDomain(await dnsCheck(host, base, answers), host, plan));
    }
  }

  if (url === undefined) {
    throw new Error("runVerifyChecks needs a domain or the server's address.");
  }
  const urlHost = normalizeHostName(new URL(url).hostname);
  let site: Awaited<ReturnType<typeof siteReachable>> | undefined;
  if (userRoute && isIP(urlHost.replace(/^\[|\]$/g, "")) === 0) {
    // The user's route has no DNS check: only when this computer cannot find its host (the
    // request fails with ENOTFOUND) is the public resolver asked, and the route checked again
    // through its answer. A name only this computer knows (a hosts file, mDNS) is never sent.
    site = await siteReachable(url, base);
    const answer = isNotFound(site.error) ? await publicAddresses(urlHost, base) : undefined;
    if (answer !== undefined && checks[0] !== undefined) {
      answers.set(urlHost, answer);
      site = undefined;
      checks[0] = {
        ...checks[0],
        message: `${checks[0].message} ${CHECKED_PUBLICLY} ${FLUSH_DNS}`,
      };
    }
  }
  // The site checks: hosts this computer still holds an older answer for are reached through the
  // public answer; only their address lookup changes.
  const ctx = throughPublicAnswers(base, answers);
  site ??= await siteReachable(url, ctx);
  checks.push(site.check);

  if (userRoute) {
    const route = new URL(url);
    if (route.protocol === "https:") {
      checks.push(await checkTls(route.hostname, ctx, Number(route.port || 443)));
      checks.push(
        route.port === ""
          ? await checkHttpRedirect(route.hostname, ctx)
          : checkResult(
              "http-redirect",
              "HTTP redirects to HTTPS",
              "medium",
              "skip",
              "Skipped: the route uses a port of its own, so there is no plain-HTTP address to try.",
            ),
      );
    } else {
      checks.push(
        checkResult(
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
        checkResult(
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
      checkResult(
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
      checkResult(
        "http-redirect",
        "HTTP redirects to HTTPS",
        "medium",
        "skip",
        "Skipped: no domain, so no HTTPS.",
      ),
    );
  } else {
    checks.push(userDomain(await checkTls(domain, ctx), domain, plan));
    checks.push(userDomain(await checkHttpRedirect(domain, ctx), domain, plan));
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
    ...(deploy.latestDeployAt !== undefined ? { latestDeployAt: deploy.latestDeployAt } : {}),
  };
}
