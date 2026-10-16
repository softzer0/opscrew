import type { DsRecord, FetchLike } from "@opscrew/contracts";
import { normalizeHostName, OpsCrewError } from "@opscrew/core";
import { dohQuery } from "../shared";

/** The DS records the registry publishes for a domain, as a public resolver sees them. */
export interface PublishedDs {
  records: DsRecord[];
  /** The record set's TTL in the resolver's answer (seconds), when records are published. */
  ttlSeconds?: number;
}

const DS_TYPE = 43;
const DS_DATA = /^(\d{1,5})\s+(\d{1,3})\s+(\d{1,3})\s+([0-9A-Fa-f][0-9A-Fa-f\s]*)$/;

/**
 * The DS records published for `domain`, looked up through Cloudflare's public resolver (see
 * `dohQuery`), with the answer's TTL. Used for registrars whose API cannot read DS records. A
 * failed, timed-out or unreadable lookup stops: OpsCrew never switches nameservers on a guess.
 */
export async function lookupPublishedDs(fetch: FetchLike, domain: string): Promise<PublishedDs> {
  const name = normalizeHostName(domain);
  const failed = (reason: string) =>
    new OpsCrewError(
      "PROVIDER_ERROR",
      `OpsCrew could not look up the DNSSEC (DS) records of ${name} (${reason}).`,
      {
        hint: "Check the internet connection and run the command again; OpsCrew does not switch nameservers before it knows whether old DS records are published.",
      },
    );
  const answer = await dohQuery(fetch, name, "DS");
  if (answer.state === "missing") return { records: [] };
  if (answer.state === "unknown") throw failed(answer.problem);
  const records: DsRecord[] = [];
  let ttl: number | undefined;
  for (const record of answer.records) {
    if (record.type !== DS_TYPE || normalizeHostName(record.name) !== name) continue;
    const match = DS_DATA.exec(record.data.trim());
    if (match === null || record.TTL === undefined) throw failed("an unexpected answer");
    records.push({
      keyTag: Number(match[1]),
      algorithm: Number(match[2]),
      digestType: Number(match[3]),
      digest: (match[4] as string).replace(/\s+/g, "").toUpperCase(),
    });
    ttl = Math.max(ttl ?? 0, record.TTL);
  }
  return ttl === undefined ? { records } : { records, ttlSeconds: ttl };
}
