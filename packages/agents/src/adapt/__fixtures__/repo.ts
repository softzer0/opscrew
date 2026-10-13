import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { PullRequest } from "@opscrew/connector-github";
import type { CommandOptions, CommandResult, CommandRunner } from "@opscrew/contracts";
import { findExecutable, NodeCommandRunner } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import {
  type Architecture,
  type DeployPlan,
  DeployPlanSchema,
  type ProjectFacts,
  writeArtifact,
} from "@opscrew/plan-schema";
import { createTestPhaseDeps, type TestPhaseDeps } from "../../testing";
import type { CodeChange } from "../../design";
import type { AdaptGitHub } from "../run";

/** Absolute path of git, or undefined when it is not installed (tests skip). */
export const GIT = findExecutable("git");

/** Runs real git for `git` commands only; anything else (for example `gh`) fails as not found. */
export class GitOnlyRunner implements CommandRunner {
  readonly #node = new NodeCommandRunner({ defaultTimeoutMs: 60_000 });
  readonly calls: string[][] = [];
  async run(command: string, args: readonly string[], options?: CommandOptions) {
    this.calls.push([basename(command), ...args]);
    if (!/^git(?:\.exe)?$/i.test(basename(command))) {
      return { exitCode: 127, stdout: "", stderr: "not found" } satisfies CommandResult;
    }
    return this.#node.run(command, args, options);
  }
}

/** Environment for test git processes: no user/system config, no tokens. */
export function testEnv(home: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(?:GIT_|GITHUB_TOKEN$|GH_TOKEN$|GH_ENTERPRISE_TOKEN$)/i.test(key)) delete env[key];
  }
  return {
    ...env,
    OPSCREW_HOME: join(home, "opscrew-home"),
    GIT_CONFIG_GLOBAL: join(home, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
  };
}

/** Runs git in `cwd` and returns stdout (throws on failure). */
export async function git(
  env: Record<string, string | undefined>,
  cwd: string,
  ...args: string[]
): Promise<string> {
  const result = await new NodeCommandRunner().run(GIT ?? "git", ["-C", cwd, ...args], { env });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

export function nextFacts(): ProjectFacts {
  return {
    name: "shop",
    languages: ["typescript"],
    packageManager: "npm",
    frameworks: [{ name: "next", version: "15.1.0", path: "." }],
    appKind: "ssr",
    platformExport: { platform: "none", evidence: [] },
    build: { buildCommand: "next build", startCommand: "next start" },
    port: 3000,
    runtimeVersions: {},
    envVars: [
      { name: "DATABASE_URL", files: ["lib/db.ts"], clientExposed: false, secretLikely: true },
      {
        name: "STRIPE_SECRET_KEY",
        files: ["lib/stripe.ts"],
        clientExposed: false,
        secretLikely: true,
      },
    ],
    services: [],
    docker: {},
    monorepo: false,
    git: {},
  };
}

export function nextChanges(): CodeChange[] {
  const change = (id: string, kind: CodeChange["kind"], path: string): CodeChange => ({
    id,
    kind,
    path,
    reason: `Reason for ${id}.`,
    status: "pending",
  });
  return [
    change("dockerfile", "dockerfile", "Dockerfile"),
    change("dockerignore", "dockerignore", ".dockerignore"),
    change("health-endpoint", "health-endpoint", "app/api/health/route.ts"),
    change("env-example", "env-example", ".env.example"),
    change("build-config", "build-config", "next.config.mjs"),
    change("secret-removal-1", "secret-removal", "lib/stripe.ts"),
  ];
}

export function makePlan(codeChanges: CodeChange[], healthPath = "/api/health"): DeployPlan {
  return DeployPlanSchema.parse({
    schemaVersion: 1,
    createdAt: "2026-10-11T10:00:00.000Z",
    updatedAt: "2026-10-11T10:00:00.000Z",
    app: {
      name: "shop",
      port: 3000,
      healthPath,
      env: [
        { name: "DATABASE_URL", secret: true, source: "user" },
        { name: "STRIPE_SECRET_KEY", secret: true, source: "user" },
      ],
    },
    target: {
      provider: "hetzner",
      mode: "vps-compose",
      location: "nbg1",
      serverType: "cx23",
      backups: true,
    },
    services: { postgres: false, redis: false },
    externalServices: [],
    cost: {
      monthly: { amount: 5.99, currency: "EUR" },
      breakdown: [{ item: "Server cx23 (nbg1)", monthly: { amount: 5.99, currency: "EUR" } }],
      pricesIncludeVat: false,
      source: "static",
      asOf: "2026-09-01T00:00:00.000Z",
    },
    codeChanges,
    dns: { provider: "none", proxied: false },
    cicd: { provider: "github-actions", registry: "ghcr" },
  });
}

export interface TestRepo {
  root: string;
  /** Bare repository that receives pushes to `origin`. */
  bare: string;
  env: Record<string, string | undefined>;
  deps: TestPhaseDeps;
  runner: GitOnlyRunner;
  /** The fake Stripe key in the gitignored `.env` (must never reach a prompt or commit). */
  envSecret: string;
  /** The fake Stripe key hard-coded in `lib/stripe.ts`. */
  codeSecret: string;
  initialSha: string;
}

export interface TestRepoOptions {
  changes?: CodeChange[];
  /** Extra committed files (repo-relative path → content). */
  files?: Record<string, string>;
  /** Origin URL; defaults to a GitHub URL whose pushes go to the bare repository. */
  remote?: string | null;
  depsOptions?: Parameters<typeof createTestPhaseDeps>[0];
  /** Analysed facts (default: the Next.js shop). */
  facts?: ProjectFacts;
  /** The plan's health check path (default `/api/health`). */
  healthPath?: string;
}

/**
 * A committed Next.js app in a temp git repository on `main` with a gitignored `.env`, untracked
 * OpsCrew artefacts (architecture, plan, scan report) and `origin` pointing at a GitHub URL whose
 * pushes land in a local bare repository.
 */
export async function createTestRepo(options: TestRepoOptions = {}): Promise<TestRepo> {
  const home = await mkdtemp(join(tmpdir(), "opscrew-adapt-"));
  const root = join(home, "shop");
  const bare = join(home, "origin.git").replace(/\\/g, "/");
  await mkdir(root, { recursive: true });
  const env = testEnv(home);
  await writeFile(env.GIT_CONFIG_GLOBAL as string, "");

  const codeSecret = fakeSecret("stripe-live-key", "code");
  const envSecret = fakeSecret("stripe-live-key", "env");
  const files: Record<string, string> = {
    ".gitignore": ".env\n.opscrew/\nnode_modules/\n",
    "package.json": `${JSON.stringify({ name: "shop", scripts: { build: "next build", start: "next start" } }, null, 2)}\n`,
    "next.config.mjs": "const nextConfig = {};\nexport default nextConfig;\n",
    "tsconfig.json": `${JSON.stringify({ compilerOptions: { strict: true, jsx: "preserve" } }, null, 2)}\n`,
    "app/page.tsx": "export default function Page() {\n  return <h1>Shop</h1>;\n}\n",
    "lib/db.ts": "export const url = process.env.DATABASE_URL;\n",
    "lib/stripe.ts": `export const stripeKey = "${codeSecret}";\n`,
    ...options.files,
  };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  await writeFile(join(root, ".env"), `STRIPE_SECRET_KEY=${envSecret}\n`);

  await git(env, root, "init", "-b", "main");
  await git(env, root, "config", "user.name", "OpsCrew Test");
  await git(env, root, "config", "user.email", "test@example.invalid");
  await git(env, root, "config", "commit.gpgsign", "false");
  await git(env, root, "config", "core.autocrlf", "false");
  await git(env, root, "add", "-A");
  await git(env, root, "commit", "-m", "initial");
  const initialSha = await git(env, root, "rev-parse", "HEAD");
  await git(env, home, "init", "--bare", "-b", "main", bare);
  const remote = options.remote === undefined ? "https://github.com/acme/shop.git" : options.remote;
  if (remote !== null) {
    await git(env, root, "remote", "add", "origin", remote);
    if (remote.startsWith("https://github.com/")) {
      await git(env, root, "config", `url.${bare}.pushInsteadOf`, remote);
    }
  }

  const runner = new GitOnlyRunner();
  const deps = await createTestPhaseDeps({ root, env, runner, ...options.depsOptions });
  const architecture: Architecture = {
    schemaVersion: 1,
    generatedAt: "2026-10-11T10:00:00.000Z",
    generator: { tool: "opscrew", version: "0.0.0-test" },
    facts: options.facts ?? nextFacts(),
    summary: "A Next.js shop.",
    risks: [],
    aiEnriched: false,
  };
  await writeArtifact("architecture", deps.paths.files.architecture, architecture);
  await writeArtifact("plan", deps.paths.files.plan, makePlan(options.changes ?? nextChanges(), options.healthPath));
  await writeFile(deps.paths.files.scanReportMd, "# Security scan\n\nNo secrets shown here.\n");
  await mkdir(deps.paths.stateDir, { recursive: true });
  await writeFile(
    deps.paths.files.scanReportJson,
    JSON.stringify({ counts: { critical: 1, high: 2, medium: 0, low: 3, info: 0 }, findings: [] }),
  );
  return { root, bare, env, deps, runner, envSecret, codeSecret, initialSha };
}

/** Fake GitHub client recording pull-request calls. */
export class FakeGitHub implements AdaptGitHub {
  readonly created: Parameters<AdaptGitHub["createPullRequest"]>[0][] = [];
  readonly lookups: string[] = [];
  /** `open` is returned for every head, or only for the branches in `heads` when given. */
  constructor(
    private readonly open?: PullRequest,
    private readonly heads?: readonly string[],
  ) {}
  async findOpenPullRequest(owner: string, repo: string, head: string) {
    this.lookups.push(`${owner}/${repo}:${head}`);
    return this.heads === undefined || this.heads.includes(head) ? this.open : undefined;
  }
  async createPullRequest(input: Parameters<AdaptGitHub["createPullRequest"]>[0]) {
    this.created.push(input);
    return { number: 7, url: `https://github.com/${input.owner}/${input.repo}/pull/7` };
  }
}
