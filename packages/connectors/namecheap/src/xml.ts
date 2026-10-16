import { XMLParser, XMLValidator } from "fast-xml-parser";
import { z } from "zod";

/** Tags that may repeat; always parsed as arrays so one element and many look the same. */
const ARRAY_TAGS = new Set([
  "Error",
  "Warning",
  "DomainCheckResult",
  "ProductType",
  "ProductCategory",
  "Product",
  "Price",
  "Domain",
  "Host",
  "host",
  "Nameserver",
  "List",
]);

/**
 * Attributes become `@_Name` keys; tag and attribute values stay strings (postal codes such as
 * `01234` and phone numbers must not turn into numbers).
 */
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
  parseAttributeValue: false,
  isArray: (name, _path, _leaf, isAttribute) => !isAttribute && ARRAY_TAGS.has(name),
});

/** Parses Namecheap's XML; undefined when it is not well-formed XML. */
export function parseXml(text: string): unknown {
  if (text.trim() === "" || XMLValidator.validate(text) !== true) return undefined;
  try {
    return parser.parse(text);
  } catch {
    return undefined;
  }
}

/** `true`/`True`/`TRUE` → true; everything else → false. */
export const flag = z.string().transform((v) => v.trim().toLowerCase() === "true");

/** A decimal number sent as a string. */
export const num = z.string().transform((v, ctx) => {
  const n = Number(v.trim());
  if (v.trim() === "" || !Number.isFinite(n)) {
    ctx.addIssue({ code: "custom", message: "not a number" });
    return z.NEVER;
  }
  return n;
});

/** An optional number; empty strings (`CouponPrice=""`) count as missing. */
export const optNum = z
  .string()
  .optional()
  .transform((v) => {
    if (v === undefined || v.trim() === "") return undefined;
    const n = Number(v.trim());
    return Number.isFinite(n) ? n : undefined;
  });

/** An element that may be empty (`<X />` parses as `""`). */
export function maybeEmpty<T extends z.ZodType>(schema: T) {
  return z.union([z.string().transform(() => undefined), schema]);
}

const ErrorNode = z.union([
  z.string().transform((text) => ({ text, number: undefined as string | undefined })),
  z
    .looseObject({ "#text": z.string().optional(), "@_Number": z.string().optional() })
    .transform((e) => ({ text: e["#text"] ?? "", number: e["@_Number"] })),
]);

/** The `ApiResponse` envelope every command answers with. */
export const EnvelopeSchema = z.looseObject({
  ApiResponse: z.looseObject({
    "@_Status": z.string(),
    Errors: maybeEmpty(z.looseObject({ Error: z.array(ErrorNode).optional() })).optional(),
    CommandResponse: z.unknown().optional(),
  }),
});

/** One entry of `Errors`: Namecheap's error number and its text. */
export interface NamecheapApiError {
  number?: string;
  text: string;
}

/** The useful parts of a parsed envelope. */
export interface Envelope {
  ok: boolean;
  errors: NamecheapApiError[];
  commandResponse: unknown;
}

/** Validates a parsed document as an `ApiResponse`; undefined when it is not one. */
export function toEnvelope(doc: unknown): Envelope | undefined {
  const parsed = EnvelopeSchema.safeParse(doc);
  if (!parsed.success) return undefined;
  const api = parsed.data.ApiResponse;
  const status = api["@_Status"].trim().toUpperCase();
  if (status !== "OK" && status !== "ERROR") return undefined;
  return {
    ok: status === "OK",
    errors: (api.Errors?.Error ?? []).map((e) => ({
      text: e.text.trim(),
      ...(e.number ? { number: e.number.trim() } : {}),
    })),
    commandResponse: api.CommandResponse,
  };
}

// --- Command responses (the content of `CommandResponse`) ---

export const CheckResponse = z.looseObject({
  DomainCheckResult: z.array(
    z.looseObject({
      "@_Domain": z.string(),
      "@_Available": flag,
      "@_ErrorNo": z.string().optional(),
      "@_Description": z.string().optional(),
      "@_IsPremiumName": flag.optional(),
      "@_PremiumRegistrationPrice": optNum,
      "@_PremiumRenewalPrice": optNum,
      "@_IcannFee": optNum,
    }),
  ),
});

const PriceNode = z.looseObject({
  "@_Duration": num,
  "@_DurationType": z.string().optional(),
  "@_Price": num,
  "@_PricingType": z.string().optional(),
  "@_AdditionalCost": optNum,
  "@_AdditionalCostType": z.string().optional(),
  "@_Currency": z.string(),
});

export const PricingResponse = z.looseObject({
  UserGetPricingResult: maybeEmpty(
    z.looseObject({
      ProductType: z
        .array(
          z.looseObject({
            "@_Name": z.string().optional(),
            ProductCategory: z
              .array(
                z.looseObject({
                  "@_Name": z.string(),
                  Product: z
                    .array(
                      z.looseObject({
                        "@_Name": z.string(),
                        Price: z.array(PriceNode).optional(),
                      }),
                    )
                    .optional(),
                }),
              )
              .optional(),
          }),
        )
        .optional(),
    }),
  ),
});

export const BalancesResponse = z.looseObject({
  UserGetBalancesResult: z.looseObject({
    "@_Currency": z.string(),
    "@_AvailableBalance": num,
    "@_FundsRequiredForAutoRenew": optNum,
  }),
});

export const AddressListResponse = z.looseObject({
  AddressGetListResult: maybeEmpty(
    z.looseObject({
      List: z
        .array(
          z.looseObject({
            "@_AddressId": z.string(),
            "@_AddressName": z.string().optional(),
            "@_IsDefault": flag.optional(),
          }),
        )
        .optional(),
    }),
  ),
});

const text = z.string().optional();

/** The address-book entry. Its values are personal data: never put them in errors or output. */
export const AddressInfoResponse = z.looseObject({
  GetAddressInfoResult: z.looseObject({
    AddressId: text,
    Default_YN: text,
    FirstName: text,
    LastName: text,
    JobTitle: text,
    Organization: text,
    Address1: text,
    Address2: text,
    City: text,
    StateProvince: text,
    StateProvinceChoice: text,
    Zip: text,
    Country: text,
    Phone: text,
    PhoneExt: text,
    Fax: text,
    EmailAddress: text,
  }),
});

export const CreateResponse = z.looseObject({
  DomainCreateResult: z.looseObject({
    "@_Domain": z.string(),
    "@_Registered": flag,
    "@_ChargedAmount": optNum,
    "@_OrderID": z.string().optional(),
    "@_WhoisguardEnable": flag.optional(),
    "@_NonRealTimeDomain": flag.optional(),
  }),
});

export const DomainListResponse = z.looseObject({
  DomainGetListResult: maybeEmpty(
    z.looseObject({
      Domain: z
        .array(
          z.looseObject({
            "@_Name": z.string(),
            "@_Created": z.string().optional(),
            "@_Expires": z.string().optional(),
            "@_IsExpired": flag.optional(),
            "@_IsLocked": flag.optional(),
            "@_AutoRenew": flag.optional(),
            "@_WhoisGuard": z.string().optional(),
            "@_IsOurDNS": flag.optional(),
          }),
        )
        .optional(),
    }),
  ),
  Paging: z
    .looseObject({
      TotalItems: num.optional(),
      CurrentPage: num.optional(),
      PageSize: num.optional(),
    })
    .optional(),
});

export const DnsListResponse = z.looseObject({
  DomainDNSGetListResult: z.looseObject({
    "@_IsUsingOurDNS": flag,
    Nameserver: z.array(z.string()).optional(),
  }),
});

export const SetCustomResponse = z.looseObject({
  DomainDNSSetCustomResult: z.looseObject({ "@_Updated": flag }),
});

const HostNode = z.looseObject({
  "@_Name": z.string(),
  "@_Type": z.string(),
  "@_Address": z.string(),
  "@_MXPref": optNum,
  "@_TTL": optNum,
});

export const HostsResponse = z.looseObject({
  DomainDNSGetHostsResult: maybeEmpty(
    z.looseObject({
      "@_IsUsingOurDNS": flag.optional(),
      "@_EmailType": z.string().optional(),
      Host: z.array(HostNode).optional(),
      host: z.array(HostNode).optional(),
    }),
  ),
});
