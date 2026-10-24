import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  CLOUDFLARE_IPV4,
  CLOUDFLARE_IPV6,
  CLOUDFLARE_RANGES,
  SERVER_IPV4,
  testPlan,
} from "@opscrew/agents/testing";
import { type DeployPlan, readArtifact, writeArtifact } from "@opscrew/plan-schema";
import { afterEach, describe, expect, it } from "vitest";
import { withServices } from "../deps";
import { DeployRunner, fakeSite, writeProjectPlan } from "../ui/__fixtures__/deploy";
import { inEnvironment, planFile } from "../ui/__fixtures__/environments";
import { projectContext, run, type TempProject, tempProject } from "../ui/__fixtures__/harness";
import { writeSitePlan } from "../ui/__fixtures__/site";

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
  withServices(ctx, {
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
      cloudflareRanges: CLOUDFLARE_RANGES,
      timeoutMs: 1000,
    },
  });
  return { ctx, root: project.root, planFile };
}

const live = () => testPlan({ domain: "shop.example.com", deployed: true, userSecret: false });

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

  it("names --env prod in its hints while the app has other environments", async () => {
    const { ctx, root } = await setup(live());
    await writeArtifact(
      "plan",
      planFile(root, "staging"),
      inEnvironment(testPlan({ userSecret: false }), "staging"),
    );
    // The site answers without its security headers.
    const site = fakeSite();
    withServices(ctx, {
      fetch: async (input, init) => {
        const response = await site(input, init);
        return String(input) === "https://shop.example.com/"
          ? new Response(await response.text(), { status: response.status })
          : response;
      },
    });
    expect(await run(ctx, "verify", "--env", "prod")).toBe(1);
    expect(ctx.errors).toContain("Fix them and run `opscrew verify --env prod` again.");
  });

  it("names --env prod in its stops while the app has other environments", async () => {
    const { ctx, root } = await setup(testPlan({ userSecret: false }));
    await writeArtifact(
      "plan",
      planFile(root, "staging"),
      inEnvironment(testPlan({ userSecret: false }), "staging"),
    );
    expect(await run(ctx, "verify", "--env", "prod")).toBe(1);
    expect(ctx.errors).toContain(
      "Run `opscrew provision --env prod` first (on this computer, it records the address), merge its pull request, then run `opscrew verify --env prod`.",
    );
    const url = projectContext(project as TempProject);
    expect(await run(url, "verify", "--env", "prod", "--url", "https://shop.example.com")).toBe(2);
    expect(url.errors).toContain("Run `opscrew verify --env prod` without it.");
  });

  it("names a site's runbook topics and its header check, never a server's", async () => {
    project = await tempProject();
    await writeSitePlan(project, "cloudflare-workers");
    const headers = {
      "strict-transport-security": "max-age=31536000; includeSubDomains",
      "x-content-type-options": "nosniff",
      "x-frame-options": "SAMEORIGIN",
      "referrer-policy": "strict-origin-when-cross-origin",
    };
    const ctx = projectContext(project, {
      services: {
        runner: new DeployRunner(),
        fetch: async () => new Response("<!doctype html><p>docs</p>", { headers }),
      },
    });
    withServices(ctx, {
      verify: {
        resolver: {
          resolve4: async () => [CLOUDFLARE_IPV4],
          resolve6: async () => [CLOUDFLARE_IPV6],
        },
        tlsConnect: async () => ({
          subjectCommonName: "docs.example.com",
          subjectAltNames: ["docs.example.com"],
          validFrom: "2026-09-20T00:00:00.000Z",
          validTo: "2026-12-19T00:00:00.000Z",
          issuer: "Google Trust Services",
        }),
        tcpConnect: async () => false,
        cloudflareRanges: CLOUDFLARE_RANGES,
        timeoutMs: 1000,
      },
    });
    expect(await run(ctx, "verify"), ctx.errors).toBe(0);
    expect(ctx.output).toContain("it explains deploys, status, rollbacks and destroy.");
    expect(ctx.output).toContain("run `opscrew secure` to check the site's security headers");
    expect(ctx.output).not.toContain("SSH access");
    expect(ctx.output).not.toContain("hardening");
  });

  it("exits 1 with the next step when nothing is provisioned yet", async () => {
    const { ctx } = await setup(testPlan({ userSecret: false }));
    expect(await run(ctx, "verify")).toBe(1);
    expect(ctx.errors).toContain("does not know the server's address");
    expect(ctx.errors).toContain("opscrew provision");
  });
});
