import { OpsCrewError } from "@opscrew/core";
import { cloudTarget } from "@opscrew/iac-templates";
import type { DeployPlan, Retarget } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { testPlan } from "../testing";
import { moveInProgress, requireNoMoveInProgress } from "./guard";

/** A plan moving from Hetzner Cloud to DigitalOcean, at `step`, optionally being aborted. */
function moving(abort?: NonNullable<Retarget["abort"]>["step"]): DeployPlan {
  const from = testPlan({ deployed: true });
  return {
    ...testPlan({ provider: "digitalocean", deployed: true }),
    retarget: {
      from: { target: cloudTarget(from.target), deploy: from.deploy },
      step: "deployed",
      empty: [],
      startedAt: "2026-10-12T09:00:00.000Z",
      ...(abort !== undefined ? { abort: { step: abort } } : {}),
    },
  };
}

describe("moveInProgress", () => {
  it("is undefined without a move", () => {
    expect(moveInProgress(testPlan())).toBeUndefined();
    expect(() => requireNoMoveInProgress(testPlan())).not.toThrow();
  });

  it("names continue, finish and abort while a move runs", () => {
    expect(moveInProgress(moving())).toEqual({
      message: "A move to DigitalOcean is in progress.",
      hint: "Run `opscrew retarget` to continue it, `opscrew retarget --finish` after the switch, or `opscrew retarget --abort` before it.",
    });
  });

  it.each(["started", "new-removed", "secrets-restored"] as const)(
    "names only the abort once an abort began (%s)",
    (step) => {
      const move = moveInProgress(moving(step));
      expect(move?.message).toBe("A move to DigitalOcean is being aborted.");
      expect(move?.hint).toContain("Run `opscrew retarget --abort` to finish the abort");
      expect(move?.hint).not.toContain("continue it");
      expect(move?.hint).not.toContain("--finish");
      const error = (() => {
        try {
          requireNoMoveInProgress(moving(step));
        } catch (e) {
          return e;
        }
      })();
      expect(error).toBeInstanceOf(OpsCrewError);
      expect(error).toMatchObject({ code: "PHASE_PRECONDITION", hint: move?.hint });
    },
  );
});

describe("moveInProgress for a move to the user's own server or Portainer", () => {
  const to = (target: DeployPlan["target"]): DeployPlan => ({ ...moving(), target });
  const own = to({
    provider: "own",
    mode: "vps-compose",
    arch: "amd64",
    access: "public",
    edge: "caddy",
  });
  const portainer = to({
    provider: "portainer",
    mode: "portainer-stack",
    environmentId: 3,
    arch: "amd64",
    redeploy: "updater",
    web: { mode: "caddy" },
  });

  it.each([
    [own, "A move to your own server is in progress."],
    [portainer, "A move to your Portainer is in progress."],
  ])("names the target in words and refuses with that notice (%#)", (plan, message) => {
    expect(moveInProgress(plan)?.message).toBe(message);
    expect(() => requireNoMoveInProgress(plan)).toThrow(message);
    expect(JSON.stringify(moveInProgress(plan))).not.toContain("Your own server");
  });
});
