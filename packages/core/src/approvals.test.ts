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
import {
  ApprovalGate,
  approvalDecision,
  CANCELLED_BY_USER,
  DECLINED_BY_USER,
  isPlanHash,
  JsonlApprovalStore,
  MemoryApprovalStore,
  PHRASE_MISMATCH,
} from "./approvals";
import { MemoryAuditLog } from "./audit";
import { OpsCrewError } from "./errors";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C_UPPER = `C${"c".repeat(63)}`.toUpperCase();
const HASH_D = "d".repeat(64);
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

describe("approvalDecision", () => {
  it("is a decision made now, with the typed confirmation or the reason when given", () => {
    expect(approvalDecision(clock, "Test User", true)).toEqual({
      approved: true,
      approver: "Test User",
      decidedAt: "2026-10-11T12:00:00.000Z",
    });
    expect(
      approvalDecision(clock, "Test User", false, {
        confirmation: "shop",
        reason: PHRASE_MISMATCH,
      }),
    ).toEqual({
      approved: false,
      approver: "Test User",
      decidedAt: "2026-10-11T12:00:00.000Z",
      confirmation: "shop",
      reason: "confirmation phrase did not match",
    });
  });

  it("has one wording for each refusal reason", () => {
    expect(CANCELLED_BY_USER).toBe("cancelled by the user");
    expect(DECLINED_BY_USER).toBe("declined by the user");
  });
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

// Feature 011: a shared Cloudflare plan's approval is its own kind, bound to that plan's hash.
describe("cloudflare-apply approvals", () => {
  const cloudflareRequest: ApprovalRequest = {
    kind: "cloudflare-apply",
    title: "Add shop.example.com to OpsCrew's rules in example.com",
    details: "opscrew-block-probes, opscrew-strict-tls",
    planHash: HASH_C_UPPER,
  };

  it("records an approved Cloudflare plan, lower-casing the hash", async () => {
    const { gate, store, audit } = makeGate();
    const result = await gate.request(cloudflareRequest);
    expect(result).toMatchObject({
      kind: "cloudflare-apply",
      approved: true,
      planHash: HASH_C_UPPER.toLowerCase(),
    });
    expect(await store.list()).toHaveLength(1);
    expect(audit.entries[0]).toMatchObject({ action: "cloudflare-apply", decision: "approved" });
  });

  it("rejects a cloudflare-apply request without a valid plan hash", async () => {
    const { gate, handler } = makeGate();
    for (const planHash of [undefined, "", "abc", `${"a".repeat(63)}z`]) {
      const error = await gate.request({ ...cloudflareRequest, planHash }).catch((e: unknown) => e);
      expect(error).toMatchObject({ code: "INVALID_INPUT" });
    }
    const missing = await gate
      .request({ ...cloudflareRequest, planHash: undefined })
      .catch((e: unknown) => e);
    expect((missing as OpsCrewError).message).toContain("Cloudflare plan");
    expect((missing as OpsCrewError).hint).toContain("64 hexadecimal characters");
    expect(handler.requests).toHaveLength(0);
  });

  it("reads cloudflare-apply records back from the JSONL store", async () => {
    const store = new JsonlApprovalStore(join(root, "cloudflare", "approvals.jsonl"));
    await store.append(record({ id: "c", kind: "cloudflare-apply" }));
    expect((await store.list()).map((r) => r.kind)).toEqual(["cloudflare-apply"]);
  });

  describe.each([
    ["MemoryApprovalStore", () => new MemoryApprovalStore()],
    ["JsonlApprovalStore", () => new JsonlApprovalStore(join(root, "approvals.jsonl"))],
  ])("assertApprovedCloudflarePlan with %s", (_name, makeStore) => {
    it("returns the latest approved cloudflare-apply record, matching the hash in any case", async () => {
      const store = makeStore();
      await store.append(record({ id: "1", kind: "cloudflare-apply", planHash: HASH_A }));
      await store.append(record({ id: "2", kind: "cloudflare-apply", planHash: HASH_A }));
      await store.append(record({ id: "3", kind: "cloudflare-apply", planHash: HASH_B }));
      expect((await gateOver(store).assertApprovedCloudflarePlan(HASH_A.toUpperCase())).id).toBe(
        "2",
      );
    });

    it("refuses another hash and tells the user about --approve", async () => {
      const store = makeStore();
      await store.append(record({ kind: "cloudflare-apply", planHash: HASH_A }));
      const error = await gateOver(store)
        .assertApprovedCloudflarePlan(HASH_B)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(OpsCrewError);
      expect(error).toMatchObject({ code: "PLAN_NOT_APPROVED" });
      expect((error as OpsCrewError).message).toContain("Cloudflare plan");
      expect((error as OpsCrewError).hint).toContain(`--approve ${HASH_B}`);
    });

    it("refuses a refused approval, another kind's approval and an invalid hash", async () => {
      const store = makeStore();
      await store.append(
        record({ id: "r", kind: "cloudflare-apply", planHash: HASH_A, approved: false }),
      );
      await store.append(record({ id: "i", kind: "iac-apply", planHash: HASH_B }));
      await store.append(record({ id: "h", kind: "host-apply", planHash: HASH_C_UPPER }));
      await store.append(record({ id: "s", kind: "stack-apply", planHash: HASH_D }));
      for (const hash of [HASH_A, HASH_B, HASH_C_UPPER, HASH_D, "not-a-hash"]) {
        await expect(gateOver(store).assertApprovedCloudflarePlan(hash)).rejects.toMatchObject({
          code: "PLAN_NOT_APPROVED",
        });
      }
    });

    it("refuses removing OpsCrew's rules unless the approval allowed it", async () => {
      const store = makeStore();
      await store.append(record({ id: "k", kind: "cloudflare-apply", planHash: HASH_A }));
      await store.append(
        record({ id: "d", kind: "cloudflare-apply", planHash: HASH_B, allowDestroy: true }),
      );
      const error = await gateOver(store)
        .assertApprovedCloudflarePlan(HASH_A, { allowDestroy: true })
        .catch((e: unknown) => e);
      expect(error).toMatchObject({ code: "DESTROY_NOT_APPROVED" });
      expect((error as OpsCrewError).message).toContain("Cloudflare plan");
      expect(
        (await gateOver(store).assertApprovedCloudflarePlan(HASH_B, { allowDestroy: true })).id,
      ).toBe("d");
    });
  });

  it("never lets a cloudflare-apply approval authorise another kind's plan", async () => {
    const { gate } = makeGate();
    await gate.request({ ...cloudflareRequest, planHash: HASH_A });
    await expect(gate.assertApprovedPlan(HASH_A)).rejects.toMatchObject({
      code: "PLAN_NOT_APPROVED",
    });
    await expect(gate.assertApprovedHostPlan(HASH_A)).rejects.toMatchObject({
      code: "PLAN_NOT_APPROVED",
    });
    await expect(gate.assertApprovedStackPlan(HASH_A)).rejects.toMatchObject({
      code: "PLAN_NOT_APPROVED",
    });
  });

  it("ApprovalGate.assertApprovedCloudflarePlan returns the record or audits the refusal", async () => {
    const { gate, audit } = makeGate();
    await gate.request({ ...cloudflareRequest, planHash: HASH_A });
    expect((await gate.assertApprovedCloudflarePlan(HASH_A.toUpperCase())).planHash).toBe(HASH_A);

    await gate.request({ ...cloudflareRequest, kind: "stack-apply", planHash: HASH_B });
    await expect(gate.assertApprovedCloudflarePlan(HASH_B)).rejects.toMatchObject({
      code: "PLAN_NOT_APPROVED",
    });
    expect(audit.entries.at(-1)).toMatchObject({
      kind: "approval",
      action: "cloudflare-apply",
      target: HASH_B,
      decision: "refused",
    });
  });

  it("removes OpsCrew's rules only after a confirmed destroy approval of the Cloudflare plan", async () => {
    const { gate, audit } = makeGate({ confirmation: "shop" });
    await gate.request({ ...cloudflareRequest, planHash: HASH_A });
    await expect(
      gate.assertApprovedCloudflarePlan(HASH_A, { allowDestroy: true }),
    ).rejects.toMatchObject({ code: "DESTROY_NOT_APPROVED" });
    expect(audit.entries.at(-1)).toMatchObject({
      action: "cloudflare-apply",
      decision: "refused",
    });

    await gate.request({
      ...cloudflareRequest,
      planHash: HASH_B,
      allowDestroy: true,
      confirmPhrase: "shop",
    });
    const approved = await gate.assertApprovedCloudflarePlan(HASH_B, { allowDestroy: true });
    expect(approved.allowDestroy).toBe(true);
  });
});

// Feature 015: a promotion's approval is its own kind, bound to the promotion's hash (the target
// plan's hash, the image digest and both environments).
describe("promote approvals", () => {
  const promoteRequest: ApprovalRequest = {
    kind: "promote",
    title: "Promote sha256:… from staging to prod",
    details: "image ghcr.io/acme/web@sha256:…",
    planHash: HASH_C_UPPER,
  };

  it("records an approved promotion, lower-casing the hash", async () => {
    const { gate, store, audit } = makeGate();
    const result = await gate.request(promoteRequest);
    expect(result).toMatchObject({
      kind: "promote",
      approved: true,
      planHash: HASH_C_UPPER.toLowerCase(),
    });
    expect(await store.list()).toHaveLength(1);
    expect(audit.entries[0]).toMatchObject({ action: "promote", decision: "approved" });
  });

  it("rejects a promote request without a valid hash, in plain words", async () => {
    const { gate, handler } = makeGate();
    for (const planHash of [undefined, "", "abc", `${"a".repeat(63)}z`]) {
      const error = await gate.request({ ...promoteRequest, planHash }).catch((e: unknown) => e);
      expect(error).toMatchObject({ code: "INVALID_INPUT" });
    }
    const missing = await gate
      .request({ ...promoteRequest, planHash: undefined })
      .catch((e: unknown) => e);
    expect(missing).toMatchObject({
      message:
        "A promotion can only be approved for a specific image and target plan, but no valid promotion hash was given.",
      hint: "Pass the promotion's SHA-256 hash (64 hexadecimal characters) with the request.",
    });
    expect(handler.requests).toHaveLength(0);
  });

  it("reads promote and github-settings records back from the JSONL store", async () => {
    const store = new JsonlApprovalStore(join(root, "environments", "approvals.jsonl"));
    await store.append(record({ id: "p", kind: "promote" }));
    const { planHash: _planHash, ...settings } = record({ id: "g", kind: "github-settings" });
    await store.append(settings);
    expect((await store.list()).map((r) => r.kind)).toEqual(["promote", "github-settings"]);
  });

  describe.each([
    ["MemoryApprovalStore", () => new MemoryApprovalStore()],
    ["JsonlApprovalStore", () => new JsonlApprovalStore(join(root, "approvals.jsonl"))],
  ])("assertApprovedPromotion with %s", (_name, makeStore) => {
    it("returns the latest approved promote record, matching the hash in any case", async () => {
      const store = makeStore();
      await store.append(record({ id: "1", kind: "promote", planHash: HASH_A }));
      await store.append(record({ id: "2", kind: "promote", planHash: HASH_A }));
      await store.append(record({ id: "3", kind: "promote", planHash: HASH_B }));
      expect((await gateOver(store).assertApprovedPromotion(HASH_A.toUpperCase())).id).toBe("2");
    });

    it("refuses another hash in plain words and tells the user about --approve", async () => {
      const store = makeStore();
      await store.append(record({ kind: "promote", planHash: HASH_A }));
      const error = await gateOver(store)
        .assertApprovedPromotion(HASH_B)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(OpsCrewError);
      expect(error).toMatchObject({
        code: "PLAN_NOT_APPROVED",
        message: "This promotion has not been approved, so OpsCrew will not deploy the image.",
        hint: `Review the image and the target environment's plan, then approve the promotion when asked or re-run with --approve ${HASH_B}.`,
      });
    });

    it("refuses a refused approval, every other kind's approval and an invalid hash", async () => {
      const store = makeStore();
      await store.append(record({ id: "r", kind: "promote", planHash: HASH_A, approved: false }));
      await store.append(record({ id: "i", kind: "iac-apply", planHash: HASH_B }));
      await store.append(record({ id: "h", kind: "host-apply", planHash: HASH_C_UPPER }));
      await store.append(record({ id: "s", kind: "stack-apply", planHash: HASH_D }));
      const HASH_E = "e".repeat(64);
      await store.append(record({ id: "c", kind: "cloudflare-apply", planHash: HASH_E }));
      for (const hash of [HASH_A, HASH_B, HASH_C_UPPER, HASH_D, HASH_E, "not-a-hash"]) {
        await expect(gateOver(store).assertApprovedPromotion(hash)).rejects.toMatchObject({
          code: "PLAN_NOT_APPROVED",
        });
      }
    });
  });

  it("never lets a promote approval authorise any plan's apply", async () => {
    const { gate } = makeGate();
    await gate.request({ ...promoteRequest, planHash: HASH_A });
    await expect(gate.assertApprovedPlan(HASH_A)).rejects.toMatchObject({
      code: "PLAN_NOT_APPROVED",
    });
    await expect(gate.assertApprovedHostPlan(HASH_A)).rejects.toMatchObject({
      code: "PLAN_NOT_APPROVED",
    });
    await expect(gate.assertApprovedStackPlan(HASH_A)).rejects.toMatchObject({
      code: "PLAN_NOT_APPROVED",
    });
    await expect(gate.assertApprovedCloudflarePlan(HASH_A)).rejects.toMatchObject({
      code: "PLAN_NOT_APPROVED",
    });
  });

  it("audits a refused promotion", async () => {
    const { gate, audit } = makeGate();
    await expect(gate.assertApprovedPromotion(HASH_B)).rejects.toMatchObject({
      code: "PLAN_NOT_APPROVED",
    });
    expect(audit.entries.at(-1)).toMatchObject({
      kind: "approval",
      action: "promote",
      target: HASH_B,
      decision: "refused",
      detail: "no approval recorded for this promotion",
    });
  });
});

// Feature 015: GitHub repository settings (an environment, its rules, the fork-PR policy) are
// approved like GitHub secrets, without a plan hash.
describe("github-settings approvals", () => {
  it("passes through without a plan hash, like github-secrets", async () => {
    const { gate, audit } = makeGate();
    const result = await gate.request({
      kind: "github-settings",
      title: "Create the GitHub environment staging",
      details: "",
    });
    expect(result).toMatchObject({ kind: "github-settings", approved: true });
    expect(result.planHash).toBeUndefined();
    expect(audit.entries[0]).toMatchObject({ action: "github-settings", decision: "approved" });
  });
});

// Feature 016: a GitHub Pages plan's approval is its own kind, bound to that plan's hash.
describe("pages-apply approvals", () => {
  const pagesRequest: ApprovalRequest = {
    kind: "pages-apply",
    title: "Turn on GitHub Pages for example-app with the custom domain docs.example.com",
    details: "create the site (workflow), set the custom domain docs.example.com",
    planHash: HASH_C_UPPER,
  };

  it("records an approved Pages plan, lower-casing the hash", async () => {
    const { gate, store, audit } = makeGate();
    const result = await gate.request(pagesRequest);
    expect(result).toMatchObject({
      kind: "pages-apply",
      approved: true,
      planHash: HASH_C_UPPER.toLowerCase(),
    });
    expect(await store.list()).toHaveLength(1);
    expect(audit.entries[0]).toMatchObject({ action: "pages-apply", decision: "approved" });
  });

  it("rejects a pages-apply request without a valid plan hash, in plain words", async () => {
    const { gate, handler } = makeGate();
    for (const planHash of [undefined, "", "abc", `${"a".repeat(63)}z`]) {
      const error = await gate.request({ ...pagesRequest, planHash }).catch((e: unknown) => e);
      expect(error).toMatchObject({ code: "INVALID_INPUT" });
    }
    const missing = await gate
      .request({ ...pagesRequest, planHash: undefined })
      .catch((e: unknown) => e);
    expect(missing).toMatchObject({
      message:
        "A change to a GitHub Pages site can only be approved for a specific Pages plan, but no valid plan hash was given.",
      hint: "Pass the Pages plan's SHA-256 hash (64 hexadecimal characters) with the request.",
    });
    expect(handler.requests).toHaveLength(0);
  });

  it("asks for the typed name before a Pages plan that deletes anything", async () => {
    const { gate, handler } = makeGate();
    const error = await gate
      .request({ ...pagesRequest, allowDestroy: true })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "INVALID_INPUT" });
    expect(handler.requests).toHaveLength(0);
  });

  it("reads pages-apply records back from the JSONL store", async () => {
    const store = new JsonlApprovalStore(join(root, "pages", "approvals.jsonl"));
    await store.append(record({ id: "p", kind: "pages-apply" }));
    expect((await store.list()).map((r) => r.kind)).toEqual(["pages-apply"]);
  });

  describe.each([
    ["MemoryApprovalStore", () => new MemoryApprovalStore()],
    ["JsonlApprovalStore", () => new JsonlApprovalStore(join(root, "approvals.jsonl"))],
  ])("assertApprovedPagesPlan with %s", (_name, makeStore) => {
    it("returns the latest approved pages-apply record, matching the hash in any case", async () => {
      const store = makeStore();
      await store.append(record({ id: "1", kind: "pages-apply", planHash: HASH_A }));
      await store.append(record({ id: "2", kind: "pages-apply", planHash: HASH_A }));
      await store.append(record({ id: "3", kind: "pages-apply", planHash: HASH_B }));
      expect((await gateOver(store).assertApprovedPagesPlan(HASH_A.toUpperCase())).id).toBe("2");
    });

    it("refuses another hash in plain words and tells the user about --approve", async () => {
      const store = makeStore();
      await store.append(record({ kind: "pages-apply", planHash: HASH_A }));
      const error = await gateOver(store)
        .assertApprovedPagesPlan(HASH_B)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(OpsCrewError);
      expect(error).toMatchObject({
        code: "PLAN_NOT_APPROVED",
        message:
          "This Pages plan has not been approved, so OpsCrew will not change the GitHub Pages site.",
        hint: `Review the Pages plan, then approve it when asked or re-run with --approve ${HASH_B}.`,
      });
    });

    it("refuses a refused approval, every other kind's approval and an invalid hash", async () => {
      const store = makeStore();
      const HASH_E = "e".repeat(64);
      const HASH_F = "f".repeat(64);
      await store.append(
        record({ id: "r", kind: "pages-apply", planHash: HASH_A, approved: false }),
      );
      await store.append(record({ id: "i", kind: "iac-apply", planHash: HASH_B }));
      await store.append(record({ id: "h", kind: "host-apply", planHash: HASH_C_UPPER }));
      await store.append(record({ id: "s", kind: "stack-apply", planHash: HASH_D }));
      await store.append(record({ id: "c", kind: "cloudflare-apply", planHash: HASH_E }));
      await store.append(record({ id: "p", kind: "promote", planHash: HASH_F }));
      for (const hash of [HASH_A, HASH_B, HASH_C_UPPER, HASH_D, HASH_E, HASH_F, "not-a-hash"]) {
        await expect(gateOver(store).assertApprovedPagesPlan(hash)).rejects.toMatchObject({
          code: "PLAN_NOT_APPROVED",
        });
      }
    });

    it("refuses deleting unless the approval allowed it, in plain words", async () => {
      const store = makeStore();
      await store.append(record({ id: "k", kind: "pages-apply", planHash: HASH_A }));
      await store.append(
        record({ id: "d", kind: "pages-apply", planHash: HASH_B, allowDestroy: true }),
      );
      const error = await gateOver(store)
        .assertApprovedPagesPlan(HASH_A, { allowDestroy: true })
        .catch((e: unknown) => e);
      expect(error).toMatchObject({
        code: "DESTROY_NOT_APPROVED",
        message:
          "This Pages plan removes the site's custom domain or deletes the GitHub Pages site, but the approval did not allow deleting them.",
        hint: "Run the command interactively and type the confirmation phrase to approve deleting them.",
      });
      expect(
        (await gateOver(store).assertApprovedPagesPlan(HASH_B, { allowDestroy: true })).id,
      ).toBe("d");
    });
  });

  it("never lets a pages-apply approval authorise another kind, nor another kind a Pages plan", async () => {
    const { gate } = makeGate();
    await gate.request({ ...pagesRequest, planHash: HASH_A });
    for (const assert of [
      () => gate.assertApprovedPlan(HASH_A),
      () => gate.assertApprovedHostPlan(HASH_A),
      () => gate.assertApprovedStackPlan(HASH_A),
      () => gate.assertApprovedCloudflarePlan(HASH_A),
      () => gate.assertApprovedPromotion(HASH_A),
    ]) {
      await expect(assert()).rejects.toMatchObject({ code: "PLAN_NOT_APPROVED" });
    }
    await gate.request({ ...pagesRequest, kind: "cloudflare-apply", planHash: HASH_B });
    await expect(gate.assertApprovedPagesPlan(HASH_B)).rejects.toMatchObject({
      code: "PLAN_NOT_APPROVED",
    });
  });

  it("audits each refusal with what was not approved", async () => {
    const { gate, audit } = makeGate({ confirmation: "example-app" });
    await expect(gate.assertApprovedPagesPlan(HASH_B)).rejects.toMatchObject({
      code: "PLAN_NOT_APPROVED",
    });
    expect(audit.entries.at(-1)).toMatchObject({
      kind: "approval",
      action: "pages-apply",
      target: HASH_B,
      decision: "refused",
      detail: "no approval recorded for this Pages plan",
    });
    await gate.request({ ...pagesRequest, planHash: HASH_A });
    await expect(
      gate.assertApprovedPagesPlan(HASH_A, { allowDestroy: true }),
    ).rejects.toMatchObject({ code: "DESTROY_NOT_APPROVED" });
    expect(audit.entries.at(-1)).toMatchObject({
      action: "pages-apply",
      decision: "refused",
      detail: "Pages plan removes the custom domain or the site; deleting them was not approved",
    });
    await gate.request({
      ...pagesRequest,
      planHash: HASH_D,
      allowDestroy: true,
      confirmPhrase: "example-app",
    });
    const approved = await gate.assertApprovedPagesPlan(HASH_D, { allowDestroy: true });
    expect(approved.allowDestroy).toBe(true);
  });
});
