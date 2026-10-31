import { describe, expect, it } from "vitest";
import { testPlan } from "../testing";
import { appServerChange, deployedAppServer } from "./server-changes";

describe("the app's deployed server", () => {
  const plan = testPlan();
  const resized = { ...plan, target: { ...plan.target, serverType: "cx33" } };

  it("keeps its disk only once it exists, and its changes are said once planned", () => {
    const applied = {
      ...plan,
      deployment: { lastApplyAt: "2026-10-11T12:30:00.000Z", lastPlanHash: "a".repeat(64) },
    };
    expect(deployedAppServer(applied, "hetzner")).toEqual({
      location: "nbg1",
      serverType: "cx23",
    });
    expect(deployedAppServer(applied, "digitalocean")).toBeUndefined();

    // Only planned: no server yet, but the next provision still changes what was planned.
    const planned = { ...plan, deployment: { lastPlanHash: "a".repeat(64) } };
    expect(deployedAppServer(planned, "hetzner")).toBeUndefined();
    expect(appServerChange(planned, resized)).toMatchObject({ kind: "resize" });

    const destroyed = {
      ...applied,
      deployment: { ...applied.deployment, destroyedAt: "2026-10-12T12:30:00.000Z" },
    };
    expect(deployedAppServer(destroyed, "hetzner")).toBeUndefined();
  });
});
