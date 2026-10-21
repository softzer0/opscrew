import { readFile } from "node:fs/promises";
import type { RegisteredDomain } from "@opscrew/contracts";
import { writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { createTestPhaseDeps, testPlan } from "../testing";
import { readProjectFiles, recordDomain } from "./project";

const INFO: RegisteredDomain = {
  domain: "example.com",
  registrar: "cloudflare",
  createdAt: "2026-10-01T09:00:00.000Z",
  expiresAt: "2027-10-01T09:00:00.000Z",
  autoRenew: true,
  privacy: true,
};

describe("recordDomain", () => {
  it("leaves plan.yaml byte-identical when it already records the same domain", async () => {
    let now = Date.parse("2026-10-21T08:00:00.000Z");
    const deps = await createTestPhaseDeps({ clock: { now: () => new Date(now) } });
    await writeArtifact("plan", deps.paths.files.plan, testPlan());
    const record = async () =>
      recordDomain(deps, await readProjectFiles(deps), {
        domain: "example.com",
        hostname: "shop.example.com",
        info: INFO,
        dnssec: true,
      });
    await record();
    const first = await readFile(deps.paths.files.plan, "utf8");
    expect(first).toContain("updatedAt: 2026-10-21T08:00:00.000Z");

    // An hour later: a plan written again would carry a new updatedAt.
    now += 3_600_000;
    expect(await record()).toEqual({ plan: true, requirements: false });
    expect(await readFile(deps.paths.files.plan, "utf8")).toBe(first);
  });
});
