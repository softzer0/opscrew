import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FAKE_ZONE_ID, FakeZone } from "@opscrew/connector-cloudflare/testing";
import { findExecutable } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { readArtifact, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { DEPLOY_SETUP_BRANCH } from "../provision/publish";
import { ADDRESS_MAY_BE_PUBLIC_NOTE, runProvision } from "../provision/run";
import type { ProvisionServices } from "../provision/types";
import {
  createProject,
  createTestPhaseDeps,
  FakeEngine,
  FakeGitHub,
  fakeCloudflare,
  fakeSharedCloudflare,
  movingPlan,
  planJsonFor,
  projectRunner,
  readyRemote,
  ScriptedApprovalHandler,
  testPlan,
} from "../testing";
import { runDns } from "./run";

const WAF = "http_request_firewall_custom";
const CONFIG = "http_config_settings";

/** The pull request an earlier run opened, while it is still open. */
const OPEN_PULL = { number: 7, url: "https://github.com/acme/shop/pull/7" };

type Git = (cwd: string, ...args: string[]) => Promise<string>;

/**
 * GitHub merges the deploy pull request (a merge commit, or a squash commit with `squash`) and
 * deletes its branch; unless `stay`, this clone checks out `main` and pulls. Returns main's tip.
 */
async function mergedOnGitHub(
  git: Git,
  root: string,
  bare: string,
  options: { squash?: boolean; stay?: boolean } = {},
): Promise<string> {
  const head = await git(root, "rev-parse", DEPLOY_SETUP_BRANCH);
  const main = await git(root, "rev-parse", "main");
  const tip = options.squash
    ? await git(root, "commit-tree", `${head}^{tree}`, "-p", main, "-m", "Deployment (#7)")
    : head;
  await git(root, "push", "-q", "origin", `${tip}:refs/heads/main`);
  await git(bare, "update-ref", "-d", `refs/heads/${DEPLOY_SETUP_BRANCH}`);
  if (!options.stay) {
    await git(root, "checkout", "-q", "main");
    await git(root, "pull", "-q", "--ff-only", bare, "main");
  }
  return tip;
}

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
  const zone = new FakeZone();
  const services: ProvisionServices = {
    engine: async () => engine,
    provider: { configured: true, verify: async () => ({ ok: true, message: "ok" }) },
    cloudflare: fakeCloudflare(),
    github,
    tcpConnect: async () => true,
    remote: readyRemote,
    sleep: async () => undefined,
    sharedCloudflare: fakeSharedCloudflare(zone),
  };
  return { ...project, deps, handler, github, engine, services, zone };
}

describe.skipIf(!findExecutable("git"))("runDns", () => {
  it("moves the app behind a Cloudflare domain through the same approved plan", async () => {
    const { deps, handler, github, services, root, zone } = await setup();
    await writeArtifact("requirements", deps.paths.files.requirements, {
      schemaVersion: 1,
      answeredAt: "2026-10-11T09:00:00.000Z",
      expectedMonthlyUsers: "<1k",
      budgetMonthly: { amount: 20, currency: "EUR" },
      provider: "hetzner",
      region: "eu-central",
      uptime: "standard",
      dataCriticality: "important",
      dnsProvider: "none",
      keepExternalServices: {},
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
      "cloudflare-apply",
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
    // OpsCrew's shared rules in the zone now protect the domain (probe block, strict TLS).
    expect(zone.opscrewRule(WAF)?.expression).toContain('(http.host in {"shop.example.com"})');
    expect(zone.opscrewRule(CONFIG)?.expression).toBe('(http.host in {"shop.example.com"})');
    expect(result.cloudflarePlanHash).toBe(handler.requests[0]?.planHash);
    const tfvars = JSON.parse(
      await readFile(join(root, "opscrew/infra/prod/terraform.tfvars.json"), "utf8"),
    );
    expect(tfvars).not.toHaveProperty("manage_config_rule");
    expect(tfvars).not.toHaveProperty("manage_waf_rules");
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

  it("a new domain: one Cloudflare plan removes the old hostname from the shared rules and adds the new one", async () => {
    const { deps, handler, services, github, zone } = await setup();
    await runDns(deps, { domain: "shop.example.com", services });
    github.openPulls.set(DEPLOY_SETUP_BRANCH, OPEN_PULL);
    handler.requests.length = 0;

    await runDns(deps, { domain: "app.example.com", services });
    const request = handler.requests.find((r) => r.kind === "cloudflare-apply");
    expect(request?.details).toContain(
      "Block probes for secrets and admin panels: add app.example.com; remove shop.example.com",
    );
    expect(request?.details).toContain(
      "Verify the origin certificate (Full (strict) TLS): add app.example.com; remove shop.example.com",
    );
    // Nothing is deleted, so no typed confirmation.
    expect(request?.allowDestroy).toBeUndefined();
    expect(zone.opscrewRule(CONFIG)?.expression).toBe('(http.host in {"app.example.com"})');
    expect(zone.opscrewRule(WAF)?.expression).toContain('(http.host in {"app.example.com"})');
    expect(JSON.parse(await readFile(deps.paths.files.cloudflareRecord, "utf8"))).toEqual({
      zoneId: FAKE_ZONE_ID,
      hostnames: {
        "opscrew-block-probes": ["app.example.com"],
        "opscrew-strict-tls": ["app.example.com"],
      },
      createdEntrypoints: [WAF, CONFIG],
    });
  });

  it("says the deploy secrets are stored when provision stored them for this server", async () => {
    const { deps, handler, github, services, git, root, bare } = await setup({ deployed: false });
    await runProvision(deps, { services });
    expect(github.secrets.size).toBeGreaterThan(0);
    handler.requests.length = 0;
    // The pull request was merged; this clone is back on the updated main.
    await mergedOnGitHub(git, root, bare);

    await runDns(deps, { domain: "shop.example.com", services });
    expect(handler.requests.map((r) => r.kind)).not.toContain("github-secrets");
    expect(github.pulls[1]?.body).toContain("the deploy secrets are stored in GitHub Actions");
    expect(deps.reporter.text()).toContain("until the pull request with the new Caddyfile");
  });

  it("does not warn when the domain and proxying stay the same", async () => {
    const { deps, services, github } = await setup();
    await runDns(deps, { domain: "shop.example.com", services });
    // The first run's pull request is still open, so the second run adds to it.
    github.openPulls.set(DEPLOY_SETUP_BRANCH, OPEN_PULL);
    const plan = await readArtifact("plan", deps.paths.files.plan);
    // The fake engine reports a URL on the server's IP, which is never committed.
    expect(plan.deployment.url).toBeUndefined();
    expect(await readFile(deps.paths.files.plan, "utf8")).not.toContain("203.0.113.10");
    // the real engine reports the domain URL once the DNS module is applied
    await writeArtifact("plan", deps.paths.files.plan, {
      ...plan,
      deployment: { ...plan.deployment, url: "https://shop.example.com" },
    });
    const before = deps.reporter.text().length;
    await runDns(deps, { services });
    expect(deps.reporter.text().slice(before)).not.toContain("new Caddyfile");
  });

  it("keeps a bought domain's registration only while the new name is inside it", async () => {
    const registration = {
      registrar: "cloudflare" as const,
      expiresAt: "2027-10-11T12:00:05.000Z",
      autoRenew: true,
      privacy: true,
      dnssec: true,
    };
    const { deps, services, github } = await setup();
    const plan = await readArtifact("plan", deps.paths.files.plan);
    const bought = {
      ...plan,
      dns: {
        ...plan.dns,
        provider: "cloudflare" as const,
        domain: "shop.example.com",
        zone: "example.com",
        proxied: true,
        registration,
      },
      security: { ...plan.security, httpAllowedFrom: "cloudflare" as const },
    };
    await writeArtifact("plan", deps.paths.files.plan, bought);

    // another name inside the registered domain: the registration still describes it
    await runDns(deps, { domain: "www.example.com", services });
    const inside = await readArtifact("plan", deps.paths.files.plan);
    expect(inside.dns).toMatchObject({ domain: "www.example.com", zone: "example.com" });
    expect(inside.dns.registration).toEqual(registration);

    // another domain: the registration would describe the old one, so it goes
    github.openPulls.set(DEPLOY_SETUP_BRANCH, OPEN_PULL);
    await writeArtifact("plan", deps.paths.files.plan, bought);
    await runDns(deps, { domain: "other.org", services }).catch(() => undefined);
    const other = await readArtifact("plan", deps.paths.files.plan);
    expect(other.dns.domain).toBe("other.org");
    expect(other.dns.registration).toBeUndefined();
  });

  it("asks for a domain when the plan has none and rejects invalid names", async () => {
    const { deps, services } = await setup();
    await expect(runDns(deps, { services })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      runDns(deps, { domain: "https://shop.example.com/", services }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("stops before changing the plan or the requirements while a move is in progress", async () => {
    const { deps, handler, engine, services } = await setup();
    await writeArtifact("plan", deps.paths.files.plan, movingPlan());
    const before = await readFile(deps.paths.files.plan, "utf8");
    await expect(runDns(deps, { domain: "shop.example.com", services })).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      message: "A move to DigitalOcean is in progress.",
      hint: expect.stringContaining("`opscrew retarget --abort` before it"),
    });
    expect(await readFile(deps.paths.files.plan, "utf8")).toBe(before);
    expect(engine.calls).toEqual([]);
    expect(handler.requests).toEqual([]);
    expect(deps.reporter.lines).toEqual([]);
    expect((await deps.state.read()).phases.dns).toBeUndefined();
  });

  it("never commits on a deploy branch GitHub deleted after squash-merging it", async () => {
    const { deps, handler, github, engine, services, git, root, bare } = await setup({
      deployed: false,
    });
    await git(root, "push", "-q", "origin", "main");
    await runProvision(deps, { services });
    // Squash-merged and deleted on GitHub; this clone is still on the old deploy branch.
    const squash = await mergedOnGitHub(git, root, bare, { squash: true, stay: true });
    const before = await readFile(deps.paths.files.plan, "utf8");
    const calls = engine.calls.length;
    handler.requests.length = 0;
    const printed = deps.reporter.text().length;

    const error = await runDns(deps, { domain: "shop.example.com", services }).catch(
      (e: unknown) => e,
    );

    expect(error).toMatchObject({
      code: "PHASE_PRECONDITION",
      message: `This clone is on ${DEPLOY_SETUP_BRANCH}, an earlier OpsCrew branch without the latest main from GitHub (its pull request was probably merged), so OpsCrew did not change anything.`,
      hint: "Run `git checkout main && git pull`, then run `opscrew dns` again.",
    });
    expect(await readFile(deps.paths.files.plan, "utf8")).toBe(before);
    expect(engine.calls).toHaveLength(calls);
    expect(handler.requests).toEqual([]);
    expect(await git(root, "status", "--porcelain")).not.toMatch(/ (?:opscrew|\.github)\//);
    expect(github.pulls).toHaveLength(1);
    expect(deps.reporter.text().slice(printed)).not.toContain(ADDRESS_MAY_BE_PUBLIC_NOTE);

    // As the hint says: the new branch starts from the squash commit, so its pull request holds
    // only this run's changes.
    await git(root, "checkout", "-q", "main");
    await git(root, "pull", "-q", "--ff-only", bare, "main");
    const result = await runDns(deps, { domain: "shop.example.com", services });
    const branch = `${DEPLOY_SETUP_BRANCH}-2`;
    expect(result.branch).toBe(branch);
    expect(await git(root, "rev-parse", `${branch}^`)).toBe(squash);
    expect(await git(root, "rev-parse", DEPLOY_SETUP_BRANCH)).not.toBe(squash);
    expect(github.pulls.map((p) => p.head)).toEqual([DEPLOY_SETUP_BRANCH, branch]);
  });

  it("says once that the address may already be public when the proxy goes on", async () => {
    // Deployed without a domain: the app was served on the server's address.
    const { deps, services, github } = await setup();
    await runDns(deps, { domain: "shop.example.com", services });
    const text = deps.reporter.text();
    expect(text.split(ADDRESS_MAY_BE_PUBLIC_NOTE)).toHaveLength(2);
    expect(ADDRESS_MAY_BE_PUBLIC_NOTE).toContain("only a new server gets a fresh, private address");
    expect(ADDRESS_MAY_BE_PUBLIC_NOTE).toContain("opscrew retarget");

    // Already behind the proxy: nothing more to say.
    github.openPulls.set(DEPLOY_SETUP_BRANCH, OPEN_PULL);
    await runDns(deps, { domain: "shop.example.com", services });
    expect(deps.reporter.text().slice(text.length)).not.toContain(ADDRESS_MAY_BE_PUBLIC_NOTE);
  });

  it("does not say it for a deployment that was never served", async () => {
    const { deps, services } = await setup({ deployed: false });
    await runDns(deps, { domain: "shop.example.com", services });
    expect(deps.reporter.text()).not.toContain(ADDRESS_MAY_BE_PUBLIC_NOTE);
  });
});
