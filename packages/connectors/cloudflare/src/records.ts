import type { RegistrarDnsRecord } from "@opscrew/contracts";
import { normalizeHostName } from "@opscrew/core";

/** A DNS record to create in a Cloudflare zone, named as in the Cloudflare API. */
export interface CloudflareRecordInput {
  type: string;
  /** Fully qualified name. */
  name: string;
  /** Record content; absent for types that use `data` (SRV, CAA). */
  content?: string;
  /** Structured content for SRV and CAA. */
  data?: Record<string, string | number>;
  /** MX priority. */
  priority?: number;
  /** Seconds, or 1 for automatic. */
  ttl: number;
  /** Copied records are never proxied, so mail and verification records keep working. */
  proxied: false;
}

/** The result of mapping one registrar record: a record to create, or why it is not copied. */
export type RecordMapping =
  | { skipped: false; record: CloudflareRecordInput }
  | { skipped: true; reason: string };

/** A registrar record that will not be copied, with the reason in plain English. */
export interface SkippedRecord {
  record: RegistrarDnsRecord;
  reason: string;
}

/** The copy plan for a zone: what will be created and what will not (shown before approval). */
export interface RecordCopyPlan {
  create: CloudflareRecordInput[];
  skipped: SkippedRecord[];
}

/** Cloudflare's automatic TTL. */
const AUTO_TTL = 1;
const MIN_TTL = 60;
const MAX_TTL = 86400;
/** Longest character-string inside one TXT value (RFC 1035). */
const TXT_CHUNK = 255;

const REDIRECT_TYPES = new Set([
  "URL",
  "URL301",
  "URL302",
  "URL_REDIRECT",
  "REDIRECT",
  "REDIRECT301",
  "REDIRECT302",
  "FRAME",
  "MASKED",
  "FORWARD",
]);

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/** A host target without its trailing dot; `@` means the zone apex. */
function target(value: string, zoneName: string): string {
  const v = value.trim().replace(/\.$/, "");
  return v === "@" || v === "" ? zoneName : v.toLowerCase();
}

function ttlOf(ttl: number | undefined): number {
  if (ttl === undefined || !Number.isInteger(ttl)) return AUTO_TTL;
  return ttl >= MIN_TTL && ttl <= MAX_TTL ? ttl : AUTO_TTL;
}

/**
 * TXT content in Cloudflare's expected form: one or more double-quoted strings. Content that is
 * already quoted is kept; otherwise it is quoted and split into 255-character strings.
 */
export function quoteTxt(content: string): string {
  const value = content.trim();
  if (/^".*"$/s.test(value)) return value;
  const parts: string[] = [];
  for (let i = 0; i < value.length || parts.length === 0; i += TXT_CHUNK) {
    parts.push(value.slice(i, i + TXT_CHUNK));
  }
  return parts.map((p) => `"${p.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(" ");
}

function integer(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  return Number(value);
}

const skip = (reason: string): RecordMapping => ({ skipped: true, reason });

/**
 * Maps one record read from a registrar to a Cloudflare record to create, or says in plain
 * English why it is not copied. Pure. Rules: the name must be inside the zone; NS at the apex and
 * SOA are skipped (Cloudflare manages them); NS below the apex is copied (a delegation); ALIAS
 * becomes CNAME (Cloudflare flattens a CNAME at the apex); redirect types (URL, URL301, FRAME …)
 * are skipped with a pointer to Cloudflare redirect rules; unknown types are skipped. Records are
 * never proxied; the TTL is kept when Cloudflare accepts it (60–86400), else automatic.
 */
export function mapRegistrarRecord(record: RegistrarDnsRecord, zoneName: string): RecordMapping {
  const zone = normalizeHostName(zoneName);
  const name = normalizeHostName(record.name) || zone;
  const type = record.type.trim().toUpperCase();
  const label = `${type} record for ${name}`;
  if (name !== zone && !name.endsWith(`.${zone}`)) {
    return skip(`The ${label} is outside the zone ${zone}.`);
  }
  const apex = name === zone;
  const ttl = ttlOf(record.ttl);
  const content = record.content.trim();
  const create = (fields: Omit<CloudflareRecordInput, "name" | "ttl" | "proxied">) =>
    ({
      skipped: false,
      record: { ...fields, name, ttl, proxied: false },
    }) as RecordMapping;

  if (REDIRECT_TYPES.has(type)) {
    return skip(
      `The ${label} is a registrar redirect or forwarding record, which is not a DNS record; recreate it with Cloudflare redirect rules (Rules → Redirect Rules in the dashboard).`,
    );
  }
  switch (type) {
    case "SOA":
      return skip(`The ${label} is managed by Cloudflare.`);
    case "NS":
      if (apex) return skip(`The ${label} is managed by Cloudflare (its own nameservers).`);
      if (!content) return skip(`The ${label} has no target.`);
      return create({ type, content: target(content, zone) });
    case "A":
      if (!IPV4.test(content)) return skip(`The ${label} does not hold an IPv4 address.`);
      return create({ type, content });
    case "AAAA":
      if (!content.includes(":")) return skip(`The ${label} does not hold an IPv6 address.`);
      return create({ type, content: content.toLowerCase() });
    case "CNAME":
    case "ALIAS":
      if (!content) return skip(`The ${label} has no target.`);
      return create({ type: "CNAME", content: target(content, zone) });
    case "MX": {
      const parts = content.split(/\s+/).filter(Boolean);
      let priority = record.priority;
      let host = parts[0];
      if (parts.length === 2 && integer(parts[0]) !== undefined) {
        priority = integer(parts[0]);
        host = parts[1];
      } else if (parts.length !== 1) {
        host = undefined;
      }
      if (priority === undefined || !Number.isInteger(priority) || priority < 0) {
        return skip(`The ${label} has no priority.`);
      }
      if (!host) return skip(`The ${label} has no mail server.`);
      // RFC 7505: any preference with the target "." says the name accepts no mail.
      if (host.trim() === ".") {
        return skip(
          `The ${label} is a null MX: ${name} accepts no mail; add it in Cloudflare yourself if you want to keep it.`,
        );
      }
      return create({ type, content: target(host, zone), priority });
    }
    case "TXT":
      return create({ type, content: quoteTxt(content) });
    case "SRV": {
      const parts = content.split(/\s+/).filter(Boolean);
      const fields =
        parts.length === 4
          ? parts
          : parts.length === 3 && record.priority !== undefined
            ? [String(record.priority), ...parts]
            : undefined;
      const [priority, weight, port] = (fields ?? []).slice(0, 3).map(integer);
      const host = fields?.[3];
      if (priority === undefined || weight === undefined || port === undefined || !host) {
        return skip(`The ${label} is not in the form "priority weight port target".`);
      }
      if (host.trim() === ".") {
        return skip(
          `The ${label} says the service is not offered (target "."); add it in Cloudflare yourself if you want to keep it.`,
        );
      }
      return create({ type, data: { priority, weight, port, target: target(host, zone) } });
    }
    case "CAA": {
      const match = /^(\d+)\s+([A-Za-z0-9]+)\s+(.+)$/s.exec(content);
      const flags = integer(match?.[1]);
      if (!match || flags === undefined || flags > 255) {
        return skip(`The ${label} is not in the form "flags tag value".`);
      }
      const value = (match[3] ?? "").trim().replace(/^"(.*)"$/s, "$1");
      return create({ type, data: { flags, tag: (match[2] ?? "").toLowerCase(), value } });
    }
    default:
      return skip(
        `OpsCrew does not copy ${type} records; add the ${label} in Cloudflare yourself.`,
      );
  }
}

/** Types Cloudflare refuses on the same name as a CNAME. */
const ADDRESS_TYPES = new Set(["A", "AAAA", "CNAME"]);

function recordKey(r: CloudflareRecordInput): string {
  return JSON.stringify([r.type, r.name, r.content ?? "", r.priority ?? null, r.data ?? null]);
}

/**
 * The copy plan for a whole zone: maps every record, drops exact duplicates, and skips a CNAME
 * that shares its name with an A, AAAA or another CNAME record (Cloudflare refuses those
 * combinations; MX, TXT and other types may sit next to a CNAME, including a flattened one at the
 * apex).
 */
export function mapRegistrarRecords(
  records: readonly RegistrarDnsRecord[],
  zoneName: string,
): RecordCopyPlan {
  const mapped: { source: RegistrarDnsRecord; record: CloudflareRecordInput }[] = [];
  const skipped: SkippedRecord[] = [];
  const seen = new Set<string>();
  for (const source of records) {
    const result = mapRegistrarRecord(source, zoneName);
    if (result.skipped) {
      skipped.push({ record: source, reason: result.reason });
      continue;
    }
    const key = recordKey(result.record);
    if (seen.has(key)) continue;
    seen.add(key);
    mapped.push({ source, record: result.record });
  }
  const create: CloudflareRecordInput[] = [];
  for (const { source, record } of mapped) {
    if (record.type === "CNAME") {
      const others = mapped.filter(
        (m) =>
          m.record !== record && m.record.name === record.name && ADDRESS_TYPES.has(m.record.type),
      );
      if (others.length > 0) {
        skipped.push({
          record: source,
          reason: `The ${source.type.toUpperCase()} record for ${record.name} cannot be copied because an A, AAAA or CNAME record has the same name; Cloudflare does not allow a CNAME next to them. Keep one of them.`,
        });
        continue;
      }
    }
    create.push(record);
  }
  return { create, skipped };
}
