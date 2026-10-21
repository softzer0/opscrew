/**
 * The TLS of the app's site as the server's own proxy serves it, checked from the server itself
 * over SSH as `deploy` with `openssl s_client` to 127.0.0.1:443 (feature 014, FR-1423): hostnames
 * behind Cloudflare's proxy refuse connections without Cloudflare's client certificate and serve
 * the app's Cloudflare origin certificate, a hostname no site serves is refused, and the
 * certificates of DNS-only hostnames are renewed in time. Also certbot's last renewal failure.
 */
import { X509Certificate } from "node:crypto";
import type { CheckResult, CommandResult } from "@opscrew/contracts";
import type { HostCheck } from "./checks";
import { result } from "./services";

/** Days before its expiry a certificate OpsCrew manages is warned about (FR-1406, FR-1445). */
export const CERTIFICATE_WARN_DAYS = 30;

const DAY_MS = 86_400_000;

/** A hostname no site serves, for the check that the proxy refuses unknown hostnames. */
const UNKNOWN_HOSTNAME = "unknown.opscrew.invalid";

/** The issuer of Cloudflare's origin certificates (ECC and RSA). */
const ORIGIN_CA = /CloudFlare Origin SSL/i;

/** What `openssl s_client` saw on the server's proxy. */
export interface ServerHandshake {
  /** The TCP connection to 127.0.0.1:443 was made. */
  connected: boolean;
  /** The certificate the proxy served, when it served one. */
  certificate?: { issuer: string; validTo: string };
  /** The HTTP status of the answer to OpsCrew's request, when one came. */
  status?: number;
  /** nginx's answer to a request without the client certificate it requires. */
  clientCertificateMissing: boolean;
  /** Caddy's refusal: the TLS alert `certificate required` (116) after the handshake. */
  certificateRequired: boolean;
}

/** Whole days from `now` until the ISO time `iso` (negative once it is past). */
export function daysLeft(iso: string, now: Date): number {
  return Math.floor((Date.parse(iso) - now.getTime()) / DAY_MS);
}

/**
 * `openssl s_client` from the server to its own proxy on 127.0.0.1:443 with the SNI `hostname`,
 * over TLS 1.3, without a client certificate; with `request`, it sends `GET /` and waits for the
 * answer (nginx completes the handshake and answers 400 without the client certificate, Caddy
 * ends the connection). Hostnames come from the plan's schema, which allows no quote.
 */
export function serverHandshakeCommand(hostname: string, request: boolean): string {
  const client = `timeout 15 openssl s_client -connect 127.0.0.1:443 -servername '${hostname}' -tls1_3`;
  return request
    ? `printf 'GET / HTTP/1.1\\r\\nHost: %s\\r\\nConnection: close\\r\\n\\r\\n' '${hostname}' | ${client} -ign_eof 2>&1`
    : `${client} </dev/null 2>&1`;
}

/** The issuer's fields on one line: `O=CloudFlare, Inc., OU=…, CN=…`. */
function oneLine(name: string): string {
  return name.split(/\r?\n/).filter(Boolean).join(", ");
}

/** What {@link serverHandshakeCommand} printed. */
export function parseServerHandshake(stdout: string): ServerHandshake {
  const pem = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/.exec(stdout)?.[0];
  let certificate: ServerHandshake["certificate"];
  if (pem !== undefined) {
    try {
      const x509 = new X509Certificate(pem);
      certificate = {
        issuer: oneLine(x509.issuer),
        validTo: new Date(x509.validTo).toISOString(),
      };
    } catch {
      certificate = undefined;
    }
  }
  const status = /^HTTP\/\d(?:\.\d)? (\d{3})\b/m.exec(stdout)?.[1];
  return {
    connected: /^CONNECTED\(/m.test(stdout),
    ...(certificate !== undefined ? { certificate } : {}),
    ...(status !== undefined ? { status: Number(status) } : {}),
    clientCertificateMissing: /No required SSL certificate was sent/.test(stdout),
    certificateRequired: /alert certificate required|SSL alert number 116/.test(stdout),
  };
}

const AGAIN = "then run `opscrew secure` again.";

/**
 * The warning when the handshake could not be checked: openssl missing on the server, a timeout,
 * or no connection to the proxy; `undefined` when it was made.
 */
function notChecked(
  check: Pick<HostCheck, "id" | "title" | "severity">,
  output: CommandResult,
  seen: ServerHandshake,
): CheckResult | undefined {
  if (output.exitCode === 127) {
    return result(
      check,
      "warn",
      "openssl is not installed on the server, so OpsCrew could not check the proxy's TLS from there.",
      `Install it as root (\`apt install openssl\`), ${AGAIN}`,
    );
  }
  if (output.exitCode === 124) {
    return result(
      check,
      "warn",
      "The TLS check from the server timed out.",
      `Try again later; ${AGAIN}`,
    );
  }
  if (!seen.connected) {
    return result(
      check,
      "warn",
      "OpsCrew could not connect to the server's proxy on 127.0.0.1:443.",
      `Check that the proxy runs on the server (\`docker ps\` shows the opscrew-edge containers), ${AGAIN}`,
    );
  }
  return undefined;
}

const REDEPLOY =
  "Run `opscrew provision` and let its deploy finish: it brings the server the app's site with the client-certificate requirement and its origin certificate.";

/**
 * The checks of origin TLS from the server (FR-1402, FR-1404, FR-1423): for each of `hostnames`
 * (the app's hostnames the origin requires Cloudflare's client certificate for), a connection
 * without one is refused (Caddy ends the handshake; nginx completes it and answers HTTP 400, which
 * counts as refused too; anything else warns) and the certificate served is from Cloudflare's
 * Origin CA; and a hostname no site serves is refused. None without hostnames.
 */
export function originHostChecks(hostnames: readonly string[]): HostCheck[] {
  if (hostnames.length === 0) return [];
  const perHost = hostnames.map(
    (hostname): HostCheck => ({
      id: `origin-tls-${hostname}`,
      title: `${hostname} accepts only Cloudflare on the server (client certificate required, origin certificate served)`,
      severity: "high",
      command: serverHandshakeCommand(hostname, true),
      evaluate(output) {
        const seen = parseServerHandshake(output.stdout);
        const unchecked = notChecked(this, output, seen);
        if (unchecked !== undefined) return unchecked;
        if (seen.status !== undefined && !(seen.status === 400 && seen.clientCertificateMissing)) {
          return result(
            this,
            "fail",
            `${hostname} answers on the server without Cloudflare's client certificate (HTTP ${seen.status}), so a request that reaches the server around Cloudflare gets the app.`,
            REDEPLOY,
          );
        }
        if (seen.certificate === undefined) {
          return result(
            this,
            "fail",
            `The server's proxy served no certificate for ${hostname}, so Cloudflare cannot connect to it.`,
            REDEPLOY,
          );
        }
        if (!ORIGIN_CA.test(seen.certificate.issuer)) {
          return result(
            this,
            "fail",
            `${hostname} is served with a certificate from ${seen.certificate.issuer}, not with the app's Cloudflare origin certificate.`,
            REDEPLOY,
            "medium",
          );
        }
        // Refused only on proof: Caddy's alert, or nginx's 400 for the missing certificate.
        const refused =
          seen.certificateRequired || (seen.status === 400 && seen.clientCertificateMissing);
        if (!refused) {
          return result(
            this,
            "warn",
            `The connection to ${hostname} on the server ended without showing that the proxy requires Cloudflare's client certificate (no refusal and no answer came).`,
            `Check that the proxy runs on the server, ${AGAIN}`,
          );
        }
        return result(
          this,
          "pass",
          `${hostname} refuses connections without Cloudflare's client certificate and serves the app's Cloudflare origin certificate.`,
        );
      },
    }),
  );
  const unknown: HostCheck = {
    id: "origin-unknown-hostname",
    title: "The server's proxy refuses hostnames it does not serve",
    severity: "medium",
    command: serverHandshakeCommand(UNKNOWN_HOSTNAME, false),
    evaluate(output) {
      const seen = parseServerHandshake(output.stdout);
      const unchecked = notChecked(this, output, seen);
      if (unchecked !== undefined) return unchecked;
      return seen.certificate === undefined && seen.status === undefined
        ? result(
            this,
            "pass",
            "The server's proxy refuses a TLS connection for a hostname no site on it serves.",
          )
        : result(
            this,
            "fail",
            `The server's proxy accepts a TLS connection for ${UNKNOWN_HOSTNAME}, a hostname no site on it serves.`,
            "Run `opscrew provision` and let its deploy finish: it puts back the edge's catch-all, which refuses them.",
          );
    },
  };
  return [...perHost, unknown];
}

/**
 * The checks that the certificates the server's proxy gets for `hostnames` (DNS only) are renewed
 * in time (FR-1406, FR-1445): a warning with fewer than {@link CERTIFICATE_WARN_DAYS} days left,
 * with `renewal` (what to do, and certbot's reason; see {@link renewalAdvice}), and a failure once
 * expired. `now` is the time of the check.
 */
export function certificateHostChecks(
  hostnames: readonly string[],
  options: { now: Date; renewal: string },
): HostCheck[] {
  return hostnames.map(
    (hostname): HostCheck => ({
      id: `certificate-${hostname}`,
      title: `The HTTPS certificate of ${hostname} is renewed in time`,
      severity: "medium",
      command: serverHandshakeCommand(hostname, false),
      evaluate(output) {
        const seen = parseServerHandshake(output.stdout);
        const unchecked = notChecked(this, output, seen);
        if (unchecked !== undefined) return unchecked;
        if (seen.certificate === undefined) {
          return result(
            this,
            "warn",
            `The server's proxy served no certificate for ${hostname}: it has none yet.`,
            options.renewal,
          );
        }
        const { issuer, validTo } = seen.certificate;
        const days = daysLeft(validTo, options.now);
        const until = validTo.slice(0, 10);
        if (days < 0) {
          return result(
            this,
            "fail",
            `The certificate of ${hostname} expired on ${until} (issued by ${issuer}); browsers refuse the site.`,
            options.renewal,
            "critical",
          );
        }
        if (days < CERTIFICATE_WARN_DAYS) {
          return result(
            this,
            "warn",
            `The certificate of ${hostname} expires on ${until} (${days} days left) and has not been renewed (issued by ${issuer}).`,
            options.renewal,
          );
        }
        return result(
          this,
          "pass",
          `The certificate of ${hostname} is valid until ${until} (${days} days left), issued by ${issuer}.`,
        );
      },
    }),
  );
}

/**
 * What to do about a certificate of the server's proxy that is not renewed in time: Caddy renews
 * 30 days ahead, certbot (nginx) 45 days ahead, so either is failing. `failure` is certbot's
 * reason from its last run ({@link parseCertbotFailure}). `where` is the edge's Compose project on
 * a server, or the app's stack in the user's Portainer (whose Caddy is in the stack).
 */
export function renewalAdvice(
  proxy: "caddy" | "nginx",
  where: { project: string } | { portainerStack: string },
  failure?: string,
): string {
  if ("portainerStack" in where) {
    return `Caddy renews certificates 30 days before they expire, so its renewal is failing: read why in the logs of the caddy container of the stack ${where.portainerStack} in your Portainer, and check that the hostname's DNS record points to your Portainer host and that ports 80 and 443 reach it.`;
  }
  const { project } = where;
  if (proxy === "caddy") {
    return `Caddy renews certificates 30 days before they expire, so its renewal is failing: read why with \`docker compose -p ${project} logs caddy\` on the server, and check that the hostname's DNS record points to the server and that ports 80 and 443 reach it.`;
  }
  const reason =
    failure === undefined
      ? `read why with \`docker compose -p ${project} logs certbot\` on the server`
      : `certbot's last renewal said: ${failure.replace(/\.$/, "")}`;
  return `certbot renews certificates 45 days before they expire, so its renewal is failing: ${reason}. Check that the hostname's DNS record points to the server and that port 80 reaches it; certbot tries again every 12 hours.`;
}

/**
 * The read-only command that prints certbot's last line about the app's certificate in its
 * container's log (`project`'s `certbot` service): `Processing …/renewal/<app>.conf` when a run
 * began, `Failed to renew certificate <app> with error: …` when it failed. Prints nothing without
 * certbot.
 */
export function certbotFailureCommand(project: string, app: string): string {
  return [
    `id=$(docker ps -q --filter label=com.docker.compose.project=${project} --filter label=com.docker.compose.service=certbot | head -n 1)`,
    `if [ -n "$id" ]; then docker logs --tail 500 "$id" 2>&1 | grep -E '^(Processing .*/renewal/${app}\\.conf|Failed to renew certificate ${app} with error: )' | tail -n 1; fi`,
  ].join("; ");
}

/**
 * certbot's reason when its last run for `app` failed to renew the certificate, from
 * {@link certbotFailureCommand}'s output; `undefined` when it did not fail (or never ran).
 */
export function parseCertbotFailure(stdout: string, app: string): string | undefined {
  const prefix = `Failed to renew certificate ${app} with error: `;
  const last = stdout.trim().split(/\r?\n/).at(-1)?.trim() ?? "";
  if (!last.startsWith(prefix)) return undefined;
  const reason = last.slice(prefix.length).trim();
  return reason.length > 300 ? `${reason.slice(0, 300)}…` : reason;
}
