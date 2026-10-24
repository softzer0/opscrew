/**
 * Plans of a site on the server-less targets (feature 016) for the CLI tests: a deployed static
 * site of `example-app` at `docs.example.com`. For tests only.
 */
import path from "node:path";
import { testPlan } from "@opscrew/agents/testing";
import { type DeployPlan, DeployPlanSchema, writeArtifact } from "@opscrew/plan-schema";
import type { TempProject } from "./harness";

/** Cloudflare's hosting or GitHub Pages. */
export type SiteProvider = "cloudflare-workers" | "github-pages";

/** A deployed static site of `example-app` at `docs.example.com` on `provider`. */
export function sitePlan(provider: SiteProvider): DeployPlan {
  const site = { tool: "none", outputDir: "site" } as const;
  return DeployPlanSchema.parse({
    ...testPlan({ deployed: true }),
    app: { ...testPlan().app, name: "example-app", env: [] },
    target:
      provider === "github-pages"
        ? { provider, mode: "pages-workflow", site }
        : {
            provider,
            mode: "workers-assets",
            worker: "example-app",
            render: "static",
            notFound: "404-page",
            site,
          },
    services: [],
    dns: {
      provider: "cloudflare",
      domain: "docs.example.com",
      proxied: provider === "cloudflare-workers",
    },
    security: { wafCustomRules: provider === "cloudflare-workers" },
  });
}

/** Writes {@link sitePlan} as the project's `opscrew/plan.yaml`. */
export async function writeSitePlan(project: TempProject, provider: SiteProvider): Promise<void> {
  await writeArtifact("plan", path.join(project.root, "opscrew", "plan.yaml"), sitePlan(provider));
}
