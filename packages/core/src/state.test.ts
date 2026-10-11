import { mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Clock } from "@opscrew/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CostLedger, ProjectStateStore, renameWithRetry, writeFileAtomic } from "./state";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "opscrew-state-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A clock that advances one minute per call. */
function tickingClock(start = "2026-10-11T12:00:00.000Z"): Clock {
  let t = new Date(start).getTime();
  return {
    now: () => {
      const d = new Date(t);
      t += 60_000;
      return d;
    },
  };
}

describe("ProjectStateStore", () => {
  it("reads a missing file as an empty state", async () => {
    const store = new ProjectStateStore(join(root, ".opscrew", "state.json"));
    expect(await store.read()).toEqual({ schemaVersion: 1, phases: {} });
  });

  it("records phases and persists them", async () => {
    const file = join(root, ".opscrew", "state.json");
    const store = new ProjectStateStore(file, tickingClock());
    await store.markPhase("scan", "ok", "3 findings");
    const state = await store.markPhase("analyze", "failed");

    expect(state).toEqual({
      schemaVersion: 1,
      phases: {
        scan: { status: "ok", at: "2026-10-11T12:00:00.000Z", summary: "3 findings" },
        analyze: { status: "failed", at: "2026-10-11T12:01:00.000Z" },
      },
      updatedAt: "2026-10-11T12:01:00.000Z",
    });
    expect(await new ProjectStateStore(file).read()).toEqual(state);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(state);
  });

  it("overwrites an earlier result for the same phase", async () => {
    const store = new ProjectStateStore(join(root, "state.json"), tickingClock());
    await store.markPhase("scan", "failed", "boom");
    const state = await store.markPhase("scan", "skipped");
    expect(state.phases.scan).toEqual({ status: "skipped", at: "2026-10-11T12:01:00.000Z" });
  });

  it("writes atomically and leaves no temp files behind", async () => {
    const dir = join(root, ".opscrew");
    const store = new ProjectStateStore(join(dir, "state.json"), tickingClock());
    await Promise.all([
      store.markPhase("scan", "ok"),
      store.markPhase("analyze", "ok"),
      store.markPhase("design", "ok"),
    ]);
    expect(await readdir(dir)).toEqual(["state.json"]);
    expect(Object.keys((await store.read()).phases).sort()).toEqual(["analyze", "design", "scan"]);
  });

  it("accepts a BOM and rejects a corrupt file with a user-facing error", async () => {
    const file = join(root, "state.json");
    await writeFile(file, `${String.fromCharCode(0xfeff)}{"schemaVersion":1,"phases":{}}`, "utf8");
    expect(await new ProjectStateStore(file).read()).toEqual({ schemaVersion: 1, phases: {} });

    await writeFile(file, "{not json", "utf8");
    await expect(new ProjectStateStore(file).read()).rejects.toMatchObject({
      code: "ARTIFACT_INVALID",
    });

    await writeFile(file, JSON.stringify({ schemaVersion: 2, phases: {} }), "utf8");
    await expect(new ProjectStateStore(file).read()).rejects.toMatchObject({
      code: "ARTIFACT_INVALID",
    });
  });

  it("keeps writing while another store reads the file in a loop", async () => {
    const file = join(root, ".opscrew", "state.json");
    const writer = new ProjectStateStore(file, tickingClock());
    const reader = new ProjectStateStore(file);
    await writer.markPhase("scan", "ok");
    let done = false;
    const readLoop = (async () => {
      let reads = 0;
      while (!done) {
        await reader.read();
        reads++;
      }
      return reads;
    })();
    try {
      for (let i = 0; i < 40; i++) await writer.markPhase(i % 2 ? "scan" : "analyze", "ok");
    } finally {
      done = true;
    }
    expect(await readLoop).toBeGreaterThan(0);
    expect(await readdir(join(root, ".opscrew"))).toEqual(["state.json"]);
  });

  it("serialises reads with writes on the same store", async () => {
    const store = new ProjectStateStore(join(root, "state.json"), tickingClock());
    const results = await Promise.all([
      store.markPhase("scan", "ok"),
      store.read(),
      store.markPhase("analyze", "ok"),
      store.read(),
    ]);
    expect(Object.keys(results[1].phases)).toEqual(["scan"]);
    expect(Object.keys(results[3].phases).sort()).toEqual(["analyze", "scan"]);
  });
});

/** An `EPERM` error like the one Windows raises when the rename target is open elsewhere. */
function eperm(): NodeJS.ErrnoException {
  return Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });
}

describe("writeFileAtomic / renameWithRetry", () => {
  it("retries a rename that fails once with EPERM and still writes the file", async () => {
    const file = join(root, "out", "state.json");
    let calls = 0;
    const flakyRename = async (from: string, to: string) => {
      calls++;
      if (calls === 1) throw eperm();
      await rename(from, to);
    };
    await writeFileAtomic(file, "hello\n", { rename: flakyRename, delayMs: () => 0 });
    expect(calls).toBe(2);
    expect(await readFile(file, "utf8")).toBe("hello\n");
    expect(await readdir(join(root, "out"))).toEqual(["state.json"]);
  });

  it.each(["EPERM", "EACCES", "EBUSY"])("retries %s", async (code) => {
    let calls = 0;
    await renameWithRetry("a", "b", {
      rename: async () => {
        calls++;
        if (calls < 3) throw Object.assign(new Error(code), { code });
      },
      delayMs: () => 0,
    });
    expect(calls).toBe(3);
  });

  it("gives up after the last attempt and removes the temp file", async () => {
    const file = join(root, "state.json");
    let calls = 0;
    const alwaysBusy = async () => {
      calls++;
      throw eperm();
    };
    await expect(
      writeFileAtomic(file, "x", { rename: alwaysBusy, attempts: 4, delayMs: () => 0 }),
    ).rejects.toMatchObject({ code: "EPERM" });
    expect(calls).toBe(4);
    expect(await readdir(root)).toEqual([]);
  });

  it("does not retry other errors", async () => {
    let calls = 0;
    const missing = async () => {
      calls++;
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    };
    await expect(
      renameWithRetry("a", "b", { rename: missing, delayMs: () => 0 }),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(calls).toBe(1);
  });
});

describe("CostLedger", () => {
  it("returns no entries and a zero total when the file is missing", async () => {
    const ledger = new CostLedger(join(root, "costs.jsonl"));
    expect(await ledger.entries()).toEqual([]);
    expect(await ledger.total()).toBe(0);
    expect(await ledger.byPhase()).toEqual({});
  });

  it("appends entries with `at` from the clock and sums them", async () => {
    const file = join(root, ".opscrew", "costs.jsonl");
    const ledger = new CostLedger(file, tickingClock());
    await ledger.append({ phase: "analyze", model: "claude-opus-5-5", costUsd: 0.25 });
    await ledger.append({ phase: "analyze", costUsd: 0.5 });
    await ledger.append({ phase: "design", costUsd: 1 });

    expect(await ledger.entries()).toEqual([
      { at: "2026-10-11T12:00:00.000Z", phase: "analyze", model: "claude-opus-5-5", costUsd: 0.25 },
      { at: "2026-10-11T12:01:00.000Z", phase: "analyze", costUsd: 0.5 },
      { at: "2026-10-11T12:02:00.000Z", phase: "design", costUsd: 1 },
    ]);
    expect(await ledger.total()).toBeCloseTo(1.75);
    expect(await ledger.byPhase()).toEqual({ analyze: 0.75, design: 1 });
  });

  it("skips corrupt lines and exposes warnings", async () => {
    const file = join(root, "costs.jsonl");
    await writeFile(
      file,
      [
        JSON.stringify({ at: "2026-10-11T12:00:00.000Z", phase: "scan", costUsd: 0.1 }),
        "garbage",
        JSON.stringify({ at: "2026-10-11T12:00:00.000Z", phase: "nope", costUsd: 1 }),
        JSON.stringify({ at: "2026-10-11T12:00:00.000Z", phase: "scan", costUsd: "1" }),
        '{"at":',
      ].join("\n"),
      "utf8",
    );
    const ledger = new CostLedger(file);
    expect(await ledger.total()).toBeCloseTo(0.1);
    expect(ledger.warnings).toHaveLength(4);
  });

  it("rejects negative or non-finite costs", async () => {
    const ledger = new CostLedger(join(root, "costs.jsonl"));
    for (const costUsd of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(ledger.append({ phase: "scan", costUsd })).rejects.toMatchObject({
        code: "INVALID_INPUT",
      });
    }
  });

  it("never interleaves 100 concurrent appends", async () => {
    const file = join(root, "costs.jsonl");
    const ledger = new CostLedger(file);
    await Promise.all(
      Array.from({ length: 100 }, () => ledger.append({ phase: "adapt", costUsd: 0.01 })),
    );
    expect(await ledger.entries()).toHaveLength(100);
    expect(ledger.warnings).toEqual([]);
    expect(await ledger.total()).toBeCloseTo(1);
  });
});
