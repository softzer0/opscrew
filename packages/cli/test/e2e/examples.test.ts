/**
 * End-to-end flow over every app in `examples/` (T115, SC-102, SC-103, SC-106): each example is
 * materialised into a temp git repository and driven through the real CLI program in-process,
 * offline and without a model: `scan --offline` → `analyze --no-ai` → `interview --answers` →
 * `design --option` (which also chooses the builder `expected.json` names) →
 * `adapt --no-ai --no-push`. The last check searches every output and every
 * written file for the fake secret values the example plants.
 */
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ScanReport } from "@opscrew/contracts";
import { FakeAgentRuntime } from "@opscrew/core/testing";
import { cloudTarget } from "@opscrew/iac-templates";
import { type ProjectFacts, readArtifact } from "@opscrew/plan-schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  EXAMPLES_DIR,
  GIT,
  git,
  projectContext,
  run,
  type TempProject,
  tempProject,
} from "../../src/ui/__fixtures__/harness";
import {
  BASE_ANSWERS,
  type Expected,
  exampleNames,
  findLeaks,
  initRepoWithBareOrigin,
  networkCalls,
  plantedSecrets,
  readExpected,
  readPlan,
  ScriptedApprovals,
  snapshotFiles,
} from "./support";

/** Every example with an `expected.json`. */
const EXAMPLES = exampleNames();

/** A small static or SSR site: a lower budget, best-effort uptime, no data. */
const SMALL_SITE = { budgetMonthly: "10 EUR", uptime: "best-effort", dataCriticality: "none" };

/** Interview answers per example: `BASE_ANSWERS` with a mix of regions, budgets, domains and kept services. */
const ANSWERS: Record<string, Record<string, unknown>> = Object.fromEntries(
  Object.entries({
    "express-drizzle": {},
    "fastapi-sqlmodel": {},
    "koa-knex": {},
    "nestjs-typeorm": {},
    "angular-static": SMALL_SITE,
    "astro-ssr": { budgetMonthly: "10 EUR", dataCriticality: "none" },
    "nuxt-ssr": { expectedMonthlyUsers: "1k-10k", dataCriticality: "none" },
    "react-router-ssr": { budgetMonthly: "10 EUR", dataCriticality: "none" },
    "sveltekit-ssr": SMALL_SITE,
    "django-postgres": {},
    "express-api": { expectedMonthlyUsers: "1k-10k" },
    "fastify-api": {},
    "hono-api": SMALL_SITE,
    "nestjs-api": SMALL_SITE,
    "fastapi-redis": { expectedMonthlyUsers: "1k-10k" },
    "lovable-supabase": {
      budgetMonthly: "15 USD",
      region: "eu-north",
      uptime: "best-effort",
      keepExternalServices: true,
    },
    "nextjs-postgres": {
      budgetMonthly: "30 EUR",
      dataCriticality: "critical",
      domain: "app.example.com",
      dnsProvider: "cloudflare",
    },
    "monorepo-two-apps": { appDir: "apps/api", budgetMonthly: "10 EUR" },
    "static-vite": { ...SMALL_SITE, region: "us-east" },
    "go-api": SMALL_SITE,
    "rails-api": {},
    "laravel-app": { budgetMonthly: "30 EUR" },
    "spring-boot-api": { expectedMonthlyUsers: "1k-10k" },
    "dotnet-api": { region: "us-east" },
    "rust-api": SMALL_SITE,
  }).map(([name, answers]) => [name, { ...BASE_ANSWERS, ...answers }]),
);

/** Code-change kinds `adapt --no-ai` writes from templates, and the file each one writes. */
const TEMPLATED: Record<string, string> = {
  dockerfile: "Dockerfile",
  dockerignore: ".dockerignore",
  "env-example": ".env.example",
};

const HIGH = new Set(["high", "critical"]);
const STEP_TIMEOUT = 120_000;

const readArchitecture = (root: string) =>
  readArtifact("architecture", path.join(root, "opscrew", "architecture.json"));

it("finds the example apps and the secrets they plant", async () => {
  expect(EXAMPLES).toEqual(
    expect.arrayContaining([
      ...["fastapi-redis", "lovable-supabase", "nextjs-postgres", "static-vite"],
      // One per language OpsCrew builds with Buildpacks or Railpack (012).
      ...["go-api", "rails-api", "laravel-app", "spring-boot-api", "dotnet-api", "rust-api"],
    ]),
  );
  for (const example of EXAMPLES) expect(ANSWERS[example], example).toBeDefined();
  // The leak search below is only meaningful when at least one example plants a secret.
  expect(await plantedSecrets(path.join(EXAMPLES_DIR, "lovable-supabase"))).not.toHaveLength(0);
});

describe.skipIf(GIT === undefined).each(EXAMPLES)("example %s", (example) => {
  const exampleDir = path.join(EXAMPLES_DIR, example);
  let project: TempProject;
  let expected: Expected;
  let secrets: string[];
  let inputs: Map<string, string>;
  let bare: string;
  let baseSha: string;
  let chosenOption: string;
  const runtime = new FakeAgentRuntime();
  const approvals = new ScriptedApprovals();
  /** Everything the user saw, labelled by command, for the final leak search. */
  const outputs = new Map<string, string>();

  /** Runs `opscrew <args>` in the project with fresh output buffers; records the output. */
  async function opscrew(...args: string[]) {
    const ctx = projectContext(project, { services: { runtime, approvalHandler: approvals } });
    const code = await run(ctx, ...args);
    outputs.set(`${args.join(" ")} (stdout)`, ctx.output);
    outputs.set(`${args.join(" ")} (stderr)`, ctx.errors);
    // Offline: no command in this flow may touch the network.
    expect(networkCalls(args, ctx.fetchUrls), `${args.join(" ")} fetched`).toEqual([]);
    return { code, ctx, text: ctx.output + ctx.errors };
  }

  beforeAll(async () => {
    expected = await readExpected(exampleDir);
    secrets = await plantedSecrets(exampleDir);
    project = await tempProject(example);
    inputs = await snapshotFiles(project.root);
    // Every planted value really is in the materialised files, so the search below can find it.
    const inputText = [...inputs.values()].join("\n");
    for (const [i, secret] of secrets.entries()) {
      expect(inputText.includes(secret), `planted secret #${i}`).toBe(true);
    }

    // A repository with one commit of everything, including the `.env` some examples plant
    // (`secrets/committed-env` needs it tracked), and a bare `origin` that must stay empty.
    bare = await initRepoWithBareOrigin(project);
    baseSha = await git(project.env, project.root, "rev-parse", "HEAD");
  }, STEP_TIMEOUT);

  afterAll(async () => {
    await project?.cleanup();
  });

  it(
    "scan --offline reports the planted problems and nothing serious on clean apps",
    async () => {
      const { code, text } = await opscrew("scan", "--offline");
      const report = JSON.parse(
        await readFile(path.join(project.root, ".opscrew", "scan.json"), "utf8"),
      ) as ScanReport;
      const ruleIds = new Set(report.findings.map((finding) => finding.ruleId));
      for (const ruleId of expected.scan.mustInclude) expect(ruleIds, ruleId).toContain(ruleId);

      const serious = report.findings.filter((finding) => HIGH.has(finding.severity));
      if (expected.scan.clean) {
        // SC-102: a clean example has no findings at all, not just no serious ones.
        expect(
          report.findings.map((f) => `${f.severity} ${f.ruleId} ${f.file ?? ""}:${f.line ?? ""}`),
          "findings on a clean example",
        ).toEqual([]);
        expect(code).toBe(0);
        expect(text).toContain("No high or critical problems were found");
      } else {
        expect(serious).not.toHaveLength(0);
        expect(code).toBe(1);
      }
      expect(text).toContain("opscrew/SECURITY_SCAN.md");
      expect(existsSync(path.join(project.root, "opscrew", "SECURITY_SCAN.md"))).toBe(true);
    },
    STEP_TIMEOUT,
  );

  it(
    "analyze --no-ai detects the expected facts",
    async () => {
      const { code } = await opscrew("analyze", "--no-ai");
      expect(code).toBe(0);
      const architecture = await readArchitecture(project.root);
      expect(architecture.aiEnriched).toBe(false);
      expectFacts(architecture.facts, expected.facts);
      expect(existsSync(path.join(project.root, "opscrew", "ARCHITECTURE.md"))).toBe(true);
    },
    STEP_TIMEOUT,
  );

  it(
    "interview --answers and design --option write a valid plan",
    async () => {
      const answersFile = path.join(project.dir, "answers.yaml");
      await writeFile(answersFile, `${JSON.stringify(ANSWERS[example], null, 2)}\n`);
      expect((await opscrew("interview", "--answers", answersFile)).code).toBe(0);
      const requirements = await readArtifact(
        "requirements",
        path.join(project.root, "opscrew", "requirements.yaml"),
      );
      const answers = ANSWERS[example] ?? {};
      expect(requirements.region).toBe(answers.region);
      expect(requirements.expectedMonthlyUsers).toBe(answers.expectedMonthlyUsers);

      // Monorepos: the chosen app is recorded and the analysis now describes only that app.
      if (expected.chosenApp !== undefined) {
        expect(requirements.appDir).toBe(expected.chosenApp.appDir);
        const architecture = await readArchitecture(project.root);
        expect(architecture.facts.appDir).toBe(expected.chosenApp.appDir);
        expect(architecture.facts.appKind).toBe(expected.chosenApp.appKind);
        const names = architecture.facts.frameworks.map((framework) => framework.name);
        expect(names).toEqual(expected.chosenApp.frameworkNames ?? names);
      }

      // Without --option the recommended option is chosen and the others are listed.
      const first = await opscrew("design");
      expect(first.code).toBe(0);
      const recommended = /Chose the recommended option, ([a-z0-9-]+)\./.exec(first.ctx.output);
      expect(recommended, "recommended option").not.toBeNull();
      const listed = [...first.text.matchAll(/\((hetzner-[a-z0-9-]+)\)/g)].map((m) => m[1]);
      expect(listed).toContain(recommended?.[1]);
      // Then choose explicitly: a non-recommended option when there is one.
      chosenOption = listed.find((id) => id !== recommended?.[1]) ?? (recommended?.[1] as string);

      const second = await opscrew("design", "--option", chosenOption);
      expect(second.code).toBe(0);
      const plan = await readPlan(project.root);
      const { serverType, location } = cloudTarget(plan.target);
      expect(`hetzner-single-${serverType}-${location}`).toBe(chosenOption);
      expect(plan.target.provider).toBe("hetzner");
      const port = expected.chosenApp?.port ?? expected.facts.port;
      if (port !== undefined) expect(plan.app.port).toBe(port);
      if (expected.chosenApp !== undefined) {
        expect(plan.app.dockerfile).toBe(`${expected.chosenApp.appDir}/Dockerfile`);
        expect(plan.app.buildContext).toBe(".");
      }
      if (answers.domain !== undefined) {
        expect(plan.dns).toMatchObject({ provider: "cloudflare", domain: answers.domain });
      } else {
        expect(plan.dns.provider).toBe("none");
      }
      // OpsCrew chooses the builder itself (contracts/builders.md "chooseBuilder").
      expect(plan.app.build).toMatchObject({ builder: expected.builder, chosen: "auto" });
      const kinds = plan.codeChanges.map((change) => change.kind);
      for (const kind of expected.codeChanges ?? []) expect(kinds, kind).toContain(kind);
      expect(plan.codeChanges.every((change) => change.status === "pending")).toBe(true);
      // Names only: the plan never carries an environment value (`optional` is a flag).
      for (const variable of plan.app.env) {
        const { optional, ...rest } = variable;
        expect(Object.keys(rest).sort()).toEqual(["name", "secret", "source"]);
        expect(optional === undefined || optional === true).toBe(true);
      }
    },
    STEP_TIMEOUT,
  );

  it(
    "adapt --no-ai --no-push writes the templated files and commits them on a branch",
    async () => {
      const before = await readPlan(project.root);
      const templated = before.codeChanges.filter((change) => TEMPLATED[change.kind] !== undefined);
      expect(templated.length, "templated code changes").toBeGreaterThan(0);

      const { code, text } = await opscrew("adapt", "--no-ai", "--no-push");
      expect(code, text).toBe(0);
      const { env, root } = project;

      // Only the commit was asked for and approved; nothing was pushed or opened.
      expect(approvals.requests.map((request) => request.kind)).toEqual(["repo-write"]);
      expect(runtime.requests).toHaveLength(0);
      expect(await git(env, root, "branch", "--show-current")).toBe("opscrew/prepare-deploy");
      expect(await git(env, root, "rev-list", "--count", `${baseSha}..HEAD`)).toBe("1");
      expect(await git(env, root, "log", "-1", "--format=%s")).toBe(
        "chore(opscrew): prepare app for deployment",
      );
      expect(await git(env, bare, "for-each-ref")).toBe("");
      expect(text).toContain("git push -u origin opscrew/prepare-deploy");

      const committed = (await git(env, root, "show", "--name-only", "--format=", "HEAD"))
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "");
      const after = await readPlan(project.root);
      for (const change of templated) {
        expect(existsSync(path.join(root, change.path)), change.path).toBe(true);
        expect(committed, change.path).toContain(change.path);
        expect(after.codeChanges.find((c) => c.id === change.id)?.status, change.id).toBe(
          "applied",
        );
      }
      expect(committed).toContain("opscrew/plan.yaml");
      expect(committed.filter((file) => /(^|\/)\.env$/.test(file))).toEqual([]);
      expect(committed.filter((file) => file.startsWith(".opscrew/"))).toEqual([]);

      // The working tree holds nothing uncommitted outside OpsCrew's own state.
      const status = (await git(env, root, "status", "--porcelain", "--untracked-files=all"))
        .split("\n")
        .filter((line) => line.trim() !== "" && !line.slice(3).startsWith(".opscrew/"));
      expect(status).toEqual([]);
    },
    STEP_TIMEOUT,
  );

  it(
    "never shows or writes a planted secret value",
    async () => {
      outputs.set(
        "approval requests",
        JSON.stringify(approvals.requests.map(({ title, details }) => ({ title, details }))),
      );
      const leaks = await findLeaks({
        secrets,
        texts: outputs,
        dir: project.dir,
        inputs,
        skipDirs: [bare],
      });
      expect(leaks).toEqual([]);
    },
    STEP_TIMEOUT,
  );
});

/** `facts` ⊇ the expected subset described in `examples/README.md`. */
function expectFacts(facts: ProjectFacts, want: Expected["facts"]): void {
  expect(facts.platformExport.platform).toBe(want.platformExport.platform);
  expect(facts.appKind).toBe(want.appKind);
  if (want.port !== undefined) expect(facts.port).toBe(want.port);
  for (const language of want.languages ?? []) expect(facts.languages).toContain(language);
  const frameworks = facts.frameworks.map((framework) => framework.name);
  for (const name of want.frameworkNames ?? []) expect(frameworks, name).toContain(name);
  const services = facts.services.map((service) => service.kind);
  if (want.services !== undefined) {
    if (want.services.length === 0) expect(services, "no services").toEqual([]);
    for (const kind of want.services) expect(services, kind).toContain(kind);
  }
  const env = new Map(facts.envVars.map((variable) => [variable.name, variable]));
  for (const name of want.clientExposedEnv ?? []) {
    expect(env.get(name)?.clientExposed, `${name} client-exposed`).toBe(true);
  }
  for (const name of want.secretEnv ?? []) {
    expect(env.get(name)?.secretLikely, `${name} secret-likely`).toBe(true);
  }
}
