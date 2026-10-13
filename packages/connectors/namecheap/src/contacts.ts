import { OpsCrewError } from "@opscrew/core";
import type { z } from "zod";
import type { AddressInfoResponse } from "./xml";

/** The address-book fields OpsCrew reads (all optional strings). */
type AddressField =
  | "FirstName"
  | "LastName"
  | "JobTitle"
  | "Organization"
  | "Address1"
  | "Address2"
  | "City"
  | "StateProvince"
  | "StateProvinceChoice"
  | "Zip"
  | "Country"
  | "Phone"
  | "PhoneExt"
  | "Fax"
  | "EmailAddress";
type AddressInfo = Pick<z.infer<typeof AddressInfoResponse>["GetAddressInfoResult"], AddressField>;

/** The four contacts `domains.create` requires; all get the account's default address (ADR 0009). */
export const CONTACT_ROLES = ["Registrant", "Tech", "Admin", "AuxBilling"] as const;

interface ContactData {
  firstName: string;
  lastName: string;
  organization?: string;
  jobTitle?: string;
  address1: string;
  address2?: string;
  city: string;
  stateProvince: string;
  stateProvinceChoice?: string;
  postalCode: string;
  country: string;
  phone: string;
  phoneExt?: string;
  fax?: string;
  email: string;
}

/** Required fields of the default address, with the names users see in the address book. */
const REQUIRED: readonly [AddressField, string][] = [
  ["FirstName", "first name"],
  ["LastName", "last name"],
  ["Address1", "address"],
  ["City", "city"],
  ["StateProvince", "state or province"],
  ["Zip", "postal code"],
  ["Country", "country"],
  ["Phone", "phone"],
  ["EmailAddress", "email address"],
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
  readonly #data: ContactData;

  private constructor(data: ContactData) {
    this.#data = data;
  }

  /**
   * Builds the card from `users.address.getInfo`. An incomplete address is a plain error naming the
   * missing fields (never their values) and the address-book page.
   */
  static fromAddress(raw: AddressInfo, addressBookUrl: string): ContactCard {
    const missing = REQUIRED.filter(([key]) => !clean(raw[key])).map(([, label]) => label);
    if (missing.length > 0) {
      throw new OpsCrewError(
        "PHASE_PRECONDITION",
        `The default address in your Namecheap address book is missing: ${missing.join(", ")}. Namecheap needs a complete contact to register a domain. Nothing was bought.`,
        { hint: `Complete the default address at ${addressBookUrl} and run the command again.` },
      );
    }
    const phone = normalizePhone(raw.Phone ?? "");
    if (!phone) {
      throw new OpsCrewError(
        "PHASE_PRECONDITION",
        "The phone number in the default address of your Namecheap address book is not in the international format Namecheap needs (+CCC.NNNNNNNNNN: country code, a dot, then the number). Nothing was bought.",
        { hint: `Fix the phone number of the default address at ${addressBookUrl}.` },
      );
    }
    const country = (clean(raw.Country) as string).toUpperCase();
    const optional = (key: AddressField) => clean(raw[key]);
    const fax = optional("Fax") ? normalizePhone(optional("Fax") as string) : undefined;
    const data: ContactData = {
      firstName: clean(raw.FirstName) as string,
      lastName: clean(raw.LastName) as string,
      address1: clean(raw.Address1) as string,
      city: clean(raw.City) as string,
      stateProvince: clean(raw.StateProvince) as string,
      postalCode: clean(raw.Zip) as string,
      country,
      phone,
      email: clean(raw.EmailAddress) as string,
    };
    const extras: [keyof ContactData, string | undefined][] = [
      ["organization", optional("Organization")],
      ["jobTitle", optional("JobTitle")],
      ["address2", optional("Address2")],
      ["stateProvinceChoice", optional("StateProvinceChoice")],
      ["phoneExt", optional("PhoneExt")],
      ["fax", fax],
    ];
    for (const [key, value] of extras) if (value) Object.assign(data, { [key]: value });
    return new ContactCard(data);
  }

  /** Masked summary for the approval, such as `T*** P***, US`. */
  summary(): string {
    const initial = (s: string) => `${s.charAt(0).toUpperCase()}***`;
    const d = this.#data;
    return `${initial(d.firstName)} ${initial(d.lastName)}, ${d.country}`;
  }

  /** The Registrant, Tech, Admin and AuxBilling parameters of `domains.create`. */
  params(): Record<string, string> {
    const d = this.#data;
    const fields: [string, string | undefined][] = [
      ["OrganizationName", d.organization],
      ["JobTitle", d.jobTitle],
      ["FirstName", d.firstName],
      ["LastName", d.lastName],
      ["Address1", d.address1],
      ["Address2", d.address2],
      ["City", d.city],
      ["StateProvince", d.stateProvince],
      ["StateProvinceChoice", d.stateProvinceChoice],
      ["PostalCode", d.postalCode],
      ["Country", d.country],
      ["Phone", d.phone],
      ["PhoneExt", d.phoneExt],
      ["Fax", d.fax],
      ["EmailAddress", d.email],
    ];
    const params: Record<string, string> = {};
    for (const role of CONTACT_ROLES) {
      for (const [name, value] of fields) if (value) params[`${role}${name}`] = value;
    }
    return params;
  }

  /**
   * Replaces any contact value in `text` (for example Namecheap echoing the phone) with `***`.
   * The country is not personal on its own and is shown in the summary anyway.
   */
  scrub(text: string): string {
    const values = new Set<string>();
    for (const [key, value] of Object.entries(this.#data)) {
      if (key === "country" || typeof value !== "string" || value.length < 2) continue;
      values.add(value);
      if (value.startsWith("+")) values.add(value.slice(1));
      const digits = value.replace(/\D/g, "");
      if (digits.length >= 6 && value.includes(".")) values.add(digits);
    }
    const phone = this.#data.phone.split(".")[1];
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
