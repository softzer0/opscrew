import type { DsRecord } from "@opscrew/contracts";
import { normalizeHostName, OpsCrewError } from "@opscrew/core";
import { z } from "zod";

/** Normalises a domain (lower case, no trailing dot) and refuses anything that is not one. */
export function normalizeDomain(domain: string): string {
  const name = normalizeHostName(domain);
  if (!isDomainName(name)) {
    throw new OpsCrewError("INVALID_INPUT", `"${domain.slice(0, 80)}" is not a domain name.`, {
      hint: "Use a name like example.com (internationalized names in their xn-- form).",
    });
  }
  return name;
}

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/** True for a syntactically valid domain name with at least two labels (lower case). */
export function isDomainName(name: string): boolean {
  if (name.length > 253) return false;
  const labels = name.split(".");
  if (labels.length < 2) return false;
  const tld = labels.at(-1) ?? "";
  if (!/^([a-z]{2,63}|xn--[a-z0-9-]{1,59})$/.test(tld)) return false;
  return labels.every((label) => LABEL.test(label));
}

/** The extension of a registrable domain (`co.uk` for `example.co.uk`). */
export function tldOf(domain: string): string {
  return domain.slice(domain.indexOf(".") + 1);
}

/** A number Porkbun sends as a number or a numeric string. */
const Numeric = z.union([z.number(), z.string()]);

/** Parses a numeric value; undefined when absent or not a finite number. */
export function toNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const n = Number(value.trim());
  return Number.isFinite(n) ? n : undefined;
}

/** Parses a USD price string (`"9.73"`) into whole cents. */
export function toCents(value: unknown): number | undefined {
  const text = typeof value === "string" ? value.replace(/[$,\s]/g, "") : value;
  const amount = toNumber(text);
  return amount === undefined || amount < 0 ? undefined : Math.round(amount * 100);
}

/** `$9.73` for 973 cents. */
export function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** Porkbun flags arrive as 1/0, "1"/"0", "yes"/"no" or booleans. */
export function toFlag(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (["1", "yes", "true", "on"].includes(v)) return true;
    if (["0", "no", "false", "off", ""].includes(v)) return false;
  }
  return undefined;
}

/** Porkbun dates (`2026-10-13 10:00:00`, assumed UTC — confirm live) as ISO 8601. */
export function toIsoDate(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const text = value.trim();
  const utc = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)
    ? `${text.replace(" ", "T")}Z`
    : text;
  const date = new Date(utc);
  return Number.isNaN(date.getTime()) ? text : date.toISOString();
}

/** Every Porkbun answer: `status` plus, on errors, `code`, `message` and `next_action`. */
export const EnvelopeSchema = z.looseObject({
  status: z.string().optional(),
  code: z.string().optional(),
  message: z.string().optional(),
  requestId: z.string().optional(),
  account: z.string().optional(),
  requiredScope: z.string().optional(),
  keyScopes: z.array(z.string()).optional(),
  cost: Numeric.optional(),
  balance: Numeric.optional(),
  shortfall: Numeric.optional(),
  limitSource: z.string().optional(),
  ttlRemaining: Numeric.optional(),
  retryAfter: Numeric.optional(),
  next_action: z
    .looseObject({
      type: z.string().optional(),
      hint: z.string().optional(),
      url: z.string().optional(),
      retryable: z.boolean().optional(),
    })
    .nullable()
    .optional(),
});
export type Envelope = z.infer<typeof EnvelopeSchema>;

export const PingSchema = z.looseObject({
  credentialsValid: z.boolean().optional(),
  account: z.string().optional(),
  scopes: z.array(z.string()).optional(),
  yourIp: z.string().optional(),
});

/** One domain of a single or bulk availability check. */
export const AvailabilitySchema = z.looseObject({
  avail: z.string(),
  price: Numeric.nullable().optional(),
  premium: z.union([z.string(), z.boolean()]).nullable().optional(),
  minDuration: Numeric.nullable().optional(),
  inYourAccount: z.boolean().nullable().optional(),
  idnLanguages: z.array(z.unknown()).nullable().optional(),
  additional: z
    .looseObject({
      renewal: z.looseObject({ price: Numeric.nullable().optional() }).nullable().optional(),
    })
    .nullable()
    .optional(),
});

/** An empty PHP object arrives as `[]`. */
const EmptyAsRecord = z.array(z.never()).transform((): Record<string, never> => ({}));

export const BulkCheckSchema = z.looseObject({
  domains: z.union([z.record(z.string(), AvailabilitySchema), EmptyAsRecord]).optional(),
  unresolved: z.array(z.string()).nullable().optional(),
  invalid: z
    .array(
      z.union([
        z.string(),
        z.looseObject({
          domain: z.string().optional(),
          name: z.string().optional(),
          reason: z.string().optional(),
          message: z.string().optional(),
        }),
      ]),
    )
    .nullable()
    .optional(),
});

export const RequirementsSchema = z.looseObject({
  tld: z.string().optional(),
  apiRegisterable: z.boolean(),
  registrationDurationYears: Numeric.nullable().optional(),
  notApiRegisterableReason: z.string().nullable().optional(),
});

export const CreatedSchema = z.looseObject({
  domain: z.string().optional(),
  cost: Numeric.optional(),
  orderId: Numeric,
  balance: Numeric.optional(),
});

export const PreviewSchema = z.looseObject({
  dryRun: z.literal(true),
  wouldSucceed: z.boolean(),
  domain: z.string().optional(),
  cost: Numeric,
  duration: Numeric.optional(),
  balance: Numeric.optional(),
  sufficientFunds: z.boolean().optional(),
  shortfall: Numeric.optional(),
  withinMonthlySpendLimit: z.boolean().optional(),
  message: z.string().optional(),
});

export const DomainSchema = z.looseObject({
  domain: z.string(),
  status: z.string().nullable().optional(),
  createDate: z.string().nullable().optional(),
  expireDate: z.string().nullable().optional(),
  securityLock: z.unknown().optional(),
  whoisPrivacy: z.unknown().optional(),
  autoRenew: z.unknown().optional(),
  apiAccess: z.unknown().optional(),
});

export const GetDomainSchema = z.looseObject({ domain: DomainSchema });

export const AutoRenewSchema = z.looseObject({
  results: z
    .union([
      z.record(
        z.string(),
        z.looseObject({ status: z.string().optional(), message: z.string().optional() }),
      ),
      EmptyAsRecord,
    ])
    .optional(),
});

export const NsSchema = z.looseObject({ ns: z.array(z.string()).nullable().optional() });

export const RecordsSchema = z.looseObject({
  records: z.array(
    z.looseObject({
      id: Numeric.optional(),
      name: z.string(),
      type: z.string(),
      content: z.string(),
      ttl: Numeric.nullable().optional(),
      prio: Numeric.nullable().optional(),
    }),
  ),
});

const DnssecItem = z.looseObject({
  keyTag: Numeric.optional(),
  alg: Numeric.optional(),
  digestType: Numeric.optional(),
  digest: z.string().optional(),
});

export const DnssecSchema = z.looseObject({
  records: z
    .union([z.record(z.string(), DnssecItem), z.array(DnssecItem)])
    .nullable()
    .optional(),
});

export const BalanceSchema = z.looseObject({ balance: Numeric });

/** DS records from a DNSSEC answer; key-data-only entries (no digest) are skipped. */
export function toDsRecords(raw: z.infer<typeof DnssecSchema>): DsRecord[] {
  const items = raw.records ? Object.values(raw.records) : [];
  const out: DsRecord[] = [];
  for (const item of items) {
    const keyTag = toNumber(item.keyTag);
    const algorithm = toNumber(item.alg);
    const digestType = toNumber(item.digestType);
    if (keyTag === undefined || algorithm === undefined || digestType === undefined) continue;
    if (!item.digest) continue;
    out.push({ keyTag, algorithm, digestType, digest: item.digest });
  }
  return out;
}
