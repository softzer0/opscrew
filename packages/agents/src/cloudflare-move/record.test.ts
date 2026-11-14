import { readFile } from "node:fs/promises";
import { OpsCrewError } from "@opscrew/core";
import { readArtifact, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { environmentPaths } from "../environments/paths";
import { createTestPhaseDeps, testPlan } from "../testing";
import {
  abortingMove,
  advancedMove,
  readMoveRecords,
  startedMove,
  withTargetZone,
  writeMoveRecord,
} from "./record";
import { leaksToken, twoAccounts } from "./record.fakes";

const START = new Date("2026-11-20T10:00:00.000Z");
const LATER = new Date("2026-11-20T10:40:00.000Z");

/** The start of a move of example.com from A to B, B's zone not made yet. */
function start(accounts = twoAccounts()) {
  const a = accounts.cloudflare.zone("example.com", "A");
  return {
    accounts,
    move: startedMove(
      {
        zone: "example.com",
        from: { accountId: a.accountId, zoneId: a.id },
        to: { accountId: accounts.cloudflare.account("B").id },
        dsAtStart: false,
      },
      START,
    ),
  };
}

describe("the move's steps", () => {
  it("starts, gets B's zone, is prepared and adopted, each time recorded", () => {
    const { accounts, move } = start();
    expect(move).toMatchObject({ step: "started", startedAt: START.toISOString() });
    expect(move.to.zoneId).toBeUndefined();
    const b = accounts.cloudflare.zone("example.com", "B");
    const zoned = withTargetZone(move, b.id);
    expect(zoned.to).toEqual({ accountId: b.accountId, zoneId: b.id });
    const prepared = advancedMove(zoned, "prepared", LATER);
    expect(prepared).toMatchObject({ step: "prepared", preparedAt: LATER.toISOString() });
    const adopted = advancedMove(prepared, "adopted", new Date("2026-11-21T09:10:00.000Z"));
    expect(adopted).toMatchObject({
      step: "adopted",
      preparedAt: LATER.toISOString(),
      adoptedAt: "2026-11-21T09:10:00.000Z",
    });
  });

  it("keeps a step already reached as it was", () => {
    const prepared = advancedMove(start().move, "prepared", LATER);
    expect(advancedMove(prepared, "prepared", new Date())).toBe(prepared);
    const aborting = abortingMove(prepared, "started");
    expect(abortingMove(aborting, "started")).toBe(aborting);
  });

  it("refuses a step out of order, and any step once an abort began", () => {
    const { move } = start();
    expect(() => advancedMove(move, "adopted", LATER)).toThrow(OpsCrewError);
    const aborting = abortingMove(move, "started");
    expect(aborting.abort).toEqual({ step: "started" });
    expect(() => advancedMove(aborting, "prepared", LATER)).toThrow(OpsCrewError);
    expect(() => abortingMove(move, "removed")).toThrow(OpsCrewError);
    expect(abortingMove(aborting, "removed").abort).toEqual({ step: "removed" });
  });

  it("never aborts once B has taken the app over", () => {
    const adopted = advancedMove(advancedMove(start().move, "prepared", LATER), "adopted", LATER);
    expect(() => abortingMove(adopted, "started")).toThrow(OpsCrewError);
  });

  it("refuses B's zone when the record names another one", () => {
    const { accounts, move } = start();
    const b = accounts.cloudflare.zone("example.com", "B");
    const zoned = withTargetZone(move, b.id);
    expect(withTargetZone(zoned, b.id)).toBe(zoned);
    expect(() => withTargetZone(zoned, "f".repeat(32))).toThrow(OpsCrewError);
  });
});

describe("the record in each covered plan", () => {
  it("round-trips through prod's and staging's plans, written atomically, and is removed", async () => {
    const deps = await createTestPhaseDeps();
    const staging = environmentPaths(deps.paths, "staging");
    await writeArtifact("plan", deps.paths.files.plan, testPlan());
    await writeArtifact("plan", staging.files.plan, {
      ...testPlan(),
      app: { ...testPlan().app, name: "shop-staging" },
      environment: { name: "staging", deploySource: { from: "main" }, runner: "github" },
    });
    const { accounts, move } = start();
    for (const paths of [deps.paths, staging]) await writeMoveRecord(deps, paths, move);
    const prepared = advancedMove(move, "prepared", LATER);
    const written = await writeMoveRecord(deps, staging, prepared);
    expect(written.cloudflareMove).toEqual(prepared);
    expect(written.updatedAt).toBe("2026-10-11T12:00:00.000Z");

    const records = await readMoveRecords(deps.paths, ["prod", "staging", "qa"]);
    expect(records.map((r) => [r.environment, r.plan.cloudflareMove?.step])).toEqual([
      ["prod", "started"],
      ["staging", "prepared"],
    ]);
    expect(records[1]?.paths.files.plan).toBe(staging.files.plan);
    expect((await readArtifact("plan", staging.files.plan)).cloudflareMove).toEqual(prepared);

    await writeMoveRecord(deps, deps.paths, undefined);
    expect((await readArtifact("plan", deps.paths.files.plan)).cloudflareMove).toBeUndefined();
    const text = [
      await readFile(deps.paths.files.plan, "utf8"),
      await readFile(staging.files.plan, "utf8"),
    ];
    expect(leaksToken(accounts, ...text)).toBe(false);
    expect(accounts.cloudflare.calls).toEqual([]);
  });

  it("leaves a plan that already holds the record untouched", async () => {
    const deps = await createTestPhaseDeps();
    await writeArtifact("plan", deps.paths.files.plan, testPlan());
    const { move } = start();
    await writeMoveRecord(deps, deps.paths, move);
    const before = await readFile(deps.paths.files.plan, "utf8");
    const later = await createTestPhaseDeps({
      root: deps.paths.root,
      env: { OPSCREW_HOME: deps.paths.homeDir },
      clock: { now: () => LATER },
    });
    await writeMoveRecord(later, later.paths, move);
    expect(await readFile(deps.paths.files.plan, "utf8")).toBe(before);
  });

  it("refuses a record the plan can't hold, leaving the plan as it was", async () => {
    const deps = await createTestPhaseDeps();
    await writeArtifact("plan", deps.paths.files.plan, testPlan());
    const before = await readFile(deps.paths.files.plan, "utf8");
    const { move } = start();
    const same = { ...move, to: { accountId: move.from.accountId } };
    await expect(writeMoveRecord(deps, deps.paths, same)).rejects.toMatchObject({
      code: "ARTIFACT_INVALID",
    });
    expect(await readFile(deps.paths.files.plan, "utf8")).toBe(before);
  });

  it("never writes a record that goes back or names another move, but ends at any step", async () => {
    const deps = await createTestPhaseDeps();
    await writeArtifact("plan", deps.paths.files.plan, testPlan());
    const { accounts, move } = start();
    const b = accounts.cloudflare.zone("example.com", "B");
    const prepared = advancedMove(withTargetZone(move, b.id), "prepared", LATER);
    const adopted = advancedMove(prepared, "adopted", LATER);
    await writeMoveRecord(deps, deps.paths, adopted);
    const before = await readFile(deps.paths.files.plan, "utf8");
    const refused = [
      prepared,
      { ...adopted, zone: "example.org" },
      { ...adopted, from: { accountId: adopted.from.accountId, zoneId: b.id } },
      { ...adopted, to: { accountId: adopted.to.accountId, zoneId: "f".repeat(32) } },
      { ...adopted, to: { accountId: adopted.to.accountId } },
    ];
    for (const record of refused) {
      await expect(writeMoveRecord(deps, deps.paths, record)).rejects.toMatchObject({
        code: "INTERNAL",
      });
      expect(await readFile(deps.paths.files.plan, "utf8")).toBe(before);
    }
    // The same step again (a later time kept as written) and the end are fine.
    const again = { ...adopted, adoptedAt: "2026-11-21T10:00:00.000Z" };
    expect((await writeMoveRecord(deps, deps.paths, again)).cloudflareMove).toEqual(again);
    expect((await writeMoveRecord(deps, deps.paths, undefined)).cloudflareMove).toBeUndefined();
  });

  it("never drops an abort or moves it back", async () => {
    const deps = await createTestPhaseDeps();
    await writeArtifact("plan", deps.paths.files.plan, testPlan());
    const { move } = start();
    const removed = abortingMove(abortingMove(move, "started"), "removed");
    await writeMoveRecord(deps, deps.paths, removed);
    for (const record of [move, abortingMove(move, "started")]) {
      await expect(writeMoveRecord(deps, deps.paths, record)).rejects.toMatchObject({
        code: "INTERNAL",
      });
    }
    expect((await writeMoveRecord(deps, deps.paths, removed)).cloudflareMove).toEqual(removed);
  });
});
