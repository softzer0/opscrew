import { readArtifact, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { leaksToken, twoAccounts, withCloudflareMove } from "../cloudflare-move/record.fakes";
import { createTestPhaseDeps, euCatalog, makeRequirements, staticSpaFacts } from "../testing";
import { previewDesignOptions, runDesign } from "./run";

describe("design during a move to another Cloudflare account", () => {
  it.each(["started", "prepared", "adopted"] as const)(
    "goes on at %s and keeps the move's record",
    async (step) => {
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
      await writeArtifact("requirements", deps.paths.files.requirements, makeRequirements());
      await runDesign(deps, { catalog: euCatalog() });
      const designed = await readArtifact("plan", deps.paths.files.plan);
      const moving = withCloudflareMove(designed, accounts, step);
      await writeArtifact("plan", deps.paths.files.plan, moving);

      const preview = await previewDesignOptions(deps, { catalog: euCatalog() });
      expect(preview.warnings.join("\n")).not.toContain("move");
      const result = await runDesign(deps, { catalog: euCatalog() });
      expect(result.plan.cloudflareMove).toEqual(moving.cloudflareMove);
      const plan = await readArtifact("plan", deps.paths.files.plan);
      expect(plan.cloudflareMove).toEqual(moving.cloudflareMove);
      expect(accounts.cloudflare.calls).toEqual([]);
      expect(leaksToken(accounts, deps.reporter.text())).toBe(false);
    },
  );
});
