import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pagesVerificationStateFile } from "@opscrew/agents";
import { testPlan } from "@opscrew/agents/testing";
import { exists, resolveProjectPaths } from "@opscrew/core";
import { materializeFixture } from "@opscrew/core/testing";
import { type DeployPlan, DeployPlanSchema, writeArtifact } from "@opscrew/plan-schema";
import { afterEach, describe, expect, it } from "vitest";
import {
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

const MONOREPO = fileURLToPath(
  new URL("../../../detect/test/fixtures/monorepo-two-apps/", import.meta.url),
);

/** A repository with two apps: the first in apps/api (analysed), and `web` in apps/web. */
async function twoApps(): Promise<TempProject> {
  const created = await tempProject();
  await materializeFixture(MONOREPO, created.root);
  const ctx = projectContext(created);
  expect(await run(ctx, "analyze", "--no-ai", "--dir", "apps/api"), ctx.errors).toBe(0);
  expect(await run(ctx, "app", "add", "web", "--dir", "apps/web"), ctx.errors).toBe(0);
  return created;
}

/** The plan of the further app `key` as design writes it (its key, name and derived names). */
function appPlan(key: string, plan: DeployPlan = testPlan()): DeployPlan {
  const { dir: _dir, ...infra } = plan.infra;
  const { workflowPath: _workflowPath, ...cicd } = plan.cicd;
  return DeployPlanSchema.parse({ ...plan, app: { ...plan.app, key, name: key }, infra, cicd });
}

function appPaths(created: TempProject, app?: string) {
  return resolveProjectPaths(created.root, {
    env: created.env,
    ...(app === undefined ? {} : { app }),
  });
}

describe("opscrew app add", () => {
  it("writes the app's record and names --app in the next steps", async () => {
    project = await tempProject();
    await materializeFixture(MONOREPO, project.root);
    const ctx = projectContext(project);
    expect(await run(ctx, "app", "add", "web", "--dir", "apps/web"), ctx.errors).toBe(0);
    const record = await readFile(`${appPaths(project, "web").artefactsDir}/app.yaml`, "utf8");
    expect(record).toContain("dir: apps/web");
    expect(ctx.output).toContain("Added the app web in apps/web (opscrew/apps/web/app.yaml)");
    expect(ctx.output).toContain("`opscrew analyze --app web`");
    expect(ctx.output).toContain("`opscrew design --app web`");
  });

  it("refuses a key the rules refuse, and a folder with no app, writing nothing", async () => {
    project = await tempProject();
    await materializeFixture(MONOREPO, project.root);
    const bad = projectContext(project);
    expect(await run(bad, "app", "add", "Web", "--dir", "apps/web")).toBe(2);
    expect(bad.errors).toContain("cannot be an app's key");
    const empty = projectContext(project);
    expect(await run(empty, "app", "add", "docs", "--dir", "nowhere")).toBe(2);
    expect(await exists(appPaths(project, "docs").artefactsDir)).toBe(false);
  });
});

describe("opscrew app list", () => {
  it("lists the first app and each further app with its folder and whether it is deployed", async () => {
    project = await twoApps();
    await writeArtifact(
      "plan",
      appPaths(project, "web").files.plan,
      appPlan("web", testPlan({ deployed: true })),
    );
    const ctx = projectContext(project);
    expect(await run(ctx, "app", "list"), ctx.errors).toBe(0);
    expect(ctx.output).toMatch(/App\s+Folder\s+Deployed/);
    expect(ctx.output).toMatch(/first app\s+apps\/api\s+no/);
    expect(ctx.output).toMatch(/web\s+apps\/web\s+yes/);
  });
});

describe("--app", () => {
  it("names the apps and --app when a script does not say which one", async () => {
    project = await twoApps();
    const ctx = projectContext(project);
    expect(await run(ctx, "analyze", "--no-ai")).not.toBe(0);
    expect(ctx.errors).toContain('the first app (in apps/api), "web" (in apps/web)');
    expect(ctx.errors).toContain("--app web");
  });

  it("asks in a terminal which app the command is for", async () => {
    project = await twoApps();
    const prompts = new ScriptedPrompts(["web"]);
    const ctx = projectContext(project, { interactive: true, services: { prompts } });
    expect(await run(ctx, "analyze", "--no-ai"), ctx.errors).toBe(0);
    expect(prompts.calls[0]).toMatchObject({
      message: "Which app is this for?",
      options: [
        { value: ".", label: "the first app (apps/api)" },
        { value: "web", label: "web (apps/web)" },
      ],
    });
    expect(await exists(appPaths(project, "web").files.architecture)).toBe(true);
  });

  it("acts on the app it names and names it in the commands it suggests", async () => {
    project = await twoApps();
    const web = projectContext(project);
    expect(await run(web, "analyze", "--no-ai", "--app", "web"), web.errors).toBe(0);
    const architecture = JSON.parse(
      await readFile(appPaths(project, "web").files.architecture, "utf8"),
    );
    expect(architecture.facts.appDir).toBe("apps/web");
    expect(web.output).toContain("review opscrew/apps/web/ARCHITECTURE.md");
    expect(web.output).toContain("`opscrew interview --app web`");

    const first = projectContext(project);
    expect(await run(first, "analyze", "--no-ai", "--app", "."), first.errors).toBe(0);
    expect(first.output).toContain("`opscrew interview --app .`");

    const envs = projectContext(project);
    expect(await run(envs, "env", "list", "--app", "web"), envs.errors).toBe(0);
    expect(envs.output).toContain("Start with `opscrew design --app web`");

    const status = projectContext(project);
    expect(await run(status, "status", "--app", "web", "--ip")).not.toBe(0);
    expect(status.errors).toContain("`opscrew provision --app web`");
  });

  it("refuses an app the repository does not have, naming its apps", async () => {
    project = await twoApps();
    const ctx = projectContext(project);
    expect(await run(ctx, "verify", "--app", "docs")).toBe(2);
    expect(ctx.errors).toContain('no app "docs"');
    expect(ctx.errors).toContain('"web" (in apps/web)');
  });

  it("is on every command that takes --env, and on analyze, interview, design and adapt", async () => {
    const commands = [
      ["analyze"],
      ["interview"],
      ["design"],
      ["adapt"],
      ["provision"],
      ["promote"],
      ["dns"],
      ["secure"],
      ["verify"],
      ["drift"],
      ["retarget"],
      ["destroy"],
      ["status"],
      ["runner", "start"],
      ["secrets", "status"],
      ["secrets", "restore"],
      ["secrets", "rotate"],
      ["secrets", "folder"],
      ["env", "add"],
      ["env", "set"],
      ["env", "list"],
      ["env", "remove"],
    ];
    project = await tempProject();
    for (const command of commands) {
      const ctx = projectContext(project);
      expect(await run(ctx, ...command, "--help")).toBe(0);
      expect(ctx.output, command.join(" ")).toContain("--app <key>");
    }
  });
});

describe("opscrew app remove", () => {
  it("has the key typed back: a script needs --confirm <key>", async () => {
    project = await twoApps();
    const refused = projectContext(project);
    expect(await run(refused, "app", "remove", "web")).toBe(1);
    expect(refused.errors).toContain("`opscrew app remove web --confirm web`");
    expect(await exists(appPaths(project, "web").artefactsDir)).toBe(true);

    const wrong = projectContext(project);
    expect(await run(wrong, "app", "remove", "web", "--confirm", "api")).toBe(1);
    expect(await exists(appPaths(project, "web").artefactsDir)).toBe(true);

    const ctx = projectContext(project);
    expect(await run(ctx, "app", "remove", "web", "--confirm", "web"), ctx.errors).toBe(0);
    expect(await exists(appPaths(project, "web").artefactsDir)).toBe(false);
    expect(ctx.output).toContain("opscrew/apps/web");
  });

  it("asks a terminal for the key, and keeps everything when it is not typed", async () => {
    project = await twoApps();
    const prompts = new ScriptedPrompts(["api"]);
    const ctx = projectContext(project, { interactive: true, services: { prompts } });
    expect(await run(ctx, "app", "remove", "web")).toBe(1);
    expect(prompts.calls[0]?.message).toBe("Type web to remove it (anything else cancels)");
    expect(ctx.output).toContain("deploy keys, state passphrases and generated secrets");
    expect(await exists(appPaths(project, "web").artefactsDir)).toBe(true);
  });

  it("refuses the first app and a deployed app before asking anything", async () => {
    project = await twoApps();
    const first = projectContext(project);
    expect(await run(first, "app", "remove", ".")).toBe(2);
    expect(first.errors).toContain("removes a further app");

    await writeArtifact(
      "plan",
      appPaths(project, "web").files.plan,
      appPlan("web", testPlan({ deployed: true })),
    );
    const prompts = new ScriptedPrompts([]);
    const ctx = projectContext(project, { interactive: true, services: { prompts } });
    expect(await run(ctx, "app", "remove", "web")).not.toBe(0);
    expect(prompts.calls).toHaveLength(0);
    expect(ctx.errors).toContain("`opscrew destroy --app web`");
    expect(await exists(appPaths(project, "web").artefactsDir)).toBe(true);
  });

  it("refuses before asking while GitHub Pages' verification record may still be in DNS", async () => {
    project = await twoApps();
    const state = pagesVerificationStateFile(appPaths(project, "web"));
    await mkdir(path.dirname(state), { recursive: true });
    await writeFile(state, "a state OpsCrew cannot read");
    const prompts = new ScriptedPrompts([]);
    const ctx = projectContext(project, { interactive: true, services: { prompts } });
    expect(await run(ctx, "app", "remove", "web")).not.toBe(0);
    expect(prompts.calls).toHaveLength(0);
    expect(ctx.errors).toContain("`opscrew destroy --app web --delete-verification`");
    expect(await exists(appPaths(project, "web").artefactsDir)).toBe(true);
  });
});
