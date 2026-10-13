import type { ErrorCode } from "@opscrew/core";
import { dollars, type Envelope, toNumber } from "./parse";

/** Porkbun's account pages (domain management, API keys, credit). */
export const PORKBUN_DASHBOARD_URL = "https://porkbun.com/account";
export const PORKBUN_API_SETTINGS_URL = "https://porkbun.com/account/api";
export const PORKBUN_CREDIT_URL = "https://porkbun.com/account/credit";
export const PORKBUN_WEBSITE = "https://porkbun.com";

/** What to do when the keys are wrong or missing. Never a colon right after a variable name. */
export const KEYS_HINT = `Check PORKBUN_API_KEY and PORKBUN_SECRET_API_KEY; create or copy API keys at ${PORKBUN_API_SETTINGS_URL}.`;

const CREDENTIAL_CODES = new Set([
  "API_KEY_REQUIRED",
  "INVALID_API_KEYS_001",
  "INVALID_TOKEN",
  "INVALID_USER",
]);

/**
 * Error codes on which Porkbun states that a `/domain/create` call was refused before anything was
 * bought. Only these, with a 4xx status and a Porkbun error answer, count as a clear rejection;
 * every other unusable answer (including the idempotency conflicts) may mean the purchase started.
 */
export const PURCHASE_REJECTION_CODES: ReadonlySet<string> = new Set([
  ...CREDENTIAL_CODES,
  "API_ACCESS_DISABLED",
  "COST_MISMATCH",
  "DOMAIN_NOT_ALLOWED",
  "DOMAIN_NOT_AVAILABLE",
  "ID_VERIFICATION_REQUIRED",
  "IDN_LANGUAGE_REQUIRED",
  "INSUFFICIENT_FUNDS",
  "INSUFFICIENT_SCOPE",
  "INVALID_DOMAIN",
  "INVALID_IDN_LANGUAGE",
  "INVALID_INPUT",
  "INVALID_OR_EMPTY_JSON",
  "INVALID_PROTOCOL",
  "IP_NOT_ALLOWED",
  "METHOD_NOT_ALLOWED",
  "MISSING_PARAMETER",
  "MONTHLY_SPEND_LIMIT_EXCEEDED",
  "NEW_ACCOUNT_LIMIT",
  "ORDER_FAILED",
  "ORDER_TOO_LARGE",
  "ORDERS_BLOCKED",
  "RATE_LIMIT_EXCEEDED",
  "REGISTRANT_EMAIL_NOT_ACCEPTED",
  "TERMS_NOT_AGREED",
  "VERIFICATION_REQUIRED",
]);

/** A plain-English problem built from a Porkbun error answer. */
export interface Problem {
  code: ErrorCode;
  message: string;
  hint: string;
}

export interface ProblemContext {
  /** What OpsCrew tried, as a verb phrase ("read the nameservers of example.com"). */
  what: string;
  domain?: string;
}

function websiteThenConnect(domain: string): string {
  return `Buy ${domain} on ${PORKBUN_WEBSITE} instead, then run \`opscrew domain connect ${domain}\`.`;
}

/** Plain English for one Porkbun error answer (without Porkbun's hint or request id). */
function describe(status: number, body: Envelope, ctx: ProblemContext): Problem {
  const domain = ctx.domain ?? "the domain";
  const account = body.account ? ` ${body.account}` : "";
  const code = body.code ?? "";
  if (CREDENTIAL_CODES.has(code) || (status === 401 && !code)) {
    return {
      code: "CREDENTIALS_INVALID",
      message: "Porkbun did not accept the API keys.",
      hint: KEYS_HINT,
    };
  }
  switch (code) {
    case "IP_NOT_ALLOWED":
      return {
        code: "CREDENTIALS_INVALID",
        message:
          "This Porkbun API key only accepts requests from certain IP addresses, and this computer's address is not one of them.",
        hint: `Add this computer's public IP address to the key's IP allowlist at ${PORKBUN_API_SETTINGS_URL} (the gear icon next to the key), or remove the allowlist.`,
      };
    case "DOMAIN_NOT_ALLOWED":
      return {
        code: "CREDENTIALS_INVALID",
        message: `This Porkbun API key is limited to certain domains, and ${domain} is not one of them.`,
        hint: `Add ${domain} to the key's domain allowlist at ${PORKBUN_API_SETTINGS_URL} (the gear icon next to the key).`,
      };
    case "INSUFFICIENT_SCOPE": {
      const scope = body.requiredScope ?? "needed";
      return {
        code: "CREDENTIALS_INVALID",
        message: `This Porkbun API key does not have the ${scope} permission, which it needs to ${ctx.what}.`,
        hint: `Give the key the ${scope} permission at ${PORKBUN_API_SETTINGS_URL} (the gear icon next to the key), or create a key that has it.`,
      };
    }
    case "API_ACCESS_DISABLED":
      return {
        code: "PHASE_PRECONDITION",
        message: `API access is turned off for ${domain} in the Porkbun account${account}.`,
        hint: `Turn on API access for ${domain} (or "Opt In All Domains") at ${PORKBUN_DASHBOARD_URL}, then run the command again.`,
      };
    case "DOMAIN_NOT_FOUND":
      return {
        code: "PHASE_PRECONDITION",
        message: `${domain} is not in the Porkbun account${account}.`,
        hint: "Check the spelling, or use the API keys of the Porkbun account that holds the domain.",
      };
    case "DOMAIN_NOT_ACTIVE":
      return {
        code: "PHASE_PRECONDITION",
        message: `${domain} cannot be managed at Porkbun right now (for example, it is pending or expired).`,
        hint: `Look at ${domain} at ${PORKBUN_DASHBOARD_URL}.`,
      };
    case "INSUFFICIENT_FUNDS": {
      const cost = toNumber(body.cost);
      const balance = toNumber(body.balance);
      const shortfall = toNumber(body.shortfall);
      const covers = cost === undefined ? "this purchase" : dollars(cost);
      const have = balance === undefined ? "" : ` (${dollars(balance)})`;
      const short = shortfall === undefined ? "" : ` (short by ${dollars(shortfall)})`;
      return {
        code: "PHASE_PRECONDITION",
        message: `Your Porkbun account credit${have} does not cover ${covers}${short}.`,
        hint: `Add credit at ${PORKBUN_CREDIT_URL} (Porkbun does not charge a saved card by itself), then run the command again.`,
      };
    }
    case "MONTHLY_SPEND_LIMIT_EXCEEDED":
      return {
        code: "PHASE_PRECONDITION",
        message: `This purchase would take this month's Porkbun API spending past the account's monthly limit${body.limitSource === "default" ? " ($100 a month unless you set your own)" : ""}.`,
        hint: `The account holder can raise the limit at ${PORKBUN_API_SETTINGS_URL}. ${websiteThenConnect(domain)}`,
      };
    case "ORDER_TOO_LARGE":
      return {
        code: "PHASE_PRECONDITION",
        message: `Porkbun does not take API orders over $100, and ${domain} costs more.`,
        hint: websiteThenConnect(domain),
      };
    case "COST_MISMATCH":
      return {
        code: "PHASE_PRECONDITION",
        message: `The price of ${domain} at Porkbun changed since it was quoted.`,
        hint: "Run the command again to see and approve the new price.",
      };
    case "DOMAIN_NOT_AVAILABLE":
      return {
        code: "PHASE_PRECONDITION",
        message: `${domain} is not available for registration at Porkbun.`,
        hint: "Pick another name (`opscrew domain search <name>`).",
      };
    case "VERIFICATION_REQUIRED":
    case "ID_VERIFICATION_REQUIRED":
      return {
        code: "PHASE_PRECONDITION",
        message:
          "Porkbun needs the account verified (email address and phone number, or identity) before it sells domains through the API.",
        hint: `Verify the account at ${PORKBUN_DASHBOARD_URL}, then run the command again.`,
      };
    case "BULK_CHECK_TOO_MANY":
    case "BULK_CHECK_TOO_SLOW":
      return {
        code: "PROVIDER_ERROR",
        message: `Porkbun could not check that many names at once: ${body.message ?? code}.`,
        hint: "Check fewer names at a time.",
      };
  }
  if (status === 429 || code === "RATE_LIMIT_EXCEEDED") {
    return {
      code: "PROVIDER_ERROR",
      message: `Porkbun's rate limit stopped the request to ${ctx.what}.`,
      hint: "Wait a minute and try again.",
    };
  }
  const detail = (body.message ?? "").trim().replace(/\.$/, "") || code || `HTTP ${status}`;
  return {
    code: "PROVIDER_ERROR",
    message: `Porkbun could not ${ctx.what}: ${detail}${code && !detail.includes(code) ? ` (${code})` : ""}.`,
    hint:
      status >= 500
        ? "Try again in a few minutes."
        : "Check the request and try again; if it keeps failing, contact Porkbun support.",
  };
}

/** Adds Porkbun's own next step and request id to a problem. */
function withPorkbunDetails(problem: Problem, body: Envelope): Problem {
  let hint = problem.hint;
  const next = body.next_action;
  const extra = [next?.hint?.trim(), next?.url && !hint.includes(next.url) ? next.url : undefined]
    .filter((s): s is string => Boolean(s))
    .join(" ");
  if (extra) hint = `${hint} Porkbun says: ${extra}`;
  const message = body.requestId
    ? `${problem.message} (Porkbun request ${body.requestId})`
    : problem.message;
  return { ...problem, message, hint };
}

/** The problem for a failed (non-purchase) Porkbun call. */
export function porkbunProblem(status: number, body: Envelope, ctx: ProblemContext): Problem {
  return withPorkbunDetails(describe(status, body, ctx), body);
}

/** The problem for a purchase Porkbun clearly refused: nothing was bought. */
export function purchaseRejection(status: number, body: Envelope, ctx: ProblemContext): Problem {
  const base = describe(status, body, ctx);
  const rateLimited = status === 429 || body.code === "RATE_LIMIT_EXCEEDED";
  const problem: Problem = rateLimited
    ? {
        code: "PHASE_PRECONDITION",
        message: `Porkbun's rate limit stopped the purchase of ${ctx.domain ?? "the domain"} (one registration attempt per second).`,
        hint: "Wait a minute and run the command again.",
      }
    : {
        ...base,
        code: base.code === "CREDENTIALS_INVALID" ? "CREDENTIALS_INVALID" : "PHASE_PRECONDITION",
      };
  return withPorkbunDetails(
    { ...problem, message: `${problem.message} Nothing was bought.` },
    body,
  );
}
