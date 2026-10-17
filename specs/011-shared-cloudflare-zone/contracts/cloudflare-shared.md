# Contract: Cloudflare shared resources (`@opscrew/connector-cloudflare`, T1102)

Owner: `@opscrew/connector-cloudflare` (exported from its root). Consumers: agents (provision, dns,
domain connect, destroy, drift, init).

```ts
/** The phases OpsCrew keeps one shared rule in, and the rule's fixed `ref`. */
export const SHARED_RULES: {
  readonly "opscrew-block-probes": { phase: "http_request_firewall_custom" };
  readonly "opscrew-strict-tls": { phase: "http_config_settings" };
};
export type SharedRuleRef = keyof typeof SHARED_RULES;

export interface SharedFacts {
  zoneId: string;
  accountId: string;
  /** Per phase: the entrypoint ruleset (absent when Cloudflare answered 404). */
  entrypoints: Record<string, { id: string; rules: { id: string; ref?: string; enabled: boolean;
    action: string; expression: string; actionParameters?: unknown }[] } | undefined>;
  /** Present only when Access is wanted. */
  organization?: { authDomain: string } | undefined;
  oneTimePinId?: string | undefined;
}

export interface SharedDesired {
  /** This app's hostnames, lower case (empty on destroy). */
  hostnames: string[];
  /** Access wanted: ensure the organization (with this auth domain) and the one-time PIN. */
  access?: { authDomain: string; oneTimePin: boolean };
}

/** `.opscrew/cloudflare.json` (data-model.md), or undefined when the app has none yet. */
export interface SharedRecord {
  zoneId: string;
  hostnames: Partial<Record<SharedRuleRef, string[]>>;
  createdEntrypoints: string[];
}

export function inspectShared(
  client: CloudflareClient,
  opts: { zoneId: string; accountId: string; access: boolean },
): Promise<SharedFacts>;

/** Pure: the changes, blocking findings and the plan's SHA-256 (`plan.hash`). */
export function planShared(
  facts: SharedFacts,
  desired: SharedDesired,
  record: SharedRecord | undefined,
): SharedPlan;

/**
 * Applies an approved plan: throws OpsCrewError PLAN_HASH_MISMATCH when `approvedHash` differs,
 * PHASE_PRECONDITION when the plan has findings or OpsCrew's rule changed since the plan (nothing
 * written), and SharedApplyError {applied, record} when a write fails part-way.
 */
export function applyShared(
  client: CloudflareClient,
  plan: SharedPlan,
  opts: { approvedHash: string },
): Promise<{ applied: string[]; record: SharedRecord; organization?: { authDomain: string };
  oneTimePinId?: string }>;
```

Rules:
- `PUT` is sent to an entrypoint only when the inspection found none, and then carries only
  OpsCrew's rule.
- Every write is followed by checking the returned ruleset.
- A rule OpsCrew did not create is never written: OpsCrew changes or deletes only rules found by
  its fixed `ref`.
- The organization and the identity provider are created when absent and never deleted. Nothing
  else in the account is touched.
- Writes are never retried after a 5xx, a timeout or a lost connection. The error says the change
  may have reached Cloudflare, and that re-running shows the current state.
- `findings` codes are `hostname-claimed`, `no-rule-slot`, `expression-too-long`, `rule-changed`
  and `permission-missing`. Each comes with a plain message and the next step.
