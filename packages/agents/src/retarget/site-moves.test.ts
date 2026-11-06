import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { FakeZone } from "@opscrew/connector-cloudflare/testing";
import type {
  FetchLike,
  IacApplyResult,
  IacApproval,
  IacInitOptions,
  IacRunOptions,
  PlanSummary,
  ResourceChange,
} from "@opscrew/contracts";
import { exists, findExecutable, sha256Hex, tfstateFile } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { detectProject } from "@opscrew/detect";
import {
  DeployPlanSchema,
  readArtifact,
  type ServerlessProvider,
  writeArtifact,
} from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { pagesVerificationStateFile } from "../shared";
import {
  createTestPhaseDeps,
  FakeEngine,
  FakeGitHub,
  fakeCloudflare,
  fakeSharedCloudflare,
  makeRequirements,
  opscrewRecord,
  plainState,
  projectRunner,
  ScriptedApprovalHandler,
} from "../testing";
import { createPagesProject, fakeGithubPages, PAGES_REPO } from "../testing/pages";
import { sitePlan } from "../testing/serverless";
import { abortRetarget } from "./abort";
import { finishRetarget } from "./finish";
import { runRetarget } from "./run";
import type { RetargetGitHubApi, RetargetOptions, RetargetServices } from "./types";

const CF_TOKEN = fakeSecret("cloudflare-token", "site-move-main");
const DEPLOY_TOKEN = fakeSecret("cloudflare-token", "site-move-deploy");
const GITHUB_TOKEN = fakeSecret("github-token", "site-move");
/** The app's own secret, given in its env file. */
const API_KEY = fakeSecret("stripe-live-key", "site-move-app");
/** A value of GitHub's verification record, as its settings page shows one (public in DNS). */
const VERIFICATION = "a1b2c3d4e5f60718293a4b5c6d7e8f";
const DOMAIN = "docs.example.com";
const { owner, repo } = PAGES_REPO;
const PAGES_ADDRESS = `https://${owner}.github.io/${repo}/`;

/** The Worker's shell in the root's state, and its custom domain. */
const SHELL = [
  "module.worker.terraform_data.worker",
  "module.worker.cloudflare_workers_script.this",
  "module.worker.cloudflare_workers_script_subdomain.this",
];
const CUSTOM_DOMAIN = "module.worker.cloudflare_workers_custom_domain.domain[0]";
/** GitHub Pages' record for a subdomain, and GitHub's verification record (a root of its own). */
const PAGES_RECORD = "module.dns.cloudflare_dns_record.cname[0]";
const VERIFICATION_RECORD = "cloudflare_dns_record.verification";

/** What a root's `main.tf` asks for, as the engines would plan it. */
async function desiredIn(dir: string): Promise<Set<string>> {
  const main = await readFile(join(dir, "main.tf"), "utf8");
  const desired = new Set<string>();
  if (main.includes('resource "cloudflare_dns_record" "verification"')) {
    desired.add(VERIFICATION_RECORD);
  }
  if (main.includes('module "worker"')) {
    for (const address of SHELL) desired.add(address);
    if (!/custom_domains\s*=\s*false/.test(main)) desired.add(CUSTOM_DOMAIN);
  }
  if (main.includes('module "dns"')) desired.add(PAGES_RECORD);
  return desired;
}

/**
 * IaC engine fake for a site's roots: a state of resource addresses per state file (the one
 * `init` configured), plans that create what a root's `main.tf` asks for and delete what it no
 * longer has, and applies that enforce the hash and `allowDestroy` as the engines do.
 */
class SiteEngine extends FakeEngine {
  readonly states = new Map<string, Set<string>>();
  /** Each applied plan, as its changes. */
  readonly appliedPlans: string[] = [];
  readonly #roots = new Map<string, string>();
  readonly #plans = new Map<string, { state: string; desired: Set<string> }>();
  #count = 0;

  override async init(dir: string, options?: IacInitOptions): Promise<void> {
    this.calls.push("init");
    this.#roots.set(dir, options?.backendConfig?.path ?? "");
  }

  override async plan(
    dir: string,
    planFile: string,
    options: IacRunOptions & { destroy?: boolean } = {},
  ): Promise<PlanSummary> {
    this.calls.push("plan");
    const state = this.#roots.get(dir);
    if (state === undefined) throw new Error(`plan before init in ${dir}`);
    const desired = options.destroy ? new Set<string>() : await desiredIn(dir);
    const current = this.states.get(state) ?? new Set<string>();
    const change = (address: string, action: "create" | "delete"): ResourceChange => ({
      address,
      type: address.split(".").at(-2) ?? "",
      name: (address.split(".").at(-1) ?? "").replace(/\[\d+\]$/, ""),
      provider: "registry.opentofu.org/cloudflare/cloudflare",
      action,
    });
    const changes = [
      ...[...desired].filter((a) => !current.has(a)).map((a) => change(a, "create")),
      ...[...current].filter((a) => !desired.has(a)).map((a) => change(a, "delete")),
    ];
    const content = `site plan ${++this.#count}: ${changes.map((c) => `${c.action} ${c.address}`).join(", ")}`;
    await writeFile(planFile, content);
    this.#plans.set(planFile, { state, desired });
    const count = (action: string) => changes.filter((c) => c.action === action).length;
    return {
      engine: this.info,
      dir,
      planFile,
      planHash: sha256Hex(content),
      createdAt: "2026-11-06T12:00:00.000Z",
      changes,
      counts: { create: count("create"), update: 0, delete: count("delete"), replace: 0 },
      hasDestroy: count("delete") > 0,
      planJson: {
        format_version: "1.2",
        planned_values: { root_module: {} },
        resource_changes: [],
      },
    };
  }

  override async apply(
    _dir: string,
    planFile: string,
    approval: IacApproval,
  ): Promise<IacApplyResult> {
    this.calls.push("apply");
    const content = await readFile(planFile, "utf8");
    if (sha256Hex(content) !== approval.approvedPlanHash) throw new Error("plan hash mismatch");
    if (content.includes("delete ") && approval.allowDestroy !== true) {
      throw new Error("a plan that deletes needs allowDestroy");
    }
    const planned = this.#plans.get(planFile);
    if (planned === undefined) throw new Error(`no plan ${planFile}`);
    this.states.set(planned.state, planned.desired);
    this.appliedPlans.push(content.replace(/^site plan \d+: /, ""));
    return { ok: true, outputs: { url: `https://${DOMAIN}` }, log: "Apply complete!" };
  }

  override async output(): Promise<Record<string, unknown>> {
    return { url: `https://${DOMAIN}` };
  }

  override readonly stateResources = async (file: string) =>
    [...(this.states.get(file) ?? [])].sort();
}

/**
 * GitHub's API for the deploy setup, secrets and workflow runs; a run's deploy job is `deploy`
 * (on Cloudflare, a version of the Worker named after the run goes live).
 */
class SiteGitHub extends FakeGitHub implements RetargetGitHubApi {
  deploy: (runId: number) => void = () => undefined;
  async deleteBranch() {
    return "absent" as const;
  }
  async waitForWorkflowRun(_owner: string, _repo: string, options: { runId: number }) {
    this.deploy(options.runId);
    return {
      id: options.runId,
      conclusion: "success",
      htmlUrl: `https://github.com/${owner}/${repo}/actions/runs/${options.runId}`,
    };
  }
}

/** A Vite single-page app, as analyze detects it. */
const SITE_FILES: Record<string, string> = {
  "package.json": `${JSON.stringify({
    name: "example-app",
    private: true,
    type: "module",
    scripts: { build: "vite build" },
    devDependencies: { vite: "^8.3.4" },
  })}\n`,
  "package-lock.json": `${JSON.stringify({ name: "example-app", lockfileVersion: 3, packages: {} })}\n`,
  "vite.config.js": "export default {};\n",
};

/**
 * A static site of `example-app` deployed on `from` (its state, its records, its GitHub Pages site
 * or Worker), analysed, with the interview's answers, in a git project whose `origin` is GitHub.
 */
async function setup(from: ServerlessProvider) {
  const base = sitePlan({ provider: from, env: ["API_KEY"], deployed: true });
  const plan = DeployPlanSchema.parse({
    ...base,
    infra: { ...base.infra, stateEncryption: false },
  });
  const project = await createPagesProject(plan);
  const { root, git, bare } = project;
  for (const [path, content] of Object.entries(SITE_FILES)) {
    await writeFile(join(root, path), content);
  }
  await writeFile(join(root, "production.env"), `API_KEY=${API_KEY}\n`);
  const env: Record<string, string | undefined> = {
    ...process.env,
    OPSCREW_HOME: join(root, ".home-opscrew"),
    CLOUDFLARE_API_TOKEN: CF_TOKEN,
    OPSCREW_CLOUDFLARE_DEPLOY_TOKEN: DEPLOY_TOKEN,
    GITHUB_TOKEN,
    GH_TOKEN: undefined,
    OPSCREW_APP_ENV_FILE: "production.env",
  };
  const zone = new FakeZone();
  const pages = fakeGithubPages(
    from === "github-pages"
      ? { site: { buildType: "workflow", cname: DOMAIN, httpsEnforced: true } }
      : {},
  );
  /** The site addresses checked, in order. */
  const checked: string[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "api.cloudflare.com") return zone.fetch(input, init);
    if (url.hostname === "api.github.com") return pages.fetch(input, init);
    if (url.hostname === `${owner}.github.io` || url.hostname === DOMAIN) {
      checked.push(url.href);
      return new Response("<!doctype html>", { status: 200 });
    }
    throw new Error(`no route for ${url.href}`);
  };
  const engine = new SiteEngine();
  const github = new SiteGitHub();
  const cloudflare = fakeCloudflare({
    records:
      from === "github-pages"
        ? [opscrewRecord(DOMAIN, "CNAME", `${owner}.github.io`, { proxied: false })]
        : [
            {
              id: "worker-domain",
              type: "AAAA",
              name: DOMAIN,
              content: "100::",
              ttl: 1,
              proxied: true,
            },
          ],
  });
  const services: RetargetServices = {
    engine: async () => engine,
    github,
    cloudflare,
    sharedCloudflare: fakeSharedCloudflare(zone),
    sleep: async () => undefined,
  };
  /** The deps of one run (each run has its own output, audit and approvals). */
  const run = async (o: { interactive?: boolean; answer?: (kind: string) => boolean } = {}) => {
    const handler = new ScriptedApprovalHandler((request) => o.answer?.(request.kind) ?? true);
    const deps = await createTestPhaseDeps({
      root,
      env,
      runner: projectRunner(),
      approvalHandler: handler,
      fetch,
      interactive: o.interactive ?? true,
    });
    deps.redactor.addLiteral(CF_TOKEN, "CLOUDFLARE_API_TOKEN");
    deps.redactor.addLiteral(GITHUB_TOKEN, "GITHUB_TOKEN");
    runs.push({ deps, handler });
    return { deps, handler };
  };
  const runs: {
    deps: Awaited<ReturnType<typeof createTestPhaseDeps>>;
    handler: ScriptedApprovalHandler;
  }[] = [];
  const { deps } = await run();
  runs.length = 0;
  // The deployment as provision left it: its state, and the site's analysis and answers.
  const state = tfstateFile(deps.paths);
  await mkdir(dirname(state), { recursive: true });
  const live = from === "github-pages" ? [PAGES_RECORD] : [...SHELL, CUSTOM_DOMAIN];
  await writeFile(
    state,
    plainState([{ mode: "managed", type: "fake", name: "live", instances: [{}] }]),
  );
  engine.states.set(state, new Set(live));
  if (from === "github-pages") {
    engine.states.set(pagesVerificationStateFile(deps.paths), new Set([VERIFICATION_RECORD]));
  } else {
    zone.workers.set("example-app", {
      versions: [
        { id: "v0", created_on: "2026-10-23T11:00:00Z", message: `opscrew 7 ${"cd".repeat(32)}` },
      ],
      deployments: [
        {
          id: "d0",
          created_on: "2026-10-23T11:00:00Z",
          source: "wrangler",
          strategy: "percentage",
          versions: [{ version_id: "v0", percentage: 100 }],
        },
      ],
    });
  }
  const facts = await detectProject(root);
  await writeArtifact("architecture", deps.paths.files.architecture, {
    schemaVersion: 1,
    generatedAt: "2026-10-23T10:00:00.000Z",
    generator: { tool: "opscrew", version: "0.0.0-test" },
    facts,
    summary: "A site.",
    risks: [],
    aiEnriched: false,
  });
  await writeArtifact(
    "requirements",
    deps.paths.files.requirements,
    makeRequirements({ provider: from, domain: DOMAIN, dnsProvider: "cloudflare" }),
  );
  /** GitHub merges the open pull request, and this clone pulls main. */
  const merge = async () => {
    const branch = await git(root, "branch", "--show-current");
    if (branch === "main") return;
    await git(bare, "update-ref", "refs/heads/main", await git(root, "rev-parse", "HEAD"));
    await git(bare, "update-ref", "-d", `refs/heads/${branch}`);
    await git(root, "checkout", "-q", "main");
    await git(root, "merge", "-q", "--ff-only", branch);
  };
  /** A version of the Worker built by run `runId` goes live, as the Workers deploy job does. */
  const workerDeploys = (runId: number) => {
    zone.workers.set("example-app", {
      versions: [
        {
          id: `v${runId}`,
          created_on: "2026-11-06T12:00:00Z",
          message: `opscrew ${runId} ${"ab".repeat(32)}`,
        },
      ],
      deployments: [
        {
          id: `d${runId}`,
          created_on: "2026-11-06T12:00:00Z",
          source: "wrangler",
          strategy: "percentage",
          versions: [{ version_id: `v${runId}`, percentage: 100 }],
        },
      ],
    });
  };
  const readPlan = () => readArtifact("plan", deps.paths.files.plan);
  return {
    ...project,
    env,
    zone,
    pages,
    engine,
    github,
    cloudflare,
    services,
    checked,
    run,
    runs,
    merge,
    workerDeploys,
    readPlan,
    paths: deps.paths,
  };
}

type Setup = Awaited<ReturnType<typeof setup>>;

/** Every file under the project apart from git's objects and the user's own env file. */
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

/** Every user-visible or persisted text of the runs so far, for the leak checks. */
async function everything(s: Setup): Promise<string> {
  return [
    ...s.runs.flatMap(({ deps, handler }) => [
      deps.reporter.text(),
      JSON.stringify(deps.audit.entries),
      JSON.stringify(handler.requests),
    ]),
    JSON.stringify(s.github.pulls),
    JSON.stringify(s.zone.calls),
    s.engine.appliedPlans.join("\n"),
    await projectText(s.root),
  ].join("\n");
}

/** The kinds of the approvals a run asked for, in order. */
const kinds = (handler: ScriptedApprovalHandler) => handler.requests.map((r) => r.kind);

/** `runRetarget` with the setup's services. */
async function move(s: Setup, options: Omit<RetargetOptions, "services"> = {}, interactive = true) {
  const { deps, handler } = await s.run({ interactive });
  const result = await runRetarget(deps, { ...options, services: s.services });
  return { deps, handler, result };
}

describe.skipIf(!findExecutable("git"))("a site's move between site hosts", () => {
  it("moves from GitHub Pages to Cloudflare's hosting and back, each change approved by its hash", async () => {
    const s = await setup("github-pages");

    // 1. To Cloudflare's hosting: the Worker without custom domains, its secrets, the pull request.
    const first = await move(s, { to: "cloudflare-workers" });
    expect(first.result).toMatchObject({ step: "started", done: false });
    expect(first.result.next[0]).toContain("Merge https://github.com/acme/shop/pull/7");
    expect(kinds(first.handler)).toEqual([
      "iac-apply",
      "github-secrets",
      "git-push",
      "pull-request",
    ]);
    expect(first.handler.requests[0]).toMatchObject({
      planHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(first.handler.requests[0]?.allowDestroy).toBeUndefined();
    expect(s.engine.appliedPlans).toEqual([SHELL.map((a) => `create ${a}`).join(", ")]);
    const summary = first.deps.reporter.text();
    expect(summary).toContain("Moving example-app from GitHub Pages to Cloudflare hosting:");
    expect(summary).toContain("No maintenance window: a site has no data to copy.");
    expect(summary).toContain("The site is unreachable for the seconds between the two.");
    expect(s.github.secrets.get("OPSCREW_CLOUDFLARE_API_TOKEN")).toBe(DEPLOY_TOKEN);
    expect(s.github.secrets.get("OPSCREW_ENV_API_KEY")).toBe(API_KEY);
    const started = await s.readPlan();
    expect(started.target.provider).toBe("cloudflare-workers");
    expect(started.dns.proxied).toBe(true);
    expect(started.retarget).toMatchObject({
      step: "started",
      from: { target: { provider: "github-pages" } },
    });
    // GitHub Pages still serves the domain: its site and record are untouched.
    expect(s.pages.state.site).toMatchObject({ cname: DOMAIN });

    // 2. Merged: the deploy run, the Worker checked through Cloudflare's API, then the switch.
    await s.merge();
    s.github.deploy = s.workerDeploys;
    const second = await move(s);
    expect(second.result).toMatchObject({ step: "switched", done: true });
    expect(s.github.dispatches).toEqual([{ workflowFile: "opscrew-deploy.yml", ref: "main" }]);
    expect(kinds(second.handler)).toEqual(["iac-apply", "cloudflare-apply"]);
    const switchPlan = second.handler.requests[0];
    expect(switchPlan).toMatchObject({ allowDestroy: true, confirmPhrase: "example-app" });
    expect(s.engine.appliedPlans.at(-1)).toBe(`create ${CUSTOM_DOMAIN}, delete ${PAGES_RECORD}`);
    expect(s.checked).toEqual([`https://${DOMAIN}/`]);
    expect(second.result.next[0]).toContain("opscrew retarget --finish");

    // 3. Finish: the GitHub Pages site goes after the typed name; its verification record stays.
    const finished = await s.run();
    const confirmed: string[] = [];
    const end = await finishRetarget(finished.deps, {
      services: s.services,
      confirm: async (preview) => {
        confirmed.push(preview.name);
        return true;
      },
    });
    expect(end).toMatchObject({ step: "finished", done: true });
    expect(confirmed).toEqual(["example-app"]);
    expect(kinds(finished.handler)).toEqual(["pages-apply", "git-push", "pull-request"]);
    expect(finished.handler.requests[0]).toMatchObject({
      allowDestroy: true,
      confirmPhrase: "example-app",
    });
    expect(s.pages.state.site).toBeUndefined();
    expect(end.next.join("\n")).toContain(
      "_github-pages-challenge-example-org.docs.example.com stays",
    );
    const onWorkers = await s.readPlan();
    expect(onWorkers.retarget).toBeUndefined();
    expect(onWorkers.target).toMatchObject({
      provider: "cloudflare-workers",
      worker: "example-app",
    });
    expect(
      await exists(join(s.root, "opscrew/infra/modules/cloudflare-dns/github-pages/main.tf")),
    ).toBe(false);
    expect(await readFile(join(s.root, "opscrew/infra/prod/main.tf"), "utf8")).not.toContain(
      "move",
    );

    // 4. And back to GitHub Pages: the site turned on without a custom domain, then the pull request.
    await s.merge();
    const back = await move(s, { to: "github-pages", pagesVerification: VERIFICATION });
    expect(back.result).toMatchObject({ step: "started", done: false });
    expect(kinds(back.handler)).toEqual([
      "pages-apply",
      "github-secrets",
      "git-push",
      "pull-request",
    ]);
    expect(s.pages.state.site).toEqual({ buildType: "workflow", httpsEnforced: false });
    // The verification record stayed, so its plan changes nothing.
    expect(s.engine.states.get(pagesVerificationStateFile(s.paths))).toEqual(
      new Set([VERIFICATION_RECORD]),
    );

    await s.merge();
    s.github.deploy = () => undefined;
    const switched = await move(s);
    expect(switched.result).toMatchObject({ step: "switched", done: true });
    // The Pages plan sets the domain first, then one plan moves the hostname.
    expect(kinds(switched.handler)).toEqual(["pages-apply", "iac-apply"]);
    expect(switched.handler.requests[1]).toMatchObject({
      allowDestroy: true,
      confirmPhrase: "example-app",
    });
    expect(s.engine.appliedPlans.at(-1)).toBe(`create ${PAGES_RECORD}, delete ${CUSTOM_DOMAIN}`);
    expect(s.pages.state.site).toMatchObject({ cname: DOMAIN });
    expect(s.checked.slice(-2)).toEqual([PAGES_ADDRESS, `http://${DOMAIN}/`]);
    expect(switched.result.next.join("\n")).toContain("run `opscrew provision`");

    // 5. Finish: OpsCrew's rules for the Worker's hostnames, then the Worker, after the typed name.
    const last = await s.run();
    const done = await finishRetarget(last.deps, {
      services: s.services,
      confirm: async () => true,
    });
    expect(done).toMatchObject({ step: "finished", done: true });
    expect(kinds(last.handler)).toEqual([
      "cloudflare-apply",
      "iac-apply",
      "git-push",
      "pull-request",
    ]);
    for (const request of last.handler.requests.slice(0, 2)) {
      expect(request).toMatchObject({ allowDestroy: true, confirmPhrase: "example-app" });
    }
    expect(s.engine.appliedPlans.at(-1)).toBe(SHELL.map((a) => `delete ${a}`).join(", "));
    const onPages = await s.readPlan();
    expect(onPages.retarget).toBeUndefined();
    expect(onPages.target.provider).toBe("github-pages");
    expect(onPages.dns.proxied).toBe(false);
    expect(onPages.security.wafCustomRules).toBe(false);
    expect(await exists(join(s.root, "opscrew/cloudflare/wrangler.jsonc"))).toBe(false);
    expect(done.next.join("\n")).toContain("OPSCREW_CLOUDFLARE_API_TOKEN");

    // Nothing secret anywhere: output, audit, approvals, pull requests, Cloudflare calls, files.
    const text = await everything(s);
    for (const secret of [CF_TOKEN, DEPLOY_TOKEN, GITHUB_TOKEN, API_KEY]) {
      expect(text).not.toContain(secret);
    }
  });

  it("aborts a move to GitHub Pages before the switch: the Pages site goes, the Worker keeps the domain", async () => {
    const s = await setup("cloudflare-workers");
    const first = await move(s, { to: "github-pages", pagesVerification: VERIFICATION });
    expect(first.result).toMatchObject({ step: "started", done: false });
    expect(s.pages.state.site).toEqual({ buildType: "workflow", httpsEnforced: false });

    const aborted = await s.run();
    const result = await abortRetarget(aborted.deps, {
      services: s.services,
      confirm: async () => true,
    });
    expect(result).toMatchObject({ step: "aborted", done: true });
    expect(kinds(aborted.handler)[0]).toBe("pages-apply");
    expect(aborted.handler.requests[0]).toMatchObject({
      allowDestroy: true,
      confirmPhrase: "example-app",
    });
    expect(s.pages.state.site).toBeUndefined();
    // The Worker and its custom domain were never touched.
    expect(s.engine.states.get(tfstateFile(s.paths))).toEqual(new Set([...SHELL, CUSTOM_DOMAIN]));
    const plan = await s.readPlan();
    expect(plan.retarget).toBeUndefined();
    expect(plan.target.provider).toBe("cloudflare-workers");
    expect(plan.dns.proxied).toBe(true);
    expect(result.next.join("\n")).toContain("stays, so docs.example.com stays verified");
  });

  it("refuses to abort once the hostnames moved, and to finish before they did", async () => {
    const s = await setup("github-pages");
    await move(s, { to: "cloudflare-workers" });
    const early = await s.run();
    await expect(
      finishRetarget(early.deps, { services: s.services, confirm: async () => true }),
    ).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      message: expect.stringContaining("do not go to Cloudflare hosting yet"),
    });
    await s.merge();
    s.github.deploy = s.workerDeploys;
    expect((await move(s)).result.step).toBe("switched");
    const late = await s.run();
    await expect(abortRetarget(late.deps, { services: s.services })).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      message: expect.stringContaining("can no longer be aborted"),
    });
  });

  it("aborts before the switch from GitHub Pages: the Worker's shell is deleted and the deploy setup goes back", async () => {
    const s = await setup("github-pages");
    await move(s, { to: "cloudflare-workers" });
    await s.merge();
    s.github.deploy = s.workerDeploys;
    // The switch plan is refused, so the move stays deployed.
    const second = await s.run({ answer: (kind) => kind !== "iac-apply" });
    await expect(runRetarget(second.deps, { services: s.services })).rejects.toMatchObject({
      code: "APPROVAL_REFUSED",
    });
    expect((await s.readPlan()).retarget?.step).toBe("deployed");

    const aborted = await s.run();
    const result = await abortRetarget(aborted.deps, {
      services: s.services,
      confirm: async () => true,
    });
    expect(result).toMatchObject({ step: "aborted", done: true });
    expect(aborted.handler.requests[0]).toMatchObject({
      kind: "iac-apply",
      allowDestroy: true,
      confirmPhrase: "example-app",
    });
    expect(s.engine.appliedPlans.at(-1)).toBe(SHELL.map((a) => `delete ${a}`).join(", "));
    expect(s.engine.states.get(tfstateFile(s.paths))).toEqual(new Set([PAGES_RECORD]));
    const plan = await s.readPlan();
    expect(plan.retarget).toBeUndefined();
    expect(plan.target.provider).toBe("github-pages");
    expect(plan.dns.proxied).toBe(false);
    // The Worker's settings leave the repository again, in the pull request that restores Pages.
    expect(await exists(join(s.root, "opscrew/cloudflare/wrangler.jsonc"))).toBe(false);
    expect(result.next[0]).toContain("Merge https://github.com/acme/shop/pull/7");
  });

  it("stops a script at each plan with its hash, and applies exactly that plan with --approve", async () => {
    const s = await setup("github-pages");
    const first = await move(s, { to: "cloudflare-workers" }, false);
    expect(first.result).toMatchObject({ step: "started", done: false });
    const hash = first.result.pendingPlanHash;
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.result.next[0]).toContain(`opscrew retarget --approve ${hash}`);
    expect(s.engine.appliedPlans).toEqual([]);

    const second = await move(s, { approvePlanHash: hash as string }, false);
    expect(s.engine.appliedPlans).toEqual([SHELL.map((a) => `create ${a}`).join(", ")]);
    expect(second.handler.requests[0]).toMatchObject({ kind: "iac-apply", planHash: hash });
    expect(second.result.pendingPlanHash).toBeUndefined();
  });
});
