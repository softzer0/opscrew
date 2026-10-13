import type { DsRecord, FetchLike } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { z } from "zod";

/** Cloudflare's public DNS over HTTPS (JSON answers). */
export const DNS_OVER_HTTPS_URL = "https://cloudflare-dns.com/dns-query";

/** The DS records the registry publishes for a domain, as a public resolver sees them. */
export interface PublishedDs {
  records: DsRecord[];
  /** The record set's TTL in the resolver's answer (seconds), when records are published. */
  ttlSeconds?: number;
}

const DS_TYPE = 43;
/** NOERROR and NXDOMAIN; anything else (SERVFAIL, REFUSED …) is a failed lookup. */
const NOERROR = 0;
const NXDOMAIN = 3;
const DS_DATA = /^(\d{1,5})\s+(\d{1,3})\s+(\d{1,3})\s+([0-9A-Fa-f][0-9A-Fa-f\s]*)$/;

const AnswerSchema = z.looseObject({
  Status: z.number().int(),
  Answer: z
    .array(
      z.looseObject({
        name: z.string(),
        type: z.number().int(),
        TTL: z.number().int().nonnegative(),
        data: z.string(),
      }),
    )
    .nullable()
    .optional(),
});

function hostName(name: string): string {
  return name.trim().toLowerCase().replace(/\.$/, "");
}

/**
 * The DS records published for `domain`, looked up through Cloudflare's public resolver
 * (`application/dns-json`), with the answer's TTL. Used for registrars whose API cannot read DS
 * records. A failed or unreadable lookup stops: OpsCrew never switches nameservers on a guess.
 */
export async function lookupPublishedDs(fetch: FetchLike, domain: string): Promise<PublishedDs> {
  const name = hostName(domain);
  const failed = (reason: string, cause?: unknown) =>
    new OpsCrewError(
      "PROVIDER_ERROR",
      `OpsCrew could not look up the DNSSEC (DS) records of ${name} (${reason}).`,
      {
        hint: "Check the internet connection and run the command again; OpsCrew does not switch nameservers before it knows whether old DS records are published.",
        ...(cause === undefined ? {} : { cause }),
      },
    );
  const url = `${DNS_OVER_HTTPS_URL}?${new URLSearchParams({ name, type: "DS" })}`;
  let response: Response;
  try {
    response = await fetch(url, { headers: { accept: "application/dns-json" } });
  } catch (error) {
    throw failed(error instanceof Error ? error.message : String(error), error);
  }
  if (!response.ok) throw failed(`HTTP ${response.status}`);
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    throw failed("an unexpected answer", error);
  }
  const parsed = AnswerSchema.safeParse(body);
  if (!parsed.success) throw failed("an unexpected answer");
  const { Status, Answer } = parsed.data;
  if (Status === NXDOMAIN) return { records: [] };
  if (Status !== NOERROR) throw failed(`the resolver answered with DNS status ${Status}`);
  const records: DsRecord[] = [];
  let ttl: number | undefined;
  for (const answer of Answer ?? []) {
    if (answer.type !== DS_TYPE || hostName(answer.name) !== name) continue;
    const match = DS_DATA.exec(answer.data.trim());
    if (match === null) throw failed("an unexpected answer");
    records.push({
      keyTag: Number(match[1]),
      algorithm: Number(match[2]),
      digestType: Number(match[3]),
      digest: (match[4] as string).replace(/\s+/g, "").toUpperCase(),
    });
    ttl = Math.max(ttl ?? 0, answer.TTL);
  }
  return ttl === undefined ? { records } : { records, ttlSeconds: ttl };
}
