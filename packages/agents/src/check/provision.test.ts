import { resolveProjectPaths } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { DeployPlanSchema, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { credentialInventory } from "../rotate/inventory";
import { createTestPhaseDeps, testPlan } from "../testing";
import { deploySetupCheck } from "./provision";

const GITHUB = {
  owner: "acme",
  repo: "shop",
  api: { getRepo: async () => ({ private: true }) },
} as unknown as Parameters<typeof deploySetupCheck>[2];

describe("deploySetupCheck: the credentials' ages", () => {
  it("renders check.json with each environment's credentials and flags, never a user's token", async () => {
    // The Hetzner token is set: the inventory lists it, the check leaves it to advise.
    const deps = await createTestPhaseDeps();
    deps.env.HCLOUD_TOKEN = fakeSecret("generic-password", "hetzner");
    const at = (environment?: string) =>
      resolveProjectPaths(deps.paths.root, {
        env: deps.env,
        ...(environment === undefined ? {} : { environment }),
      });
    const base = testPlan({ domain: "shop.example.com" });
    const checked = (environment?: string) =>
      DeployPlanSchema.parse({
        ...base,
        app: { ...base.app, name: environment === undefined ? "shop" : `shop-${environment}` },
        ...(environment === undefined ? {} : { environment: { name: environment } }),
        deployment: { ...base.deployment, firstDeployAt: "2025-09-23T12:00:00.000Z" },
        observability: { check: { enabled: true, credentials: true } },
      });
    await writeArtifact("plan", at().files.plan, checked());
    const staging = checked("staging");
    await writeArtifact("plan", at("staging").files.plan, staging);

    const { files } = await deploySetupCheck(deps, staging, GITHUB);
    const config = JSON.parse(
      files.find((f) => f.path === "opscrew/check/check.json")?.content ?? "",
    );
    const credentials = config.environments.map(
      (e: { key: string; credentials: { names: string[]; flags: string; since: string } }) => [
        e.key,
        e.credentials.flags,
        e.credentials.since,
      ],
    );
    expect(credentials).toEqual([
      ["shop/prod", " --env prod", "2025-09-23T12:00:00.000Z"],
      ["shop/staging", " --env staging", "2025-09-23T12:00:00.000Z"],
    ]);
    const inventory = await credentialInventory({ ...deps, paths: at("staging") }, staging);
    expect(inventory.map((c) => c.name)).toContain("hetzner");
    expect(config.environments[1].credentials.names).toEqual(
      inventory
        .filter((c) => c.kind !== "user-token" && c.rotation.mode !== "none" && c.name !== "app")
        .map((c) => c.name),
    );
    for (const { credentials: c } of config.environments) {
      expect(c.names).toContain("db");
      expect(c.names).not.toContain("app");
      expect(c.names).not.toContain("hetzner");
    }
  });
});
