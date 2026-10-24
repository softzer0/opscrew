import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveProjectPaths } from "@opscrew/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appsOf,
  type DeployPlan,
  environmentsOf,
  otherAppDirs,
  parseArtifact,
  resolveEnvironmentPaths,
  writeArtifact,
} from "./index";

const FIXTURES = new URL("./__fixtures__/", import.meta.url);
const fixture = (name: string) => readFile(new URL(name, FIXTURES), "utf8");

let root: string;
let prodPlan: DeployPlan;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "opscrew-environments-"));
  prodPlan = parseArtifact("plan", await fixture("plan.yaml"), "plan.yaml");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/**
 * Writes an environment's plan: prod's at its app's `plan.yaml`, any other in its own folder. A
 * further app's (`app`) carry its key and are named after it.
 */
async function addEnvironment(name: string, source?: string, app?: string): Promise<void> {
  const deploySource =
    source === undefined ? { from: "main" as const } : { from: "promote" as const, source };
  const appName = app ?? prodPlan.app.name;
  const appFields = { ...prodPlan.app, ...(app === undefined ? {} : { key: app }) };
  const plan: DeployPlan =
    name === "prod"
      ? {
          ...prodPlan,
          app: { ...appFields, name: appName },
          environment: { deploySource, runner: "github" },
        }
      : {
          ...prodPlan,
          app: { ...appFields, name: `${appName}-${name}` },
          environment: { name, deploySource, runner: "github" },
        };
  const options = app === undefined ? { environment: name } : { app, environment: name };
  await writeArtifact("plan", resolveProjectPaths(root, options).files.plan, plan);
}

/** Writes a further app's record, `opscrew/apps/<key>/app.yaml`. */
async function addApp(key: string, dir: string): Promise<void> {
  const file = path.join(root, "opscrew", "apps", key, "app.yaml");
  await writeArtifact("app", file, { schemaVersion: 1, dir });
}

describe("environmentsOf", () => {
  it("is empty for a project without plans", async () => {
    expect(await environmentsOf(root)).toEqual([]);
  });

  it("lists prod first, then every environment after its source, ties by name", async () => {
    await addEnvironment("prod", "staging");
    await addEnvironment("staging", "dev");
    await addEnvironment("dev");
    await addEnvironment("alpha");
    await addEnvironment("qa", "alpha");
    expect(await environmentsOf(root)).toEqual(["alpha", "dev", "qa", "staging", "prod"]);
  });

  it("puts prod first when it deploys from main", async () => {
    await addEnvironment("staging", "prod");
    await addEnvironment("dev");
    await addEnvironment("prod");
    expect(await environmentsOf(root)).toEqual(["prod", "dev", "staging"]);
  });

  it("lists environments without prod, and skips folders without a plan", async () => {
    await addEnvironment("staging");
    await mkdir(path.join(root, "opscrew", "environments", "empty"), { recursive: true });
    expect(await environmentsOf(root)).toEqual(["staging"]);
  });

  it("validates each plan when reading it", async () => {
    await addEnvironment("prod");
    const file = path.join(root, "opscrew", "environments", "staging", "plan.yaml");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "schemaVersion: 1\n");
    await expect(environmentsOf(root)).rejects.toMatchObject({ code: "ARTIFACT_INVALID", file });
  });

  it("refuses a plan whose environment is not its folder's", async () => {
    await addEnvironment("staging");
    const file = path.join(root, "opscrew", "environments", "qa", "plan.yaml");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      await readFile(resolveProjectPaths(root, { environment: "staging" }).files.plan),
    );
    await expect(environmentsOf(root)).rejects.toMatchObject({
      code: "ARTIFACT_INVALID",
      file,
      issues: [{ path: "environment.name", message: 'must be "qa", the folder\'s name' }],
    });
  });

  it("refuses prod's plan when it names an environment", async () => {
    await addEnvironment("staging");
    const file = path.join(root, "opscrew", "plan.yaml");
    await writeFile(
      file,
      await readFile(resolveProjectPaths(root, { environment: "staging" }).files.plan),
    );
    await expect(environmentsOf(root)).rejects.toMatchObject({
      code: "ARTIFACT_INVALID",
      file,
      issues: [
        { path: "environment.name", message: "must be absent: opscrew/plan.yaml is prod's plan" },
      ],
    });
  });

  it("refuses a folder that is not an environment's name", async () => {
    for (const name of ["Staging", "dev_1", "prod"]) {
      const project = await mkdtemp(path.join(tmpdir(), "opscrew-environments-"));
      try {
        await mkdir(path.join(project, "opscrew", "environments", name), { recursive: true });
        await expect(environmentsOf(project), name).rejects.toMatchObject({
          code: "INVALID_INPUT",
          message: `opscrew/environments/${name} is not an environment's folder: an environment's name must be 1-16 lower-case letters, digits or hyphens and start with a letter, and not a name Windows reserves (con, nul, com1…) or one OpsCrew reserves (production, github-pages, modules, storage, a name starting with storage-, or a name with service or env as one of its hyphen-separated parts, such as service, db-service or env), and never "prod".`,
        });
      } finally {
        await rm(project, { recursive: true, force: true });
      }
    }
  });

  it("reads no environments when opscrew/environments is a file", async () => {
    await addEnvironment("prod");
    await writeFile(path.join(root, "opscrew", "environments"), "");
    expect(await environmentsOf(root)).toEqual(["prod"]);
  });

  it("refuses a source that does not exist, naming both", async () => {
    await addEnvironment("staging", "prod");
    await expect(environmentsOf(root)).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: 'The environment "staging" is promoted from "prod", which does not exist.',
    });
  });

  it("refuses a cycle, naming its environments in order", async () => {
    await addEnvironment("prod");
    await addEnvironment("dev", "qa");
    await addEnvironment("qa", "staging");
    await addEnvironment("staging", "dev");
    await expect(environmentsOf(root)).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message:
        'The environments "dev" → "qa" → "staging" → "dev" are promoted in a cycle: each must come after its source.',
      hint: 'Deploy "dev" from main (environment.deploySource.from: main).',
    });
  });

  it("names only the environments in the cycle, not one promoted from it", async () => {
    await addEnvironment("alpha", "dev");
    await addEnvironment("dev", "qa");
    await addEnvironment("qa", "dev");
    const error = await environmentsOf(root).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: "INVALID_INPUT",
      message:
        'The environments "dev" → "qa" → "dev" are promoted in a cycle: each must come after its source.',
    });
    expect((error as Error).message).not.toContain("alpha");
  });
});

describe("appsOf", () => {
  it("lists the first app at the root before it is set up, and at the analysed folder", async () => {
    expect(await appsOf(root)).toEqual([{ dir: "." }]);
    const architecture = parseArtifact("architecture", await fixture("architecture.json"), "a");
    await writeArtifact("architecture", path.join(root, "opscrew", "architecture.json"), {
      ...architecture,
      facts: { ...architecture.facts, appDir: "sites/landing" },
    });
    expect(await appsOf(root)).toEqual([{ dir: "sites/landing" }]);
  });

  it("lists the first app at the requirements' folder, else the analysed one, else the root", async () => {
    const requirements = parseArtifact("requirements", await fixture("requirements.yaml"), "r");
    const file = path.join(root, "opscrew", "requirements.yaml");
    await writeArtifact("requirements", file, { ...requirements, appDir: "sites/landing" });
    expect(await appsOf(root)).toEqual([{ dir: "sites/landing" }]);

    await writeArtifact("requirements", file, requirements);
    expect(await appsOf(root)).toEqual([{ dir: "." }]);
    const architecture = parseArtifact("architecture", await fixture("architecture.json"), "a");
    await writeArtifact("architecture", path.join(root, "opscrew", "architecture.json"), {
      ...architecture,
      facts: { ...architecture.facts, appDir: "sites/web" },
    });
    expect(await appsOf(root)).toEqual([{ dir: "sites/web" }]);
  });

  it("lists every further app by key after the first, from its record", async () => {
    await addEnvironment("prod");
    await addApp("landing", "sites/landing");
    await addApp("docs", "sites/docs");
    expect(await appsOf(root)).toEqual([
      { dir: "." },
      { key: "docs", dir: "sites/docs" },
      { key: "landing", dir: "sites/landing" },
    ]);
  });

  it("names the other apps' folders, never the asking app's own", async () => {
    expect(await otherAppDirs({ root })).toEqual([]);
    await addApp("landing", "sites/landing");
    await addApp("docs", "sites/docs");
    expect(await otherAppDirs({ root })).toEqual(["sites/docs", "sites/landing"]);
    // The first app's folder is the repository root, which holds every app's folder.
    expect(await otherAppDirs({ root, app: "docs" })).toEqual(["sites/landing"]);
  });

  it("never names a folder that holds the asking app's own: nested apps", async () => {
    await addApp("web", "site/");
    await addApp("admin", "site/admin");
    // `site` holds `site/admin`: leaving it out would leave out admin's own files.
    expect(await otherAppDirs({ root, app: "admin" })).toEqual([]);
    // admin's folder lies inside web's, and is another app's: web's deploys leave it out.
    expect(await otherAppDirs({ root, app: "web" })).toEqual(["site/admin"]);
    expect(await otherAppDirs({ root })).toEqual(["site/admin", "site"]);
  });

  it("refuses a folder that is not an app's key", async () => {
    for (const key of ["Docs", "prod", "x-env"]) {
      const project = await mkdtemp(path.join(tmpdir(), "opscrew-apps-"));
      try {
        await mkdir(path.join(project, "opscrew", "apps", key), { recursive: true });
        await expect(appsOf(project), key).rejects.toMatchObject({
          code: "INVALID_INPUT",
          message: expect.stringMatching(
            new RegExp(`^opscrew/apps/${key} is not an app's folder: an app's key must be 1-16 `),
          ),
          hint: "Rename the folder after its app's key, or remove it.",
        });
      } finally {
        await rm(project, { recursive: true, force: true });
      }
    }
  });

  it("refuses a further app's folder with no record, naming it", async () => {
    await mkdir(path.join(root, "opscrew", "apps", "docs"), { recursive: true });
    const hint =
      "Add the app again with `opscrew app add docs --dir <folder>`, or remove opscrew/apps/docs.";
    await expect(appsOf(root)).rejects.toMatchObject({
      code: "ARTIFACT_MISSING",
      file: path.join(root, "opscrew", "apps", "docs", "app.yaml"),
      message: `opscrew/apps/docs has no app.yaml, the record of the app's folder in the repository. ${hint}`,
      hint,
    });
  });

  it("refuses a bad record, naming the file and the field", async () => {
    const file = path.join(root, "opscrew", "apps", "docs", "app.yaml");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "schemaVersion: 1\ndir: /srv/docs\n");
    await expect(appsOf(root)).rejects.toMatchObject({
      code: "ARTIFACT_INVALID",
      file,
      issues: [{ path: "dir", message: expect.stringContaining("must be a repo-relative path") }],
      hint: "Add the app again with `opscrew app add docs --dir <folder>`, or remove opscrew/apps/docs.",
    });
  });
});

describe("environmentsOf for a further app", () => {
  it("lists the app's own environments, apart from the first app's", async () => {
    await addEnvironment("prod");
    await addEnvironment("docs");
    await addApp("docs", "sites/docs");
    await addEnvironment("staging", undefined, "docs");
    await addEnvironment("prod", "staging", "docs");
    expect(await environmentsOf(root)).toEqual(["prod", "docs"]);
    expect(await environmentsOf(root, "docs")).toEqual(["staging", "prod"]);
  });

  it("is empty for an app with no plan yet", async () => {
    await addApp("docs", "sites/docs");
    expect(await environmentsOf(root, "docs")).toEqual([]);
  });

  it("refuses an app the repository does not have, listing its apps", async () => {
    await addEnvironment("prod");
    await expect(environmentsOf(root, "docs")).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: 'The repository has no app "docs". Its further apps: none yet.',
      hint: "Run `opscrew app list` to see the repository's apps, or add this one with `opscrew app add <key> --dir <folder>`.",
    });
    await addApp("landing", "sites/landing");
    await addApp("blog", "sites/blog");
    await expect(environmentsOf(root, "docs")).rejects.toMatchObject({
      message: 'The repository has no app "docs". Its further apps: "blog", "landing".',
    });
  });

  it("refuses a plan whose key is not its app's", async () => {
    await addApp("docs", "sites/docs");
    await addEnvironment("prod", undefined, "docs");
    const file = path.join(root, "opscrew", "apps", "docs", "plan.yaml");
    await writeArtifact("plan", file, {
      ...(await readPlan(file)),
      app: { ...prodPlan.app, name: "docs", key: "blog" },
    });
    await expect(environmentsOf(root, "docs")).rejects.toMatchObject({
      code: "ARTIFACT_INVALID",
      file,
      issues: [
        {
          path: "app.key",
          message: 'must be "docs", the key of the app\'s folder (opscrew/apps/docs)',
        },
      ],
      hint: 'Set app.key to "docs", or move the plan to the folder of its app.',
    });
  });

  it("refuses a plan without the key in a further app's environment", async () => {
    await addApp("docs", "sites/docs");
    await addEnvironment("staging", undefined, "docs");
    const file = path.join(root, "opscrew", "apps", "docs", "environments", "staging", "plan.yaml");
    const { key: _key, ...withoutKey } = (await readPlan(file)).app;
    await writeArtifact("plan", file, { ...(await readPlan(file)), app: withoutKey });
    await expect(environmentsOf(root, "docs")).rejects.toMatchObject({
      code: "ARTIFACT_INVALID",
      file,
      issues: [{ path: "app.key", message: expect.stringContaining('must be "docs"') }],
    });
  });

  it("refuses a further app's key in the first app's plans", async () => {
    await addEnvironment("staging");
    const file = resolveProjectPaths(root, { environment: "staging" }).files.plan;
    const plan = await readPlan(file);
    await writeArtifact("plan", file, { ...plan, app: { ...plan.app, key: "docs" } });
    await expect(environmentsOf(root)).rejects.toMatchObject({
      code: "ARTIFACT_INVALID",
      file,
      issues: [
        {
          path: "app.key",
          message: "must be absent: the plan is in the repository's first app's folder (opscrew/)",
        },
      ],
      hint: "Remove app.key, or move the plan to the folder of its app (opscrew/apps/<key>/).",
    });
  });

  it("names the app's folder and command in its refusals", async () => {
    await addApp("docs", "sites/docs");
    await addEnvironment("staging", "prod", "docs");
    await expect(environmentsOf(root, "docs")).rejects.toMatchObject({
      message: 'The environment "staging" is promoted from "prod", which does not exist.',
      hint: 'Add "prod" with `opscrew env add prod --app docs`, or deploy "staging" from main.',
    });
    await rm(path.join(root, "opscrew", "apps", "docs", "environments"), { recursive: true });
    await mkdir(path.join(root, "opscrew", "apps", "docs", "environments", "Qa"), {
      recursive: true,
    });
    await expect(environmentsOf(root, "docs")).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: expect.stringMatching(
        /^opscrew\/apps\/docs\/environments\/Qa is not an environment's folder/,
      ),
    });
  });
});

async function readPlan(file: string): Promise<DeployPlan> {
  return parseArtifact("plan", await readFile(file, "utf8"), file);
}

describe("resolveEnvironmentPaths", () => {
  const options = { env: {}, homedir: "home" };

  it("gives a further app's listed environment its paths", async () => {
    await addApp("docs", "sites/docs");
    await addEnvironment("prod", undefined, "docs");
    await addEnvironment("staging", "prod", "docs");
    expect(await resolveEnvironmentPaths(root, "staging", { ...options, app: "docs" })).toEqual(
      resolveProjectPaths(root, { ...options, app: "docs", environment: "staging" }),
    );
    await expect(
      resolveEnvironmentPaths(root, "qa", { ...options, app: "docs" }),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: 'The app docs has no environment "qa". Its environments: "prod", "staging".',
      hint: "Run `opscrew env list --app docs` to see the app's environments.",
    });
  });

  it("gives a listed environment its paths", async () => {
    await addEnvironment("prod");
    await addEnvironment("staging", "prod");
    expect(await resolveEnvironmentPaths(root, "staging", options)).toEqual(
      resolveProjectPaths(root, { ...options, environment: "staging" }),
    );
    expect(await resolveEnvironmentPaths(root, "prod", options)).toEqual(
      resolveProjectPaths(root, options),
    );
  });

  it("refuses an unknown name with the list of names", async () => {
    await addEnvironment("prod");
    await addEnvironment("staging", "prod");
    await expect(resolveEnvironmentPaths(root, "qa", options)).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: 'The app has no environment "qa". Its environments: "prod", "staging".',
      hint: "Run `opscrew env list` to see the app's environments.",
    });
  });

  it("refuses any name while the app has no environment", async () => {
    await expect(resolveEnvironmentPaths(root, "prod", options)).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: 'The app has no environment "prod". Its environments: none yet.',
    });
  });
});
