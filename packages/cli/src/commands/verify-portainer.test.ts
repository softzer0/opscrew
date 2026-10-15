import type { DeployPlan } from "@opscrew/plan-schema";
import { afterEach, describe, expect, it } from "vitest";
import { CF_V4, CF_V6, DeployRunner, fakeSite, writeProjectPlan } from "../ui/__fixtures__/deploy";
import { projectContext, run, type TempProject, tempProject } from "../ui/__fixtures__/harness";
import {
  PORTAINER_HOST,
  PORTAINER_URL,
  portainerTestPlan,
  recordPortainer,
} from "../ui/__fixtures__/portainer";
import { withDeployServices } from "../ui/deploy-services";

let project: TempProject | undefined;
afterEach(async () => {
  await project?.cleanup();
  project = undefined;
});

async function setup(plan: DeployPlan) {
  project = await tempProject();
  await writeProjectPlan(project, plan);
  await recordPortainer(project);
  const ctx = projectContext(project, {
    services: { runner: new DeployRunner(), fetch: fakeSite() },
  });
  withDeployServices(ctx, {
    verify: {
      resolver: {
        resolve4: async () => ["198.51.100.7"],
        resolve6: async () => [],
      },
      tlsConnect: async () => ({
        subjectCommonName: "shop.example.com",
        subjectAltNames: ["shop.example.com"],
        validFrom: "2026-09-20T00:00:00.000Z",
        validTo: "2026-12-19T00:00:00.000Z",
        issuer: "Let's Encrypt",
      }),
      tcpConnect: async () => false,
      cloudflareRanges: { ipv4: CF_V4, ipv6: CF_V6 },
      timeoutMs: 1000,
    },
  });
  return ctx;
}

describe("opscrew verify for the user's Portainer", () => {
  it("checks the route given with --url behind the user's own reverse proxy", async () => {
    const ctx = await setup(
      portainerTestPlan({ web: { mode: "proxy", port: 8080 }, domain: null, deployed: true }),
    );
    expect(await run(ctx, "verify", "--url", "https://shop.example.com/"), ctx.errors).toBe(0);
    expect(ctx.output).toContain("https://shop.example.com is live and healthy");
    expect(ctx.output).toContain("run `opscrew secure` to check the app's stack");
    expect(`${ctx.output}${ctx.errors}`).not.toContain(PORTAINER_HOST);
  });

  it("refuses --url when the app is served through its domain", async () => {
    const ctx = await setup(portainerTestPlan({ deployed: true }));
    expect(await run(ctx, "verify", "--url", "https://shop.example.com")).toBe(2);
    expect(ctx.errors).toContain("only for an app in your Portainer behind your own reverse proxy");
  });

  it("never shows Portainer's address, even inside the route the user gave", async () => {
    const ctx = await setup(
      portainerTestPlan({ web: { mode: "proxy", port: 8080 }, domain: null, deployed: true }),
    );
    await run(ctx, "verify", "--url", `${PORTAINER_URL.replace(":9443", ":8080")}/`);
    expect(`${ctx.output}${ctx.errors}`).not.toContain(PORTAINER_HOST);
  });
});
