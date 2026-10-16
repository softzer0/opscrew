import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ApprovalDecision,
  ApprovalHandler,
  ApprovalRecord,
  ApprovalRequest,
  ApprovalStore,
  Clock,
} from "@opscrew/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApprovalGate, isPlanHash, JsonlApprovalStore, MemoryApprovalStore } from "./approvals";
import { MemoryAuditLog } from "./audit";
import { OpsCrewError } from "./errors";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C_UPPER = `C${"c".repeat(63)}`.toUpperCase();
const clock: Clock = { now: () => new Date("2026-10-11T12:00:00.000Z") };

function record(overrides: Partial<ApprovalRecord> = {}): ApprovalRecord {
  return {
    id: "id-1",
    kind: "iac-apply",
    title: "Create 4 resources on Hetzner Cloud",
    planHash: HASH_A,
    approved: true,
    approver: "Test User",
    decidedAt: "2026-10-11T12:00:00.000Z",
    ...overrides,
  };
}

/** Handler that returns scripted decisions and remembers what it was asked. */
class ScriptedHandler implements ApprovalHandler {
  readonly requests: ApprovalRequest[] = [];
  constructor(private readonly decision: Partial<ApprovalDecision>) {}
  async request(request: ApprovalRequest): Promise<ApprovalDecision> {
    this.requests.push(request);
    return {
      approved: true,
      approver: "Test User",
      decidedAt: "2026-10-11T12:00:00.000Z",
      ...this.decision,
    };
  }
}

function makeGate(decision: Partial<ApprovalDecision> = {}) {
  const handler = new ScriptedHandler(decision);
  const store = new MemoryApprovalStore();
  const audit = new MemoryAuditLog({ clock });
  let n = 0;
  const gate = new ApprovalGate({ handler, store, audit, clock, newId: () => `id-${++n}` });
  return { gate, handler, store, audit };
}

/** A gate over `store`, to check what a store's records authorise. */
function gateOver(store: ApprovalStore): ApprovalGate {
  return new ApprovalGate({
    handler: new ScriptedHandler({}),
    store,
    audit: new MemoryAuditLog({ clock }),
    clock,
  });
}

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "opscrew-approvals-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("isPlanHash", () => {
  it("accepts 64 hex characters in either case", () => {
    expect(isPlanHash(HASH_A)).toBe(true);
    expect(isPlanHash(HASH_C_UPPER)).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isPlanHash("a".repeat(63))).toBe(false);
    expect(isPlanHash("a".repeat(65))).toBe(false);
    expect(isPlanHash(`${"a".repeat(63)}g`)).toBe(false);
    expect(isPlanHash(` ${HASH_A}`)).toBe(false);
    expect(isPlanHash(undefined)).toBe(false);
    expect(isPlanHash(42)).toBe(false);
  });
});

describe.each([
  ["MemoryApprovalStore", () => new MemoryApprovalStore()],
  ["JsonlApprovalStore", () => new JsonlApprovalStore(join(root, ".opscrew", "approvals.jsonl"))],
])("%s", (_name, makeStore) => {
  it("lists records in append order", async () => {
    const store = makeStore();
    expect(await store.list()).toEqual([]);
    await store.append(record({ id: "1" }));
    await store.append(record({ id: "2", kind: "git-push", planHash: undefined }));
    expect((await store.list()).map((r) => r.id)).toEqual(["1", "2"]);
  });

  it("finds the latest approved iac-apply record, matching the hash case-insensitively", async () => {
    const store = makeStore();
    await store.append(record({ id: "1", planHash: HASH_A }));
    await store.append(record({ id: "2", planHash: HASH_A.toUpperCase() }));
    await store.append(record({ id: "3", planHash: HASH_A, approved: false }));
    await store.append(record({ id: "4", planHash: HASH_A, kind: "tool-call" }));
    await store.append(record({ id: "5", planHash: HASH_B }));
    const gate = gateOver(store);
    expect((await gate.assertApprovedPlan(HASH_A.toUpperCase())).id).toBe("2");
    expect((await gate.assertApprovedPlan(HASH_B)).id).toBe("5");
    await expect(gate.assertApprovedPlan("d".repeat(64))).rejects.toMatchObject({
      code: "PLAN_NOT_APPROVED",
    });
  });
});

describe("JsonlApprovalStore", () => {
  it("creates parent directories and writes one record per line", async () => {
    const file = join(root, "deep", ".opscrew", "approvals.jsonl");
    const store = new JsonlApprovalStore(file);
    await store.append(record());
    const lines = (await readFile(file, "utf8")).split("\n").filter(Boolean);
    expect(lines.map((line) => JSON.parse(line))).toEqual([record()]);
  });

  it("reads back domain purchase and settings approvals", async () => {
    const store = new JsonlApprovalStore(join(root, "domains", "approvals.jsonl"));
    await store.append(record({ id: "p", kind: "domain-purchase", title: "Buy shopapp.com" }));
    await store.append(record({ id: "s", kind: "domain-settings", title: "Auto-renew off" }));
    expect((await store.list()).map((r) => r.kind)).toEqual(["domain-purchase", "domain-settings"]);
  });

  it("treats a missing or empty file as no approvals", async () => {
    const file = join(root, "approvals.jsonl");
    const store = new JsonlApprovalStore(file);
    expect(await store.list()).toEqual([]);
    await writeFile(file, "", "utf8");
    expect(await store.list()).toEqual([]);
  });

  it("skips corrupt and malformed lines", async () => {
    const file = join(root, "approvals.jsonl");
    const good = JSON.stringify(record({ id: "good" }));
    const wrongShape = JSON.stringify({ id: "x", kind: "launch-missiles" });
    await writeFile(file, `${good}\n{broken\n${wrongShape}\n${good.slice(0, 20)}`, "utf8");
    const store = new JsonlApprovalStore(file);
    expect((await store.list()).map((r) => r.id)).toEqual(["good"]);
    expect(await gateOver(store).assertApprovedPlan(HASH_A)).toMatchObject({ id: "good" });
  });

  it("never interleaves 100 concurrent appends", async () => {
    const file = join(root, "approvals.jsonl");
    const store = new JsonlApprovalStore(file);
    await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        store.append(record({ id: `r${i}`, title: "t".repeat(10_000) })),
      ),
    );
    const records = await store.list();
    expect(records).toHaveLength(100);
    expect(new Set(records.map((r) => r.id)).size).toBe(100);
  });
});

describe("ApprovalGate.request", () => {
  const applyRequest: ApprovalRequest = {
    kind: "iac-apply",
    title: "Create 4 resources on Hetzner Cloud",
    details: "+ hcloud_server.app",
    planHash: HASH_C_UPPER,
  };

  it("records an approved decision in the store and the audit log, lower-casing the hash", async () => {
    const { gate, handler, store, audit } = makeGate();
    const result = await gate.request(applyRequest);
    expect(handler.requests).toEqual([applyRequest]);
    expect(result).toEqual({
      id: "id-1",
      kind: "iac-apply",
      title: applyRequest.title,
      planHash: HASH_C_UPPER.toLowerCase(),
      approved: true,
      approver: "Test User",
      decidedAt: "2026-10-11T12:00:00.000Z",
    });
    expect(await store.list()).toEqual([result]);
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]).toMatchObject({
      kind: "approval",
      action: "iac-apply",
      decision: "approved",
      target: HASH_C_UPPER.toLowerCase(),
    });
  });

  it("records a refusal from the handler", async () => {
    const { gate, store, audit } = makeGate({ approved: false, reason: "not today" });
    const result = await gate.request(applyRequest);
    expect(result.approved).toBe(false);
    expect(result.reason).toBe("not today");
    expect((await store.list())[0]?.approved).toBe(false);
    expect(audit.entries[0]?.decision).toBe("refused");
  });

  it("rejects an iac-apply request without a valid plan hash", async () => {
    const { gate, handler } = makeGate();
    for (const planHash of [undefined, "", "abc", `${"a".repeat(63)}z`]) {
      const promise = gate.request({ ...applyRequest, planHash });
      await expect(promise).rejects.toBeInstanceOf(OpsCrewError);
      await expect(gate.request({ ...applyRequest, planHash })).rejects.toMatchObject({
        code: "INVALID_INPUT",
      });
    }
    expect(handler.requests).toHaveLength(0);
  });

  it("rejects allowDestroy without a non-empty confirmation phrase", async () => {
    const { gate, handler } = makeGate();
    for (const confirmPhrase of [undefined, "", "   "]) {
      await expect(
        gate.request({ ...applyRequest, allowDestroy: true, confirmPhrase }),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    }
    expect(handler.requests).toHaveLength(0);
  });

  it("rejects a domain purchase or domain setting without a typed confirmation phrase", async () => {
    const { gate, handler } = makeGate();
    for (const kind of ["domain-purchase", "domain-settings"] as const) {
      for (const confirmPhrase of [undefined, "", "   "]) {
        await expect(
          gate.request({ kind, title: "Buy shopapp.com", details: "", confirmPhrase }),
        ).rejects.toMatchObject({ code: "INVALID_INPUT" });
      }
    }
    expect(handler.requests).toHaveLength(0);
    const typed = await gate.request({
      kind: "domain-purchase",
      title: "Buy shopapp.com",
      details: "",
      confirmPhrase: "shopapp.com",
    });
    expect(typed.approved).toBe(false);
    expect(handler.requests).toHaveLength(1);
  });

  // Spec US3 scenario 3: deletions require the exact typed phrase; anything else is a refusal.
  describe("destructive plans (US3 scenario 3)", () => {
    const destroyRequest: ApprovalRequest = {
      ...applyRequest,
      allowDestroy: true,
      confirmPhrase: "hcloud_server.app",
    };

    it("approves when the typed phrase matches exactly (surrounding whitespace ignored)", async () => {
      const { gate, audit } = makeGate({ confirmation: "  hcloud_server.app \n" });
      const result = await gate.request(destroyRequest);
      expect(result.approved).toBe(true);
      expect(result.allowDestroy).toBe(true);
      expect(audit.entries[0]?.decision).toBe("approved");
    });

    it.each([
      ["a different phrase", "hcloud_server.db"],
      ["a different case", "HCLOUD_SERVER.APP"],
      ["a partial phrase", "hcloud_server"],
      ["yes", "yes"],
      ["nothing", undefined],
    ])("refuses when the user types %s", async (_label, confirmation) => {
      const { gate, store, audit } = makeGate({ approved: true, confirmation });
      const result = await gate.request(destroyRequest);
      expect(result.approved).toBe(false);
      expect(result.reason).toBe("confirmation phrase did not match");
      expect((await store.list())[0]?.approved).toBe(false);
      expect(audit.entries[0]?.decision).toBe("refused");
    });

    it("never grants a destroy when the plan is approved without the flag", async () => {
      const { gate } = makeGate();
      await gate.request(applyRequest);
      await expect(
        gate.assertApprovedPlan(HASH_C_UPPER, { allowDestroy: true }),
      ).rejects.toMatchObject({ code: "DESTROY_NOT_APPROVED" });
    });

    it("grants a destroy after a confirmed destroy approval", async () => {
      const { gate } = makeGate({ confirmation: "hcloud_server.app" });
      await gate.request(destroyRequest);
      const approved = await gate.assertApprovedPlan(HASH_C_UPPER, { allowDestroy: true });
      expect(approved.allowDestroy).toBe(true);
    });
  });

  it("enforces a confirmation phrase on non-destructive requests too", async () => {
    const { gate } = makeGate({ confirmation: "nope" });
    const result = await gate.request({
      kind: "github-secrets",
      title: "Set 3 repository secrets",
      details: "",
      confirmPhrase: "owner/repo",
    });
    expect(result.approved).toBe(false);
  });

  it("passes non-apply requests through without a plan hash", async () => {
    const { gate } = makeGate();
    const result = await gate.request({ kind: "git-push", title: "Push branch", details: "" });
    expect(result).toMatchObject({ kind: "git-push", approved: true });
    expect(result.planHash).toBeUndefined();
  });
});

// Spec US3 scenario 2: an approval for hash A never authorises an apply of hash B.
describe("ApprovalGate.assertApprovedPlan (US3 scenario 2)", () => {
  it("refuses a different hash, audits the refusal and tells the user about --approve", async () => {
    const { gate, audit } = makeGate();
    await gate.request({ kind: "iac-apply", title: "Apply A", details: "", planHash: HASH_A });

    const error = await gate.assertApprovedPlan(HASH_B).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpsCrewError);
    expect(error).toMatchObject({ code: "PLAN_NOT_APPROVED" });
    expect((error as OpsCrewError).hint).toContain(`--approve ${HASH_B}`);

    const refusal = audit.entries.at(-1);
    expect(refusal).toMatchObject({
      kind: "approval",
      action: "iac-apply",
      target: HASH_B,
      decision: "refused",
    });
  });

  it("returns the approved record for the approved hash in any case", async () => {
    const { gate } = makeGate();
    await gate.request({ kind: "iac-apply", title: "Apply A", details: "", planHash: HASH_A });
    const approved = await gate.assertApprovedPlan(HASH_A.toUpperCase());
    expect(approved.planHash).toBe(HASH_A);
  });

  it("refuses a hash whose only decision was a refusal", async () => {
    const { gate } = makeGate({ approved: false });
    await gate.request({ kind: "iac-apply", title: "Apply A", details: "", planHash: HASH_A });
    await expect(gate.assertApprovedPlan(HASH_A)).rejects.toMatchObject({
      code: "PLAN_NOT_APPROVED",
    });
  });

  it("refuses an invalid hash", async () => {
    const { gate } = makeGate();
    await expect(gate.assertApprovedPlan("not-a-hash")).rejects.toMatchObject({
      code: "PLAN_NOT_APPROVED",
    });
  });

  it("refuses when the store holds an approval for another kind with the same hash", async () => {
    const { gate, store } = makeGate();
    await store.append(record({ kind: "tool-call", planHash: HASH_A }));
    await expect(gate.assertApprovedPlan(HASH_A)).rejects.toMatchObject({
      code: "PLAN_NOT_APPROVED",
    });
  });
});

// Feature 009: a host plan's approval is its own kind, bound to the host plan's SHA-256 hash.
describe("host-apply approvals", () => {
  const hostRequest: ApprovalRequest = {
    kind: "host-apply",
    title: "Prepare the server for acme-web",
    details: "change docker, sshd, ufw",
    planHash: HASH_C_UPPER,
  };

  it("records an approved host plan, lower-casing the hash", async () => {
    const { gate, store, audit } = makeGate();
    const result = await gate.request(hostRequest);
    expect(result).toMatchObject({
      kind: "host-apply",
      approved: true,
      planHash: HASH_C_UPPER.toLowerCase(),
    });
    expect(await store.list()).toHaveLength(1);
    expect(audit.entries[0]).toMatchObject({ action: "host-apply", decision: "approved" });
  });

  it("rejects a host-apply request without a valid plan hash", async () => {
    const { gate, handler } = makeGate();
    for (const planHash of [undefined, "", "abc", `${"a".repeat(63)}z`]) {
      await expect(gate.request({ ...hostRequest, planHash })).rejects.toMatchObject({
        code: "INVALID_INPUT",
      });
    }
    expect(handler.requests).toHaveLength(0);
  });

  it("reads host-apply records back from the JSONL store", async () => {
    const store = new JsonlApprovalStore(join(root, "host", "approvals.jsonl"));
    await store.append(record({ id: "h", kind: "host-apply" }));
    expect((await store.list()).map((r) => r.kind)).toEqual(["host-apply"]);
  });

  describe.each([
    ["MemoryApprovalStore", () => new MemoryApprovalStore()],
    ["JsonlApprovalStore", () => new JsonlApprovalStore(join(root, "approvals.jsonl"))],
  ])("assertApprovedHostPlan with %s", (_name, makeStore) => {
    it("returns the latest approved host-apply record, matching the hash in any case", async () => {
      const store = makeStore();
      await store.append(record({ id: "1", kind: "host-apply", planHash: HASH_A }));
      await store.append(record({ id: "2", kind: "host-apply", planHash: HASH_A }));
      await store.append(record({ id: "3", kind: "host-apply", planHash: HASH_B }));
      expect((await gateOver(store).assertApprovedHostPlan(HASH_A.toUpperCase())).id).toBe("2");
    });

    it("refuses another hash and tells the user about --approve", async () => {
      const store = makeStore();
      await store.append(record({ kind: "host-apply", planHash: HASH_A }));
      const error = await gateOver(store)
        .assertApprovedHostPlan(HASH_B)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(OpsCrewError);
      expect(error).toMatchObject({ code: "PLAN_NOT_APPROVED" });
      expect((error as OpsCrewError).message).toContain("host plan");
      expect((error as OpsCrewError).hint).toContain(`--approve ${HASH_B}`);
    });

    it("refuses a refused approval, an iac-apply approval and an invalid hash", async () => {
      const store = makeStore();
      await store.append(
        record({ id: "r", kind: "host-apply", planHash: HASH_A, approved: false }),
      );
      await store.append(record({ id: "i", kind: "iac-apply", planHash: HASH_B }));
      for (const hash of [HASH_A, HASH_B, "not-a-hash"]) {
        await expect(gateOver(store).assertApprovedHostPlan(hash)).rejects.toMatchObject({
          code: "PLAN_NOT_APPROVED",
        });
      }
    });
  });

  it("never lets a host-apply approval authorise an infrastructure apply", async () => {
    const { gate } = makeGate();
    await gate.request({ ...hostRequest, planHash: HASH_A });
    await expect(gate.assertApprovedPlan(HASH_A)).rejects.toMatchObject({
      code: "PLAN_NOT_APPROVED",
    });
  });

  it("ApprovalGate.assertApprovedHostPlan returns the record or audits the refusal", async () => {
    const { gate, audit } = makeGate();
    await gate.request({ ...hostRequest, planHash: HASH_A });
    expect((await gate.assertApprovedHostPlan(HASH_A.toUpperCase())).planHash).toBe(HASH_A);

    await gate.request({ kind: "iac-apply", title: "Apply B", details: "", planHash: HASH_B });
    await expect(gate.assertApprovedHostPlan(HASH_B)).rejects.toMatchObject({
      code: "PLAN_NOT_APPROVED",
    });
    expect(audit.entries.at(-1)).toMatchObject({
      kind: "approval",
      action: "host-apply",
      target: HASH_B,
      decision: "refused",
    });
  });

  it("deletes app data only after a confirmed destroy approval of the host plan", async () => {
    const { gate, audit } = makeGate({ confirmation: "shop" });
    await gate.request({ ...hostRequest, planHash: HASH_A });
    await expect(gate.assertApprovedHostPlan(HASH_A, { allowDestroy: true })).rejects.toMatchObject(
      { code: "DESTROY_NOT_APPROVED" },
    );
    expect(audit.entries.at(-1)).toMatchObject({ action: "host-apply", decision: "refused" });

    await gate.request({
      ...hostRequest,
      planHash: HASH_B,
      allowDestroy: true,
      confirmPhrase: "shop",
    });
    const approved = await gate.assertApprovedHostPlan(HASH_B, { allowDestroy: true });
    expect(approved.allowDestroy).toBe(true);
  });
});

// Feature 010: a Portainer stack plan's approval is its own kind, bound to the stack plan's hash.
describe("stack-apply approvals", () => {
  const stackRequest: ApprovalRequest = {
    kind: "stack-apply",
    title: "Create the stacks for acme-web in Portainer",
    details: "app-stack, updater-stack",
    planHash: HASH_C_UPPER,
  };

  it("records an approved stack plan, lower-casing the hash", async () => {
    const { gate, store, audit } = makeGate();
    const result = await gate.request(stackRequest);
    expect(result).toMatchObject({
      kind: "stack-apply",
      approved: true,
      planHash: HASH_C_UPPER.toLowerCase(),
    });
    expect(await store.list()).toHaveLength(1);
    expect(audit.entries[0]).toMatchObject({ action: "stack-apply", decision: "approved" });
  });

  it("rejects a stack-apply request without a valid plan hash", async () => {
    const { gate, handler } = makeGate();
    for (const planHash of [undefined, "", "abc", `${"a".repeat(63)}z`]) {
      const error = await gate.request({ ...stackRequest, planHash }).catch((e: unknown) => e);
      expect(error).toMatchObject({ code: "INVALID_INPUT" });
    }
    const missing = await gate
      .request({ ...stackRequest, planHash: undefined })
      .catch((e: unknown) => e);
    expect((missing as OpsCrewError).message).toContain("stack plan");
    expect(handler.requests).toHaveLength(0);
  });

  it("reads stack-apply records back from the JSONL store", async () => {
    const store = new JsonlApprovalStore(join(root, "stack", "approvals.jsonl"));
    await store.append(record({ id: "s", kind: "stack-apply" }));
    expect((await store.list()).map((r) => r.kind)).toEqual(["stack-apply"]);
  });

  describe.each([
    ["MemoryApprovalStore", () => new MemoryApprovalStore()],
    ["JsonlApprovalStore", () => new JsonlApprovalStore(join(root, "approvals.jsonl"))],
  ])("assertApprovedStackPlan with %s", (_name, makeStore) => {
    it("returns the latest approved stack-apply record, matching the hash in any case", async () => {
      const store = makeStore();
      await store.append(record({ id: "1", kind: "stack-apply", planHash: HASH_A }));
      await store.append(record({ id: "2", kind: "stack-apply", planHash: HASH_A }));
      await store.append(record({ id: "3", kind: "stack-apply", planHash: HASH_B }));
      expect((await gateOver(store).assertApprovedStackPlan(HASH_A.toUpperCase())).id).toBe("2");
    });

    it("refuses another hash and tells the user about --approve", async () => {
      const store = makeStore();
      await store.append(record({ kind: "stack-apply", planHash: HASH_A }));
      const error = await gateOver(store)
        .assertApprovedStackPlan(HASH_B)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(OpsCrewError);
      expect(error).toMatchObject({ code: "PLAN_NOT_APPROVED" });
      expect((error as OpsCrewError).message).toContain("stack plan");
      expect((error as OpsCrewError).hint).toContain(`--approve ${HASH_B}`);
    });

    it("refuses a refused approval, an iac-apply or host-apply approval and an invalid hash", async () => {
      const store = makeStore();
      await store.append(
        record({ id: "r", kind: "stack-apply", planHash: HASH_A, approved: false }),
      );
      await store.append(record({ id: "i", kind: "iac-apply", planHash: HASH_B }));
      await store.append(record({ id: "h", kind: "host-apply", planHash: HASH_C_UPPER }));
      for (const hash of [HASH_A, HASH_B, HASH_C_UPPER, "not-a-hash"]) {
        await expect(gateOver(store).assertApprovedStackPlan(hash)).rejects.toMatchObject({
          code: "PLAN_NOT_APPROVED",
        });
      }
    });

    it("refuses deleting data unless the approval allowed it", async () => {
      const store = makeStore();
      await store.append(record({ id: "k", kind: "stack-apply", planHash: HASH_A }));
      await store.append(
        record({ id: "d", kind: "stack-apply", planHash: HASH_B, allowDestroy: true }),
      );
      await expect(
        gateOver(store).assertApprovedStackPlan(HASH_A, { allowDestroy: true }),
      ).rejects.toMatchObject({ code: "DESTROY_NOT_APPROVED" });
      expect(
        (await gateOver(store).assertApprovedStackPlan(HASH_B, { allowDestroy: true })).id,
      ).toBe("d");
    });
  });

  it("never lets a stack-apply approval authorise an infrastructure apply or a host plan", async () => {
    const { gate } = makeGate();
    await gate.request({ ...stackRequest, planHash: HASH_A });
    await expect(gate.assertApprovedPlan(HASH_A)).rejects.toMatchObject({
      code: "PLAN_NOT_APPROVED",
    });
    await expect(gate.assertApprovedHostPlan(HASH_A)).rejects.toMatchObject({
      code: "PLAN_NOT_APPROVED",
    });
  });

  it("ApprovalGate.assertApprovedStackPlan returns the record or audits the refusal", async () => {
    const { gate, audit } = makeGate();
    await gate.request({ ...stackRequest, planHash: HASH_A });
    expect((await gate.assertApprovedStackPlan(HASH_A.toUpperCase())).planHash).toBe(HASH_A);

    await gate.request({ ...stackRequest, kind: "host-apply", planHash: HASH_B });
    await expect(gate.assertApprovedStackPlan(HASH_B)).rejects.toMatchObject({
      code: "PLAN_NOT_APPROVED",
    });
    expect(audit.entries.at(-1)).toMatchObject({
      kind: "approval",
      action: "stack-apply",
      target: HASH_B,
      decision: "refused",
    });
  });

  it("deletes app data only after a confirmed destroy approval of the stack plan", async () => {
    const { gate, audit } = makeGate({ confirmation: "shop" });
    await gate.request({ ...stackRequest, planHash: HASH_A });
    await expect(
      gate.assertApprovedStackPlan(HASH_A, { allowDestroy: true }),
    ).rejects.toMatchObject({ code: "DESTROY_NOT_APPROVED" });
    expect(audit.entries.at(-1)).toMatchObject({ action: "stack-apply", decision: "refused" });

    await gate.request({
      ...stackRequest,
      planHash: HASH_B,
      allowDestroy: true,
      confirmPhrase: "shop",
    });
    const approved = await gate.assertApprovedStackPlan(HASH_B, { allowDestroy: true });
    expect(approved.allowDestroy).toBe(true);
  });
});
