import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { exists, OpsCrewError, Redactor, resolveProjectPaths } from "@opscrew/core";
import { renderDependabot } from "@opscrew/iac-templates";
import {
  type DeployPlan,
  DeployPlanSchema,
  readArtifact,
  writeArtifact,
} from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { selfHostedServices } from "../design/sizing";
import { dependabotStep } from "../provision/dependabot";
import { pullPemFile } from "../provision/origin-tls";
import { writeCloudflareRecord } from "../provision/shared-cloudflare";
import {
  COPY_PATH,
  copyPath,
  recoveryStatus,
  recoveryStatusLines,
  refreshRecoveryCopy,
} from "../secrets";
import {
  provisionedFiles,
  recoveryWorld,
  writeLocal,
  writeRepositoryFiles,
} from "../secrets/__fixtures__/world";
import { recordPortainerConnection, stateFile, stateNotHere } from "../shared";
import { buildPhaseDeps } from "../shared/phase-deps";
import {
  createTestPhaseDeps,
  forbiddenFetch,
  MemoryReporter,
  makeFacts,
  makeRequirements,
  ScriptedApprovalHandler,
  ScriptedRunner,
  type TestPhaseDeps,
  testPlan,
} from "../testing";
import { requireOwnHostnames } from "./hostnames";
import {
  environmentPaths,
  listEnvironments,
  readEnvironmentRequirements,
  removeEnvironment,
  requireSharedParts,
  resolveEnvironment,
  setDeploySource,
  sharedPartsDiffer,
  withSharedParts,
} from "./index";
import { writeEnvironmentRequirements } from "./requirements";

type Environment = NonNullable<DeployPlan["environment"]>;

/** `prod` as the plan of the environment `name`, as design writes it. */
function inEnvironment(
  prod: DeployPlan,
  name: string,
  block: Partial<Omit<Environment, "name">> = {},
): DeployPlan {
  return DeployPlanSchema.parse({
    ...prod,
    environment: { name, ...block },
    app: { ...prod.app, name: `${prod.app.name}-${name}` },
    infra: { ...prod.infra, dir: `opscrew/infra/${name}` },
    cicd: { ...prod.cicd, workflowPath: `.github/workflows/opscrew-deploy-${name}.yml` },
    dns: prod.dns.domain === undefined ? prod.dns : { ...prod.dns, domain: `${name}.example.com` },
  });
}

/** A project with these environments' plans. */
async function project(plans: Record<string, DeployPlan>): Promise<TestPhaseDeps> {
  const deps = await createTestPhaseDeps();
  for (const [name, plan] of Object.entries(plans)) {
    await writeArtifact("plan", environmentPaths(deps.paths, name).files.plan, plan);
  }
  return deps;
}

const prodPlan = () => testPlan({ domain: "shop.example.com" });

async function failure(promise: Promise<unknown>): Promise<OpsCrewError> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(OpsCrewError);
  return error as OpsCrewError;
}

describe("resolveEnvironment", () => {
  it("is prod for an app without a plan, and the only environment without --env", async () => {
    const empty = await createTestPhaseDeps();
    expect(await resolveEnvironment(empty.paths.root, undefined)).toBe("prod");
    const deps = await project({ prod: prodPlan() });
    expect(await resolveEnvironment(deps.paths.root, undefined)).toBe("prod");
    expect(await resolveEnvironment(deps.paths.root, "prod")).toBe("prod");
  });

  it("asks which one when there are several, and stops a script with the names and --env", async () => {
    const deps = await project({ prod: prodPlan(), staging: inEnvironment(prodPlan(), "staging") });
    const asked: (readonly string[])[] = [];
    const chosen = await resolveEnvironment(deps.paths.root, undefined, {
      choose: async (names) => {
        asked.push(names);
        return "staging";
      },
    });
    expect(chosen).toBe("staging");
    expect(asked).toEqual([["prod", "staging"]]);

    const script = await failure(resolveEnvironment(deps.paths.root, undefined));
    expect(script.code).toBe("PHASE_PRECONDITION");
    expect(script.message).toBe(
      'The app has several environments ("prod", "staging"), so OpsCrew needs to know which one this is for. Nothing was changed.',
    );
    expect(script.hint).toBe("Add `--env <name>`, for example `--env staging`.");
    expect(await resolveEnvironment(deps.paths.root, "staging")).toBe("staging");
  });

  it("refuses an unknown name, and an unknown pick, with the list", async () => {
    const deps = await project({ prod: prodPlan(), staging: inEnvironment(prodPlan(), "staging") });
    const unknown = await failure(resolveEnvironment(deps.paths.root, "dev"));
    expect(unknown.code).toBe("INVALID_INPUT");
    expect(unknown.message).toBe(
      'The app has no environment "dev". Its environments: "prod", "staging".',
    );
    const picked = await failure(
      resolveEnvironment(deps.paths.root, undefined, { choose: async () => "qa" }),
    );
    expect(picked.code).toBe("INVALID_INPUT");
  });
});

describe("the shared parts", () => {
  const prod = DeployPlanSchema.parse({
    ...prodPlan(),
    app: { ...prodPlan().app, releaseCommand: "npm run migrate" },
    supplyChain: { sign: true },
  });

  it("copies the source's build, components, port, health route and signing, and keeps the rest", () => {
    const own = inEnvironment(testPlan({ postgres: false }), "staging");
    const staging = DeployPlanSchema.parse({
      ...own,
      app: { ...own.app, port: 8080, healthPath: "/up" },
      target: { ...own.target, serverType: "cx33" },
    });
    expect(sharedPartsDiffer(prod, staging)).toEqual([
      "services.db (missing)",
      "app.port",
      "app.healthPath",
      "app.releaseCommand",
      "supplyChain.sign",
    ]);
    const copied = withSharedParts(staging, prod);
    expect(sharedPartsDiffer(prod, copied)).toEqual([]);
    expect(copied.app).toMatchObject({
      name: "shop-staging",
      port: 3000,
      healthPath: "/api/health",
    });
    expect(copied.target).toEqual(staging.target);
    expect(copied.dns).toEqual(staging.dns);
    expect(copied.environment).toEqual(staging.environment);
    expect(DeployPlanSchema.parse(copied)).toEqual(copied);
  });

  it("allows services beyond the source's, and names a service with other settings", () => {
    const [db, cache] = selfHostedServices({ postgres: true, redis: true });
    if (db === undefined || cache === undefined) throw new Error("no services");
    const staging = inEnvironment(prodPlan(), "staging");
    const extra = DeployPlanSchema.parse({ ...staging, services: [db, cache] });
    expect(sharedPartsDiffer(prodPlan(), extra)).toEqual([]);
    const bigger = DeployPlanSchema.parse({ ...staging, services: [{ ...db, memoryMb: 1024 }] });
    expect(sharedPartsDiffer(prodPlan(), bigger)).toEqual(["services.db (other settings)"]);
    // The copy has the source's services, then those the environment keeps.
    expect(withSharedParts(bigger, prodPlan(), [cache]).services).toEqual([db, cache]);
  });

  it("keeps the environment's own bucket and takes the source's SQLite folder", () => {
    const sqlite = DeployPlanSchema.parse({
      ...prod,
      services: [],
      deploy: { strategy: "recreate" },
      storage: { sqlite: { dir: "data" } },
    });
    const staging = inEnvironment(testPlan(), "staging");
    expect(sharedPartsDiffer(sqlite, staging)).toContain("storage.sqlite");
    expect(withSharedParts(staging, sqlite).storage).toEqual({ sqlite: { dir: "data" } });
    expect(withSharedParts(staging, prod)).not.toHaveProperty("storage");
  });

  it("stops a promoted environment's provision preflight naming its source and the parts", async () => {
    const deps = await project({ prod });
    const staging = inEnvironment(prodPlan(), "staging", {
      deploySource: { from: "promote", source: "prod" },
    });
    const paths = environmentPaths(deps.paths, "staging");
    const stop = await failure(requireSharedParts(paths, staging));
    expect(stop.code).toBe("PHASE_PRECONDITION");
    expect(stop.message).toBe(
      "The staging environment runs prod's image, and its plan differs from prod's in what every environment shares: app.releaseCommand and supplyChain.sign. Nothing was changed.",
    );
    expect(stop.hint).toBe(
      "Run `opscrew design --env staging` to take them from prod's plan, then run the command again.",
    );
    await requireSharedParts(paths, withSharedParts(staging, prod));
  });

  it("checks nothing in the preflight of an environment that builds, prod included", async () => {
    const deps = await project({ prod });
    await requireSharedParts(
      environmentPaths(deps.paths, "staging"),
      inEnvironment(prodPlan(), "staging"),
    );
    const building = DeployPlanSchema.parse({
      ...prod,
      environment: { deploySource: { from: "main" } },
    });
    await requireSharedParts(deps.paths, building);
  });
});

describe("requireOwnHostnames", () => {
  it("checks an environment whose folder does not exist yet against prod", async () => {
    const deps = await project({ prod: prodPlan() });
    const paths = environmentPaths(deps.paths, "staging");
    expect(await exists(dirname(paths.files.plan))).toBe(false);
    const clash = DeployPlanSchema.parse({
      ...inEnvironment(prodPlan(), "staging"),
      dns: prodPlan().dns,
    });
    const error = await failure(requireOwnHostnames(paths, clash));
    expect(error.message).toBe(
      "shop.example.com is already the prod environment's hostname, and every environment needs its own. Nothing was changed.",
    );
    await requireOwnHostnames(paths, inEnvironment(prodPlan(), "staging"));
  });

  it("leaves prod alone while it has no other environment, reading none of its files", async () => {
    const deps = await createTestPhaseDeps();
    await mkdir(dirname(deps.paths.files.plan), { recursive: true });
    await writeFile(deps.paths.files.plan, "not: [a plan");
    await requireOwnHostnames(deps.paths, prodPlan());
  });
});

describe("an environment's own answers", () => {
  it("keeps only the answers that differ from prod's, and reads them over prod's", async () => {
    const deps = await createTestPhaseDeps();
    const base = makeRequirements({ domain: "shop.example.com", dnsProvider: "cloudflare" });
    await writeArtifact("requirements", deps.paths.files.requirements, base);
    const paths = environmentPaths(deps.paths, "staging");
    const own = {
      ...base,
      answeredAt: "2026-10-22T09:00:00.000Z",
      domain: "staging-shop.example.com",
      provider: "digitalocean" as const,
    };
    await writeEnvironmentRequirements(paths, own);
    const text = await readFile(paths.files.requirements, "utf8");
    expect(text.split("\n").slice(1).join("\n")).toBe(
      "answeredAt: 2026-10-22T09:00:00.000Z\nprovider: digitalocean\ndomain: staging-shop.example.com\n",
    );
    expect(await readEnvironmentRequirements(paths)).toEqual(own);
    expect(await readEnvironmentRequirements(deps.paths)).toEqual(base);

    // Prod's later answers reach every answer the environment leaves to it, and its time.
    const later = { ...base, answeredAt: "2026-10-23T09:00:00.000Z", uptime: "high" as const };
    await writeArtifact("requirements", deps.paths.files.requirements, later);
    expect(await readEnvironmentRequirements(paths)).toEqual({
      ...own,
      uptime: "high",
      answeredAt: "2026-10-23T09:00:00.000Z",
    });
  });

  it("names the environment's file when its answers are not valid", async () => {
    const deps = await createTestPhaseDeps();
    await writeArtifact("requirements", deps.paths.files.requirements, makeRequirements());
    const paths = environmentPaths(deps.paths, "staging");
    await mkdir(dirname(paths.files.requirements), { recursive: true });
    await writeFile(paths.files.requirements, "provider: moon\nsize: huge\n");
    const error = await failure(readEnvironmentRequirements(paths));
    expect(error.code).toBe("ARTIFACT_INVALID");
    expect(error.message).toContain("provider:");
    expect(error.message).toContain("size:");
    expect(error.hint).toBe(
      "Fix the answers shown above in opscrew/environments/staging/requirements.yaml; every answer it leaves out is prod's.",
    );
  });
});

describe("setDeploySource", () => {
  it("promotes an environment from another, and back to main, writing only that plan", async () => {
    const prod = prodPlan();
    const deps = await project({ prod, staging: inEnvironment(prod, "staging") });
    const root = deps.paths.root;
    const stagingFile = environmentPaths(deps.paths, "staging").files.plan;
    const before = await readFile(stagingFile, "utf8");

    const promoted = await setDeploySource(root, "prod", "staging");
    expect(promoted.environment).toEqual({
      deploySource: { from: "promote", source: "staging" },
      runner: "github",
    });
    expect((await readArtifact("plan", deps.paths.files.plan)).environment).toEqual(
      promoted.environment,
    );
    expect(await readFile(stagingFile, "utf8")).toBe(before);
    // staging now comes first: prod takes its releases.
    expect(await listEnvironments(deps.paths)).toMatchObject([
      { name: "staging", from: "main" },
      { name: "prod", from: "staging" },
    ]);

    const back = await setDeploySource(root, "prod", "main");
    expect(back.environment?.deploySource).toEqual({ from: "main" });
  });

  it("leaves a plan that already deploys from there as it is", async () => {
    const deps = await project({ prod: prodPlan() });
    const before = await readFile(deps.paths.files.plan, "utf8");
    await setDeploySource(deps.paths.root, "prod", "main");
    expect(await readFile(deps.paths.files.plan, "utf8")).toBe(before);
  });

  it("refuses the environment itself, an unknown one, and a cycle", async () => {
    const prod = prodPlan();
    const deps = await project({
      prod,
      staging: inEnvironment(prod, "staging"),
      qa: inEnvironment(prod, "qa", { deploySource: { from: "promote", source: "staging" } }),
    });
    const root = deps.paths.root;
    const itself = await failure(setDeploySource(root, "staging", "staging"));
    expect(itself.message).toBe("The staging environment cannot be promoted from itself.");
    const unknown = await failure(setDeploySource(root, "staging", "dev"));
    expect(unknown.message).toContain('The app has no environment "dev"');
    const cycle = await failure(setDeploySource(root, "staging", "qa"));
    expect(cycle.code).toBe("INVALID_INPUT");
    expect(cycle.message).toBe(
      "The staging environment cannot be promoted from qa, since qa takes its releases from staging itself.",
    );
    expect(cycle.hint).toBe("Deploy one of them from main: `opscrew env set qa --from main`.");
  });
});

describe("listEnvironments and removeEnvironment", () => {
  async function withStaging(staging = inEnvironment(prodPlan(), "staging")) {
    const deployed = testPlan({ domain: "shop.example.com", deployed: true });
    const deps = await project({ prod: deployed, staging });
    const paths = environmentPaths(deps.paths, "staging");
    return {
      deps,
      paths,
      staging: await createTestPhaseDeps({ root: deps.paths.root, environment: "staging" }),
    };
  }

  it("lists each environment's target, source, runner and whether it is deployed", async () => {
    const { deps } = await withStaging(
      inEnvironment(testPlan({ domain: "shop.example.com", provider: "digitalocean" }), "staging", {
        runner: "server",
      }),
    );
    expect(await listEnvironments(deps.paths)).toEqual([
      {
        name: "prod",
        target: "hetzner",
        from: "main",
        branch: "main",
        runner: "github",
        deployed: true,
      },
      {
        name: "staging",
        target: "digitalocean",
        from: "main",
        branch: "main",
        runner: "server",
        deployed: false,
      },
    ]);
  });

  it("lists a promoted environment by its source, never the branch it keeps for later", async () => {
    const { deps } = await withStaging();
    const qa = inEnvironment(prodPlan(), "qa", {
      deploySource: { from: "promote", source: "staging" },
    });
    await writeArtifact(
      "plan",
      environmentPaths(deps.paths, "qa").files.plan,
      DeployPlanSchema.parse({ ...qa, cicd: { ...qa.cicd, branch: "develop" } }),
    );
    expect((await listEnvironments(deps.paths)).at(-1)).toEqual({
      name: "qa",
      target: "hetzner",
      from: "staging",
      runner: "github",
      deployed: false,
    });
  });

  it("removes only the environment's own files", async () => {
    const { deps, paths, staging } = await withStaging();
    const root = deps.paths.root;
    const files = [
      paths.files.requirements,
      join(paths.stateDir, "state.json"),
      paths.files.deployKey,
      join(root, "opscrew/infra/staging/main.tf"),
      join(root, "opscrew/infra/storage-staging/main.tf"),
      join(root, ".github/workflows/opscrew-deploy-staging.yml"),
    ];
    const prodFiles = [
      join(root, "opscrew/infra/prod/main.tf"),
      join(root, ".github/workflows/opscrew-deploy.yml"),
      deps.paths.files.deployKey,
      join(deps.paths.stateDir, "state.json"),
    ];
    for (const file of [...files, ...prodFiles]) {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, "x");
    }
    const removed = await removeEnvironment(staging);
    // The plan's folder last, so a removal stopped half-way can be run again.
    expect(removed).toEqual([
      ".opscrew/environments/staging",
      "opscrew/infra/staging",
      "opscrew/infra/storage-staging",
      ".github/workflows/opscrew-deploy-staging.yml",
      `.home-opscrew/projects/${deps.paths.projectId}/environments/staging`,
      "opscrew/environments/staging",
    ]);
    for (const file of files) expect(await exists(file)).toBe(false);
    for (const file of prodFiles) expect(await exists(file)).toBe(true);
    expect(await readArtifact("plan", deps.paths.files.plan)).toEqual(
      testPlan({ domain: "shop.example.com", deployed: true }),
    );
    expect(await listEnvironments(deps.paths)).toMatchObject([{ name: "prod" }]);
  });

  it("refuses while the environment is deployed, or another is promoted from it", async () => {
    const deployed = DeployPlanSchema.parse({
      ...inEnvironment(prodPlan(), "staging"),
      deployment: { lastApplyAt: "2026-10-11T11:00:00.000Z" },
    });
    const live = await withStaging(deployed);
    const stop = await failure(removeEnvironment(live.staging));
    expect(stop.code).toBe("PHASE_PRECONDITION");
    expect(stop.message).toBe(
      "The staging environment is deployed, so OpsCrew removed none of its files.",
    );
    expect(stop.hint).toBe(
      "Run `opscrew destroy --env staging` first, then `opscrew env remove staging`.",
    );
    expect(await exists(live.paths.files.plan)).toBe(true);

    // A half-way first apply leaves a state, and what OpsCrew made in a Portainer counts too.
    const halfway = await withStaging();
    await mkdir(halfway.paths.files.tfstateDir, { recursive: true });
    await writeFile(stateFile(halfway.paths), '{"version":4}\n');
    expect((await failure(removeEnvironment(halfway.staging))).code).toBe("PHASE_PRECONDITION");
    const portainer = await withStaging();
    await recordPortainerConnection(portainer.paths, {
      url: "https://portainer.lan:9443",
      environmentId: 1,
      environmentName: "local",
      created: { stacks: [{ id: 4, name: "opscrew-shop-staging", role: "app" }] },
    });
    expect((await failure(removeEnvironment(portainer.staging))).code).toBe("PHASE_PRECONDITION");

    // Provision applies the shared Cloudflare change first: its record may be all there is.
    const record = { zoneId: "0".repeat(32), createdEntrypoints: [] };
    const named = await withStaging();
    await writeCloudflareRecord(named.paths, {
      ...record,
      hostnames: { "opscrew-strict-tls": ["staging.example.com"] },
    });
    expect((await failure(removeEnvironment(named.staging))).code).toBe("PHASE_PRECONDITION");
    const certified = await withStaging();
    await writeCloudflareRecord(certified.paths, {
      ...record,
      hostnames: {},
      tls: {
        origin: {
          id: "o1",
          hostnames: ["staging.example.com"],
          expiresAt: "2041-10-16T23:53:00.000Z",
          sha256: "a".repeat(64),
          superseded: [],
        },
      },
    });
    expect((await failure(removeEnvironment(certified.staging))).code).toBe("PHASE_PRECONDITION");
    // A damaged record stops too, and nothing is removed.
    const damaged = await withStaging();
    await mkdir(damaged.paths.stateDir, { recursive: true });
    await writeFile(damaged.paths.files.cloudflareRecord, "{ not json");
    await failure(removeEnvironment(damaged.staging));
    expect(await exists(damaged.paths.files.plan)).toBe(true);
    // A record destroy emptied lets the environment go.
    const emptied = await withStaging();
    await writeCloudflareRecord(emptied.paths, { ...record, hostnames: {}, tls: {} });
    await removeEnvironment(emptied.staging);
    expect(await exists(emptied.paths.files.plan)).toBe(false);

    const source = await withStaging();
    await setDeploySource(source.deps.paths.root, "prod", "staging");
    const promoted = await failure(removeEnvironment(source.staging));
    expect(promoted.message).toBe(
      "prod is promoted from staging, so OpsCrew removed none of its files.",
    );
    expect(promoted.hint).toBe(
      "Deploy it from another source first, for example `opscrew env set prod --from main`.",
    );
  });

  it("leaves prod to opscrew destroy", async () => {
    const deps = await project({ prod: prodPlan() });
    expect((await failure(removeEnvironment(deps))).code).toBe("INVALID_INPUT");
  });
});

describe("the phases' paths per environment", () => {
  const input = (root: string, environment?: string) => ({
    root,
    env: { OPSCREW_HOME: join(root, ".home-opscrew") },
    reporter: new MemoryReporter(),
    redactor: new Redactor(),
    approvalHandler: new ScriptedApprovalHandler(),
    runner: new ScriptedRunner(),
    fetch: forbiddenFetch,
    clock: { now: () => new Date("2026-10-22T10:00:00.000Z") },
    interactive: false,
    version: "0.0.0-test",
    ...(environment === undefined ? {} : { environment }),
  });

  it("gives prod today's paths and state file, and another environment its own", async () => {
    const { root } = (await createTestPhaseDeps()).paths;
    const env = { OPSCREW_HOME: join(root, ".home-opscrew") };
    const prod = buildPhaseDeps(input(root));
    expect(prod.paths).toEqual(resolveProjectPaths(root, { env }));
    expect(buildPhaseDeps(input(root, "prod")).paths).toEqual(prod.paths);
    expect(stateFile(prod.paths)).toBe(join(root, ".opscrew", "tfstate", "prod.tfstate"));

    const staging = buildPhaseDeps(input(root, "staging"));
    expect(staging.paths.environment).toBe("staging");
    expect(staging.paths.files.plan).toBe(join(root, "opscrew/environments/staging/plan.yaml"));
    expect(staging.paths.files.state).toBe(join(root, ".opscrew/environments/staging/state.json"));
    expect(stateFile(staging.paths)).toBe(
      join(root, ".opscrew/environments/staging/tfstate/staging.tfstate"),
    );
    expect(staging.paths.files.deployKey).toBe(
      join(root, ".home-opscrew/projects", prod.paths.projectId, "environments/staging/deploy_key"),
    );
  });

  it("names the environment's own state file when it is missing", () => {
    const prod = prodPlan();
    expect(stateNotHere(prod, "tell what to delete", "hint").message).toBe(
      "The infrastructure state of shop is not on this computer (.opscrew/tfstate/prod.tfstate), so OpsCrew cannot tell what to delete. Nothing was changed.",
    );
    expect(stateNotHere(inEnvironment(prod, "staging"), "move it", "hint").message).toBe(
      "The infrastructure state of shop-staging is not on this computer (.opscrew/environments/staging/tfstate/staging.tfstate), so OpsCrew cannot move it. Nothing was changed.",
    );
  });

  it("keeps each environment's recovery copy and pull.pem beside its own files", async () => {
    const deps = await createTestPhaseDeps();
    expect(copyPath(deps.paths)).toBe(COPY_PATH);
    expect(copyPath(environmentPaths(deps.paths, "staging"))).toBe(
      "opscrew/environments/staging/secrets.sops.json",
    );
    const values = { ORIGIN_PULL_CERT: "-----BEGIN CERTIFICATE-----\n" };
    expect(pullPemFile(prodPlan(), values).path).toBe("opscrew/runtime/edge/tls/pull.pem");
    expect(pullPemFile(inEnvironment(prodPlan(), "staging"), values).path).toBe(
      "opscrew/environments/staging/runtime/edge/tls/pull.pem",
    );
  });

  it("writes staging's recovery copy at its own path, from its own files", async () => {
    const world = await recoveryWorld();
    const staging = await createTestPhaseDeps({
      root: world.root,
      env: world.deps.env,
      runner: world.deps.runner,
      environment: "staging",
    });
    const { "state/tfstate/prod.tfstate": _prod, ...provisioned } = provisionedFiles();
    const own = { ...provisioned, "home/deploy_key": "STAGING-KEY-FILE\n" };
    await writeLocal(staging, { ...own, "state/tfstate/staging.tfstate": '{"version":4}\n' });
    const result = await refreshRecoveryCopy(
      staging,
      { app: { name: "shop-staging" } },
      {
        repositoryPrivate: async () => true,
        keyOut: async () => join(world.keys, "age-key.txt"),
      },
    );
    if (!result.changed) throw new Error("expected a copy");
    const files = Object.fromEntries(result.repositoryFiles.map((file) => [file.path, file]));
    expect(Object.keys(files).sort()).toEqual([
      ".gitattributes",
      "opscrew/.sops.yaml",
      "opscrew/environments/staging/secrets.sops.json",
    ]);
    expect(files[".gitattributes"]?.content).toBe(
      "opscrew/environments/staging/secrets.sops.json text eol=lf\nopscrew/.sops.yaml text eol=lf\n",
    );
    const sealed = world.sops.calls.find((call) => call.args[0] === "encrypt")?.input ?? "";
    expect(Object.keys((JSON.parse(sealed) as { files: object }).files).sort()).toEqual(
      Object.keys({ ...own, "state/tfstate/staging.tfstate": "" }).sort(),
    );
    expect(sealed).toContain("STAGING-KEY-FILE");

    // staging's status names its own copy; prod's says nothing new.
    await writeRepositoryFiles(world.root, result.repositoryFiles);
    const status = await recoveryStatus(staging);
    expect(status).toMatchObject({
      exists: true,
      path: "opscrew/environments/staging/secrets.sops.json",
    });
    expect(recoveryStatusLines(status)[0]).toMatch(
      /^Recovery copy \(opscrew\/environments\/staging\/secrets\.sops\.json\)/,
    );
    expect(await recoveryStatus(world.deps)).not.toHaveProperty("path");
  });

  it("renders one dependabot.yml for every environment, from prod's provision or staging's", async () => {
    const prod = prodPlan();
    const staging = inEnvironment(prod, "staging");
    const deps = await project({ prod, staging });
    const facts = makeFacts({ name: "shop" });
    const fromProd = await dependabotStep(deps.paths.root, facts, prod);
    const fromStaging = await dependabotStep(deps.paths.root, facts, staging);
    expect(fromStaging).toEqual(fromProd);
    expect(fromProd.action === "write" && fromProd.file.content).toContain(
      "- /opscrew/environments/staging/runtime",
    );
    // Prod alone renders today's file.
    const alone = await project({ prod });
    const today = await dependabotStep(alone.paths.root, facts, prod);
    expect(today.action === "write" && today.file.content).not.toContain("environments");
  });

  it("brings OpsCrew's committed dependabot.yml up to date when an environment comes or goes", async () => {
    const prod = prodPlan();
    const staging = inEnvironment(prod, "staging");
    const deps = await project({ prod, staging });
    const facts = makeFacts({ name: "shop" });
    const file = join(deps.paths.root, ".github/dependabot.yml");
    await mkdir(dirname(file), { recursive: true });
    // prod's provision committed its file before staging came.
    await writeFile(file, renderDependabot(facts, prod).content.replace(/\n/g, "\r\n"));
    const added = await dependabotStep(deps.paths.root, facts, staging);
    expect(added.action).toBe("write");
    expect(added.action === "write" && added.file.content).toContain(
      "- /opscrew/environments/staging/runtime\n",
    );
    // After staging is removed, prod's provision takes its folders out again.
    if (added.action === "write") await writeFile(file, added.file.content);
    const alone = await project({ prod });
    await mkdir(join(alone.paths.root, ".github"), { recursive: true });
    await writeFile(join(alone.paths.root, ".github/dependabot.yml"), await readFile(file, "utf8"));
    const removed = await dependabotStep(alone.paths.root, facts, prod);
    expect(removed).toEqual({ action: "write", file: renderDependabot(facts, prod) });
    // A file the user changed stays theirs.
    await writeFile(file, `${renderDependabot(facts, prod).content}# mine\n`);
    expect((await dependabotStep(deps.paths.root, facts, staging)).action).toBe("keep");
  });
});
