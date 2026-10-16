import { cloudTarget } from "@opscrew/iac-templates";
import { type DeployPlan, DeployPlanSchema, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { defaultProvider } from "../interview/questions";
import { planProvider, requestedProvider } from "../providers";
import { testPlan } from "../provision/__fixtures__/fakes";
import { runRetarget } from "../retarget/run";
import { createTestPhaseDeps } from "../testing";
import { moveProvider, ownServerNoMove } from "./vps-target";

const BUG = {
  code: "PHASE_PRECONDITION",
  hint: "This is a bug in OpsCrew: please report it with the command you ran.",
};
const NO_MOVE = {
  code: "PHASE_PRECONDITION",
  message:
    "Moving an app to or from a Portainer target is not supported; destroy it and provision again.",
};

function portainerPlan(): DeployPlan {
  return DeployPlanSchema.parse({
    ...testPlan(),
    target: {
      provider: "portainer",
      mode: "portainer-stack",
      environmentId: 3,
      arch: "amd64",
      redeploy: "updater",
      web: { mode: "proxy", port: 8080 },
    },
  });
}

function refusal(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected a refusal");
}

describe("a Portainer target in steps that only know single servers", () => {
  it("is a bug in OpsCrew where a server's provider is needed", () => {
    const plan = portainerPlan();
    for (const attempt of [
      () => planProvider(plan),
      () => requestedProvider({ provider: "portainer" }),
      () => cloudTarget(plan.target),
    ]) {
      expect(refusal(attempt)).toMatchObject(BUG);
    }
    expect(refusal(() => moveProvider(plan.target))).toMatchObject(NO_MOVE);
    // The interview handles a Portainer target (T1004): its previous answer is the default.
    expect(defaultProvider({ provider: "portainer" })).toBe("portainer");
  });

  it("leaves Hetzner, DigitalOcean and own servers as they were", () => {
    expect(planProvider(testPlan())).toBe("hetzner");
    expect(planProvider(testPlan({ provider: "digitalocean" }))).toBe("digitalocean");
    expect(requestedProvider(undefined)).toBe("hetzner");
    expect(requestedProvider({ provider: "own" })).toBe("own");
    expect(defaultProvider(undefined)).toBe("hetzner");
    expect(moveProvider(testPlan().target)).toBe("hetzner");
  });

  it("never moves: opscrew retarget refuses a Portainer target before anything else", async () => {
    const deps = await createTestPhaseDeps();
    await writeArtifact("plan", deps.paths.files.plan, portainerPlan());
    await expect(runRetarget(deps, { to: "hetzner" })).rejects.toMatchObject(NO_MOVE);
  });

  it("says plainly that a server the user owns never moves", () => {
    expect(ownServerNoMove()).toMatchObject({
      code: "PHASE_PRECONDITION",
      message: expect.stringContaining("to or from a server you already own is not supported"),
    });
  });
});
