// Feature 027 (T2737): the paths the agent links into each release from shared/.
import type { DeployPlan } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { hostingTestPlan } from "./__fixtures__/account";
import { agentSettingsText } from "./provision-plans";

/** The agent's SHARED_PATHS for `plan`, from its settings. */
function sharedPaths(plan: DeployPlan, laravel = false): string {
  const settings = agentSettingsText(plan, { repository: "acme/shop", laravel });
  return /\nSHARED_PATHS='([^']*)'\n/.exec(settings)?.[1] ?? "missing";
}

const withStorage = (storage: DeployPlan["storage"], plan = hostingTestPlan()): DeployPlan => ({
  ...plan,
  storage,
});

describe("the agent's shared paths", () => {
  it("adds the plan's kept folders, cleaned, to .env and Laravel's storage", () => {
    expect(sharedPaths(hostingTestPlan())).toBe("");
    expect(sharedPaths(hostingTestPlan(), true)).toBe(".env storage");
    // The note examples/php-plain-mysql keeps in storage/ outlives each release.
    expect(sharedPaths(withStorage({ files: { dir: "./storage/" } }))).toBe("storage");
    expect(sharedPaths(withStorage({ files: { dir: "uploads" }, sqlite: { dir: "var/db" } }))).toBe(
      "uploads var/db",
    );
    // A Node.js app's settings file, with its kept folder.
    const plan = hostingTestPlan();
    const node = {
      ...plan,
      target: {
        ...plan.target,
        app: "node",
        webRoot: "public",
        runtime: { version: "22", startup: "dist/index.js" },
      },
    } as DeployPlan;
    expect(sharedPaths(withStorage({ files: { dir: "data" } }, node))).toBe(".env data");
  });

  it("names Laravel's storage once, and none of its folders, which it holds", () => {
    expect(sharedPaths(withStorage({ files: { dir: "storage" } }), true)).toBe(".env storage");
    expect(sharedPaths(withStorage({ files: { dir: "storage/app" } }), true)).toBe(".env storage");
    expect(
      sharedPaths(
        withStorage({ files: { dir: "storage/app" }, sqlite: { dir: "database" } }),
        true,
      ),
    ).toBe(".env storage database");
  });
});
