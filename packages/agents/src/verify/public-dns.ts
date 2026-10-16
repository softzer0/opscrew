import { isIPv4, isIPv6 } from "node:net";
import type { FetchLike } from "@opscrew/contracts";
import { z } from "zod";
import { DNS_OVER_HTTPS_URL } from "../domain/connect-dns";

/**
 * What a public resolver says about a host name right now: `found` when it has an A, AAAA or
 * CNAME record, with the addresses it resolves to (either list may be empty, for example for a
 * CNAME whose target has no address; absent when the lookup does not return them).
 */
export type PublicAddressLookup =
  | { state: "found"; ipv4?: readonly string[]; ipv6?: readonly string[] }
  | { state: "missing" }
  | { state: "unknown"; problem: string };

const TYPE_CODES = { A: 1, AAAA: 28 } as const;
const CNAME = 5;
const DNS_NOERROR = 0;
const DNS_NXDOMAIN = 3;
/** CNAME targets followed through further queries (chains in one answer need none). */
const MAX_CNAME_QUERIES = 4;
const DNS_LOOKUP_TIMEOUT_MS = 15_000;

const DnsJsonResponse = z.looseObject({
  Status: z.number().int(),
  Answer: z
    .array(z.looseObject({ name: z.string(), type: z.number().int(), data: z.string() }))
    .nullish(),
});
type DnsRecord = { name: string; type: number; data: string };

function hostName(name: string): string {
  return name.trim().toLowerCase().replace(/\.$/, "");
}

type Query =
  | { state: "answer"; records: DnsRecord[] }
  | { state: "missing" }
  | { state: "unknown"; problem: string };

async function query(fetch: FetchLike, name: string, type: "A" | "AAAA"): Promise<Query> {
  const url = `${DNS_OVER_HTTPS_URL}?${new URLSearchParams({ name, type })}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: { accept: "application/dns-json" },
      signal: AbortSignal.timeout(DNS_LOOKUP_TIMEOUT_MS),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { state: "unknown", problem: `the request failed: ${reason}` };
  }
  if (!response.ok) return { state: "unknown", problem: `HTTP ${response.status}` };
  const parsed = DnsJsonResponse.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) return { state: "unknown", problem: "an unexpected answer" };
  const { Status, Answer } = parsed.data;
  if (Status === DNS_NXDOMAIN) return { state: "missing" };
  if (Status !== DNS_NOERROR) {
    return { state: "unknown", problem: `the resolver answered with DNS status ${Status}` };
  }
  return { state: "answer", records: Answer ?? [] };
}

type Resolved =
  | { state: "answer"; found: boolean; addresses: string[] }
  | { state: "missing" }
  | { state: "unknown"; problem: string };

/** One record type for `name`, following CNAMEs (in the answer, then by asking for the target). */
async function resolveType(fetch: FetchLike, name: string, type: "A" | "AAAA"): Promise<Resolved> {
  const valid = type === "A" ? isIPv4 : isIPv6;
  const seen = new Set<string>([name]);
  let current = name;
  let found = false;
  for (let asked = 0; asked <= MAX_CNAME_QUERIES; asked++) {
    const answer = await query(fetch, current, type);
    // A target that fails or does not exist: the host has its record, but no address.
    if (answer.state !== "answer")
      return asked === 0 ? answer : { state: "answer", found, addresses: [] };
    const { records } = answer;
    if (asked === 0) {
      found = records.some(
        (r) => (r.type === TYPE_CODES[type] || r.type === CNAME) && hostName(r.name) === name,
      );
    }
    const addresses = [
      ...new Set(
        records
          .filter((r) => r.type === TYPE_CODES[type])
          .map((r) => r.data.trim())
          .filter((data) => valid(data)),
      ),
    ];
    if (addresses.length > 0) return { state: "answer", found: true, addresses };
    // The end of the CNAME chain the answer shows, then ask for it.
    const cnames = new Map(
      records.filter((r) => r.type === CNAME).map((r) => [hostName(r.name), hostName(r.data)]),
    );
    let next = current;
    for (let target = cnames.get(next); target !== undefined && !seen.has(target); ) {
      seen.add(target);
      next = target;
      target = cnames.get(next);
    }
    if (next === current) break;
    current = next;
  }
  return { state: "answer", found, addresses: [] };
}

/**
 * The addresses `host` resolves to, asked read-only of Cloudflare's public resolver over DNS over
 * HTTPS (`application/dns-json`): A, then AAAA, each following its CNAME chain through the same
 * resolver. NXDOMAIN or no record is `missing`; a failed or unreadable lookup is `unknown`, never
 * taken as an answer. Answers that are not addresses of the asked type are dropped.
 */
export async function lookupPublicAddresses(
  fetch: FetchLike,
  host: string,
): Promise<PublicAddressLookup> {
  const name = hostName(host);
  const ipv4 = await resolveType(fetch, name, "A");
  if (ipv4.state !== "answer") return ipv4;
  const ipv6 = await resolveType(fetch, name, "AAAA");
  const v6 = ipv6.state === "answer" ? ipv6 : { found: false, addresses: [] };
  if (!ipv4.found && !v6.found) {
    return ipv6.state === "unknown" ? ipv6 : { state: "missing" };
  }
  return { state: "found", ipv4: ipv4.addresses, ipv6: v6.addresses };
}
