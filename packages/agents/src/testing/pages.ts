import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import type {
  FetchLike,
  IacApplyResult,
  IacApproval,
  IacInitOptions,
  IacRunOptions,
  PlanSummary,
  ResourceChange,
} from "@opscrew/contracts";
import { NodeCommandRunner } from "@opscrew/core";
import { type DeployPlan, DeployPlanSchema, writeArtifact } from "@opscrew/plan-schema";
import { FakeEngine, FakeGitHub } from "./deploy";
import { plainState } from "./state";

/** The repository of the GitHub Pages tests: its owner and name. */
export const PAGES_REPO = { owner: "example-org", repo: "example-app" } as const;

export interface PagesPlanOptions {
  /** The site's domain (default `docs.example.com`; `example.com` is the zone's apex). */
  domain?: string;
  /** Also serve `www.<domain>` (apex only). */
  www?: boolean;
  /** The app's variables, by name (all secret, from the user). */
  env?: readonly string[];
}

/** A static Vite site of `example-app` on GitHub Pages, in the zone `example.com`. */
export function pagesTestPlan(options: PagesPlanOptions = {}): DeployPlan {
  return DeployPlanSchema.parse({
    schemaVersion: 1,
    createdAt: "2026-10-23T12:00:00.000Z",
    updatedAt: "2026-10-23T12:00:00.000Z",
    app: {
      name: "example-app",
      port: 3000,
      env: (options.env ?? []).map((name) => ({ name, secret: true, source: "user" })),
    },
    target: {
      provider: "github-pages",
      mode: "pages-workflow",
      site: {
        tool: "node",
        packageManager: "npm",
        nodeVersion: "24",
        command: "npm run build",
        outputDir: "dist",
      },
    },
    processes: { workers: [], cron: [] },
    externalServices: [],
    cost: {
      monthly: { amount: 0, currency: "USD" },
      breakdown: [],
      pricesIncludeVat: false,
      source: "static",
      asOf: "2026-10-23T00:00:00.000Z",
    },
    codeChanges: [],
    infra: { engine: "tofu" },
    dns: {
      provider: "cloudflare",
      domain: options.domain ?? "docs.example.com",
      proxied: false,
      www: options.www === true,
    },
    cicd: { provider: "github-actions", registry: "ghcr", branch: "main" },
    security: { wafCustomRules: false },
  });
}

/**
 * Temp git project of a static site with a GitHub `origin` ({@link PAGES_REPO}; pushes go to a
 * bare repository) and `plan` written; no Dockerfile.
 */
export async function createPagesProject(plan: DeployPlan) {
  const runner = new NodeCommandRunner();
  const root = await mkdtemp(join(tmpdir(), "opscrew-pages-"));
  const bare = await mkdtemp(join(tmpdir(), "opscrew-pages-remote-"));
  const git = async (cwd: string, ...args: string[]) => {
    const result = await runner.run("git", ["-C", cwd, ...args]);
    if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  };
  await git(bare, "init", "--bare", "-b", "main");
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.name", "OpsCrew Test");
  await git(root, "config", "user.email", "test@example.invalid");
  await git(root, "config", "commit.gpgsign", "false");
  const { owner, repo } = PAGES_REPO;
  await git(root, "remote", "add", "origin", `https://github.com/${owner}/${repo}.git`);
  await git(root, "remote", "set-url", "--push", "origin", bare);
  await writeFile(join(root, "index.html"), "<!doctype html><title>example-app</title>\n");
  await writeFile(join(root, ".gitignore"), ".opscrew/\n.env\n");
  await git(root, "add", "index.html", ".gitignore");
  await git(root, "commit", "-m", "init");
  await writeArtifact("plan", join(root, "opscrew", "plan.yaml"), plan);
  return { root, bare, git };
}

/** A repository's Pages site in {@link fakeGithubPages}. */
export interface FakePagesSite {
  buildType: "workflow" | "legacy";
  cname?: string;
  httpsEnforced: boolean;
}

/**
 * What GitHub's health check of the custom domain answers: still checking (202), the DNS valid
 * with no certificate yet, the certificate issued, or the records wrong.
 */
export type FakePagesHealth = "checking" | "dns-ok" | "issued" | "dns-error";

export interface FakePagesOptions {
  /** The repository's site; none: GitHub Pages is off. */
  site?: FakePagesSite;
  /** The repository is private (default public). */
  private?: boolean;
  /** The owner's plan as `GET /user` shows it (`free`, `pro`); none: the token cannot read it. */
  plan?: string;
  health?: FakePagesHealth;
  /**
   * The repository has the GitHub environment `github-pages`, which GitHub creates with the site and
   * keeps when the site is deleted (default: while the site is on).
   */
  environment?: boolean;
  /** Shared call log: each request as `pages <METHOD> <path after the repository> [<body>]`. */
  log?: string[];
}

/** {@link fakeGithubPages}: the `fetch` the GitHub client uses, and the site as it is now. */
export interface FakePages {
  fetch: FetchLike;
  state: { site?: FakePagesSite; health: FakePagesHealth; environment: boolean };
  log: string[];
}

/** A JSON answer as GitHub sends it. */
function json(status: number, body?: unknown): Response {
  return new Response(status === 204 || body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** GitHub's health check of the domain for `health`. */
function healthAnswer(domain: string, health: FakePagesHealth): Response {
  if (health === "checking") return json(202);
  return json(200, {
    domain: {
      host: domain,
      dns_resolves: true,
      is_valid: health !== "dns-error",
      is_proxied: false,
      is_https_eligible: true,
      responds_to_https: health === "issued",
    },
    alt_domain: null,
  });
}

/**
 * GitHub's REST API for the Pages site of {@link PAGES_REPO}, as a `fetch` for the real
 * `GitHubClient`, behaving like GitHub: Pages on (`POST`, refused with 422 on a private
 * repository whose owner has the free plan), the source, the custom domain and HTTPS (`PUT`; HTTPS
 * answers 404 until the certificate is issued), the health check (400 without a custom domain),
 * turning Pages off (`DELETE`, which leaves the `github-pages` environment GitHub created with
 * the site), that environment (read and deleted), and the repository and plan `pagesAllowed` reads.
 */
export function fakeGithubPages(options: FakePagesOptions = {}): FakePages {
  const log = options.log ?? [];
  const state: FakePages["state"] = {
    ...(options.site !== undefined ? { site: { ...options.site } } : {}),
    health: options.health ?? "checking",
    environment: options.environment ?? options.site !== undefined,
  };
  const { owner, repo } = PAGES_REPO;
  const base = `/repos/${owner}/${repo}`;
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body =
      typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const path = url.pathname.startsWith(base) ? url.pathname.slice(base.length) : url.pathname;
    log.push(`pages ${method} ${path || "/"}${init?.body ? ` ${init.body}` : ""}`);
    const site = state.site;
    if (method === "GET" && path === "") {
      return json(200, {
        default_branch: "main",
        private: options.private === true,
        owner: { login: owner, type: "User" },
      });
    }
    if (method === "GET" && url.pathname === "/user") {
      return json(200, {
        login: owner,
        id: 1,
        ...(options.plan !== undefined ? { plan: { name: options.plan } } : {}),
      });
    }
    if (path === "/pages" && method === "GET") {
      if (site === undefined) return json(404, { message: "Not Found" });
      return json(200, {
        status: "built",
        cname: site.cname ?? null,
        build_type: site.buildType,
        https_enforced: site.httpsEnforced,
      });
    }
    if (path === "/pages" && method === "POST") {
      if (options.private === true && options.plan === "free") {
        return json(422, {
          message: "Your current plan does not support GitHub Pages for this repository.",
        });
      }
      if (site !== undefined) return json(409, { message: "GitHub Pages is already enabled." });
      state.site = { buildType: "workflow", httpsEnforced: false };
      state.environment = true;
      return json(201, { status: null, cname: null, build_type: "workflow" });
    }
    if (path === "/pages" && method === "PUT") {
      if (site === undefined) return json(404, { message: "Not Found" });
      if (body.https_enforced === true && state.health !== "issued") {
        return json(404, { message: "The certificate does not exist yet" });
      }
      if (body.build_type === "workflow") site.buildType = "workflow";
      if (body.cname === null) delete site.cname;
      else if (typeof body.cname === "string") site.cname = body.cname;
      if (typeof body.https_enforced === "boolean") site.httpsEnforced = body.https_enforced;
      return json(204);
    }
    if (path === "/pages" && method === "DELETE") {
      if (site === undefined) return json(404, { message: "Not Found" });
      delete state.site;
      return json(204);
    }
    if (path === "/environments/github-pages") {
      if (!state.environment) return json(404, { message: "Not Found" });
      if (method === "GET") return json(200, { name: "github-pages", protection_rules: [] });
      if (method === "DELETE") {
        state.environment = false;
        return json(204);
      }
    }
    if (path === "/pages/health" && method === "GET") {
      if (site === undefined) return json(404, { message: "Not Found" });
      if (site.cname === undefined) {
        return json(400, { message: "There isn't a CNAME for this page" });
      }
      return healthAnswer(site.cname, state.health);
    }
    throw new Error(`fakeGithubPages: no route for ${method} ${url.pathname}`);
  };
  return { fetch, state, log };
}

/** A Cloudflare DNS record as the `show -json` of the GitHub Pages roots plans it. */
function plannedRecord(module: string | undefined, name: string, values: Record<string, unknown>) {
  return {
    address: `${module === undefined ? "" : `${module}.`}cloudflare_dns_record.${name}`,
    mode: "managed",
    type: "cloudflare_dns_record",
    name,
    values,
  };
}

const CLOUDFLARE_PROVIDER = "registry.opentofu.org/cloudflare/cloudflare";

/** What the first plan of each GitHub Pages root creates. */
function firstChanges(verification: boolean): ResourceChange[] {
  const [module, name] = verification ? [undefined, "verification"] : ["module.dns", "cname"];
  return [
    {
      address: `${module === undefined ? "" : `${module}.`}cloudflare_dns_record.${name}`,
      type: "cloudflare_dns_record",
      name,
      provider: CLOUDFLARE_PROVIDER,
      action: "create",
    },
  ];
}

/**
 * IaC engine fake for the two GitHub Pages roots (the site's DNS records and GitHub's
 * verification record): each root's first plan creates its record, later plans of an applied root
 * change nothing, a destroy plan (`destroy: true`) of an applied root deletes its record, and
 * applying it empties the root's state file, as the engines do. Every plan and apply goes into the
 * shared `log` as `engine <plan|apply> [-destroy] <root>`, and each `init` records its state file.
 * `applied` lists the roots an earlier run applied.
 */
export class PagesEngine extends FakeEngine {
  readonly inits: { root: string; statePath: string | undefined }[] = [];
  readonly #applied = new Set<string>();
  readonly #destroyPlans = new Set<string>();

  constructor(
    readonly log: string[],
    readonly projectRoot: string,
    applied: readonly string[] = [],
  ) {
    super({
      outputs: { url: "https://docs.example.com" },
      planJson: {
        format_version: "1.2",
        planned_values: {
          root_module: {
            child_modules: [
              {
                address: "module.dns",
                resources: [
                  plannedRecord("module.dns", "cname", {
                    name: "docs.example.com",
                    type: "CNAME",
                    proxied: false,
                    ttl: 1,
                  }),
                ],
              },
            ],
          },
        },
        resource_changes: [],
      },
    });
    for (const root of applied) this.#applied.add(root);
  }

  /** `dir` from the project root, with `/`. */
  rootOf(dir: string): string {
    return relative(this.projectRoot, dir).replace(/\\/g, "/");
  }

  override async init(dir: string, options?: IacInitOptions): Promise<void> {
    this.inits.push({ root: this.rootOf(dir), statePath: options?.backendConfig?.path });
    return super.init(dir, options);
  }

  override async plan(
    dir: string,
    planFile: string,
    options: IacRunOptions & { destroy?: boolean } = {},
  ): Promise<PlanSummary> {
    const root = this.rootOf(dir);
    const destroy = options.destroy === true;
    this.log.push(`engine plan${destroy ? " -destroy" : ""} ${root}`);
    const applied = this.#applied.has(root);
    const first = firstChanges(root.endsWith("github-pages-verification"));
    this.scenario.changes = destroy
      ? applied
        ? first.map((change) => ({ ...change, action: "delete" as const }))
        : []
      : applied
        ? []
        : first;
    if (destroy) this.#destroyPlans.add(planFile);
    else this.#destroyPlans.delete(planFile);
    return super.plan(dir, planFile);
  }

  override async apply(
    dir: string,
    planFile: string,
    approval: IacApproval,
  ): Promise<IacApplyResult> {
    const root = this.rootOf(dir);
    const destroy = this.#destroyPlans.has(planFile);
    this.log.push(`engine apply${destroy ? " -destroy" : ""} ${root}`);
    const result = await super.apply(dir, planFile, approval);
    if (!destroy) {
      this.#applied.add(root);
      return result;
    }
    this.#applied.delete(root);
    const state = this.inits.findLast((init) => init.root === root)?.statePath;
    if (state !== undefined) {
      await mkdir(dirname(state), { recursive: true });
      await writeFile(state, plainState([]));
    }
    return result;
  }
}

/** {@link FakeGitHub} that also puts its pull requests and secrets into the shared `log`. */
export class LoggedGitHub extends FakeGitHub {
  constructor(readonly log: string[]) {
    super();
  }

  override async setActionsSecret(owner: string, repo: string, name: string, value: string) {
    this.log.push(`github secret ${name}`);
    return super.setActionsSecret(owner, repo, name, value);
  }

  override async createPullRequest(input: Parameters<FakeGitHub["createPullRequest"]>[0]) {
    this.log.push("github pull request");
    return super.createPullRequest(input);
  }
}
