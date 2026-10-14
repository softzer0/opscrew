import type { IacEngine } from "@opscrew/contracts";
import type { DeployPlan } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { createTestPhaseDeps } from "../testing";
import {
  type FakeRuleset,
  fakeCloudflare,
  fakeRulesetId,
  heldRulesetsOutput,
  testPlan,
  writeFakeState,
} from "./__fixtures__/fakes";
import { ownCloudflare, ownPlan } from "./__fixtures__/own";
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

const TARGETS: { label: string; plan: () => DeployPlan; own: boolean }[] = [
  { label: "Hetzner", plan: () => testPlan({ domain: "shop.example.com" }), own: false },
  { label: "an own server", plan: () => ownPlan(), own: true },
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

      it(`${label}: keeps managing OpsCrew's ruleset of a state applied before the ids were recorded`, async () => {
        const { deps, setup } = await run(target, phase, "opscrew", {
          kind: "outputs",
          outputs: SERVER,
        });
        expect(await managed(setup, phase.flag)).toBe(true);
        expect(deps.reporter.text()).not.toContain("Another OpsCrew deployment");
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
