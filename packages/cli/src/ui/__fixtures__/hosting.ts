/**
 * The plan of an app on a hosting account (feature 027) for the CLI tests: a deployed static site
 * of `example-app` at `notes.example.com` on a cPanel account. For tests only.
 */
import path from "node:path";
import { testPlan } from "@opscrew/agents/testing";
import { type DeployPlan, DeployPlanSchema, writeArtifact } from "@opscrew/plan-schema";
import type { TempProject } from "./harness";

/** The app's hostname on the account, which a deletion is confirmed with. */
export const HOSTING_HOSTNAME = "notes.example.com";

/** A deployed static site of `example-app` at {@link HOSTING_HOSTNAME} on a cPanel account. */
export function hostingPlan(): DeployPlan {
  return DeployPlanSchema.parse({
    ...testPlan({ deployed: true }),
    app: { ...testPlan().app, name: "example-app", env: [] },
    target: {
      provider: "hosting",
      panel: "cpanel",
      app: "static",
      webRoot: ".",
      site: { tool: "none", outputDir: "site" },
      cron: [],
    },
    services: [],
    dns: { provider: "none", domain: HOSTING_HOSTNAME, proxied: false },
    security: { wafCustomRules: false },
  });
}

/** Writes {@link hostingPlan} as the project's `opscrew/plan.yaml`. */
export async function writeHostingPlan(project: TempProject): Promise<void> {
  await writeArtifact("plan", path.join(project.root, "opscrew", "plan.yaml"), hostingPlan());
}
