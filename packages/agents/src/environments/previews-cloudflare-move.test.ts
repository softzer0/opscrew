import { exists } from "@opscrew/core";
import { writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { leaksToken, twoAccounts, withCloudflareMove } from "../cloudflare-move/record.fakes";
import {
  createTestPhaseDeps,
  makeRequirements,
  nextPostgresFacts,
  PREVIEW_ZONE,
  testPlan,
} from "../testing";
import { addEnvironment } from "./index";

describe("adding a preview environment during a move to another Cloudflare account", () => {
  it("refuses before any question or file", async () => {
    const accounts = twoAccounts();
    const prod = await createTestPhaseDeps();
    await writeArtifact("architecture", prod.paths.files.architecture, {
      schemaVersion: 1,
      generatedAt: "2026-11-05T10:00:00.000Z",
      generator: { tool: "opscrew", version: "0.0.0-test" },
      facts: nextPostgresFacts({ name: "shop" }),
      summary: "A shop.",
      risks: [],
      aiEnriched: false,
    });
    const domain = "shop.example.com";
    await writeArtifact(
      "requirements",
      prod.paths.files.requirements,
      makeRequirements({ domain, dnsProvider: "cloudflare" }),
    );
    const plan = withCloudflareMove(testPlan({ domain, deployed: true }), accounts, "started");
    await writeArtifact("plan", prod.paths.files.plan, plan);
    const preview = await createTestPhaseDeps({
      root: prod.paths.root,
      env: { ...prod.env, ...accounts.env },
      environment: "preview",
    });
    let asked = false;
    const error = await addEnvironment(preview, {
      previews: true,
      ask: async () => {
        asked = true;
        return { domain: PREVIEW_ZONE };
      },
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: "PHASE_PRECONDITION",
      message:
        "A move of example.com to another Cloudflare account is in progress. Nothing was changed.",
      hint: expect.stringContaining("`opscrew cloudflare move --abort`"),
    });
    expect(asked).toBe(false);
    expect(await exists(preview.paths.files.requirements)).toBe(false);
    expect(await exists(preview.paths.files.plan)).toBe(false);
    expect(accounts.cloudflare.calls).toEqual([]);
    const { message, hint } = error as Error & { hint: string };
    expect(leaksToken(accounts, message, hint, preview.reporter.text())).toBe(false);
  });
});
