import { readFile } from "node:fs/promises";
import path from "node:path";
import { type DeployPlan, readArtifact } from "@opscrew/plan-schema";
import { afterEach, describe, expect, it } from "vitest";
import {
  CF_V4,
  CF_V6,
  CLOUDFLARE_IPV4,
  CLOUDFLARE_IPV6,
  DeployRunner,
  fakeSite,
  SERVER_IPV4,
  testPlan,
  writeProjectPlan,
} from "../ui/__fixtures__/deploy";
import { projectContext, run, type TempProject, tempProject } from "../ui/__fixtures__/harness";
import { withDeployServices } from "../ui/deploy-services";

let project: TempProject | undefined;
afterEach(async () => {
  await project?.cleanup();
  project = undefined;
});

async function setup(plan: DeployPlan, options: { healthStatus?: number } = {}) {
  project = await tempProject();
  const planFile = await writeProjectPlan(project, plan);
  const ctx = projectContext(project, {
    services: { runner: new DeployRunner(), fetch: fakeSite(options) },
  });
  withDeployServices(ctx, {
    verify: {
      resolver: {
        resolve4: async () => [CLOUDFLARE_IPV4],
        resolve6: async () => [CLOUDFLARE_IPV6],
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
  return { ctx, root: project.root, planFile };
}

const live = () => testPlan({ domain: "shop.example.com", deployed: true });

describe("opscrew verify", () => {
  it("passes for a healthy deployment, writes the runbook and exits 0", async () => {
    const { ctx, root, planFile } = await setup(live());
    expect(await run(ctx, "verify")).toBe(0);

    expect(ctx.output).toContain("https://shop.example.com is live and healthy");
    expect(ctx.output).toContain("read opscrew/RUNBOOK.md");
    const runbook = await readFile(path.join(root, "opscrew", "RUNBOOK.md"), "utf8");
    expect(runbook).toContain("shop.example.com");
    // Behind Cloudflare's proxy, neither committed file names the server's address.
    expect(runbook).not.toContain(SERVER_IPV4);
    expect(runbook).toContain("deploy@$(opscrew status --ip)");
    expect(await readFile(planFile, "utf8")).not.toContain(SERVER_IPV4);
    const plan = await readArtifact("plan", planFile);
    expect(plan.deployment.url).toBe("https://shop.example.com");
  });

  it("exits 1 when the health endpoint fails", async () => {
    const { ctx } = await setup(live(), { healthStatus: 500 });
    expect(await run(ctx, "verify")).toBe(1);
    expect(ctx.errors).toContain("Verification found problems");
    expect(ctx.output).toContain("run `opscrew verify` again");
  });

  it("exits 1 with the next step when nothing is provisioned yet", async () => {
    const { ctx } = await setup(testPlan());
    expect(await run(ctx, "verify")).toBe(1);
    expect(ctx.errors).toContain("does not know the server's address");
    expect(ctx.errors).toContain("opscrew provision");
  });
});
