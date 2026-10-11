import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { findExecutable } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { readArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { createTestPhaseDeps, ScriptedApprovalHandler } from "../testing";
import {
  createProject,
  FakeEngine,
  FakeGitHub,
  fakeCloudflare,
  HOST_KEY,
  planJsonFor,
  projectRunner,
  readyRemote,
  SERVER_IPV4,
  testPlan,
} from "./__fixtures__/fakes";
import { findSavedPlan } from "./plan-apply";
import { DEPLOY_SETUP_BRANCH } from "./publish";
import { previewDeploymentFiles } from "./render";
import { runProvision } from "./run";
import type { ProvisionServices } from "./types";

const STRIPE = fakeSecret("stripe-live-key");
const HCLOUD = fakeSecret("hcloud-token");

interface SetupOptions {
  plan?: ReturnType<typeof testPlan>;
  answer?: ConstructorParameters<typeof ScriptedApprovalHandler>[0];
  engine?: FakeEngine;
  services?: ProvisionServices;
  env?: Record<string, string | undefined>;
}

async function setup(options: SetupOptions = {}) {
  const project = await createProject(options.plan ?? testPlan());
  await writeFile(join(project.root, "production.env"), `STRIPE_SECRET_KEY=${STRIPE}\n`);
  const engine = options.engine ?? new FakeEngine();
  const github = new FakeGitHub();
  const handler = new ScriptedApprovalHandler(options.answer ?? (() => true));
  const env: Record<string, string | undefined> = {
    ...process.env,
    OPSCREW_HOME: join(project.root, ".home-opscrew"),
    HCLOUD_TOKEN: HCLOUD,
    OPSCREW_APP_ENV_FILE: "production.env",
    ...options.env,
  };
  const deps = await createTestPhaseDeps({
    root: project.root,
    env,
    runner: projectRunner(),
    approvalHandler: handler,
  });
  deps.redactor.addLiteral(HCLOUD, "HCLOUD_TOKEN");
  const services: ProvisionServices = {
    engine: async () => engine,
    hetzner: { configured: true, verify: async () => ({ ok: true, message: "ok" }) },
    github,
    tcpConnect: async () => true,
    remote: readyRemote,
    sleep: async () => undefined,
    ...options.services,
  };
  return { ...project, deps, engine, github, handler, services };
}

/** Every user-visible or persisted text a run produced. */
function everythingPrinted(deps: Awaited<ReturnType<typeof setup>>["deps"]) {
  return `${deps.reporter.text()}\n${JSON.stringify(deps.audit.entries)}`;
}

describe.skipIf(!findExecutable("git"))("runProvision", () => {
  it("renders, plans, applies, waits, stores secrets, commits, pushes and opens a pull request", async () => {
    const { deps, engine, github, handler, services, root, bare, git } = await setup();
    const result = await runProvision(deps, { services });

    expect(handler.requests.map((r) => r.kind)).toEqual([
      "repo-write",
      "iac-apply",
      "github-secrets",
      "git-push",
      "pull-request",
    ]);
    expect(engine.calls).toEqual(["init", "validate", "plan", "apply"]);
    expect(engine.initOptions?.backendConfig?.path).toBe(
      join(deps.paths.files.tfstateDir, "prod.tfstate"),
    );
    expect(engine.initOptions?.env?.TF_ENCRYPTION).toContain("pbkdf2");
    expect(result).toMatchObject({
      applied: true,
      branch: DEPLOY_SETUP_BRANCH,
      prUrl: "https://github.com/acme/shop/pull/7",
    });

    for (const file of [
      "opscrew/infra/prod/main.tf",
      "opscrew/infra/modules/hetzner-vps/main.tf",
      "opscrew/runtime/compose.yaml",
      "opscrew/runtime/Caddyfile",
      ".github/workflows/opscrew-deploy.yml",
    ]) {
      await expect(readFile(join(root, file), "utf8")).resolves.toContain("OpsCrew");
    }

    const plan = await readArtifact("plan", deps.paths.files.plan);
    expect(plan.deployment).toMatchObject({
      serverIpv4: SERVER_IPV4,
      lastPlanHash: result.planHash,
      lastApplyAt: "2026-10-11T12:00:00.000Z",
      lastCompletedPhase: "provision",
    });
    expect(plan.approvals).toEqual([
      expect.objectContaining({ planHash: result.planHash, kind: "iac-apply" }),
    ]);

    expect([...github.secrets.keys()].sort()).toEqual([
      "OPSCREW_APP_ENV",
      "OPSCREW_BUILD_ENV",
      "OPSCREW_DB_ENV",
      "OPSCREW_HOST",
      "OPSCREW_SSH_KNOWN_HOSTS",
      "OPSCREW_SSH_PRIVATE_KEY",
    ]);
    expect(github.secrets.get("OPSCREW_HOST")).toBe(SERVER_IPV4);
    expect(github.secrets.get("OPSCREW_SSH_KNOWN_HOSTS")).toBe(`${SERVER_IPV4} ${HOST_KEY}\n`);
    expect(github.secrets.get("OPSCREW_APP_ENV")).toContain(`STRIPE_SECRET_KEY=${STRIPE}`);
    expect(github.secrets.get("OPSCREW_SSH_PRIVATE_KEY")).toContain("OPENSSH PRIVATE KEY");
    await expect(readFile(deps.paths.files.knownHosts, "utf8")).resolves.toContain(HOST_KEY);

    expect(github.pulls).toEqual([
      expect.objectContaining({ head: DEPLOY_SETUP_BRANCH, base: "main" }),
    ]);
    expect(github.pulls[0]?.body).toContain("Opened by OpsCrew");
    expect(await git(bare, "branch", "--list", DEPLOY_SETUP_BRANCH)).toContain(DEPLOY_SETUP_BRANCH);
    const committed = await git(root, "show", "--name-only", "--format=", "HEAD");
    expect(committed).toContain("opscrew/plan.yaml");
    expect(committed).toContain(".github/workflows/opscrew-deploy.yml");

    expect((await deps.state.read()).phases.provision?.status).toBe("ok");

    // No secret value ever reaches the reporter or the audit log
    const printed = everythingPrinted(deps);
    const secretValue = (secret: string, name: string) =>
      new RegExp(`${name}=(\\S+)`).exec(github.secrets.get(secret) ?? "")?.[1] as string;
    const dbPassword = secretValue("OPSCREW_DB_ENV", "POSTGRES_PASSWORD");
    const sessionSecret = secretValue("OPSCREW_APP_ENV", "SESSION_SECRET");
    expect(dbPassword).toHaveLength(32);
    expect(sessionSecret).toHaveLength(32);
    const keyLines = (github.secrets.get("OPSCREW_SSH_PRIVATE_KEY") as string)
      .split("\n")
      .filter((line) => line.length > 0 && !line.startsWith("-----"));
    for (const value of [STRIPE, HCLOUD, dbPassword, sessionSecret, ...keyLines]) {
      expect(printed).not.toContain(value);
    }
    expect(
      deps.audit.entries.filter((e) => e.kind === "secret-set").map((e) => e.action),
    ).toContain("set secret OPSCREW_APP_ENV");
  });

  it("keeps the database password and reuses key and host pin when run again", async () => {
    const { deps, github, services, handler } = await setup();
    await runProvision(deps, { services });
    const firstDb = github.secrets.get("OPSCREW_DB_ENV");
    const firstKey = github.secrets.get("OPSCREW_SSH_PRIVATE_KEY");
    handler.requests.length = 0;

    const second = await runProvision(deps, { services });
    expect(github.secrets.get("OPSCREW_DB_ENV")).toBe(firstDb);
    expect(github.secrets.get("OPSCREW_SSH_PRIVATE_KEY")).toBe(firstKey);
    // files are unchanged, so no repo-write; the fake engine plans the same changes again
    expect(handler.requests.map((r) => r.kind)).not.toContain("repo-write");
    expect(handler.requests.map((r) => r.kind)).not.toContain("remote-exec");
    expect(second.prUrl).toBeDefined();
  });

  it("--plan-only saves the plan; --approve applies exactly that plan or refuses", async () => {
    const { deps, engine, services, github } = await setup({
      answer: (request) => request.kind !== "iac-apply" || request.planHash === approved,
    });
    let approved = "";
    const planned = await runProvision(deps, { services, planOnly: true });
    expect(planned.applied).toBe(false);
    expect(planned.planHash).toMatch(/^[0-9a-f]{64}$/);
    expect(engine.calls).toEqual(["init", "validate", "plan"]);
    expect(github.secrets.size).toBe(0);
    expect(deps.reporter.text()).toContain(`opscrew provision --approve ${planned.planHash}`);
    const saved = await findSavedPlan(deps.paths.files.plansDir, planned.planHash as string);
    expect(saved?.planHash).toBe(planned.planHash);

    await expect(
      runProvision(deps, { services, approvePlanHash: "0".repeat(64) }),
    ).rejects.toMatchObject({ code: "PLAN_HASH_MISMATCH" });

    approved = planned.planHash as string;
    const applied = await runProvision(deps, { services, approvePlanHash: approved });
    expect(applied).toMatchObject({ applied: true, planHash: approved });
    expect(engine.calls).toEqual(["init", "validate", "plan", "apply"]);
    expect(engine.applied[0]?.planFile).toBe(saved?.planFile);
  });

  it("stops before approval when a security policy fails", async () => {
    const engine = new FakeEngine({ planJson: planJsonFor({ openDatabasePort: true }) });
    const { deps, handler, services } = await setup({ engine });
    await expect(runProvision(deps, { services })).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      message: expect.stringContaining("security"),
    });
    expect(handler.requests.map((r) => r.kind)).toEqual(["repo-write"]);
    expect(engine.calls).not.toContain("apply");
    expect((await deps.state.read()).phases.provision?.status).toBe("failed");
  });

  it("requires the typed server name to approve a plan that destroys something", async () => {
    const replace = {
      address: "module.server.hcloud_server.this",
      type: "hcloud_server",
      name: "this",
      provider: "registry.opentofu.org/hetznercloud/hcloud",
      action: "replace" as const,
    };
    const wrong = await setup({
      engine: new FakeEngine({ changes: [replace] }),
      answer: (request) =>
        request.kind === "iac-apply" ? { approved: true, confirmation: "yes" } : true,
    });
    await expect(runProvision(wrong.deps, { services: wrong.services })).rejects.toMatchObject({
      code: "APPROVAL_REFUSED",
    });
    expect(wrong.engine.calls).not.toContain("apply");
    const asked = wrong.handler.requests.find((r) => r.kind === "iac-apply");
    expect(asked).toMatchObject({ allowDestroy: true, confirmPhrase: "shop" });

    const right = await setup({ engine: new FakeEngine({ changes: [replace] }) });
    await runProvision(right.deps, { services: right.services });
    expect(right.engine.applied[0]?.approval).toMatchObject({ allowDestroy: true });
  });

  it("explains which token is missing and where to create it", async () => {
    const { deps, services } = await setup({ env: { HCLOUD_TOKEN: undefined } });
    const { hetzner: _ignored, ...withoutHetzner } = services;
    await expect(runProvision(deps, { services: withoutHetzner })).rejects.toMatchObject({
      code: "CREDENTIALS_MISSING",
      message: expect.stringContaining("HCLOUD_TOKEN"),
      hint: expect.stringContaining("https://console.hetzner.cloud/"),
    });
  });

  it("refuses when the Dockerfile is not committed", async () => {
    const { deps, services, git, root } = await setup();
    await git(root, "rm", "-q", "Dockerfile");
    await git(root, "commit", "-q", "-m", "drop dockerfile");
    await expect(runProvision(deps, { services })).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      hint: expect.stringContaining("opscrew adapt"),
    });
  });

  it("does not manage Cloudflare rule phases the zone already uses", async () => {
    const { deps, services, root } = await setup({
      plan: testPlan({ domain: "shop.example.com" }),
      engine: new FakeEngine({ planJson: planJsonFor({ proxied: true }) }),
      services: { cloudflare: fakeCloudflare({ configRules: true, wafRules: true }) },
    });
    await runProvision(deps, { services });
    const tfvars = JSON.parse(
      await readFile(join(root, "opscrew/infra/prod/terraform.tfvars.json"), "utf8"),
    );
    expect(tfvars).toMatchObject({ manage_config_rule: false, manage_waf_rules: false });
    expect(deps.reporter.text()).toContain("already has its own configuration rules");
    expect(deps.reporter.text()).toContain("already has its own WAF custom rules");
    const plan = await readArtifact("plan", deps.paths.files.plan);
    expect(plan.dns.zone).toBe("example.com");
  });

  it("stops when the Cloudflare zone is not visible to the token", async () => {
    const { deps, services } = await setup({
      plan: testPlan({ domain: "shop.example.com" }),
      services: { cloudflare: fakeCloudflare({ zone: false }) },
    });
    await expect(runProvision(deps, { services })).rejects.toMatchObject({
      code: "CREDENTIALS_INVALID",
      hint: expect.stringContaining("DNS → Edit"),
    });
  });

  it("keeps the commit local when the push is refused", async () => {
    const { deps, services, github, git, root, bare } = await setup({
      answer: (request) => request.kind !== "git-push",
    });
    const result = await runProvision(deps, { services });
    expect(result.prUrl).toBeUndefined();
    expect(github.pulls).toEqual([]);
    expect(await git(root, "rev-parse", "--abbrev-ref", "HEAD")).toBe(DEPLOY_SETUP_BRANCH);
    expect(await git(bare, "branch", "--list", DEPLOY_SETUP_BRANCH)).toBe("");
    expect(deps.reporter.text()).toContain("Not pushed");
  });

  it("refuses to continue when the server's host key changed", async () => {
    const { deps, services, github, handler } = await setup({
      answer: (request) => request.kind !== "remote-exec",
    });
    await mkdir(deps.paths.projectHomeDir, { recursive: true });
    await writeFile(
      deps.paths.files.knownHosts,
      `${SERVER_IPV4} ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOldKeyOldKeyOldKeyOldKeyOldKey\n`,
    );
    await expect(runProvision(deps, { services })).rejects.toMatchObject({
      code: "APPROVAL_REFUSED",
      message: expect.stringContaining("host key"),
    });
    expect(handler.requests.map((r) => r.kind)).toContain("remote-exec");
    expect(github.secrets.size).toBe(0);
  });

  it("previews the files provision would write without touching the repository", async () => {
    const { deps, services, root, git } = await setup({
      plan: testPlan({ domain: "shop.example.com" }),
      services: { cloudflare: fakeCloudflare() },
    });
    const status = () => git(root, "status", "--porcelain", "--", ".", ":!.home-opscrew");
    const before = await status();
    const preview = await previewDeploymentFiles(deps, { services });
    expect(preview.created).toContain("opscrew/infra/prod/main.tf");
    expect(preview.created).toContain(".github/workflows/opscrew-deploy.yml");
    expect(preview.changed).toEqual([]);
    expect(preview.plan.dns.zone).toBe("example.com");
    expect(await status()).toBe(before);
    expect((await deps.state.read()).phases.provision).toBeUndefined();

    await runProvision(deps, { services });
    const after = await previewDeploymentFiles(deps, { services });
    expect(after.created).toEqual([]);
    expect(after.unchanged).toContain("opscrew/runtime/Caddyfile");
  });

  it("reports a failed apply with the engine's message", async () => {
    const { deps, services } = await setup({ engine: new FakeEngine({ applyOk: false }) });
    await expect(runProvision(deps, { services })).rejects.toMatchObject({
      code: "ENGINE_FAILED",
      message: expect.stringContaining("server type unavailable"),
    });
  });
});
