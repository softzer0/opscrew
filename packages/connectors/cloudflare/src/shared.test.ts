import type { FetchLike } from "@opscrew/contracts";
import { canonicalJson, OpsCrewError, sha256Hex } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { CloudflareClient } from "./client";
import {
  applyShared,
  inspectShared,
  planShared,
  SHARED_RULES,
  SharedApplyError,
  type SharedChange,
  type SharedDesired,
  type SharedPlan,
  type SharedRecord,
  SharedRecordSchema,
} from "./shared";
import { FAKE_ACCOUNT_ID as ACCOUNT_ID, FakeZone, FAKE_ZONE_ID as ZONE_ID } from "./testing";

const TOKEN = fakeSecret("cloudflare-token");
const WAF = "http_request_firewall_custom";
const CONFIG = "http_config_settings";
const BLOCK = "opscrew-block-probes";
const TLS = "opscrew-strict-tls";
const PATHS =
  'http.request.uri.path contains "/.env" or starts_with(http.request.uri.path, "/.git") or http.request.uri.path contains "/wp-admin" or http.request.uri.path contains "/wp-login.php" or http.request.uri.path contains "/xmlrpc.php" or http.request.uri.path contains "/phpmyadmin"';
const hostSet = (hosts: string[]) => `(http.host in {${hosts.map((h) => `"${h}"`).join(" ")}})`;
const blockExpression = (hosts: string[]) => `${hostSet(hosts)} and (${PATHS})`;

const A = ["shop.example.com", "www.shop.example.com"];
const B = ["api.example.com"];
const AUTH_DOMAIN = "opscrew-example.cloudflareaccess.com";

const clientFor = (zone: FakeZone, timeoutMs?: number) =>
  new CloudflareClient({
    token: TOKEN,
    fetch: zone.fetch,
    sleep: async () => {},
    ...(timeoutMs ? { timeoutMs } : {}),
  });

async function planFor(
  zone: FakeZone,
  desired: SharedDesired,
  record?: SharedRecord,
): Promise<SharedPlan> {
  const facts = await inspectShared(clientFor(zone), {
    zoneId: ZONE_ID,
    accountId: ACCOUNT_ID,
    access: desired.access !== undefined,
  });
  return planShared(facts, desired, record);
}

/** One app's provision (or destroy, with no hostnames): inspect, plan, apply the approved hash. */
async function deploy(zone: FakeZone, desired: SharedDesired, record?: SharedRecord) {
  const plan = await planFor(zone, desired, record);
  expect(plan.findings).toEqual([]);
  const result = await applyShared(clientFor(zone), plan, { approvedHash: plan.hash });
  return { plan, result };
}

const both = (hosts: string[]) => ({ [BLOCK]: hosts, [TLS]: hosts });
const kinds = (plan: SharedPlan) => plan.changes.map((c) => c.kind);
const writesSince = (zone: FakeZone, count: number) =>
  zone.calls.slice(count).filter((c) => c.method !== "GET");

async function rejection(promise: Promise<unknown>): Promise<OpsCrewError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OpsCrewError);
  return error as OpsCrewError;
}

describe("SHARED_RULES", () => {
  it("names one rule per phase by its fixed ref", () => {
    expect(SHARED_RULES).toEqual({
      "opscrew-block-probes": { phase: WAF },
      "opscrew-strict-tls": { phase: CONFIG },
    });
  });
});

describe("planShared and applyShared", () => {
  it("creates both entrypoints for the first app, from sorted lower-case hostnames, and plans nothing on a re-run", async () => {
    const zone = new FakeZone();
    const plan = await planFor(zone, {
      hostnames: both(["WWW.Shop.example.com", "shop.example.com"]),
    });
    expect(plan.findings).toEqual([]);
    expect(plan.changes).toEqual([
      {
        kind: "create-entrypoint",
        phase: WAF,
        rule: {
          ref: BLOCK,
          description: "OpsCrew: block probes for secrets and admin panels",
          expression: blockExpression(A),
          action: "block",
          enabled: true,
        },
      },
      {
        kind: "create-entrypoint",
        phase: CONFIG,
        rule: {
          ref: TLS,
          description: "OpsCrew: verify the origin certificate (Full (strict) TLS)",
          expression: '(http.host in {"shop.example.com" "www.shop.example.com"})',
          action: "set_config",
          action_parameters: { ssl: "strict" },
          enabled: true,
        },
      },
    ]);
    expect(plan.expect).toEqual({ [WAF]: null, [CONFIG]: null });
    expect(plan.hash).toBe(
      sha256Hex(
        canonicalJson({
          zoneId: ZONE_ID,
          accountId: ACCOUNT_ID,
          changes: plan.changes,
          expect: plan.expect,
        }),
      ),
    );

    const before = zone.calls.length;
    const result = await applyShared(clientFor(zone), plan, { approvedHash: plan.hash });
    expect(result).toEqual({
      applied: [`create-entrypoint ${WAF}`, `create-entrypoint ${CONFIG}`],
      record: { zoneId: ZONE_ID, hostnames: both(A), createdEntrypoints: [WAF, CONFIG] },
    });
    const writes = writesSince(zone, before);
    expect(writes.map((c) => `${c.method} ${c.path}`)).toEqual([
      `PUT /zones/${ZONE_ID}/rulesets/phases/${WAF}/entrypoint`,
      `PUT /zones/${ZONE_ID}/rulesets/phases/${CONFIG}/entrypoint`,
    ]);
    expect(writes[0]?.body).toEqual({ rules: [(plan.changes[0] as { rule: unknown }).rule] });
    expect(zone.opscrewRule(WAF)).toMatchObject({
      ref: BLOCK,
      expression: blockExpression(A),
      action: "block",
      enabled: true,
    });
    expect(zone.opscrewRule(CONFIG)).toMatchObject({
      ref: TLS,
      action_parameters: { ssl: "strict" },
    });

    const again = await planFor(zone, { hostnames: both(A) }, result.record);
    expect(again).toMatchObject({ changes: [], findings: [], expect: {}, record: result.record });
  });

  it("adds a second app's hostnames to both shared rules, and the last app removes the rules", async () => {
    const zone = new FakeZone();
    const a = await deploy(zone, { hostnames: both(A) });
    const blockRule = zone.opscrewRule(WAF);
    const b = await deploy(zone, { hostnames: both(B) });
    expect(b.plan.changes).toEqual([
      {
        kind: "update-hostnames",
        phase: WAF,
        rulesetId: zone.entrypoints.get(WAF)?.id,
        ruleId: blockRule?.id,
        add: B,
        remove: [],
      },
      {
        kind: "update-hostnames",
        phase: CONFIG,
        rulesetId: zone.entrypoints.get(CONFIG)?.id,
        ruleId: zone.opscrewRule(CONFIG)?.id,
        add: B,
        remove: [],
      },
    ]);
    expect(b.plan.expect[WAF]).toEqual({ id: blockRule?.id, hostnames: A });
    const all = [...B, ...A];
    expect(zone.opscrewRule(WAF)).toMatchObject({
      id: blockRule?.id,
      expression: blockExpression(all),
    });
    expect(zone.opscrewRule(CONFIG)?.expression).toBe(hostSet(all));
    expect(b.result.record).toEqual({
      zoneId: ZONE_ID,
      hostnames: both(B),
      createdEntrypoints: [],
    });
    expect(zone.entrypoints.get(WAF)?.rules).toHaveLength(1);
    expect((await planFor(zone, { hostnames: both(A) }, a.result.record)).changes).toEqual([]);

    const aGone = await deploy(zone, { hostnames: {} }, a.result.record);
    expect(aGone.plan.changes).toMatchObject([
      { kind: "update-hostnames", phase: WAF, add: [], remove: A },
      { kind: "update-hostnames", phase: CONFIG, add: [], remove: A },
    ]);
    expect(aGone.result.record).toEqual({
      zoneId: ZONE_ID,
      hostnames: {},
      createdEntrypoints: [WAF, CONFIG],
    });
    expect(zone.opscrewRule(WAF)?.expression).toBe(blockExpression(B));
    expect(zone.opscrewRule(CONFIG)?.expression).toBe(hostSet(B));

    const bGone = await deploy(zone, { hostnames: {} }, b.result.record);
    expect(bGone.plan.changes).toMatchObject([
      { kind: "delete-rule", phase: WAF },
      { kind: "delete-entrypoint", phase: WAF },
      { kind: "delete-rule", phase: CONFIG },
      { kind: "delete-entrypoint", phase: CONFIG },
    ]);
    expect(zone.entrypoints.size).toBe(0);
    expect(bGone.result.record).toEqual({ zoneId: ZONE_ID, hostnames: {}, createdEntrypoints: [] });
    expect((await planFor(zone, { hostnames: {} }, bGone.result.record)).changes).toEqual([]);
  });

  it("keeps each rule's own hostnames: a tunnel app only in the block rule, an app without WAF rules only in the TLS rule", async () => {
    const zone = new FakeZone();
    // Served through a Cloudflare Tunnel: no strict-TLS rule for its hostnames.
    const tunnel = await deploy(zone, { hostnames: { [BLOCK]: A } });
    expect(kinds(tunnel.plan)).toEqual(["create-entrypoint"]);
    expect(tunnel.result.record).toEqual({
      zoneId: ZONE_ID,
      hostnames: { [BLOCK]: A },
      createdEntrypoints: [WAF],
    });
    // `security.wafCustomRules: false`: no block rule for its hostnames.
    const noWaf = await deploy(zone, { hostnames: { [TLS]: B, [BLOCK]: [] } });
    expect(kinds(noWaf.plan)).toEqual(["create-entrypoint"]);
    expect(noWaf.result.record).toEqual({
      zoneId: ZONE_ID,
      hostnames: { [TLS]: B },
      createdEntrypoints: [CONFIG],
    });
    expect(zone.opscrewRule(WAF)?.expression).toBe(blockExpression(A));
    expect(zone.opscrewRule(CONFIG)?.expression).toBe(hostSet(B));
    expect(
      (await planFor(zone, { hostnames: { [BLOCK]: A } }, tunnel.result.record)).changes,
    ).toEqual([]);

    // The tunnel app moves to public records: it joins the TLS rule, the block rule stays as it is.
    const moved = await deploy(zone, { hostnames: both(A) }, tunnel.result.record);
    expect(moved.plan.changes).toMatchObject([
      { kind: "update-hostnames", phase: CONFIG, add: A, remove: [] },
    ]);
    expect(zone.opscrewRule(CONFIG)?.expression).toBe(hostSet([...B, ...A]));
    // The other app turns its WAF rules back off again later: only its TLS hostnames stay.
    const off = await deploy(zone, { hostnames: { [TLS]: B } }, noWaf.result.record);
    expect(off.plan.changes).toEqual([]);
  });

  it("adds back a hostname this app recorded that was removed by hand, and changes a hostname set in one plan", async () => {
    const zone = new FakeZone();
    const a = await deploy(zone, { hostnames: both(A) });
    const rule = zone.opscrewRule(WAF) as Record<string, unknown>;
    rule.expression = blockExpression(["shop.example.com"]);

    const plan = await planFor(zone, { hostnames: both(A) }, a.result.record);
    expect(plan.changes).toMatchObject([
      { kind: "update-hostnames", phase: WAF, add: ["www.shop.example.com"], remove: [] },
    ]);

    await applyShared(clientFor(zone), plan, { approvedHash: plan.hash });
    const moved = await deploy(zone, { hostnames: both(["shop.example.org"]) }, a.result.record);
    expect(moved.plan.changes).toMatchObject([
      { kind: "update-hostnames", phase: WAF, add: ["shop.example.org"], remove: A },
      { kind: "update-hostnames", phase: CONFIG, add: ["shop.example.org"], remove: A },
    ]);
    expect(zone.opscrewRule(WAF)?.expression).toBe(blockExpression(["shop.example.org"]));
  });

  it.each([
    ["in both phases", [WAF, CONFIG]],
    ["in the WAF phase only", [WAF]],
  ])(
    "leaves the user's own rules %s byte-identical and in order after every kind of change",
    async (_, phases) => {
      const zone = new FakeZone();
      for (const phase of phases) {
        zone.seedRule(phase, {
          description: "Block one country",
          expression: '(ip.src.country eq "XX")',
          action: phase === WAF ? "block" : "set_config",
        });
        zone.seedRule(phase, {
          description: "Challenge bots",
          expression: '(cf.client.bot and http.host eq "blog.example.com")',
          action: phase === WAF ? "managed_challenge" : "set_config",
        });
      }
      const users = Object.fromEntries(phases.map((p) => [p, zone.userRulesText(p)]));
      const seen = new Set<SharedChange["kind"]>();
      const step = async (desired: SharedDesired, record?: SharedRecord) => {
        const { plan, result } = await deploy(zone, desired, record);
        for (const kind of kinds(plan)) seen.add(kind);
        for (const phase of phases) {
          expect(zone.userRulesText(phase)).toBe(users[phase]);
          const rules = zone.entrypoints.get(phase)?.rules ?? [];
          const own = rules.findIndex((r) => String(r.ref).startsWith("opscrew-"));
          expect(own === -1 || own === rules.length - 1).toBe(true);
        }
        return result.record;
      };

      const access = { authDomain: AUTH_DOMAIN, oneTimePin: true };
      const a = await step({ hostnames: both(A), access });
      const b = await step({ hostnames: both(B), access });
      const a2 = await step({ hostnames: both(["shop.example.com"]) }, a);
      await step({ hostnames: {} }, a2);
      await step({ hostnames: {} }, b);

      for (const phase of phases) {
        expect(zone.entrypoints.get(phase)?.rules).toHaveLength(2);
        expect(zone.opscrewRule(phase)).toBeUndefined();
      }
      expect(
        zone.calls.some((c) => c.method === "PUT" && phases.some((p) => c.path.includes(p))),
      ).toBe(false);
      const expected: SharedChange["kind"][] =
        phases.length === 2
          ? ["add-rule", "update-hostnames", "delete-rule"]
          : [
              "add-rule",
              "create-entrypoint",
              "update-hostnames",
              "delete-rule",
              "delete-entrypoint",
            ];
      expect([...seen].sort()).toEqual(
        [...expected, "create-organization", "create-identity-provider"].sort(),
      );
    },
  );
});

describe("findings", () => {
  it("refuses to claim a hostname another app added", async () => {
    const zone = new FakeZone();
    await deploy(zone, { hostnames: both(A) });
    const plan = await planFor(zone, { hostnames: both(["c.example.com", "shop.example.com"]) });
    expect(plan.changes).toEqual([]);
    expect(plan.findings).toHaveLength(2);
    expect(plan.findings[0]).toMatchObject({
      code: "hostname-claimed",
      message: expect.stringContaining(
        "shop.example.com is already in OpsCrew's shared rule \"OpsCrew: block probes",
      ),
      hint: expect.stringContaining("remove it from that rule's hostname list"),
    });
    const before = zone.calls.length;
    const error = await rejection(applyShared(clientFor(zone), plan, { approvedHash: plan.hash }));
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(zone.calls.length).toBe(before);
  });

  /** A zone on `plan` whose phases already hold `custom` and `config` rules of the user's own. */
  const fullZone = (plan: string | undefined, custom: number, config: number) => {
    const zone = new FakeZone();
    zone.plan = plan;
    for (const [phase, count, action] of [
      [WAF, custom, "block"],
      [CONFIG, config, "set_config"],
    ] as const) {
      for (let i = 0; i < count; i++) {
        zone.seedRule(phase, {
          description: `user ${i}`,
          expression: `(http.host eq "u${i}.example.com")`,
          action,
        });
      }
    }
    return zone;
  };

  it("stops when the Free plan's rule slots are used by others", async () => {
    const plan = await planFor(fullZone("free", 5, 10), { hostnames: both(A) });
    expect(plan.changes).toEqual([]);
    expect(plan.findings).toMatchObject([
      {
        code: "no-rule-slot",
        message: expect.stringContaining(
          "WAF custom rules already hold 5 rules, the most Cloudflare's Free plan allows (5)",
        ),
        hint: expect.stringContaining(
          "Delete or merge one of the zone's WAF custom rules in the Cloudflare dashboard, or move the zone to a higher plan",
        ),
      },
      {
        code: "no-rule-slot",
        message: expect.stringContaining(
          "configuration rules already hold 10 rules, the most Cloudflare's Free plan allows (10)",
        ),
      },
    ]);
  });

  it("counts rule slots by the zone's plan", async () => {
    const roomy = await planFor(fullZone("pro", 5, 10), { hostnames: both(A) });
    expect(roomy.findings).toEqual([]);
    expect(kinds(roomy)).toEqual(["add-rule", "add-rule"]);

    const full = await planFor(fullZone("pro", 20, 24), { hostnames: both(A) });
    expect(full.findings).toMatchObject([
      {
        code: "no-rule-slot",
        message: expect.stringContaining(
          "already hold 20 rules, the most Cloudflare's Pro plan allows (20)",
        ),
      },
    ]);
    expect(kinds(full)).toEqual(["add-rule"]);

    const enterprise = await planFor(fullZone("enterprise", 0, 300), { hostnames: both(A) });
    expect(enterprise.findings).toMatchObject([
      {
        code: "no-rule-slot",
        message: expect.stringContaining("the most Cloudflare's Enterprise plan allows (300)"),
        hint: expect.not.stringContaining("higher plan"),
      },
    ]);
  });

  it("leaves the slot count to Cloudflare on a plan OpsCrew does not know", async () => {
    for (const plan of ["partners_free", undefined]) {
      const zone = fullZone(plan, 5, 0);
      const planned = await planFor(zone, { hostnames: both(A) });
      expect(planned.findings).toEqual([]);
      expect(planned.changes).toMatchObject([
        { kind: "add-rule", phase: WAF },
        { kind: "create-entrypoint", phase: CONFIG },
      ]);
      const error = (await rejection(
        applyShared(clientFor(zone), planned, { approvedHash: planned.hash }),
      )) as SharedApplyError;
      expect(error).toBeInstanceOf(SharedApplyError);
      expect(error.message).toBe(
        'Cloudflare could not add the rule "OpsCrew: block probes for secrets and admin panels": exceeded the maximum number of rules in the phase.',
      );
      expect(error.applied).toEqual([]);
      expect(zone.opscrewRule(WAF)).toBeUndefined();
    }
  });

  it("counts the expression length before planning", async () => {
    const zone = new FakeZone();
    const hosts = (n: number) =>
      Array.from({ length: n }, (_, i) => `host-${String(i).padStart(3, "0")}.example.com`);
    let n = 1;
    while (blockExpression(hosts(n + 1)).length <= 4096) n++;
    await deploy(zone, { hostnames: both(hosts(n)) });
    expect(String(zone.opscrewRule(WAF)?.expression).length).toBeLessThanOrEqual(4096);

    // Longer than any hostname of the first app, so it cannot fit in what is left.
    const plan = await planFor(zone, { hostnames: both([`${"z".repeat(24)}.example.com`]) });
    expect(plan.findings).toMatchObject([
      {
        code: "expression-too-long",
        message: expect.stringContaining(
          `over Cloudflare's limit of 4,096. It already lists ${n} hostnames.`,
        ),
      },
    ]);
    expect(plan.changes).toMatchObject([{ kind: "update-hostnames", phase: CONFIG }]);
  });

  it.each([
    [WAF, { action: "log" }, 'its action is "log" instead of "block"'],
    [WAF, { enabled: false }, "it is turned off"],
    [
      WAF,
      { expression: `${hostSet(A)} and (http.request.uri.path contains "/.env")` },
      "its expression is not the one OpsCrew writes",
    ],
    [
      CONFIG,
      { action_parameters: { ssl: "full" } },
      "its settings are not just the SSL setting Strict",
    ],
  ] as const)(
    "reports OpsCrew's rule changed by someone and writes nothing (%s %o)",
    async (phase, edit, difference) => {
      const zone = new FakeZone();
      const a = await deploy(zone, { hostnames: both(A) });
      Object.assign(zone.opscrewRule(phase) as Record<string, unknown>, edit);

      const again = await planFor(zone, { hostnames: both(A) }, a.result.record);
      expect(again.findings).toMatchObject([
        {
          code: "rule-changed",
          message: expect.stringContaining(
            `was changed outside OpsCrew: ${difference}. OpsCrew does not overwrite it.`,
          ),
          hint: expect.stringContaining("delete the rule so OpsCrew creates it again"),
        },
      ]);
      const other = await planFor(zone, { hostnames: both(B) });
      expect(other.changes.map((c) => ("phase" in c ? c.phase : c.kind))).toEqual(
        [WAF, CONFIG].filter((p) => p !== phase),
      );
      const before = zone.calls.length;
      const error = await rejection(
        applyShared(clientFor(zone), other, { approvedHash: other.hash }),
      );
      expect(error.code).toBe("PHASE_PRECONDITION");
      expect(error.message).toContain("was changed outside OpsCrew");
      expect(zone.calls.length).toBe(before);
    },
  );

  it("names the token permission when a read is refused", async () => {
    const zone = new FakeZone();
    zone.denied.add(WAF);
    zone.denied.add(CONFIG);
    const facts = await inspectShared(clientFor(zone), {
      zoneId: ZONE_ID,
      accountId: ACCOUNT_ID,
      access: false,
    });
    expect(facts.deniedPhases).toEqual([WAF, CONFIG]);
    const plan = planShared(facts, { hostnames: both(A) }, undefined);
    expect(plan.changes).toEqual([]);
    expect(plan.findings).toMatchObject([
      {
        code: "permission-missing",
        message: "The Cloudflare token may not read the zone's WAF custom rules (HTTP 403).",
        hint: expect.stringContaining("give it Zone → Zone WAF → Edit for this zone"),
      },
      {
        code: "permission-missing",
        hint: expect.stringContaining("give it Zone → Config Rules → Edit for this zone"),
      },
    ]);
  });

  it("refuses a hostname that cannot go into an expression, and a record of another zone", async () => {
    const facts = await inspectShared(clientFor(new FakeZone()), {
      zoneId: ZONE_ID,
      accountId: ACCOUNT_ID,
      access: false,
    });
    const injected = await rejection(
      (async () =>
        planShared(facts, { hostnames: both(['a" or true or "b.example.com']) }, undefined))(),
    );
    expect(injected.code).toBe("INVALID_INPUT");
    const record = { zoneId: "f".repeat(32), hostnames: both(A), createdEntrypoints: [] };
    const otherZone = await rejection(
      (async () => planShared(facts, { hostnames: both(A) }, record))(),
    );
    expect(otherZone.code).toBe("INVALID_INPUT");
  });
});

describe("applyShared", () => {
  it("refuses a plan whose hash was not approved or that changed after approval", async () => {
    const zone = new FakeZone();
    const plan = await planFor(zone, { hostnames: both(A) });
    const tampered: SharedPlan = {
      ...plan,
      changes: [{ kind: "create-organization", authDomain: AUTH_DOMAIN }],
    };
    const before = zone.calls.length;
    for (const [candidate, approvedHash] of [
      [plan, "0".repeat(64)],
      [plan, "not a hash"],
      [tampered, plan.hash],
    ] as const) {
      const error = await rejection(applyShared(clientFor(zone), candidate, { approvedHash }));
      expect(error.code).toBe("PLAN_HASH_MISMATCH");
    }
    expect(zone.calls.length).toBe(before);
    await applyShared(clientFor(zone), plan, { approvedHash: plan.hash.toUpperCase() });
    expect(zone.entrypoints.size).toBe(2);
  });

  it("stops a plan another app made stale, writing nothing", async () => {
    const zone = new FakeZone();
    const a = await deploy(zone, { hostnames: both(A) });
    const stale = await planFor(zone, { hostnames: both(B) });
    await deploy(zone, { hostnames: both(["c.example.com"]) });

    const before = zone.calls.length;
    const error = await rejection(
      applyShared(clientFor(zone), stale, { approvedHash: stale.hash }),
    );
    expect(error).not.toBeInstanceOf(SharedApplyError);
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toBe(
      "The zone's WAF custom rules changed after this Cloudflare plan was made: another OpsCrew app added or removed hostnames in OpsCrew's rule. OpsCrew changed nothing.",
    );
    expect(error.hint).toContain("make a new plan");
    expect(writesSince(zone, before)).toEqual([]);

    const removed = await planFor(zone, { hostnames: {} }, a.result.record);
    zone.entrypoints.get(CONFIG)?.rules.splice(0, 1);
    const gone = await rejection(
      applyShared(clientFor(zone), removed, { approvedHash: removed.hash }),
    );
    expect(gone.message).toContain(
      "configuration rules changed after this Cloudflare plan was made: OpsCrew's rule was deleted or replaced",
    );
    expect(zone.opscrewRule(WAF)?.expression).toBe(blockExpression(["c.example.com", ...A]));
  });

  it("never sends PUT to an entrypoint created after the plan", async () => {
    const zone = new FakeZone();
    const plan = await planFor(zone, { hostnames: both(A) });
    zone.seedRule(CONFIG, {
      description: "user",
      expression: "(cf.client.bot)",
      action: "set_config",
    });
    const users = zone.userRulesText(CONFIG);
    const before = zone.calls.length;
    const error = await rejection(applyShared(clientFor(zone), plan, { approvedHash: plan.hash }));
    expect(error.message).toContain(
      "the zone has a ruleset for them now. OpsCrew changed nothing.",
    );
    expect(writesSince(zone, before)).toEqual([]);
    expect(zone.userRulesText(CONFIG)).toBe(users);
  });

  it.each([
    ["its action changed", { action: "log" }],
    ["it was turned off", { enabled: false }],
  ])(
    "re-checks OpsCrew's rule before writing and stops when %s since the plan",
    async (_, edit) => {
      const zone = new FakeZone();
      await deploy(zone, { hostnames: both(A) });
      const plan = await planFor(zone, { hostnames: both(B) });
      expect(kinds(plan)).toEqual(["update-hostnames", "update-hostnames"]);
      const rule = zone.opscrewRule(WAF) as Record<string, unknown>;
      Object.assign(rule, edit);

      const before = zone.calls.length;
      const error = await rejection(
        applyShared(clientFor(zone), plan, { approvedHash: plan.hash }),
      );
      expect(error).not.toBeInstanceOf(SharedApplyError);
      expect(error.code).toBe("PHASE_PRECONDITION");
      expect(error.message).toBe(
        "The zone's WAF custom rules changed after this Cloudflare plan was made: OpsCrew's rule was changed beyond its hostnames. OpsCrew changed nothing.",
      );
      expect(writesSince(zone, before)).toEqual([]);
      expect(zone.opscrewRule(WAF)).toMatchObject({ ...edit, expression: blockExpression(A) });
    },
  );

  /** The zone with only app B, and B's destroy plan (it deletes both rules and entrypoints). */
  async function lastAppDestroy() {
    const zone = new FakeZone();
    const { result } = await deploy(zone, { hostnames: both(B) });
    const plan = await planFor(zone, { hostnames: {} }, result.record);
    expect(kinds(plan)).toEqual([
      "delete-rule",
      "delete-entrypoint",
      "delete-rule",
      "delete-entrypoint",
    ]);
    return { zone, plan };
  }
  const userRule = {
    description: "Block one country",
    expression: '(ip.src.country eq "XX")',
    action: "block",
  };

  it("does not delete a ruleset that gained a rule of the user's after the destroy plan", async () => {
    const { zone, plan } = await lastAppDestroy();
    zone.seedRule(WAF, userRule);

    const before = zone.calls.length;
    const error = await rejection(applyShared(clientFor(zone), plan, { approvedHash: plan.hash }));
    expect(error).not.toBeInstanceOf(SharedApplyError);
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toContain(
      "their ruleset holds another rule now. OpsCrew changed nothing.",
    );
    expect(writesSince(zone, before)).toEqual([]);
    expect(zone.entrypoints.get(WAF)?.rules).toMatchObject([
      { ref: BLOCK },
      { description: userRule.description, expression: userRule.expression },
    ]);
  });

  it("re-reads before each write and keeps a ruleset that gained a rule between two writes", async () => {
    const { zone, plan } = await lastAppDestroy();
    const deleteRule = `DELETE /zones/${ZONE_ID}/rulesets/${zone.entrypoints.get(WAF)?.id}/rules/`;
    let seeded = false;
    const fetch: FetchLike = async (input, init) => {
      const response = await zone.fetch(input, init);
      const call = zone.calls.at(-1);
      if (!seeded && response.ok && `${call?.method} ${call?.path}`.startsWith(deleteRule)) {
        seeded = true;
        zone.seedRule(WAF, userRule);
      }
      return response;
    };
    const client = new CloudflareClient({ token: TOKEN, fetch, sleep: async () => {} });

    const error = await rejection(applyShared(client, plan, { approvedHash: plan.hash }));
    expect(error).toBeInstanceOf(SharedApplyError);
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toContain(
      "their ruleset holds a rule again. OpsCrew stopped before changing them.",
    );
    expect((error as SharedApplyError).applied).toEqual([`delete-rule ${WAF}`]);
    expect(seeded).toBe(true);
    expect(zone.calls.some((c) => c.method === "DELETE" && !c.path.includes("/rules/"))).toBe(
      false,
    );
    expect(zone.entrypoints.get(WAF)?.rules).toMatchObject([
      { description: userRule.description, expression: userRule.expression },
    ]);
    expect(zone.opscrewRule(CONFIG)).toBeDefined();
  });

  it("stops part-way on a failed write, never sends it twice, and says what was applied", async () => {
    const zone = new FakeZone();
    const a = await deploy(zone, { hostnames: both(A) });
    const plan = await planFor(zone, { hostnames: both(["shop.example.com"]) }, a.result.record);
    const config = zone.entrypoints.get(CONFIG)?.id;
    zone.faults.push({
      match: `PATCH /zones/${ZONE_ID}/rulesets/${config}/rules`,
      reply: { status: 502, body: { success: false, errors: [], messages: [], result: null } },
    });

    const error = await rejection(applyShared(clientFor(zone), plan, { approvedHash: plan.hash }));
    expect(error).toBeInstanceOf(SharedApplyError);
    const failed = error as SharedApplyError;
    expect(failed.code).toBe("PROVIDER_ERROR");
    expect(failed.message).toContain("(HTTP 502). The change may still have reached Cloudflare.");
    expect(failed.hint).toContain("Run the command again");
    expect(failed.applied).toEqual([`update-hostnames ${WAF}`]);
    expect(failed.record).toEqual({
      zoneId: ZONE_ID,
      hostnames: { [BLOCK]: ["shop.example.com"], [TLS]: A },
      createdEntrypoints: [WAF, CONFIG],
    });
    expect(
      zone.calls.filter((c) => c.method === "PATCH" && c.path.includes(`/${config}/`)),
    ).toHaveLength(1);
    expect(zone.opscrewRule(CONFIG)?.expression).toBe(hostSet(A));

    const next = await planFor(zone, { hostnames: both(["shop.example.com"]) }, failed.record);
    expect(next.findings).toEqual([]);
    expect(next.changes).toMatchObject([
      { kind: "update-hostnames", phase: CONFIG, remove: ["www.shop.example.com"] },
    ]);
  });

  it.each([
    [
      "reads the phase again and records the hostnames OpsCrew's rule holds",
      false,
      ["shop.example.com"],
    ],
    ["keeps the old and the new hostnames when that read fails too", true, A],
  ])("after a write with no clear answer, %s", async (_, readFails, held) => {
    const zone = new FakeZone();
    const first = await deploy(zone, { hostnames: both(["shop.example.com"]) });
    const plan = await planFor(zone, { hostnames: both(A) }, first.result.record);
    expect(plan.changes).toMatchObject([
      { kind: "update-hostnames", phase: WAF, add: ["www.shop.example.com"] },
      { kind: "update-hostnames", phase: CONFIG, add: ["www.shop.example.com"] },
    ]);
    const patchConfig = `PATCH /zones/${ZONE_ID}/rulesets/${zone.entrypoints.get(CONFIG)?.id}/rules/`;
    zone.faults.push({ match: patchConfig, reply: { error: new TypeError("fetch failed") } });
    const fetch: FetchLike = async (input, init) => {
      const wrote = zone.calls.some((c) => `${c.method} ${c.path}`.startsWith(patchConfig));
      if (readFails && wrote) throw new TypeError("fetch failed");
      return zone.fetch(input, init);
    };
    const client = new CloudflareClient({ token: TOKEN, fetch, sleep: async () => {} });

    const error = (await rejection(
      applyShared(client, plan, { approvedHash: plan.hash }),
    )) as SharedApplyError;
    expect(error).toBeInstanceOf(SharedApplyError);
    expect(error.message).toContain("The change may still have reached Cloudflare.");
    expect(error.applied).toEqual([`update-hostnames ${WAF}`]);
    expect(error.record.hostnames).toEqual({ [BLOCK]: A, [TLS]: held });
    const patched = zone.calls.findIndex((c) => `${c.method} ${c.path}`.startsWith(patchConfig));
    expect(zone.calls.slice(patched + 1)).toEqual(
      readFails
        ? []
        : [
            {
              method: "GET",
              path: `/zones/${ZONE_ID}/rulesets/phases/${CONFIG}/entrypoint`,
              body: undefined,
            },
          ],
    );
  });

  it("says a write that timed out may have reached Cloudflare, and counts its hostnames as this app's", async () => {
    const zone = new FakeZone();
    const plan = await planFor(zone, { hostnames: both(A) });
    zone.faults.push({
      match: `PUT /zones/${ZONE_ID}/rulesets/phases/${CONFIG}/entrypoint`,
      reply: { hang: true },
      applied: true,
    });

    const error = await rejection(
      applyShared(clientFor(zone, 20), plan, { approvedHash: plan.hash }),
    );
    const failed = error as SharedApplyError;
    expect(failed.message).toContain("did not answer within");
    expect(failed.message).toContain("The change may still have reached Cloudflare.");
    expect(failed.applied).toEqual([`create-entrypoint ${WAF}`]);
    expect(failed.record).toEqual({
      zoneId: ZONE_ID,
      hostnames: both(A),
      createdEntrypoints: [WAF],
    });
    expect(zone.calls.filter((c) => c.method === "PUT")).toHaveLength(2);
    expect(zone.opscrewRule(CONFIG)).toBeDefined();

    const next = await planFor(zone, { hostnames: both(A) }, failed.record);
    expect(next).toMatchObject({ changes: [], findings: [] });
  });

  it("does not send a write again after a lost connection", async () => {
    const zone = new FakeZone();
    zone.seedRule(WAF, { description: "user", expression: "(cf.client.bot)", action: "block" });
    const plan = await planFor(zone, { hostnames: both(A) });
    const waf = zone.entrypoints.get(WAF)?.id;
    zone.faults.push({
      match: `POST /zones/${ZONE_ID}/rulesets/${waf}/rules`,
      reply: { error: new TypeError("fetch failed") },
    });
    const error = (await rejection(
      applyShared(clientFor(zone), plan, { approvedHash: plan.hash }),
    )) as SharedApplyError;
    expect(error.message).toContain("could not reach the Cloudflare API");
    expect(error.message).toContain("may still have reached Cloudflare");
    expect(error.applied).toEqual([]);
    expect(zone.calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(zone.entrypoints.has(CONFIG)).toBe(false);
  });

  it("checks the ruleset Cloudflare returns after a write", async () => {
    const zone = new FakeZone();
    zone.seedRule(WAF, { description: "user", expression: "(cf.client.bot)", action: "block" });
    const plan = await planFor(zone, { hostnames: both(A) });
    const waf = zone.entrypoints.get(WAF)?.id;
    zone.faults.push({
      match: `POST /zones/${ZONE_ID}/rulesets/${waf}/rules`,
      reply: {
        body: { success: true, errors: [], messages: [], result: { id: waf, rules: [] } },
      },
      applied: true,
    });
    const error = (await rejection(
      applyShared(clientFor(zone), plan, { approvedHash: plan.hash }),
    )) as SharedApplyError;
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toContain(
      "the ruleset it returned does not hold OpsCrew's rule as it was sent",
    );
    expect(error.applied).toEqual([]);
    expect(error.record.hostnames).toEqual({ [BLOCK]: A });
  });
});

describe("Zero Trust", () => {
  it("creates the organization and the one-time PIN when absent, and never deletes them", async () => {
    const zone = new FakeZone();
    const access = { authDomain: AUTH_DOMAIN, oneTimePin: true };
    const a = await deploy(zone, { hostnames: both(A), access });
    expect(a.plan.changes.slice(2)).toEqual([
      { kind: "create-organization", authDomain: AUTH_DOMAIN },
      { kind: "create-identity-provider", type: "onetimepin" },
    ]);
    const pin = zone.providers[0]?.id;
    expect(a.result).toMatchObject({
      applied: [
        `create-entrypoint ${WAF}`,
        `create-entrypoint ${CONFIG}`,
        "create-organization",
        "create-identity-provider",
      ],
      organization: { authDomain: AUTH_DOMAIN },
      oneTimePinId: pin,
    });
    expect(zone.calls.filter((c) => c.path.startsWith("/accounts") && c.method === "POST")).toEqual(
      [
        {
          method: "POST",
          path: `/accounts/${ACCOUNT_ID}/access/organizations`,
          body: { name: AUTH_DOMAIN, auth_domain: AUTH_DOMAIN },
        },
        {
          method: "POST",
          path: `/accounts/${ACCOUNT_ID}/access/identity_providers`,
          body: { name: "One-time PIN", type: "onetimepin", config: {} },
        },
      ],
    );

    const b = await deploy(zone, { hostnames: both(B), access });
    expect(kinds(b.plan)).toEqual(["update-hostnames", "update-hostnames"]);
    expect(b.result).toMatchObject({
      organization: { authDomain: AUTH_DOMAIN },
      oneTimePinId: pin,
    });

    await deploy(zone, { hostnames: {}, access }, a.result.record);
    await deploy(zone, { hostnames: {} }, b.result.record);
    expect(zone.organization).toEqual({ name: AUTH_DOMAIN, auth_domain: AUTH_DOMAIN });
    expect(zone.providers).toHaveLength(1);
    expect(zone.calls.some((c) => c.method === "DELETE" && c.path.startsWith("/accounts"))).toBe(
      false,
    );
  });

  it("reuses an organization the user set up and adds only the missing one-time PIN", async () => {
    const zone = new FakeZone();
    zone.organization = { name: "Acme", auth_domain: "acme.cloudflareaccess.com" };
    const { plan, result } = await deploy(zone, {
      hostnames: both(A),
      access: { authDomain: AUTH_DOMAIN, oneTimePin: true },
    });
    expect(kinds(plan).slice(2)).toEqual(["create-identity-provider"]);
    expect(result.organization).toEqual({ authDomain: "acme.cloudflareaccess.com" });
    expect(zone.organization).toEqual({ name: "Acme", auth_domain: "acme.cloudflareaccess.com" });
  });

  it("reads Zero Trust only when Access is wanted", async () => {
    const zone = new FakeZone();
    await planFor(zone, { hostnames: both(A) });
    expect(zone.calls.some((c) => c.path.startsWith("/accounts"))).toBe(false);
  });
});

describe("SharedRecordSchema", () => {
  it("reads the record an apply returns, as written to disk", async () => {
    const zone = new FakeZone();
    const { result } = await deploy(zone, { hostnames: both(A) });
    const onDisk = JSON.parse(JSON.stringify(result.record, null, 2));
    expect(SharedRecordSchema.parse(onDisk)).toEqual(result.record);
    const empty = { zoneId: ZONE_ID, hostnames: {}, createdEntrypoints: [] };
    expect(SharedRecordSchema.parse(empty)).toEqual(empty);
  });

  it.each([
    ["a zone id that is not 32 hex", { zoneId: "example.com" }],
    ["a rule OpsCrew does not have", { hostnames: { "opscrew-other": A } }],
    ["a hostname that is not lower case", { hostnames: { [BLOCK]: ["Shop.example.com"] } }],
    ["a hostname list that is not a list", { hostnames: { [TLS]: "shop.example.com" } }],
    ["an unknown phase", { createdEntrypoints: ["http_request_redirect"] }],
    ["an unknown key", { version: 2 }],
    ["a missing key", { createdEntrypoints: undefined }],
  ])("refuses a damaged record: %s", (_, damage) => {
    const record = { zoneId: ZONE_ID, hostnames: both(A), createdEntrypoints: [WAF], ...damage };
    expect(SharedRecordSchema.safeParse(record).success).toBe(false);
  });
});

describe("inspectShared", () => {
  it("reads the zone's plan", async () => {
    const zone = new FakeZone();
    zone.plan = "business";
    const opts = { zoneId: ZONE_ID, accountId: ACCOUNT_ID, access: false };
    expect(await inspectShared(clientFor(zone), opts)).toMatchObject({ zonePlan: "business" });
    zone.plan = undefined;
    expect(await inspectShared(clientFor(zone), opts)).not.toHaveProperty("zonePlan");
  });

  it("treats only Cloudflare's 'no entrypoint' answer as a missing ruleset", async () => {
    const zone = new FakeZone();
    zone.faults.push({
      match: `GET /zones/${ZONE_ID}/rulesets/phases/${WAF}/entrypoint`,
      reply: {
        status: 404,
        body: {
          success: false,
          errors: [{ code: 7003, message: "Could not route" }],
          result: null,
        },
      },
    });
    const error = await rejection(
      inspectShared(clientFor(zone), { zoneId: ZONE_ID, accountId: ACCOUNT_ID, access: false }),
    );
    expect(error.code).toBe("PROVIDER_ERROR");
  });
});
