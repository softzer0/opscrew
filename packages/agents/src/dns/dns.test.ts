import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { findExecutable } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
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
import { runProvision } from "../provision/run";
import type { ProvisionServices } from "../provision/types";
import { createTestPhaseDeps, ScriptedApprovalHandler } from "../testing";
import { runDns } from "./run";

async function setup(options: { deployed?: boolean } = {}) {
  const project = await createProject(testPlan({ deployed: options.deployed ?? true }));
  await writeFile(
    join(project.root, "production.env"),
    `STRIPE_SECRET_KEY=${fakeSecret("stripe-live-key")}\n`,
  );
  const handler = new ScriptedApprovalHandler(() => true);
  const deps = await createTestPhaseDeps({
    root: project.root,
    env: {
      ...process.env,
      OPSCREW_HOME: join(project.root, ".home-opscrew"),
      HCLOUD_TOKEN: "unused-in-tests",
      OPSCREW_APP_ENV_FILE: "production.env",
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

    // the running server is told about before anything is approved
    const warning = "until the pull request with the new Caddyfile is merged and deployed";
    expect(deps.reporter.text()).toContain(warning);
    expect(deps.reporter.text()).toContain("ports 80 and 443 accept only Cloudflare");
    const apply = handler.requests.find((r) => r.kind === "iac-apply");
    expect(apply?.details).toContain(warning);
    expect(apply?.title).toContain("Cloudflare");

    // audit entries name the phase that made them
    expect(deps.audit.entries.find((e) => e.kind === "iac")?.phase).toBe("dns");
    expect(deps.audit.entries.filter((e) => e.kind === "git").map((e) => e.phase)).toEqual([
      "dns",
      "dns",
      "dns",
    ]);

    // no record of stored deploy secrets for this server: the pull request says what to do
    const body = github.pulls[0]?.body ?? "";
    expect(body).not.toContain("the deploy secrets are stored");
    expect(body).toContain("run `opscrew provision` in a terminal");
  });

  it("says the deploy secrets are stored when provision stored them for this server", async () => {
    const { deps, handler, github, services } = await setup({ deployed: false });
    await runProvision(deps, { services });
    expect(github.secrets.size).toBeGreaterThan(0);
    handler.requests.length = 0;

    await runDns(deps, { domain: "shop.example.com", services });
    expect(handler.requests.map((r) => r.kind)).not.toContain("github-secrets");
    expect(github.pulls[1]?.body).toContain("the deploy secrets are stored in GitHub Actions");
    expect(deps.reporter.text()).toContain("until the pull request with the new Caddyfile");
  });

  it("does not warn when the domain and proxying stay the same", async () => {
    const { deps, services } = await setup();
    await runDns(deps, { domain: "shop.example.com", services });
    const plan = await readArtifact("plan", deps.paths.files.plan);
    expect(plan.deployment.url).toBe("http://203.0.113.10");
    // the fake engine reports the domain URL once the DNS module is applied
    await writeArtifact("plan", deps.paths.files.plan, {
      ...plan,
      deployment: { ...plan.deployment, url: "https://shop.example.com" },
    });
    const before = deps.reporter.text().length;
    await runDns(deps, { services });
    expect(deps.reporter.text().slice(before)).not.toContain("new Caddyfile");
  });

  it("asks for a domain when the plan has none and rejects invalid names", async () => {
    const { deps, services } = await setup();
    await expect(runDns(deps, { services })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      runDns(deps, { domain: "https://shop.example.com/", services }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});
