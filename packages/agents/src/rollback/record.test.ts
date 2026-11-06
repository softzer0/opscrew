import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson, sha256Hex } from "@opscrew/core";
import { describe, expect, it } from "vitest";
import { commitOf, digestOf } from "../promote/__fixtures__/world";
import { createTestPhaseDeps } from "../testing";
import {
  imageRollbackHash,
  PENDING_ROLLBACK_FILE,
  type PendingRollback,
  type RolledBack,
  readPendingRollback,
  readRollback,
  rollbackFile,
  writePendingRollback,
  writeRollback,
} from "./record";

const A = digestOf("a");
const B = digestOf("b");
const C = digestOf("c");

describe("imageRollbackHash", () => {
  const parts = {
    environment: "shop/prod",
    current: C,
    target: B,
    targetPlanHash: "a".repeat(64),
  };

  it("is SHA-256 of the canonical environment, current digest, target digest and plan hash", () => {
    const hash = imageRollbackHash(parts);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(sha256Hex(canonicalJson(parts)));
    // The order the parts are given in doesn't matter.
    const { targetPlanHash, target, current, environment } = parts;
    expect(imageRollbackHash({ targetPlanHash, target, current, environment })).toBe(hash);
  });

  it("keeps the same bytes, with and without the database", () => {
    expect(imageRollbackHash(parts)).toBe(
      "3e9cec37b8be08d3b6d8381edee5725dc4053aa9dada3b488b59c46d52e34fcc",
    );
    const database = {
      choice: "snapshot",
      taken: "2026-10-11T11:30:00Z",
      currentRecord: "count=3",
      targetRecord: null,
    } as const;
    expect(imageRollbackHash({ ...parts, database })).toBe(
      "c1a37925cee78c0f6562fedfedb3591b68442626589f6a6f099a3442e6a4b42c",
    );
  });

  it("changes with each of its four parts", () => {
    const changed = [
      { ...parts, environment: "shop/staging" },
      { ...parts, current: A },
      { ...parts, target: A },
      { ...parts, targetPlanHash: "b".repeat(64) },
    ].map(imageRollbackHash);
    expect(new Set([imageRollbackHash(parts), ...changed]).size).toBe(5);
  });
});

describe("rollback.json", () => {
  const first: RolledBack = {
    digest: B,
    commit: commitOf("b"),
    from: { digest: C, commit: commitOf("c") },
    runUrl: "https://github.com/acme/shop/actions/runs/777",
    at: "2026-10-31T10:04:00.000Z",
    hash: "1".repeat(64),
  };
  const second: RolledBack = {
    digest: A,
    commit: commitOf("a"),
    from: { digest: B, commit: commitOf("b") },
    runUrl: "https://github.com/acme/shop/actions/runs/778",
    at: "2026-10-31T11:00:00.000Z",
    hash: "2".repeat(64),
  };

  it("records the last rollback in the environment's state folder, with the one it replaced", async () => {
    const deps = await createTestPhaseDeps();
    expect(await readRollback(deps.paths)).toBeUndefined();
    await writeRollback(deps.paths, first);
    expect(rollbackFile(deps.paths)).toBe(join(deps.paths.stateDir, "rollback.json"));
    expect(await readRollback(deps.paths)).toEqual(first);

    await writeRollback(deps.paths, second);
    const third = { ...first, at: "2026-10-31T12:00:00.000Z" };
    await writeRollback(deps.paths, third);
    // Only the record it replaced is kept, without that one's own `previous`.
    expect(await readRollback(deps.paths)).toEqual({ ...third, previous: second });
    // `status` reads the commit and the time of the last rollback from it.
    const text = JSON.parse(await readFile(rollbackFile(deps.paths), "utf8"));
    expect(text).toMatchObject({ commit: first.commit, at: third.at });
  });

  it("reads a damaged file as none", async () => {
    const deps = await createTestPhaseDeps();
    await writeRollback(deps.paths, first);
    await writeFile(rollbackFile(deps.paths), "{ not json");
    expect(await readRollback(deps.paths)).toBeUndefined();
  });
});

describe("pending-rollback.json", () => {
  const pending: PendingRollback = {
    digest: B,
    commit: commitOf("b"),
    from: { digest: C, commit: commitOf("c") },
    runId: 777,
    at: "2026-10-31T10:04:00.000Z",
    hash: "1".repeat(64),
    pauseBefore: null,
  };

  it("keeps a run left waiting for a reviewer, with the pause entry it replaced", async () => {
    const deps = await createTestPhaseDeps();
    expect(await readPendingRollback(deps.paths)).toBeUndefined();
    await writePendingRollback(deps.paths, pending);
    expect(await readPendingRollback(deps.paths)).toEqual(pending);
    expect(
      JSON.parse(await readFile(join(deps.paths.stateDir, PENDING_ROLLBACK_FILE), "utf8")),
    ).toMatchObject({ pauseBefore: null });

    const pauseBefore = {
      reason: "rollback" as const,
      since: "2026-10-30T09:00:00.000Z",
      image: C,
      commit: commitOf("c"),
      from: commitOf("d"),
    };
    await writePendingRollback(deps.paths, { ...pending, pauseBefore });
    expect(await readPendingRollback(deps.paths)).toEqual({ ...pending, pauseBefore });
  });
});
