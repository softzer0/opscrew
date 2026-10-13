import { join } from "node:path";
import type { ResourceMove } from "@opscrew/contracts";
import { describe, expect, it } from "vitest";
import { createTestPhaseDeps, ScriptedApprovalHandler } from "../testing";
import { FakeEngine, type FakeEngineScenario, testPlan } from "./__fixtures__/fakes";
import { describePlan, findSavedPlan, isMovesOnly, planAndApply } from "./plan-apply";

const MOVES: ResourceMove[] = [
  {
    from: "module.server.hcloud_server.this",
    to: "module.server_previous.hcloud_server.this",
    type: "hcloud_server",
  },
  {
    from: "module.server.hcloud_firewall.this",
    to: "module.server_previous.hcloud_firewall.this",
    type: "hcloud_firewall",
  },
];

async function setup(scenario: FakeEngineScenario) {
  const handler = new ScriptedApprovalHandler(() => true);
  const deps = await createTestPhaseDeps({ approvalHandler: handler });
  const engine = new FakeEngine(scenario);
  const deployPlan = testPlan({ deployed: true, domain: "shop.example.com" });
  const options = {
    engine,
    dir: join(deps.paths.root, "opscrew", "infra", "prod"),
    env: {},
    deployPlan,
    files: [],
  };
  return { deps, engine, handler, options };
}

describe("planAndApply with state renames (moved blocks)", () => {
  it("applies a moves-only plan after an approval that names the renames and no cloud change", async () => {
    const { deps, engine, handler, options } = await setup({ changes: [], moves: MOVES });
    const result = await planAndApply(deps, options);

    expect(result.applied).toBe(true);
    expect(engine.calls).toEqual(["init", "validate", "plan", "apply"]);
    expect(engine.applied[0]?.approval).toEqual({
      approvedPlanHash: result.planHash,
      allowDestroy: false,
    });
    expect(handler.requests).toHaveLength(1);
    const request = handler.requests[0];
    expect(request?.kind).toBe("iac-apply");
    expect(request?.planHash).toBe(result.planHash);
    expect(request?.title).toBe(
      "Rename 2 resources in the infrastructure state (nothing changes in the cloud)",
    );
    expect(request?.title).not.toMatch(/to create|to update|to delete/);
    expect(request?.details).toContain(
      "module.server.hcloud_server.this → module.server_previous.hcloud_server.this",
    );
    expect(request?.details).toContain(
      "module.server.hcloud_firewall.this → module.server_previous.hcloud_firewall.this",
    );
    expect(request?.details).toContain(
      "Changes: none in the cloud; 2 resources renamed in the infrastructure state only.",
    );
    expect(request?.details).not.toContain("Estimated cost");
    expect(request?.costDelta).toBeUndefined();
    expect(request?.allowDestroy).toBeUndefined();
    expect(request?.confirmPhrase).toBeUndefined();

    const text = deps.reporter.text();
    expect(text).not.toContain("already up to date");
    expect(text).toContain("Renamed the resources in the infrastructure state");
    expect(deps.audit.entries).toContainEqual(
      expect.objectContaining({ kind: "iac", action: "apply", target: result.planHash }),
    );
  });

  it("is up to date only without changes and without moves", async () => {
    for (const moves of [undefined, []]) {
      const { deps, engine, handler, options } = await setup({
        changes: [],
        ...(moves ? { moves } : {}),
      });
      const result = await planAndApply(deps, options);
      expect(result.applied).toBe(false);
      expect(engine.calls).not.toContain("apply");
      expect(handler.requests).toEqual([]);
      expect(deps.reporter.text()).toContain("The infrastructure is already up to date.");
    }
  });

  it("--plan-only saves a moves-only plan and --approve applies exactly that plan", async () => {
    const { deps, engine, handler, options } = await setup({ changes: [], moves: MOVES });
    const planned = await planAndApply(deps, { ...options, planOnly: true });
    expect(planned.applied).toBe(false);
    expect(planned.planHash).toMatch(/^[0-9a-f]{64}$/);
    expect(engine.calls).toEqual(["init", "validate", "plan"]);
    expect(handler.requests).toEqual([]);
    expect(deps.reporter.text()).toContain(`Saved the plan (hash ${planned.planHash})`);
    expect(deps.reporter.text()).not.toContain("already up to date");
    const saved = await findSavedPlan(deps.paths.files.plansDir, planned.planHash as string);
    expect(saved?.moves).toEqual(MOVES);

    const applied = await planAndApply(deps, {
      ...options,
      approvePlanHash: planned.planHash as string,
    });
    expect(applied).toMatchObject({ applied: true, planHash: planned.planHash });
    expect(engine.calls).toEqual(["init", "validate", "plan", "apply"]);
    expect(engine.applied[0]?.planFile).toBe(saved?.planFile);
    expect(handler.requests.map((r) => r.title)).toEqual([
      "Rename 2 resources in the infrastructure state (nothing changes in the cloud)",
    ]);
  });

  it("keeps the usual title and cost for a plan with changes and lists its renames too", async () => {
    const { deps, handler, options } = await setup({ moves: MOVES.slice(0, 1) });
    await planAndApply(deps, options);
    const request = handler.requests[0];
    expect(request?.title).toBe(
      "Apply the infrastructure plan on Hetzner Cloud and Cloudflare (3 to create, 0 to update, 0 to delete, 0 to replace)",
    );
    expect(request?.costDelta).toEqual(options.deployPlan.cost.monthly);
    expect(request?.details).toContain(
      "Changes: 3 to create, 0 to update, 0 to delete, 0 to replace. 1 resource renamed in the infrastructure state.",
    );
    expect(request?.details).toContain(
      "  → moved   module.server.hcloud_server.this → module.server_previous.hcloud_server.this",
    );
    expect(request?.details).toContain("Estimated cost:");
  });
});

describe("isMovesOnly and describePlan", () => {
  it("tells moves-only plans apart", () => {
    expect(isMovesOnly({ changes: [], moves: MOVES })).toBe(true);
    expect(isMovesOnly({ changes: [], moves: [] })).toBe(false);
    expect(isMovesOnly({ changes: [] })).toBe(false);
  });

  it("does not mention a cost for a plan that only renames state", () => {
    const text = describePlan(
      {
        planHash: "a".repeat(64),
        planFile: "/plans/x.tfplan",
        dir: "/infra",
        engine: { name: "tofu", version: "1.13.1", binary: "/fake/tofu" },
        createdAt: "2026-10-11T12:00:00.000Z",
        changes: [],
        moves: MOVES.slice(0, 1),
        counts: { create: 0, update: 0, delete: 0, replace: 0 },
        hasDestroy: false,
        policy: [],
      },
      testPlan(),
    );
    expect(text).toContain(
      "Changes: none in the cloud; 1 resource renamed in the infrastructure state only.",
    );
    expect(text).toContain("Cost: unchanged (nothing is created, updated or deleted).");
    expect(text).not.toContain("Estimated cost");
  });
});
