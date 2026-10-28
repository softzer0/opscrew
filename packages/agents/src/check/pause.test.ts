import { CHECK_PAUSED_VARIABLE } from "@opscrew/iac-templates";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { createTestPhaseDeps, FakeGitHub, ScriptedApprovalHandler, testPlan } from "../testing";
import { changeCheckPause } from "./pause";

/** The `shop` app's prod plan, or its `staging` environment, with the check on or off. */
function plan(enabled = true, environment?: string): DeployPlan {
  const base = testPlan();
  return DeployPlanSchema.parse({
    ...base,
    app: { ...base.app, name: environment === undefined ? "shop" : `shop-${environment}` },
    ...(environment === undefined ? {} : { environment: { name: environment } }),
    observability: { check: { enabled } },
  });
}

async function setup(answer = true) {
  const handler = new ScriptedApprovalHandler(() => answer);
  const deps = await createTestPhaseDeps({ approvalHandler: handler });
  const github = new FakeGitHub();
  const target = { api: github, owner: "acme", repo: "shop" };
  const paused = () => {
    const text = github.variables.get(CHECK_PAUSED_VARIABLE);
    return text === undefined ? undefined : JSON.parse(text);
  };
  return { deps, handler, github, target, paused };
}

describe("changeCheckPause", () => {
  it("adds the environment's entry and keeps the others", async () => {
    const { deps, handler, github, target, paused } = await setup();
    github.variables.set(
      CHECK_PAUSED_VARIABLE,
      JSON.stringify({ "shop/staging": { reason: "retarget", since: "2026-10-01T00:00:00.000Z" } }),
    );
    await expect(changeCheckPause(deps, target, plan(), "destroyed", "provision")).resolves.toBe(
      "changed",
    );
    expect(paused()).toEqual({
      "shop/staging": { reason: "retarget", since: "2026-10-01T00:00:00.000Z" },
      "shop/prod": { reason: "destroyed", since: "2026-10-11T12:00:00.000Z" },
    });
    expect(handler.requests).toEqual([
      expect.objectContaining({
        kind: "github-settings",
        title: "Pause the scheduled check for shop/prod in acme/shop",
      }),
    ]);
    expect(deps.audit.entries).toContainEqual(
      expect.objectContaining({
        kind: "provider-call",
        action: "pause the scheduled check for shop/prod",
        target: "acme/shop",
      }),
    );
  });

  it("removes the entry, and the variable with the last one", async () => {
    const { deps, github, target, paused } = await setup();
    await changeCheckPause(deps, target, plan(true, "staging"), "retarget", "retarget");
    await changeCheckPause(deps, target, plan(), "retarget", "retarget");
    await changeCheckPause(deps, target, plan(), undefined, "provision");
    // A named environment's app name is `<app>-<env>`.
    expect(Object.keys(paused())).toEqual(["shop/staging"]);
    await changeCheckPause(deps, target, plan(true, "staging"), undefined, "provision");
    expect(github.variables.has(CHECK_PAUSED_VARIABLE)).toBe(false);
  });

  it("asks nothing when nothing changes", async () => {
    const { deps, handler, github, target } = await setup();
    // Nothing to resume.
    await expect(changeCheckPause(deps, target, plan(), undefined, "provision")).resolves.toBe(
      "unchanged",
    );
    // No check to pause or resume: the variable is not even read.
    github.getRepoVariable = async () => {
      throw new Error("read without the check on");
    };
    await expect(
      changeCheckPause(deps, target, plan(false), "destroyed", "provision"),
    ).resolves.toBe("unchanged");
    await expect(changeCheckPause(deps, target, plan(false), undefined, "provision")).resolves.toBe(
      "unchanged",
    );
    github.getRepoVariable = FakeGitHub.prototype.getRepoVariable;
    // Paused already, for the same reason.
    await changeCheckPause(deps, target, plan(), "retarget", "retarget");
    await expect(changeCheckPause(deps, target, plan(), "retarget", "retarget")).resolves.toBe(
      "unchanged",
    );
    expect(handler.requests).toHaveLength(1);
  });

  it("changes nothing when the change is declined", async () => {
    const { deps, github, target } = await setup(false);
    await expect(changeCheckPause(deps, target, plan(), "destroyed", "provision")).resolves.toBe(
      "refused",
    );
    expect(github.variables.size).toBe(0);
  });

  it("stops on a variable that is not OpsCrew's JSON", async () => {
    const { deps, github, handler, target } = await setup();
    github.variables.set(CHECK_PAUSED_VARIABLE, "yes please");
    await expect(changeCheckPause(deps, target, plan(), "destroyed", "provision")).rejects.toThrow(
      /OPSCREW_CHECK_PAUSED of acme\/shop is not the JSON OpsCrew writes/,
    );
    expect(github.variables.get(CHECK_PAUSED_VARIABLE)).toBe("yes please");
    expect(handler.requests).toEqual([]);
  });
});
