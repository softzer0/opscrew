import { createHash, X509Certificate } from "node:crypto";
import http from "node:http";
import { isIP } from "node:net";
import type { Duplex } from "node:stream";
import tls from "node:tls";
import { durationText, OpsCrewError } from "@opscrew/core";
import { normalizeCertFingerprint } from "./fingerprint";

/** How OpsCrew reaches Portainer: HTTPS with the certificate pinned, or plain HTTP to localhost. */
export interface PortainerEndpoint {
  /** Portainer's address as the user gave it (`https://nas.lan:9443`, `http://localhost:9000`). */
  url: string;
  /** The confirmed SHA-256 fingerprint of Portainer's certificate (required for `https://`). */
  certFingerprint?: string;
}

/** One HTTP request to Portainer. */
export interface PinnedRequestInit {
  method: "GET" | "POST" | "PUT" | "DELETE";
  /** Path and query below Portainer's address (`/api/…`), built only from constants and numbers. */
  path: string;
  headers: Readonly<Record<string, string>>;
  body?: string;
  timeoutMs: number;
}

/** Portainer's answer: the status and the body text (never logged). */
export interface PinnedResponse {
  status: number;
  body: string;
}

/** Sends one request to the pinned Portainer endpoint (tests inject a fake). */
export type PinnedRequest = (init: PinnedRequestInit) => Promise<PinnedResponse>;

/** `tls.connect`, injectable for tests. */
export type TlsConnect = (options: tls.ConnectionOptions) => tls.TLSSocket;

/** A validated endpoint. */
export interface PortainerTarget {
  protocol: "https:" | "http:";
  /** Host to connect to (IPv6 without brackets). */
  host: string;
  port: number;
  /** `Host` header value. */
  hostHeader: string;
  /** Path prefix Portainer is served under (`""` at the root). */
  basePath: string;
  /** SNI name, for host names only. */
  servername?: string;
  /** Canonical pinned fingerprint (HTTPS only). */
  pin?: string;
}

/** The certificate Portainer presented, as shown to the user on first use. */
export interface CertificateDetails {
  /** Canonical SHA-256 fingerprint (`SHA256:AB:CD:…`). */
  fingerprint: string;
  /** curl's `--pinnedpubkey` form of the certificate's public key (`sha256//<base64>`). */
  publicKeyPin: string;
}

/** Host names Portainer may be reached on over plain HTTP: this computer only. */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const CONNECT_TIMEOUT_MS = 15_000;
const CERT_HINT =
  "If you changed Portainer's certificate yourself, check the new fingerprint (for example with `openssl s_client -connect <host>:<port> </dev/null | openssl x509 -noout -fingerprint -sha256` on a computer you trust) and confirm it with `opscrew interview`; otherwise do not continue: someone may be intercepting the connection to Portainer.";

/**
 * Portainer answered with a certificate other than the pinned one. Nothing was sent. Both
 * fingerprints are named; the token and Portainer's address never are.
 */
export class PortainerCertificateError extends OpsCrewError {
  /** The pinned fingerprint (canonical). */
  readonly expected: string;
  /** The fingerprint Portainer presented (canonical). */
  readonly actual: string;

  constructor(expected: string, actual: string) {
    super(
      "PHASE_PRECONDITION",
      `Portainer's certificate has changed: OpsCrew pinned ${expected}, but Portainer now presents ${actual}. OpsCrew sent nothing and stopped.`,
      { hint: CERT_HINT },
    );
    this.name = "PortainerCertificateError";
    this.expected = expected;
    this.actual = actual;
  }
}

/**
 * Validates Portainer's address: `https://` with a pinned fingerprint, or `http://` only to this
 * computer; never a login, query string or fragment. Throws `INVALID_INPUT` with the next step.
 */
export function parsePortainerEndpoint(endpoint: PortainerEndpoint): PortainerTarget {
  const target = parseAddress(endpoint.url);
  if (target.protocol === "http:") return target;
  if (endpoint.certFingerprint === undefined) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      "Portainer's certificate has not been confirmed yet, so OpsCrew does not connect.",
      { hint: "Run `opscrew interview` to see the certificate's fingerprint and confirm it." },
    );
  }
  const pin = normalizeCertFingerprint(endpoint.certFingerprint);
  if (pin === undefined) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      "The pinned certificate fingerprint is not a SHA-256 fingerprint.",
      { hint: "Confirm Portainer's certificate again with `opscrew interview`." },
    );
  }
  return { ...target, pin };
}

/** Portainer's address without the pin rule (used to read the certificate on first use). */
function parseAddress(text: string): PortainerTarget {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new OpsCrewError("INVALID_INPUT", "Portainer's address is not a valid URL.", {
      hint: "Give Portainer's address as https://<host>:9443 (or http://localhost:9000 on this computer).",
    });
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new OpsCrewError("INVALID_INPUT", "Portainer's address must start with https://.", {
      hint: "Give Portainer's address as https://<host>:9443.",
    });
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new OpsCrewError(
      "INVALID_INPUT",
      "Portainer's address must not contain a login, a query string or a fragment.",
      {
        hint: "Give only Portainer's address (https://<host>:9443); the token comes from PORTAINER_API_KEY.",
      },
    );
  }
  const protocol = url.protocol;
  if (protocol === "http:" && !LOOPBACK.has(url.hostname)) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      "OpsCrew does not send Portainer's access token over plain HTTP, except to Portainer on this computer.",
      {
        hint: "Use Portainer's HTTPS address instead (by default port 9443: https://<host>:9443).",
      },
    );
  }
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
  const port = url.port === "" ? (protocol === "https:" ? 443 : 80) : Number(url.port);
  return {
    protocol,
    host,
    port,
    hostHeader: url.host,
    basePath: url.pathname.replace(/\/+$/, ""),
    ...(isIP(host) === 0 && { servername: host }),
  };
}

/**
 * Reads the SHA-256 fingerprint of Portainer's certificate without trusting it (first use; shown
 * to the user to confirm). Sends nothing but the TLS handshake.
 */
export async function fetchCertificateFingerprint(
  url: string,
  deps: { connect?: TlsConnect } = {},
): Promise<string> {
  return (await inspectCertificate(url, deps)).fingerprint;
}

/**
 * The fingerprint and public-key pin of the certificate Portainer presents, read without trusting
 * it. Compare `fingerprint` with the pinned one before using `publicKeyPin`.
 */
export async function inspectCertificate(
  url: string,
  deps: { connect?: TlsConnect } = {},
): Promise<CertificateDetails> {
  const target = parseAddress(url);
  if (target.protocol !== "https:") {
    throw new OpsCrewError(
      "INVALID_INPUT",
      "Only an https:// address has a certificate to confirm.",
      { hint: "Give Portainer's HTTPS address (https://<host>:9443)." },
    );
  }
  const probe = await probeCertificate(target, deps.connect ?? tls.connect);
  return { fingerprint: probe.fingerprint, publicKeyPin: probe.publicKeyPin };
}

/**
 * The request function for a Portainer endpoint. HTTPS: every connection is checked against the
 * pinned fingerprint (`ca` is the certificate seen on first contact, and `checkServerIdentity`
 * compares `fingerprint256`) and the HTTP request is handed the socket only after that check, so a
 * different certificate fails before anything is sent. HTTP: only to this computer.
 */
export function pinnedRequest(
  endpoint: PortainerEndpoint,
  deps: { connect?: TlsConnect } = {},
): PinnedRequest {
  const target = parsePortainerEndpoint(endpoint);
  const connect = deps.connect ?? tls.connect;
  const state: PinState = {};
  return (init) => send(target, connect, state, init);
}

interface PinState {
  /** PEM of the pinned certificate as Portainer presented it. */
  ca?: string;
}

interface Probe extends CertificateDetails {
  pem: string;
}

function send(
  target: PortainerTarget,
  connect: TlsConnect,
  state: PinState,
  init: PinnedRequestInit,
): Promise<PinnedResponse> {
  if (!init.path.startsWith("/api/")) {
    return Promise.reject(new OpsCrewError("INTERNAL", "Portainer paths start with /api/."));
  }
  return new Promise<PinnedResponse>((resolve, reject) => {
    let settled = false;
    const finish = (error: unknown, response?: PinnedResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error !== undefined) reject(toTransportError(error));
      else resolve(response as PinnedResponse);
    };
    const headers: Record<string, string> = {
      ...init.headers,
      Host: target.hostHeader,
      Connection: "close",
    };
    if (init.body !== undefined) {
      headers["Content-Length"] = String(Buffer.byteLength(init.body, "utf8"));
    }
    const options: http.RequestOptions = {
      host: target.host,
      port: target.port,
      method: init.method,
      path: `${target.basePath}${init.path}`,
      headers,
    };
    if (target.protocol === "https:") {
      options.createConnection = (_options, oncreate) => {
        connectPinned(target, connect, state).then(
          (socket) => oncreate(null, socket as Duplex),
          (error: Error) => oncreate(error, undefined as unknown as Duplex),
        );
        return undefined;
      };
    } else {
      options.agent = false;
    }
    const request = http.request(options, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          request.destroy(new OpsCrewError("PROVIDER_ERROR", "Portainer's answer was too large."));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () =>
        finish(undefined, {
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
        }),
      );
      response.on("error", (error) => finish(error));
    });
    const timer = setTimeout(() => {
      request.destroy(new TimeoutError(init.timeoutMs));
    }, init.timeoutMs);
    request.on("error", (error) => finish(error));
    request.end(init.body);
  });
}

class TimeoutError extends Error {
  constructor(readonly ms: number) {
    super("timeout");
  }
}

/** Plain errors without Portainer's address; certificate and OpsCrew errors pass through. */
function toTransportError(error: unknown): OpsCrewError {
  if (error instanceof OpsCrewError) return error;
  if (error instanceof TimeoutError) {
    return new OpsCrewError(
      "PROVIDER_ERROR",
      `Portainer did not answer within ${durationText(error.ms)}.`,
      {
        hint: "Check that Portainer is running and reachable from this computer, then try again.",
      },
    );
  }
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return new OpsCrewError(
    "PROVIDER_ERROR",
    `Could not reach Portainer${typeof code === "string" ? ` (${code})` : ""}.`,
    {
      hint: "Check that Portainer is running, that its address in .opscrew/server.json is right and that this computer can reach it, then try again.",
    },
  );
}

/** Verification errors that mean "this is not the certificate in `ca`". */
const NOT_PINNED_CODES = new Set([
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_SIGNATURE_FAILURE",
  "CERT_UNTRUSTED",
]);

async function connectPinned(
  target: PortainerTarget,
  connect: TlsConnect,
  state: PinState,
): Promise<tls.TLSSocket> {
  const pin = target.pin as string;
  if (state.ca === undefined) {
    const probe = await probeCertificate(target, connect);
    if (probe.fingerprint !== pin) throw new PortainerCertificateError(pin, probe.fingerprint);
    state.ca = probe.pem;
  }
  try {
    return await verifiedConnect(target, connect, state.ca, pin);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (typeof code === "string" && NOT_PINNED_CODES.has(code)) {
      // Portainer presents a certificate other than the one seen first: name the new one.
      state.ca = undefined;
      const probe = await probeCertificate(target, connect);
      if (probe.fingerprint !== pin) throw new PortainerCertificateError(pin, probe.fingerprint);
    }
    if (code === "CERT_HAS_EXPIRED" || code === "CERT_NOT_YET_VALID") {
      throw new OpsCrewError(
        "PHASE_PRECONDITION",
        `Portainer's certificate is ${code === "CERT_HAS_EXPIRED" ? "expired" : "not valid yet"}, so OpsCrew sent nothing.`,
        {
          hint: "Renew Portainer's certificate (Settings → SSL certificate), then confirm the new fingerprint with `opscrew interview`.",
        },
      );
    }
    throw error;
  }
}

function verifiedConnect(
  target: PortainerTarget,
  connect: TlsConnect,
  ca: string,
  pin: string,
): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = connect({
      host: target.host,
      port: target.port,
      ...(target.servername !== undefined && { servername: target.servername }),
      ca: [ca],
      // The pinned certificate is the trust anchor even when a CA issued it.
      allowPartialTrustChain: true,
      rejectUnauthorized: true,
      minVersion: "TLSv1.2",
      checkServerIdentity: (_host, cert) => {
        const actual = normalizeCertFingerprint(cert.fingerprint256 ?? "");
        return actual === pin
          ? undefined
          : new PortainerCertificateError(pin, actual ?? "an unreadable fingerprint");
      },
    });
    socket.setTimeout(CONNECT_TIMEOUT_MS, () =>
      socket.destroy(new TimeoutError(CONNECT_TIMEOUT_MS)),
    );
    socket.once("secureConnect", () => {
      socket.setTimeout(0);
      if (!socket.authorized) {
        socket.destroy();
        reject(new PortainerCertificateError(pin, "an unverified certificate"));
        return;
      }
      resolve(socket);
    });
    socket.once("error", reject);
  });
}

/** Handshake only, without trusting the certificate: nothing is written to the connection. */
function probeCertificate(target: PortainerTarget, connect: TlsConnect): Promise<Probe> {
  return new Promise((resolve, reject) => {
    const socket = connect({
      host: target.host,
      port: target.port,
      ...(target.servername !== undefined && { servername: target.servername }),
      rejectUnauthorized: false,
      minVersion: "TLSv1.2",
    });
    socket.setTimeout(CONNECT_TIMEOUT_MS, () =>
      socket.destroy(new TimeoutError(CONNECT_TIMEOUT_MS)),
    );
    socket.once("secureConnect", () => {
      const cert = socket.getPeerCertificate();
      socket.destroy();
      if (cert === null || typeof cert !== "object" || !Buffer.isBuffer(cert.raw)) {
        reject(new OpsCrewError("PROVIDER_ERROR", "Portainer presented no certificate."));
        return;
      }
      const x509 = new X509Certificate(cert.raw);
      const fingerprint = normalizeCertFingerprint(x509.fingerprint256);
      if (fingerprint === undefined) {
        reject(new OpsCrewError("PROVIDER_ERROR", "Portainer's certificate could not be read."));
        return;
      }
      const spki = x509.publicKey.export({ type: "spki", format: "der" });
      resolve({
        fingerprint,
        publicKeyPin: `sha256//${createHash("sha256").update(spki).digest("base64")}`,
        pem: x509.toString(),
      });
    });
    socket.once("error", (error) => reject(toTransportError(error)));
  });
}
