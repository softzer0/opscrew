import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { materializeFixture } from "@opscrew/core/testing";
import { readArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { runAnalyze } from "../../analyze";
import { runDesign } from "../../design";
import { euCatalog } from "../../design/__fixtures__/catalog";
import { runInterview } from "../../interview";
import { createTestPhaseDeps, ScriptedApprovalHandler } from "../../testing";
import { GIT, GitOnlyRunner, git, testEnv } from "../__fixtures__/repo";
import { runAdapt } from "../index";
import { indentationError } from "./__fixtures__/repo";

const EXAMPLE = fileURLToPath(new URL("../../../../../examples/fastapi-redis/", import.meta.url));

/** The example committed in a temp git repository on `main`, without a remote. */
async function exampleRepo() {
  const home = await mkdtemp(join(tmpdir(), "opscrew-fastapi-redis-"));
  const root = join(home, "visits");
  await mkdir(root, { recursive: true });
  const env = testEnv(home);
  await writeFile(env.GIT_CONFIG_GLOBAL as string, "");
  await materializeFixture(EXAMPLE, root);
  await writeFile(join(root, ".gitignore"), ".env\n.opscrew/\n__pycache__/\n");
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

describe.skipIf(GIT === undefined)("examples/fastapi-redis without a model", () => {
  it("gets its /health route from analyze, design and adapt --no-ai", async () => {
    const { root, env, deps, handler } = await exampleRepo();
    const before = await stat(join(root, "main.py"));
    await runAnalyze(deps, { ai: false });
    await runInterview(deps, {
      answers: {
        expectedMonthlyUsers: "1k-10k",
        budgetMonthly: "20 EUR",
        region: "eu-central",
        uptime: "standard",
        dataCriticality: "important",
      },
    });
    const design = await runDesign(deps, { catalog: euCatalog() });
    expect(design.plan.app.healthPath).toBe("/health");
    const change = design.plan.codeChanges.find((c) => c.kind === "health-endpoint");
    expect(change?.path).toBe("main.py");

    const adapt = await runAdapt(deps, { ai: false, push: false });

    expect(adapt.aiRan).toBe(false);
    expect(adapt.editedFiles).toContain("main.py");
    expect(adapt.manual.map((item) => item.change.kind)).not.toContain("health-endpoint");
    const main = await readFile(join(root, "main.py"), "utf8");
    expect(main).toContain(
      'app = FastAPI(title="Visit counter (OpsCrew example)")\n\n\n@app.get("/health")\ndef health():\n    return {"status": "ok"}\n\n\ncache = ',
    );
    expect(indentationError(main)).toBeUndefined();
    // The edited file keeps its mode, so the image can still read it.
    expect((await stat(join(root, "main.py"))).mode & 0o777).toBe(before.mode & 0o777);
    const plan = await readArtifact("plan", deps.paths.files.plan);
    expect(plan.codeChanges.find((c) => c.kind === "health-endpoint")?.status).toBe("applied");
    expect(adapt.notes["health-endpoint"]).toBe(
      'Added GET /health to main.py by OpsCrew, right after the FastAPI app is created: answers {"status":"ok"} for the deploy health check.',
    );
    expect(deps.reporter.text()).toContain(
      "Added the FastAPI health route for the deploy health check (main.py).",
    );
    expect(deps.reporter.text()).not.toContain("fails its health check");
    expect(handler.requests.map((request) => request.kind)).toEqual(["repo-write"]);
    const committed = await git(env, root, "show", "--name-only", "--format=", "HEAD");
    expect(committed.split("\n")).toContain("main.py");
    expect(await git(env, root, "log", "-1", "--format=%B")).toContain(
      "- health-endpoint: main.py",
    );
  });
});
