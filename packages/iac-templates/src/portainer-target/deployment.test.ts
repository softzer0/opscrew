import { describe, expect, it } from "vitest";
import { testCloudflareAccount, testContext, testPlan } from "../__fixtures__/plans";
import * as templates from "../index";
import { portainerTestPlan } from "./__fixtures__/plans";

const ctx = testContext({ cloudflare: testCloudflareAccount(), acmeEmail: "ops@example.com" });

describe("renderPortainerDeployment", () => {
  it("writes the Cloudflare root, the stack template and the workflow, and nothing for a server", () => {
    const plan = portainerTestPlan({ web: { mode: "tunnel" }, redeploy: "cloudflare" });
    const files = templates.renderPortainerDeployment(plan, ctx);
    const paths = files.map((f) => f.path);
    expect(paths.filter((p) => !p.startsWith("opscrew/infra/"))).toEqual([
      "opscrew/runtime/compose.yaml",
      ".github/workflows/opscrew-deploy.yml",
    ]);
    expect(paths).toContain("opscrew/infra/prod/main.tf");
    expect(paths).toContain("opscrew/infra/modules/cloudflare-access/main.tf");
    expect(paths.some((p) => p.endsWith("Caddyfile") || p.includes("hetzner"))).toBe(false);
    expect(files.find((f) => f.path === "opscrew/runtime/compose.yaml")?.content).toBe(
      templates.renderPortainerStack(plan, ctx).content,
    );
    expect(templates.renderPortainerDeployment(plan, ctx)).toEqual(files);
  });

  it("is what renderDeployment writes for a Portainer target", () => {
    for (const plan of [
      portainerTestPlan({ web: { mode: "tunnel" }, redeploy: "cloudflare" }),
      portainerTestPlan({ web: { mode: "caddy" } }),
    ]) {
      expect(templates.renderDeployment(plan, ctx)).toEqual(
        templates.renderPortainerDeployment(plan, ctx),
      );
    }
    // Caddy mode with the updater has no Cloudflare root: only the stack and the workflow.
    expect(
      templates
        .renderDeployment(portainerTestPlan({ web: { mode: "caddy" } }), ctx)
        .map((f) => f.path),
    ).toEqual(["opscrew/runtime/compose.yaml", ".github/workflows/opscrew-deploy.yml"]);
  });

  it("the server's Compose file and Caddyfile refuse a Portainer target plainly", () => {
    const plan = portainerTestPlan();
    for (const render of [templates.renderCompose, templates.renderCaddyfile]) {
      expect(() => render(plan, ctx)).toThrow(
        expect.objectContaining({
          code: "PHASE_PRECONDITION",
          message: expect.stringContaining("has no server Compose file or Caddyfile"),
        }),
      );
    }
  });

  it("refuses a plan that does not deploy to Portainer", () => {
    expect(() => templates.renderPortainerDeployment(testPlan(), ctx)).toThrow(
      expect.objectContaining({ code: "PHASE_PRECONDITION" }),
    );
  });

  it("is exported from the package root with the other Portainer renderers", () => {
    for (const name of [
      "renderPortainerStack",
      "renderPlaceholderStack",
      "renderUpdaterStack",
      "renderPortainerConnectorStack",
      "renderPortainerDeployment",
      "fillPortainerStack",
      "portainerStackEnvKeys",
      "portainerStackVolumes",
      "portainerWebhookHostname",
      "portainerHealthUrl",
    ] as const) {
      expect(typeof (templates as Record<string, unknown>)[name], name).toBe("function");
    }
    expect(templates.PORTAINER_DEPLOY_SECRETS.webhookUrl).toBe("OPSCREW_PORTAINER_WEBHOOK_URL");
    expect(templates.PORTAINER_DEPLOY_BRANCH).toBe("opscrew-deploy");
  });
});
