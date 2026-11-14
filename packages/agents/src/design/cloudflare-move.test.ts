import { readFile } from "node:fs/promises";
import {
  type CloudflareMove,
  type Requirements,
  readArtifact,
  writeArtifact,
} from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { leaksToken, twoAccounts, withCloudflareMove } from "../cloudflare-move/record.fakes";
import { createTestPhaseDeps, euCatalog, makeRequirements, staticSpaFacts } from "../testing";
import { previewDesignOptions, runDesign } from "./run";

/** A designed app on `shop.example.com` (Cloudflare DNS) whose zone moves, at `step`. */
async function designedOnCloudflare(
  zone: string | undefined,
  step: CloudflareMove["step"] = "started",
) {
  const accounts = twoAccounts();
  const deps = await createTestPhaseDeps();
  Object.assign(deps.env, accounts.env);
  await writeArtifact("architecture", deps.paths.files.architecture, {
    schemaVersion: 1,
    generatedAt: "2026-10-11T10:00:00.000Z",
    generator: { tool: "opscrew", version: "0.0.0-test" },
    facts: staticSpaFacts(),
    summary: "A test app.",
    risks: [],
    aiEnriched: false,
  });
  const requirements = makeRequirements({ dnsProvider: "cloudflare", domain: "shop.example.com" });
  await writeArtifact("requirements", deps.paths.files.requirements, requirements);
  const { plan } = await runDesign(deps, { catalog: euCatalog() });
  const onCloudflare = { ...plan, dns: { ...plan.dns, ...(zone === undefined ? {} : { zone }) } };
  const moving = withCloudflareMove(onCloudflare, accounts, step);
  await writeArtifact("plan", deps.paths.files.plan, moving);
  return { accounts, deps, moving };
}

describe("design during a move to another Cloudflare account", () => {
  it.each(["started", "prepared", "adopted"] as const)(
    "goes on at %s and keeps the move's record",
    async (step) => {
      const { accounts, deps, moving } = await designedOnCloudflare("example.com", step);
      const preview = await previewDesignOptions(deps, { catalog: euCatalog() });
      expect(preview.warnings.join(" ")).not.toContain("move");
      const result = await runDesign(deps, { catalog: euCatalog() });
      expect(result.plan.cloudflareMove).toEqual(moving.cloudflareMove);
      const plan = await readArtifact("plan", deps.paths.files.plan);
      expect(plan.cloudflareMove).toEqual(moving.cloudflareMove);
      expect(accounts.cloudflare.calls).toEqual([]);
      expect(leaksToken(accounts, deps.reporter.text())).toBe(false);
    },
  );

  it.each([
    ["the plan's zone", "example.com", { dnsProvider: "cloudflare", domain: "shop.example.org" }],
    ["the zone found for the domain", undefined, { domain: "shop.example.org" }],
    ["Cloudflare DNS", "example.com", { dnsProvider: "none", domain: undefined }],
  ] as const)(
    "refuses answers that leave %s, before plan.yaml changes",
    async (_c, zone, change) => {
      const { accounts, deps } = await designedOnCloudflare(zone);
      const before = await readFile(deps.paths.files.plan, "utf8");
      const requirements: Requirements = {
        ...makeRequirements({ dnsProvider: "cloudflare", domain: "shop.example.com" }),
        ...change,
      };
      await writeArtifact("requirements", deps.paths.files.requirements, requirements);
      await expect(runDesign(deps, { catalog: euCatalog() })).rejects.toMatchObject({
        code: "PHASE_PRECONDITION",
        message:
          "example.com is moving to another Cloudflare account; change the app's domain after the move ends. plan.yaml was not changed.",
      });
      expect(await readFile(deps.paths.files.plan, "utf8")).toBe(before);
      expect(accounts.cloudflare.calls).toEqual([]);
      expect(leaksToken(accounts, deps.reporter.text())).toBe(false);
    },
  );

  it("goes on with another hostname in the moving zone", async () => {
    const { deps } = await designedOnCloudflare("example.com");
    await writeArtifact(
      "requirements",
      deps.paths.files.requirements,
      makeRequirements({ dnsProvider: "cloudflare", domain: "app.example.com" }),
    );
    const { plan } = await runDesign(deps, { catalog: euCatalog() });
    expect(plan.dns).toMatchObject({ domain: "app.example.com", zone: "example.com" });
    expect(plan.cloudflareMove?.zone).toBe("example.com");
  });
});
