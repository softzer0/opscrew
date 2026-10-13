import { OpsCrewError } from "@opscrew/core";
import type { PhaseDeps } from "../context";
import type {
  BuyDomainOptions,
  BuyDomainResult,
  DomainStatusResult,
  SearchDomainsOptions,
  SearchDomainsResult,
  SetAutoRenewOptions,
} from "./types";

export type * from "./types";

function notYet(): never {
  throw new OpsCrewError("INTERNAL", "Buying domains is not implemented yet.", {
    hint: "Update OpsCrew; `opscrew domain` arrives with feature 006.",
  });
}

/** Suggestions for a name, checked live (T603). */
export async function searchDomains(
  _deps: PhaseDeps,
  _options: SearchDomainsOptions,
): Promise<SearchDomainsResult> {
  return notYet();
}

/** Buys a domain through Cloudflare and sets it up for the deployment (T603). */
export async function buyDomain(
  _deps: PhaseDeps,
  _options: BuyDomainOptions,
): Promise<BuyDomainResult> {
  return notYet();
}

/** Registrar, expiry, auto-renew, lock, privacy and DNSSEC of the plan's domain (T603). */
export async function domainStatus(
  _deps: PhaseDeps,
  _options: { account?: string } = {},
): Promise<DomainStatusResult> {
  return notYet();
}

/** Turns auto-renew of the plan's domain on or off after an approval (T603). */
export async function setDomainAutoRenew(
  _deps: PhaseDeps,
  _options: SetAutoRenewOptions,
): Promise<DomainStatusResult> {
  return notYet();
}
