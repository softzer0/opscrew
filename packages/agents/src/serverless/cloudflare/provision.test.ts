import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CloudflareDnsRecord } from "@opscrew/connector-cloudflare";
import { FAKE_ACCOUNT_ID, FakeZone } from "@opscrew/connector-cloudflare/testing";
import { exists, findExecutable, OpsCrewError, tfstateFile } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { type DeployPlan, readArtifact, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { runProvision } from "../../provision/run";
import type { ProvisionServices } from "../../provision/types";
import {
  createTestPhaseDeps,
  FakeEngine,
  type FakeEngineScenario,
  FakeGitHub,
  fakeCloudflare,
  fakeSharedCloudflare,
  projectRunner,
  ScriptedApprovalHandler,
} from "../../testing";
import {
  createSiteProject,
  sitePlan,
  workerCreate,
  workerPlanJson,
} from "../../testing/serverless";

const CF_TOKEN = fakeSecret("cloudflare-token", "site-main");
const DEPLOY_TOKEN = fakeSecret("cloudflare-token", "site-deploy");
/** The app's own secret, given in its env file. */
const API_KEY = fakeSecret("stripe-live-key", "site-app");
const OPEN_PULL = { number: 7, url: "https://github.com/acme/shop/pull/7" };
const WAF = "http_request_firewall_custom";
const REDIRECT = "http_request_dynamic_redirect";

interface SetupOptions {
  plan?: DeployPlan;
  scenario?: FakeEngineScenario;
  env?: Record<string, string | undefined>;
  records?: CloudflareDnsRecord[];
  answer?: ConstructorParameters<typeof ScriptedApprovalHandler>[0];
}

/** The engine's first plan of `plan`'s root: the Worker's shell and its custom domains. */
const firstPlan = (plan: DeployPlan): FakeEngineScenario => ({
  changes: workerCreate(plan),
  planJson: workerPlanJson(plan),
  outputs: { url: `https://${plan.dns.domain}` },
});

async function setup(o: SetupOptions = {}) {
  const plan = o.plan ?? sitePlan({ env: ["API_KEY"] });
  const project = await createSiteProject(plan);
  await writeFile(join(project.root, "production.env"), `API_KEY=${API_KEY}\n`);
  // OpsCrew's own token reaches the zone and account through `sharedCloudflare`; the deploy token
  // (a client of its own) through `fetch`, here the same zone and account.
  const zone = new FakeZone();
  const engine = new FakeEngine(o.scenario ?? firstPlan(plan));
  const github = new FakeGitHub();
  const handler = new ScriptedApprovalHandler(o.answer ?? (() => true));
  const env: Record<string, string | undefined> = {
    ...process.env,
    OPSCREW_HOME: join(project.root, ".home-opscrew"),
    CLOUDFLARE_API_TOKEN: CF_TOKEN,
    OPSCREW_CLOUDFLARE_DEPLOY_TOKEN: DEPLOY_TOKEN,
    OPSCREW_APP_ENV_FILE: "production.env",
    ...o.env,
  };
  const deps = await createTestPhaseDeps({
    root: project.root,
    env,
    runner: projectRunner(),
    approvalHandler: handler,
    fetch: zone.fetch,
  });
  deps.redactor.addLiteral(CF_TOKEN, "CLOUDFLARE_API_TOKEN");
  const cloudflare = fakeCloudflare({ records: o.records ?? [] });
  const services: ProvisionServices = {
    engine: async () => engine,
    github,
    cloudflare,
    sharedCloudflare: fakeSharedCloudflare(zone),
    sleep: async () => undefined,
  };
  return { ...project, plan, deps, engine, github, handler, services, zone, cloudflare };
}

type Setup = Awaited<ReturnType<typeof setup>>;

/**
 * Every file under the project (OpsCrew's local state and home included), apart from git's objects
 * and the user's own env file, which holds the app's value.
 */
async function projectText(root: string): Promise<string> {
  const texts: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "production.env") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else texts.push(await readFile(path, "utf8"));
    }
  };
  await walk(root);
  return texts.join("\n");
}

/** Every user-visible or persisted text of a run: output, audit, approvals, pull requests, files. */
async function everything(s: Setup): Promise<string> {
  return [
    s.deps.reporter.text(),
    JSON.stringify(s.deps.audit.entries),
    JSON.stringify(s.handler.requests),
    JSON.stringify(s.github.pulls),
    JSON.stringify(s.zone.calls),
    await projectText(s.root),
  ].join("\n");
}

function expectNoSecrets(text: string): void {
  for (const secret of [CF_TOKEN, DEPLOY_TOKEN, API_KEY]) expect(text).not.toContain(secret);
}

/** The approval of each `kind` this run asked for, by its hash. */
const hashesOf = (s: Setup, kind: string) =>
  s.handler.requests.filter((r) => r.kind === kind).map((r) => r.planHash);

/** Marks the Worker as created by the first apply: in the account, with its custom domain. */
function workerCreated(s: Setup, hostnames: readonly string[]): void {
  s.zone.workers.set("example-app", { versions: [], deployments: [] });
  for (const hostname of hostnames) {
    s.zone.workerDomains.push({
      id: `domain-${hostname}`,
      hostname,
      service: "example-app",
      zone_id: "0123456789abcdef0123456789abcdef",
      zone_name: "example.com",
    });
    // The custom domain's own record, which carries no OpsCrew comment.
    s.cloudflare.state.records.push({
      id: `worker-${hostname}`,
      type: "AAAA",
      name: hostname,
      content: "100::",
      ttl: 1,
      proxied: true,
    });
  }
}

/** The state an apply leaves: the Worker's shell and its custom domain. */
async function writeWorkerState(s: Setup): Promise<void> {
  const file = tfstateFile(s.deps.paths);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(
    file,
    JSON.stringify({
      version: 4,
      resources: [
        { mode: "managed", type: "cloudflare_workers_script", name: "this", instances: [{}] },
        {
          mode: "managed",
          type: "cloudflare_workers_custom_domain",
          name: "domain",
          instances: [{}],
        },
      ],
    }),
  );
}

describe.skipIf(!findExecutable("git"))("provision on Cloudflare's hosting", () => {
  it("a static site: checks, files, the IaC plan, the shared rules, the secrets and the pull request", async () => {
    const s = await setup();
    const result = await runProvision(s.deps, { services: s.services });

    // Each change after its own approval, in order; the plans by their hashes.
    expect(s.handler.requests.map((r) => r.kind)).toEqual([
      "repo-write",
      "iac-apply",
      "cloudflare-apply",
      "github-secrets",
      "git-push",
      "pull-request",
    ]);
    expect(result.planHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.cloudflarePlanHash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashesOf(s, "iac-apply")).toEqual([result.planHash]);
    expect(hashesOf(s, "cloudflare-apply")).toEqual([result.cloudflarePlanHash]);
    expect(s.engine.calls).toEqual(["init", "validate", "plan", "apply"]);
    expect(s.engine.applied.map((a) => a.approval.approvedPlanHash)).toEqual([result.planHash]);
    expect(s.handler.requests[1]?.title).toBe(
      "Apply the infrastructure plan on Cloudflare (4 to create, 0 to update, 0 to delete, 0 to replace)",
    );
    expect(result).toMatchObject({
      applied: true,
      branch: "opscrew/deploy-setup",
      prUrl: OPEN_PULL.url,
      outputs: { url: "https://docs.example.com" },
    });

    // No Dockerfile, image or server: the Worker's root, its settings and the site's workflow.
    expect(await exists(join(s.root, "Dockerfile"))).toBe(false);
    const main = await readFile(join(s.root, "opscrew/infra/prod/main.tf"), "utf8");
    expect(main).toContain('module "worker"');
    const tfvars = JSON.parse(
      await readFile(join(s.root, "opscrew/infra/prod/terraform.tfvars.json"), "utf8"),
    );
    expect(tfvars).toMatchObject({
      cloudflare_account_id: FAKE_ACCOUNT_ID,
      worker: "example-app",
      workers_dev: false,
    });
    await expect(
      readFile(join(s.root, "opscrew/infra/modules/cloudflare-workers/main.tf"), "utf8"),
    ).resolves.toContain("cloudflare_workers_script");
    const wrangler = await readFile(join(s.root, "opscrew/cloudflare/wrangler.jsonc"), "utf8");
    expect(wrangler).toContain('"name": "example-app"');
    expect(await exists(join(s.root, "opscrew/runtime"))).toBe(false);
    const workflow = await readFile(join(s.root, ".github/workflows/opscrew-deploy.yml"), "utf8");
    expect(workflow).toContain("versions upload");
    expect(workflow).not.toContain("--secrets-file");

    // The probe block lists the Worker's hostname; there is no strict-TLS rule (no origin).
    expect(String(s.zone.opscrewRule(WAF)?.expression)).toContain('"docs.example.com"');
    expect(s.zone.entrypoints.has("http_config_settings")).toBe(false);
    expect(s.zone.calls.some((call) => call.path.includes(REDIRECT))).toBe(false);

    // The deploy secrets: the deploy token (never OpsCrew's own), the account id and the app's
    // value, all repository secrets.
    expect(Object.fromEntries(s.github.secrets)).toEqual({
      OPSCREW_CLOUDFLARE_API_TOKEN: DEPLOY_TOKEN,
      OPSCREW_CLOUDFLARE_ACCOUNT_ID: FAKE_ACCOUNT_ID,
      OPSCREW_ENV_API_KEY: API_KEY,
    });
    expect(s.github.environments.size).toBe(0);
    expect(s.handler.requests[3]?.details).toContain("OPSCREW_ENV_API_KEY");

    // The record: both plans' approvals, the apply and the domain.
    const plan = await readArtifact("plan", s.deps.paths.files.plan);
    expect(plan.deployment).toMatchObject({
      url: "https://docs.example.com",
      lastPlanHash: result.planHash,
      lastApplyAt: "2026-10-11T12:00:00.000Z",
    });
    expect(plan.approvals.map((a) => [a.kind, a.planHash])).toEqual([
      ["iac-apply", result.planHash],
      ["cloudflare-apply", result.cloudflarePlanHash],
    ]);
    expect(s.github.pulls[0]?.body).toContain("which Cloudflare serves with no server");
    const committed = await s.git(s.root, "show", "--name-only", "--format=", "HEAD");
    for (const file of [
      "opscrew/plan.yaml",
      "opscrew/infra/prod/main.tf",
      "opscrew/cloudflare/wrangler.jsonc",
      ".github/workflows/opscrew-deploy.yml",
    ]) {
      expect(committed).toContain(file);
    }
    expectNoSecrets(await everything(s));
  });

  it("a server-rendered app: the headers wrapper, and its secret only in GitHub Actions", async () => {
    const s = await setup({ plan: sitePlan({ render: "ssr", env: ["API_KEY"] }) });
    const result = await runProvision(s.deps, { services: s.services });
    expect(result.applied).toBe(true);
    expect(hashesOf(s, "iac-apply")).toEqual([result.planHash]);
    expect(hashesOf(s, "cloudflare-apply")).toEqual([result.cloudflarePlanHash]);
    const files = await readdir(join(s.root, "opscrew/cloudflare"));
    expect(files.sort()).toEqual(["headers-entry.js", "wrangler.jsonc"]);
    const workflow = await readFile(join(s.root, ".github/workflows/opscrew-deploy.yml"), "utf8");
    expect(workflow).toContain("--secrets-file");
    expect(workflow).toContain("OPSCREW_ENV_API_KEY");
    expect(s.github.secrets.get("OPSCREW_ENV_API_KEY")).toBe(API_KEY);
    expect(s.github.pulls[0]?.body).toContain("security headers to the pages the Worker renders");
    expectNoSecrets(await everything(s));
  });

  it("www: a custom domain of the Worker, and the shared redirect rule sends it to the domain", async () => {
    const plan = sitePlan({ domain: "example.com", www: true });
    const s = await setup({ plan });
    const result = await runProvision(s.deps, { services: s.services });
    const tfvars = JSON.parse(
      await readFile(join(s.root, "opscrew/infra/prod/terraform.tfvars.json"), "utf8"),
    );
    expect(tfvars).toMatchObject({ domain: "example.com", www: true });
    const rule = s.zone.opscrewRule(REDIRECT);
    expect(rule).toMatchObject({
      action: "redirect",
      expression: '(http.host in {"www.example.com"})',
    });
    expect(String(s.zone.opscrewRule(WAF)?.expression)).toContain(
      '"example.com" "www.example.com"',
    );
    const shared = s.handler.requests.find((r) => r.kind === "cloudflare-apply");
    expect(shared?.planHash).toBe(result.cloudflarePlanHash);
    expect(shared?.details).toContain("Redirect www to the domain: add www.example.com");
    const record = JSON.parse(await readFile(s.deps.paths.files.cloudflareRecord, "utf8"));
    expect(record.hostnames["opscrew-www-redirect"]).toEqual(["www.example.com"]);
  });

  it("refuses a Worker of that name another app (or the user) has, before anything changes", async () => {
    const s = await setup();
    s.zone.workers.set("example-app", { versions: [], deployments: [] });
    const error = (await runProvision(s.deps, { services: s.services }).catch(
      (e: unknown) => e,
    )) as OpsCrewError;
    expect(error).toBeInstanceOf(OpsCrewError);
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toBe(
      "Your Cloudflare account already has a Worker named example-app, and it is not this app's: OpsCrew would replace its code. Nothing was changed.",
    );
    expect(error.hint).toContain("target.worker of opscrew/plan.yaml");
    expect(s.handler.requests).toEqual([]);
    expect(s.engine.calls).toEqual([]);
    expect(await exists(join(s.root, "opscrew/infra"))).toBe(false);
  });

  it("after a rename, refuses another Worker of the new name although the state holds a Worker", async () => {
    const s = await setup();
    // The last run rendered and applied the app's old Worker, `old-app`.
    await writeWorkerState(s);
    await mkdir(join(s.root, "opscrew/infra/prod"), { recursive: true });
    await writeFile(
      join(s.root, "opscrew/infra/prod/terraform.tfvars.json"),
      `${JSON.stringify({ worker: "old-app" })}\n`,
    );
    s.zone.workers.set("example-app", { versions: [], deployments: [] });
    const error = (await runProvision(s.deps, { services: s.services }).catch(
      (e: unknown) => e,
    )) as OpsCrewError;
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toContain("already has a Worker named example-app");
    expect(s.handler.requests).toEqual([]);
    expect(s.engine.calls).toEqual([]);
  });

  it("stops before any change when the token may not read the zone's single redirect rules", async () => {
    const s = await setup({ plan: sitePlan({ domain: "example.com", www: true }) });
    s.zone.denied.add(REDIRECT);
    const error = (await runProvision(s.deps, { services: s.services }).catch(
      (e: unknown) => e,
    )) as OpsCrewError;
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toContain("OpsCrew cannot apply the Cloudflare plan");
    expect(`${error.message}\n${error.hint}`).toContain("Zone → Single Redirect → Edit");
    // No repo-write or any other approval was asked.
    expect(s.handler.requests).toEqual([]);
    expect(s.engine.calls).toEqual([]);
    expect(s.zone.writes()).toEqual([]);
  });

  it("refuses a DNS record OpsCrew did not create at the hostname, naming it", async () => {
    const s = await setup({
      records: [
        {
          id: "a-1",
          type: "A",
          name: "docs.example.com",
          content: "198.51.100.7",
          ttl: 1,
          proxied: false,
        },
      ],
    });
    const error = (await runProvision(s.deps, { services: s.services }).catch(
      (e: unknown) => e,
    )) as OpsCrewError;
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toBe(
      [
        "Cloudflare already has DNS records for docs.example.com that OpsCrew did not create:",
        "  A docs.example.com 198.51.100.7",
        "The Worker's custom domains cannot be added next to them. Nothing was changed.",
      ].join("\n"),
    );
    expect(s.handler.requests).toEqual([]);
  });

  it("names a token without the Workers permission, and a missing or shared deploy token", async () => {
    const main = await setup();
    main.zone.denied.add("workers");
    const lacks = (await runProvision(main.deps, { services: main.services }).catch(
      (e: unknown) => e,
    )) as OpsCrewError;
    expect(lacks.message).toBe(
      "CLOUDFLARE_API_TOKEN lacks Account → Workers Scripts → Edit for the account that holds example.com, and OpsCrew creates the app's Worker and its custom domains with it. Nothing was changed.",
    );

    const unset = await setup({ env: { OPSCREW_CLOUDFLARE_DEPLOY_TOKEN: undefined } });
    const missing = (await runProvision(unset.deps, { services: unset.services }).catch(
      (e: unknown) => e,
    )) as OpsCrewError;
    expect(missing.code).toBe("CREDENTIALS_MISSING");
    expect(missing.message).toContain("OPSCREW_CLOUDFLARE_DEPLOY_TOKEN is not set");
    expect(missing.hint).toContain("with only Account → Workers Scripts → Edit");

    const same = await setup({ env: { OPSCREW_CLOUDFLARE_DEPLOY_TOKEN: CF_TOKEN } });
    const shared = (await runProvision(same.deps, { services: same.services }).catch(
      (e: unknown) => e,
    )) as OpsCrewError;
    expect(shared.message).toContain("is the same token as CLOUDFLARE_API_TOKEN");
    for (const s of [main, unset, same]) {
      expect(s.handler.requests).toEqual([]);
      expectNoSecrets(await everything(s));
    }
  });

  it("names the deploy token when it lacks the Workers permission", async () => {
    const s = await setup();
    // The deploy token's own client reaches an account that refuses it.
    const refusing = new FakeZone();
    refusing.denied.add("workers");
    s.deps.fetch = refusing.fetch;
    const error = (await runProvision(s.deps, { services: s.services }).catch(
      (e: unknown) => e,
    )) as OpsCrewError;
    expect(error.message).toBe(
      "OPSCREW_CLOUDFLARE_DEPLOY_TOKEN lacks Account → Workers Scripts → Edit for the account that holds example.com, and the deploy workflow uploads each version of the Worker with it. Nothing was changed.",
    );
    expect(s.handler.requests).toEqual([]);
  });

  it("an existing deployment: a second run changes nothing; a changed setting shows in the files and the plan", async () => {
    const s = await setup();
    await runProvision(s.deps, { services: s.services });
    // What the first apply left: the Worker with its custom domain (its own DNS record) and the state.
    workerCreated(s, ["docs.example.com"]);
    await writeWorkerState(s);
    s.github.openPull = OPEN_PULL;

    const again = new FakeEngine({ changes: [], outputs: { url: "https://docs.example.com" } });
    s.handler.requests.length = 0;
    const second = await runProvision(s.deps, {
      services: { ...s.services, engine: async () => again },
    });
    expect(s.handler.requests.map((r) => r.kind)).toEqual(["github-secrets"]);
    expect(second).toMatchObject({ applied: false, published: false, prUrl: OPEN_PULL.url });
    expect(second.cloudflarePlanHash).toBeUndefined();
    expect(s.deps.reporter.text()).toContain("The infrastructure is already up to date.");
    expect(s.deps.reporter.text()).toContain(
      "OpsCrew's shared Cloudflare resources are already set up for this app; nothing in Cloudflare changes.",
    );

    // notFound lives in the Wrangler config only; workersDev in it and in the IaC plan.
    const plan = await readArtifact("plan", s.deps.paths.files.plan);
    await writeArtifact("plan", s.deps.paths.files.plan, {
      ...plan,
      target: { ...plan.target, notFound: "404-page", workersDev: true } as DeployPlan["target"],
    });
    const update = new FakeEngine({
      changes: [
        {
          address: "module.worker.cloudflare_workers_script_subdomain.this",
          type: "cloudflare_workers_script_subdomain",
          name: "this",
          provider: "registry.opentofu.org/cloudflare/cloudflare",
          action: "update",
        },
      ],
      outputs: { url: "https://docs.example.com" },
    });
    s.handler.requests.length = 0;
    const third = await runProvision(s.deps, {
      services: { ...s.services, engine: async () => update },
    });
    expect(s.handler.requests.map((r) => r.kind)).toEqual([
      "repo-write",
      "iac-apply",
      "github-secrets",
      "git-push",
    ]);
    expect(s.handler.requests[0]?.details).toContain("changed  opscrew/cloudflare/wrangler.jsonc");
    expect(s.handler.requests[0]?.details).toContain(
      "changed  opscrew/infra/prod/terraform.tfvars.json",
    );
    expect(hashesOf(s, "iac-apply")).toEqual([third.planHash]);
    expect(update.applied.map((a) => a.approval.approvedPlanHash)).toEqual([third.planHash]);
    expect((await readArtifact("plan", s.deps.paths.files.plan)).deployment.lastPlanHash).toBe(
      third.planHash,
    );
    const wrangler = await readFile(join(s.root, "opscrew/cloudflare/wrangler.jsonc"), "utf8");
    expect(wrangler).toContain('"not_found_handling": "404-page"');
    expect(wrangler).toContain('"workers_dev": true');
    const committed = await s.git(s.root, "show", "--name-only", "--format=", "HEAD");
    expect(committed).toContain("opscrew/cloudflare/wrangler.jsonc");
    expect(third.prUrl).toBe(OPEN_PULL.url);
    expectNoSecrets(await everything(s));
  });

  it("--plan-only shows both plans; --approve applies exactly them, the Cloudflare plan's hash never as the IaC plan's", async () => {
    // A deployed app whose infrastructure is up to date, with only its probe block to add.
    const s = await setup({
      plan: sitePlan({ env: ["API_KEY"] }),
      scenario: { changes: [], outputs: { url: "https://docs.example.com" } },
    });
    const shown = await runProvision(s.deps, { services: s.services, planOnly: true });
    expect(shown).toMatchObject({ applied: false, outputs: {} });
    expect(shown.cloudflarePlanHash).toMatch(/^[0-9a-f]{64}$/);
    // Only the files are written, as for servers; nothing changes at Cloudflare or GitHub.
    expect(s.handler.requests.map((r) => r.kind)).toEqual(["repo-write"]);
    expect(s.zone.writes()).toEqual([]);
    expect(s.github.secrets.size).toBe(0);

    // A script approves the Cloudflare plan by its hash, as the CLI's `--approve` handler does.
    const approved = [shown.cloudflarePlanHash as string];
    const handler = new ScriptedApprovalHandler(
      (request) => request.planHash === undefined || approved.includes(request.planHash),
    );
    const deps = await createTestPhaseDeps({
      root: s.root,
      env: s.deps.env,
      runner: projectRunner(),
      approvalHandler: handler,
      fetch: s.zone.fetch,
    });
    const result = await runProvision(deps, {
      services: s.services,
      approveHashes: approved,
    });
    expect(result.cloudflarePlanHash).toBe(shown.cloudflarePlanHash);
    expect(
      handler.requests.filter((r) => r.kind === "cloudflare-apply").map((r) => r.planHash),
    ).toEqual(approved);
    expect(handler.requests.some((r) => r.kind === "iac-apply")).toBe(false);
    expect(String(s.zone.opscrewRule(WAF)?.expression)).toContain('"docs.example.com"');
  });

  it("a promoted environment's workflow checks the build's run against its builder's workflow", async () => {
    const staging = sitePlan({ environment: "staging", domain: "staging-docs.example.com" });
    const prod = sitePlan({ promotedFrom: "staging" });
    const s = await setup({ plan: prod });
    await writeArtifact(
      "plan",
      join(s.root, "opscrew", "environments", "staging", "plan.yaml"),
      staging,
    );
    await runProvision(s.deps, { services: s.services });
    const workflow = await readFile(join(s.root, ".github/workflows/opscrew-deploy.yml"), "utf8");
    expect(workflow).toContain('BUILD_WORKFLOW: ".github/workflows/opscrew-deploy-staging.yml"');
    expect(workflow).toContain('BUILD_BRANCH: "main"');
  });
});
