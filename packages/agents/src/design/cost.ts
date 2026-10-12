import type { ComputeOffer, Currency, Money, ProviderExtras } from "@opscrew/contracts";
import { type CostEstimate, CostEstimateSchema } from "@opscrew/plan-schema";

/** Fixed approximate exchange rate used for budget comparisons: 1 EUR = 1.10 USD. */
export const USD_PER_EUR = 1.1;

/** Sentence stating the exchange rate, shown whenever a budget is compared across currencies. */
export const EXCHANGE_RATE_NOTE = "Converted at a fixed approximate rate of 1 EUR = 1.10 USD.";

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

/** `€6.09` or `$6.70`. */
export function formatMoney(money: Money): string {
  return `${money.currency === "EUR" ? "€" : "$"}${money.amount.toFixed(2)}`;
}

/** `estimate as of 2026-06-15` for static prices, `live price` for prices read from the API. */
export function priceLabel(cost: Pick<CostEstimate, "source" | "asOf">): string {
  return cost.source === "static" ? `estimate as of ${cost.asOf.slice(0, 10)}` : "live price";
}

/**
 * Monthly cost of running `offer`: server + primary IPv4 (only when the provider prices it
 * separately) + automated backups (percentage of the server price) when `backups` is on. The
 * backup percentage comes from `extras`, else `options.backupPercent` (the provider profile's),
 * else 20. Each line is rounded to cents and the total is their sum, in the offer's currency.
 * Validated with `CostEstimateSchema`.
 */
export function costFor(
  offer: ComputeOffer,
  extras: ProviderExtras,
  options: { backups: boolean; backupPercent?: number },
): CostEstimate {
  const currency = offer.monthly.currency;
  const server = roundCents(offer.monthly.amount);
  const breakdown: CostEstimate["breakdown"] = [
    {
      item: `Server ${offer.id} (${offer.location})`,
      monthly: { amount: server, currency },
    },
  ];
  if (extras.ipv4Monthly !== undefined) {
    breakdown.push({
      item: "Primary IPv4 address",
      monthly: convertMoney(extras.ipv4Monthly, currency),
    });
  }
  if (options.backups) {
    const percent = extras.backupPercent ?? options.backupPercent ?? DEFAULT_BACKUP_PERCENT;
    breakdown.push({
      item: `Automated backups (${percent}% of the server price)`,
      monthly: { amount: roundCents((server * percent) / 100), currency },
    });
  }
  const total = roundCents(breakdown.reduce((sum, line) => sum + line.monthly.amount, 0));
  const live = offer.source === "live" && extras.source === "live";
  return CostEstimateSchema.parse({
    monthly: { amount: total, currency },
    breakdown,
    pricesIncludeVat: offer.pricesIncludeVat,
    source: live ? "live" : "static",
    // A mixed estimate is only as fresh as its static part.
    asOf: live || offer.source === "static" ? offer.asOf : extras.asOf,
  });
}
