import { OpsCrewError } from "@opscrew/core";
import { DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { createTestPhaseDeps, testPlan } from "../testing";
import { pausedMergeNote, reportPausedMerge } from "./steps";

const PINNED = {
  reason: "rollback",
  since: "2026-10-11T11:00:00.000Z",
  image: `sha256:${"ab".repeat(32)}`,
  commit: "c".repeat(40),
} as const;

describe("pausedMergeNote", () => {
  it("says nothing unless a rollback pins the environment", async () => {
    const deps = await createTestPhaseDeps();
    const plan = testPlan();
    expect(await pausedMergeNote(deps, plan, undefined)).toBeUndefined();
    expect(
      await pausedMergeNote(deps, plan, { reason: "move", since: PINNED.since }),
    ).toBeUndefined();
  });

  it("names --resume --deploy for an environment that follows its branch", async () => {
    const deps = await createTestPhaseDeps();
    expect(await pausedMergeNote(deps, testPlan(), PINNED)).toBe(
      "The deploys of shop/prod are paused since 2026-10-11T11:00:00.000Z: `opscrew rollback` pinned it to ccccccc (sha256:abababababab). The merged files deploy only after `opscrew rollback --resume --deploy`.",
    );
  });

  it("names opscrew promote after resuming, for a promoted environment", async () => {
    const deps = await createTestPhaseDeps();
    const plan = DeployPlanSchema.parse({
      ...testPlan(),
      environment: { deploySource: { from: "promote", source: "staging" } },
    });
    expect(await pausedMergeNote(deps, plan, PINNED)).toBe(
      "The deploys of shop/prod are paused since 2026-10-11T11:00:00.000Z: `opscrew rollback` pinned it to ccccccc (sha256:abababababab). The merged files deploy only after `opscrew rollback --resume`, then `opscrew promote --to prod`.",
    );
  });
});

describe("reportPausedMerge", () => {
  const repo = (read: () => Promise<string | undefined>) => ({
    api: { getRepoVariable: read },
    owner: "acme",
    repo: "shop",
  });

  it("reports the note for the pause GitHub holds", async () => {
    const deps = await createTestPhaseDeps();
    await reportPausedMerge(
      deps,
      testPlan(),
      repo(async () => JSON.stringify({ "shop/prod": PINNED })),
    );
    expect(deps.reporter.lines).toEqual([
      { level: "info", message: await pausedMergeNote(deps, testPlan(), PINNED) },
    ]);
  });

  it("reports nothing when no rollback pins it, or the token cannot read the variable", async () => {
    const deps = await createTestPhaseDeps();
    await reportPausedMerge(
      deps,
      testPlan(),
      repo(async () => undefined),
    );
    await reportPausedMerge(
      deps,
      testPlan(),
      repo(async () => {
        throw new OpsCrewError("CREDENTIALS_INVALID", "no Variables: read");
      }),
    );
    expect(deps.reporter.lines).toEqual([]);
  });
});
