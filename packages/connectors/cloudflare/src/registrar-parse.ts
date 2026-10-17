import type {
  Currency,
  DomainCheck,
  Money,
  RegisteredDomain,
  RegistrationState,
  RegistrationStatus,
} from "@opscrew/contracts";
import { DOMAIN_TAKEN_REASON, isoDateOr } from "@opscrew/core";
import { z } from "zod";

/** Where users buy what the API cannot (premium names, some extensions). */
export const CLOUDFLARE_REGISTRAR_DASHBOARD = "https://dash.cloudflare.com (Domain Registration)";

const REASONS: Record<string, string> = {
  domain_premium: `This is a premium domain; Cloudflare sells premium names only in the dashboard, so buy it at ${CLOUDFLARE_REGISTRAR_DASHBOARD}.`,
  domain_unavailable: DOMAIN_TAKEN_REASON,
  extension_not_supported_via_api: `Cloudflare sells this extension, but not through its API; buy it at ${CLOUDFLARE_REGISTRAR_DASHBOARD}.`,
  extension_not_supported: "Cloudflare Registrar does not sell this extension.",
  extension_disallows_registration:
    "The registry of this extension does not accept new registrations.",
};

/** Plain English for a known Cloudflare Registrar `reason` code, else undefined. */
export function knownReasonText(code: string): string | undefined {
  return Object.hasOwn(REASONS, code) ? REASONS[code] : undefined;
}

/** Plain English for a Cloudflare Registrar `reason` code (unknown codes are named as-is). */
export function registrarReasonText(code: string): string {
  return knownReasonText(code) ?? `Cloudflare cannot register this domain (${code}).`;
}

const PricingSchema = z.looseObject({
  currency: z.string().optional(),
  registration_cost: z.union([z.string(), z.number()]).optional(),
  renewal_cost: z.union([z.string(), z.number()]).optional(),
});

/** One domain in a domain-check or domain-search answer (the documented fields). */
const DomainItemSchema = z.looseObject({
  name: z.string().min(1),
  registrable: z.boolean().optional(),
  tier: z.string().nullable().optional(),
  pricing: PricingSchema.nullable().optional(),
  reason: z.string().nullable().optional(),
});

/** The `result` of a domain-check or domain-search answer: `{ domains: [...] }`. */
export const DomainListSchema = z
  .looseObject({ domains: z.array(DomainItemSchema) })
  .transform((r) => r.domains);

const SUPPORTED_CURRENCIES: readonly Currency[] = ["USD", "EUR"];

/** Parses a price that Cloudflare sends as a string (`"8.57"`) into a number. */
function parseAmount(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  const text = typeof value === "number" ? String(value) : value.replace(/[^0-9.]/g, "");
  if (text === "") return undefined;
  const amount = Number(text);
  return Number.isFinite(amount) && amount >= 0 ? amount : undefined;
}

function money(amount: number | undefined, currency: Currency): Money | undefined {
  return amount === undefined ? undefined : { amount, currency };
}

/**
 * Maps one domain from Cloudflare to a {@link DomainCheck}. Conservative: a registrable domain
 * without a usable price, or a premium one, is reported as not registrable through the API.
 */
export function toDomainCheck(
  item: z.infer<typeof DomainItemSchema>,
  registrableByDefault: boolean,
): DomainCheck {
  const domain = item.name.toLowerCase();
  const tier = item.tier === "premium" || item.tier === "standard" ? item.tier : undefined;
  const base: DomainCheck = { domain, registrable: false, ...(tier ? { tier } : {}) };
  const registrable = item.registrable ?? registrableByDefault;
  if (!registrable) {
    const code = item.reason ?? (tier === "premium" ? "domain_premium" : "domain_unavailable");
    return { ...base, reason: registrarReasonText(code) };
  }
  if (tier === "premium") return { ...base, reason: registrarReasonText("domain_premium") };
  const currency = item.pricing?.currency?.trim().toUpperCase();
  if (currency && !SUPPORTED_CURRENCIES.includes(currency as Currency)) {
    return {
      ...base,
      reason: `Cloudflare quoted this domain in ${currency}, which OpsCrew cannot show yet; buy it at ${CLOUDFLARE_REGISTRAR_DASHBOARD}.`,
    };
  }
  const firstYear = money(parseAmount(item.pricing?.registration_cost), currency as Currency);
  if (!currency || !firstYear) {
    return {
      ...base,
      reason: "Cloudflare did not return a price for this domain; try again in a minute.",
    };
  }
  const renewal = money(parseAmount(item.pricing?.renewal_cost), currency as Currency);
  return { ...base, registrable: true, firstYear, ...(renewal ? { renewal } : {}) };
}

/** A registration workflow status (answer to create or registration-status). */
export const WorkflowSchema = z.looseObject({
  domain_name: z.string().optional(),
  state: z.string().optional(),
  error: z
    .looseObject({
      code: z.union([z.string(), z.number()]).nullable().optional(),
      message: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
});

const STATES: readonly RegistrationState[] = [
  "pending",
  "in_progress",
  "action_required",
  "blocked",
  "succeeded",
  "failed",
];

/**
 * Maps a workflow answer to a {@link RegistrationStatus}. Only an explicit `succeeded` state counts
 * as success: a missing or unknown state (whatever the HTTP status) is `in_progress`, and the
 * caller polls the registration status to confirm it.
 */
export function toRegistrationStatus(
  raw: z.infer<typeof WorkflowSchema>,
  domain: string,
): RegistrationStatus {
  const reported = raw.state?.trim().toLowerCase();
  const known = STATES.find((s) => s === reported);
  const state: RegistrationState = known ?? "in_progress";
  const name = (raw.domain_name ?? domain).toLowerCase();
  const detail = (raw.error?.message ?? "").trim().replace(/\.$/, "");
  const code = raw.error?.code;
  const why = detail || (code !== undefined && code !== null ? `error ${code}` : "");
  const suffix = why ? `: ${why}` : "";
  switch (state) {
    case "action_required":
      return {
        domain: name,
        state,
        message: `Cloudflare needs an action from you before it can register ${name}${suffix}. Finish it at ${CLOUDFLARE_REGISTRAR_DASHBOARD}.`,
      };
    case "blocked":
      return {
        domain: name,
        state,
        message: `Cloudflare blocked the registration of ${name}${suffix}. Check the account's payment method, verified email and default registrant contact at ${CLOUDFLARE_REGISTRAR_DASHBOARD}.`,
      };
    case "failed":
      return {
        domain: name,
        state,
        message: `The registration of ${name} failed${suffix}.`,
      };
    default:
      if (!known && reported && state === "in_progress") {
        return { domain: name, state, message: `Cloudflare reported the state "${reported}".` };
      }
      return { domain: name, state };
  }
}

/** A domain registration as Cloudflare returns it (the documented fields). */
export const RegistrationSchema = z.looseObject({
  domain_name: z.string().optional(),
  created_at: z.string().nullable().optional(),
  expires_at: z.string().nullable().optional(),
  auto_renew: z.boolean().nullable().optional(),
  locked: z.boolean().nullable().optional(),
  privacy_mode: z.string().nullable().optional(),
});

/** Maps a Cloudflare registration to a {@link RegisteredDomain}. */
export function toRegisteredDomain(
  raw: z.infer<typeof RegistrationSchema>,
  domain: string,
): RegisteredDomain {
  return {
    domain: (raw.domain_name ?? domain).toLowerCase(),
    registrar: "cloudflare",
    ...(raw.created_at ? { createdAt: isoDateOr(raw.created_at) } : {}),
    ...(raw.expires_at ? { expiresAt: isoDateOr(raw.expires_at) } : {}),
    autoRenew: raw.auto_renew ?? false,
    ...(raw.locked != null ? { locked: raw.locked } : {}),
    ...(raw.privacy_mode != null ? { privacy: raw.privacy_mode !== "off" } : {}),
  };
}

/** A TLD's registrar settings; only whether contact extensions are required is used. */
export const ExtensionSchema = z.looseObject({
  contact_extensions_required: z.boolean().optional(),
  requires_contact_extensions: z.boolean().optional(),
  contact_extensions: z.unknown().optional(),
});

/** True when the extension asks for registrant contact extensions (.us, .uk, .ca …). */
export function needsContactExtensions(raw: z.infer<typeof ExtensionSchema>): boolean {
  const flag = raw.contact_extensions_required ?? raw.requires_contact_extensions;
  if (flag !== undefined) return flag;
  const extensions = raw.contact_extensions;
  if (Array.isArray(extensions)) return extensions.length > 0;
  if (extensions && typeof extensions === "object") return Object.keys(extensions).length > 0;
  return false;
}
