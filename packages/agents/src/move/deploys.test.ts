import { OpsCrewError } from "@opscrew/core";
import { DEPLOY_PAUSED_VARIABLE } from "@opscrew/iac-templates";
import { describe, expect, it } from "vitest";
import { createTestPhaseDeps, FakeGitHub, testPlan } from "../testing";
import { withDeploysPaused, withDeploysPausedUntilDone } from "./deploys";

/** A deploy that never ends, and a clock that jumps a minute on every sleep. */
async function stuckDeploy() {
  const deps = await createTestPhaseDeps();
  const fake = new FakeGitHub();
  fake.workflowRuns = [
    { status: "in_progress", htmlUrl: "https://github.com/acme/shop/actions/runs/1" },
  ] as typeof fake.workflowRuns;
  let now = 0;
  const services = {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
  };
  return { deps, fake, github: { api: fake, owner: "acme", repo: "shop" }, services };
}

describe("withDeploysPaused", () => {
  for (const command of ["opscrew retarget", "opscrew provision"]) {
    it(`names ${command}, which holds the pause, when a deploy still runs`, async () => {
      const w = await stuckDeploy();
      let ran = false;
      const error = await withDeploysPaused(
        w.deps,
        w.github,
        testPlan(),
        w.services,
        command,
        async () => {
          ran = true;
        },
      ).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(OpsCrewError);
      expect((error as OpsCrewError).hint).toContain(`then run \`${command}\` again.`);
      expect(ran).toBe(false);
      // The pause is cleared however the window ends.
      expect(w.fake.variables.get(DEPLOY_PAUSED_VARIABLE)).toBeUndefined();
    });
  }
});

describe("withDeploysPausedUntilDone", () => {
  const paused = (w: Awaited<ReturnType<typeof stuckDeploy>>) =>
    w.fake.variables.get(DEPLOY_PAUSED_VARIABLE);
  const HASH = "a".repeat(64);
  const rotation = { command: "opscrew rotate db", hash: HASH };
  /** The rotation's own entry, which no move or rollback reads as theirs. */
  const OWN = { "shop/prod": { reason: "rotation", hash: HASH } };

  it("resumes the deploys once the window succeeds, and keeps them paused when it fails", async () => {
    const w = await stuckDeploy();
    w.fake.workflowRuns = [];
    const done = await withDeploysPausedUntilDone(
      w.deps,
      w.github,
      testPlan(),
      w.services,
      rotation,
      async () => {
        expect(JSON.parse(paused(w) ?? "{}")).toMatchObject(OWN);
        return "done";
      },
    );
    expect(done).toBe("done");
    expect(paused(w)).toBeUndefined();

    const failed = await withDeploysPausedUntilDone(
      w.deps,
      w.github,
      testPlan(),
      w.services,
      rotation,
      async () => {
        throw new OpsCrewError("COMMAND_FAILED", "The rotation stopped on the app's server.");
      },
    ).catch((e: unknown) => e);
    expect((failed as OpsCrewError).message).toContain("stopped on the app's server");
    expect(JSON.parse(paused(w) ?? "{}")).toMatchObject(OWN);

    // The next run that ends well resumes them.
    await withDeploysPausedUntilDone(
      w.deps,
      w.github,
      testPlan(),
      w.services,
      rotation,
      async () => {},
    );
    expect(paused(w)).toBeUndefined();
  });

  it("pauses the deploys as they were when a deploy still runs and the window never starts", async () => {
    const w = await stuckDeploy();
    let ran = false;
    const window = async () => {
      ran = true;
    };
    const error = await withDeploysPausedUntilDone(
      w.deps,
      w.github,
      testPlan(),
      w.services,
      rotation,
      window,
    ).catch((e: unknown) => e);
    expect((error as OpsCrewError).hint).toContain("then run `opscrew rotate db` again.");
    expect(ran).toBe(false);
    expect(paused(w)).toBeUndefined();

    // An earlier run's pause stays.
    const earlier = JSON.stringify({
      "shop/prod": { reason: "rotation", since: "2026-11-08T09:00:00Z", hash: HASH },
    });
    w.fake.variables.set(DEPLOY_PAUSED_VARIABLE, earlier);
    await withDeploysPausedUntilDone(
      w.deps,
      w.github,
      testPlan(),
      w.services,
      rotation,
      window,
    ).catch(() => undefined);
    expect(JSON.parse(paused(w) ?? "{}")).toMatchObject(OWN);
    expect(ran).toBe(false);
  });
});
