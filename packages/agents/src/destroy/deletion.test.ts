import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
  ApprovalRequest,
  IacApplyResult,
  IacApproval,
  IacEngine,
  IacRunOptions,
  PlanSummary,
  ResourceChange,
  VpsProviderId,
} from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { describe, expect, it } from "vitest";
import { HOST_KEY } from "../provision/__fixtures__/fakes";
import { createTestPhaseDeps, ScriptedApprovalHandler } from "../testing";
import { FakeServers, serverAttributes } from "./__fixtures__/fakes";
import {
  assertDeletionPlan,
  confirmDeletion,
  type DeletionSession,
  forgetHostKeys,
  infraDeclaresVariable,
  liftProtection,
  previewDeletion,
  remainingAfterDeletion,
  snapshotRecordPath,
  snapshotWanted,
  takeSnapshotBeforeDelete,
} from "./deletion";
import type { DestroyPreview } from "./types";

const sha256 = (data: string) => createHash("sha256").update(data).digest("hex");
const HCLOUD = "registry.opentofu.org/hetznercloud/hcloud";
const PREFIX = "module.server_previous.";
const PREVIOUS_SERVER = "module.server_previous.hcloud_server.this";
const FINISH = "opscrew retarget --finish";

function at(address: string, action: ResourceChange["action"] = "delete"): ResourceChange {
  const parts = address.split(".");
  return {
    address,
    type: parts[parts.length - 2] as string,
    name: parts[parts.length - 1] as string,
    provider: HCLOUD,
    action,
  };
}

/** The old Hetzner server's resources after the rename to `module.server_previous`. */
const PREVIOUS = [
  at("module.server_previous.hcloud_ssh_key.deploy"),
  at("module.server_previous.hcloud_firewall.this"),
  at(PREVIOUS_SERVER),
];

type Scripted = { changes: ResourceChange[]; planJson: unknown };

/** `show -json` of a deletion plan: the state's ids in `before` (the server's is 4711). */
function deletionJson(changes: readonly ResourceChange[], serverId = "4711") {
  return {
    format_version: "1.2",
    resource_changes: changes.map((c) => ({
      address: c.address,
      type: c.type,
      change: {
        actions: [c.action],
        before: { id: c.type === "hcloud_server" ? serverId : `${c.name}-1` },
        after: null,
      },
    })),
  };
}

/** A protection-lifting plan of the server at `address`. */
function unprotectAt(address: string, extra: Record<string, unknown> = {}): Scripted {
  const before = serverAttributes();
  const after = serverAttributes({ delete_protection: false, rebuild_protection: false, ...extra });
  return {
    changes: [at(address, "update")],
    planJson: {
      resource_changes: [
        { address, type: "hcloud_server", change: { actions: ["update"], before, after } },
      ],
    },
  };
}

/** Engine fake for a move's root module: every plan returns `next(options)`; applies check hashes. */
class MoveEngine implements IacEngine {
  readonly info = { name: "tofu" as const, version: "1.13.1", binary: "/fake/tofu" };
  readonly planOptions: (IacRunOptions & { destroy?: boolean })[] = [];
  readonly applied: IacApproval[] = [];
  #counter = 0;

  constructor(public next: (options: IacRunOptions & { destroy?: boolean }) => Scripted) {}

  async init(): Promise<void> {}
  async validate() {
    return { valid: true, diagnostics: [] };
  }
  async output() {
    return {};
  }

  async plan(
    dir: string,
    planFile: string,
    options: IacRunOptions & { destroy?: boolean } = {},
  ): Promise<PlanSummary> {
    this.planOptions.push(options);
    const content = `fake plan ${++this.#counter}`;
    await writeFile(planFile, content);
    const { changes, planJson } = this.next(options);
    const count = (action: string) => changes.filter((c) => c.action === action).length;
    return {
      engine: this.info,
      dir,
      planFile,
      planHash: sha256(content),
      createdAt: "2026-10-11T12:00:00.000Z",
      changes,
      counts: {
        create: count("create"),
        update: count("update"),
        delete: count("delete"),
        replace: count("replace"),
      },
      hasDestroy: changes.some((c) => c.action === "delete" || c.action === "replace"),
      planJson,
    };
  }

  async apply(_dir: string, planFile: string, approval: IacApproval): Promise<IacApplyResult> {
    if (sha256(await readFile(planFile, "utf8")) !== approval.approvedPlanHash) {
      throw new Error("plan hash mismatch");
    }
    this.applied.push(approval);
    return { ok: true, outputs: {}, log: "Apply complete!" };
  }
}

async function setup(
  options: {
    provider?: VpsProviderId;
    next?: (options: IacRunOptions & { destroy?: boolean }) => Scripted;
    answer?: (request: ApprovalRequest) => boolean;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "opscrew-deletion-"));
  const handler = new ScriptedApprovalHandler(options.answer ?? (() => true));
  const deps = await createTestPhaseDeps({ root, approvalHandler: handler });
  await mkdir(deps.paths.files.plansDir, { recursive: true });
  const engine = new MoveEngine(
    options.next ?? (() => ({ changes: PREVIOUS, planJson: deletionJson(PREVIOUS) })),
  );
  const session: DeletionSession = {
    deps,
    provider: options.provider ?? "hetzner",
    app: "shop",
    command: FINISH,
    what: "removal of the old server",
    phase: "retarget",
    engine,
    env: {},
    dir: join(root, "opscrew", "infra"),
    stamp: "2026-10-11T12-00-00-000Z",
  };
  return { root, deps, handler, engine, session };
}

async function plansLeft(session: DeletionSession): Promise<string[]> {
  return readdir(session.deps.paths.files.plansDir);
}

function preview(overrides: Partial<DestroyPreview> = {}): DestroyPreview {
  return {
    name: "shop",
    provider: "hetzner",
    deleteProtection: true,
    resources: PREVIOUS,
    snapshot: true,
    ...overrides,
  };
}

describe("previewDeletion", () => {
  it("previews a normal plan bounded to a prefix and discards it", async () => {
    const { session, engine } = await setup();
    const result = await previewDeletion(session, { suffix: "finish-preview", prefix: PREFIX });
    expect(result.changes).toEqual(PREVIOUS);
    expect([...result.addresses]).toEqual(PREVIOUS.map((c) => c.address));
    expect(result.serverInState).toBe(true);
    expect(result.serverIds).toEqual(["4711"]);
    // a normal plan of the root without the module: no destroy flag, no variables
    expect(engine.planOptions).toEqual([{ env: {} }]);
    expect(await plansLeft(session)).toEqual([]);
  });

  it("stops with nothing changed when the plan touches anything outside the prefix", async () => {
    const changes = [...PREVIOUS, at("module.server.hcloud_server.this")];
    const { session, engine } = await setup({
      next: () => ({ changes, planJson: deletionJson(changes) }),
    });
    const error = await previewDeletion(session, { suffix: "p", prefix: PREFIX }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(OpsCrewError);
    expect(error).toMatchObject({ code: "PHASE_PRECONDITION" });
    const { message, hint } = error as OpsCrewError;
    expect(message).toBe(
      [
        "The removal of the old server plan would do more than delete resources under module.server_previous., so OpsCrew stopped. Nothing was changed.",
        "  delete module.server.hcloud_server.this",
      ].join("\n"),
    );
    expect(hint).toContain(`run \`${FINISH}\` again`);
    expect(engine.applied).toEqual([]);
    expect(await plansLeft(session)).toEqual([]);
  });

  it("passes variables and the destroy flag through (opscrew destroy's whole-root preview)", async () => {
    const { session, engine } = await setup({
      next: () => ({ changes: [at("module.dns.cloudflare_dns_record.a")], planJson: {} }),
    });
    const result = await previewDeletion(session, {
      suffix: "destroy-preview",
      vars: { delete_protection: "false" },
      destroy: true,
    });
    expect(result.serverInState).toBe(false);
    expect(result.serverIds).toEqual([]);
    expect(engine.planOptions).toEqual([
      { env: {}, vars: { delete_protection: "false" }, destroy: true },
    ]);
  });
});

describe("invalid prefixes", () => {
  it("are refused before anything is planned or applied", async () => {
    for (const prefix of ["module.server", ""]) {
      const { session, engine, handler } = await setup({
        next: () => unprotectAt(PREVIOUS_SERVER),
      });
      await expect(previewDeletion(session, { suffix: "p", prefix })).rejects.toMatchObject({
        code: "INTERNAL",
      });
      await expect(
        liftProtection(session, {
          variable: "previous_delete_protection",
          prefix,
          serverInState: true,
          mismatchHint: "x",
        }),
      ).rejects.toMatchObject({ code: "INTERNAL" });
      expect(() =>
        assertDeletionPlan(
          { provider: "hetzner", what: "x" },
          { changes: PREVIOUS },
          { prefix },
          { note: "", hint: "" },
        ),
      ).toThrow(expect.objectContaining({ code: "INTERNAL" }));
      expect(engine.planOptions).toEqual([]);
      expect(engine.applied).toEqual([]);
      expect(handler.requests).toEqual([]);
    }
  });
});

describe("assertDeletionPlan", () => {
  const scope = { provider: "hetzner" as const, what: "removal of the old server" };
  const stop = { note: "Nothing was deleted.", hint: "Try again." };
  const confirmed = new Set(PREVIOUS.map((c) => c.address));

  it("accepts deletes of the confirmed resources and server under the prefix", () => {
    const summary = { changes: PREVIOUS, planJson: deletionJson(PREVIOUS) };
    expect(() =>
      assertDeletionPlan(scope, summary, { prefix: PREFIX, confirmed, serverIds: ["4711"] }, stop),
    ).not.toThrow();
  });

  it("refuses deletes that were not in the confirmed preview", () => {
    const changes = [...PREVIOUS, at("module.server_previous.hcloud_volume.data")];
    expect(() =>
      assertDeletionPlan(
        scope,
        { changes, planJson: deletionJson(changes) },
        { prefix: PREFIX, confirmed },
        stop,
      ),
    ).toThrow(
      "The removal of the old server plan now deletes resources that were not in the list you confirmed, so OpsCrew stopped. Nothing was deleted.\n  module.server_previous.hcloud_volume.data",
    );
  });

  it("refuses another server than the confirmed one", () => {
    const summary = { changes: PREVIOUS, planJson: deletionJson(PREVIOUS, "4712") };
    expect(() =>
      assertDeletionPlan(scope, summary, { prefix: PREFIX, confirmed, serverIds: ["4711"] }, stop),
    ).toThrow(
      "The removal of the old server plan now deletes a server other than the one you confirmed (id 4711), so OpsCrew stopped. Nothing was deleted.",
    );
  });

  it("refuses updates and creates, even under the prefix", () => {
    const changes = [at(PREVIOUS_SERVER, "update")];
    expect(() => assertDeletionPlan(scope, { changes }, { prefix: PREFIX }, stop)).toThrow(
      `  update ${PREVIOUS_SERVER}`,
    );
  });
});

describe("confirmDeletion", () => {
  it("audits a refusal and stops with APPROVAL_REFUSED before anything changes", async () => {
    const { session, deps } = await setup();
    const seen: DestroyPreview[] = [];
    const error = await confirmDeletion(session, preview(), async (p) => {
      seen.push(p);
      return false;
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: "APPROVAL_REFUSED",
      message: "The server name was not confirmed, so nothing was deleted and nothing was changed.",
      hint: `Run \`${FINISH}\` again and type shop when asked.`,
    });
    expect(seen).toEqual([preview()]);
    expect(deps.audit.entries.filter((e) => e.kind === "approval")).toMatchObject([
      {
        actor: "user",
        action: "destroy-confirm",
        phase: "retarget",
        target: "shop",
        decision: "refused",
        detail: "typed confirmation for deleting 3 resources",
      },
    ]);
  });

  it("audits a confirmation and returns; without a hook or resources it asks nothing", async () => {
    const { session, deps } = await setup();
    await confirmDeletion(session, preview(), async () => true);
    expect(deps.audit.entries.map((e) => e.decision)).toEqual(["approved"]);
    let asked = 0;
    await confirmDeletion(session, preview({ resources: [] }), async () => {
      asked++;
      return false;
    });
    await confirmDeletion(session, preview(), undefined);
    expect(asked).toBe(0);
    expect(deps.audit.entries).toHaveLength(1);
  });

  it("names the provider's noun (a Droplet on DigitalOcean)", async () => {
    const { session } = await setup({ provider: "digitalocean" });
    await expect(
      confirmDeletion(session, preview({ provider: "digitalocean" }), async () => false),
    ).rejects.toThrow("The Droplet name was not confirmed");
  });
});

describe("takeSnapshotBeforeDelete", () => {
  const input = (servers: FakeServers, overrides = {}) => ({
    server: { inState: true, ids: ["4711"] },
    data: { postgres: true, backups: false },
    purpose: "retarget" as const,
    servers,
    ...overrides,
  });

  it("snapshots the server with the plan's id for a move, with its own record", async () => {
    const { session, deps } = await setup();
    const servers = new FakeServers();
    servers.servers.push({ id: "4800", name: "shop", status: "running" });
    const id = await takeSnapshotBeforeDelete(session, input(servers));
    expect(id).toBe("9001");
    expect(servers.snapshots).toEqual([
      {
        serverId: "4711",
        name: "opscrew-shop-before-retarget-20261011T120000Z",
        description: `OpsCrew snapshot of shop before ${FINISH} (2026-10-11T12:00:00.000Z)`,
        labels: {
          app: "shop",
          "created-by": "opscrew",
          reason: "retarget",
          "taken-at": "20261011T120000Z",
        },
        timeoutMs: 15 * 60_000,
      },
    ]);
    const record = snapshotRecordPath(deps, "retarget");
    expect(record).toBe(join(deps.paths.stateDir, "retarget-snapshot.json"));
    expect(JSON.parse(await readFile(record, "utf8"))).toEqual({
      provider: "hetzner",
      serverId: "4711",
      snapshotId: "9001",
      takenAt: "2026-10-11T12:00:00.000Z",
    });
    expect(existsSync(snapshotRecordPath(deps, "destroy"))).toBe(false);
    const calls = deps.audit.entries.filter((e) => e.kind === "provider-call");
    expect(calls.map((e) => [e.action, e.phase, e.target])).toEqual([
      ["create snapshot", "retarget", "hetzner server 4711"],
      ["snapshot ready", "retarget", "hetzner server 4711"],
    ]);
  });

  it("never reuses a destroy run's snapshot for a move, but reuses the move's own", async () => {
    const { session, deps } = await setup();
    await mkdir(deps.paths.stateDir, { recursive: true });
    const stale = { provider: "hetzner", serverId: "4711", snapshotId: "1234", takenAt: "x" };
    await writeFile(snapshotRecordPath(deps, "destroy"), JSON.stringify(stale));
    const servers = new FakeServers();
    expect(await takeSnapshotBeforeDelete(session, input(servers))).toBe("9001");
    expect(servers.snapshots).toHaveLength(1);

    // a re-run of the finish (refused or failed after the snapshot) reuses it
    expect(await takeSnapshotBeforeDelete(session, input(servers))).toBe("9001");
    expect(servers.snapshots).toHaveLength(1);
    expect(deps.reporter.text()).toContain(
      "Reusing the snapshot taken by the earlier run (Hetzner image 9001).",
    );
  });

  it("skips the snapshot when not wanted, and words a lookup failure with the command", async () => {
    const { session, deps } = await setup();
    const servers = new FakeServers();
    expect(await takeSnapshotBeforeDelete(session, input(servers, { choice: false }))).toBe(
      undefined,
    );
    expect(
      await takeSnapshotBeforeDelete(
        session,
        input(servers, { data: { postgres: false, backups: false } }),
      ),
    ).toBe(undefined);
    expect(deps.reporter.text()).toContain("Skipping the snapshot, as requested.");
    expect(deps.reporter.text()).toContain(
      "No snapshot: the database does not run on the server and Hetzner backups are off.",
    );
    servers.lookupError = new OpsCrewError("PROVIDER_ERROR", "Hetzner is down.");
    const error = await takeSnapshotBeforeDelete(session, input(servers)).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: "PROVIDER_ERROR",
      message: "The snapshot of shop failed: Hetzner is down. Nothing was deleted.",
    });
    expect((error as OpsCrewError).hint).toContain(`\`${FINISH} --no-snapshot\``);
    expect(servers.snapshots).toEqual([]);
  });

  it("resolves auto from the deleted server's data", () => {
    expect(snapshotWanted(undefined, { postgres: false, backups: true })).toBe(true);
    expect(snapshotWanted("auto", { postgres: false, backups: false })).toBe(false);
    expect(snapshotWanted(true, { postgres: false, backups: false })).toBe(true);
    expect(snapshotWanted(false, { postgres: true, backups: true })).toBe(false);
  });
});

describe("liftProtection", () => {
  const lift = {
    variable: "previous_delete_protection",
    prefix: PREFIX,
    serverInState: true,
    mismatchHint: "Check the old server.",
  };

  it("lifts the old server's protection with previous_delete_protection after an approval", async () => {
    const { session, deps, engine, handler } = await setup({
      next: () => unprotectAt(PREVIOUS_SERVER),
    });
    const result = await liftProtection(session, lift);
    expect(result.off).toBe(true);
    expect(result.approval?.approved).toBe(true);
    expect(engine.planOptions).toEqual([
      { env: {}, vars: { previous_delete_protection: "false" } },
    ]);
    expect(handler.requests).toHaveLength(1);
    expect(handler.requests[0]).toMatchObject({
      kind: "iac-apply",
      title: "Lift delete protection on shop",
    });
    expect(handler.requests[0]?.allowDestroy).toBeUndefined();
    expect(handler.requests[0]?.details).toContain(`~ update  ${PREVIOUS_SERVER}`);
    expect(engine.applied).toEqual([
      { approvedPlanHash: handler.requests[0]?.planHash, allowDestroy: false },
    ]);
    const applies = deps.audit.entries.filter((e) => e.kind === "iac");
    expect(applies.map((e) => [e.phase, e.detail])).toEqual([
      ["retarget", "lifting delete protection: apply finished"],
    ]);
    expect(await plansLeft(session)).toEqual([]);
  });

  it("stops before the approval when the plan changes the new server or anything else", async () => {
    for (const scripted of [
      unprotectAt("module.server.hcloud_server.this"),
      unprotectAt(PREVIOUS_SERVER, { server_type: "cx53" }),
    ]) {
      const { session, engine, handler } = await setup({ next: () => scripted });
      const error = await liftProtection(session, lift).catch((e: unknown) => e);
      expect(error).toMatchObject({ code: "PHASE_PRECONDITION", hint: "Check the old server." });
      expect((error as OpsCrewError).message).toContain(
        "Lifting the delete protection on shop would also change other things, so OpsCrew stopped. Nothing was changed.",
      );
      expect(handler.requests).toEqual([]);
      expect(engine.applied).toEqual([]);
      expect(await plansLeft(session)).toEqual([]);
    }
  });

  it("a refusal applies nothing and names the command and the kept snapshot", async () => {
    const { session, engine } = await setup({
      next: () => unprotectAt(PREVIOUS_SERVER),
      answer: () => false,
    });
    const error = await liftProtection(session, { ...lift, snapshotId: "9001" }).catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({
      code: "APPROVAL_REFUSED",
      hint: `Run \`${FINISH}\` again when you are ready.`,
    });
    expect((error as OpsCrewError).message).toContain("The snapshot (Hetzner image 9001) was kept");
    expect(engine.applied).toEqual([]);
  });

  it("does nothing on DigitalOcean, when protection is already off, or without the server", async () => {
    const droplet = await setup({ provider: "digitalocean" });
    expect(await liftProtection(droplet.session, lift)).toEqual({ off: false });
    expect(droplet.engine.planOptions).toEqual([]);

    const gone = await setup();
    expect(await liftProtection(gone.session, { ...lift, serverInState: false })).toEqual({
      off: false,
    });
    expect(gone.engine.planOptions).toEqual([]);

    const off = await setup({ next: () => ({ changes: [], planJson: {} }) });
    expect(await liftProtection(off.session, lift)).toEqual({ off: true });
    expect(off.handler.requests).toEqual([]);
  });
});

describe("forgetHostKeys", () => {
  it("removes the given hosts only and says how many lines went", async () => {
    const { deps } = await setup();
    const file = deps.paths.files.knownHosts;
    await mkdir(dirname(file), { recursive: true });
    await writeFile(
      file,
      [`198.51.100.7 ${HOST_KEY}`, `203.0.113.10 ${HOST_KEY}`, `2001:db8::10 ${HOST_KEY}`, ""].join(
        "\n",
      ),
    );
    expect(await forgetHostKeys(deps, ["203.0.113.10", "2001:db8::10", undefined, ""])).toBe(2);
    expect(await readFile(file, "utf8")).toBe(`198.51.100.7 ${HOST_KEY}\n`);
    expect(await forgetHostKeys(deps, ["203.0.113.10"])).toBe(0);
    expect(await forgetHostKeys(deps, [undefined])).toBe(0);
  });

  it("returns 0 without a known_hosts file", async () => {
    const { deps } = await setup();
    expect(await forgetHostKeys(deps, ["203.0.113.10"])).toBe(0);
  });
});

describe("remainingAfterDeletion", () => {
  it("lists the snapshot and the backups the provider keeps, per provider", () => {
    expect(
      remainingAfterDeletion({
        provider: "hetzner",
        app: "shop",
        snapshotId: "9001",
        backups: true,
      }),
    ).toEqual([
      "The snapshot of shop (Hetzner image 9001). Hetzner bills snapshots per GB per month and OpsCrew never deletes them; delete it in the Hetzner Cloud Console when you no longer need it.",
    ]);
    const droplet = remainingAfterDeletion({
      provider: "digitalocean",
      app: "shop",
      backups: true,
    });
    expect(droplet).toEqual([
      "The Droplet's automatic backups. DigitalOcean keeps them until they expire, four weeks after they were taken; you can delete them earlier in the DigitalOcean control panel.",
    ]);
    expect(remainingAfterDeletion({ provider: "hetzner", app: "shop", backups: false })).toEqual(
      [],
    );
  });
});

describe("infraDeclaresVariable", () => {
  it("finds a variable declared in any .tf file of the root module", async () => {
    const { session } = await setup();
    await mkdir(session.dir, { recursive: true });
    await writeFile(join(session.dir, "notes.md"), 'variable "previous_delete_protection"\n');
    expect(await infraDeclaresVariable(session.dir, "previous_delete_protection")).toBe(false);
    await writeFile(
      join(session.dir, "variables.tf"),
      'variable "previous_delete_protection" {\n  type = bool\n}\n',
    );
    expect(await infraDeclaresVariable(session.dir, "previous_delete_protection")).toBe(true);
    expect(await infraDeclaresVariable(session.dir, "delete_protection")).toBe(false);
    expect(await infraDeclaresVariable(join(session.dir, "missing"), "x")).toBe(false);
  });
});
