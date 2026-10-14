import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ResourceChange, ResourceMove } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { describe, expect, it } from "vitest";
import { createTestPhaseDeps, ScriptedApprovalHandler } from "../testing";
import { FakeEngine, type FakeEngineScenario, testPlan } from "./__fixtures__/fakes";
import { describePlan, findSavedPlan, isMovesOnly, planAndApply } from "./plan-apply";
import type { SavedPlan } from "./types";

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

async function setup(scenario: FakeEngineScenario, approve = true) {
  const handler = new ScriptedApprovalHandler(() => approve);
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

const DNS_UPDATE = [
  {
    address: "module.dns.cloudflare_dns_record.root_a",
    type: "cloudflare_dns_record",
    name: "root_a",
    provider: "registry.opentofu.org/cloudflare/cloudflare",
    action: "update" as const,
  },
];

describe("planAndApply refusal hint", () => {
  const DNS_DELETE = DNS_UPDATE.map((change) => ({ ...change, action: "delete" as const }));

  async function refused(changes: ResourceChange[], command?: string): Promise<string> {
    const { deps, engine, options } = await setup({ changes }, false);
    const error = await planAndApply(deps, {
      ...options,
      ...(command === undefined ? {} : { command }),
    }).catch((e: unknown) => e);
    expect(engine.calls).not.toContain("apply");
    expect(error).toBeInstanceOf(OpsCrewError);
    return (error as OpsCrewError).hint ?? "";
  }

  it("names only --approve for a plan that removes nothing", async () => {
    const hint = await refused(DNS_UPDATE);
    expect(hint).toMatch(
      /^To apply it later without prompts, run: opscrew provision --approve [0-9a-f]{64}$/,
    );
  });

  it("adds --confirm <app> for provision when the plan needs the typed app name", async () => {
    const hint = await refused(DNS_DELETE);
    expect(hint).toMatch(
      /^To apply it later without prompts, run: opscrew provision --approve [0-9a-f]{64} --confirm shop$/,
    );
  });

  it("points `opscrew dns` (no --confirm) to a terminal or opscrew provision", async () => {
    const hint = await refused(DNS_DELETE, "opscrew dns");
    expect(hint).toBe(
      "This plan deletes or replaces resources, so it needs the app's name: run `opscrew dns` in a terminal and type shop when asked, or in a script run `opscrew provision --plan-only` and then the command it prints (with --confirm shop).",
    );
  });
});

describe("planAndApply cost change", () => {
  it("keeps the plan's monthly cost as the cost change by default", async () => {
    const { deps, handler, options } = await setup({});
    await planAndApply(deps, options);
    expect(handler.requests[0]?.costDelta).toEqual(options.deployPlan.cost.monthly);
  });

  it("claims no cost change for a plan that changes nothing billed (costDelta null)", async () => {
    const { deps, handler, options } = await setup({ changes: DNS_UPDATE });
    await planAndApply(deps, { ...options, costDelta: null });
    const request = handler.requests[0];
    expect(request?.costDelta).toBeUndefined();
    expect(request?.details).toContain(
      "Cost: unchanged (nothing that is billed is created or deleted).",
    );
    expect(request?.details).not.toContain("Estimated cost");
  });

  it("uses an explicit cost change", async () => {
    const { deps, handler, options } = await setup({});
    const delta = { amount: 4.51, currency: "EUR" as const };
    await planAndApply(deps, { ...options, costDelta: delta });
    expect(handler.requests[0]?.costDelta).toEqual(delta);
  });
});

describe("findSavedPlan validation", () => {
  async function planned() {
    const { deps, engine, handler, options } = await setup({});
    const result = await planAndApply(deps, { ...options, planOnly: true });
    const hash = result.planHash as string;
    const sidecar = `${result.plan?.planFile}.json`;
    const content = JSON.parse(await readFile(sidecar, "utf8")) as Record<string, unknown>;
    return { deps, engine, handler, options, hash, sidecar, content };
  }

  it("returns a complete saved plan", async () => {
    const { deps, hash } = await planned();
    const saved = await findSavedPlan(deps.paths.files.plansDir, hash);
    expect(saved?.planHash).toBe(hash);
    expect(saved?.changes).toHaveLength(3);
    expect(saved?.planJson).toBeDefined();
  });

  const DAMAGE: [string, (content: Record<string, unknown>) => void][] = [
    ["without its changes", (c) => Reflect.deleteProperty(c, "changes")],
    ["with a malformed change", (c) => Object.assign(c, { changes: [{ address: 7 }] })],
    ["with malformed moves", (c) => Object.assign(c, { moves: [{ from: "module.server.x" }] })],
    ["without the plan JSON", (c) => Reflect.deleteProperty(c, "planJson")],
    ["without the engine", (c) => Reflect.deleteProperty(c, "engine")],
  ];

  it.each(DAMAGE)("fails closed for a sidecar %s", async (_what, damage) => {
    const { deps, engine, handler, options, hash, sidecar, content } = await planned();
    damage(content);
    await writeFile(sidecar, JSON.stringify(content));
    const error = await findSavedPlan(deps.paths.files.plansDir, hash).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpsCrewError);
    expect(error).toMatchObject({ code: "PLAN_HASH_MISMATCH" });
    expect((error as OpsCrewError).message).toContain(
      `The saved plan with the hash ${hash} is incomplete or damaged`,
    );
    expect((error as OpsCrewError).hint).toContain("plan again");

    const applying = await planAndApply(deps, { ...options, approvePlanHash: hash }).catch(
      (e: unknown) => e,
    );
    expect(applying).toMatchObject({ code: "PLAN_HASH_MISMATCH" });
    expect((applying as OpsCrewError).hint).toContain("opscrew provision --plan-only");
    expect(engine.calls).not.toContain("apply");
    expect(handler.requests).toEqual([]);
  });

  it("ignores unreadable sidecars of other plans", async () => {
    const { deps, hash } = await planned();
    await writeFile(join(deps.paths.files.plansDir, "0-broken.tfplan.json"), "{ not json");
    await writeFile(
      join(deps.paths.files.plansDir, "1-other.tfplan.json"),
      JSON.stringify({ planHash: "b".repeat(64) }),
    );
    expect((await findSavedPlan(deps.paths.files.plansDir, hash))?.planHash).toBe(hash);
    expect(await findSavedPlan(deps.paths.files.plansDir, "c".repeat(64))).toBeUndefined();
  });
});

describe("planAndApply hooks", () => {
  /** A setup whose approvals and engine applies are logged in `order`, with the hooks. */
  async function hooked(scenario: FakeEngineScenario, approve = true) {
    const order: string[] = [];
    const handler = new ScriptedApprovalHandler(() => {
      order.push("approve");
      return approve;
    });
    const deps = await createTestPhaseDeps({ approvalHandler: handler });
    const engine = new FakeEngine(scenario);
    const apply = engine.apply.bind(engine);
    engine.apply = async (dir, planFile, approval) => {
      order.push("apply");
      return apply(dir, planFile, approval);
    };
    const seen: { notes: string[]; before: string[]; failed: string[] } = {
      notes: [],
      before: [],
      failed: [],
    };
    const options = {
      engine,
      dir: join(deps.paths.root, "opscrew", "infra", "prod"),
      env: {},
      deployPlan: testPlan({ deployed: true, domain: "shop.example.com" }),
      files: [],
      approvalNotes: (plan: SavedPlan) => {
        order.push("notes");
        seen.notes.push(plan.planHash);
        return [`Note for ${plan.changes.length} change(s).`];
      },
      beforeApply: async (plan: SavedPlan) => {
        order.push("before");
        seen.before.push(plan.planHash);
      },
      applyFailed: (log: string, plan: SavedPlan) => {
        order.push("failed");
        seen.failed.push(`${plan.planHash}:${log}`);
      },
    };
    return { deps, engine, handler, options, order, seen };
  }

  it("asks for the notes from the plan shown and runs beforeApply once, after the approval", async () => {
    const s = await hooked({ changes: DNS_UPDATE });
    const result = await planAndApply(s.deps, s.options);
    expect(result.applied).toBe(true);
    expect(s.order).toEqual(["notes", "approve", "before", "apply"]);
    expect(s.seen.notes).toEqual([result.planHash]);
    expect(s.seen.before).toEqual([result.planHash]);
    expect(s.seen.failed).toEqual([]);
    expect(s.handler.requests[0]?.details).toMatch(
      /Plan hash: [0-9a-f]{64}\n\nNote for 1 change\(s\)\.$/,
    );
  });

  it("never runs beforeApply on a refusal or with --plan-only; the saved plan gets its notes too", async () => {
    const refused = await hooked({ changes: DNS_UPDATE }, false);
    const error = await planAndApply(refused.deps, refused.options).catch((e: unknown) => e);
    expect((error as OpsCrewError).code).toBe("APPROVAL_REFUSED");
    expect(refused.order).toEqual(["notes", "approve"]);
    expect(refused.engine.applied).toEqual([]);

    const s = await hooked({ changes: DNS_UPDATE });
    const planned = await planAndApply(s.deps, { ...s.options, planOnly: true });
    expect(planned.applied).toBe(false);
    expect(s.order).toEqual([]);

    const applied = await planAndApply(s.deps, {
      ...s.options,
      approvePlanHash: planned.planHash as string,
    });
    expect(applied.applied).toBe(true);
    expect(s.order).toEqual(["notes", "approve", "before", "apply"]);
    expect(s.seen.notes).toEqual([planned.planHash]);
    expect(s.seen.before).toEqual([planned.planHash]);
    expect(s.handler.requests[0]?.details).toContain("Note for 1 change(s).");
  });

  it("stops before the apply when beforeApply throws, and hears of a failed apply", async () => {
    const s = await hooked({ changes: DNS_UPDATE });
    const stop = new OpsCrewError("PROVIDER_ERROR", "Stopped before the apply.");
    const error = await planAndApply(s.deps, {
      ...s.options,
      beforeApply: async () => {
        s.order.push("before");
        throw stop;
      },
    }).catch((e: unknown) => e);
    expect(error).toBe(stop);
    expect(s.order).toEqual(["notes", "approve", "before"]);
    expect(s.engine.applied).toEqual([]);

    const failing = await hooked({ changes: DNS_UPDATE, applyOk: false, applyLog: "Error: boom" });
    const failed = await planAndApply(failing.deps, failing.options).catch((e: unknown) => e);
    expect((failed as OpsCrewError).code).toBe("ENGINE_FAILED");
    expect(failing.order).toEqual(["notes", "approve", "before", "apply", "failed"]);
    expect(failing.seen.failed).toEqual([`${failing.seen.before[0]}:Error: boom`]);
  });

  it("still takes a fixed list of notes", async () => {
    const s = await hooked({ changes: DNS_UPDATE });
    await planAndApply(s.deps, { ...s.options, approvalNotes: ["Warning: fixed."] });
    expect(s.handler.requests[0]?.details).toMatch(/\n\nWarning: fixed\.$/);
  });
});
