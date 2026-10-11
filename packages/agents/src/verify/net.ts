import { resolve4, resolve6 } from "node:dns/promises";
import { connect as tlsConnectSocket } from "node:tls";

/** DNS lookups used by `opscrew verify`. Missing records resolve to an empty list. */
export interface DnsResolver {
  resolve4(host: string): Promise<string[]>;
  resolve6(host: string): Promise<string[]>;
}

/** What `opscrew verify` needs to know about the certificate a server presents. */
export interface TlsCertificateInfo {
  /** Subject common name, when present. */
  subjectCommonName?: string;
  /** DNS names from the subject alternative name extension. */
  subjectAltNames: string[];
  /** ISO-8601 start of validity. */
  validFrom: string;
  /** ISO-8601 end of validity. */
  validTo: string;
  /** Issuer organisation (or common name), for example `Let's Encrypt`. */
  issuer: string;
}

/** Opens a TLS connection with SNI `host` and returns the peer certificate (no trust decision). */
export type TlsConnect = (
  host: string,
  options: { port?: number; timeoutMs: number },
) => Promise<TlsCertificateInfo>;

const NO_RECORDS = new Set(["ENODATA", "ENOTFOUND", "ENONAME", "NODATA", "NOTFOUND"]);

async function lookup(fn: (host: string) => Promise<string[]>, host: string): Promise<string[]> {
  try {
    return await fn(host);
  } catch (error) {
    if (NO_RECORDS.has(String((error as NodeJS.ErrnoException).code))) return [];
    throw error;
  }
}

/** `node:dns/promises` resolver: `ENODATA`/`ENOTFOUND` become empty lists, other errors throw. */
export const defaultDnsResolver: DnsResolver = {
  resolve4: (host) => lookup(resolve4, host),
  resolve6: (host) => lookup(resolve6, host),
};

function toIso(date: string): string {
  const parsed = new Date(date);
  return Number.isNaN(parsed.getTime()) ? date : parsed.toISOString();
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** `node:tls` adapter: connects without verifying trust so expired or mismatched certs can be read. */
export const defaultTlsConnect: TlsConnect = (host, options) =>
  new Promise((resolve, reject) => {
    const socket = tlsConnectSocket({
      host,
      port: options.port ?? 443,
      servername: host,
      rejectUnauthorized: false,
    });
    const fail = (error: Error) => {
      socket.destroy();
      reject(error);
    };
    socket.setTimeout(options.timeoutMs, () =>
      fail(new Error(`TLS connection to ${host} timed out`)),
    );
    socket.once("error", fail);
    socket.once("secureConnect", () => {
      const cert = socket.getPeerCertificate();
      socket.end();
      if (!cert || Object.keys(cert).length === 0) {
        reject(new Error(`${host} did not present a certificate`));
        return;
      }
      const names = (cert.subjectaltname ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.startsWith("DNS:"))
        .map((entry) => entry.slice(4));
      const commonName = first(cert.subject?.CN);
      resolve({
        ...(commonName ? { subjectCommonName: commonName } : {}),
        subjectAltNames: names,
        validFrom: toIso(cert.valid_from),
        validTo: toIso(cert.valid_to),
        issuer: first(cert.issuer?.O) ?? first(cert.issuer?.CN) ?? "unknown issuer",
      });
    });
  });
