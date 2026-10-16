import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from "node:dns";
import { resolve4, resolve6 } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";
import { connect as tlsConnectSocket } from "node:tls";
import type { FetchLike } from "@opscrew/contracts";
import { normalizeHostName } from "@opscrew/core";

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

/**
 * Opens a TLS connection with SNI `host` and returns the peer certificate (no trust decision).
 * `lookup`, when given, finds the address to connect to (the server name stays `host`).
 */
export type TlsConnect = (
  host: string,
  options: { port?: number; timeoutMs: number; lookup?: LookupFunction },
) => Promise<TlsCertificateInfo>;

/** The addresses a public resolver gave for a host name. */
export interface PublicAddresses {
  ipv4: readonly string[];
  ipv6: readonly string[];
}

/** Builds a fetch whose connections find addresses with `lookup`; everything else stays as is. */
export type FetchWithLookup = (lookup: LookupFunction) => FetchLike;

/** `dns.lookup` errors that mean the name is not found (rather than a broken resolver). */
const NOT_FOUND_LOOKUP = new Set(["ENOTFOUND", "ENODATA", "EAI_NONAME", "EAI_NODATA"]);

/**
 * A `dns.lookup`-compatible function for a host this computer still holds an older "no such name"
 * answer for: it asks `system` (default `dns.lookup`) first and keeps its answer; only when that
 * finds no such name for a host in `answers` (keyed by `normalizeHostName`) does it answer with
 * the public addresses (IPv4 first). Other names and errors are `system`'s.
 */
export function publicAnswerLookup(
  answers: ReadonlyMap<string, PublicAddresses>,
  system: LookupFunction = dnsLookup as LookupFunction,
): LookupFunction {
  return (hostname, options, callback) => {
    system(hostname, options, (error, address, family) => {
      const answer = answers.get(normalizeHostName(hostname));
      if (!error || !answer || !NOT_FOUND_LOOKUP.has(String(error.code))) {
        callback(error, address, family);
        return;
      }
      const wanted = lookupFamily(options);
      const list: LookupAddress[] = [
        ...(wanted === 6 ? [] : answer.ipv4.map((a) => ({ address: a, family: 4 }))),
        ...(wanted === 4 ? [] : answer.ipv6.map((a) => ({ address: a, family: 6 }))),
      ];
      const first = list[0];
      if (first === undefined) {
        callback(error, address, family);
        return;
      }
      if (options.all) callback(null, list);
      else callback(null, first.address, first.family);
    });
  };
}

function lookupFamily(options: LookupOptions): 0 | 4 | 6 {
  const family = options.family;
  return family === 4 || family === "IPv4" ? 4 : family === 6 || family === "IPv6" ? 6 : 0;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);
const MAX_REDIRECTS = 20;

/**
 * A fetch over `node:http`/`node:https` whose connections find addresses with `lookup`. The URL,
 * the Host header, TLS SNI and the certificate check keep the real host name. For the GET and HEAD
 * requests `opscrew verify` sends (no request body); `redirect` is `follow` (default) or `manual`.
 * Fails like `fetch` (a `TypeError` whose `cause` is the network error).
 */
export const nodeFetchWithLookup: FetchWithLookup = (lookup) => async (input, init) => {
  if (init?.body !== undefined && init.body !== null) {
    throw new TypeError("This fetch sends no request body.");
  }
  const method = (init?.method ?? "GET").toUpperCase();
  const headers = Object.fromEntries(new Headers(init?.headers));
  const signal = init?.signal ?? undefined;
  let url = new URL(String(input));
  for (let hops = 0; ; hops++) {
    const response = await requestOnce(url, method, headers, lookup, signal);
    const location = response.headers.get("location");
    if (init?.redirect === "manual" || !REDIRECT_STATUSES.has(response.status) || !location) {
      return response;
    }
    await response.body?.cancel();
    if (init?.redirect === "error" || hops >= MAX_REDIRECTS) {
      throw new TypeError("fetch failed", {
        cause: new Error(`${url.origin} redirected too often or unexpectedly`),
      });
    }
    url = new URL(location, url);
  }
};

function requestOnce(
  url: URL,
  method: string,
  headers: Record<string, string>,
  lookup: LookupFunction,
  signal: AbortSignal | undefined,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const fail = (cause: unknown) => reject(new TypeError("fetch failed", { cause }));
    const https = url.protocol === "https:";
    if (!https && url.protocol !== "http:") {
      fail(new Error(`${url.protocol} addresses are not supported`));
      return;
    }
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const request = (https ? httpsRequest : httpRequest)(
      url,
      {
        method,
        headers,
        lookup,
        // One connection per request: it never outlives the check nor serves another lookup.
        agent: false,
        ...(https && isIP(host) === 0 ? { servername: host } : {}),
        ...(signal ? { signal } : {}),
      },
      (incoming) => {
        const status = incoming.statusCode ?? 0;
        if (status < 200 || status > 599) {
          incoming.destroy();
          fail(new Error(`${url.origin} answered with HTTP ${status}`));
          return;
        }
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
            responseHeaders.append(name, item);
          }
        }
        const empty = method === "HEAD" || NULL_BODY_STATUSES.has(status);
        if (empty) incoming.resume();
        resolve(
          new Response(
            empty ? null : (Readable.toWeb(incoming) as unknown as ReadableStream<Uint8Array>),
            { status, statusText: incoming.statusMessage ?? "", headers: responseHeaders },
          ),
        );
      },
    );
    request.once("error", fail);
    request.end();
  });
}

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
      ...(options.lookup ? { lookup: options.lookup } : {}),
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
