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
      "digitalocean", // cloud provider
      "us-east", // region
      "best-effort", // uptime
      "none", // data criticality
      "", // no domain, so the DNS provider question is skipped
      false, // no image signing
      "off", // no deploy tags
    ]);
    const ctx = projectContext(project, { interactive: true, services: { prompts } });
    expect(await run(ctx, "interview")).toBe(0);

    expect(prompts.calls.map((call) => call.kind)).toEqual([
      "select",
      "text",
      "select",
      "select",
      "select",
      "select",
      "text",
      "confirm",
      "select",
    ]);
    expect(prompts.calls[0]?.initial).toBe("<1k");
    expect(prompts.calls[0]?.options?.length).toBeGreaterThan(1);
    expect(prompts.calls[2]?.message).toContain("Where should OpsCrew run your app?");
    expect(prompts.calls[2]?.initial).toBe("hetzner");
    const requirements = await requirementsOf(project.root, project.env);
    expect(requirements.provider).toBe("digitalocean");
    expect(requirements.budgetMonthly).toEqual({ amount: 15, currency: "USD" });
    expect(requirements.region).toBe("us-east");
    expect(requirements.dnsProvider).toBe("none");
    expect(requirements.domain).toBeUndefined();
  });

  it("asks the questions about a server the user already has in a terminal and keeps them local", async () => {
    project = await tempProject("nextjs-postgres");
    const asked: string[] = [];
    // Answers by question: the own-server follow-ups come after the provider question.
    const answer = (message: string, initial: unknown): unknown => {
      asked.push(message.split("\n")[0] ?? "");
      if (message.includes("Where should OpsCrew run your app?")) return "own";
      if (message.includes("server's address")) return "203.0.113.20";
      if (message.includes("Which port do you connect to for SSH?")) return "2222";
      if (message.includes("Which user should OpsCrew log in as?")) return "admin";
      if (message.includes("Which SSH key")) return "agent";
      if (message.includes("Can the internet reach this server directly?")) return true;
      if (message.toLowerCase().includes("budget")) return "10 EUR";
      if (message.toLowerCase().includes("domain")) return "";
      return initial ?? "";
    };
    const prompts = new ScriptedPrompts([]);
    const fake = {
      ...prompts,
      isCancel: prompts.isCancel.bind(prompts),
      password: prompts.password.bind(prompts),
      select: async (o: { message: string; options: { value: string }[]; initialValue?: string }) =>
        answer(o.message, o.initialValue ?? o.options[0]?.value) as string,
      multiselect: async (o: { message: string; initialValues?: string[] }) =>
        answer(o.message, o.initialValues ?? []) as string[],
      text: async (o: { message: string; initialValue?: string }) =>
        answer(o.message, o.initialValue) as string,
      confirm: async (o: { message: string; initialValue?: boolean }) =>
        answer(o.message, o.initialValue) as boolean,
    };
    const ctx = projectContext(project, { interactive: true, services: { prompts: fake } });
    expect(await run(ctx, "interview"), ctx.errors).toBe(0);

    expect(asked).toEqual(
      expect.arrayContaining([
        "What is your server's address?",
        "Which port do you connect to for SSH?",
        "Which user should OpsCrew log in as?",
        "Which SSH key should OpsCrew use?",
        "Can the internet reach this server directly?",
      ]),
    );
    const requirements = await requirementsOf(project.root, project.env);
    expect(requirements.provider).toBe("own");
    const paths = resolveProjectPaths(project.root, { env: project.env });
    expect(await readFile(paths.files.requirements, "utf8")).not.toContain("203.0.113.20");
    const local = await readFile(path.join(paths.stateDir, "server.json"), "utf8");
    expect(JSON.parse(local).own).toMatchObject({
      host: "203.0.113.20",
      port: 2222,
      user: "admin",
    });
    expect(ctx.output).toContain("a server you already have");
    expect(ctx.output).not.toContain("203.0.113.20");
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
      "hetzner",
      "eu-central",
      "standard",
      "important",
      "shop.example.com",
      "cloudflare",
      false,
      "off",
    ]);
    const rerun = projectContext(project, { interactive: true, services: { prompts: answers } });
    expect(await run(rerun, "interview")).toBe(0);
    expect(answers.calls[0]?.initial).toBe("1k-10k");
    expect(answers.calls[1]?.initial).toBe("20 EUR");
    expect(answers.calls[6]?.initial).toBe("shop.example.com");

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
