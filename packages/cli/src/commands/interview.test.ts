import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveProjectPaths } from "@opscrew/core";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  CANCEL,
  projectContext,
  run,
  ScriptedPrompts,
  type TempProject,
  tempProject,
} from "../ui/__fixtures__/harness";

let project: TempProject | undefined;
afterEach(async () => {
  await project?.cleanup();
  project = undefined;
});

const ANSWERS = [
  "expectedMonthlyUsers: 1k-10k",
  "budgetMonthly: 20 EUR",
  "region: eu-central",
  "uptime: standard",
  "dataCriticality: important",
  "domain: https://Shop.Example.com/",
  "dnsProvider: cloudflare",
  "",
].join("\n");

async function requirementsOf(root: string, env: Record<string, string | undefined>) {
  const paths = resolveProjectPaths(root, { env });
  return parse(await readFile(paths.files.requirements, "utf8"));
}

describe("opscrew interview", () => {
  it("reads the answers from --answers and writes requirements.yaml", async () => {
    project = await tempProject("nextjs-postgres");
    await writeFile(path.join(project.dir, "answers.yaml"), ANSWERS);
    const ctx = projectContext(project);
    expect(await run(ctx, "analyze", "--no-ai")).toBe(0);
    expect(await run(ctx, "interview", "--answers", "../answers.yaml")).toBe(0);

    const requirements = await requirementsOf(project.root, project.env);
    expect(requirements.expectedMonthlyUsers).toBe("1k-10k");
    expect(requirements.budgetMonthly).toEqual({ amount: 20, currency: "EUR" });
    expect(requirements.domain).toBe("shop.example.com");
    expect(ctx.output).toContain("Budget: 20 EUR per month");
    expect(ctx.output).toContain("opscrew design");
  });

  it("asks the questions in a terminal, pre-filling defaults", async () => {
    project = await tempProject("nextjs-postgres");
    const prompts = new ScriptedPrompts([
      "<1k", // users
      "15 USD", // budget
      "us-east", // region
      "best-effort", // uptime
      "none", // data criticality
      "", // no domain, so the DNS provider question is skipped
    ]);
    const ctx = projectContext(project, { interactive: true, services: { prompts } });
    expect(await run(ctx, "interview")).toBe(0);

    expect(prompts.calls.map((call) => call.kind)).toEqual([
      "select",
      "text",
      "select",
      "select",
      "select",
      "text",
    ]);
    expect(prompts.calls[0]?.initial).toBe("<1k");
    expect(prompts.calls[0]?.options?.length).toBeGreaterThan(1);
    const requirements = await requirementsOf(project.root, project.env);
    expect(requirements.budgetMonthly).toEqual({ amount: 15, currency: "USD" });
    expect(requirements.region).toBe("us-east");
    expect(requirements.dnsProvider).toBe("none");
    expect(requirements.domain).toBeUndefined();
  });

  it("pre-fills the previous answers on a re-run and reuses them without a terminal", async () => {
    project = await tempProject("nextjs-postgres");
    await writeFile(path.join(project.dir, "answers.yaml"), ANSWERS);
    const first = projectContext(project);
    expect(await run(first, "interview", "--answers", path.join(project.dir, "answers.yaml"))).toBe(
      0,
    );

    const answers = new ScriptedPrompts([
      "<1k",
      "25 EUR",
      "eu-central",
      "standard",
      "important",
      "shop.example.com",
      "cloudflare",
    ]);
    const rerun = projectContext(project, { interactive: true, services: { prompts: answers } });
    expect(await run(rerun, "interview")).toBe(0);
    expect(answers.calls[0]?.initial).toBe("1k-10k");
    expect(answers.calls[1]?.initial).toBe("20 EUR");
    expect(answers.calls[5]?.initial).toBe("shop.example.com");

    const quiet = projectContext(project);
    expect(await run(quiet, "interview")).toBe(0);
    expect(quiet.output).toContain("uses your previous answers");
    expect((await requirementsOf(project.root, project.env)).budgetMonthly.amount).toBe(25);
  });

  it("fails with a plain-English error when required answers are missing", async () => {
    project = await tempProject("static-vite");
    const ctx = projectContext(project);
    expect(await run(ctx, "interview")).toBe(2);
    expect(ctx.errors).toContain("Some required answers are missing");
  });

  it("rejects an answers file that is not a mapping", async () => {
    project = await tempProject("static-vite");
    await writeFile(path.join(project.root, "answers.yaml"), "- a\n- b\n");
    const ctx = projectContext(project);
    expect(await run(ctx, "interview", "--answers", "answers.yaml")).toBe(2);
    expect(ctx.errors).toContain("must map question names to answers");
  });

  it("writes nothing when the user cancels", async () => {
    project = await tempProject("static-vite");
    const prompts = new ScriptedPrompts([CANCEL]);
    const ctx = projectContext(project, { interactive: true, services: { prompts } });
    expect(await run(ctx, "interview")).toBe(1);
    expect(ctx.errors).toContain("You cancelled the interview, so nothing was written.");
    const paths = resolveProjectPaths(project.root, { env: project.env });
    await expect(readFile(paths.files.requirements, "utf8")).rejects.toThrow();
  });
});
