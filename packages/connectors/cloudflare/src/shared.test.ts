import type { FetchLike } from "@opscrew/contracts";
import {
  buildCsr,
  canonicalJson,
  errorText,
  fingerprintSha256,
  generateP256,
  OpsCrewError,
  selfSignedClientCertificate,
  sha256Hex,
} from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { CloudflareClient, OPSCREW_MANAGED_COMMENT } from "./client";
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
import {
  FAKE_ACCOUNT_ID as ACCOUNT_ID,
  type FakeOriginCertificate,
  FakeZone,
  FAKE_ZONE_ID as ZONE_ID,
} from "./testing";

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

  it("deletes an empty entrypoint this app created that an interrupted destroy left, only when the app wants no hostnames there", async () => {
    const zone = new FakeZone();
    const { result } = await deploy(zone, { hostnames: { [BLOCK]: A } });
    const waf = zone.entrypoints.get(WAF)?.id;
    // OpsCrew's rule is deleted, but the ruleset's delete fails (a fault matches by prefix, so
    // this one is told apart by its exact path).
    const rulesetPath = `/zones/${ZONE_ID}/rulesets/${waf}`;
    const failing: FetchLike = async (input, init) =>
      init?.method === "DELETE" && new URL(String(input)).pathname.endsWith(rulesetPath)
        ? new Response("Bad Gateway", { status: 502 })
        : zone.fetch(input, init);
    const destroy = await planFor(zone, { hostnames: {} }, result.record);
    const client = new CloudflareClient({ token: TOKEN, fetch: failing, sleep: async () => {} });
    const failed = (await rejection(
      applyShared(client, destroy, { approvedHash: destroy.hash }),
    )) as SharedApplyError;
    expect(failed.applied).toEqual([`delete-rule ${WAF}`]);
    expect(failed.record).toEqual({ zoneId: ZONE_ID, hostnames: {}, createdEntrypoints: [WAF] });
    expect(zone.entrypoints.get(WAF)?.rules).toEqual([]);

    // A provision that adds hostnames again keeps the entrypoint and adds OpsCrew's rule to it.
    expect((await planFor(zone, { hostnames: { [BLOCK]: A } }, failed.record)).changes).toEqual([
      expect.objectContaining({ kind: "add-rule", phase: WAF, rulesetId: waf }),
    ]);
    // Another app's record (it did not create the entrypoint) plans nothing for it.
    const other = { zoneId: ZONE_ID, hostnames: {}, createdEntrypoints: [] };
    expect((await planFor(zone, { hostnames: {} }, other)).changes).toEqual([]);

    const again = await planFor(zone, { hostnames: {} }, failed.record);
    expect(again.changes).toEqual([{ kind: "delete-entrypoint", phase: WAF, rulesetId: waf }]);
    expect(again.expect).toEqual({ [WAF]: null });
    expect(again.record.createdEntrypoints).toEqual([]);
    const done = await applyShared(clientFor(zone), again, { approvedHash: again.hash });
    expect(done.applied).toEqual([`delete-entrypoint ${WAF}`]);
    expect(zone.entrypoints.has(WAF)).toBe(false);
  });

  it("keeps an empty entrypoint that gained a rule after the plan that deletes it", async () => {
    const zone = new FakeZone();
    zone.seedRule(WAF, { description: "user", expression: "(cf.client.bot)", action: "block" });
    const ruleset = zone.entrypoints.get(WAF);
    if (ruleset === undefined) throw new Error("no ruleset");
    const userRule = ruleset.rules.splice(0);
    const record = { zoneId: ZONE_ID, hostnames: {}, createdEntrypoints: [WAF] };
    const plan = await planFor(zone, { hostnames: {} }, record);
    expect(kinds(plan)).toEqual(["delete-entrypoint"]);
    ruleset.rules.push(...userRule);
    const before = zone.calls.length;
    const error = await rejection(applyShared(clientFor(zone), plan, { approvedHash: plan.hash }));
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toContain("their ruleset holds a rule again");
    expect(writesSince(zone, before)).toEqual([]);
    expect(zone.entrypoints.get(WAF)?.rules).toEqual(userRule);
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

  /** A record with the app's origin TLS and the zone setting OpsCrew set. */
  const withTls = () => ({
    zoneId: ZONE_ID,
    hostnames: both(A),
    createdEntrypoints: [WAF],
    tls: {
      origin: {
        id: "origin-2",
        hostnames: A,
        expiresAt: "2041-10-17T09:00:00.000Z",
        sha256: "a".repeat(64),
        superseded: ["origin-1"],
      },
      client: {
        id: "client-1",
        expiresAt: "2041-10-17T09:00:00Z",
        sha256: "b".repeat(64),
        enabled: A,
        retiring: ["old.example.com"],
      },
      gap: "permission" as const,
    },
    zoneSettings: {
      minTlsVersion: { setAt: "2026-10-21T09:00:00.000Z", previous: "1.0" as const },
    },
  });

  it("reads a record with the app's origin TLS and the zone setting OpsCrew set, or with part of them", () => {
    const record = withTls();
    expect(SharedRecordSchema.parse(JSON.parse(JSON.stringify(record)))).toEqual(record);
    const { tls, zoneSettings: _zoneSettings, ...without } = record;
    for (const part of [{}, { gap: tls.gap }, { origin: tls.origin }, { client: tls.client }]) {
      const read = { ...without, tls: part, zoneSettings: {} };
      expect(SharedRecordSchema.parse(read)).toEqual(read);
    }
    expect(SharedRecordSchema.parse(without)).toEqual(without);
  });

  type TlsRecord = ReturnType<typeof withTls>;
  it.each<[string, (record: TlsRecord) => void]>([
    ["an origin hostname that is not lower case", (r) => (r.tls.origin.hostnames = ["Shop.a.b"])],
    ["an origin hostname that is a wildcard", (r) => (r.tls.origin.hostnames = ["*.example.com"])],
    ["an enabled hostname that is not a name", (r) => (r.tls.client.enabled = ["shop"])],
    [
      "a retiring hostname that is not lower case",
      (r) => (r.tls.client.retiring = ["A.example.com"]),
    ],
    ["an empty origin id", (r) => (r.tls.origin.id = "")],
    ["an empty client id", (r) => (r.tls.client.id = "")],
    ["an empty superseded id", (r) => (r.tls.origin.superseded = [""])],
    ["an origin fingerprint in upper case", (r) => (r.tls.origin.sha256 = "A".repeat(64))],
    ["a client fingerprint too short", (r) => (r.tls.client.sha256 = "b".repeat(63))],
    ["an origin expiry that is not an ISO time", (r) => (r.tls.origin.expiresAt = "2041-10-17")],
    ["a client expiry that is not an ISO time", (r) => (r.tls.client.expiresAt = "in 15 years")],
    ["a setting time that is not an ISO time", (r) => (r.zoneSettings.minTlsVersion.setAt = "now")],
    [
      "a previous minimum TLS other than 1.0",
      (r) => Object.assign(r.zoneSettings.minTlsVersion, { previous: "1.1" }),
    ],
    ["an unknown gap", (r) => Object.assign(r.tls, { gap: "token" })],
    [
      "an origin without its superseded list",
      (r) => Reflect.deleteProperty(r.tls.origin, "superseded"),
    ],
    ["a client without its retiring list", (r) => Reflect.deleteProperty(r.tls.client, "retiring")],
    ["an unknown key in tls", (r) => Object.assign(r.tls, { key: "never" })],
    ["an unknown key in the origin", (r) => Object.assign(r.tls.origin, { privateKey: "never" })],
    ["an unknown key in the client", (r) => Object.assign(r.tls.client, { key: "never" })],
    ["an unknown zone setting", (r) => Object.assign(r.zoneSettings, { ssl: "strict" })],
    [
      "an unknown key in the setting",
      (r) => Object.assign(r.zoneSettings.minTlsVersion, { to: 1 }),
    ],
  ])("refuses a damaged origin TLS or zone settings record: %s", (_, damage) => {
    const record = withTls();
    damage(record);
    expect(SharedRecordSchema.safeParse(record).success).toBe(false);
  });
});

describe("origin TLS and the zone's minimum TLS", () => {
  const SSL = "Zone → SSL and Certificates → Edit";
  const AOP = `/zones/${ZONE_ID}/origin_tls_client_auth/hostnames`;
  /** The fake zone's issue time, and where each test's clock starts. */
  const START = new Date("2026-10-21T09:00:00Z");
  const IN_15_YEARS = "2041-10-21T09:00:00.000Z";
  const [SHOP, WWW] = A as [string, string];

  /** The app's keys, client certificate and CSR, made at test time. */
  function material(hostnames: readonly string[] = A) {
    const origin = generateP256();
    const client = generateP256();
    const clientCertificate = selfSignedClientCertificate({
      key: client.privateKey,
      commonName: "opscrew-shop",
      days: 5475,
      now: START,
    });
    return {
      originKey: origin.privateKey,
      csr: buildCsr({ key: origin.privateKey, hostnames }),
      keys: { clientCertificate, clientKey: client.privateKey },
      sha256: fingerprintSha256(clientCertificate),
    };
  }
  type Material = ReturnType<typeof material>;
  type DesiredTls = NonNullable<SharedDesired["tls"]>;
  type ClientRecord = NonNullable<NonNullable<SharedRecord["tls"]>["client"]>;

  /** A clock that each `sleep` moves on. */
  function fakeTime() {
    let now = START.getTime();
    const sleeps: number[] = [];
    return {
      clock: { now: () => new Date(now) },
      sleep: async (ms: number) => {
        sleeps.push(ms);
        now += ms;
      },
      sleeps,
    };
  }
  type Time = ReturnType<typeof fakeTime>;

  /** A provision that wants origin TLS for `proxied` (and 011's rules for A). */
  const wanted = (m: Material, proxied = A, extra: Partial<DesiredTls> = {}): SharedDesired => ({
    hostnames: both(A),
    tls: { proxied, retiring: [], origin: { csr: m.csr }, client: { sha256: m.sha256 }, ...extra },
  });
  /** A destroy: no hostnames, nothing proxied. */
  const gone = (served?: DesiredTls["served"]): SharedDesired => ({
    hostnames: {},
    tls: { proxied: [], retiring: [], ...(served ? { served } : {}) },
  });

  async function tlsPlan(
    zone: FakeZone,
    desired: SharedDesired,
    record?: SharedRecord,
    time: Time = fakeTime(),
  ): Promise<SharedPlan> {
    const facts = await inspectShared(clientFor(zone), {
      zoneId: ZONE_ID,
      accountId: ACCOUNT_ID,
      access: false,
      ...(desired.tls ? { tls: { proxied: desired.tls.proxied, record } } : {}),
      ...(desired.minTls ? { minTls: true } : {}),
      clock: time.clock,
    });
    return planShared(facts, desired, record);
  }

  /** Applies the approved plan with the plan's CSR and `m`'s client certificate and key. */
  const applyTls = (zone: FakeZone, plan: SharedPlan, m?: Material, time: Time = fakeTime()) =>
    applyShared(clientFor(zone), plan, {
      approvedHash: plan.hash,
      ...(m ? { keys: m.keys } : {}),
      ...(plan.csr ? { csr: plan.csr } : {}),
      clock: time.clock,
      sleep: time.sleep,
    });

  /** Origin TLS for A, applied. */
  async function provisioned(zone: FakeZone, m: Material) {
    return applyTls(zone, await tlsPlan(zone, wanted(m)), m);
  }

  it("plans a new app's origin TLS in the contract's order before 011's rules, and applies it with the keys and the CSR it is given", async () => {
    const zone = new FakeZone();
    zone.addDnsRecord({ type: "A", name: SHOP, proxied: true, comment: OPSCREW_MANAGED_COMMENT });
    zone.addDnsRecord({
      type: "CNAME",
      name: WWW,
      proxied: true,
      comment: OPSCREW_MANAGED_COMMENT,
    });
    zone.addDnsRecord({ type: "A", name: "mail.example.com", proxied: false });
    const m = material();
    const time = fakeTime();
    const plan = await tlsPlan(zone, { ...wanted(m), minTls: true }, undefined, time);
    expect(plan.findings).toEqual([]);
    expect(plan.advice).toEqual([]);
    expect(plan.changes.slice(0, 4)).toEqual([
      { kind: "upload-client-certificate", sha256: m.sha256 },
      { kind: "enable-client-certificate", hostnames: A, sha256: m.sha256 },
      { kind: "create-origin-certificate", hostnames: A, csrSha256: sha256Hex(m.csr) },
      { kind: "set-min-tls", from: "1.0", to: "1.2" },
    ]);
    expect(kinds(plan).slice(4)).toEqual(["create-entrypoint", "create-entrypoint"]);
    expect(plan.csr).toBe(m.csr);
    const hashed = canonicalJson({
      zoneId: ZONE_ID,
      accountId: ACCOUNT_ID,
      changes: plan.changes,
      expect: plan.expect,
    });
    expect(plan.hash).toBe(sha256Hex(hashed));
    expect(hashed).not.toContain("CERTIFICATE REQUEST");

    const before = zone.calls.length;
    const result = await applyTls(zone, plan, m, time);
    expect(result.applied).toEqual([
      ...kinds(plan).slice(0, 4),
      `create-entrypoint ${WAF}`,
      `create-entrypoint ${CONFIG}`,
    ]);
    const writes = writesSince(zone, before);
    expect(writes.map((c) => `${c.method} ${c.path}`)).toEqual([
      `POST ${AOP}/certificates`,
      `PUT ${AOP}`,
      "POST /certificates",
      `PATCH /zones/${ZONE_ID}/settings/min_tls_version`,
      `PUT /zones/${ZONE_ID}/rulesets/phases/${WAF}/entrypoint`,
      `PUT /zones/${ZONE_ID}/rulesets/phases/${CONFIG}/entrypoint`,
    ]);
    const [client] = zone.clientCertificates;
    const [origin] = zone.originCertificates;
    expect(writes[0]?.body).toEqual({
      certificate: m.keys.clientCertificate,
      private_key: m.keys.clientKey,
      bundle_method: "ubiquitous",
    });
    expect(writes[1]?.body).toEqual({
      config: A.map((hostname) => ({ hostname, cert_id: client?.id, enabled: true })),
    });
    expect(writes[2]?.body).toEqual({
      csr: m.csr,
      hostnames: A,
      request_type: "origin-ecc",
      requested_validity: 5475,
    });
    // Both hostnames were read until active before the origin certificate was asked for.
    const calls = zone.calls.slice(before).map((c) => `${c.method} ${c.path}`);
    expect(
      calls.slice(calls.indexOf(`PUT ${AOP}`) + 1, calls.indexOf("POST /certificates")),
    ).toEqual([
      `GET ${AOP}/${SHOP}`,
      `GET ${AOP}/${WWW}`,
      `GET ${AOP}/${SHOP}`,
      `GET ${AOP}/${WWW}`,
    ]);
    expect(time.sleeps).toEqual([2000]);
    expect(result.originCertificate).toBe(origin?.certificate);
    expect(result.record).toEqual({
      zoneId: ZONE_ID,
      hostnames: both(A),
      createdEntrypoints: [WAF, CONFIG],
      tls: {
        origin: {
          id: origin?.id,
          hostnames: A,
          expiresAt: IN_15_YEARS,
          sha256: fingerprintSha256(origin?.certificate ?? ""),
          superseded: [],
        },
        client: {
          id: client?.id,
          expiresAt: IN_15_YEARS,
          sha256: m.sha256,
          enabled: A,
          retiring: [],
        },
      },
      zoneSettings: { minTlsVersion: { setAt: "2026-10-21T09:00:02.000Z", previous: "1.0" } },
    });
    expect(zone.minTls.value).toBe("1.2");
    expect(SharedRecordSchema.parse(JSON.parse(JSON.stringify(result.record)))).toEqual(
      result.record,
    );

    const again = await tlsPlan(zone, { ...wanted(m), minTls: true }, result.record);
    expect(again).toMatchObject({ changes: [], findings: [], advice: [], record: result.record });
    expect(again).not.toHaveProperty("csr");
  });

  it("reads the zone's certificates, the proxied hostnames' settings, the minimum TLS and the proxied records", async () => {
    const zone = new FakeZone();
    zone.addDnsRecord({ type: "A", name: SHOP, proxied: true, comment: OPSCREW_MANAGED_COMMENT });
    zone.addDnsRecord({ type: "CNAME", name: "blog.example.com", proxied: true });
    zone.addDnsRecord({ type: "TXT", name: "example.com", proxied: false });
    const m = material();
    await provisioned(zone, m);
    const facts = await inspectShared(clientFor(zone), {
      zoneId: ZONE_ID,
      accountId: ACCOUNT_ID,
      access: false,
      tls: { proxied: [...A, "new.example.com"], record: undefined },
      minTls: true,
      clock: fakeTime().clock,
    });
    const [client] = zone.clientCertificates;
    expect(facts.tls).toEqual({
      readAt: START.toISOString(),
      origin: [{ id: zone.originCertificates[0]?.id, hostnames: A, expiresOn: IN_15_YEARS }],
      client: [{ id: client?.id, expiresOn: IN_15_YEARS, status: "active" }],
      aop: A.map((hostname) => ({ hostname, certId: client?.id, enabled: true, status: "active" })),
    });
    expect(facts.minTls).toEqual({
      value: "1.0",
      editable: true,
      proxied: [{ name: SHOP, comment: OPSCREW_MANAGED_COMMENT }, { name: "blog.example.com" }],
    });
    expect(facts).not.toHaveProperty("deniedTls");
  });

  it("waits for active with the injected clock, stops after 5 minutes with the still-deploying error, and the next run continues without uploading again", async () => {
    const quick = new FakeZone();
    quick.pendingReads = 3;
    const m = material();
    const time = fakeTime();
    await applyTls(quick, await tlsPlan(quick, wanted(m)), m, time);
    expect(time.sleeps).toEqual([2000, 2000, 2000]);

    const zone = new FakeZone();
    zone.pendingReads = Number.POSITIVE_INFINITY;
    const slow = fakeTime();
    const stuck = await tlsPlan(zone, wanted(m), undefined, slow);
    const error = (await rejection(applyTls(zone, stuck, m, slow))) as SharedApplyError;
    expect(error).toBeInstanceOf(SharedApplyError);
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toBe(
      `Cloudflare is still turning on the client certificate for ${SHOP} and ${WWW}: it was not active after 5 minutes. The server does not require it yet, so no request fails.`,
    );
    expect(error.hint).toBe(
      "Run `opscrew provision` again in a few minutes: OpsCrew continues from where it stopped.",
    );
    expect(slow.sleeps.reduce((sum, ms) => sum + ms, 0)).toBe(300_000);
    expect(error.applied).toEqual(["upload-client-certificate"]);
    expect(error.record.tls).toEqual({
      client: {
        id: zone.clientCertificates[0]?.id,
        expiresAt: IN_15_YEARS,
        sha256: m.sha256,
        enabled: A,
        retiring: [],
      },
    });
    expect(zone.calls.some((c) => c.method === "POST" && c.path === "/certificates")).toBe(false);

    // Cloudflare finishes: the next run creates the origin certificate and nothing else for TLS.
    zone.pendingReads = 0;
    const next = await tlsPlan(zone, wanted(m), error.record);
    expect(kinds(next)).toEqual([
      "create-origin-certificate",
      "create-entrypoint",
      "create-entrypoint",
    ]);
    const done = await applyTls(zone, next, m);
    expect(done.record.tls).toMatchObject({ client: { enabled: A }, origin: { hostnames: A } });
    expect(zone.clientCertificates).toHaveLength(1);
    expect(zone.calls.filter((c) => c.method === "POST" && c.path.startsWith(AOP))).toHaveLength(1);
  });

  it("records each change as it is made, so the next plan after a failed origin certificate continues without uploading again", async () => {
    const zone = new FakeZone();
    const m = material();
    zone.faults.push({
      match: "POST /certificates",
      reply: {
        status: 400,
        body: {
          success: false,
          errors: [{ code: 1010, message: "invalid request" }],
          result: null,
        },
      },
    });
    const error = (await rejection(
      applyTls(zone, await tlsPlan(zone, wanted(m)), m),
    )) as SharedApplyError;
    expect(error.message).toBe(
      `Cloudflare could not create an origin certificate for ${SHOP} and ${WWW}: invalid request.`,
    );
    expect(error.applied).toEqual(["upload-client-certificate", "enable-client-certificate"]);
    expect(error.record).toEqual({
      zoneId: ZONE_ID,
      hostnames: {},
      createdEntrypoints: [],
      tls: {
        client: {
          id: zone.clientCertificates[0]?.id,
          expiresAt: IN_15_YEARS,
          sha256: m.sha256,
          enabled: A,
          retiring: [],
        },
      },
    });
    const next = await tlsPlan(zone, wanted(m), error.record);
    expect(next.changes[0]).toEqual({
      kind: "create-origin-certificate",
      hostnames: A,
      csrSha256: sha256Hex(m.csr),
    });
    expect(kinds(next).slice(1)).toEqual(["create-entrypoint", "create-entrypoint"]);
    await applyTls(zone, next, m);
    expect(zone.clientCertificates).toHaveLength(1);
    expect(zone.originCertificates).toHaveLength(1);
  });

  it("replaces an origin certificate with fewer than 30 days left, and revokes the old one only once the server serves the new one", async () => {
    const zone = new FakeZone();
    const m = material();
    const { record } = await provisioned(zone, m);
    const first = record.tls?.origin as NonNullable<NonNullable<SharedRecord["tls"]>["origin"]>;
    const expiring = (days: number): SharedRecord => ({
      ...record,
      tls: {
        ...record.tls,
        origin: {
          ...first,
          expiresAt: new Date(START.getTime() + days * 86_400_000).toISOString(),
        },
      },
    });
    expect((await tlsPlan(zone, wanted(m), expiring(30))).changes).toEqual([]);

    const { csr } = material();
    const renew = await tlsPlan(zone, wanted(m, A, { origin: { csr } }), expiring(29));
    expect(renew.changes).toEqual([
      { kind: "create-origin-certificate", hostnames: A, csrSha256: sha256Hex(csr) },
    ]);
    const renewed = await applyTls(zone, renew, m);
    const second = renewed.record.tls?.origin;
    expect(second).toMatchObject({ hostnames: A, expiresAt: IN_15_YEARS, superseded: [first.id] });
    expect(second?.id).not.toBe(first.id);
    expect(renewed.originCertificate).toBe(zone.originCertificates[1]?.certificate);

    // The server still serves the old certificate, or could not be read: the old one waits.
    for (const extra of [{ served: { originSha256: first.sha256, requiring: A } }, {}]) {
      const waits = await tlsPlan(zone, wanted(m, A, extra), renewed.record);
      expect(waits.changes).toEqual([]);
      expect(waits.record.tls?.origin?.superseded).toEqual([first.id]);
    }
    const served = { originSha256: second?.sha256 as string, requiring: A };
    const moved = await tlsPlan(zone, wanted(m, A, { served }), renewed.record);
    expect(moved.changes).toEqual([{ kind: "revoke-origin-certificate", id: first.id }]);
    const revoked = await applyTls(zone, moved, m);
    expect(zone.originCertificates.find((c) => c.id === first.id)?.revoked_at).toBeDefined();
    expect(revoked.record.tls?.origin).toEqual({ ...second, superseded: [] });
  });

  it("plans a new origin certificate when Cloudflare no longer lists the app's, and uploads the client certificate again when it is gone", async () => {
    const zone = new FakeZone();
    const m = material();
    const { record } = await provisioned(zone, m);
    const old = zone.originCertificates[0] as FakeOriginCertificate;
    old.revoked_at = "2026-10-22T00:00:00Z";
    zone.clientCertificates.splice(0);
    zone.hostnameAop.clear();
    const plan = await tlsPlan(zone, wanted(m), record);
    expect(kinds(plan)).toEqual([
      "upload-client-certificate",
      "enable-client-certificate",
      "create-origin-certificate",
    ]);
    // The record follows what Cloudflare lists: neither certificate is in it any more.
    expect(plan.record).not.toHaveProperty("tls");
    const done = await applyTls(zone, plan, m);
    expect(done.record.tls?.origin).toMatchObject({ superseded: [] });
    expect(done.record.tls?.origin?.id).not.toBe(old.id);
    expect(done.record.tls?.client?.id).toBe(zone.clientCertificates[0]?.id);
  });

  it("keeps a revoked origin certificate in the record only while superseded ones it held are still listed", async () => {
    const zone = new FakeZone();
    const m = material();
    const { record } = await provisioned(zone, m);
    const first = zone.originCertificates[0] as FakeOriginCertificate;
    const origin = record.tls?.origin as NonNullable<NonNullable<SharedRecord["tls"]>["origin"]>;
    // It expires now: a new one is wanted.
    const renewing = {
      ...record,
      tls: { ...record.tls, origin: { ...origin, expiresAt: START.toISOString() } },
    };
    const { csr } = material();
    const renew = await tlsPlan(zone, wanted(m, A, { origin: { csr } }), renewing);
    const renewed = await applyTls(zone, renew, m);
    const second = zone.originCertificates[1] as FakeOriginCertificate;
    second.revoked_at = "2026-10-22T00:00:00Z";
    const plan = await tlsPlan(
      zone,
      wanted(m, A, { origin: { csr: material().csr } }),
      renewed.record,
    );
    expect(plan.record.tls?.origin).toMatchObject({ id: second.id, superseded: [first.id] });
    first.revoked_at = "2026-10-22T00:00:00Z";
    const later = await tlsPlan(
      zone,
      wanted(m, A, { origin: { csr: material().csr } }),
      renewed.record,
    );
    expect(later.record.tls).not.toHaveProperty("origin");
  });

  it("asks for a CSR when a new origin certificate is needed and none was given", async () => {
    const zone = new FakeZone();
    const m = material();
    const desired = wanted(m);
    const { origin: _origin, ...withoutCsr } = desired.tls as DesiredTls;
    const error = await rejection(tlsPlan(zone, { ...desired, tls: withoutCsr }));
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.message).toBe(
      `A new origin certificate is needed for ${SHOP} and ${WWW} (there is none, it expires within 30 days, Cloudflare no longer lists it, or the hostnames changed), but this plan was given no certificate request.`,
    );
    expect(error.hint).toContain("CSR");
  });

  it("refuses to replace a client certificate Cloudflare still has, and says how to replace it by hand", async () => {
    const zone = new FakeZone();
    const m = material();
    const { record } = await provisioned(zone, m);
    const error = await rejection(tlsPlan(zone, wanted(material()), record));
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.message).toBe(
      "This app's client certificate at Cloudflare is not the one asked for, and OpsCrew does not replace a client certificate: it lasts 15 years, and a safe switch needs the server to trust both certificates first.",
    );
    expect(error.hint).toContain("To replace it by hand");
    expect(error.hint).toContain("opscrew/runtime/edge/tls/pull.pem");
    expect(error.hint).toContain(".opscrew/cloudflare.json");
  });

  it("waits until the uploaded client certificate is active before turning it on, and stops after 5 minutes", async () => {
    const zone = new FakeZone();
    zone.certificatePendingReads = 2;
    const m = material();
    const time = fakeTime();
    const before = zone.calls.length;
    await applyTls(zone, await tlsPlan(zone, wanted(m)), m, time);
    const calls = zone.calls.slice(before).map((c) => `${c.method} ${c.path}`);
    const certificates = `GET ${AOP}/certificates?page=1&per_page=50`;
    // The certificate until active, then each hostname's setting read again before the write.
    expect(
      calls.slice(calls.indexOf(`POST ${AOP}/certificates`) + 1, calls.indexOf(`PUT ${AOP}`)),
    ).toEqual([
      certificates,
      certificates,
      certificates,
      `GET ${AOP}/${SHOP}`,
      `GET ${AOP}/${WWW}`,
    ]);
    expect(time.sleeps).toEqual([2000, 2000, 2000]);

    const stuck = new FakeZone();
    stuck.certificatePendingReads = Number.POSITIVE_INFINITY;
    const slow = fakeTime();
    const error = (await rejection(
      applyTls(stuck, await tlsPlan(stuck, wanted(m)), m, slow),
    )) as SharedApplyError;
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toBe(
      "Cloudflare is still deploying the app's client certificate: it was not active after 5 minutes. The server does not require it yet, so no request fails.",
    );
    expect(error.hint).toBe(
      "Run `opscrew provision` again in a few minutes: OpsCrew continues from where it stopped.",
    );
    expect(slow.sleeps.reduce((sum, ms) => sum + ms, 0)).toBe(300_000);
    expect(error.applied).toEqual(["upload-client-certificate"]);
    expect(error.record.tls?.client).toMatchObject({ enabled: [], retiring: [] });
    expect(stuck.calls.some((c) => c.method === "PUT" && c.path === AOP)).toBe(false);

    // Once Cloudflare has deployed it, the next run turns it on without uploading again.
    stuck.certificatePendingReads = 0;
    const next = await tlsPlan(stuck, wanted(m), error.record);
    expect(kinds(next).slice(0, 2)).toEqual([
      "enable-client-certificate",
      "create-origin-certificate",
    ]);
    await applyTls(stuck, next, m);
    expect(stuck.clientCertificates).toHaveLength(1);
  });

  it("retires a hostname that leaves the proxy once the server stops requiring it, and removes everything on destroy, in order, once the server shows it", async () => {
    const zone = new FakeZone();
    const m = material();
    const first = await provisioned(zone, m);
    const old = first.record.tls?.origin as { id: string; sha256: string };
    const { csr } = material([SHOP]);
    const leaving = (served: { originSha256: string; requiring: string[] }) =>
      wanted(m, [SHOP], { retiring: [WWW], origin: { csr }, served });

    // The first run: a certificate for what stays proxied; www keeps its requirement for now.
    const one = await tlsPlan(
      zone,
      leaving({ originSha256: old.sha256, requiring: A }),
      first.record,
    );
    expect(one.changes).toEqual([
      { kind: "create-origin-certificate", hostnames: [SHOP], csrSha256: sha256Hex(csr) },
    ]);
    expect(one.record.tls?.client).toMatchObject({ enabled: A, retiring: [WWW] });
    const oneDone = await applyTls(zone, one, m);
    const current = oneDone.record.tls?.origin as { id: string; sha256: string };
    expect(oneDone.record.tls?.client).toMatchObject({ enabled: A, retiring: [WWW] });

    // The next run, once the server serves the new certificate and requires the client one only for shop.
    const two = await tlsPlan(
      zone,
      leaving({ originSha256: current.sha256, requiring: [SHOP] }),
      oneDone.record,
    );
    expect(two.changes).toEqual([
      { kind: "disable-client-certificate", hostnames: [WWW] },
      { kind: "revoke-origin-certificate", id: old.id },
    ]);
    const twoDone = await applyTls(zone, two, m);
    expect(zone.calls.filter((c) => c.method === "PUT" && c.path === AOP).at(-1)?.body).toEqual({
      config: [{ hostname: WWW, cert_id: zone.clientCertificates[0]?.id, enabled: null }],
    });
    expect(zone.hostnameAop.get(WWW)).toMatchObject({ enabled: null });
    expect(twoDone.record.tls?.client).toMatchObject({ enabled: [SHOP], retiring: [] });
    expect(twoDone.record.tls?.origin).toMatchObject({ id: current.id, superseded: [] });

    // Destroy: while the server cannot be read, the TLS changes wait.
    const unread = await tlsPlan(zone, gone(), twoDone.record);
    expect(unread.changes.filter((c) => !("phase" in c))).toEqual([]);
    expect(unread.record.tls).toMatchObject({
      client: { enabled: [SHOP], retiring: [SHOP] },
      origin: { id: current.id },
    });
    const destroy = await tlsPlan(zone, gone({ requiring: [] }), twoDone.record);
    expect(destroy.changes.slice(0, 3)).toEqual([
      { kind: "disable-client-certificate", hostnames: [SHOP] },
      { kind: "delete-client-certificate", id: zone.clientCertificates[0]?.id },
      { kind: "revoke-origin-certificate", id: current.id },
    ]);
    expect(kinds(destroy).slice(3)).toEqual([
      "delete-rule",
      "delete-entrypoint",
      "delete-rule",
      "delete-entrypoint",
    ]);
    const before = zone.calls.length;
    const destroyed = await applyTls(zone, destroy);
    const [certificate] = zone.clientCertificates;
    expect(
      writesSince(zone, before)
        .slice(0, 3)
        .map((c) => `${c.method} ${c.path}`),
    ).toEqual([
      `PUT ${AOP}`,
      `DELETE ${AOP}/certificates/${certificate?.id}`,
      `DELETE /certificates/${current.id}`,
    ]);
    expect(destroyed.record).toEqual({ zoneId: ZONE_ID, hostnames: {}, createdEntrypoints: [] });
    expect(certificate?.status).toBe("pending_deletion");
    expect(zone.originCertificates.every((c) => c.revoked_at !== undefined)).toBe(true);
  });

  it("drops a client certificate from the record once Cloudflare lists it as being deleted, after a delete whose answer was lost", async () => {
    const zone = new FakeZone();
    const m = material();
    const { record } = await provisioned(zone, m);
    const origin = record.tls?.origin as { id: string };
    const id = zone.clientCertificates[0]?.id as string;
    zone.faults.push({
      match: `DELETE ${AOP}/certificates/${id}`,
      reply: { error: new TypeError("fetch failed") },
      applied: true,
    });
    const destroy = await tlsPlan(zone, gone({ requiring: [] }), record);
    const error = (await rejection(applyTls(zone, destroy))) as SharedApplyError;
    expect(error.message).toContain("may still have reached Cloudflare");
    expect(error.applied).toEqual(["disable-client-certificate"]);
    expect(error.record.tls?.client).toMatchObject({ id, enabled: [], retiring: [] });
    expect(zone.clientCertificates[0]?.status).toBe("pending_deletion");

    // A fresh plan follows what Cloudflare lists: the client certificate is gone from the record,
    // and only the origin certificate is left to revoke.
    const next = await tlsPlan(zone, gone({ requiring: [] }), error.record);
    expect(next.record.tls).not.toHaveProperty("client");
    expect(next.changes.filter((c) => !("phase" in c))).toEqual([
      { kind: "revoke-origin-certificate", id: origin.id },
    ]);
    const done = await applyTls(zone, next);
    expect(done.record).not.toHaveProperty("tls");
  });

  it("refuses a hostname another app's client certificate holds, and writes nothing", async () => {
    const zone = new FakeZone();
    const other = material(B);
    const theirs: DesiredTls = {
      proxied: B,
      retiring: [],
      origin: { csr: other.csr },
      client: { sha256: other.sha256 },
    };
    await applyTls(zone, await tlsPlan(zone, { hostnames: both(B), tls: theirs }), other);
    const m = material(B);
    const plan = await tlsPlan(zone, {
      hostnames: {},
      tls: { ...theirs, origin: { csr: m.csr }, client: { sha256: m.sha256 } },
    });
    expect(plan.changes).toEqual([]);
    expect(plan.findings).toEqual([
      {
        code: "hostname-tls-claimed",
        message: expect.stringContaining(
          "api.example.com already requires a client certificate at Cloudflare that this app did not upload",
        ),
        hint: expect.stringContaining("OpsCrew never takes a hostname from another app."),
      },
    ]);
    const before = zone.calls.length;
    expect((await rejection(applyTls(zone, plan, m))).code).toBe("PHASE_PRECONDITION");
    expect(zone.calls.length).toBe(before);
  });

  /** Another app's client certificate on `hostname`, as Cloudflare would hold it. */
  const takeOver = (zone: FakeZone, hostname: string) =>
    zone.hostnameAop.set(hostname, { hostname, cert_id: "f".repeat(32), enabled: true });

  it("never turns off a hostname another certificate holds when the plan is made, and drops it from the record", async () => {
    const zone = new FakeZone();
    const m = material();
    const { record } = await provisioned(zone, m);
    const origin = record.tls?.origin as { sha256: string };
    takeOver(zone, WWW);
    const { csr } = material([SHOP]);
    const served = { originSha256: origin.sha256, requiring: [SHOP] };
    const plan = await tlsPlan(zone, wanted(m, [SHOP], { origin: { csr }, served }), record);
    expect(kinds(plan)).toEqual(["create-origin-certificate"]);
    expect(plan.record.tls?.client).toMatchObject({ enabled: [SHOP], retiring: [] });
  });

  it("stops before turning a hostname on when another certificate took it after the plan", async () => {
    const zone = new FakeZone();
    const m = material();
    const plan = await tlsPlan(zone, wanted(m));
    takeOver(zone, WWW);
    const error = (await rejection(applyTls(zone, plan, m))) as SharedApplyError;
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toBe(
      `${WWW} is held by another client certificate at Cloudflare now: another OpsCrew app turned on Authenticated Origin Pulls for it after this Cloudflare plan was made. OpsCrew stopped before changing it.`,
    );
    expect(error.applied).toEqual(["upload-client-certificate"]);
    expect(error.record.tls?.client).toMatchObject({ enabled: [] });
    expect(zone.calls.some((c) => c.method === "PUT" && c.path === AOP)).toBe(false);
    expect(zone.hostnameAop.get(WWW)).toMatchObject({ cert_id: "f".repeat(32), enabled: true });
  });

  it("stops before turning a hostname off when another certificate took it after the plan", async () => {
    const zone = new FakeZone();
    const m = material();
    const { record } = await provisioned(zone, m);
    const { csr } = material([SHOP]);
    const origin = record.tls?.origin as { sha256: string };
    const served = { originSha256: origin.sha256, requiring: [SHOP] };
    const plan = await tlsPlan(zone, wanted(m, [SHOP], { origin: { csr }, served }), record);
    expect(kinds(plan)).toEqual(["create-origin-certificate", "disable-client-certificate"]);
    takeOver(zone, WWW);
    const error = (await rejection(applyTls(zone, plan, m))) as SharedApplyError;
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toContain(`${WWW} is held by another client certificate`);
    expect(error.applied).toEqual(["create-origin-certificate"]);
    expect(zone.calls.filter((c) => c.method === "PUT" && c.path === AOP)).toHaveLength(1);
    expect(zone.hostnameAop.get(WWW)).toMatchObject({ cert_id: "f".repeat(32), enabled: true });
  });

  it("turns on only the client certificate the approved plan names", async () => {
    const zone = new FakeZone();
    const m = material();
    const { record } = await provisioned(zone, m);
    const certId = zone.clientCertificates[0]?.id as string;
    zone.hostnameAop.set(SHOP, { hostname: SHOP, cert_id: certId, enabled: null });
    const plan = await tlsPlan(zone, wanted(m), record);
    expect(plan.changes).toEqual([
      { kind: "enable-client-certificate", hostnames: [SHOP], sha256: m.sha256 },
    ]);
    const client = plan.record.tls?.client as ClientRecord;
    // The record is outside the hash: one naming another certificate is refused.
    const tampered: SharedPlan = {
      ...plan,
      record: {
        ...plan.record,
        tls: { ...plan.record.tls, client: { ...client, sha256: "0".repeat(64) } },
      },
    };
    const before = zone.calls.length;
    const error = await rejection(applyTls(zone, tampered, m));
    expect(error.code).toBe("PLAN_HASH_MISMATCH");
    expect(writesSince(zone, before)).toEqual([]);
  });

  it("leaves origin TLS out with the tls-permission-missing advice when the token lacks the permission, records the gap, and still applies 011's rules", async () => {
    const zone = new FakeZone();
    zone.denied.add("ssl");
    const m = material();
    const facts = await inspectShared(clientFor(zone), {
      zoneId: ZONE_ID,
      accountId: ACCOUNT_ID,
      access: false,
      tls: { proxied: A, record: undefined },
    });
    expect(facts.deniedTls).toEqual([SSL]);
    expect(facts).not.toHaveProperty("tls");
    const plan = planShared(facts, wanted(m), undefined);
    expect(plan.findings).toEqual([]);
    expect(kinds(plan)).toEqual(["create-entrypoint", "create-entrypoint"]);
    expect(plan.advice).toEqual([
      {
        code: "tls-permission-missing",
        message: `The Cloudflare token lacks ${SSL} for this zone (HTTP 403), so this plan leaves out the app's origin certificate and Authenticated Origin Pulls. The app keeps today's protection: only Cloudflare's addresses reach the server.`,
        hint: `Edit the token at https://dash.cloudflare.com/profile/api-tokens and give it ${SSL} for this zone, then run the command again.`,
      },
    ]);
    expect(plan).not.toHaveProperty("csr");
    const result = await applyTls(zone, plan);
    expect(result.record).toEqual({
      zoneId: ZONE_ID,
      hostnames: both(A),
      createdEntrypoints: [WAF, CONFIG],
      tls: { gap: "permission" },
    });

    // Once the token has it, the gap goes and origin TLS is planned.
    zone.denied.delete("ssl");
    const next = await tlsPlan(zone, wanted(m), result.record);
    expect(kinds(next)).toEqual([
      "upload-client-certificate",
      "enable-client-certificate",
      "create-origin-certificate",
    ]);
    expect(next.advice).toEqual([]);
    expect(next.record).not.toHaveProperty("tls");
  });

  it.each([
    ["settings", "Zone → Zone Settings → Edit"],
    ["dns", "Zone → DNS → Edit"],
  ])(
    "names the permission when the token may not read the zone's %s for the minimum TLS, and still plans origin TLS",
    async (denied, permission) => {
      const zone = new FakeZone();
      zone.denied.add(denied);
      const plan = await tlsPlan(zone, { ...wanted(material()), minTls: true });
      expect(kinds(plan)).toEqual([
        "upload-client-certificate",
        "enable-client-certificate",
        "create-origin-certificate",
        "create-entrypoint",
        "create-entrypoint",
      ]);
      expect(plan.advice).toEqual([
        {
          code: "tls-permission-missing",
          message: `The Cloudflare token lacks ${permission} for this zone (HTTP 403), so this plan leaves out the zone's minimum TLS version.`,
          hint: expect.stringContaining(`${permission} for this zone`),
        },
      ]);
      expect(plan.record).not.toHaveProperty("tls");
    },
  );

  it.each<[string, (zone: FakeZone) => void, "raise" | "advise" | "nothing"]>([
    [
      "every proxied record is OpsCrew's",
      (z) =>
        z.addDnsRecord({ type: "A", name: SHOP, proxied: true, comment: OPSCREW_MANAGED_COMMENT }),
      "raise",
    ],
    [
      "a DNS-only record of someone else",
      (z) => z.addDnsRecord({ type: "A", name: "mail.example.com", proxied: false }),
      "raise",
    ],
    [
      "a proxied record of someone else",
      (z) => z.addDnsRecord({ type: "CNAME", name: "blog.example.com", proxied: true }),
      "advise",
    ],
    [
      "a proxied AAAA record with another comment",
      (z) =>
        z.addDnsRecord({ type: "AAAA", name: "v6.example.com", proxied: true, comment: "mine" }),
      "advise",
    ],
    ["1.1, set by someone", (z) => Object.assign(z.minTls, { value: "1.1" }), "advise"],
    [
      "a setting the zone cannot change",
      (z) => Object.assign(z.minTls, { editable: false }),
      "advise",
    ],
    ["1.2", (z) => Object.assign(z.minTls, { value: "1.2" }), "nothing"],
    ["1.3", (z) => Object.assign(z.minTls, { value: "1.3" }), "nothing"],
  ])("decides the zone's minimum TLS version: %s", async (_, setup, outcome) => {
    const zone = new FakeZone();
    setup(zone);
    const plan = await tlsPlan(zone, { hostnames: {}, minTls: true });
    expect(plan.changes).toEqual(
      outcome === "raise" ? [{ kind: "set-min-tls", from: "1.0", to: "1.2" }] : [],
    );
    expect(plan.advice).toEqual(
      outcome === "advise"
        ? [
            {
              code: "min-tls-advised",
              message: expect.stringContaining("OpsCrew leaves it as it is"),
              hint: expect.stringContaining("Minimum TLS Version"),
            },
          ]
        : [],
    );
  });

  it("names the proxied records that are not OpsCrew's in the advice, and plans nothing when the decision is not asked for", async () => {
    const zone = new FakeZone();
    for (const name of ["a.example.com", "b.example.com", "c.example.com", "d.example.com"]) {
      zone.addDnsRecord({ type: "CNAME", name, proxied: true });
    }
    const plan = await tlsPlan(zone, { hostnames: {}, minTls: true });
    expect(plan.advice[0]?.message).toBe(
      "The zone's minimum TLS version is 1.0, so visitors can still connect with TLS 1.0 and 1.1. OpsCrew leaves it as it is because the zone has proxied hostnames that are not OpsCrew's: a.example.com, b.example.com, c.example.com and 1 more.",
    );
    const before = zone.calls.length;
    const notAsked = await tlsPlan(zone, { hostnames: {} });
    expect(notAsked).toMatchObject({ changes: [], advice: [] });
    expect(zone.calls.slice(before).some((c) => c.path.includes("/settings/"))).toBe(false);
  });

  it("raises the minimum TLS only from 1.0: a value changed after the plan stops the apply", async () => {
    const zone = new FakeZone();
    const plan = await tlsPlan(zone, { hostnames: {}, minTls: true });
    expect(kinds(plan)).toEqual(["set-min-tls"]);
    zone.minTls.value = "1.3";
    const error = (await rejection(applyTls(zone, plan))) as SharedApplyError;
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toBe(
      "The zone's minimum TLS version is 1.3 now, not the 1.0 this Cloudflare plan raises, so OpsCrew leaves it as it is.",
    );
    expect(zone.writes()).toEqual([]);
    expect(zone.minTls.value).toBe("1.3");
    expect(error.record).not.toHaveProperty("zoneSettings");
  });

  it("carries the record's origin TLS and zone settings over when the plan does not ask for them, reading none of them", async () => {
    const zone = new FakeZone();
    const m = material();
    const { record } = await applyTls(zone, await tlsPlan(zone, { ...wanted(m), minTls: true }), m);
    const before = zone.calls.length;
    const plan = await planFor(zone, { hostnames: both(A) }, record);
    expect(plan.changes).toEqual([]);
    expect(plan.record).toEqual(record);
    expect(
      zone.calls
        .slice(before)
        .every((c) => c.path.includes("/rulesets/") || c.path === `/zones/${ZONE_ID}`),
    ).toBe(true);
  });

  it("refuses an apply given another CSR or client certificate than the approved plan's, writing nothing", async () => {
    const zone = new FakeZone();
    const m = material();
    const plan = await tlsPlan(zone, wanted(m));
    const other = material();
    for (const given of [
      { csr: other.csr, keys: m.keys },
      { keys: m.keys },
      { csr: m.csr, keys: other.keys },
      { csr: m.csr },
    ]) {
      const error = await rejection(
        applyShared(clientFor(zone), plan, { approvedHash: plan.hash, ...given }),
      );
      expect(error.code).toBe("PLAN_HASH_MISMATCH");
      expect(error).not.toBeInstanceOf(SharedApplyError);
    }
    expect(zone.writes()).toEqual([]);
  });

  it("keeps every key out of the plan, its hash and the errors, and the CSR's text out of the hash", async () => {
    const zone = new FakeZone();
    const m = material();
    const secrets = [m.originKey, m.keys.clientKey].map((key) => key.split("\n")[1] as string);
    const plan = await tlsPlan(zone, { ...wanted(m), minTls: true });
    const text = JSON.stringify(plan);
    for (const secret of secrets) expect(text).not.toContain(secret);
    const hashed = canonicalJson({
      zoneId: ZONE_ID,
      accountId: ACCOUNT_ID,
      changes: plan.changes,
      expect: plan.expect,
    });
    expect(hashed).not.toContain(m.csr.split("\n")[1]);

    // Cloudflare refuses the upload quoting the key; then a setting never becomes active.
    zone.faults.push({
      match: `POST ${AOP}/certificates`,
      reply: {
        status: 400,
        body: {
          success: false,
          errors: [{ code: 1406, message: `Bad key ${m.keys.clientKey}` }],
          result: null,
        },
      },
    });
    const refused = await rejection(applyTls(zone, plan, m));
    zone.pendingReads = Number.POSITIVE_INFINITY;
    const stuck = await rejection(applyTls(zone, plan, m));
    for (const error of [refused, stuck]) {
      const shown = `${error.message} ${error.hint} ${JSON.stringify(error)} ${errorText(error.cause)}`;
      for (const secret of secrets) expect(shown).not.toContain(secret);
    }
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
