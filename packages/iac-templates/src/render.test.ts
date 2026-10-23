import { DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { testCloudflareAccount } from "./__fixtures__/plans";
import { withServices } from "./catalog/__fixtures__/plans";
import { renderInfra } from "./infra";
import { renderDeployment } from "./render";
import { renderRuntimeFiles } from "./runtime";
import { cloudflarePlan, pagesPlan, ssrPlan } from "./serverless/__fixtures__/plans";
import type { RenderContext } from "./types";
import { renderWorkflow } from "./workflow";

const ctx: RenderContext = {
  opscrewVersion: "0.1.0",
  github: { owner: "acme", repo: "shop" },
  deploySshPublicKey: "ssh-ed25519 AAAA opscrew-deploy",
};

describe("renderDeployment", () => {
  it("writes the services' settings files, the crontab and the edge next to compose.yaml, then the app's site", () => {
    const base = withServices([{ kind: "mysql" }, { kind: "rabbitmq" }]);
    const plan = DeployPlanSchema.parse({
      ...base,
      processes: {
        workers: [],
        cron: [{ name: "cleanup", schedule: "0 3 * * *", command: "node cleanup.js" }],
      },
    });
    const paths = renderDeployment(plan, ctx).map((file) => file.path);
    const runtime = renderRuntimeFiles(plan).map((file) => file.path);
    expect(runtime).toEqual([
      "opscrew/runtime/services/mysql/my.cnf",
      "opscrew/runtime/services/rabbitmq/rabbitmq.conf",
      "opscrew/runtime/crontab",
      "opscrew/runtime/edge/compose.yaml",
    ]);
    const compose = paths.indexOf("opscrew/runtime/compose.yaml");
    expect(paths.slice(compose + 1, compose + 2 + runtime.length)).toEqual([
      ...runtime,
      "opscrew/runtime/edge/sites/shop.caddy",
    ]);
  });

  it("renders a server-less plan's infrastructure, its Cloudflare files and its workflow", () => {
    const serverless = { ...ctx, cloudflare: testCloudflareAccount() };
    for (const [plan, files] of [
      [cloudflarePlan(), ["opscrew/cloudflare/wrangler.jsonc"]],
      [ssrPlan(), ["opscrew/cloudflare/wrangler.jsonc", "opscrew/cloudflare/headers-entry.js"]],
      [pagesPlan(), []],
    ] as const) {
      const rendered = renderDeployment(plan, serverless);
      const infra = renderInfra(plan, serverless);
      expect(infra.length).toBeGreaterThan(0);
      expect(rendered.slice(0, infra.length)).toEqual(infra);
      expect(rendered.slice(infra.length).map((file) => file.path)).toEqual([
        ...files,
        ".github/workflows/opscrew-deploy.yml",
      ]);
      expect(rendered.at(-1)).toEqual(renderWorkflow(plan, serverless));
    }
  });
});
