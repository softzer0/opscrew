import { readFile } from "node:fs/promises";
import { OpsCrewError } from "@opscrew/core";
import {
  type Architecture,
  type DeployPlan,
  DeployPlanSchema,
  writeArtifact,
} from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { gitClient } from "../shared";
import { createTestPhaseDeps, makeFacts, type TestPhaseDeps, testPlan } from "../testing";
import { remoteWith } from "./__fixtures__/remote";
import {
  builderBranch,
  builderCicd,
  defaultBranchOf,
  matchBranches,
  remoteEnvironmentBranches,
  requireBranch,
} from "./branches";
import { environmentPaths } from "./paths";
import { setEnvironment } from "./set";
import { setupNote } from "./setup";

type Environment = NonNullable<DeployPlan["environment"]>;

/** The analysis of a repository whose default branch is `branch`. */
function analysisWith(branch: string): Architecture {
  return {
    schemaVersion: 1,
    generatedAt: "2026-10-11T10:00:00.000Z",
    generator: { tool: "opscrew", version: "0.0.0-test" },
    facts: makeFacts({ git: { defaultBranch: branch } }),
    summary: "A shop.",
    risks: [],
    aiEnriched: false,
  };
}

/** `prod` as the plan of the environment `name`, following `branch` unless promoted. */
function inEnvironment(
  name: string,
  block: Partial<Omit<Environment, "name">> = {},
  branch = "main",
): DeployPlan {
  const prod = testPlan();
  return DeployPlanSchema.parse({
    ...prod,
    environment: { name, ...block },
    app: { ...prod.app, name: `${prod.app.name}-${name}` },
    infra: { ...prod.infra, dir: `opscrew/infra/${name}` },
    cicd: { ...prod.cicd, branch, workflowPath: `.github/workflows/opscrew-deploy-${name}.yml` },
  });
}

/** A project with prod (following main) and these environments' plans, for `environment`. */
async function project(
  plans: Record<string, DeployPlan>,
  options: { environment?: string; branches?: readonly string[] } = {},
): Promise<TestPhaseDeps & { runner: ReturnType<typeof remoteWith> }> {
  const runner = remoteWith(options.branches ?? ["main"]);
  const deps = await createTestPhaseDeps({
    runner,
    ...(options.environment !== undefined ? { environment: options.environment } : {}),
  });
  for (const [name, plan] of Object.entries({ prod: testPlan(), ...plans })) {
    await writeArtifact("plan", environmentPaths(deps.paths, name).files.plan, plan);
  }
  return Object.assign(deps, { runner });
}

async function failure(promise: Promise<unknown>): Promise<OpsCrewError> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(OpsCrewError);
  return error as OpsCrewError;
}

describe("branches named like environments (FR-1537)", () => {
  it("matches the common names, the first of each list the repository has", () => {
    expect(matchBranches(["feature/login", "release", "master", "main", "develop"])).toEqual({
      prod: "main",
      dev: "develop",
      staging: "release",
    });
    expect(matchBranches(["trunk", "development", "stage"])).toEqual({
      prod: "trunk",
      dev: "development",
      staging: "stage",
    });
    expect(matchBranches(["master", "dev", "staging"])).toEqual({
      prod: "master",
      dev: "dev",
      staging: "staging",
    });
  });

  it("matches nothing for other names, also ones that only look alike", () => {
    expect(
      matchBranches(["Main", "mainline", "devel", "develop-2", "staging/old", "releases", "qa"]),
    ).toEqual({});
    expect(matchBranches([])).toEqual({});
  });

  it("reads the remote's branches through git, asking for each common name", async () => {
    const runner = remoteWith(["main", "develop", "feature/x"]);
    const deps = await createTestPhaseDeps({ runner });
    expect(await remoteEnvironmentBranches(gitClient(deps))).toEqual({
      prod: "main",
      dev: "develop",
    });
    expect([...runner.asked].sort()).toEqual(
      ["main", "master", "trunk", "develop", "development", "dev", "staging", "stage", "release"]
        .map((name) => `refs/heads/${name}`)
        .sort(),
    );
  });

  it("proposes both setups, promotion first, with their commands, only with a dev or staging branch", () => {
    expect(setupNote({ prod: "main", dev: "develop", staging: "staging" }, "main")).toBe(
      [
        "Your repository has branches named like environments: main, develop and staging. Once prod is designed, `opscrew env add` adds the others in one of two setups:",
        "- Promotion first (recommended): one image moves dev → staging → prod, and only dev follows a branch (main). Each environment gets exactly the image the one before it ran: `opscrew env add dev`, `opscrew env add staging --from dev` and `opscrew env set prod --from staging`, in that order.",
        "- Each environment follows its own branch (dev ← develop, staging ← staging, prod ← main), and each branch builds its own image: `opscrew env add dev --branch develop` and `opscrew env add staging --branch staging`.",
      ].join("\n"),
    );
    expect(setupNote({ prod: "master", staging: "release" }, "master")).toContain(
      "one image moves staging → prod, and only staging follows a branch (master). Each environment gets exactly the image the one before it ran: `opscrew env add staging` and `opscrew env set prod --from staging`, in that order.",
    );
    expect(setupNote({ prod: "main" }, "main")).toBeUndefined();
    expect(setupNote({}, "main")).toBeUndefined();
  });
});

describe("defaultBranchOf", () => {
  it("prefers origin's HEAD, then the checked-out branch, then main", () => {
    expect(
      defaultBranchOf(makeFacts({ git: { defaultBranch: "trunk", currentBranch: "feature/x" } })),
    ).toBe("trunk");
    expect(defaultBranchOf(makeFacts({ git: { currentBranch: "feature/x" } }))).toBe("feature/x");
    expect(defaultBranchOf(makeFacts({ git: {} }))).toBe("main");
  });

  it("never takes one of OpsCrew's own branches for the default branch", () => {
    for (const currentBranch of ["opscrew/deploy-setup", "opscrew/deploy-setup-docs"]) {
      expect(defaultBranchOf(makeFacts({ git: { currentBranch } }))).toBe("main");
    }
  });
});

describe("--branch", () => {
  it("sets the environment's own cicd.branch to a branch the repository has", async () => {
    const deps = await project(
      { dev: inEnvironment("dev") },
      {
        environment: "dev",
        branches: ["main", "develop"],
      },
    );
    const plan = await setEnvironment(deps, { branch: " develop " });
    expect(plan.cicd.branch).toBe("develop");
    expect(await readFile(deps.paths.files.plan, "utf8")).toContain("branch: develop");
    expect(deps.runner.asked).toEqual(["refs/heads/develop"]);
  });

  it("refuses a branch the repository does not have, and changes nothing", async () => {
    const deps = await project({ dev: inEnvironment("dev") }, { environment: "dev" });
    const before = await readFile(deps.paths.files.plan, "utf8");
    const error = await failure(setEnvironment(deps, { branch: "develop" }));
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.message).toBe(
      "The repository on GitHub has no branch develop, so no push to it could deploy the dev environment.",
    );
    expect(error.hint).toBe(
      "Push the branch first (`git push -u origin develop`), or name one it has.",
    );
    expect(await readFile(deps.paths.files.plan, "utf8")).toBe(before);
  });

  it("refuses a branch another environment follows, naming both, before asking GitHub", async () => {
    const deps = await project(
      { dev: inEnvironment("dev", {}, "develop"), staging: inEnvironment("staging") },
      { environment: "staging", branches: ["main", "develop"] },
    );
    const error = await failure(setEnvironment(deps, { branch: "develop" }));
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.message).toBe(
      "The dev environment already follows develop, so the staging environment cannot follow it too: each push to develop would then build and deploy both.",
    );
    expect(error.hint).toBe(
      "Name another branch for staging, or promote one of them from the other (`opscrew env set staging --from dev`).",
    );
    expect(deps.runner.asked).toEqual([]);
  });

  it("lets two environments follow the default branch, as a new environment does without --branch", async () => {
    // prod follows trunk, the analysis's default branch: `--branch trunk` acts like no --branch.
    const deps = await project(
      { staging: inEnvironment("staging", {}, "release") },
      {
        environment: "staging",
        branches: ["trunk"],
      },
    );
    await writeArtifact("architecture", deps.paths.files.architecture, analysisWith("trunk"));
    await writeArtifact(
      "plan",
      environmentPaths(deps.paths, "prod").files.plan,
      DeployPlanSchema.parse({ ...testPlan(), cicd: { ...testPlan().cicd, branch: "trunk" } }),
    );
    expect((await setEnvironment(deps, { branch: "trunk" })).cicd.branch).toBe("trunk");
  });

  it("does not count a promoted environment's branch, which no push builds", async () => {
    // prod is promoted from dev and kept release, so staging may follow release.
    const deps = await project(
      { dev: inEnvironment("dev", {}, "develop"), staging: inEnvironment("staging") },
      { environment: "staging", branches: ["main", "release"] },
    );
    await writeArtifact(
      "plan",
      environmentPaths(deps.paths, "prod").files.plan,
      DeployPlanSchema.parse({
        ...testPlan(),
        environment: { deploySource: { from: "promote", source: "dev" } },
        cicd: { ...testPlan().cicd, branch: "release" },
      }),
    );
    expect((await setEnvironment(deps, { branch: "release" })).cicd.branch).toBe("release");
  });

  it("refuses --from main bringing back a branch another environment follows now", async () => {
    // staging kept develop while promoted; dev has followed develop since.
    const deps = await project({
      dev: inEnvironment("dev", {}, "develop"),
      staging: inEnvironment(
        "staging",
        { deploySource: { from: "promote", source: "dev" } },
        "develop",
      ),
    });
    const before = await readFile(environmentPaths(deps.paths, "staging").files.plan, "utf8");
    const error = await failure(
      setEnvironment({ ...deps, paths: environmentPaths(deps.paths, "staging") }, { from: "main" }),
    );
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.message).toBe(
      "The dev environment already follows develop, so the staging environment cannot follow it too: each push to develop would then build and deploy both.",
    );
    expect(await readFile(environmentPaths(deps.paths, "staging").files.plan, "utf8")).toBe(before);

    // Its kept branch on the default branch is no conflict.
    await writeArtifact(
      "plan",
      environmentPaths(deps.paths, "staging").files.plan,
      inEnvironment("staging", { deploySource: { from: "promote", source: "dev" } }, "main"),
    );
    const plan = await setEnvironment(
      { ...deps, paths: environmentPaths(deps.paths, "staging") },
      { from: "main" },
    );
    expect(plan.environment?.deploySource).toEqual({ from: "main" });
  });

  it("refuses a name OpsCrew cannot write into the workflow", async () => {
    const deps = await project({ dev: inEnvironment("dev") }, { environment: "dev" });
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not JavaScript.
    for (const name of ["${{ github.token }}", "-x", "my branch", ""]) {
      const error = await failure(requireBranch(deps.paths, gitClient(deps), name));
      expect(error.message).toContain(
        "is not a branch name OpsCrew can deploy the dev environment from",
      );
    }
    expect(deps.runner.asked).toEqual([]);
  });
});

describe("builderBranch", () => {
  it("is none for an environment that follows a branch", async () => {
    const deps = await project({ dev: inEnvironment("dev", {}, "develop") });
    expect(await builderBranch(environmentPaths(deps.paths, "dev"), inEnvironment("dev"))).toBe(
      undefined,
    );
  });

  it("is the branch of the first environment along the sources that follows one", async () => {
    // dev follows develop; staging is promoted from dev, and prod from staging.
    const staging = inEnvironment("staging", { deploySource: { from: "promote", source: "dev" } });
    const prod = DeployPlanSchema.parse({
      ...testPlan(),
      environment: { deploySource: { from: "promote", source: "staging" } },
    });
    const deps = await project({ dev: inEnvironment("dev", {}, "develop"), staging });
    await writeArtifact("plan", deps.paths.files.plan, prod);
    expect(await builderBranch(deps.paths, prod)).toBe("develop");
    expect(await builderBranch(environmentPaths(deps.paths, "staging"), staging)).toBe("develop");
    // The workflow a promoted site's run is checked against comes from the same environment.
    const dev = { branch: "develop", workflowPath: ".github/workflows/opscrew-deploy-dev.yml" };
    expect(await builderCicd(deps.paths, prod)).toEqual(dev);
    expect(await builderCicd(environmentPaths(deps.paths, "staging"), staging)).toEqual(dev);
  });

  it("is an error naming the sources when one of them has no plan, never main", async () => {
    const qa = inEnvironment("qa", { deploySource: { from: "promote", source: "uat" } });
    const deps = await project({});
    const error = await failure(builderBranch(environmentPaths(deps.paths, "qa"), qa));
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toBe(
      "No environment builds the images of the qa environment: it is promoted along qa ← uat, and uat has no plan. Nothing was changed.",
    );
    expect(error.hint).toBe(
      "Have one of them built from its branch, for example `opscrew env set uat --from main`.",
    );
  });

  it("is an error naming the sources when they lead back round", async () => {
    const a = inEnvironment("a", { deploySource: { from: "promote", source: "b" } });
    const b = inEnvironment("b", { deploySource: { from: "promote", source: "a" } });
    const deps = await createTestPhaseDeps();
    for (const [name, plan] of Object.entries({ a, b })) {
      await writeArtifact("plan", environmentPaths(deps.paths, name).files.plan, plan);
    }
    const error = await failure(builderBranch(environmentPaths(deps.paths, "a"), a));
    expect(error.message).toContain("it is promoted along a ← b ← a, and a comes round again");
  });
});
