import { readFile } from "node:fs/promises";
import path from "node:path";
import { makeRequirements, nextPostgresFacts, testPlan } from "@opscrew/agents/testing";
import { exists } from "@opscrew/core";
import { readArtifact, writeArtifact } from "@opscrew/plan-schema";
import { afterEach, describe, expect, it } from "vitest";
import { inEnvironment, planFile, withEnvironments } from "../ui/__fixtures__/environments";
import {
  projectContext,
  run,
  ScriptedPrompts,
  type TempProject,
  tempProject,
} from "../ui/__fixtures__/harness";
import type { UiChoice, UiPrompts } from "../ui/prompts";

/** Prompts that take every question's default, recording what was asked. */
class DefaultPrompts implements UiPrompts {
  readonly messages: string[] = [];
  async select(options: { message: string; options: UiChoice[]; initialValue?: string }) {
    this.messages.push(options.message);
    return options.initialValue ?? options.options[0]?.value ?? "";
  }
  async multiselect(options: { message: string; initialValues?: string[] }) {
    this.messages.push(options.message);
    return options.initialValues ?? [];
  }
  async text(options: { message: string; initialValue?: string }) {
    this.messages.push(options.message);
    return options.initialValue ?? "";
  }
  async confirm(options: { message: string; initialValue?: boolean }) {
    this.messages.push(options.message);
    return options.initialValue ?? false;
  }
  async password(options: { message: string }): Promise<string> {
    throw new Error(`No secret is asked here: ${options.message}`);
  }
  isCancel(_value: unknown): _value is symbol {
    return false;
  }
}

let project: TempProject | undefined;
afterEach(async () => {
  await project?.cleanup();
  project = undefined;
});

describe("opscrew env list", () => {
  it("shows each environment: where it runs, how it gets new versions, its runner, deployed or not", async () => {
    const prod = testPlan();
    project = await withEnvironments({
      staging: inEnvironment(prod, "staging", {
        deploySource: { from: "promote", source: "prod" },
      }),
    });
    const ctx = projectContext(project);
    expect(await run(ctx, "env", "list"), ctx.errors).toBe(0);
    const lines = ctx.output.trim().split("\n");
    expect(lines[0]).toMatch(/^Environment\s+Runs on\s+New versions\s+Deploy job\s+Deployed$/);
    expect(lines[1]).toMatch(/^prod\s+hetzner\s+each push\s+GitHub's machines\s+yes$/);
    expect(lines[2]).toMatch(/^staging\s+hetzner\s+promoted from prod\s+GitHub's machines\s+no$/);
  });
});

describe("opscrew env set", () => {
  it("changes the deploy source in the environment's plan and names its provision", async () => {
    project = await withEnvironments({ staging: inEnvironment(testPlan(), "staging") });
    const ctx = projectContext(project);
    expect(await run(ctx, "env", "set", "staging", "--from", "prod"), ctx.errors).toBe(0);
    const plan = await readArtifact("plan", planFile(project.root, "staging"));
    expect(plan.environment?.deploySource).toEqual({ from: "promote", source: "prod" });
    expect(ctx.output).toContain("is deployed only by `opscrew promote --to staging`");
    expect(ctx.output).toContain("run `opscrew provision --env staging`");
  });

  it("refuses the environment itself as its source, and changes nothing", async () => {
    project = await withEnvironments({ staging: inEnvironment(testPlan(), "staging") });
    const before = await readFile(planFile(project.root, "staging"), "utf8");
    const ctx = projectContext(project);
    expect(await run(ctx, "env", "set", "staging", "--from", "staging")).not.toBe(0);
    expect(ctx.errors).toContain("cannot be promoted from itself");
    expect(await readFile(planFile(project.root, "staging"), "utf8")).toBe(before);
  });
});

describe("opscrew env remove", () => {
  it("in a script, removes an environment that is not deployed only with --confirm <name>", async () => {
    project = await withEnvironments({ staging: inEnvironment(testPlan(), "staging") });
    const bare = projectContext(project);
    expect(await run(bare, "env", "remove", "staging")).not.toBe(0);
    expect(bare.errors).toContain("`opscrew env remove staging --confirm staging`");
    expect(await exists(planFile(project.root, "staging"))).toBe(true);
    const wrong = projectContext(project);
    expect(await run(wrong, "env", "remove", "staging", "--confirm", "prod")).not.toBe(0);
    expect(await exists(planFile(project.root, "staging"))).toBe(true);
    const ctx = projectContext(project);
    expect(await run(ctx, "env", "remove", "staging", "--confirm", "staging"), ctx.errors).toBe(0);
    expect(await exists(planFile(project.root, "staging"))).toBe(false);
    expect(ctx.output).toContain("Removed the staging environment's files");
  });

  it("in a terminal, removes it only once its name is typed back", async () => {
    project = await withEnvironments({ staging: inEnvironment(testPlan(), "staging") });
    const typo = projectContext(project, {
      interactive: true,
      services: { prompts: new ScriptedPrompts(["stagin"]) },
    });
    expect(await run(typo, "env", "remove", "staging")).not.toBe(0);
    expect(typo.output).toContain("its deploy key, state passphrase and generated secrets");
    expect(await exists(planFile(project.root, "staging"))).toBe(true);
    const ctx = projectContext(project, {
      interactive: true,
      services: { prompts: new ScriptedPrompts(["staging"]) },
    });
    expect(await run(ctx, "env", "remove", "staging"), ctx.errors).toBe(0);
    expect(await exists(planFile(project.root, "staging"))).toBe(false);
  });

  it("refuses while it is deployed, with destroy --env first", async () => {
    project = await withEnvironments({
      staging: inEnvironment(testPlan({ deployed: true }), "staging"),
    });
    const ctx = projectContext(project);
    expect(await run(ctx, "env", "remove", "staging", "--confirm", "staging")).not.toBe(0);
    expect(ctx.errors).toContain("`opscrew destroy --env staging`");
    expect(await exists(planFile(project.root, "staging"))).toBe(true);
  });
});

describe("opscrew env add", () => {
  /** A designed prod app: its facts, its answers and its plan. */
  async function prodApp(): Promise<TempProject> {
    const created = await tempProject();
    await writeArtifact("architecture", path.join(created.root, "opscrew", "architecture.json"), {
      schemaVersion: 1,
      generatedAt: "2026-10-11T10:00:00.000Z",
      generator: { tool: "opscrew", version: "0.0.0-test" },
      facts: nextPostgresFacts({ name: "shop" }),
      summary: "A shop.",
      risks: [],
      aiEnriched: false,
    });
    await writeArtifact(
      "requirements",
      path.join(created.root, "opscrew", "requirements.yaml"),
      makeRequirements(),
    );
    const ctx = projectContext(created);
    expect(await run(ctx, "design"), ctx.errors).toBe(0);
    return created;
  }

  it("in a script, takes its flags and the defaults, designs it and names its provision", async () => {
    project = await prodApp();
    const ctx = projectContext(project);
    expect(await run(ctx, "env", "add", "staging", "--from", "prod"), ctx.errors).toBe(0);
    const plan = await readArtifact("plan", planFile(project.root, "staging"));
    expect(plan.app.name).toBe("shop-staging");
    expect(plan.environment).toMatchObject({
      name: "staging",
      deploySource: { from: "promote", source: "prod" },
      runner: "github",
    });
    expect(ctx.output).toContain("opscrew provision --env staging");
  });

  it("in a terminal, asks only what its flags leave open", async () => {
    project = await prodApp();
    const prompts = new DefaultPrompts();
    const ctx = projectContext(project, { interactive: true, services: { prompts } });
    expect(await run(ctx, "env", "add", "staging", "--runner", "server"), ctx.errors).toBe(0);
    const asked = prompts.messages.join("\n");
    expect(asked).toContain("Where should the staging environment run?");
    expect(asked).toContain("How should the staging environment get new versions?");
    expect(asked).not.toContain("deploy job run?");
    const plan = await readArtifact("plan", planFile(project.root, "staging"));
    expect(plan.environment?.runner).toBe("server");
  });
});
