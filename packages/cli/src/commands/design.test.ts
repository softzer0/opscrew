import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveProjectPaths } from "@opscrew/core";
import { afterEach, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import {
  CANCEL,
  projectContext,
  run,
  ScriptedPrompts,
  type TempProject,
  tempProject,
} from "../ui/__fixtures__/harness";
import { RECOMMENDED_MARKER } from "../ui/options";

let project: TempProject | undefined;
afterEach(async () => {
  await project?.cleanup();
  project = undefined;
});

const ANSWERS = [
  "expectedMonthlyUsers: <1k",
  "budgetMonthly: 30 EUR",
  "region: eu-central",
  "uptime: standard",
  "dataCriticality: important",
  "",
].join("\n");

/** A project with architecture.json and requirements.yaml written. */
async function prepared(example = "nextjs-postgres"): Promise<TempProject> {
  const p = await tempProject(example);
  await writeFile(path.join(p.dir, "answers.yaml"), ANSWERS);
  const ctx = projectContext(p);
  expect(await run(ctx, "analyze", "--no-ai")).toBe(0);
  expect(await run(ctx, "interview", "--answers", path.join(p.dir, "answers.yaml"))).toBe(0);
  return p;
}

async function planOf(p: TempProject) {
  const paths = resolveProjectPaths(p.root, { env: p.env });
  return parse(await readFile(paths.files.plan, "utf8"));
}

/** Option ids listed by a non-interactive run. */
function optionIds(output: string): string[] {
  return [...output.matchAll(/\((hetzner-[a-z0-9-]+)\): /g)].map((m) => m[1] as string);
}

describe("opscrew design", () => {
  it("uses the recommended option without a terminal and lists the others", async () => {
    project = await prepared();
    const ctx = projectContext(project);
    expect(await run(ctx, "design")).toBe(0);

    const plan = await planOf(project);
    expect(ctx.output).toContain(`Chose the recommended option, `);
    expect(ctx.output).toContain("opscrew design --option <id>");
    expect(ctx.output).toContain("opscrew adapt");
    expect(ctx.errors).toContain("HCLOUD_TOKEN is not set");
    expect(plan.codeChanges.length).toBeGreaterThan(0);
    // No live prices without a token: the fake fetch was never called.
    expect(ctx.fetchUrls).toEqual([]);
  });

  it("shows each component with its memory and its share of the server's price", async () => {
    project = await prepared();
    const ctx = projectContext(project);
    expect(await run(ctx, "design")).toBe(0);
    const shown = `${ctx.output}\n${ctx.errors}`;
    expect(shown).toMatch(/PostgreSQL 17 \(db, 512 MB\): /);
    expect(shown).toMatch(/Memory limits: the app 512 MB \(€\d+\.\d\d\/month\), db 512 MB \(€/);
  });

  it("takes --option <id>", async () => {
    project = await prepared();
    const first = projectContext(project);
    expect(await run(first, "design")).toBe(0);
    const ids = optionIds(first.output);
    expect(ids.length).toBeGreaterThanOrEqual(2);
    const other = ids[ids.length - 1] as string;

    const ctx = projectContext(project);
    expect(await run(ctx, "design", "--option", other)).toBe(0);
    expect(ctx.output).not.toContain("Chose the recommended option");
    const plan = await planOf(project);
    expect(JSON.stringify(plan)).toContain(other.split("-")[2] as string);
  });

  it("shows the builder, the deploy strategy and the supply-chain settings with their reasons", async () => {
    project = await prepared();
    const ctx = projectContext(project);
    expect(await run(ctx, "design")).toBe(0);
    expect(ctx.output).toContain("Image builder: generated-dockerfile. OpsCrew has a Dockerfile");
    expect(ctx.output).toContain("Deploys: rolling. New versions start next to the running one");
    expect(ctx.output).toContain("  Image signing: off (the default).");
    expect(ctx.output).toContain("  Deploy tags: off (the default).");
    expect(ctx.output).toContain("  Image retention: keeps the newest 10 deployed images");
    // Before the next step.
    expect(ctx.output.indexOf("Image retention:")).toBeLessThan(
      ctx.output.indexOf("Next: run `opscrew adapt`"),
    );
  });

  it("keeps the builder, strategy and supply-chain settings set in plan.yaml", async () => {
    project = await prepared();
    expect(await run(projectContext(project), "design")).toBe(0);
    const paths = resolveProjectPaths(project.root, { env: project.env });
    const plan = await planOf(project);
    plan.app.build = { ...plan.app.build, builder: "railpack", chosen: "user" };
    plan.deploy = { strategy: "recreate", drainSeconds: 45 };
    plan.supplyChain = { sign: true };
    plan.cicd.deployTags = { enabled: true, release: false };
    plan.cicd.imageRetention = { enabled: true, keep: 5 };
    await writeFile(paths.files.plan, stringify(plan));

    const ctx = projectContext(project);
    expect(await run(ctx, "design")).toBe(0);
    const kept = await planOf(project);
    expect(kept.app.build).toMatchObject({ builder: "railpack", chosen: "user" });
    expect(kept.deploy).toMatchObject({ strategy: "recreate", drainSeconds: 45 });
    expect(kept.supplyChain).toEqual({ sign: true });
    expect(kept.cicd.deployTags).toEqual({ enabled: true, release: false });
    expect(kept.cicd.imageRetention).toEqual({ enabled: true, keep: 5 });
    expect(ctx.output).toContain(
      "Image builder: railpack. You chose Railpack in opscrew/plan.yaml (app.build.builder).",
    );
    expect(ctx.output).toContain(
      "Deploys: recreate. You chose recreate in opscrew/plan.yaml (deploy.strategy).",
    );
    expect(ctx.output).toContain("  Image signing: on.");
    expect(ctx.output).toContain("  Deploy tags: on. Each healthy deploy tags its commit");
    expect(ctx.output).toContain("  Image retention: keeps the newest 5 deployed images");
  });

  it("fails with the valid ids for an unknown --option", async () => {
    project = await prepared();
    const ctx = projectContext(project);
    expect(await run(ctx, "design", "--option", "nope")).toBe(2);
    expect(ctx.errors).toContain('There is no design option "nope".');
    expect(ctx.errors).toContain("Choose one of: hetzner-");
  });

  it("shows the cost table in a terminal and plans the chosen option", async () => {
    project = await prepared();
    const probe = projectContext(project);
    expect(await run(probe, "design")).toBe(0);
    const ids = optionIds(probe.output);
    const choice = ids[ids.length - 1] as string;

    const prompts = new ScriptedPrompts([choice]);
    const ctx = projectContext(project, { interactive: true, services: { prompts } });
    expect(await run(ctx, "design")).toBe(0);
    expect(ctx.output).toContain("Your budget: €30.00 per month");
    expect(ctx.output).toContain(RECOMMENDED_MARKER);
    expect(ctx.output).toMatch(/Per month\s+Budget/);
    expect(ctx.output).toContain("Prices: ");
    const call = prompts.calls[0];
    expect(call?.kind).toBe("select");
    expect(call?.options?.map((o) => o.value)).toEqual(ids);
    expect(call?.initial).not.toBe(choice);
    expect(ctx.output).not.toContain("Chose the recommended option");
    expect(ctx.output).toContain(`Wrote opscrew/plan.yaml`);
  });

  it("writes no plan when the choice is cancelled", async () => {
    project = await prepared();
    const prompts = new ScriptedPrompts([CANCEL]);
    const ctx = projectContext(project, { interactive: true, services: { prompts } });
    expect(await run(ctx, "design")).toBe(1);
    expect(ctx.errors).toContain("You cancelled the choice");
    await expect(planOf(project)).rejects.toThrow();
  });

  it("asks for the earlier steps when they have not run", async () => {
    project = await tempProject("static-vite");
    const ctx = projectContext(project);
    expect(await run(ctx, "design")).toBe(1);
    expect(ctx.errors).toMatch(/architecture\.json/);
  });
});
