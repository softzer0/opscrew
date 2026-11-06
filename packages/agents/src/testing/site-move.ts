/**
 * A static site's move between Cloudflare's hosting and GitHub Pages (`opscrew retarget`, T2312):
 * the IaC engine of a site's roots, GitHub's API for the deploy setup and workflow runs, and a
 * deployed site of `example-app` with every fake its move talks to. Tests only.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
import { sha256Hex, tfstateFile } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { detectProject } from "@opscrew/detect";
import {
  DeployPlanSchema,
  readArtifact,
  type ServerlessProvider,
  writeArtifact,
} from "@opscrew/plan-schema";
import type { RetargetGitHubApi, RetargetServices } from "../retarget/types";
import { pagesVerificationStateFile } from "../shared";
import { makeRequirements } from "./catalog";
import {
  FakeEngine,
  FakeGitHub,
  fakeCloudflare,
  fakeSharedCloudflare,
  opscrewRecord,
  projectRunner,
} from "./deploy";
import { createTestPhaseDeps, ScriptedApprovalHandler } from "./deps";
import { createPagesProject, fakeGithubPages, PAGES_REPO } from "./pages";
import { sitePlan } from "./serverless";
import { plainState } from "./state";

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

/** The values the site move's tests check against (synthetic secrets, the site's domain, its records). */
export const SITE_MOVE = {
  CF_TOKEN,
  DEPLOY_TOKEN,
  GITHUB_TOKEN,
  API_KEY,
  VERIFICATION,
  DOMAIN,
  PAGES_ADDRESS,
  SHELL,
  CUSTOM_DOMAIN,
  PAGES_RECORD,
  VERIFICATION_RECORD,
} as const;

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
export class SiteEngine extends FakeEngine {
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
    if (this.failPartway) {
      // The deletes went through, then a create failed: the state keeps what is left.
      this.failPartway = false;
      const current = this.states.get(planned.state) ?? new Set<string>();
      this.states.set(planned.state, new Set([...current].filter((a) => planned.desired.has(a))));
      return { ok: false, outputs: {}, log: "Error: creating the hostname's record failed" };
    }
    this.states.set(planned.state, planned.desired);
    this.appliedPlans.push(content.replace(/^site plan \d+: /, ""));
    return { ok: true, outputs: { url: `https://${DOMAIN}` }, log: "Apply complete!" };
  }

  /** The next apply deletes what its plan deletes, then fails before it creates anything. */
  failPartway = false;

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
export class SiteGitHub extends FakeGitHub implements RetargetGitHubApi {
  deploy: (runId: number) => void = () => undefined;
  /** How the run ends; its deploy job runs only when it succeeds. */
  conclusion = "success";
  async deleteBranch() {
    return "absent" as const;
  }
  async waitForWorkflowRun(_owner: string, _repo: string, options: { runId: number }) {
    if (this.conclusion === "success") this.deploy(options.runId);
    return {
      id: options.runId,
      conclusion: this.conclusion,
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
export async function siteMoveHarness(from: ServerlessProvider, o: { pagesSite?: boolean } = {}) {
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
      : o.pagesSite === true
        ? { site: { buildType: "legacy", httpsEnforced: false } }
        : {},
  );
  const engine = new SiteEngine();
  /** Whether GitHub Pages serves the repository's site on github.io, and the domain is reachable. */
  const up = { pages: true, domain: true };
  /** The site root's state file, known once the first run's paths are. */
  let stateFile = "";
  /** The site addresses checked, in order. */
  const checked: string[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "api.cloudflare.com") return zone.fetch(input, init);
    if (url.hostname === "api.github.com") return pages.fetch(input, init);
    if (url.hostname === `${owner}.github.io` || url.hostname === DOMAIN) {
      checked.push(url.href);
      // The domain answers where a host holds it: the Worker's custom domain, or GitHub Pages'
      // record while its site claims the domain.
      const held = engine.states.get(stateFile) ?? new Set<string>();
      const served =
        url.hostname === DOMAIN
          ? up.domain &&
            (held.has(CUSTOM_DOMAIN) ||
              (held.has(PAGES_RECORD) && pages.state.site?.cname === DOMAIN))
          : up.pages && pages.state.site !== undefined;
      return new Response(served ? "<!doctype html>" : "", { status: served ? 200 : 522 });
    }
    throw new Error(`no route for ${url.href}`);
  };
  let clock = 0;
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
    // A minute passes between two checks of an address, so a wait gives up quickly.
    now: () => {
      clock += 60_000;
      return clock;
    },
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
  stateFile = state;
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
    fetch,
    up,
    run,
    runs,
    merge,
    workerDeploys,
    readPlan,
    paths: deps.paths,
  };
}

export type SiteMoveHarness = Awaited<ReturnType<typeof siteMoveHarness>>;
