import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ResourceChange, ResourceMove } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { describe, expect, it } from "vitest";
import { hidePortainerAddress, PlanRefusedError } from "../shared";
import {
  createTestPhaseDeps,
  FakeEngine,
  type FakeEngineScenario,
  portainerPlan,
  ScriptedApprovalHandler,
  testPlan,
} from "../testing";
import { sitePlan, workerCreate } from "../testing/serverless";
import {
  describePlan,
  findSavedPlan,
  isMovesOnly,
  planAndApply,
  REMOVAL_PLAN_SUFFIX,
} from "./plan-apply";
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

  it("is a PlanRefusedError whose parts say what stayed as it was", async () => {
    const { deps, engine, options } = await setup({ changes: DNS_UPDATE }, false);
    const error = await planAndApply(deps, options).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PlanRefusedError);
    expect(error).toMatchObject({
      code: "APPROVAL_REFUSED",
      message: "The infrastructure plan was not approved. Nothing was changed.",
      refusal: { plan: "infrastructure plan", unchanged: "Nothing was changed." },
    });
    expect(engine.calls).not.toContain("apply");
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

describe("planAndApply failure hint for an unavailable size", () => {
  it("says what the provider cannot create, then the caller's next step instead of `opscrew design`", async () => {
    const { deps, options } = await setup({ applyOk: false });
    const plain = (await planAndApply(deps, options).catch((e: unknown) => e)) as OpsCrewError;
    expect(plain.code).toBe("ENGINE_FAILED");
    expect(plain.hint).toBe(
      "Hetzner Cloud cannot create a cx23 server in nbg1 right now (the server type is unavailable or out of stock there). Run `opscrew design` to pick another server type or location, then run `opscrew provision` again. Nothing that was already created is removed.",
    );

    const moving = await setup({ applyOk: false });
    const error = (await planAndApply(moving.deps, {
      ...moving.options,
      redesignHint: "Run `opscrew retarget --abort`, then start the move again.",
    }).catch((e: unknown) => e)) as OpsCrewError;
    expect(error.code).toBe("ENGINE_FAILED");
    expect(error.hint).toBe(
      "Hetzner Cloud cannot create a cx23 server in nbg1 right now (the server type is unavailable or out of stock there). Run `opscrew retarget --abort`, then start the move again.",
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

describe("planAndApply for the user's Portainer", () => {
  const TUNNEL_CREATE: ResourceChange[] = [
    ["cloudflare_zero_trust_tunnel_cloudflared", "this"],
    ["cloudflare_zero_trust_tunnel_cloudflared_config", "this"],
    ["cloudflare_dns_record", "route"],
  ].map(([type, name]) => ({
    address: `module.tunnel.${type}.${name}`,
    type: type as string,
    name: name as string,
    provider: "registry.opentofu.org/cloudflare/cloudflare",
    action: "create" as const,
  }));

  async function portainerSetup(scenario: FakeEngineScenario, approve = true) {
    const base = await setup(scenario, approve);
    return { ...base, options: { ...base.options, deployPlan: portainerPlan() } };
  }

  it("asks for the Cloudflare plan in Cloudflare's words, with no cost, and applies it", async () => {
    const { deps, engine, handler, options } = await portainerSetup({
      changes: TUNNEL_CREATE,
      outputs: { url: "https://shop.example.com", tunnel_id: "t-1" },
    });
    const result = await planAndApply(deps, options);
    expect(result.applied).toBe(true);
    expect(engine.calls).toEqual(["init", "validate", "plan", "apply"]);
    const request = handler.requests[0];
    expect(request?.title).toBe(
      "Apply the infrastructure plan on Cloudflare (3 to create, 0 to update, 0 to delete, 0 to replace)",
    );
    expect(request?.costDelta).toBeUndefined();
    expect(request?.details).toContain("Cost: unchanged");
    expect(request?.details).not.toContain("Estimated cost");
  });

  it("uses the caller's title", async () => {
    const { deps, handler, options } = await portainerSetup({ changes: TUNNEL_CREATE });
    await planAndApply(deps, { ...options, approvalTitle: "Apply the Cloudflare plan" });
    expect(handler.requests[0]?.title).toBe("Apply the Cloudflare plan");
  });

  it("blames a refused Cloudflare request on the Cloudflare token (also the Portainer tunnel's)", async () => {
    const { deps, options } = await portainerSetup({
      changes: TUNNEL_CREATE,
      applyOk: false,
      applyLog: [
        "Error: failed to create tunnel",
        "  with module.portainer_tunnel.cloudflare_zero_trust_tunnel_cloudflared.this,",
        "  403 Forbidden",
      ].join("\n"),
    });
    const error = (await planAndApply(deps, options).catch((e: unknown) => e)) as OpsCrewError;
    expect(error.code).toBe("ENGINE_FAILED");
    expect(error.hint).toContain("Cloudflare refused the request");
    expect(error.hint).toContain("CLOUDFLARE_API_TOKEN");
    expect(error.hint).toContain("Cloudflare Tunnel");
  });

  it("gives the plain next step for any other failed apply", async () => {
    const { deps, options } = await portainerSetup({
      changes: TUNNEL_CREATE,
      applyOk: false,
      applyLog: "Error: something else went wrong",
    });
    const error = (await planAndApply(deps, options).catch((e: unknown) => e)) as OpsCrewError;
    expect(error.code).toBe("ENGINE_FAILED");
    expect(error.hint).toBe(
      "Fix the cause shown above, then run `opscrew provision` again; it plans the remaining changes.",
    );
  });
});

describe.each([
  ["Cloudflare's hosting", "cloudflare-workers", "Account → Workers Scripts → Edit"],
  ["GitHub Pages", "github-pages", "Zone → DNS → Edit"],
] as const)("planAndApply for %s", (_name, provider, permission) => {
  // What the plan creates does not matter here: only how the approval and the hints name it.
  const changes = workerCreate(sitePlan());

  async function siteSetup(scenario: FakeEngineScenario) {
    const base = await setup({ changes, ...scenario });
    return { ...base, options: { ...base.options, deployPlan: sitePlan({ provider }) } };
  }

  it("asks for the plan in Cloudflare's words, never as a server's, and applies it", async () => {
    const { deps, engine, handler, options } = await siteSetup({
      outputs: { url: "https://docs.example.com" },
    });
    const result = await planAndApply(deps, options);
    expect(result.applied).toBe(true);
    expect(engine.calls).toEqual(["init", "validate", "plan", "apply"]);
    expect(handler.requests[0]?.title).toBe(
      "Apply the infrastructure plan on Cloudflare (4 to create, 0 to update, 0 to delete, 0 to replace)",
    );
  });

  it("blames a refused request on the Cloudflare token, with the target's permissions", async () => {
    const { deps, options } = await siteSetup({
      applyOk: false,
      applyLog: "Error: failed to create the resource\n  403 Forbidden",
    });
    const error = (await planAndApply(deps, options).catch((e: unknown) => e)) as OpsCrewError;
    expect(error.code).toBe("ENGINE_FAILED");
    expect(error.hint).toContain("Cloudflare refused the request");
    expect(error.hint).toContain("CLOUDFLARE_API_TOKEN");
    expect(error.hint).toContain(permission);
  });

  it("gives the plain next step for any other failed apply", async () => {
    const { deps, options } = await siteSetup({
      applyOk: false,
      applyLog: "Error: something else went wrong",
    });
    const error = (await planAndApply(deps, options).catch((e: unknown) => e)) as OpsCrewError;
    expect(error.hint).toBe(
      "Fix the cause shown above, then run `opscrew provision` again; it plans the remaining changes.",
    );
  });
});

describe("saved plan sidecars pass through the redactor", () => {
  // A documentation address (RFC 5737) standing in for the Portainer host's IPv4.
  const ADDRESS = "203.0.113.9";
  const TUNNEL = "module.tunnel.cloudflare_zero_trust_tunnel_cloudflared.this";
  const TUNNEL_DELETE: ResourceChange[] = [
    {
      address: TUNNEL,
      type: "cloudflare_zero_trust_tunnel_cloudflared",
      name: "this",
      provider: "registry.opentofu.org/cloudflare/cloudflare",
      action: "delete",
    },
  ];
  /**
   * A removal plan holding the registered address where the plan marks nothing sensitive: a
   * tunnel route's origin (as if the value had not come from the sensitive variable) and an
   * untyped drift entry. A tunnel's own `connections` are masked by `maskSensitivePlanJson`.
   */
  const removalPlanJson = () => ({
    format_version: "1.2",
    resource_changes: [
      {
        address: TUNNEL,
        type: "cloudflare_zero_trust_tunnel_cloudflared",
        change: {
          actions: ["delete"],
          before: {
            name: "opscrew-shop",
            connections: [{ colo_name: "fra08", origin_ip: ADDRESS }],
          },
          after: null,
          before_sensitive: { connections: [{}] },
          after_sensitive: false,
        },
      },
      {
        address: "module.portainer_tunnel.cloudflare_zero_trust_tunnel_cloudflared_config.this",
        type: "cloudflare_zero_trust_tunnel_cloudflared_config",
        change: {
          actions: ["delete"],
          before: { config: { ingress: [{ service: `https://${ADDRESS}:9443` }] } },
          after: null,
          before_sensitive: { config: { ingress: [{}] } },
          after_sensitive: false,
        },
      },
    ],
    resource_drift: [
      {
        address: TUNNEL,
        change: {
          before: { connections: [] },
          after: { connections: [{ origin_ip: ADDRESS }] },
          before_sensitive: {},
          after_sensitive: {},
        },
      },
    ],
    // A key can name the address too (a map keyed by host).
    checks: { [`https://${ADDRESS}:9443`]: { status: "unknown" } },
  });

  async function removalSetup() {
    const base = await setup({ changes: TUNNEL_DELETE, planJson: removalPlanJson() });
    hidePortainerAddress(base.deps.redactor, `https://${ADDRESS}:9443`);
    return {
      ...base,
      options: { ...base.options, deployPlan: portainerPlan(), destroy: true },
    };
  }

  it("masks a registered address held in a value the plan does not mark sensitive, and --approve still applies that plan", async () => {
    const { deps, engine, handler, options } = await removalSetup();
    const planned = await planAndApply(deps, { ...options, planOnly: true });
    const planFile = planned.plan?.planFile as string;
    expect(planFile.endsWith(REMOVAL_PLAN_SUFFIX)).toBe(true);
    const text = await readFile(`${planFile}.json`, "utf8");
    expect(text).not.toContain(ADDRESS);
    expect(text).toContain('"origin_ip": "[REDACTED:portainer-address]"');
    expect(text).toContain('"service": "[REDACTED:portainer-address]"');
    expect(text).toContain('"connections": "(sensitive value)"');
    expect(text).toContain('"[REDACTED:portainer-address]": {');
    expect(JSON.parse(text).planHash).toBe(planned.planHash);

    const saved = await findSavedPlan(deps.paths.files.plansDir, planned.planHash as string);
    expect(saved?.planFile).toBe(planFile);
    expect(saved?.changes).toEqual(TUNNEL_DELETE);
    const applied = await planAndApply(deps, {
      ...options,
      approvePlanHash: planned.planHash as string,
    });
    expect(applied).toMatchObject({ applied: true, planHash: planned.planHash });
    expect(engine.applied).toEqual([
      { planFile, approval: { approvedPlanHash: planned.planHash, allowDestroy: true } },
    ]);
    expect(handler.requests.map((r) => r.kind)).toEqual(["iac-apply"]);
    expect(handler.requests[0]?.details).not.toContain(ADDRESS);
  });

  it("finds the plan file beside its sidecar even when a registered name masked the stored path", async () => {
    const { deps, engine, options } = await removalSetup();
    // A name that is also a folder of the project path (`…/.opscrew/plans/…`).
    deps.redactor.addName("plans", "host");
    const planned = await planAndApply(deps, { ...options, planOnly: true });
    const planFile = planned.plan?.planFile as string;
    const stored = JSON.parse(await readFile(`${planFile}.json`, "utf8")) as { planFile: string };
    expect(stored.planFile).not.toBe(planFile);
    expect(stored.planFile).toContain("[REDACTED:host]");

    const saved = await findSavedPlan(deps.paths.files.plansDir, planned.planHash as string);
    expect(saved?.planFile).toBe(planFile);
    await planAndApply(deps, { ...options, approvePlanHash: planned.planHash as string });
    expect(engine.applied.map((a) => a.planFile)).toEqual([planFile]);
  });

  it("keeps the hash binding: a changed plan file beside the sidecar is not applied", async () => {
    const { deps, engine, options } = await removalSetup();
    const planned = await planAndApply(deps, { ...options, planOnly: true });
    await writeFile(planned.plan?.planFile as string, "a different plan");
    const error = await planAndApply(deps, {
      ...options,
      approvePlanHash: planned.planHash as string,
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "PLAN_HASH_MISMATCH" });
    expect(engine.calls).not.toContain("apply");
  });
});
