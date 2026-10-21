/**
 * The certificates OpsCrew manages for the app, the server's proxy and the secrets copy, for
 * `status` (FR-1462), and the expiry warnings `status`, `verify` and `secure` share (FR-1406,
 * FR-1445): the origin and client certificates from the app's Cloudflare record, and the
 * certificates the server's proxy gets for DNS-only hostnames, with certbot's reason when its last
 * renewal failed (read from the server).
 */
import type { SharedRecord } from "@opscrew/connector-cloudflare";
import type { CheckResult, Clock, RemoteExec } from "@opscrew/contracts";
import { errorText, isUserFacingError, listText, plural } from "@opscrew/core";
import {
  EDGE_PROJECT,
  EDGE_PROXIES,
  edgeProxy,
  portainerStackName,
  siteHosts,
  tunnelMode,
} from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import {
  CERTIFICATE_WARN_DAYS,
  certbotFailureCommand,
  daysLeft,
  formatUtc,
  parseCertbotFailure,
  renewalAdvice,
} from "@opscrew/secops";
import type { PhaseDeps } from "../context";
import { clientCertificateWarning, deployLogin } from "../provision/origin-tls";
import { readCloudflareRecord } from "../provision/shared-cloudflare";
import type { ProvisionServices } from "../provision/types";
import { recoveryStatus } from "../secrets";
import { checkResult, SshRemoteExec } from "../shared";
import { defaultTlsConnect, type TlsConnect } from "../verify/net";

/**
 * The app's hostnames whose certificate the proxy OpsCrew runs gets itself (ACME): DNS-only ones,
 * on a server or in OpsCrew's Caddy in a Portainer stack. None behind Cloudflare's proxy or a
 * tunnel (Cloudflare's edge serves those), nor behind the user's own proxy.
 */
export function proxyCertificateHosts(plan: DeployPlan): string[] {
  if (plan.dns.proxied || tunnelMode(plan)) return [];
  if (plan.target.provider === "portainer" && plan.target.web.mode !== "caddy") return [];
  return siteHosts(plan);
}

/**
 * What to do about a certificate of the app's proxy that is not renewed in time: on a server, the
 * shared edge's logs; in the user's Portainer, the Caddy of the app's stack.
 */
export function proxyRenewalAdvice(plan: DeployPlan, failure: string | undefined): string {
  return renewalAdvice(
    edgeProxy(plan),
    plan.target.provider === "portainer"
      ? { portainerStack: portainerStackName(plan) }
      : { project: EDGE_PROJECT },
    failure,
  );
}

/**
 * The warnings about the certificates in the app's Cloudflare record with fewer than 30 days left
 * (FR-1406): the origin certificate, which the next provision replaces, and the client
 * certificate, which OpsCrew never replaces by itself (`clientCertificateWarning`, with the steps).
 */
export function recordCertificateWarnings(
  record: Pick<SharedRecord, "tls"> | undefined,
  clock: Clock,
): string[] {
  const origin = record?.tls?.origin;
  const warnings: string[] = [];
  if (origin !== undefined && daysLeft(origin.expiresAt, clock.now()) < CERTIFICATE_WARN_DAYS) {
    warnings.push(
      `The app's Cloudflare origin certificate for ${listText(origin.hostnames)} expires on ${origin.expiresAt.slice(0, 10)}. Run \`opscrew provision\`: it replaces the certificate, and the deploy brings the server the new one.`,
    );
  }
  const client = clientCertificateWarning(record, clock);
  if (client !== undefined) warnings.push(client);
  return warnings;
}

/** The id and title of the check of the record's certificates ({@link recordCertificateCheck}). */
export const RECORD_CERTIFICATES = {
  id: "origin-tls-certificates",
  title: "The app's Cloudflare origin and client certificates are valid for 30 days or more",
} as const;

/**
 * The check of the app's Cloudflare origin and client certificates from its record, for `verify`
 * and `secure` (FR-1406): a warning with fewer than 30 days left on either
 * ({@link recordCertificateWarnings}); none when the app has no origin TLS.
 */
export function recordCertificateCheck(
  record: Pick<SharedRecord, "tls"> | undefined,
  clock: Clock,
): CheckResult[] {
  const { origin, client } = record?.tls ?? {};
  if (origin === undefined && client === undefined) return [];
  const warnings = recordCertificateWarnings(record, clock);
  const until = (what: string, at: string) => `the ${what} certificate until ${at.slice(0, 10)}`;
  const valid = [
    ...(origin !== undefined ? [until("origin", origin.expiresAt)] : []),
    ...(client !== undefined ? [until("client", client.expiresAt)] : []),
  ];
  return [
    checkResult(
      RECORD_CERTIFICATES.id,
      RECORD_CERTIFICATES.title,
      "medium",
      warnings.length > 0 ? "warn" : "pass",
      warnings.length > 0 ? warnings.join(" ") : `Valid: ${listText(valid)}.`,
    ),
  ];
}

/**
 * A shell on the app's server as `deploy` (the project's deploy key, the pinned host key), where
 * the deploy logs in (`deployLogin`). `undefined` in the user's Portainer, behind a tunnel, or when
 * this computer knows no address or has no deploy key.
 */
export async function deployShell(
  deps: Pick<PhaseDeps, "paths" | "runner">,
  plan: DeployPlan,
  services: Pick<ProvisionServices, "remote"> = {},
): Promise<RemoteExec | undefined> {
  if (plan.target.provider === "portainer") return undefined;
  const login = await deployLogin(deps, plan);
  if (login === undefined) return undefined;
  return (
    services.remote?.(login.host) ??
    new SshRemoteExec({
      host: login.host,
      port: login.port,
      keyFile: deps.paths.files.deployKey,
      knownHostsFile: deps.paths.files.knownHosts,
      runner: deps.runner,
    })
  );
}

/**
 * certbot's reason when its last renewal of the app's certificate failed, read from its log on the
 * server over `remote` (read-only, audited without the address); `undefined` on Caddy, when it did
 * not fail, or when it could not be read.
 */
export async function readRenewalFailure(
  deps: Pick<PhaseDeps, "audit" | "redactor">,
  plan: DeployPlan,
  remote: RemoteExec | undefined,
): Promise<string | undefined> {
  if (remote === undefined || edgeProxy(plan) !== "nginx") return undefined;
  let failure: string | undefined;
  try {
    const result = await remote.run(certbotFailureCommand(EDGE_PROJECT, plan.app.name), {
      timeoutMs: 30_000,
    });
    failure = result.exitCode === 0 ? parseCertbotFailure(result.stdout, plan.app.name) : undefined;
  } catch {
    failure = undefined;
  }
  await deps.audit.append({
    kind: "remote-exec",
    actor: "opscrew",
    action: "read certbot's last renewal (read-only)",
    target: "server",
    decision: "allow",
  });
  return failure === undefined ? undefined : deps.redactor.redact(failure);
}

/** Options of {@link tlsStatusReport}. */
export interface TlsStatusOptions {
  /** Reads the certificate a DNS-only hostname presents (default: `node:tls`). */
  tlsConnect?: TlsConnect;
  /** The deploy user's shell on the server (tests), for certbot's last renewal. */
  services?: Pick<ProvisionServices, "remote">;
}

/**
 * What `status` shows of the app's TLS and secrets copy (FR-1462): the server's proxy, each
 * certificate OpsCrew manages with its expiry (the origin and client certificates from the
 * record; once the app was deployed, the certificates of DNS-only hostnames from a TLS handshake),
 * a warning for each with fewer than 30 days left (with certbot's reason on nginx), and the
 * secrets copy's last update, how many keys open it and whether it is behind. Redacted.
 */
export async function tlsStatusReport(
  deps: PhaseDeps,
  plan: DeployPlan,
  options: TlsStatusOptions = {},
): Promise<{ lines: string[] }> {
  const now = deps.clock.now();
  const record = await readCloudflareRecord(deps.paths).catch(() => undefined);
  const lines = [proxyLine(plan)];
  const certificates: string[] = [];
  const warnings = recordCertificateWarnings(record, deps.clock);
  const { origin, client } = record?.tls ?? {};
  if (origin !== undefined) {
    certificates.push(
      `  Cloudflare origin certificate (${origin.hostnames.join(", ")}): expires ${origin.expiresAt.slice(0, 10)}`,
    );
  }
  if (client !== undefined) {
    certificates.push(
      `  Client certificate for Cloudflare's origin pulls: expires ${client.expiresAt.slice(0, 10)}`,
    );
  }
  const hosts = plan.deployment.firstDeployAt === undefined ? [] : proxyCertificateHosts(plan);
  let renewing = false;
  for (const host of hosts) {
    try {
      const cert = await (options.tlsConnect ?? defaultTlsConnect)(host, { timeoutMs: 10_000 });
      const days = daysLeft(cert.validTo, now);
      certificates.push(
        `  ${host} (from ${cert.issuer}): expires ${cert.validTo.slice(0, 10)} (${plural(days, "day")} left)`,
      );
      if (days < CERTIFICATE_WARN_DAYS) {
        renewing = true;
        warnings.push(
          `The certificate of ${host} expires on ${cert.validTo.slice(0, 10)} and has not been renewed.`,
        );
      }
    } catch (error) {
      certificates.push(`  ${host}: could not be read (${errorText(error)})`);
    }
  }
  if (renewing) {
    const remote = await deployShell(deps, plan, options.services);
    warnings.push(proxyRenewalAdvice(plan, await readRenewalFailure(deps, plan, remote)));
  }
  if (certificates.length > 0) lines.push("Certificates:", ...certificates);
  lines.push(...warnings.map((warning) => `  Warning: ${warning}`));
  lines.push(...(await copyLines(deps)));
  return { lines: lines.map((line) => deps.redactor.redact(line)) };
}

/** The server's proxy, as the plan has it (provision keeps the server's the same). */
function proxyLine(plan: DeployPlan): string {
  if (plan.target.provider === "portainer") {
    const { mode } = plan.target.web;
    return mode === "caddy"
      ? "Proxy: Caddy, in the app's stack in your Portainer"
      : mode === "proxy"
        ? "Proxy: your own reverse proxy"
        : "Proxy: none (the app is served through a Cloudflare Tunnel)";
  }
  return `Proxy: ${EDGE_PROXIES[edgeProxy(plan)].label}`;
}

/** The secrets copy: when it was last updated, how many keys open it, and whether it is behind. */
async function copyLines(deps: PhaseDeps): Promise<string[]> {
  try {
    const copy = await recoveryStatus(deps);
    if (!copy.exists) {
      return ["Secrets copy: none yet (`opscrew provision` makes it)."];
    }
    const updated =
      copy.lastModified === undefined ? "" : `last updated ${formatUtc(copy.lastModified)}, `;
    return [
      `Secrets copy: ${updated}${plural(copy.recipients, "key")} can open it${copy.folder !== undefined ? `, also in ${copy.folder}` : ""}.`,
      ...(copy.behind
        ? [
            "  Warning: files on this computer changed since the copy in the repository was made; the next `opscrew provision` updates it.",
          ]
        : []),
    ];
  } catch (error) {
    if (!isUserFacingError(error)) throw error;
    return [`Secrets copy: unreadable. ${errorText(error)}`];
  }
}
