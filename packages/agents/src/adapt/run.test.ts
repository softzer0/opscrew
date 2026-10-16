import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PhaseRequest } from "@opscrew/contracts";
import { FakeAgentRuntime, type FakePhaseResponse } from "@opscrew/core/testing";
import { type ProjectFacts, readArtifact, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import type { CodeChange } from "../design/code-changes";
import { ScriptedApprovalHandler } from "../testing";
import {
  createTestRepo,
  FakeGitHub,
  GIT,
  git,
  makePlan,
  nextChanges,
  nextFacts,
  type TestRepo,
  type TestRepoOptions,
} from "./__fixtures__/repo";
import { PULL_REQUEST_FOOTER, PULL_REQUEST_TITLE } from "./pr";
import { ADAPT_BRANCH, ADAPT_COMMIT_SUBJECT, runAdapt } from "./run";

/** A Code-change agent that edits files directly (no tools) and reports statuses. */
function editingAgent(
  override?: (request: PhaseRequest<unknown>) => Promise<FakePhaseResponse>,
): FakeAgentRuntime {
  return new FakeAgentRuntime({
    phases: {
      adapt:
        override ??
        (async (request) => {
          const root = request.projectRoot;
          await writeFile(
            join(root, "lib", "stripe.ts"),
            "export const stripeKey = process.env.STRIPE_SECRET_KEY;\n",
          );
          return {
            costUsd: 0.42,
            model: "claude-opus-5-5",
            output: {
              changes: [
                { id: "secret-removal-1", status: "applied", notes: "Reads STRIPE_SECRET_KEY." },
              ],
            },
          };
        }),
    },
  });
}

async function setup(
  options: TestRepoOptions & { approvals?: boolean[]; agent?: FakeAgentRuntime | null } = {},
): Promise<TestRepo & { handler: ScriptedApprovalHandler; runtime?: FakeAgentRuntime }> {
  const handler = new ScriptedApprovalHandler(options.approvals ?? (() => true));
  const runtime = options.agent === null ? undefined : (options.agent ?? editingAgent());
  const repo = await createTestRepo({
    ...options,
    depsOptions: {
      approvalHandler: handler,
      ...(runtime ? { runtime } : {}),
      ...options.depsOptions,
    },
  });
  return { ...repo, handler, ...(runtime ? { runtime } : {}) };
}

const statusOf = async (repo: TestRepo) =>
  Object.fromEntries(
    (await readArtifact("plan", repo.deps.paths.files.plan)).codeChanges.map((c) => [
      c.id,
      c.status,
    ]),
  );

const exists = (repo: TestRepo, path: string) =>
  readFile(join(repo.root, path), "utf8").then(
    () => true,
    () => false,
  );

const remoteBranches = (repo: TestRepo) =>
  git(repo.env, repo.bare, "for-each-ref", "--format=%(refname:short)", "refs/heads");

describe.skipIf(GIT === undefined)("runAdapt (real git repository)", () => {
  it("refuses a dirty working tree without touching any file", async () => {
    const repo = await setup();
    await writeFile(join(repo.root, "app", "page.tsx"), "export default function Page() {}\n");

    await expect(runAdapt(repo.deps, { github: new FakeGitHub() })).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      message: expect.stringContaining("uncommitted changes"),
      hint: expect.stringContaining("Commit or stash"),
    });
    expect(await git(repo.env, repo.root, "branch", "--show-current")).toBe("main");
    expect(await exists(repo, "Dockerfile")).toBe(false);
    expect(repo.handler.requests).toHaveLength(0);
    expect(repo.runtime?.requests).toHaveLength(0);
    expect(await statusOf(repo)).toMatchObject({ dockerfile: "pending" });
    expect((await repo.deps.state.read()).phases.adapt?.status).toBe("failed");
  });

  it("writes files, runs the agent, commits, pushes and opens a pull request", async () => {
    const repo = await setup();
    const github = new FakeGitHub();

    const result = await runAdapt(repo.deps, { github });

    // Branch and deterministic files.
    expect(result.branch).toBe(ADAPT_BRANCH);
    expect(result.baseBranch).toBe("main");
    expect(await git(repo.env, repo.root, "branch", "--show-current")).toBe(ADAPT_BRANCH);
    expect(result.createdFiles).toEqual([
      "Dockerfile",
      ".dockerignore",
      ".env.example",
      "app/api/health/route.ts",
    ]);
    const route = await readFile(join(repo.root, "app", "api", "health", "route.ts"), "utf8");
    expect(route).toContain('import { NextResponse } from "next/server";');
    expect(route).toContain('return NextResponse.json({ status: "ok" });');
    expect(route).not.toContain("dynamic");
    const dockerfile = await readFile(join(repo.root, "Dockerfile"), "utf8");
    expect(dockerfile).toMatch(/^FROM .* AS /m);
    expect(dockerfile).toContain("USER");
    expect(dockerfile).toContain("server.js");
    const envExample = await readFile(join(repo.root, ".env.example"), "utf8");
    expect(envExample).toContain("STRIPE_SECRET_KEY=\n");
    expect(envExample).not.toContain(repo.envSecret);

    // Agent request: edit-repo profile, Opus, budgets, no secrets in the prompt.
    const request = repo.runtime?.requests[0];
    expect(request).toMatchObject({
      phase: "adapt",
      profile: "edit-repo",
      model: "claude-opus-5-5",
      effort: "high",
      maxTurns: 60,
      maxBudgetUsd: 3,
      projectRoot: repo.root,
    });
    expect(request?.output?.name).toBe("code_change_report");
    // OpsCrew created the health route itself, so the agent is not asked to either.
    expect(request?.prompt).toContain("### secret-removal-1");
    expect(request?.prompt).not.toContain("### health-endpoint");
    expect(request?.prompt).not.toContain("### dockerfile");
    // OpsCrew set the standalone output itself, so the agent is not asked to.
    expect(request?.prompt).not.toContain("### build-config");
    expect(await readFile(join(repo.root, "next.config.mjs"), "utf8")).toBe(
      'const nextConfig = {\n  output: "standalone",\n};\nexport default nextConfig;\n',
    );
    expect(result.editedFiles).toEqual(["next.config.mjs"]);
    for (const text of [request?.prompt, request?.systemPrompt]) {
      expect(text).not.toContain(repo.envSecret);
      expect(text).not.toContain(repo.codeSecret);
    }

    // Statuses in the result and in plan.yaml.
    const expected = {
      dockerfile: "applied",
      dockerignore: "applied",
      "env-example": "applied",
      "health-endpoint": "applied",
      "secret-removal-1": "applied",
      "build-config": "applied",
    };
    expect(await statusOf(repo)).toEqual(expected);
    expect(Object.fromEntries(result.changes.map((c) => [c.id, c.status]))).toEqual(expected);
    expect(result.notes["build-config"]).toContain('OpsCrew set output: "standalone"');
    expect(result.aiRan).toBe(true);
    expect(result.costUsd).toBe(0.42);
    expect(await repo.deps.costs.total()).toBe(0.42);

    // Commit contents.
    expect(result.committed).toBe(true);
    expect(await git(repo.env, repo.root, "rev-parse", "HEAD")).toBe(result.commitSha);
    expect(await git(repo.env, repo.root, "log", "-1", "--format=%s")).toBe(ADAPT_COMMIT_SUBJECT);
    const committed = (
      await git(repo.env, repo.root, "show", "--name-only", "--format=", "HEAD")
    ).split("\n");
    expect(committed.sort()).toEqual(
      [
        ".dockerignore",
        ".env.example",
        "Dockerfile",
        "app/api/health/route.ts",
        "lib/stripe.ts",
        "next.config.mjs",
        "opscrew/SECURITY_SCAN.md",
        "opscrew/architecture.json",
        "opscrew/plan.yaml",
      ].sort(),
    );
    const committedPlan = await git(repo.env, repo.root, "show", "HEAD:opscrew/plan.yaml");
    expect(committedPlan).toContain("status: applied");
    expect(await git(repo.env, repo.root, "status", "--porcelain")).toBe("");

    // Approvals in order, then push and pull request.
    expect(repo.handler.requests.map((r) => r.kind)).toEqual([
      "repo-write",
      "git-push",
      "pull-request",
    ]);
    expect(repo.handler.requests[0]?.details).toContain("Dockerfile");
    expect(repo.handler.requests[1]?.details).toContain("https://github.com/acme/shop.git");
    expect(result.pushed).toBe(true);
    expect(await remoteBranches(repo)).toBe(ADAPT_BRANCH);
    expect(await git(repo.env, repo.bare, "rev-parse", ADAPT_BRANCH)).toBe(result.commitSha);

    expect(github.lookups).toEqual([`acme/shop:${ADAPT_BRANCH}`]);
    expect(github.created).toHaveLength(1);
    const pr = github.created[0];
    expect(pr).toMatchObject({
      owner: "acme",
      repo: "shop",
      head: ADAPT_BRANCH,
      base: "main",
      title: PULL_REQUEST_TITLE,
    });
    expect(pr?.body.trimEnd().endsWith(PULL_REQUEST_FOOTER)).toBe(true);
    expect(pr?.body).toContain("app/api/health/route.ts");
    expect(pr?.body).toContain("in `next.config.mjs` (applied by OpsCrew)");
    expect(pr?.body).toContain("in `app/api/health/route.ts` (applied by OpsCrew)");
    expect(pr?.body).not.toContain("fails its health check");
    expect(pr?.body).toContain("| 1 | 2 | 0 | 3 | 0 |");
    expect(pr?.body).toContain(
      `https://github.com/acme/shop/blob/${ADAPT_BRANCH}/opscrew/plan.yaml`,
    );
    expect(pr?.body).not.toContain(repo.codeSecret);
    expect(result.pullRequest).toEqual({ number: 7, url: "https://github.com/acme/shop/pull/7" });
    expect(repo.deps.reporter.text()).toContain("https://github.com/acme/shop/pull/7");

    // Audit and phase state.
    const actions = repo.deps.audit.entries.map((e) => `${e.kind}:${e.action}`);
    expect(actions).toEqual(
      expect.arrayContaining([
        "git:create branch",
        "git:commit",
        "git:push",
        "provider-call:create pull request",
      ]),
    );
    expect((await repo.deps.state.read()).phases.adapt?.status).toBe("ok");
    // The secret in .env stays out of the commit and every message.
    expect(committed).not.toContain(".env");
    expect(repo.deps.reporter.text()).not.toContain(repo.envSecret);
  });

  it("appends a numeric suffix when the branch already exists", async () => {
    const repo = await setup();
    await git(repo.env, repo.root, "branch", ADAPT_BRANCH);
    await git(repo.env, repo.root, "branch", `${ADAPT_BRANCH}-2`);

    const result = await runAdapt(repo.deps, { github: new FakeGitHub(), push: false });

    expect(result.branch).toBe(`${ADAPT_BRANCH}-3`);
    expect(await git(repo.env, repo.root, "branch", "--show-current")).toBe(`${ADAPT_BRANCH}-3`);
  });

  it("writes deterministic files only when they are missing", async () => {
    const own = "FROM scratch\n# my own Dockerfile\n";
    const repo = await setup({ files: { Dockerfile: own }, agent: null });

    const result = await runAdapt(repo.deps, { push: false });

    expect(await readFile(join(repo.root, "Dockerfile"), "utf8")).toBe(own);
    expect(result.createdFiles).toEqual([
      ".dockerignore",
      ".env.example",
      "app/api/health/route.ts",
    ]);
    expect(await statusOf(repo)).toMatchObject({
      dockerfile: "skipped",
      dockerignore: "applied",
      "env-example": "applied",
    });
    expect(result.notes.dockerfile).toContain("already exists");
  });

  it("leaves the changes uncommitted on the new branch when the commit is refused", async () => {
    const repo = await setup({ approvals: [false] });
    const github = new FakeGitHub();

    const result = await runAdapt(repo.deps, { github });

    expect(result.committed).toBe(false);
    expect(result.pushed).toBe(false);
    expect(repo.handler.requests.map((r) => r.kind)).toEqual(["repo-write"]);
    expect(await git(repo.env, repo.root, "branch", "--show-current")).toBe(ADAPT_BRANCH);
    expect(await git(repo.env, repo.root, "rev-parse", "HEAD")).toBe(repo.initialSha);
    const status = await git(repo.env, repo.root, "status", "--porcelain", "--untracked-files=all");
    expect(status).toContain("?? Dockerfile");
    expect(status).toMatch(/^ ?M lib\/stripe\.ts$/m);
    expect(await remoteBranches(repo)).toBe("");
    expect(github.lookups).toHaveLength(0);
    expect(github.created).toHaveLength(0);
    expect(await statusOf(repo)).toMatchObject({ dockerfile: "applied" });
    expect(repo.deps.reporter.text()).toContain("Nothing was committed");
    expect((await repo.deps.state.read()).phases.adapt?.status).toBe("skipped");
  });

  it("commits but does not push when the push is refused", async () => {
    const repo = await setup({ approvals: [true, false] });
    const github = new FakeGitHub();

    const result = await runAdapt(repo.deps, { github });

    expect(result.committed).toBe(true);
    expect(result.pushed).toBe(false);
    expect(repo.handler.requests.map((r) => r.kind)).toEqual(["repo-write", "git-push"]);
    expect(await remoteBranches(repo)).toBe("");
    expect(github.created).toHaveLength(0);
    expect(repo.deps.reporter.text()).toContain(`git push -u origin ${ADAPT_BRANCH}`);
  });

  it("pushes but opens no pull request when that approval is refused", async () => {
    const repo = await setup({ approvals: [true, true, false] });
    const github = new FakeGitHub();

    const result = await runAdapt(repo.deps, { github });

    expect(result.pushed).toBe(true);
    expect(result.pullRequest).toBeUndefined();
    expect(await remoteBranches(repo)).toBe(ADAPT_BRANCH);
    expect(github.created).toHaveLength(0);
    expect(repo.deps.reporter.text()).toContain(
      `https://github.com/acme/shop/compare/main...${ADAPT_BRANCH}?expand=1`,
    );
  });

  it("reuses an open pull request instead of opening another", async () => {
    const open = { number: 3, url: "https://github.com/acme/shop/pull/3" };
    const repo = await setup();
    const github = new FakeGitHub(open);

    const result = await runAdapt(repo.deps, { github });

    expect(result.pullRequest).toEqual(open);
    expect(github.created).toHaveLength(0);
    expect(repo.handler.requests.map((r) => r.kind)).toEqual(["repo-write", "git-push"]);
  });

  it("with --no-ai and --no-push lists manual steps and asks only to commit", async () => {
    const repo = await setup();

    const result = await runAdapt(repo.deps, { ai: false, push: false });

    expect(repo.runtime?.requests).toHaveLength(0);
    expect(result.aiRan).toBe(false);
    expect(result.manual.map((m) => m.change.id)).toEqual(["secret-removal-1"]);
    expect(result.manual[0]?.instructions).toContain("lib/stripe.ts");
    expect(await statusOf(repo)).toMatchObject({
      dockerfile: "applied",
      "health-endpoint": "applied",
      "build-config": "applied",
    });
    // Without a model, the health route the deploy checks is created, and committed.
    expect(result.createdFiles).toContain("app/api/health/route.ts");
    expect(repo.deps.reporter.text()).toContain("Created app/api/health/route.ts");
    expect(repo.deps.reporter.text()).not.toContain("fails its health check");
    // Without a model, the standalone output is still set, and committed.
    expect(await readFile(join(repo.root, "next.config.mjs"), "utf8")).toContain(
      'output: "standalone"',
    );
    const committed = await git(repo.env, repo.root, "show", "--name-only", "--format=", "HEAD");
    expect(committed.split("\n")).toContain("next.config.mjs");
    expect(committed.split("\n")).toContain("app/api/health/route.ts");
    expect(repo.handler.requests.map((r) => r.kind)).toEqual(["repo-write"]);
    expect(result.committed).toBe(true);
    expect(result.pushed).toBe(false);
    expect(await remoteBranches(repo)).toBe("");
    expect(repo.deps.reporter.text()).toContain("--no-ai");
  });

  it("keeps changes pending when the agent's output is invalid", async () => {
    const agent = editingAgent(async () => ({
      output: { changes: [{ id: "health-endpoint", status: "done" }] },
    }));
    // A health path other than /api/health is left to the agent.
    const repo = await setup({ agent, healthPath: "/healthz" });

    const result = await runAdapt(repo.deps, { push: false });

    expect(await statusOf(repo)).toMatchObject({
      dockerfile: "applied",
      "health-endpoint": "pending",
      "secret-removal-1": "pending",
    });
    expect(await exists(repo, "app/api/health/route.ts")).toBe(false);
    expect(result.manual).toHaveLength(2);
    const text = repo.deps.reporter.text();
    expect(text).toContain("did not finish");
    expect(text).toContain(
      "Until GET /healthz answers 200, every deploy fails its health check and is rolled back.",
    );
  });

  it("ignores unknown ids and keeps unreported changes pending", async () => {
    const agent = editingAgent(async () => ({
      output: {
        changes: [
          { id: "health-endpoint", status: "skipped", notes: "Already has one." },
          { id: "dockerfile", status: "applied", notes: "" },
        ],
      },
    }));
    const repo = await setup({ agent, healthPath: "/healthz" });

    await runAdapt(repo.deps, { push: false });

    expect(await statusOf(repo)).toMatchObject({
      dockerfile: "applied",
      "health-endpoint": "skipped",
      "secret-removal-1": "pending",
    });
    const text = repo.deps.reporter.text();
    expect(text).toContain('unknown or repeated change "dockerfile"');
    expect(text).toContain("did not report on secret-removal-1;");
  });

  it("leaves a Next.js config it cannot edit safely to the agent, with the reason", async () => {
    const config = 'const nextConfig = { output: "export" };\nexport default nextConfig;\n';
    const repo = await setup({ files: { "next.config.mjs": config }, agent: null });

    const result = await runAdapt(repo.deps, { push: false });

    expect(await readFile(join(repo.root, "next.config.mjs"), "utf8")).toBe(config);
    expect(result.editedFiles).toEqual([]);
    expect(await statusOf(repo)).toMatchObject({ "build-config": "pending" });
    const item = result.manual.find((m) => m.change.id === "build-config");
    expect(item?.instructions).toContain('sets output to "export"');
    expect(result.notes["build-config"]).toContain("OpsCrew did not edit it");
  });

  it("creates the health route under a basePath and moves the plan's path in the same commit", async () => {
    const config = 'const nextConfig = { basePath: "/shop" };\nexport default nextConfig;\n';
    const repo = await setup({ files: { "next.config.mjs": config }, agent: null });
    const github = new FakeGitHub();

    const result = await runAdapt(repo.deps, { github });

    expect(result.createdFiles).toContain("app/api/health/route.ts");
    expect(await statusOf(repo)).toMatchObject({ "health-endpoint": "applied" });
    const say =
      'next.config.mjs sets basePath "/shop", so the health route answers at /shop/api/health; OpsCrew set app.healthPath in `opscrew/plan.yaml` to /shop/api/health to match.';
    expect(result.notes["health-endpoint"]).toContain(say);
    expect(repo.deps.reporter.text()).toContain(say);
    // The plan follows the route, committed with it and named in the pull request.
    expect((await readArtifact("plan", repo.deps.paths.files.plan)).app.healthPath).toBe(
      "/shop/api/health",
    );
    const committed = await git(repo.env, repo.root, "show", "HEAD:opscrew/plan.yaml");
    expect(committed).toContain("healthPath: /shop/api/health");
    expect(github.created[0]?.body).toContain("http://localhost:3000/shop/api/health");
  });

  it("leaves the plan's path alone under a basePath it cannot read", async () => {
    const config = "export default { basePath: process.env.BASE_PATH };\n";
    const repo = await setup({ files: { "next.config.mjs": config }, agent: null });

    const result = await runAdapt(repo.deps, { push: false });

    expect(result.notes["health-endpoint"]).toContain(
      "next.config.mjs mentions basePath in a way OpsCrew cannot read",
    );
    expect((await readArtifact("plan", repo.deps.paths.files.plan)).app.healthPath).toBe(
      "/api/health",
    );
  });

  it("creates next.config.mjs when the app has no Next.js config", async () => {
    const repo = await setup({ agent: null });
    await git(repo.env, repo.root, "rm", "-q", "next.config.mjs");
    await git(repo.env, repo.root, "commit", "-q", "-m", "no config");

    const result = await runAdapt(repo.deps, { ai: false, push: false });

    expect(result.createdFiles).toContain("next.config.mjs");
    expect(await readFile(join(repo.root, "next.config.mjs"), "utf8")).toContain(
      'const nextConfig = {\n  output: "standalone",\n};',
    );
    expect(await statusOf(repo)).toMatchObject({ "build-config": "applied" });
  });

  it("skips the agent and the commit when nothing needs to change", async () => {
    const changes = nextChanges().map((c) => ({ ...c, status: "applied" as const }));
    const repo = await setup({ changes });
    await git(repo.env, repo.root, "add", "-A");
    await git(repo.env, repo.root, "commit", "-m", "artefacts");

    const result = await runAdapt(repo.deps, { github: new FakeGitHub() });

    expect(repo.runtime?.requests).toHaveLength(0);
    expect(result.committed).toBe(false);
    expect(repo.handler.requests).toHaveLength(0);
    expect(repo.deps.reporter.text()).toContain("Nothing to commit");
  });

  it("tells the pull request that background jobs will not run yet", async () => {
    const repo = await setup({
      facts: { ...nextFacts(), services: [{ kind: "queue", evidence: ["dependency:bullmq"] }] },
    });
    const github = new FakeGitHub();

    await runAdapt(repo.deps, { github });

    const body = github.created[0]?.body ?? "";
    expect(body).toContain("## Background jobs");
    expect(body).toContain("background jobs with BullMQ");
    expect(body).toContain("run the worker yourself");
  });

  it("tells the pull request which migration command every deploy runs", async () => {
    const repo = await setup();
    const plan = await readArtifact("plan", repo.deps.paths.files.plan);
    await writeArtifact("plan", repo.deps.paths.files.plan, {
      ...plan,
      app: { ...plan.app, releaseCommand: "npx prisma migrate deploy" },
    });
    const github = new FakeGitHub();

    await runAdapt(repo.deps, { github });

    const body = github.created[0]?.body ?? "";
    expect(body).toContain("## Database migrations");
    expect(body).toContain("Every deploy runs `npx prisma migrate deploy`");
    expect(body).toContain("app.releaseCommand");
  });

  it("says nothing about background jobs for an app without them", async () => {
    const repo = await setup();
    const github = new FakeGitHub();

    await runAdapt(repo.deps, { github });

    expect(github.created[0]?.body).not.toContain("Background jobs");
  });

  it("does not push without an origin remote", async () => {
    const repo = await setup({ remote: null });

    const result = await runAdapt(repo.deps, { github: new FakeGitHub() });

    expect(result.committed).toBe(true);
    expect(result.pushed).toBe(false);
    expect(repo.handler.requests.map((r) => r.kind)).toEqual(["repo-write"]);
    expect(repo.deps.reporter.text()).toContain("no `origin` remote");
  });

  it("explains how to open the pull request when no GitHub token is available", async () => {
    const repo = await setup();

    const result = await runAdapt(repo.deps);

    expect(result.pushed).toBe(true);
    expect(result.pullRequest).toBeUndefined();
    expect(repo.deps.reporter.text()).toContain("No GitHub token was found");
  });

  it("counts only real folders for outputFileTracingRoot (a ./ prefix adds no level)", async () => {
    const config = "const nextConfig = {};\nexport default nextConfig;\n";
    const changes = nextChanges()
      .filter((c) => c.kind === "build-config")
      .map((c) => ({ ...c, path: "./apps/web/next.config.mjs" }));
    const repo = await setup({
      agent: null,
      changes,
      files: { "apps/web/next.config.mjs": config },
    });

    const result = await runAdapt(repo.deps, { ai: false, push: false });

    expect(result.editedFiles).toEqual(["./apps/web/next.config.mjs"]);
    const edited = await readFile(join(repo.root, "apps", "web", "next.config.mjs"), "utf8");
    expect(edited).toContain('"../../"');
    expect(edited).not.toContain('"../../../"');
  });

  it("does not pick between two Next.js configs next to each other", async () => {
    const repo = await setup({
      agent: null,
      files: { "next.config.js": "module.exports = {};\n" },
    });

    const result = await runAdapt(repo.deps, { ai: false, push: false });

    expect(await readFile(join(repo.root, "next.config.mjs"), "utf8")).toBe(
      "const nextConfig = {};\nexport default nextConfig;\n",
    );
    expect(await readFile(join(repo.root, "next.config.js"), "utf8")).toBe(
      "module.exports = {};\n",
    );
    expect(result.editedFiles).toEqual([]);
    expect(await statusOf(repo)).toMatchObject({ "build-config": "pending" });
    const item = result.manual.find((m) => m.change.id === "build-config");
    expect(item?.instructions).toContain("next.config.mjs and next.config.js");
  });

  it("adds no second health route and no second output key when run again", async () => {
    const repo = await setup({ agent: null });
    const first = await runAdapt(repo.deps, { ai: false, push: false });
    expect(first.createdFiles).toContain("app/api/health/route.ts");
    const route = await readFile(join(repo.root, "app", "api", "health", "route.ts"), "utf8");

    // The pull request is merged into main; then `opscrew design` again: every change is
    // pending once more.
    await git(repo.env, repo.root, "checkout", "-q", "main");
    await git(repo.env, repo.root, "merge", "-q", "--ff-only", ADAPT_BRANCH);
    await writeArtifact("plan", repo.deps.paths.files.plan, makePlan(nextChanges()));
    await git(repo.env, repo.root, "commit", "-q", "-am", "design again");
    const second = await runAdapt(repo.deps, { ai: false, push: false });

    expect(second.branch).toBe(`${ADAPT_BRANCH}-2`);
    expect(second.createdFiles).toEqual([]);
    expect(second.editedFiles).toEqual([]);
    expect(await statusOf(repo)).toMatchObject({
      "health-endpoint": "skipped",
      "build-config": "skipped",
    });
    expect(second.notes["health-endpoint"]).toContain(
      "app/api/health/route.ts already answers /api/health",
    );
    expect(await readFile(join(repo.root, "app", "api", "health", "route.ts"), "utf8")).toBe(route);
    const config = await readFile(join(repo.root, "next.config.mjs"), "utf8");
    expect(config.match(/output:/g)).toHaveLength(1);
  });

  it("creates the pages router route in JavaScript and points at middleware", async () => {
    const changes = nextChanges().map((c) =>
      c.kind === "health-endpoint" ? { ...c, path: "pages/api/health.ts" } : c,
    );
    const repo = await setup({
      agent: null,
      changes,
      files: {
        "pages/index.js": "export default function Home() {\n  return null;\n}\n",
        "middleware.js": "export function middleware() {}\n",
      },
    });
    await git(repo.env, repo.root, "rm", "-q", "tsconfig.json", "app/page.tsx");
    await git(repo.env, repo.root, "commit", "-q", "-m", "pages router in JavaScript");

    const result = await runAdapt(repo.deps, { ai: false, push: false });

    expect(result.createdFiles).toContain("pages/api/health.js");
    const route = await readFile(join(repo.root, "pages", "api", "health.js"), "utf8");
    expect(route).toContain('res.status(200).json({ status: "ok" });');
    expect(await statusOf(repo)).toMatchObject({ "health-endpoint": "applied" });
    expect(result.notes["health-endpoint"]).toContain("middleware.js");
    expect(repo.deps.reporter.text()).toContain(
      "Check that middleware.js does not redirect or protect /api/health",
    );
  });

  it("names the route file really created in the note, the pull request and the commit", async () => {
    // Design saw TypeScript (route.ts), but the app folder has no tsconfig.json: route.js.
    const repo = await setup({ agent: null });
    await git(repo.env, repo.root, "rm", "-q", "tsconfig.json");
    await git(repo.env, repo.root, "commit", "-q", "-m", "no tsconfig");
    const github = new FakeGitHub();

    const result = await runAdapt(repo.deps, { ai: false, github });

    const real = "app/api/health/route.js";
    expect(result.createdFiles).toContain(real);
    expect(await exists(repo, "app/api/health/route.ts")).toBe(false);
    expect(result.notes["health-endpoint"]).toContain(`Created ${real} by OpsCrew`);
    const message = await git(repo.env, repo.root, "log", "-1", "--format=%B");
    expect(message).toContain(`- health-endpoint: ${real}`);
    expect(message).not.toContain("route.ts");
    const body = github.created[0]?.body ?? "";
    expect(body).toContain(`**Health endpoint** in \`${real}\` (applied by OpsCrew)`);
    expect(body).not.toContain("app/api/health/route.ts");
    // The plan keeps its own path as the change's id.
    const plan = await readArtifact("plan", repo.deps.paths.files.plan);
    expect(plan.codeChanges.find((c) => c.id === "health-endpoint")?.path).toBe(
      "app/api/health/route.ts",
    );
  });

  it("counts a health route inside a route group as existing", async () => {
    const grouped = "app/(api)/api/health/route.ts";
    const repo = await setup({
      agent: null,
      files: { [grouped]: "export function GET() {\n  return new Response('ok');\n}\n" },
    });

    const result = await runAdapt(repo.deps, { ai: false, push: false });

    expect(result.createdFiles).not.toContain("app/api/health/route.ts");
    expect(await exists(repo, "app/api/health/route.ts")).toBe(false);
    expect(await statusOf(repo)).toMatchObject({ "health-endpoint": "skipped" });
    expect(result.notes["health-endpoint"]).toBe(
      `${grouped} already answers /api/health; OpsCrew left it as it is.`,
    );
  });

  it("leaves the route to the user when the Next.js router is not clear", async () => {
    const repo = await setup({ agent: null });
    await git(repo.env, repo.root, "rm", "-q", "app/page.tsx");
    await git(repo.env, repo.root, "commit", "-q", "-m", "no router folder");

    const result = await runAdapt(repo.deps, { ai: false, push: false });

    expect(await exists(repo, "app/api/health/route.ts")).toBe(false);
    const item = result.manual.find((m) => m.change.id === "health-endpoint");
    expect(item?.instructions).toContain("no app/ folder");
    expect(repo.deps.reporter.text()).toContain(
      "Until GET /api/health answers 200, every deploy fails its health check and is rolled back.",
    );
  });

  it("says plainly that deploys fail their health check while an edit is left by hand", async () => {
    const facts: ProjectFacts = {
      ...nextFacts(),
      frameworks: [{ name: "express", version: "4.21.0", path: "." }],
      appKind: "api",
      build: { startCommand: "node server.js" },
    };
    const changes: CodeChange[] = [
      {
        id: "health-endpoint",
        kind: "health-endpoint",
        path: "server.js",
        reason: "The deploy checks /health.",
        status: "pending",
      },
    ];
    const repo = await setup({
      agent: null,
      facts,
      changes,
      healthPath: "/health",
      files: { "server.js": "require('express')().listen(3000);\n" },
    });

    const result = await runAdapt(repo.deps, { ai: false, push: false });

    expect(result.manual.map((m) => m.change.id)).toEqual(["health-endpoint"]);
    expect(repo.deps.reporter.text()).toContain(
      "Until GET /health answers 200, every deploy fails its health check and is rolled back.",
    );
  });

  describe("the health route of a code-routed app, without a model", () => {
    const facts: ProjectFacts = {
      ...nextFacts(),
      languages: ["javascript"],
      frameworks: [{ name: "express", version: "5.1.0", path: "." }],
      appKind: "api",
      build: { startCommand: "node server.js" },
    };
    const changes: CodeChange[] = [
      {
        id: "health-endpoint",
        kind: "health-endpoint",
        path: "server.js",
        reason: "The deploy checks /health.",
        status: "pending",
      },
    ];

    it("adds it to the file that creates the app and says so in the commit and pull request", async () => {
      const server =
        'const express = require("express");\nconst app = express();\napp.listen(3000);\n';
      const repo = await setup({
        agent: null,
        facts,
        changes,
        healthPath: "/health",
        files: { "server.js": server },
      });
      const github = new FakeGitHub();

      const result = await runAdapt(repo.deps, { ai: false, github });

      expect(result.editedFiles).toEqual(["server.js"]);
      expect(result.manual).toEqual([]);
      expect(await readFile(join(repo.root, "server.js"), "utf8")).toBe(
        'const express = require("express");\nconst app = express();\n\napp.get("/health", (_req, res) => {\n  res.json({ status: "ok" });\n});\n\napp.listen(3000);\n',
      );
      expect(await statusOf(repo)).toEqual({ "health-endpoint": "applied" });
      expect(await git(repo.env, repo.root, "log", "-1", "--format=%B")).toContain(
        "- health-endpoint: server.js",
      );
      const body = github.created[0]?.body ?? "";
      expect(body).toContain("in `server.js` (applied by OpsCrew)");
      expect(body).toContain(
        "Added GET /health to server.js by OpsCrew, right after the Express app is created",
      );
      expect(body).not.toContain("fails its health check");
    });

    it("names the reason in the pull request when it cannot tell where the route goes", async () => {
      const repo = await setup({
        agent: null,
        // No start command, so nothing says which of the two apps is served.
        facts: { ...facts, build: {} },
        changes,
        healthPath: "/health",
        files: {
          "server.js": 'const express = require("express");\nconst app = express();\n',
          "admin.js": 'const express = require("express");\nconst admin = express();\n',
        },
      });
      const github = new FakeGitHub();

      const result = await runAdapt(repo.deps, { ai: false, github });

      expect(result.editedFiles).toEqual([]);
      const reason =
        "OpsCrew found 2 app objects (Express in admin.js line 2 and Express in server.js line 2), so it cannot tell which one serves the app.";
      expect(result.manual[0]?.instructions).toContain(reason);
      const body = github.created[0]?.body ?? "";
      expect(body).toContain("in `server.js` (to do)");
      expect(body).toContain(`OpsCrew did not add it: ${reason}`);
      expect(body).toContain("Until GET /health answers 200, every deploy fails its health check");
    });
  });

  describe("a branch left on GitHub by an earlier run", () => {
    const OPEN = { number: 3, url: "https://github.com/acme/shop/pull/3" };
    /** Pushes `main` to `branch` on origin, as an earlier run did. */
    const leftOnOrigin = (repo: TestRepo, branch: string) =>
      git(repo.env, repo.root, "push", "-q", "origin", `main:refs/heads/${branch}`);

    it("stops before changing anything while its pull request is open", async () => {
      const repo = await setup();
      await leftOnOrigin(repo, ADAPT_BRANCH);
      const github = new FakeGitHub(OPEN);

      await expect(runAdapt(repo.deps, { github })).rejects.toMatchObject({
        code: "PHASE_PRECONDITION",
        message: expect.stringContaining(OPEN.url),
        hint: expect.stringContaining("Merge or close"),
      });
      expect(github.lookups).toEqual([`acme/shop:${ADAPT_BRANCH}`]);
      expect(await git(repo.env, repo.root, "branch", "--show-current")).toBe("main");
      expect(await git(repo.env, repo.root, "branch", "--list", "opscrew/*")).toBe("");
      expect(await exists(repo, "Dockerfile")).toBe(false);
      expect(repo.handler.requests).toHaveLength(0);
      expect(repo.runtime?.requests).toHaveLength(0);
      expect(github.created).toHaveLength(0);
      expect(await git(repo.env, repo.bare, "rev-parse", ADAPT_BRANCH)).toBe(repo.initialSha);
    });

    it("pushes to a new branch and opens the pull request when the old one is merged or closed", async () => {
      const repo = await setup();
      await leftOnOrigin(repo, ADAPT_BRANCH);
      await git(repo.env, repo.root, "branch", ADAPT_BRANCH);
      const github = new FakeGitHub();

      const result = await runAdapt(repo.deps, { github });

      const branch = `${ADAPT_BRANCH}-2`;
      expect(result.branch).toBe(branch);
      expect(result.pushed).toBe(true);
      expect(await git(repo.env, repo.bare, "rev-parse", branch)).toBe(result.commitSha);
      // The old branch is never touched.
      expect(await git(repo.env, repo.bare, "rev-parse", ADAPT_BRANCH)).toBe(repo.initialSha);
      expect(github.created).toEqual([expect.objectContaining({ head: branch, base: "main" })]);
      expect(result.pullRequest?.url).toBe("https://github.com/acme/shop/pull/7");
      const text = repo.deps.reporter.text();
      expect(text).toContain(
        `${ADAPT_BRANCH} is already on origin from an earlier run, and no pull request from it is open`,
      );
      expect(text).toContain(`Created branch ${branch} from main.`);
    });

    it("stops at the first branch whose pull request is still open", async () => {
      const repo = await setup();
      await leftOnOrigin(repo, ADAPT_BRANCH);
      await leftOnOrigin(repo, `${ADAPT_BRANCH}-2`);
      const github = new FakeGitHub(OPEN, [`${ADAPT_BRANCH}-2`]);

      await expect(runAdapt(repo.deps, { github })).rejects.toMatchObject({
        message: expect.stringContaining(`${ADAPT_BRANCH}-2`),
      });
      expect(await git(repo.env, repo.root, "branch", "--show-current")).toBe("main");
    });

    it("never reuses a branch on origin when it cannot check its pull request", async () => {
      const repo = await setup();
      await leftOnOrigin(repo, ADAPT_BRANCH);

      const result = await runAdapt(repo.deps);

      expect(result.branch).toBe(`${ADAPT_BRANCH}-2`);
      expect(result.pushed).toBe(true);
      const text = repo.deps.reporter.text();
      expect(text).toContain(`${ADAPT_BRANCH} is already on origin`);
      expect(text).toContain("No GitHub token was found");
    });

    it("warns and continues when origin cannot be checked", async () => {
      const repo = await setup({ approvals: [true, false] });
      await git(repo.env, repo.root, "remote", "set-url", "--push", "origin", `${repo.bare}-gone`);

      const result = await runAdapt(repo.deps, { github: new FakeGitHub() });

      expect(result.branch).toBe(ADAPT_BRANCH);
      expect(result.committed).toBe(true);
      expect(repo.deps.reporter.text()).toContain(
        "OpsCrew could not check origin for a branch left by an earlier run",
      );
    });

    it("with --no-push, only reads origin to name a branch the push is not refused on", async () => {
      const repo = await setup();
      await leftOnOrigin(repo, ADAPT_BRANCH);
      const github = new FakeGitHub(OPEN);

      const result = await runAdapt(repo.deps, { github, push: false });

      expect(result.branch).toBe(ADAPT_BRANCH);
      expect(result.committed).toBe(true);
      const command = `git push -u origin ${ADAPT_BRANCH}:${ADAPT_BRANCH}-2`;
      expect(result.pushCommand).toBe(command);
      expect(repo.deps.reporter.text()).toContain(
        `${ADAPT_BRANCH} is already on origin from an earlier run, so push this commit to a new branch when you are ready: \`${command}\`.`,
      );
      expect(github.lookups).toEqual([]);
      expect(repo.handler.requests.map((r) => r.kind)).toEqual(["repo-write"]);
      expect(await remoteBranches(repo)).toBe(ADAPT_BRANCH);
      expect(await git(repo.env, repo.bare, "rev-parse", ADAPT_BRANCH)).toBe(repo.initialSha);
    });

    it("with --no-push, names the plain push when origin does not have the branch", async () => {
      const repo = await setup();

      const result = await runAdapt(repo.deps, { push: false });

      expect(result.pushCommand).toBe(`git push -u origin ${ADAPT_BRANCH}`);
      expect(repo.deps.reporter.text()).toContain(
        `Not pushed (--no-push). When you are ready: \`git push -u origin ${ADAPT_BRANCH}\`. Then open a pull request.`,
      );
    });

    it("says what to do when the push is refused after origin could not be checked", async () => {
      const repo = await setup();
      // An earlier run's branch with other commits; origin cannot be read when adapt starts.
      await git(repo.env, repo.root, "commit", "-q", "--allow-empty", "-m", "elsewhere");
      await leftOnOrigin(repo, ADAPT_BRANCH);
      await git(repo.env, repo.root, "push", "-q", "origin", `HEAD:refs/heads/${ADAPT_BRANCH}`);
      await git(repo.env, repo.root, "reset", "-q", "--hard", repo.initialSha);
      const runner = repo.runner as unknown as {
        run: (c: string, a: readonly string[], o?: object) => Promise<unknown>;
      };
      const real = runner.run.bind(repo.runner);
      runner.run = async (command, args, options) =>
        args.includes("ls-remote")
          ? { exitCode: 128, stdout: "", stderr: "fatal: unable to access origin" }
          : real(command, args, options);

      const error = await runAdapt(repo.deps, { github: new FakeGitHub() }).catch(
        (e: unknown) => e,
      );

      expect(error).toMatchObject({
        code: "COMMAND_FAILED",
        message: expect.stringContaining(
          `on ${ADAPT_BRANCH}, but the push to origin failed: git push failed`,
        ),
        hint: expect.stringContaining(
          `Push the commit to a free branch name yourself with \`git push -u origin ${ADAPT_BRANCH}:<new name>\``,
        ),
      });
      expect((error as { hint: string }).hint).toContain(
        "Once origin is reachable, run `opscrew adapt` again on this branch",
      );
      expect((await repo.deps.state.read()).phases.adapt?.status).toBe("failed");

      // Origin is reachable again: the re-run pushes that commit to a free name and opens the PR.
      runner.run = real;
      const sha = await git(repo.env, repo.root, "rev-parse", "HEAD");
      const github = new FakeGitHub();
      const again = await runAdapt(repo.deps, { github });

      const branch = `${ADAPT_BRANCH}-2`;
      expect(again).toMatchObject({ branch, pushed: true, commitSha: sha, baseBranch: "main" });
      expect(await git(repo.env, repo.root, "branch", "--show-current")).toBe(branch);
      expect(await git(repo.env, repo.bare, "rev-parse", branch)).toBe(sha);
      expect(github.created).toEqual([expect.objectContaining({ head: branch, base: "main" })]);
      expect(github.created[0]?.body).toContain("Production Dockerfile");
      expect(repo.deps.reporter.text()).not.toContain("Nothing to commit");
      expect(repo.deps.reporter.text()).toContain(`Renamed ${ADAPT_BRANCH} to ${branch}`);
      expect(repo.handler.requests.map((r) => r.kind)).toEqual([
        "repo-write",
        "git-push",
        "git-push",
        "pull-request",
      ]);
    });

    it("on the branch of an unpushed OpsCrew commit, --no-push says how to push it", async () => {
      const repo = await setup({ approvals: [true, false] });
      const first = await runAdapt(repo.deps, { github: new FakeGitHub() });
      expect(first.pushed).toBe(false);

      await expect(runAdapt(repo.deps, { push: false })).rejects.toMatchObject({
        code: "PHASE_PRECONDITION",
        message: expect.stringContaining(
          `You are on ${ADAPT_BRANCH}, and OpsCrew's commit ${first.commitSha?.slice(0, 7)} on it is not on origin yet`,
        ),
        hint: expect.stringContaining(`\`git push -u origin ${ADAPT_BRANCH}\``),
      });
      expect(await git(repo.env, repo.root, "branch", "--list", "opscrew/*")).toBe(
        `* ${ADAPT_BRANCH}`,
      );
    });
  });

  it("requires the plan", async () => {
    const repo = await setup();
    await writeFile(repo.deps.paths.files.plan, "");
    await expect(runAdapt(repo.deps)).rejects.toMatchObject({ code: "ARTIFACT_INVALID" });
  });
});
