import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveProjectPaths } from "@opscrew/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type DeployPlan,
  environmentsOf,
  parseArtifact,
  resolveEnvironmentPaths,
  writeArtifact,
} from "./index";

let root: string;
let prodPlan: DeployPlan;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "opscrew-environments-"));
  const text = await readFile(new URL("./__fixtures__/plan.yaml", import.meta.url), "utf8");
  prodPlan = parseArtifact("plan", text, "plan.yaml");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Writes an environment's plan: prod's at `opscrew/plan.yaml`, any other in its own folder. */
async function addEnvironment(name: string, source?: string): Promise<void> {
  const deploySource =
    source === undefined ? { from: "main" as const } : { from: "promote" as const, source };
  const plan: DeployPlan =
    name === "prod"
      ? { ...prodPlan, environment: { deploySource, runner: "github" } }
      : {
          ...prodPlan,
          app: { ...prodPlan.app, name: `${prodPlan.app.name}-${name}` },
          environment: { name, deploySource, runner: "github" },
        };
  await writeArtifact("plan", resolveProjectPaths(root, { environment: name }).files.plan, plan);
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
          message: `opscrew/environments/${name} is not an environment's folder: an environment's name must be 1-16 lower-case letters, digits or hyphens and start with a letter, and not a name Windows reserves (con, nul, com1…), storage, or a name starting with storage-, and never "prod".`,
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

describe("resolveEnvironmentPaths", () => {
  const options = { env: {}, homedir: "home" };

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
