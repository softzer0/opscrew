import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PhaseRequest } from "@opscrew/contracts";
import { FakeAgentRuntime, type FakePhaseResponse } from "@opscrew/core/testing";
import { readArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { ScriptedApprovalHandler } from "../testing";
import {
  createTestRepo,
  FakeGitHub,
  GIT,
  git,
  nextChanges,
  type TestRepo,
  type TestRepoOptions,
} from "./__fixtures__/repo";
import {
  ADAPT_BRANCH,
  ADAPT_COMMIT_SUBJECT,
  PULL_REQUEST_FOOTER,
  PULL_REQUEST_TITLE,
  runAdapt,
} from "./index";

const HEALTH_ROUTE = 'export function GET() {\n  return Response.json({ status: "ok" });\n}\n';

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
          await mkdir(join(root, "app", "api", "health"), { recursive: true });
          await writeFile(join(root, "app", "api", "health", "route.ts"), HEALTH_ROUTE);
          await writeFile(
            join(root, "lib", "stripe.ts"),
            "export const stripeKey = process.env.STRIPE_SECRET_KEY;\n",
          );
          return {
            costUsd: 0.42,
            model: "claude-opus-5-5",
            output: {
              changes: [
                { id: "health-endpoint", status: "applied", notes: "Added the app router route." },
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
    expect(result.createdFiles).toEqual(["Dockerfile", ".dockerignore", ".env.example"]);
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
    expect(request?.prompt).toContain("health-endpoint");
    expect(request?.prompt).toContain("app/api/health/route.ts");
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
    expect(pr?.body).toContain("in `app/api/health/route.ts` (applied):");
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
    expect(result.createdFiles).toEqual([".dockerignore", ".env.example"]);
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
    expect(result.manual.map((m) => m.change.id)).toEqual(["health-endpoint", "secret-removal-1"]);
    expect(result.manual[0]?.instructions).toContain("app/api/health/route.ts");
    expect(await statusOf(repo)).toMatchObject({
      dockerfile: "applied",
      "health-endpoint": "pending",
      "build-config": "applied",
    });
    // Without a model, the standalone output is still set, and committed.
    expect(await readFile(join(repo.root, "next.config.mjs"), "utf8")).toContain(
      'output: "standalone"',
    );
    const committed = await git(repo.env, repo.root, "show", "--name-only", "--format=", "HEAD");
    expect(committed.split("\n")).toContain("next.config.mjs");
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
    const repo = await setup({ agent });

    const result = await runAdapt(repo.deps, { push: false });

    expect(await statusOf(repo)).toMatchObject({
      dockerfile: "applied",
      "health-endpoint": "pending",
      "secret-removal-1": "pending",
    });
    expect(result.manual).toHaveLength(2);
    expect(repo.deps.reporter.text()).toContain("did not finish");
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
    const repo = await setup({ agent });

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

  it("requires the plan", async () => {
    const repo = await setup();
    await writeFile(repo.deps.paths.files.plan, "");
    await expect(runAdapt(repo.deps)).rejects.toMatchObject({ code: "ARTIFACT_INVALID" });
  });
});
