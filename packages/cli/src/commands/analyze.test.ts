import { readFile } from "node:fs/promises";
import { CostLedger, ProjectStateStore, resolveProjectPaths } from "@opscrew/core";
import { FakeAgentRuntime } from "@opscrew/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import { MODEL_SETUP_HINT } from "../deps";
import { projectContext, run, type TempProject, tempProject } from "../ui/__fixtures__/harness";

let project: TempProject | undefined;
afterEach(async () => {
  await project?.cleanup();
  project = undefined;
});

const analystOutput = {
  summary: "A Next.js shop that stores orders in PostgreSQL.",
  risks: ["Card payments need a webhook secret in production."],
};

describe("opscrew analyze", () => {
  it("writes the deterministic analysis with --no-ai and never calls the model", async () => {
    project = await tempProject("nextjs-postgres");
    const runtime = new FakeAgentRuntime({ phases: { analyze: { output: analystOutput } } });
    const ctx = projectContext(project, { services: { runtime } });
    expect(await run(ctx, "analyze", "--no-ai")).toBe(0);

    expect(runtime.requests).toHaveLength(0);
    const paths = resolveProjectPaths(project.root, { env: project.env });
    const architecture = JSON.parse(await readFile(paths.files.architecture, "utf8"));
    expect(architecture.aiEnriched).toBe(false);
    expect(architecture.facts.appKind).toBe("ssr");
    await expect(readFile(paths.files.architectureMd, "utf8")).resolves.toContain("#");
    expect(ctx.output).toContain(architecture.summary.trim().split("\n")[0]);
    expect(ctx.output).not.toContain("Model cost");
    expect(ctx.output).not.toContain(MODEL_SETUP_HINT);
    expect(ctx.output).toContain("opscrew interview");
    const state = await new ProjectStateStore(paths.files.state).read();
    expect(state.phases.analyze?.status).toBe("ok");
  });

  it("lets the Analyst refine the result and prints the model cost", async () => {
    project = await tempProject("nextjs-postgres");
    const runtime = new FakeAgentRuntime({
      phases: { analyze: { output: analystOutput, costUsd: 0.0215, model: "claude-test" } },
    });
    const ctx = projectContext(project, { services: { runtime } });
    expect(await run(ctx, "analyze", "--model", "claude-test")).toBe(0);

    expect(runtime.requests).toHaveLength(1);
    expect(runtime.requests[0]?.model).toBe("claude-test");
    expect(runtime.requests[0]?.profile).toBe("read-only");
    expect(ctx.output).toContain(analystOutput.summary);
    expect(ctx.output).toContain("Card payments need a webhook secret");
    expect(ctx.output).toContain(
      "Model cost: $0.0215 for this run; $0.0215 in total for this project.",
    );
    const paths = resolveProjectPaths(project.root, { env: project.env });
    expect(await new CostLedger(paths.files.costs).total()).toBeCloseTo(0.0215);
  });

  it("uses OPSCREW_MODEL when --model is not given", async () => {
    project = await tempProject("nextjs-postgres");
    const runtime = new FakeAgentRuntime({ phases: { analyze: { output: analystOutput } } });
    project.env.OPSCREW_MODEL = "claude-from-env";
    const ctx = projectContext(project, { services: { runtime } });
    expect(await run(ctx, "analyze")).toBe(0);
    expect(runtime.requests[0]?.model).toBe("claude-from-env");
  });

  it("explains how to configure a model when none is configured", async () => {
    project = await tempProject("static-vite");
    const ctx = projectContext(project);
    expect(await run(ctx, "analyze")).toBe(0);
    expect(ctx.output).toContain(MODEL_SETUP_HINT);
    expect(ctx.output).not.toContain("Model cost");
  });
});
