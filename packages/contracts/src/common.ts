/** Severity levels shared by findings, policy results and verification checks (most severe first). */
export const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
export type Severity = (typeof SEVERITIES)[number];

/** ISO-8601 timestamp in UTC, for example `2026-10-11T14:03:00.000Z`. */
export type IsoDateTime = string;

/** Supported currencies for cost estimates. */
export type Currency = "EUR" | "USD";

/** An amount of money. `amount` is a decimal number in the currency's major unit. */
export interface Money {
  amount: number;
  currency: Currency;
}

/**
 * Shape of every error that is safe to show to a user: a stable machine code, a plain-English
 * message and an optional next step. Implemented by `OpsCrewError` in `@opscrew/core` and by
 * package-specific errors (for example artefact validation errors in `@opscrew/plan-schema`).
 */
export interface UserFacingError {
  code: string;
  message: string;
  hint?: string;
}
