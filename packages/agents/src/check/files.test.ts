import { resolveProjectPaths } from "@opscrew/core";
import { type DeployPlan, DeployPlanSchema, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { recordOwnServer } from "../shared/server-record";
import {
  createTestPhaseDeps,
  ED25519_FINGERPRINT,
  OWN_IPV4,
  ownPlan,
  SERVER_IPV4,
  testPlan,
} from "../testing";
import { checkFiles } from "./files";

/** `base` in `environment` (its app name `<app>-<env>`) at `domain`, with the check on. */
function checked(base: DeployPlan, environment?: string, domain?: string): DeployPlan {
  return DeployPlanSchema.parse({
    ...base,
    app: { ...base.app, name: environment === undefined ? base.app.name : `shop-${environment}` },
    ...(environment === undefined ? {} : { environment: { name: environment } }),
    ...(domain === undefined ? {} : { dns: { ...base.dns, domain } }),
    observability: { check: { enabled: true } },
  });
}

const REPO = { owner: "acme", name: "shop", public: false };

async function project() {
  const deps = await createTestPhaseDeps();
  const at = (environment?: string) =>
    resolveProjectPaths(deps.paths.root, {
      env: deps.env,
      ...(environment === undefined ? {} : { environment }),
    });
  return { deps, at };
}

describe("checkFiles", () => {
  it("checks a server two environments share once, by its host key, never its address", async () => {
    const { deps, at } = await project();
    const prod = checked(ownPlan());
    const staging = checked(ownPlan(), "staging", "staging.example.com");
    await writeArtifact("plan", at().files.plan, prod);
    await writeArtifact("plan", at("staging").files.plan, staging);
    for (const environment of [undefined, "staging"]) {
      await recordOwnServer(at(environment), {
        host: OWN_IPV4,
        user: "root",
        agent: true,
        hostKey: ED25519_FINGERPRINT,
      });
    }
    const files = await checkFiles(deps.paths, prod, REPO);
    expect(files.map((file) => file.path)).toEqual([
      ".github/workflows/opscrew-check.yml",
      "opscrew/check/check.json",
      "opscrew/check/check.mjs",
    ]);
    const config = JSON.parse(files[1]?.content ?? "");
    const id = `own-${ED25519_FINGERPRINT.slice(7).replace(/\+/g, "-").replace(/\//g, "_")}`;
    expect(config.intervalMinutes).toBe(60);
    expect(config.environments).toEqual([
      {
        key: "shop/prod",
        hosts: [{ hostname: "shop.example.com", healthPath: "/api/health" }],
        server: { id, secret: "OPSCREW_CHECK_SERVER", via: "github" },
      },
      {
        key: "shop-staging/staging",
        hosts: [{ hostname: "staging.example.com", healthPath: "/api/health" }],
      },
    ]);
    for (const file of files) expect(file.content).not.toContain(OWN_IPV4);
  });

  it("renders this run's plan over its file, with every other app's and environment's", async () => {
    const { deps, at } = await project();
    await writeArtifact("plan", at().files.plan, checked(testPlan({ domain: "shop.example.com" })));
    const staging = checked(
      testPlan({ domain: "shop.example.com" }),
      "staging",
      "staging.example.com",
    );
    await writeArtifact("plan", at("staging").files.plan, {
      ...staging,
      observability: { check: { enabled: false } },
    });
    // This run turns the check on for staging (not written yet).
    const files = await checkFiles(deps.paths, staging, REPO);
    const config = JSON.parse(files[1]?.content ?? "");
    expect(config.environments.map((environment: { key: string }) => environment.key)).toEqual([
      "shop/prod",
      "shop-staging/staging",
    ]);
    for (const file of files) expect(file.content).not.toContain(SERVER_IPV4);
    // The same plans render the same files.
    expect(await checkFiles(deps.paths, staging, REPO)).toEqual(files);
  });

  it("renders nothing when no plan has the check on", async () => {
    const { deps, at } = await project();
    const plan = testPlan();
    await writeArtifact("plan", at().files.plan, plan);
    await expect(checkFiles(deps.paths, plan, REPO)).resolves.toEqual([]);
  });
});
