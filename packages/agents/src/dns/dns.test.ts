import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { findExecutable } from "@opscrew/core";
import { readArtifact, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import {
  createProject,
  FakeEngine,
  FakeGitHub,
  fakeCloudflare,
  planJsonFor,
  projectRunner,
  readyRemote,
  testPlan,
} from "../provision/__fixtures__/fakes";
import type { ProvisionServices } from "../provision/types";
import { createTestPhaseDeps, ScriptedApprovalHandler } from "../testing";
import { runDns } from "./run";

async function setup() {
  const project = await createProject(testPlan({ deployed: true }));
  const handler = new ScriptedApprovalHandler(() => true);
  const deps = await createTestPhaseDeps({
    root: project.root,
    env: {
      ...process.env,
      OPSCREW_HOME: join(project.root, ".home-opscrew"),
      HCLOUD_TOKEN: "unused-in-tests",
    },
    runner: projectRunner(),
    approvalHandler: handler,
  });
  const github = new FakeGitHub();
  const engine = new FakeEngine({ planJson: planJsonFor({ proxied: true }) });
  const services: ProvisionServices = {
    engine: async () => engine,
    hetzner: { configured: true, verify: async () => ({ ok: true, message: "ok" }) },
    cloudflare: fakeCloudflare(),
    github,
    tcpConnect: async () => true,
    remote: readyRemote,
    sleep: async () => undefined,
  };
  return { ...project, deps, handler, github, engine, services };
}

describe.skipIf(!findExecutable("git"))("runDns", () => {
  it("moves the app behind a Cloudflare domain through the same approved plan", async () => {
    const { deps, handler, github, services, root } = await setup();
    await writeArtifact("requirements", deps.paths.files.requirements, {
      schemaVersion: 1,
      answeredAt: "2026-10-11T09:00:00.000Z",
      expectedMonthlyUsers: "<1k",
      budgetMonthly: { amount: 20, currency: "EUR" },
      region: "eu-central",
      uptime: "standard",
      dataCriticality: "important",
      dnsProvider: "none",
      keepExternalServices: [],
    });

    const result = await runDns(deps, { domain: "Shop.Example.com", services });

    const plan = await readArtifact("plan", deps.paths.files.plan);
    expect(plan.dns).toMatchObject({
      provider: "cloudflare",
      domain: "shop.example.com",
      zone: "example.com",
      proxied: true,
    });
    expect(plan.security.httpAllowedFrom).toBe("cloudflare");
    const requirements = await readArtifact("requirements", deps.paths.files.requirements);
    expect(requirements).toMatchObject({ domain: "shop.example.com", dnsProvider: "cloudflare" });

    // the server exists already, so no deploy secrets are touched
    expect(handler.requests.map((r) => r.kind)).toEqual([
      "repo-write",
      "iac-apply",
      "git-push",
      "pull-request",
    ]);
    expect(github.secrets.size).toBe(0);
    expect(result.applied).toBe(true);
    await expect(readFile(join(root, "opscrew/runtime/Caddyfile"), "utf8")).resolves.toContain(
      "shop.example.com",
    );
    const tfvars = JSON.parse(
      await readFile(join(root, "opscrew/infra/prod/terraform.tfvars.json"), "utf8"),
    );
    expect(tfvars).toMatchObject({ manage_config_rule: true, manage_waf_rules: true });
    expect((await deps.state.read()).phases.dns?.status).toBe("ok");
  });

  it("asks for a domain when the plan has none and rejects invalid names", async () => {
    const { deps, services } = await setup();
    await expect(runDns(deps, { services })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      runDns(deps, { domain: "https://shop.example.com/", services }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});
