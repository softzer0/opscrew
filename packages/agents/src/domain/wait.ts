import type { Registrar, RegistrationStatus } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import type { PhaseDeps } from "../context";
import { auditDomain, DASHBOARD, errorText, providerText } from "./common";
import { removePurchaseRecord } from "./record";
import type { ResolvedDomainServices } from "./services";
import type { DomainAccount } from "./types";

/** How long OpsCrew waits for Cloudflare to finish a purchase before it stops (the rerun continues). */
export const REGISTRATION_TIMEOUT_MS = 10 * 60_000;
const FIRST_POLL_MS = 2_000;
const MAX_POLL_MS = 30_000;
/** Consecutive failed status checks tolerated while waiting (network hiccups). */
const MAX_CHECK_FAILURES = 3;

/** Everything one purchase needs. */
export interface PurchaseContext {
  deps: PhaseDeps;
  services: ResolvedDomainServices;
  registrar: Registrar;
  account: DomainAccount;
  domain: string;
  recordFile: string;
}

/** "`opscrew domain buy x` again: …", to follow "Run" or "then run". */
const again = (domain: string) =>
  `\`opscrew domain buy ${domain}\` again: OpsCrew continues the same purchase and never sends a second one.`;

/**
 * Polls the registration status (with backoff) until Cloudflare reports `succeeded`; nothing else
 * counts as bought. Never sends a purchase. Stops with a plain error on `action_required` or
 * `blocked` (record kept, the next run re-checks), `failed` (record removed; Cloudflare reports no
 * charge for a failed purchase), repeated status errors or the timeout (record kept).
 */
export async function waitForRegistration(
  ctx: PurchaseContext,
  initial: RegistrationStatus,
): Promise<void> {
  const { deps, services, domain } = ctx;
  const started = services.now();
  let status: RegistrationStatus | undefined = initial;
  let delay = FIRST_POLL_MS;
  let failures = 0;
  let announced = false;
  for (;;) {
    if (status !== undefined) {
      if (status.state === "succeeded") return;
      if (
        status.state === "action_required" ||
        status.state === "blocked" ||
        status.state === "failed"
      ) {
        throw await stopped(ctx, status);
      }
      if (!announced) {
        deps.reporter.step(`Waiting for Cloudflare to finish buying ${domain}…`);
        announced = true;
      }
    }
    const elapsed = services.now() - started;
    if (elapsed >= REGISTRATION_TIMEOUT_MS) throw timedOut(ctx, status);
    await services.sleep(Math.min(delay, REGISTRATION_TIMEOUT_MS - elapsed));
    delay = Math.min(Math.round(delay * 1.5), MAX_POLL_MS);
    try {
      status = await ctx.registrar.registrationStatus(domain);
      failures = 0;
    } catch (error) {
      failures += 1;
      const code = (error as { code?: unknown }).code;
      const credentials = code === "CREDENTIALS_MISSING" || code === "CREDENTIALS_INVALID";
      if (credentials || failures >= MAX_CHECK_FAILURES) {
        throw new OpsCrewError(
          "PROVIDER_ERROR",
          `OpsCrew could not check the purchase of ${domain}: ${errorText(deps, error)}. The purchase may still complete.`,
          { hint: `Run ${again(domain)}`, cause: error },
        );
      }
    }
  }
}

async function stopped(ctx: PurchaseContext, status: RegistrationStatus): Promise<OpsCrewError> {
  const { deps, domain } = ctx;
  await auditDomain(deps, "domain purchase", domain, `Cloudflare reported ${status.state}`);
  const said = status.message ? providerText(ctx.deps, status.message) : "";
  const because = said === "" ? "." : `: ${said}.`;
  if (status.state === "failed") {
    await removePurchaseRecord(ctx.recordFile);
    return new OpsCrewError(
      "PROVIDER_ERROR",
      `Cloudflare reported that buying ${domain} failed${because} Nothing is charged for a failed purchase.`,
      {
        hint: `OpsCrew never sends a second purchase for the same domain. Fix the cause in ${DASHBOARD} and buy ${domain} there, or pick another name with \`opscrew domain search\`. After buying it in the dashboard, run \`opscrew domain buy ${domain}\` to set it up.`,
      },
    );
  }
  const what =
    status.state === "blocked"
      ? `Cloudflare blocked the purchase of ${domain}${because}`
      : `Cloudflare needs you to act before it can finish buying ${domain}${because}`;
  return new OpsCrewError(
    "PHASE_PRECONDITION",
    `${what} Nothing is charged until the purchase succeeds.`,
    {
      hint: `Resolve it in ${DASHBOARD} (for example a missing default contact or payment method, or an unverified email address), then run ${again(domain)}`,
    },
  );
}

function timedOut(ctx: PurchaseContext, status: RegistrationStatus | undefined): OpsCrewError {
  const { domain } = ctx;
  const state = status === undefined ? "" : ` (${status.state.replace("_", " ")})`;
  return new OpsCrewError(
    "PHASE_PRECONDITION",
    `Cloudflare is still processing the purchase of ${domain}${state}. It may still complete.`,
    { hint: `Wait a few minutes, then run ${again(domain)}` },
  );
}
