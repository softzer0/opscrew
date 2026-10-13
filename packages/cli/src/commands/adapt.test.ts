import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ApprovalDecision, ApprovalHandler, ApprovalRequest } from "@opscrew/contracts";
import { FakeAgentRuntime } from "@opscrew/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import type { CliServices } from "../deps";
import {
  GIT,
  git,
  projectContext,
  run,
  type TempProject,
  tempProject,
} from "../ui/__fixtures__/harness";

let project: TempProject | undefined;
afterEach(async () => {
  await project?.cleanup();
  project = undefined;
});

/** Approves everything and records the requests (the scripted human). */
class ApproveAll implements ApprovalHandler {
  readonly requests: ApprovalRequest[] = [];
  async request(request: ApprovalRequest): Promise<ApprovalDecision> {
    this.requests.push(request);
    return { approved: true, approver: "test", decidedAt: "2026-10-11T12:00:00.000Z" };
  }
}

const ANSWERS = [
  "expectedMonthlyUsers: <1k",
  "budgetMonthly: 30 EUR",
  "region: eu-central",
  "uptime: standard",
  "dataCriticality: important",
  "",
].join("\n");

/** nextjs-postgres in a git repository with one commit, analysed, interviewed and designed. */
async function planned(): Promise<TempProject> {
  const p = await tempProject("nextjs-postgres");
  await git(p.env, p.root, "init", "-q", "-b", "main");
  await git(p.env, p.root, "add", "-A");
  await git(p.env, p.root, "commit", "-q", "-m", "initial");
  await writeFile(path.join(p.dir, "answers.yaml"), ANSWERS);
  const ctx = projectContext(p);
  expect(await run(ctx, "analyze", "--no-ai")).toBe(0);
  expect(await run(ctx, "interview", "--answers", path.join(p.dir, "answers.yaml"))).toBe(0);
  expect(await run(ctx, "design")).toBe(0);
  return p;
}

const exists = (file: string) =>
  stat(file).then(
    () => true,
    () => false,
  );

describe.skipIf(GIT === undefined)("opscrew adapt", () => {
  it("writes the templates and commits after approval with --no-ai --no-push", async () => {
    project = await planned();
    const approvals = new ApproveAll();
    const runtime = new FakeAgentRuntime();
    const services: CliServices = { approvalHandler: approvals, runtime };
    const ctx = projectContext(project, { services });
    expect(await run(ctx, "adapt", "--no-ai", "--no-push")).toBe(0);

    expect(runtime.requests).toHaveLength(0);
    expect(await exists(path.join(project.root, "Dockerfile"))).toBe(true);
    expect(await exists(path.join(project.root, ".dockerignore"))).toBe(true);
    expect(await git(project.env, project.root, "branch", "--show-current")).toBe(
      "opscrew/prepare-deploy",
    );
    expect(await git(project.env, project.root, "log", "-1", "--format=%s")).toBe(
      "chore(opscrew): prepare app for deployment",
    );
    expect(approvals.requests.map((r) => r.kind)).toEqual(["repo-write"]);
    // Without a model OpsCrew makes the Next.js changes itself: nothing is left to do by hand.
    expect(await exists(path.join(project.root, "app", "api", "health", "route.ts"))).toBe(true);
    expect(ctx.output).not.toContain("still to make by hand");
    expect(ctx.output).toContain("git push -u origin opscrew/prepare-deploy");
    expect(ctx.output).toContain("opscrew provision");
    expect(ctx.output).not.toContain("Model cost");
    const plan = await readFile(path.join(project.root, "opscrew", "plan.yaml"), "utf8");
    expect(plan).toMatch(/status: applied/);
  });

  it("runs the Code-change agent when a model is configured and prints its cost", async () => {
    project = await planned();
    // A health path other than /api/health leaves the route to the Code-change agent.
    const planFile = path.join(project.root, "opscrew", "plan.yaml");
    const plan = await readFile(planFile, "utf8");
    expect(plan).toContain("healthPath: /api/health");
    await writeFile(planFile, plan.replace("healthPath: /api/health", "healthPath: /healthz"));
    const runtime = new FakeAgentRuntime({
      phases: { adapt: { output: { changes: [] }, costUsd: 0.75, model: "claude-test" } },
    });
    const ctx = projectContext(project, {
      services: { approvalHandler: new ApproveAll(), runtime },
    });
    expect(await run(ctx, "adapt", "--no-push", "--model", "claude-test")).toBe(0);

    expect(runtime.requests).toHaveLength(1);
    expect(runtime.requests[0]?.profile).toBe("edit-repo");
    expect(runtime.requests[0]?.model).toBe("claude-test");
    expect(ctx.output).toContain(
      "Model cost: $0.7500 for this run; $0.7500 in total for this project.",
    );
  });

  it("leaves the changes uncommitted when no one can approve the commit", async () => {
    project = await planned();
    const ctx = projectContext(project);
    expect(await run(ctx, "adapt", "--no-ai", "--no-push")).toBe(0);
    expect(ctx.errors).toContain("Nothing was committed");
    expect(ctx.output).toContain("review the changes on opscrew/prepare-deploy");
    expect(await git(project.env, project.root, "log", "-1", "--format=%s")).toBe("initial");
  });

  it("commits without prompts in a non-interactive run with --yes", async () => {
    project = await planned();
    const ctx = projectContext(project);
    expect(await run(ctx, "adapt", "--no-ai", "--no-push", "--yes")).toBe(0);
    expect(await git(project.env, project.root, "log", "-1", "--format=%s")).not.toBe("initial");
  });

  it("refuses to start on a dirty working tree", async () => {
    project = await planned();
    await writeFile(path.join(project.root, "README.md"), "changed\n");
    const ctx = projectContext(project, { services: { approvalHandler: new ApproveAll() } });
    expect(await run(ctx, "adapt", "--no-ai", "--no-push")).toBe(1);
    expect(ctx.errors).toContain("The working tree has uncommitted changes");
    expect(ctx.errors).toContain("git stash -u");
  });
});
