import { OpsCrewError } from "@opscrew/core";
import type { z } from "zod";
import type { AddressInfoResponse } from "./xml";

/** The address-book fields the schema declares (all optional strings). */
type AddressField = keyof (typeof AddressInfoResponse)["shape"]["GetAddressInfoResult"]["shape"];
type AddressInfo = Pick<z.infer<typeof AddressInfoResponse>["GetAddressInfoResult"], AddressField>;

/** The four contacts `domains.create` requires; all get the account's default address (ADR 0009). */
const CONTACT_ROLES = ["Registrant", "Tech", "Admin", "AuxBilling"] as const;

/**
 * Each `domains.create` contact field (without the role prefix), the address-book field it comes
 * from, and for required fields the name users see in the address book.
 */
const FIELDS: readonly {
  param: string;
  from: AddressField;
  label?: string;
  format?: (value: string) => string | undefined;
}[] = [
  { param: "OrganizationName", from: "Organization" },
  { param: "JobTitle", from: "JobTitle" },
  { param: "FirstName", from: "FirstName", label: "first name" },
  { param: "LastName", from: "LastName", label: "last name" },
  { param: "Address1", from: "Address1", label: "address" },
  { param: "Address2", from: "Address2" },
  { param: "City", from: "City", label: "city" },
  { param: "StateProvince", from: "StateProvince", label: "state or province" },
  { param: "StateProvinceChoice", from: "StateProvinceChoice" },
  { param: "PostalCode", from: "Zip", label: "postal code" },
  { param: "Country", from: "Country", label: "country", format: (v) => v.toUpperCase() },
  { param: "Phone", from: "Phone", label: "phone", format: (v) => normalizePhone(v) },
  { param: "PhoneExt", from: "PhoneExt" },
  { param: "Fax", from: "Fax", format: (v) => normalizePhone(v) },
  { param: "EmailAddress", from: "EmailAddress", label: "email address" },
];

/**
 * Normalises a phone number to Namecheap's `+CCC.NNNNNNNNNN` (the address book returns
 * `91.1111111111`). Undefined when the country code cannot be told apart from the number.
 */
export function normalizePhone(raw: string): string | undefined {
  const compact = raw.replace(/[\s\-()]/g, "").replace(/^00/, "+");
  const match = /^\+?(\d{1,3})\.(\d{4,14})$/.exec(compact);
  return match ? `+${match[1]}.${match[2]}` : undefined;
}

const clean = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

const INSPECT = Symbol.for("nodejs.util.inspect.custom");

/**
 * The account's default address, held in memory only for one `domains.create` call. Its values
 * never leave this object except through {@link ContactCard.params} (the request body): JSON,
 * `toString` and `util.inspect` show the masked summary.
 */
export class ContactCard {
  /** `domains.create` field (without the role prefix) → value, in Namecheap's order. */
  readonly #values: ReadonlyMap<string, string>;

  private constructor(values: ReadonlyMap<string, string>) {
    this.#values = values;
  }

  /**
   * Builds the card from `users.address.getInfo`. An incomplete address is a plain error naming the
   * missing fields (never their values) and the address-book page.
   */
  static fromAddress(raw: AddressInfo, addressBookUrl: string): ContactCard {
    const missing = FIELDS.filter((f) => f.label && !clean(raw[f.from])).map((f) => f.label);
    if (missing.length > 0) {
      throw new OpsCrewError(
        "PHASE_PRECONDITION",
        `The default address in your Namecheap address book is missing: ${missing.join(", ")}. Namecheap needs a complete contact to register a domain. Nothing was bought.`,
        { hint: `Complete the default address at ${addressBookUrl} and run the command again.` },
      );
    }
    if (!normalizePhone(raw.Phone ?? "")) {
      throw new OpsCrewError(
        "PHASE_PRECONDITION",
        "The phone number in the default address of your Namecheap address book is not in the international format Namecheap needs (+CCC.NNNNNNNNNN: country code, a dot, then the number). Nothing was bought.",
        { hint: `Fix the phone number of the default address at ${addressBookUrl}.` },
      );
    }
    const values = new Map<string, string>();
    for (const { param, from, format } of FIELDS) {
      const value = clean(raw[from]);
      const formatted = value === undefined || format === undefined ? value : format(value);
      if (formatted) values.set(param, formatted);
    }
    return new ContactCard(values);
  }

  /** Masked summary for the approval, such as `T*** P***, US`. */
  summary(): string {
    const initial = (key: string) => `${(this.#values.get(key) ?? "").charAt(0).toUpperCase()}***`;
    return `${initial("FirstName")} ${initial("LastName")}, ${this.#values.get("Country")}`;
  }

  /** The Registrant, Tech, Admin and AuxBilling parameters of `domains.create`. */
  params(): Record<string, string> {
    const params: Record<string, string> = {};
    for (const role of CONTACT_ROLES) {
      for (const [name, value] of this.#values) params[`${role}${name}`] = value;
    }
    return params;
  }

  /**
   * Replaces any contact value in `text` (for example Namecheap echoing the phone) with `***`.
   * The country is not personal on its own and is shown in the summary anyway.
   */
  scrub(text: string): string {
    const values = new Set<string>();
    for (const [key, value] of this.#values) {
      if (key === "Country" || value.length < 2) continue;
      values.add(value);
      if (value.startsWith("+")) values.add(value.slice(1));
      const digits = value.replace(/\D/g, "");
      if (digits.length >= 6 && value.includes(".")) values.add(digits);
    }
    const phone = this.#values.get("Phone")?.split(".")[1];
    if (phone) values.add(phone);
    let out = text;
    for (const value of [...values].sort((a, b) => b.length - a.length)) {
      const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // Short values (initials, two-letter names) only as whole words, so other text stays readable.
      const pattern = value.length < 4 ? `\\b${escaped}\\b` : escaped;
      out = out.replace(new RegExp(pattern, "gi"), "***");
    }
    return out;
  }

  toJSON(): string {
    return this.summary();
  }

  toString(): string {
    return this.summary();
  }

  [INSPECT](): string {
    return `ContactCard(${this.summary()})`;
  }
}
