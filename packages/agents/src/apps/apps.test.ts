import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { OpsCrewError, resolveProjectPaths } from "@opscrew/core";
import { type DeployPlan, DeployPlanSchema, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { runAnalyze } from "../analyze";
import { releaseCommandNote } from "../design/release";
import { runDesign } from "../design/run";
import {
  addEnvironment,
  commandFlags,
  environmentFlag,
  environmentPaths,
  resolveEnvironment,
} from "../environments";
import { requireOwnHostnames } from "../environments/hostnames";
import { pagesVerificationStateFile, stateCopyPaths } from "../shared";
import { appBranchNames } from "../shared/app-branches";
import {
  createTestPhaseDeps,
  encryptedState,
  FakeEngine,
  makeFacts,
  makeRequirements,
  plainState,
  testPlan,
  withStateList,
} from "../testing";
import { appPlan, twoSites } from "./__fixtures__/sites";
import { addApp, appFlag, listApps, removeApp, resolveApp } from "./index";
import { requireOnePagesSite, requireUniqueNames } from "./names";

/** The error `promise` rejects with. */
async function failure(promise: Promise<unknown>): Promise<OpsCrewError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OpsCrewError);
  return error as OpsCrewError;
}

/** Writes `plan` as the plan of the app `key`'s environment `env` (prod by default) in `root`. */
async function writePlan(
  root: string,
  plan: DeployPlan,
  key?: string,
  env?: string,
): Promise<void> {
  const paths = resolveProjectPaths(root, { env: {}, app: key, environment: env });
  await writeArtifact("plan", paths.files.plan, plan);
}

/** The repository's files under `dir` (repo-relative, `/`-separated), or none. */
async function filesIn(root: string, dir: string): Promise<string[]> {
  try {
    const entries = await readdir(join(root, dir), { recursive: true, withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) =>
        join(entry.parentPath, entry.name)
          .slice(root.length + 1)
          .split("\\")
          .join("/"),
      )
      .sort();
  } catch {
    return [];
  }
}

describe("resolveApp and appFlag", () => {
  it("are the first app's, reading nothing, while the repository has no further app", async () => {
    const root = await twoSites();
    // An invalid requirements file is never read for it.
    await mkdir(join(root, "opscrew"), { recursive: true });
    await writeFile(join(root, "opscrew", "requirements.yaml"), "not: [valid\n");
    expect(await resolveApp(root, undefined)).toBeUndefined();
    expect(await resolveApp(root, ".")).toBeUndefined();
    expect(await appFlag(root, undefined)).toBe("");
    const unknown = await failure(resolveApp(root, "docs"));
    expect(unknown.code).toBe("INVALID_INPUT");
    expect(unknown.message).toBe('The repository has no app "docs". Its further apps: none yet.');
    expect(unknown.hint).toContain("opscrew app add <key> --dir <folder>");
  });

  it("take a key or `.`, ask in a terminal, and tell a script the apps", async () => {
    const root = await twoSites();
    await addApp(root, "docs", "sites/docs");
    expect(await resolveApp(root, "docs")).toBe("docs");
    expect(await resolveApp(root, " docs ")).toBe("docs");
    expect(await resolveApp(root, ".")).toBeUndefined();
    let offered: unknown;
    const chosen = await resolveApp(root, undefined, {
      choose: async (apps) => {
        offered = apps;
        return "docs";
      },
    });
    expect(chosen).toBe("docs");
    expect(offered).toEqual([{ dir: "." }, { key: "docs", dir: "sites/docs" }]);
    expect(await resolveApp(root, undefined, { choose: async () => "." })).toBeUndefined();

    const script = await failure(resolveApp(root, undefined));
    expect(script.code).toBe("PHASE_PRECONDITION");
    expect(script.message).toBe(
      'The repository has several apps (the first app (in .), "docs" (in sites/docs)), so OpsCrew needs to know which one this is for. Nothing was changed.',
    );
    expect(script.hint).toBe(
      "Add `--app <key>`, for example `--app docs`, or `--app .` for the first app.",
    );
    const unknown = await failure(resolveApp(root, "blog"));
    expect(unknown.message).toBe(
      'The repository has no app "blog". Its further apps: "docs" (in sites/docs).',
    );
    const invalid = await failure(resolveApp(root, "Docs!"));
    expect(invalid.code).toBe("INVALID_INPUT");
    expect(invalid.message).toContain('"Docs!" is not an app\'s key');

    expect(await appFlag(root, "docs")).toBe(" --app docs");
    expect(await appFlag(root, undefined)).toBe(" --app .");
    // A damaged record never stands in for a command's own error in a hint.
    await mkdir(join(root, "opscrew", "apps", "blog"));
    expect(await appFlag(root, undefined)).toBe(" --app .");
    expect((await failure(resolveApp(root, undefined))).code).toBe("ARTIFACT_MISSING");
  });
});

describe("addApp", () => {
  it("checks the folder and writes only the app's record", async () => {
    const root = await twoSites();
    expect(await addApp(root, "docs", "./sites/docs/")).toEqual({ key: "docs", dir: "sites/docs" });
    expect(await filesIn(root, "opscrew")).toEqual(["opscrew/apps/docs/app.yaml"]);
    expect(await readFile(join(root, "opscrew", "apps", "docs", "app.yaml"), "utf8")).toBe(
      "# Generated by OpsCrew (schema v1). Validated on every read.\nschemaVersion: 1\ndir: sites/docs\n",
    );
    expect(await filesIn(root, ".opscrew")).toEqual([]);
  });

  it("takes a Hugo site, which has no manifest, as an app", async () => {
    const root = await twoSites();
    await mkdir(join(root, "sites", "blog", "content"), { recursive: true });
    await writeFile(join(root, "sites", "blog", "hugo.toml"), 'title = "Blog"\n');
    await writeFile(join(root, "sites", "blog", "content", "_index.md"), "# Blog\n");
    expect(await addApp(root, "blog", "sites/blog")).toEqual({ key: "blog", dir: "sites/blog" });
  });

  it("refuses a folder with no app it can deploy, a key twice and a key the rules refuse", async () => {
    const root = await twoSites();
    await mkdir(join(root, "notes"), { recursive: true });
    const none = await failure(addApp(root, "docs", "notes"));
    expect(none.code).toBe("INVALID_INPUT");
    expect(none.message).toContain("Deployable apps found: sites/docs, sites/web.");
    expect(none.hint).toBe(
      "Name one of the listed folders with `--dir`, then run `opscrew app add docs --dir <folder>` again.",
    );
    await addApp(root, "docs", "sites/docs");
    const twice = await failure(addApp(root, "docs", "sites/web"));
    expect(twice.code).toBe("PHASE_PRECONDITION");
    expect(twice.message).toBe(
      "The repository already has an app docs (opscrew/apps/docs). Nothing was changed.",
    );
    for (const key of ["prod", "Docs", "my-env", "storage"]) {
      expect((await failure(addApp(root, key, "sites/web"))).code).toBe("INVALID_INPUT");
    }
    expect(await filesIn(root, "opscrew")).toEqual(["opscrew/apps/docs/app.yaml"]);
  });

  it("refuses a key whose names another app or environment has, naming the clash", async () => {
    const root = await twoSites();
    await writePlan(root, testPlan());
    await writePlan(root, appPlan(undefined, "docs"), undefined, "docs");
    const clash = await failure(addApp(root, "docs", "sites/docs"));
    expect(clash.code).toBe("INVALID_INPUT");
    expect(clash.message).toBe(
      "The app docs's prod would have the workflow file .github/workflows/opscrew-deploy-docs.yml, which the first app's environment docs already has: no two apps or environments of a repository may share it. Nothing was changed.",
    );
    expect(clash.hint).toBe(
      "Choose another key, then run `opscrew app add <key> --dir sites/docs` again.",
    );
    expect(await filesIn(root, "opscrew/apps")).toEqual([]);
  });

  it("compares the names a plan has, set by hand there too", async () => {
    const root = await twoSites();
    const prod = testPlan();
    await writePlan(
      root,
      DeployPlanSchema.parse({ ...prod, infra: { ...prod.infra, dir: "opscrew/infra/docs/" } }),
    );
    const folder = await failure(addApp(root, "docs", "sites/docs"));
    expect(folder.message).toContain(
      "would have the infrastructure folder opscrew/infra/docs, which the first app's prod already has",
    );
    // The app name a further app's resources take, its key, against the first app's.
    await writePlan(root, testPlan());
    const named = await failure(addApp(root, "shop", "sites/docs"));
    expect(named.message).toContain(
      "would have the app name shop (resource names and concurrency group), which the first app's prod already has",
    );
  });

  it("reads no plan for the first app's prod alone, which design may be writing anew", async () => {
    const root = await twoSites();
    await mkdir(join(root, "opscrew"), { recursive: true });
    await writeFile(join(root, "opscrew", "plan.yaml"), "app: [unreadable\n");
    const plan = testPlan();
    const paths = resolveProjectPaths(root, { env: {} });
    await requireUniqueNames(paths, { environment: "prod", plan }, "unused");
    await requireOnePagesSite(paths, { environment: "prod" });
  });

  it("is refused by `opscrew env add` beside it: an environment whose names the app has", async () => {
    const root = await twoSites();
    await writePlan(root, testPlan());
    await addApp(root, "docs", "sites/docs");
    const deps = await createTestPhaseDeps({ root, environment: "docs" });
    const clash = await failure(addEnvironment(deps, { answers: {} }));
    expect(clash.message).toBe(
      "The first app's environment docs would have the workflow file .github/workflows/opscrew-deploy-docs.yml, which the app docs's prod already has: no two apps or environments of a repository may share it. Nothing was changed.",
    );
    expect(clash.hint).toBe(
      "Give the environment another name, then run `opscrew env add <name> --app .` again.",
    );
    expect(await filesIn(root, "opscrew/environments")).toEqual([]);
  });
});

describe("listApps and removeApp", () => {
  it("lists every app with its folder and whether it is deployed", async () => {
    const root = await twoSites();
    await addApp(root, "docs", "sites/docs");
    await addApp(root, "blog", "sites/web");
    const deployed = appPlan("docs", undefined, testPlan({ deployed: true }));
    await writePlan(root, deployed, "docs");
    const deps = await createTestPhaseDeps({ root });
    expect(await listApps(deps.paths)).toEqual([
      { dir: ".", deployed: false },
      { key: "blog", dir: "sites/web", deployed: false },
      { key: "docs", dir: "sites/docs", deployed: true },
    ]);
  });

  it("refuses the first app, and a further app while deployed", async () => {
    const root = await twoSites();
    await addApp(root, "docs", "sites/docs");
    const first = await failure(removeApp(await createTestPhaseDeps({ root })));
    expect(first.code).toBe("INVALID_INPUT");
    expect(first.hint).toBe("Run `opscrew destroy --app .` to remove the first app's deployment.");

    await writePlan(root, appPlan("docs", undefined, testPlan({ deployed: true })), "docs");
    await writePlan(
      root,
      appPlan("docs", "staging", testPlan({ deployed: true })),
      "docs",
      "staging",
    );
    const deps = await createTestPhaseDeps({ root, app: "docs" });
    const deployed = await failure(removeApp(deps));
    expect(deployed.code).toBe("PHASE_PRECONDITION");
    expect(deployed.message).toBe(
      "The app docs is deployed (prod and staging), so OpsCrew removed none of its files.",
    );
    expect(deployed.hint).toBe(
      "Run `opscrew destroy --app docs` and `opscrew destroy --app docs --env staging` first, then `opscrew app remove docs`.",
    );
    expect(await filesIn(root, "opscrew/apps/docs")).toHaveLength(3);
  });

  it("refuses while the app's GitHub Pages verification record may still be in DNS", async () => {
    const root = await twoSites();
    await addApp(root, "docs", "sites/docs");
    await writePlan(root, appPlan("docs"), "docs");
    const deps = await createTestPhaseDeps({ root, app: "docs" });
    const engine = withStateList(new FakeEngine(), () => undefined);
    const state = pagesVerificationStateFile(deps.paths);
    await mkdir(dirname(state), { recursive: true });
    const record = {
      mode: "managed",
      type: "cloudflare_dns_record",
      name: "verification",
      instances: [{ schema_version: 0, attributes: {} }],
    };
    await writeFile(state, plainState([record]));
    const held = await failure(removeApp(deps, { engine: async () => engine }));
    expect(held.code).toBe("PHASE_PRECONDITION");
    expect(held.message).toBe(
      "The app docs's GitHub Pages verification record may still be in DNS (its state, .opscrew/apps/docs/tfstate/github-pages-verification.tfstate, holds it), so OpsCrew removed none of its files: without that state nothing could delete the record later.",
    );
    expect(held.hint).toBe(
      "Run `opscrew destroy --app docs --delete-verification` first, then `opscrew app remove docs`.",
    );
    // An encrypted state the engine cannot open counts too.
    await writeFile(state, encryptedState());
    expect((await failure(removeApp(deps, { engine: async () => engine }))).message).toContain(
      "cannot be read here",
    );
    expect(await filesIn(root, "opscrew/apps/docs")).toHaveLength(2);

    // Once a destroy emptied it, the app goes, its verification root with it.
    await writeFile(state, plainState([]));
    const folder = join(root, "opscrew", "infra", "github-pages-verification-docs");
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "main.tf"), "# OpsCrew\n");
    const removed = await removeApp(deps, { engine: async () => engine });
    expect(removed).toContain("opscrew/infra/github-pages-verification-docs");
    expect(await filesIn(root, ".opscrew/apps")).toEqual([]);
  });

  it("removes only the app's own files", async () => {
    const root = await twoSites();
    await writePlan(root, testPlan());
    await addApp(root, "docs", "sites/docs");
    await writePlan(root, appPlan("docs"), "docs");
    await writePlan(root, appPlan("docs", "staging"), "docs", "staging");
    const deps = await createTestPhaseDeps({ root, app: "docs" });
    const kept = [
      "opscrew/infra/prod/main.tf",
      ".github/workflows/opscrew-deploy.yml",
      ".opscrew/state.json",
    ];
    const gone = [
      "opscrew/infra/docs/main.tf",
      "opscrew/infra/docs-staging/main.tf",
      ".github/workflows/opscrew-deploy-docs.yml",
      ".github/workflows/opscrew-deploy-docs-staging.yml",
      ".opscrew/apps/docs/state.json",
      ".opscrew/apps/docs/environments/staging/state.json",
    ];
    for (const file of [...kept, ...gone]) {
      await mkdir(dirname(join(root, file)), { recursive: true });
      await writeFile(join(root, file), "x\n");
    }
    await mkdir(deps.paths.projectHomeDir, { recursive: true });
    await writeFile(join(deps.paths.projectHomeDir, "deploy_key"), "x\n");

    const removed = await removeApp(deps);
    expect(removed).toEqual([
      ".opscrew/apps/docs",
      "opscrew/infra/docs",
      ".github/workflows/opscrew-deploy-docs.yml",
      "opscrew/infra/docs-staging",
      ".github/workflows/opscrew-deploy-docs-staging.yml",
      `.home-opscrew/projects/${deps.paths.projectId}/apps/docs`,
      "opscrew/apps/docs",
    ]);
    for (const file of kept) await expect(readFile(join(root, file), "utf8")).resolves.toBe("x\n");
    expect(await filesIn(root, "opscrew/apps")).toEqual([]);
    expect(deps.reporter.text()).toContain("Removed the app docs's files: .opscrew/apps/docs,");
    expect(await resolveApp(root, undefined)).toBeUndefined();
  });
});

describe("a further app's paths, environments and names", () => {
  it("keeps the app in its environments' paths, and lists only its own environments", async () => {
    const root = await twoSites();
    await writePlan(root, testPlan());
    await writePlan(root, appPlan(undefined, "staging"), undefined, "staging");
    await addApp(root, "docs", "sites/docs");
    await writePlan(root, appPlan("docs"), "docs");
    const docs = await createTestPhaseDeps({ root, app: "docs" });
    expect(environmentPaths(docs.paths, "staging")).toMatchObject({
      app: "docs",
      environment: "staging",
      artefactsDir: join(root, "opscrew", "apps", "docs", "environments", "staging"),
    });
    expect(await resolveEnvironment(root, undefined, { app: "docs" })).toBe("prod");
    expect((await failure(resolveEnvironment(root, undefined))).code).toBe("PHASE_PRECONDITION");
    expect((await failure(resolveEnvironment(root, "staging", { app: "docs" }))).message).toBe(
      'The app docs has no environment "staging". Its environments: "prod".',
    );
    expect(await environmentFlag(root, "prod", "docs")).toBe("");
    expect(await commandFlags(root, "prod", "docs")).toBe(" --app docs");
    expect(await commandFlags(root, "staging", undefined)).toBe(" --app . --env staging");
    expect(stateCopyPaths(appPlan("docs", "staging"))).toEqual({
      folder: ".opscrew/apps/docs/environments/staging/tfstate",
      passphrase: "~/.opscrew/projects/<project>/apps/docs/environments/staging/state_passphrase",
    });
  });

  it("refuses a hostname another app serves", async () => {
    const root = await twoSites();
    await writePlan(root, testPlan({ domain: "shop.example.com" }));
    await addApp(root, "docs", "sites/docs");
    const docs = await createTestPhaseDeps({ root, app: "docs" });
    const error = await failure(
      requireOwnHostnames(
        docs.paths,
        appPlan("docs", undefined, testPlan({ domain: "shop.example.com" })),
      ),
    );
    expect(error.message).toBe(
      "shop.example.com is already the hostname of the first app's prod, and every app needs its own. Nothing was changed.",
    );
    expect(error.hint).toBe(
      "Answer another domain with `opscrew interview --app docs`, then run `opscrew design --app docs` again.",
    );
    await requireOwnHostnames(
      docs.paths,
      appPlan("docs", undefined, testPlan({ domain: "docs.example.com" })),
    );
  });

  it("analyses a further app in its record's folder only", async () => {
    const root = await twoSites();
    await addApp(root, "docs", "sites/docs");
    const docs = await createTestPhaseDeps({ root, app: "docs" });
    const { architecture } = await runAnalyze(docs, { ai: false });
    expect(architecture.facts.appDir).toBe("sites/docs");
    expect(docs.reporter.text()).toContain(
      "Wrote opscrew/apps/docs/architecture.json and opscrew/apps/docs/ARCHITECTURE.md.",
    );
    const other = await failure(runAnalyze(docs, { ai: false, appDir: "sites/web" }));
    expect(other.code).toBe("INVALID_INPUT");
    expect(other.message).toBe(
      "The app docs is the one in sites/docs (opscrew/apps/docs/app.yaml), so OpsCrew does not describe sites/web for it. Nothing was written.",
    );
  });

  it("tells a further app whose answers name another folder to analyse and interview it", async () => {
    const root = await twoSites();
    await addApp(root, "docs", "sites/docs");
    const docs = await createTestPhaseDeps({ root, app: "docs" });
    await runAnalyze(docs, { ai: false });
    await writeArtifact(
      "requirements",
      docs.paths.files.requirements,
      makeRequirements({ appDir: "sites/web" }),
    );
    const error = await failure(runDesign(docs));
    expect(error.message).toBe(
      "opscrew/apps/docs/requirements.yaml chooses the app in sites/web, but opscrew/apps/docs/architecture.json describes sites/docs.",
    );
    expect(error.hint).toBe(
      "Run `opscrew analyze --app docs` and `opscrew interview --app docs`, which take the app's folder from opscrew/apps/docs/app.yaml, then run `opscrew design --app docs` again.",
    );
  });

  it("names a further app's own plan where its release command is not run", () => {
    const plan = appPlan("docs");
    const note = releaseCommandNote(
      { ...plan, app: { ...plan.app, releaseCommand: undefined } },
      makeFacts({ build: { ...makeFacts().build, releaseCommand: "alembic upgrade head" } }),
    );
    expect(note?.text).toContain("`app.releaseCommand` in opscrew/apps/docs/plan.yaml");
    const runs = releaseCommandNote(
      { ...plan, app: { ...plan.app, releaseCommand: "npx prisma migrate deploy" } },
      undefined,
      " --app docs",
    );
    expect(runs?.text).toContain(
      "`app.releaseCommand` in opscrew/apps/docs/plan.yaml (running `opscrew design --app docs` again sets the detected command back).",
    );
    // testPlan has Postgres: the hint names the app's own plan.
    const none = releaseCommandNote({ ...plan, app: { ...plan.app, releaseCommand: undefined } });
    expect(none?.text).toContain("set it as `app.releaseCommand` in opscrew/apps/docs/plan.yaml:");
    const first = releaseCommandNote({
      ...testPlan(),
      app: { ...testPlan().app, releaseCommand: "x" },
    });
    expect(first?.text).toContain("in opscrew/plan.yaml (running `opscrew design` again");
  });
});

describe("the branches OpsCrew opens", () => {
  it("are numbered after a separator no key holds, so no two apps' branches meet", () => {
    const first = appBranchNames("opscrew/prepare-deploy", undefined);
    expect(first.slice(0, 3)).toEqual([
      "opscrew/prepare-deploy",
      "opscrew/prepare-deploy-2",
      "opscrew/prepare-deploy-3",
    ]);
    expect(first).toHaveLength(100);
    expect(first.at(-1)).toBe("opscrew/prepare-deploy-100");
    const a = appBranchNames("opscrew/deploy-setup", "a");
    const a2 = appBranchNames("opscrew/deploy-setup", "a-2");
    expect(a.slice(0, 2)).toEqual(["opscrew/deploy-setup-a", "opscrew/deploy-setup-a_2"]);
    expect(a2[0]).toBe("opscrew/deploy-setup-a-2");
    const all = [a, a2, appBranchNames("opscrew/deploy-setup", undefined)].flat();
    expect(new Set(all).size).toBe(all.length);
  });
});
