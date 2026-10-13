import {
  type CloudflareRecordInput,
  mapRegistrarRecord,
  mapRegistrarRecords,
} from "@opscrew/connector-cloudflare";
import type { RegistrarDnsRecord } from "@opscrew/contracts";
import type { ZoneRecord } from "./types";

/**
 * The record copy plan of `opscrew domain connect`: which of the domain's current records become
 * Cloudflare records, which are already in the zone (an earlier run copied them), which are not
 * copied and why, and what the zone already holds that the current DNS does not (it is served
 * after the switch too, or it clashes and stops the run).
 */
export interface CopyPlan {
  /** Records to create in the zone (those it does not have yet). */
  create: CloudflareRecordInput[];
  /** Records the zone has already, so they are not created again. */
  present: number;
  /** SOA and NS records of the domain itself: Cloudflare manages its own. */
  managed: RegistrarDnsRecord[];
  /** Records that are not copied, each with the reason in plain English. */
  skipped: { record: RegistrarDnsRecord; reason: string }[];
  /** Zone records the current DNS does not have: Cloudflare serves them after the switch too. */
  extra: ZoneRecord[];
  /** Zone records served after the switch (matching or extra) that Cloudflare proxies. */
  proxied: ZoneRecord[];
  /**
   * Zone records that clash with the current records on the same name: a CNAME next to an A,
   * AAAA or another CNAME (Cloudflare refuses that); an A or AAAA answer the current DNS does not
   * give (both would be served); other mail servers than the current MX records (mail would be
   * split); or another SPF policy (two SPF records make mail checks fail). Plain-English lines;
   * any clash stops the run.
   */
  clashes: string[];
}

/** Types that hold one host name (compared without case and the trailing dot). */
const HOST_TYPES = new Set(["CNAME", "NS", "MX", "PTR"]);
const ADDRESS_TYPES = new Set(["A", "AAAA"]);
/** DNSSEC data of the current provider, found in exported zone files. */
const DNSSEC_TYPES = new Set(["RRSIG", "NSEC", "NSEC3", "NSEC3PARAM", "DNSKEY", "CDS", "CDNSKEY"]);

function hostText(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

/** An IPv6 address in its canonical form (`2001:0db8:0:0::1` → `2001:db8::1`); else lower case. */
export function canonicalIpv6(value: string): string {
  const ip = value.trim().toLowerCase();
  try {
    return new URL(`http://[${ip}]/`).hostname.slice(1, -1);
  } catch {
    return ip;
  }
}

/** TXT text without its quotes: the character-strings decoded and joined. */
export function unquoteTxt(text: string): string {
  const value = text.trim();
  if (!value.startsWith('"')) return value;
  let out = "";
  let i = 0;
  while (i < value.length) {
    if (value[i] !== '"') {
      i++;
      continue;
    }
    i++;
    while (i < value.length && value[i] !== '"') {
      if (value[i] === "\\" && i + 1 < value.length) {
        const digits = /^\d{3}/.exec(value.slice(i + 1, i + 4));
        if (digits !== null) {
          out += String.fromCharCode(Number(digits[0]));
          i += 4;
        } else {
          out += value[i + 1];
          i += 2;
        }
        continue;
      }
      out += value[i];
      i++;
    }
    i++;
  }
  return out;
}

/** A record in comparable form: type, name and content, plus the priority when it is known. */
interface Comparable {
  type: string;
  name: string;
  /** The normalised content (host without the trailing dot, TXT unquoted …). */
  content: string;
  key: string;
  priority?: number;
}

function comparable(type: string, name: string, content: string, priority?: number): Comparable {
  const upper = type.toUpperCase();
  const host = hostText(name);
  return {
    type: upper,
    name: host,
    content,
    key: JSON.stringify([upper, host, content]),
    ...(priority === undefined || !Number.isFinite(priority) ? {} : { priority }),
  };
}

const SPF = /^v=spf1(\s|$)/i;

/**
 * TXT content in comparable form: unquoted; an SPF policy also with its spaces collapsed and in
 * lower case (two spellings of one policy are still two SPF records, so they must match).
 */
function txtContent(raw: string): string {
  const text = unquoteTxt(raw);
  return SPF.test(text.trim()) ? text.trim().replace(/\s+/g, " ").toLowerCase() : text;
}

/** An SPF policy (`v=spf1 …`) in comparable form, or undefined for other records. */
function spfOf(record: Comparable): string | undefined {
  return record.type === "TXT" && SPF.test(record.content) ? record.content : undefined;
}

function numberOf(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

/** The comparable form of a record OpsCrew would create. */
function inputComparable(record: CloudflareRecordInput): Comparable {
  const type = record.type.toUpperCase();
  const data = record.data ?? {};
  if (type === "SRV") {
    const content = `${data.weight} ${data.port} ${hostText(String(data.target ?? ""))}`;
    return comparable(type, record.name, content, numberOf(data.priority));
  }
  if (type === "CAA") {
    const content = `${data.flags} ${String(data.tag ?? "").toLowerCase()} ${data.value ?? ""}`;
    return comparable(type, record.name, content);
  }
  if (type === "TXT") return comparable(type, record.name, txtContent(record.content ?? ""));
  if (type === "AAAA") return comparable(type, record.name, canonicalIpv6(record.content ?? ""));
  if (HOST_TYPES.has(type)) {
    return comparable(type, record.name, hostText(record.content ?? ""), record.priority);
  }
  return comparable(type, record.name, (record.content ?? "").trim().toLowerCase());
}

/** The comparable form of a record in the zone (Cloudflare's content format). */
function zoneComparable(record: ZoneRecord): Comparable {
  const type = record.type.toUpperCase();
  const raw = record.content.trim();
  const given = numberOf(record.priority);
  if (type === "SRV") {
    const parts = raw.split(/\s+/);
    const [weight, port, target] = parts.slice(-3);
    const priority = given ?? (parts.length === 4 ? numberOf(parts[0]) : undefined);
    return comparable(type, record.name, `${weight} ${port} ${hostText(target ?? "")}`, priority);
  }
  if (type === "CAA") {
    const match = /^(\d+)\s+(\S+)\s+(.*)$/s.exec(raw);
    const content =
      match === null
        ? raw
        : `${match[1]} ${(match[2] as string).toLowerCase()} ${unquoteTxt(match[3] as string)}`;
    return comparable(type, record.name, content);
  }
  if (type === "TXT") return comparable(type, record.name, txtContent(raw));
  if (type === "AAAA") return comparable(type, record.name, canonicalIpv6(raw));
  if (type === "MX") {
    const parts = raw.split(/\s+/);
    const priority = given ?? (parts.length === 2 ? numberOf(parts[0]) : undefined);
    return comparable(type, record.name, hostText(parts.at(-1) ?? ""), priority);
  }
  return comparable(type, record.name, HOST_TYPES.has(type) ? hostText(raw) : raw.toLowerCase());
}

/** Same record: same type, name and content, and the same priority when both sides know it. */
function sameRecord(a: Comparable, b: Comparable): boolean {
  return (
    a.key === b.key &&
    (a.priority === undefined || b.priority === undefined || a.priority === b.priority)
  );
}

/** The reason a record is not copied: the mapping's, or a clearer one for some types. */
function skipReason(record: RegistrarDnsRecord, reason: string): string {
  const type = record.type.trim().toUpperCase();
  const name = hostText(record.name);
  if (type === "EMAIL-FORWARDING") {
    // Namecheap's mail pseudo-record: its content says what to do.
    return `Mail for ${name}: ${record.content.trim().replace(/\.+$/, "")}.`;
  }
  if (DNSSEC_TYPES.has(type)) {
    return `The ${type} record for ${name} is DNSSEC data of the current DNS provider; Cloudflare signs the zone itself once DNSSEC is on.`;
  }
  return reason;
}

/** `A shopapp.com 198.51.100.7`: a zone record as the approval shows it. */
export function zoneRecordText(record: ZoneRecord): string {
  return `${record.type.toUpperCase()} ${hostText(record.name)} ${record.content.trim()}`;
}

/**
 * Why a zone record the current DNS does not have clashes with the current records on its name,
 * or undefined when it can simply be served next to them. `inZone` is every zone record; mail
 * clashes are said once per name (the caller drops repeated lines).
 */
function clashOf(
  zone: Comparable,
  record: ZoneRecord,
  inZone: readonly Comparable[],
  source: readonly { comparable: Comparable; text: string; value: string }[],
): string | undefined {
  const sameName = source.filter((s) => s.comparable.name === zone.name);
  const types = (wanted: (type: string) => boolean) =>
    sameName.filter((s) => wanted(s.comparable.type));
  const answers = (list: readonly { text: string }[]) => list.map((s) => s.text).join(", ");
  const zoneHere = inZone.filter((z) => z.name === zone.name);
  if (zone.type === "MX") {
    // Mail split between two providers: the zone's other mail servers next to the current ones.
    const current = new Set(types((t) => t === "MX").map((s) => s.comparable.content));
    const others = [
      ...new Set(
        zoneHere.filter((z) => z.type === "MX" && !current.has(z.content)).map((z) => z.content),
      ),
    ];
    if (current.size > 0 && others.includes(zone.content)) {
      return `the Cloudflare zone already has other mail servers for ${zone.name}: ${others.join(", ")}, next to the current ones (${[...current].join(", ")}); after the switch mail would be split between them`;
    }
  }
  const spf = spfOf(zone);
  if (spf !== undefined) {
    // More than one SPF policy on a name makes SPF checks fail.
    const current = new Set(
      sameName.map((s) => spfOf(s.comparable)).filter((v): v is string => v !== undefined),
    );
    const zoneOnly = [
      ...new Set(
        zoneHere.map(spfOf).filter((v): v is string => v !== undefined && !current.has(v)),
      ),
    ];
    if (current.size + zoneOnly.length > 1) {
      const quoted = (values: Iterable<string>) => [...values].map((v) => `"${v}"`).join(", ");
      const now = current.size > 0 ? ` next to the current one (${quoted(current)})` : "";
      return `the Cloudflare zone already has another SPF record for ${zone.name} (${quoted(zoneOnly)})${now}; with more than one SPF record on a name, mail checks fail`;
    }
  }
  const inZoneText = `${zoneRecordText(record)} is already in the Cloudflare zone`;
  if (zone.type === "CNAME") {
    const others = types((t) => ADDRESS_TYPES.has(t) || t === "CNAME");
    if (others.length > 0) {
      return `${inZoneText}, but the current DNS has ${answers(others)}; Cloudflare does not allow a CNAME next to an A, AAAA or another CNAME record on the same name`;
    }
  }
  if (ADDRESS_TYPES.has(zone.type)) {
    const cnames = types((t) => t === "CNAME");
    if (cnames.length > 0) {
      return `${inZoneText}, but the current DNS has ${answers(cnames)}; Cloudflare does not allow a CNAME next to an A or AAAA record on the same name`;
    }
    const same = types((t) => t === zone.type);
    if (same.length > 0) {
      const values = same.map((s) => s.value).join(", ");
      return `${inZoneText}, but the current DNS answers ${values} there; after the switch both answers would be served`;
    }
  }
  return undefined;
}

/**
 * The copy plan: `mapRegistrarRecords` (ALIAS → CNAME, MX priority, TXT quoting, redirects and
 * unknown types skipped), without the records the zone already has (same type, name and
 * normalised content, IPv6 canonical, and the same MX/SRV priority when both sides know it), so a
 * resumed run copies only what is missing. Zone records the current DNS does not have are listed
 * (`extra`) or, when they clash on the same name, reported (`clashes`).
 */
export function copyPlan(
  records: readonly RegistrarDnsRecord[],
  domain: string,
  inZone: readonly ZoneRecord[],
): CopyPlan {
  const mapped = mapRegistrarRecords(records, domain);
  const zone = inZone.map((record) => ({ record, comparable: zoneComparable(record) }));
  const matched = new Set<number>();
  const create: CloudflareRecordInput[] = [];
  const source = mapped.create.map((record) => ({
    record,
    comparable: inputComparable(record),
    text: recordText(record),
    value: record.content ?? "",
  }));
  for (const { record, comparable: wanted } of source) {
    const index = zone.findIndex((z, i) => !matched.has(i) && sameRecord(z.comparable, wanted));
    if (index === -1) create.push(record);
    else matched.add(index);
  }
  const extra: ZoneRecord[] = [];
  const clashes: string[] = [];
  const all = zone.map((z) => z.comparable);
  zone.forEach((z, i) => {
    if (matched.has(i)) return;
    const clash = clashOf(z.comparable, z.record, all, source);
    if (clash === undefined) extra.push(z.record);
    else if (!clashes.includes(clash)) clashes.push(clash);
  });
  const proxied = zone
    .filter((z, i) => z.record.proxied === true && (matched.has(i) || extra.includes(z.record)))
    .map((z) => z.record);
  const managed: RegistrarDnsRecord[] = [];
  const skipped: CopyPlan["skipped"] = [];
  for (const { record, reason } of mapped.skipped) {
    const type = record.type.trim().toUpperCase();
    if (type === "SOA" || (type === "NS" && hostText(record.name) === domain)) {
      managed.push(record);
    } else {
      skipped.push({ record, reason: skipReason(record, reason) });
    }
  }
  return {
    create,
    present: mapped.create.length - create.length,
    managed,
    skipped,
    extra,
    proxied,
    clashes,
  };
}

/** The records the zone does not have (same comparison as the copy plan). */
export function missingFromZone(
  records: readonly CloudflareRecordInput[],
  inZone: readonly ZoneRecord[],
): CloudflareRecordInput[] {
  const zone = inZone.map(zoneComparable);
  const used = new Set<number>();
  return records.filter((record) => {
    const wanted = inputComparable(record);
    const index = zone.findIndex((z, i) => !used.has(i) && sameRecord(z, wanted));
    if (index === -1) return true;
    used.add(index);
    return false;
  });
}

/** `MX shopapp.com 10 mx1.example.net`: a record as the approval shows it. */
export function recordText(record: CloudflareRecordInput): string {
  const data = record.data ?? {};
  switch (record.type) {
    case "MX":
      return `MX ${record.name} ${record.priority ?? 0} ${record.content ?? ""}`;
    case "SRV":
      return `SRV ${record.name} ${data.priority} ${data.weight} ${data.port} ${data.target}`;
    case "CAA":
      return `CAA ${record.name} ${data.flags} ${data.tag} "${data.value}"`;
    default:
      return `${record.type} ${record.name} ${record.content ?? ""}`;
  }
}

/**
 * Approval lines for the records to create; a CNAME made from an ALIAS record says so (at the
 * apex, Cloudflare flattens it, so it answers like ALIAS).
 */
export function createLines(
  plan: CopyPlan,
  records: readonly RegistrarDnsRecord[],
  domain: string,
): string[] {
  const fromAlias: Comparable[] = [];
  for (const record of records) {
    if (record.type.trim().toUpperCase() !== "ALIAS") continue;
    const mapping = mapRegistrarRecord(record, domain);
    if (!mapping.skipped) fromAlias.push(inputComparable(mapping.record));
  }
  return plan.create.map((record) => {
    const text = recordText(record);
    const wanted = inputComparable(record);
    if (!fromAlias.some((a) => sameRecord(a, wanted))) return text;
    return record.name === domain
      ? `${text} (the ALIAS record, as a CNAME: Cloudflare flattens a CNAME at the apex, so it answers like ALIAS)`
      : `${text} (the ALIAS record, as a CNAME)`;
  });
}

/** `the SOA record and 2 NS records of shopapp.com`. */
export function managedText(plan: CopyPlan, domain: string): string | undefined {
  const soa = plan.managed.filter((r) => r.type.trim().toUpperCase() === "SOA").length;
  const ns = plan.managed.length - soa;
  const parts = [
    ...(soa > 0 ? [soa === 1 ? "the SOA record" : `${soa} SOA records`] : []),
    ...(ns > 0 ? [ns === 1 ? "the NS record" : `${ns} NS records`] : []),
  ];
  return parts.length === 0 ? undefined : `${parts.join(" and ")} of ${domain}`;
}
