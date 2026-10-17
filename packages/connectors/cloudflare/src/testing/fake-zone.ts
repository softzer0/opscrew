import type { FetchLike } from "@opscrew/contracts";
import { type FakeReply, fakeFetch } from "@opscrew/core/testing";
import { CLOUDFLARE_API } from "../client";

/**
 * A fake Cloudflare zone and account behind core's `fakeFetch`, with the Rulesets behaviour the
 * live spike of research R1–R3 observed: a missing entrypoint answers 404 with code 10003; `PUT`
 * creates it (or replaces every rule of an existing one); `POST …/rules` appends; `PATCH` keeps the
 * rule's id; deleting the last rule leaves an empty ruleset; deleting a ruleset answers 204; a
 * duplicate `ref` is refused (20023), as is an expression over 4,096 characters (20127) and a rule
 * beyond the zone plan's limit (a plan the fake does not know has the Free plan's 5 custom and 10
 * configuration rules). The zone details answer with its `plan.legacy_id`. The account holds the
 * Zero Trust organization and login methods. State is plain data for assertions.
 */

/** The fake zone's id. */
export const FAKE_ZONE_ID = "0123456789abcdef0123456789abcdef";
/** The fake account's id. */
export const FAKE_ACCOUNT_ID = "fedcba9876543210fedcba9876543210";

export interface FakeRuleset {
  id: string;
  name: string;
  kind: "zone";
  phase: string;
  version: string;
  /** Rules as Cloudflare returns them. */
  rules: Record<string, unknown>[];
}

/** A request the fake received. */
export interface FakeZoneCall {
  method: string;
  path: string;
  body: unknown;
}

/** A one-shot failure of the next request matching `"METHOD /path"` (prefix). */
export interface FakeFault {
  match: string;
  reply: FakeReply;
  /** Carry the request out first: the change reaches Cloudflare, but its answer is `reply`. */
  applied?: boolean;
}

/** Rules per phase (custom, configuration) by plan, as Cloudflare enforces them. */
const LIMITS = new Map<string, [number, number]>([
  ["free", [5, 10]],
  ["pro", [20, 25]],
  ["business", [100, 50]],
  ["enterprise", [1000, 300]],
]);
const UPDATED = "2026-10-17T00:00:00.000000Z";

const ok = (result: unknown): FakeReply => ({
  body: { success: true, errors: [], messages: [], result },
});
const refuse = (status: number, code: number, message: string): FakeReply => ({
  status,
  body: { success: false, errors: [{ code, message }], messages: [], result: null },
});

/** `reply` sent the way core's `fakeFetch` sends it (a timeout and a lost connection included). */
const answer = (reply: FakeReply, ...request: Parameters<FetchLike>) =>
  fakeFetch({ "/": reply }, { base: CLOUDFLARE_API }).fetch(...request);

/** A fake zone and account; send a `CloudflareClient`'s requests to its `fetch`. */
export class FakeZone {
  /** The zone's plan as `plan.legacy_id`; undefined leaves `plan` out of the zone details. */
  plan: string | undefined = "free";
  /** The zone's entrypoint rulesets by phase. */
  readonly entrypoints = new Map<string, FakeRuleset>();
  organization: { name: string; auth_domain: string } | undefined;
  readonly providers: { id: string; name: string; type: string }[] = [];
  /** Phases whose rulesets the token may not read or change (HTTP 403). */
  readonly denied = new Set<string>();
  readonly faults: FakeFault[] = [];
  readonly calls: FakeZoneCall[] = [];
  #ids = 0;

  readonly fetch: FetchLike = async (input, init) => {
    const method = init?.method ?? "GET";
    const path = String(input).slice(CLOUDFLARE_API.length);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    this.calls.push({ method, path, body });
    const at = this.faults.findIndex((f) => `${method} ${path}`.startsWith(f.match));
    const fault = at === -1 ? undefined : this.faults.splice(at, 1)[0];
    if (!fault || fault.applied) {
      const reply = this.#handle(method, path, body);
      if (!fault) return answer(reply, input, init);
    }
    return answer((fault as FakeFault).reply, input, init);
  };

  /** Puts a rule of the user's own into the phase (creating its entrypoint), as Cloudflare would. */
  seedRule(phase: string, rule: { description: string; expression: string; action: string }) {
    const ruleset = this.entrypoints.get(phase) ?? this.#newRuleset(phase);
    this.entrypoints.set(phase, ruleset);
    ruleset.rules.push(this.#stored(rule as Record<string, unknown>));
  }

  /** The rules of the phase without OpsCrew's, as JSON text (for byte-for-byte comparisons). */
  userRulesText(phase: string): string {
    const rules = this.entrypoints.get(phase)?.rules ?? [];
    return JSON.stringify(rules.filter((r) => !String(r.ref).startsWith("opscrew-")));
  }

  /** OpsCrew's rule in the phase, as stored. */
  opscrewRule(phase: string): Record<string, unknown> | undefined {
    return this.entrypoints.get(phase)?.rules.find((r) => String(r.ref).startsWith("opscrew-"));
  }

  /** The write requests received (everything but `GET`). */
  writes(): FakeZoneCall[] {
    return this.calls.filter((c) => c.method !== "GET");
  }

  #id(): string {
    this.#ids++;
    return this.#ids.toString(16).padStart(32, "0");
  }

  #newRuleset(phase: string): FakeRuleset {
    return { id: this.#id(), name: "default", kind: "zone", phase, version: "1", rules: [] };
  }

  #stored(rule: Record<string, unknown>, id = this.#id(), version = "1"): Record<string, unknown> {
    return {
      id,
      version,
      action: rule.action,
      ...(rule.action_parameters === undefined
        ? {}
        : { action_parameters: rule.action_parameters }),
      expression: rule.expression,
      description: rule.description ?? "",
      last_updated: UPDATED,
      ref: rule.ref ?? id,
      enabled: rule.enabled ?? true,
    };
  }

  #bump(ruleset: FakeRuleset) {
    ruleset.version = String(Number(ruleset.version) + 1);
  }

  /** Why Cloudflare refuses `rule` in `ruleset` (undefined: it does not). */
  #refusal(ruleset: FakeRuleset, rule: Record<string, unknown>, replacing?: string) {
    if (String(rule.expression).length > 4096) {
      return refuse(400, 20127, "expression exceeds the maximum length of 4096 characters");
    }
    const others = ruleset.rules.filter((r) => r.id !== replacing);
    if (rule.ref !== undefined && others.some((r) => r.ref === rule.ref)) {
      return refuse(400, 20023, "a rule with the same ref already exists");
    }
    const [custom, config] = LIMITS.get(this.plan ?? "") ?? [5, 10];
    const limit = ruleset.phase === "http_request_firewall_custom" ? custom : config;
    if (!replacing && others.length >= limit) {
      return refuse(400, 20003, "exceeded the maximum number of rules in the phase");
    }
    return undefined;
  }

  #handle(method: string, path: string, body: unknown): FakeReply {
    if (method === "GET" && path === `/zones/${FAKE_ZONE_ID}`) {
      return ok({
        id: FAKE_ZONE_ID,
        name: "example.com",
        status: "active",
        ...(this.plan ? { plan: { id: "0".repeat(32), legacy_id: this.plan } } : {}),
      });
    }
    const zone = `/zones/${FAKE_ZONE_ID}/rulesets`;
    const account = `/accounts/${FAKE_ACCOUNT_ID}/access`;
    const entry = new RegExp(`^${zone}/phases/([a-z_]+)/entrypoint$`).exec(path);
    if (entry?.[1]) return this.#entrypoint(method, entry[1], body);
    const rules = new RegExp(`^${zone}/([0-9a-f]+)/rules(?:/([0-9a-f]+))?$`).exec(path);
    if (rules?.[1]) return this.#rules(method, rules[1], rules[2], body);
    const ruleset = new RegExp(`^${zone}/([0-9a-f]+)$`).exec(path);
    if (ruleset?.[1] && method === "DELETE") return this.#deleteRuleset(ruleset[1]);
    if (path === `${account}/organizations`) return this.#organizations(method, body);
    if (path === `${account}/identity_providers`) return this.#providers(method, body);
    throw new Error(`fake zone: no route for ${method} ${path}`);
  }

  #entrypoint(method: string, phase: string, body: unknown): FakeReply {
    if (this.denied.has(phase)) return refuse(403, 10000, "Authentication error");
    const existing = this.entrypoints.get(phase);
    if (method === "GET") {
      return existing
        ? ok(existing)
        : refuse(404, 10003, `could not find entrypoint ruleset in the '${phase}' phase`);
    }
    if (method !== "PUT") throw new Error(`fake zone: ${method} on an entrypoint`);
    const ruleset = existing ?? this.#newRuleset(phase);
    const sent = (body as { rules: Record<string, unknown>[] }).rules;
    const next: FakeRuleset = { ...ruleset, rules: [] };
    for (const rule of sent) {
      const refusal = this.#refusal(next, rule);
      if (refusal) return refusal;
      next.rules.push(this.#stored(rule));
    }
    if (existing) this.#bump(next);
    this.entrypoints.set(phase, next);
    return ok(next);
  }

  #find(rulesetId: string): FakeRuleset | undefined {
    return [...this.entrypoints.values()].find((r) => r.id === rulesetId);
  }

  #rules(method: string, rulesetId: string, ruleId: string | undefined, body: unknown): FakeReply {
    const ruleset = this.#find(rulesetId);
    if (!ruleset) return refuse(404, 10000, "ruleset not found");
    if (this.denied.has(ruleset.phase)) return refuse(403, 10000, "Authentication error");
    const rule = body as Record<string, unknown>;
    if (method === "POST" && !ruleId) {
      const refusal = this.#refusal(ruleset, rule);
      if (refusal) return refusal;
      ruleset.rules.push(this.#stored(rule));
      this.#bump(ruleset);
      return ok(ruleset);
    }
    const at = ruleset.rules.findIndex((r) => r.id === ruleId);
    if (at === -1) return refuse(404, 10000, "rule not found");
    if (method === "PATCH") {
      const refusal = this.#refusal(ruleset, rule, ruleId);
      if (refusal) return refusal;
      const old = ruleset.rules[at] as Record<string, unknown>;
      ruleset.rules[at] = this.#stored(rule, ruleId, String(Number(old.version) + 1));
      this.#bump(ruleset);
      return ok(ruleset);
    }
    if (method === "DELETE") {
      ruleset.rules.splice(at, 1);
      this.#bump(ruleset);
      return ok(ruleset);
    }
    throw new Error(`fake zone: ${method} on a rule`);
  }

  #deleteRuleset(rulesetId: string): FakeReply {
    const ruleset = this.#find(rulesetId);
    if (!ruleset) return refuse(404, 10000, "ruleset not found");
    this.entrypoints.delete(ruleset.phase);
    return { status: 204 };
  }

  #organizations(method: string, body: unknown): FakeReply {
    if (method === "GET") {
      return this.organization
        ? ok(this.organization)
        : refuse(404, 12130, "access.api.error.not_found: organization not found");
    }
    if (this.organization) return refuse(400, 12000, "organization already exists");
    const sent = body as { name: string; auth_domain: string };
    this.organization = { name: sent.name, auth_domain: sent.auth_domain };
    return ok(this.organization);
  }

  #providers(method: string, body: unknown): FakeReply {
    if (method === "GET") return ok(this.providers);
    const sent = body as { name: string; type: string };
    const provider = { id: this.#id(), name: sent.name, type: sent.type };
    this.providers.push(provider);
    return ok({ ...provider, config: {} });
  }
}
