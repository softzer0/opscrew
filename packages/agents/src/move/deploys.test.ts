import { OpsCrewError } from "@opscrew/core";
import { DEPLOY_PAUSED_VARIABLE } from "@opscrew/iac-templates";
import { describe, expect, it } from "vitest";
import { createTestPhaseDeps, FakeGitHub, testPlan } from "../testing";
import { withDeploysPaused } from "./deploys";

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
