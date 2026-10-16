import type { IacEngine } from "@opscrew/contracts";
import type { DeployPlan } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import {
  createTestPhaseDeps,
  type FakeRuleset,
  fakeCloudflare,
  fakeRulesetId,
  heldRulesetsOutput,
  ownCloudflare,
  ownPlan,
  portainerPlan,
  testPlan,
  writeFakeState,
} from "../testing";
import { setupCloudflare } from "./credentials";

type Phase = "http_config_settings" | "http_request_firewall_custom";

/** What this project's infrastructure state looks like. */
type StateCase =
  | { kind: "none" }
  | { kind: "outputs"; outputs: Record<string, unknown> }
  | { kind: "unreadable" };

/** An engine that only reads outputs: the given ones, or a failure. */
function outputsEngine(state: StateCase): IacEngine & { reads: number } {
  const engine = {
    reads: 0,
    info: { name: "tofu" as const, version: "1.13.1", binary: "/fake/tofu" },
    init: async () => undefined,
    validate: async () => ({ valid: true, diagnostics: [] }),
    plan: async () => {
      throw new Error("no plans here");
    },
    apply: async () => {
      throw new Error("no applies here");
    },
    output: async () => {
      engine.reads++;
      if (state.kind === "unreadable") throw new Error("Error: decrypting the state failed");
      return state.kind === "outputs" ? state.outputs : {};
    },
  };
  return engine;
}

const SERVER = {
  server_ipv4: "203.0.113.10",
  server_ipv6: "2001:db8::1",
  url: "https://shop.example.com",
};

const TARGETS: { label: string; plan: () => DeployPlan; own: boolean; tunnel: boolean }[] = [
  {
    label: "Hetzner",
    plan: () => testPlan({ domain: "shop.example.com" }),
    own: false,
    tunnel: false,
  },
  {
    label: "DigitalOcean",
    plan: () => testPlan({ provider: "digitalocean", domain: "shop.example.com" }),
    own: false,
    tunnel: false,
  },
  { label: "an own server", plan: () => ownPlan(), own: true, tunnel: false },
  {
    label: "an own server in tunnel mode",
    plan: () => ownPlan({ access: "tunnel" }),
    own: true,
    tunnel: true,
  },
];

const PHASES: { phase: Phase; key: "configRules" | "wafRules"; flag: string; rules: string }[] = [
  {
    phase: "http_config_settings",
    key: "configRules",
    flag: "manageConfigRule",
    rules: "configuration rules",
  },
  {
    phase: "http_request_firewall_custom",
    key: "wafRules",
    flag: "manageWafRules",
    rules: "WAF custom rules",
  },
];

async function run(
  target: (typeof TARGETS)[number],
  phase: (typeof PHASES)[number],
  ruleset: FakeRuleset,
  state: StateCase,
) {
  const deps = await createTestPhaseDeps();
  if (state.kind !== "none") await writeFakeState(deps.paths);
  const base = fakeCloudflare({ [phase.key]: ruleset });
  const cloudflare = target.own ? { ...base, findZone: ownCloudflare().findZone } : base;
  const engine = outputsEngine(state);
  const setup = setupCloudflare(deps, target.plan(), {
    cloudflare,
    engine: async () => engine,
  });
  return { deps, engine, setup };
}

const managed = async (setup: Awaited<ReturnType<typeof run>>["setup"], flag: string) =>
  ((await setup) as unknown as Record<string, boolean>)[flag];

describe("setupCloudflare: which entrypoint rulesets OpsCrew manages", () => {
  for (const target of TARGETS) {
    for (const phase of PHASES) {
      const label = `${target.label}, ${phase.phase}`;
      if (target.tunnel && phase.phase === "http_config_settings") {
        it(`${label}: renders no configuration rule, so the phase is never inspected, warned about or read from the state`, async () => {
          const rulesets: FakeRuleset[] = ["none", "opscrew", "user", "user-empty"];
          const states: StateCase[] = [
            { kind: "none" },
            { kind: "outputs", outputs: { ...SERVER, cloudflare_rulesets: heldRulesetsOutput() } },
            { kind: "outputs", outputs: { url: "https://shop.example.com", tunnel_id: "t-1" } },
            { kind: "unreadable" },
          ];
          for (const ruleset of rulesets) {
            for (const state of states) {
              const why = `${ruleset}, ${state.kind}`;
              const { deps, engine, setup } = await run(target, phase, ruleset, state);
              expect(await managed(setup, phase.flag), why).toBe(false);
              expect(engine.reads, why).toBe(0);
              const text = deps.reporter.text();
              expect(text, why).not.toContain("configuration rule");
              expect(text, why).not.toContain("TLS");
              expect(text, why).not.toContain("OpsCrew deployment");
            }
          }
        });
        continue;
      }
      const another = `Another OpsCrew deployment (or one whose state is gone) holds the example.com zone's ${phase.rules}`;

      it(`${label}: manages the phase when the zone has no ruleset for it`, async () => {
        const { deps, engine, setup } = await run(target, phase, "none", { kind: "none" });
        expect(await managed(setup, phase.flag)).toBe(true);
        expect(engine.reads).toBe(0);
        expect(deps.reporter.text()).not.toContain("OpsCrew deployment");
      });

      it(`${label}: manages the ruleset this project's state holds (by id)`, async () => {
        const { deps, setup } = await run(target, phase, "opscrew", {
          kind: "outputs",
          outputs: { ...SERVER, cloudflare_rulesets: heldRulesetsOutput() },
        });
        expect(await managed(setup, phase.flag)).toBe(true);
        expect(deps.reporter.text()).not.toContain("Another OpsCrew deployment");
      });

      it(`${label}: leaves another deployment's ruleset alone in a fresh project`, async () => {
        const { deps, engine, setup } = await run(target, phase, "opscrew", { kind: "none" });
        expect(await managed(setup, phase.flag)).toBe(false);
        expect(engine.reads).toBe(0);
        const text = deps.reporter.text();
        expect(text).toContain(another);
        expect(text).toContain("for shop.example.com");
        expect(text).toContain(
          `If no other OpsCrew app uses this zone, delete the ruleset "${phase.phase === "http_config_settings" ? "OpsCrew configuration rules" : "OpsCrew custom rules"}" in the Cloudflare dashboard (or the API: DELETE /zones/zone-123/rulesets/${fakeRulesetId(phase.phase)}) and run OpsCrew again: it then adds these rules for shop.example.com.`,
        );
      });

      it(`${label}: leaves another deployment's ruleset alone when the state names another id or none`, async () => {
        for (const id of ["rs-of-an-earlier-ruleset", null]) {
          const { deps, setup } = await run(target, phase, "opscrew", {
            kind: "outputs",
            outputs: { ...SERVER, cloudflare_rulesets: heldRulesetsOutput({ [phase.phase]: id }) },
          });
          expect(await managed(setup, phase.flag), String(id)).toBe(false);
          expect(deps.reporter.text()).toContain(another);
        }
      });

      it(`${label}: treats a state without outputs (nothing deployed) like a fresh project`, async () => {
        const { deps, setup } = await run(target, phase, "opscrew", {
          kind: "outputs",
          outputs: {},
        });
        expect(await managed(setup, phase.flag)).toBe(false);
        expect(deps.reporter.text()).toContain(another);
      });

      it(`${label}: leaves OpsCrew's ruleset alone when the state names no rulesets`, async () => {
        const { deps, setup } = await run(target, phase, "opscrew", {
          kind: "outputs",
          outputs: SERVER,
        });
        expect(await managed(setup, phase.flag)).toBe(false);
        expect(deps.reporter.text()).toContain("Another OpsCrew deployment");
      });

      it(`${label}: stops with a plain error when the state's outputs cannot be read`, async () => {
        const { setup } = await run(target, phase, "opscrew", { kind: "unreadable" });
        await expect(setup).rejects.toMatchObject({
          code: "PHASE_PRECONDITION",
          message: expect.stringContaining(
            "OpsCrew could not read this project's infrastructure state (.opscrew/tfstate)",
          ),
          hint: expect.stringContaining("then run OpsCrew again"),
        });
        const malformed = await run(target, phase, "opscrew", {
          kind: "outputs",
          outputs: { ...SERVER, cloudflare_rulesets: "not ids" },
        });
        await expect(malformed.setup).rejects.toMatchObject({ code: "PHASE_PRECONDITION" });
      });

      it(`${label}: leaves the user's own rulesets alone as before, without reading the state`, async () => {
        const own = await run(target, phase, "user", { kind: "unreadable" });
        expect(await managed(own.setup, phase.flag)).toBe(false);
        expect(own.engine.reads).toBe(0);
        expect(own.deps.reporter.text()).toContain(`already has its own ${phase.rules}`);
        expect(own.deps.reporter.text()).not.toContain("Another OpsCrew deployment");
        const empty = await run(target, phase, "user-empty", { kind: "unreadable" });
        expect(await managed(empty.setup, phase.flag)).toBe(false);
        expect(empty.deps.reporter.text()).toContain("OpsCrew did not create this one");
      });
    }
  }

  it("treats outputs of a root without a Cloudflare domain as a fresh project", async () => {
    for (const target of TARGETS) {
      for (const phase of PHASES) {
        if (target.tunnel && phase.phase === "http_config_settings") continue;
        const why = `${target.label}, ${phase.phase}`;
        const { deps, setup } = await run(target, phase, "opscrew", {
          kind: "outputs",
          outputs: { server_ipv4: "203.0.113.10", url: "http://203.0.113.10" },
        });
        expect(await managed(setup, phase.flag), why).toBe(false);
        expect(deps.reporter.text(), why).toContain("Another OpsCrew deployment");
      }
    }
  });

  it("tunnel mode: decides on the tunnel's WAF ruleset with the tunnel root's output (no configuration rule)", async () => {
    const target = TARGETS[3] as (typeof TARGETS)[number];
    const waf = PHASES[1] as (typeof PHASES)[number];
    // The tunnel root's `cloudflare_rulesets`: the WAF id, and null for the configuration rule.
    const tunnelOutputs = (id: string | null) => ({
      url: "https://shop.example.com",
      tunnel_id: "tunnel-1",
      cloudflare_rulesets: heldRulesetsOutput({ http_config_settings: null, [waf.phase]: id }),
    });
    const ours = await run(target, waf, "opscrew", {
      kind: "outputs",
      outputs: tunnelOutputs(fakeRulesetId(waf.phase)),
    });
    expect(await managed(ours.setup, waf.flag), "this project's").toBe(true);
    expect(ours.deps.reporter.text()).not.toContain("Another OpsCrew deployment");

    const fresh = await run(target, waf, "opscrew", { kind: "none" });
    expect(await managed(fresh.setup, waf.flag), "fresh project").toBe(false);
    expect(fresh.deps.reporter.text()).toContain(
      "Another OpsCrew deployment (or one whose state is gone) holds the example.com zone's WAF custom rules",
    );

    const another = await run(target, waf, "opscrew", {
      kind: "outputs",
      outputs: tunnelOutputs(null),
    });
    expect(await managed(another.setup, waf.flag), "another deployment's").toBe(false);
    expect(another.deps.reporter.text()).toContain("Another OpsCrew deployment");
  });

  it("reads the state once for both phases", async () => {
    const deps = await createTestPhaseDeps();
    await writeFakeState(deps.paths);
    const engine = outputsEngine({
      kind: "outputs",
      outputs: { ...SERVER, cloudflare_rulesets: heldRulesetsOutput() },
    });
    const setup = await setupCloudflare(deps, testPlan({ domain: "shop.example.com" }), {
      cloudflare: fakeCloudflare({ configRules: "opscrew", wafRules: "opscrew" }),
      engine: async () => engine,
    });
    expect(setup).toMatchObject({ manageConfigRule: true, manageWafRules: true });
    expect(engine.reads).toBe(1);
  });
});

describe("setupCloudflare for the user's Portainer", () => {
  const userRecord = (name: string) => ({
    id: `user-${name}`,
    type: "A",
    name,
    content: "198.51.100.20",
    ttl: 1,
    proxied: false,
  });

  async function setup(
    plan: DeployPlan,
    options: {
      records?: ReturnType<typeof userRecord>[];
      accounts?: string[];
      zoneAccount?: string;
    } = {},
  ) {
    const deps = await createTestPhaseDeps();
    const base = fakeCloudflare({
      records: options.records ?? [],
      configRules: "user",
      wafRules: "none",
    });
    const inspected: string[] = [];
    const cloudflare = {
      ...base,
      findZone: async () => ({
        id: "zone-123",
        name: "example.com",
        status: "active",
        nameServers: [],
        ...(options.zoneAccount !== undefined ? { accountId: options.zoneAccount } : {}),
      }),
      listAccounts: async () => (options.accounts ?? ["acc-1"]).map((id) => ({ id, name: id })),
      inspectEntrypointRuleset: async (zone: string, phase: Phase) => {
        inspected.push(phase);
        return base.inspectEntrypointRuleset(zone, phase);
      },
    };
    const setupResult = setupCloudflare(deps, plan, { cloudflare });
    return { deps, cloudflare, inspected, result: setupResult };
  }

  it("needs no Cloudflare at all without a tunnel (proxy or Caddy with the updater)", async () => {
    for (const web of [{ mode: "proxy", port: 8080 }, { mode: "caddy" }] as const) {
      const { result, cloudflare } = await setup(portainerPlan({ web }));
      expect(await result).toBeUndefined();
      expect(cloudflare.listed).toEqual([]);
    }
  });

  it("tunnel mode: checks the app's hostnames, reads the account, decides only the WAF phase", async () => {
    const { result, cloudflare, inspected } = await setup(portainerPlan({ www: true }));
    expect(await result).toEqual({
      zoneId: "zone-123",
      zoneName: "example.com",
      manageConfigRule: false,
      manageWafRules: true,
      accountId: "acc-1",
    });
    expect(cloudflare.listed).toEqual(["shop.example.com", "www.shop.example.com"]);
    expect(inspected).toEqual(["http_request_firewall_custom"]);
  });

  it("tunnel mode: stops on a record at the app's hostname OpsCrew did not create", async () => {
    const { result } = await setup(portainerPlan(), { records: [userRecord("shop.example.com")] });
    await expect(result).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      message: expect.stringContaining("A shop.example.com"),
    });
  });

  it("proxy or Caddy with the Cloudflare redeploy: the user's own record at the domain is expected", async () => {
    for (const web of [{ mode: "proxy", port: 8080 }, { mode: "caddy" }] as const) {
      const { result, cloudflare, inspected } = await setup(
        portainerPlan({ web, redeploy: "cloudflare" }),
        { records: [userRecord("shop.example.com")] },
      );
      expect(await result).toMatchObject({ zoneId: "zone-123", accountId: "acc-1" });
      // Only the webhook's hostname is OpsCrew's; no rule phase is used without the app's tunnel.
      expect(cloudflare.listed).toEqual(["portainer-shop.example.com"]);
      expect(inspected).toEqual([]);
    }
  });

  it("stops on a record at the webhook's hostname OpsCrew did not create", async () => {
    const { result } = await setup(portainerPlan({ redeploy: "cloudflare" }), {
      records: [userRecord("portainer-shop.example.com")],
    });
    await expect(result).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      message: expect.stringContaining("portainer-shop.example.com"),
    });
  });

  it("uses the zone's account when Cloudflare names it, and names the tunnel permissions otherwise", async () => {
    const named = await setup(portainerPlan(), { zoneAccount: "acc-zone", accounts: [] });
    expect(await named.result).toMatchObject({ accountId: "acc-zone" });
    const unknown = await setup(portainerPlan(), { accounts: ["a", "b"] });
    const error = await unknown.result.then(
      () => undefined,
      (e: unknown) => e as { code: string; hint: string },
    );
    expect(error).toMatchObject({ code: "CREDENTIALS_INVALID" });
    expect(error?.hint).toContain("Cloudflare Tunnel");
  });
});
