import type { ComputeOffer, Currency, Money, ProviderExtras } from "@opscrew/contracts";
import { type CostEstimate, CostEstimateSchema } from "@opscrew/plan-schema";
import { designWording } from "./wording";

/** Fixed approximate exchange rate used for budget comparisons: 1 EUR = 1.10 USD. */
export const USD_PER_EUR = 1.1;

/**
 * Sentences stating the exchange rate, shown whenever a budget is compared across currencies. The
 * rate stays fixed so estimates are reproducible; the user can get an exact figure themselves.
 */
export const EXCHANGE_RATE_NOTE =
  "Converted at a fixed approximate rate of 1 EUR = 1.10 USD. For an exact figure, look up today's rate, or ask your AI assistant to search the web for it and convert.";

/** Automated backup surcharge when neither the catalogue nor the caller gives one (Hetzner's). */
const DEFAULT_BACKUP_PERCENT = 20;

/** Rounds to cents. */
export function roundCents(amount: number): number {
  return Math.round((amount + Number.EPSILON) * 100) / 100;
}

/** Converts money between EUR and USD at {@link USD_PER_EUR}, rounded to cents. */
export function convertMoney(money: Money, to: Currency): Money {
  if (money.currency === to) return { amount: roundCents(money.amount), currency: to };
  const amount = to === "USD" ? money.amount * USD_PER_EUR : money.amount / USD_PER_EUR;
  return { amount: roundCents(amount), currency: to };
}

/** `estimate as of 2026-06-15` for static prices, `live price` for prices read from the API. */
export function priceLabel(cost: Pick<CostEstimate, "source" | "asOf">): string {
  return cost.source === "static" ? `estimate as of ${cost.asOf.slice(0, 10)}` : "live price";
}

/** Where a rate in an estimate with a live server price comes from, when not from the API. */
export interface RateSource {
  /** `DigitalOcean's published rate as of 2026-10-12` or `OpsCrew's default rate`. */
  rate: string;
  /** Why: `the API does not return it` or `Hetzner's API did not return one`. */
  reason: string;
  /** Appended to the breakdown line, after a comma. */
  item: string;
  /** Date the rate is valid for, when it has one (a published price list). */
  asOf?: string;
}

/** The rates of an estimate that were not read from the provider's API, by line. */
export interface NonLiveRates {
  ipv4?: RateSource;
  backups?: RateSource;
}

/**
 * The rates in an estimate for a live `offer` that were not read from the provider's API in this
 * run: the IPv4 price and backup percentage from static extras (DigitalOcean's published price
 * page) and a backup percentage that is the provider profile's or OpsCrew's default because the
 * extras have none. Empty for a static offer: the whole estimate is then dated as one.
 */
function nonLiveRates(
  offer: Pick<ComputeOffer, "provider" | "source">,
  extras: ProviderExtras,
  options: { backups: boolean },
): NonLiveRates {
  if (offer.source !== "live") return {};
  const name =
    offer.provider === "hetzner" || offer.provider === "digitalocean"
      ? designWording(offer.provider).name
      : offer.provider;
  const date = extras.asOf.slice(0, 10);
  const published: RateSource = {
    rate: `${name}'s published rate as of ${date}`,
    reason: "the API does not return it",
    item: `${name}'s published rate as of ${date}`,
    asOf: extras.asOf,
  };
  const out: NonLiveRates = {};
  if (extras.ipv4Monthly !== undefined && extras.source !== "live") out.ipv4 = published;
  if (options.backups) {
    if (extras.backupPercent === undefined) {
      out.backups = {
        rate: "OpsCrew's default rate",
        reason: `${name}'s API did not return one`,
        item: `OpsCrew's default rate, not from ${name}'s API`,
      };
    } else if (extras.source !== "live") {
      out.backups = published;
    }
  }
  return out;
}

/**
 * Monthly cost of running `offer`: server + primary IPv4 (only when the provider prices it
 * separately) + automated backups (percentage of the server price) when `backups` is on. The
 * backup percentage comes from `extras`, else `options.backupPercent` (the provider profile's),
 * else 20. Each line is rounded to cents and the total is their sum, in the offer's currency.
 *
 * The estimate is `live` only when every number in it was read from the provider's API in this
 * run. With a live offer, a line whose rate was not (see {@link nonLiveRates}) names where it comes
 * from, and the estimate is `static`, dated by the published price list when one is used, else
 * by the offer. Validated with `CostEstimateSchema`.
 */
export function costFor(
  offer: ComputeOffer,
  extras: ProviderExtras,
  options: { backups: boolean; backupPercent?: number },
): CostEstimate {
  return pricedOffer(offer, extras, options).cost;
}

/** {@link costFor}, with the rates in it that were not read from the provider's API. */
export function pricedOffer(
  offer: ComputeOffer,
  extras: ProviderExtras,
  options: { backups: boolean; backupPercent?: number },
): { cost: CostEstimate; rates: NonLiveRates } {
  const currency = offer.monthly.currency;
  const server = roundCents(offer.monthly.amount);
  const breakdown: CostEstimate["breakdown"] = [
    {
      item: `Server ${offer.id} (${offer.location})`,
      monthly: { amount: server, currency },
    },
  ];
  const rates = nonLiveRates(offer, extras, options);
  if (extras.ipv4Monthly !== undefined) {
    breakdown.push({
      item: rates.ipv4 ? `Primary IPv4 address (${rates.ipv4.item})` : "Primary IPv4 address",
      monthly: convertMoney(extras.ipv4Monthly, currency),
    });
  }
  if (options.backups) {
    const percent = extras.backupPercent ?? options.backupPercent ?? DEFAULT_BACKUP_PERCENT;
    const note = rates.backups ? `, ${rates.backups.item}` : "";
    breakdown.push({
      item: `Automated backups (${percent}% of the server price${note})`,
      monthly: { amount: roundCents((server * percent) / 100), currency },
    });
  }
  const total = roundCents(breakdown.reduce((sum, line) => sum + line.monthly.amount, 0));
  const live = offer.source === "live" && rates.ipv4 === undefined && rates.backups === undefined;
  // A mixed estimate is only as fresh as its published price list; without one, as the offer.
  const asOf = rates.ipv4?.asOf ?? rates.backups?.asOf ?? offer.asOf;
  const cost = CostEstimateSchema.parse({
    monthly: { amount: total, currency },
    breakdown,
    pricesIncludeVat: offer.pricesIncludeVat,
    source: live ? "live" : "static",
    asOf,
  });
  return { cost, rates };
}
