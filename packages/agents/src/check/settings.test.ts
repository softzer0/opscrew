import { resolveProjectPaths } from "@opscrew/core";
import { ArtifactError, type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { localPlan } from "../localhost/__fixtures__/computer";
import { testPlan } from "../testing";
import { requireCheckSettingsPlace, withDesignedCheck } from "./settings";

const ROOT = "/work/shop";

/** `testPlan` as `app` (a further app's key) in `environment`, with `check`. */
function plan(
  check: Record<string, unknown> | undefined,
  where: { app?: string; environment?: string } = {},
): DeployPlan {
  const base = testPlan();
  const name = [where.app ?? "shop", where.environment].filter(Boolean).join("-");
  return DeployPlanSchema.parse({
    ...base,
    app: { ...base.app, name, ...(where.app === undefined ? {} : { key: where.app }) },
    ...(where.environment === undefined ? {} : { environment: { name: where.environment } }),
    ...(check === undefined ? {} : { observability: { check } }),
  });
}

function pathsOf(where: { app?: string; environment?: string } = {}) {
  return resolveProjectPaths(ROOT, {
    env: { OPSCREW_HOME: "/home/user/.opscrew" },
    ...where,
  });
}

describe("requireCheckSettingsPlace", () => {
  it("accepts the interval and the webhook in the first app's prod plan", () => {
    expect(() =>
      requireCheckSettingsPlace(
        pathsOf(),
        plan({ enabled: true, intervalMinutes: 30, webhook: "ntfy" }),
      ),
    ).not.toThrow();
  });

  it("refuses them in another environment's plan, naming the file to edit", () => {
    const staging = { environment: "staging" };
    let error: unknown;
    try {
      requireCheckSettingsPlace(
        pathsOf(staging),
        plan({ enabled: false, intervalMinutes: 30, webhook: "slack" }, staging),
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ArtifactError);
    const artifact = error as ArtifactError;
    expect(artifact.file).toBe("opscrew/environments/staging/plan.yaml");
    expect(artifact.issues.map((issue) => issue.path)).toEqual([
      "observability.check.intervalMinutes",
      "observability.check.webhook",
    ]);
    expect(artifact.message).toContain("only the first app's prod plan (opscrew/plan.yaml)");
    expect(artifact.hint).toBe(
      "Remove observability.check.intervalMinutes and observability.check.webhook from opscrew/environments/staging/plan.yaml, and set them in opscrew/plan.yaml instead.",
    );
  });

  it("refuses them in a further app's prod plan", () => {
    const api = { app: "api" };
    expect(() =>
      requireCheckSettingsPlace(pathsOf(api), plan({ enabled: true, intervalMinutes: 15 }, api)),
    ).toThrow(/opscrew\/apps\/api\/plan\.yaml/);
  });

  it("accepts `enabled` anywhere", () => {
    const staging = { app: "api", environment: "staging" };
    expect(() =>
      requireCheckSettingsPlace(pathsOf(staging), plan({ enabled: true }, staging)),
    ).not.toThrow();
  });
});

describe("withDesignedCheck", () => {
  it("turns the check on for prod and off for the other environments", () => {
    expect(withDesignedCheck(plan(undefined), "prod").observability).toEqual({
      check: { enabled: true },
    });
    expect(
      withDesignedCheck(plan(undefined, { environment: "staging" }), "staging").observability,
    ).toEqual({ check: { enabled: false } });
  });

  it("keeps the plan's own setting", () => {
    const off = plan({ enabled: false, intervalMinutes: 30 });
    expect(withDesignedCheck(off, "prod")).toBe(off);
  });

  it("gives localhost no check", () => {
    const local = localPlan();
    expect(withDesignedCheck(local, "prod").observability).toBeUndefined();
  });
});
