import type { UserFacingError } from "@opscrew/contracts";
import type { z } from "zod";
import { zodIssues } from "./values";

/** Stable error codes. Add new codes here; never reuse or rename an existing one. */
export const ERROR_CODES = [
  "ARTIFACT_INVALID",
  "ARTIFACT_MISSING",
  "PLAN_NOT_APPROVED",
  "PLAN_HASH_MISMATCH",
  "DESTROY_NOT_APPROVED",
  "APPROVAL_REFUSED",
  "TOOL_DENIED",
  "ENGINE_NOT_FOUND",
  "ENGINE_FAILED",
  "CREDENTIALS_MISSING",
  "CREDENTIALS_INVALID",
  "PROVIDER_ERROR",
  "RUNTIME_NOT_CONFIGURED",
  "PHASE_PRECONDITION",
  "COMMAND_FAILED",
  "INVALID_INPUT",
  "INTERNAL",
  "SECRETS_KEY_REJECTED",
  "SECRETS_COPY_CHANGED_ELSEWHERE",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * An error that is safe to show to a user: plain-English `message`, optional `hint` with the next
 * step. Never put secrets in either field.
 */
export class OpsCrewError extends Error implements UserFacingError {
  readonly code: ErrorCode;
  readonly hint?: string;

  constructor(code: ErrorCode, message: string, options?: { hint?: string; cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "OpsCrewError";
    this.code = code;
    if (options?.hint !== undefined) this.hint = options.hint;
  }
}

/**
 * True for errors that are safe and meaningful to show as-is: an `OpsCrewError` (such as
 * `ArtifactError` from plan-schema) or a lookalike whose `code` is one of {@link ERROR_CODES}.
 * Node system errors such as `ENOENT` also carry `code` and `message` but are not user-facing.
 */
export function isUserFacingError(value: unknown): value is UserFacingError {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.message === "string" &&
    typeof candidate.code === "string" &&
    (ERROR_CODES as readonly string[]).includes(candidate.code)
  );
}

/**
 * The error for a purchase whose outcome is unknown (no clear answer, a lost connection, a
 * timeout): it may have started, so buying again could buy twice. `detail` says what the
 * registrar answered; `dashboard` is where the user checks the account's domains.
 */
export function maybeStarted(purchase: {
  registrar: string;
  domain: string;
  detail: string;
  dashboard: string;
  cause?: unknown;
}): OpsCrewError {
  const { registrar, domain, detail, dashboard, cause } = purchase;
  return new OpsCrewError(
    "PROVIDER_ERROR",
    `${registrar} gave no clear answer while registering ${domain} (${detail}). The purchase may still have started; check its status before trying again.`,
    {
      hint: `Run \`opscrew domain status\` or look at ${dashboard} before buying ${domain} again.`,
      cause,
    },
  );
}

/** Throws `INVALID_INPUT` unless `years` is a whole number of registration years from 1 to 10. */
export function checkRegistrationYears(years: number): void {
  if (!Number.isInteger(years) || years < 1 || years > 10) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `A domain can be registered for 1 to 10 years, not ${years}.`,
      { hint: "Pass a whole number of years between 1 and 10." },
    );
  }
}

/** Why a registrar cannot sell a domain someone else holds. */
export const DOMAIN_TAKEN_REASON = "This domain is already registered by someone else.";

/** The next step after a registrar's price changed since the user approved it. */
export const NEW_PRICE_HINT = "Run the command again to see and approve the new price.";

/**
 * For a domain OpsCrew cannot buy through the registrar's API: buy it `where` (for example
 * `at https://…`), then connect it.
 */
export function connectAfterBuyingHint(where: string, domain: string): string {
  return `Buy it ${where}, then run \`opscrew domain connect ${domain}\`.`;
}

/** The error's own message (`String(error)` for anything that is not an `Error`). */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * An error as one line for the user: a user-facing error's message and hint; for any other
 * error `fallback` when given, else its message.
 */
export function errorText(error: unknown, fallback?: string): string {
  if (isUserFacingError(error)) return `${error.message}${error.hint ? ` ${error.hint}` : ""}`;
  return fallback ?? errorMessage(error);
}

/** Why a phase's structured result was rejected: the format's name and the first five problems. */
export function modelOutputMismatch(format: string, error: z.ZodError): string {
  return `The model's output did not match the expected ${format} format (${zodIssues(error, 5)}).`;
}
