import { type DeployPlan, DeployPlanSchema, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { defaultProvider } from "../interview/questions";
import { cloudTarget, planProvider, requestedProvider } from "../providers";
import { testPlan } from "../provision/__fixtures__/fakes";
import { runRetarget } from "../retarget/run";
import { createTestPhaseDeps } from "../testing";
import { moveProvider, vpsProvider, vpsTarget } from "./vps-target";

const NOT_YET = {
  code: "PHASE_PRECONDITION",
  message: "A Portainer target is not supported by this command yet.",
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

describe("a Portainer target in phases that only know single servers", () => {
  it("is refused plainly where a server's provider is needed", () => {
    const plan = portainerPlan();
    for (const attempt of [
      () => planProvider(plan),
      () => requestedProvider({ provider: "portainer" }),
      () => cloudTarget(plan.target),
      () => vpsTarget(plan.target),
      () => vpsProvider("portainer"),
    ]) {
      expect(refusal(attempt)).toMatchObject(NOT_YET);
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
    expect(vpsTarget(testPlan().target)).toEqual(testPlan().target);
  });

  it("never moves: opscrew retarget refuses a Portainer target before anything else", async () => {
    const deps = await createTestPhaseDeps();
    await writeArtifact("plan", deps.paths.files.plan, portainerPlan());
    await expect(runRetarget(deps, { to: "hetzner" })).rejects.toMatchObject(NO_MOVE);
  });
});
