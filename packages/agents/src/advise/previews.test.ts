import { describe, expect, it } from "vitest";
import { previewTestPlan } from "../previews/__fixtures__/plan";
import { figuresOutput } from "../testing";
import { scenario } from "./__fixtures__/environment";
import { runAdvise } from "./run";

describe("advise --env <preview>", () => {
  it("reads the preview server as any, without the app's services or a hostname", async () => {
    const plan = previewTestPlan();
    const s = await scenario({
      plan,
      host: { figures: figuresOutput(plan.app.name, { containers: [] }) },
      init: { environment: "preview" },
    });
    const report = await runAdvise(s.deps, s.plan, s.options);

    expect(report.checked).toEqual(
      expect.arrayContaining(["server app's figures", "secure's host checks on server app"]),
    );
    expect(report.notRead.filter((line) => line.startsWith("server app"))).toEqual([]);
    // No check of a service of the environment's own app, which a preview server never runs.
    const checks = s.servers.commands.filter((c) => !c.command.includes("==opscrew-figures:"));
    expect(checks.length).toBeGreaterThan(0);
    expect(checks.some((c) => c.command.includes("project=shop-preview"))).toBe(false);
    expect(JSON.stringify(report)).not.toContain("shop.example.com");
  });
});
