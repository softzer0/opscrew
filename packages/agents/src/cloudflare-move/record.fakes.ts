/**
 * Test helpers: a plan whose app's zone moves to another Cloudflare account, its ids taken from
 * the two-account Cloudflare fake (one token per account), for the guards' tests.
 */
import {
  type FakeCloudflareAccounts,
  fakeCloudflareAccounts,
} from "@opscrew/connector-cloudflare/testing";
import { fakeSecret } from "@opscrew/core/testing";
import { type CloudflareMove, type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";

/** The zone that moves when the plan names none. */
export const MOVE_ZONE = "example.com";

/** The two accounts, A holding the zone (active) and B with it pending, and their tokens. */
export interface TwoAccounts {
  cloudflare: FakeCloudflareAccounts;
  /** A's token (`CLOUDFLARE_API_TOKEN`) and B's (`OPSCREW_NEW_CLOUDFLARE_API_TOKEN`). */
  tokens: { a: string; b: string };
  /** Both tokens as the environment holds them. */
  env: Record<string, string>;
}

export function twoAccounts(zone = MOVE_ZONE): TwoAccounts {
  const tokens = { a: fakeSecret("cloudflare-token"), b: fakeSecret("cloudflare-token") };
  const cloudflare = fakeCloudflareAccounts({
    accounts: [
      { name: "A", token: tokens.a },
      { name: "B", token: tokens.b },
    ],
    zones: [
      { name: zone, account: "A" },
      { name: zone, account: "B", status: "pending" },
    ],
  });
  return {
    cloudflare,
    tokens,
    env: { CLOUDFLARE_API_TOKEN: tokens.a, OPSCREW_NEW_CLOUDFLARE_API_TOKEN: tokens.b },
  };
}

/**
 * `plan` with the move's record of its zone (`dns.zone`, else {@link MOVE_ZONE}) from A to B at
 * `step`, an abort begun at `abort` when given.
 */
export function withCloudflareMove(
  plan: DeployPlan,
  accounts: TwoAccounts,
  step: CloudflareMove["step"] = "started",
  abort?: NonNullable<CloudflareMove["abort"]>["step"],
): DeployPlan {
  const zone = plan.dns.zone ?? MOVE_ZONE;
  const a = accounts.cloudflare.zone(zone, "A");
  const b = accounts.cloudflare.zone(zone, "B");
  return DeployPlanSchema.parse({
    ...plan,
    cloudflareMove: {
      zone,
      from: { accountId: a.accountId, zoneId: a.id },
      to: { accountId: b.accountId, zoneId: b.id },
      dsAtStart: false,
      step,
      ...(abort === undefined ? {} : { abort: { step: abort } }),
      startedAt: "2026-11-20T10:00:00.000Z",
      ...(step === "started" ? {} : { preparedAt: "2026-11-20T10:40:00.000Z" }),
      ...(step === "adopted" ? { adoptedAt: "2026-11-21T09:10:00.000Z" } : {}),
    },
  });
}

/** True when any of `texts` holds either account's token. */
export function leaksToken(accounts: TwoAccounts, ...texts: string[]): boolean {
  const all = texts.join("\n");
  return all.includes(accounts.tokens.a) || all.includes(accounts.tokens.b);
}
