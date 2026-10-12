import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { materializeFixture } from "@opscrew/core/testing";
import { readArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { runAnalyze } from "../analyze";
import { runDesign } from "../design";
import { euCatalog } from "../design/__fixtures__/catalog";
import { runInterview } from "../interview";
import { createTestPhaseDeps, ScriptedApprovalHandler } from "../testing";
import { GIT, GitOnlyRunner, git, testEnv } from "./__fixtures__/repo";
import { buildCodeChangePrompt, runAdapt } from "./index";
import { playbookFor } from "./playbooks";

/** The detect fixture with an Express API in `apps/api` and a Next.js app in `apps/web`. */
const TWO_APPS = fileURLToPath(
  new URL("../../../detect/test/fixtures/monorepo-two-apps/", import.meta.url),
);

/** The two-app monorepo committed in a temp git repository on `main`, without a remote. */
async function twoAppRepo() {
  const home = await mkdtemp(join(tmpdir(), "opscrew-monorepo-"));
  const root = join(home, "duo");
  await mkdir(root, { recursive: true });
  const env = testEnv(home);
  await writeFile(env.GIT_CONFIG_GLOBAL as string, "");
  await materializeFixture(TWO_APPS, root);
  await writeFile(join(root, ".gitignore"), ".env\n.opscrew/\nnode_modules/\n");
  await git(env, root, "init", "-b", "main");
  await git(env, root, "config", "user.name", "OpsCrew Test");
  await git(env, root, "config", "user.email", "test@example.invalid");
  await git(env, root, "config", "commit.gpgsign", "false");
  await git(env, root, "config", "core.autocrlf", "false");
  await git(env, root, "add", "-A");
  await git(env, root, "commit", "-m", "initial");
  const handler = new ScriptedApprovalHandler([true]);
  const deps = await createTestPhaseDeps({
    root,
    env,
    runner: new GitOnlyRunner(),
    approvalHandler: handler,
  });
  return { root, env, deps, handler };
}

describe.skipIf(GIT === undefined)("one app of a monorepo, from analyze to adapt", () => {
  it("chooses apps/api in the interview and writes its Dockerfile in the app folder", async () => {
    const { root, env, deps, handler } = await twoAppRepo();

    // Analyze: the root describes two candidate apps.
    const analysis = await runAnalyze(deps, { ai: false });
    expect(analysis.architecture.facts.appDir).toBe(".");
    expect(analysis.architecture.risks.join("\n")).toMatch(
      /several deployable apps \(`apps\/api` and `apps\/web`\)/,
    );

    // Interview: asks which app, the answer picks apps/api and the analysis follows it.
    const interview = await runInterview(deps, {
      ask: async (questions) => {
        expect(questions[0]?.id).toBe("appDir");
        return {
          appDir: "apps/api",
          expectedMonthlyUsers: "<1k",
          budgetMonthly: "10 EUR",
          region: "eu-central",
          uptime: "standard",
          dataCriticality: "important",
        };
      },
    });
    expect(interview.requirements.appDir).toBe("apps/api");
    const { facts } = await readArtifact("architecture", deps.paths.files.architecture);
    expect(facts.appDir).toBe("apps/api");
    expect(facts.appKind).toBe("api");
    expect(facts.frameworks.map((f) => f.name)).toEqual(["express"]);

    // Design: no multi-app stop; the plan builds apps/api/Dockerfile from the repository root.
    const design = await runDesign(deps, { catalog: euCatalog() });
    expect(design.plan.app.dockerfile).toBe("apps/api/Dockerfile");
    expect(design.plan.app.buildContext).toBe(".");
    const dockerfileChange = design.plan.codeChanges.find((c) => c.kind === "dockerfile");
    expect(dockerfileChange?.path).toBe("apps/api/Dockerfile");
    expect(design.plan.codeChanges.find((c) => c.kind === "dockerignore")?.path).toBe(
      ".dockerignore",
    );

    // The Code-change prompt says which folder the app lives in.
    const prompt = buildCodeChangePrompt({
      facts,
      plan: design.plan,
      changes: design.plan.codeChanges,
      playbook: playbookFor(facts),
    });
    expect(prompt).toContain("- App folder: apps/api");
    expect(prompt).toContain("built from the repository root with apps/api/Dockerfile");

    // Adapt --no-ai: writes the Dockerfile in the app folder and .dockerignore at the root.
    const adapt = await runAdapt(deps, { ai: false, push: false });
    expect(adapt.createdFiles).toContain("apps/api/Dockerfile");
    expect(adapt.createdFiles).toContain(".dockerignore");
    expect(adapt.createdFiles).not.toContain("Dockerfile");
    const dockerfile = await readFile(join(root, "apps", "api", "Dockerfile"), "utf8");
    expect(dockerfile).toMatch(/apps\/api/);
    await expect(readFile(join(root, "Dockerfile"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(handler.requests.map((r) => r.kind)).toEqual(["repo-write"]);
    expect(adapt.committed).toBe(true);
    const committed = await git(env, root, "show", "--name-only", "--format=", "HEAD");
    expect(committed.split("\n")).toContain("apps/api/Dockerfile");
    const plan = await readArtifact("plan", deps.paths.files.plan);
    expect(plan.codeChanges.find((c) => c.kind === "dockerfile")?.status).toBe("applied");
    expect(deps.reporter.text()).not.toMatch(/would render it at/);
  });

  it("chooses apps/web (Next.js): Dockerfile in the app folder, standalone build from the root", async () => {
    const { root, deps } = await twoAppRepo();
    await runAnalyze(deps, { ai: false });
    await runInterview(deps, {
      ask: async () => ({
        appDir: "apps/web",
        expectedMonthlyUsers: "<1k",
        budgetMonthly: "10 EUR",
        region: "eu-central",
        uptime: "standard",
        dataCriticality: "none",
      }),
    });
    const { facts } = await readArtifact("architecture", deps.paths.files.architecture);
    expect(facts.appDir).toBe("apps/web");
    expect(facts.appKind).toBe("ssr");

    const design = await runDesign(deps, { catalog: euCatalog() });
    expect(design.plan.app.dockerfile).toBe("apps/web/Dockerfile");
    const buildConfig = design.plan.codeChanges.find((c) => c.kind === "build-config");
    expect(buildConfig?.path).toMatch(/^apps\/web\/next\.config\./);
    expect(buildConfig?.reason).toContain("outputFileTracingRoot");

    const adapt = await runAdapt(deps, { ai: false, push: false });
    expect(adapt.createdFiles).toContain("apps/web/Dockerfile");
    const dockerfile = await readFile(join(root, "apps", "web", "Dockerfile"), "utf8");
    expect(dockerfile).toContain("apps/web/.next/standalone");
    expect(dockerfile).toMatch(/apps\/web\/server\.js/);
  });
});
