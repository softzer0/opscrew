import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { exists, OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import {
  type Architecture,
  type ProjectFacts,
  type Requirements,
  readArtifact,
  writeArtifact,
} from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { runDesign } from "../design/run";
import type { OwnServerFacts } from "../providers";
import {
  type OwnServerConnectionInput,
  readOwnServer,
  readPortainerConnection,
  recordOwnServer,
  recordPortainerConnection,
} from "../shared";
import {
  createTestPhaseDeps,
  ED25519_FINGERPRINT,
  euCatalog,
  FakeHostServer,
  freshFacts,
  makeRequirements,
  nextPostgresFacts,
  ownRunner,
  PORTAINER_URL,
  portainerPlan,
  readyRemote,
  ScriptedRunner,
  type TestPhaseDeps,
} from "../testing";
import { remoteWith } from "./__fixtures__/remote";
import {
  addEnvironment,
  type EnvironmentQuestion,
  environmentQuestions,
  listEnvironments,
  setDeploySource,
  setEnvironmentRunner,
  sharedPartsDiffer,
} from "./index";

const DOMAIN = "shop.example.com";
const IPV4 = "203.0.113.10";
const HOST_KEY = `SHA256:${"A".repeat(43)}`;
const SERVER: OwnServerFacts = {
  arch: "amd64",
  vcpus: 4,
  memoryGb: 8,
  diskFreeGb: 120,
  os: "Ubuntu 24.04",
};

function architecture(facts: ProjectFacts): Architecture {
  return {
    schemaVersion: 1,
    generatedAt: "2026-10-11T10:00:00.000Z",
    generator: { tool: "opscrew", version: "0.0.0-test" },
    facts,
    summary: "A shop.",
    risks: [],
    aiEnriched: false,
  };
}

interface App {
  prod: TestPhaseDeps;
  staging: TestPhaseDeps;
}

/** A designed prod app (Next.js with Postgres on `DOMAIN`), and the deps of its `staging`. */
async function prodApp(
  requirements: Requirements = makeRequirements({ domain: DOMAIN, dnsProvider: "cloudflare" }),
  design: Parameters<typeof runDesign>[1] = { catalog: euCatalog() },
  own?: OwnServerConnectionInput,
): Promise<App> {
  const prod = await createTestPhaseDeps();
  await writeArtifact(
    "architecture",
    prod.paths.files.architecture,
    architecture(nextPostgresFacts({ name: "shop" })),
  );
  await writeArtifact("requirements", prod.paths.files.requirements, requirements);
  if (own !== undefined) await recordOwnServer(prod.paths, own);
  await runDesign(prod, design);
  const staging = await createTestPhaseDeps({ root: prod.paths.root, environment: "staging" });
  return { prod, staging };
}

async function failure(promise: Promise<unknown>): Promise<OpsCrewError> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(OpsCrewError);
  return error as OpsCrewError;
}

describe("addEnvironment", () => {
  it("adds staging beside an app in prod: its own answers and names, prod's shared parts, prod untouched", async () => {
    const { prod, staging } = await prodApp();
    const prodPlan = await readArtifact("plan", prod.paths.files.plan);
    const prodBytes = await readFile(prod.paths.files.plan, "utf8");

    const result = await addEnvironment(staging, {
      answers: { provider: "hetzner" },
      design: { catalog: euCatalog() },
    });
    const { plan } = result.design;
    expect(plan.environment).toEqual({
      name: "staging",
      deploySource: { from: "main" },
      runner: "github",
    });
    expect(plan.app.name).toBe(`${prodPlan.app.name}-staging`);
    expect(plan.infra.dir).toBe("opscrew/infra/staging");
    expect(plan.cicd.workflowPath).toBe(".github/workflows/opscrew-deploy-staging.yml");
    // staging.shop.example.com would be too deep for Cloudflare's free certificate.
    expect(plan.dns).toMatchObject({ provider: "cloudflare", domain: "staging-shop.example.com" });
    expect(sharedPartsDiffer(prodPlan, plan)).toEqual([]);
    expect(plan.target).toMatchObject({ provider: "hetzner", mode: "vps-compose" });
    expect(await readArtifact("plan", staging.paths.files.plan)).toEqual(plan);

    // Its own answers are only those that differ from prod's.
    const own = await readFile(staging.paths.files.requirements, "utf8");
    expect(own).toContain("domain: staging-shop.example.com");
    expect(own).not.toMatch(/budgetMonthly|provider|uptime/);
    expect(result.requirements).toMatchObject({
      domain: "staging-shop.example.com",
      region: "eu-central",
    });

    // The monthly cost is shown, and what comes next.
    const said = staging.reporter.text();
    expect(said).toMatch(/Wrote opscrew\/environments\/staging\/plan\.yaml: .*€\d+\.\d\d\/month/);
    expect(said).toContain("Next: run `opscrew provision --env staging`.");
    expect(result.design.chosen.cost.monthly.amount).toBeGreaterThan(0);

    // Prod stays byte-identical, and its next design changes nothing.
    expect(await readFile(prod.paths.files.plan, "utf8")).toBe(prodBytes);
    await runDesign(prod, { catalog: euCatalog() });
    expect(await readFile(prod.paths.files.plan, "utf8")).toBe(prodBytes);
    expect(prod.reporter.text()).toContain("opscrew/plan.yaml is up to date");

    // staging's next design keeps its plan, environment block included.
    await runDesign(staging, { catalog: euCatalog() });
    expect(staging.reporter.text()).toContain(
      "opscrew/environments/staging/plan.yaml is up to date",
    );
    expect(await listEnvironments(prod.paths)).toEqual([
      {
        name: "prod",
        target: "hetzner",
        from: "main",
        branch: "trunk",
        runner: "github",
        deployed: false,
      },
      {
        name: "staging",
        target: "hetzner",
        from: "main",
        branch: "trunk",
        runner: "github",
        deployed: false,
      },
    ]);
  });

  it("asks only the environment's own questions, with their defaults", async () => {
    const { prod } = await prodApp();
    const prodPlan = await readArtifact("plan", prod.paths.files.plan);
    const base = await readArtifact("requirements", prod.paths.files.requirements);
    const facts = nextPostgresFacts({ name: "shop" });
    const context = { prodPlan, base, environments: ["prod"] };
    const questions = environmentQuestions("staging", context, facts);
    expect(questions.map((q) => q.id)).toEqual([
      "provider",
      "region",
      "expectedMonthlyUsers",
      "domain",
      "from",
      "runner",
      "build",
    ]);
    // Where to build is optional: GitHub's machines unless answered.
    expect(questions.at(-1)).toMatchObject({ required: false });
    expect(questions.at(-1)?.default).toBeUndefined();
    const defaults = Object.fromEntries(questions.map((q) => [q.id, q.default]));
    expect(defaults).toEqual({
      provider: "hetzner",
      region: "eu-central",
      expectedMonthlyUsers: "<1k",
      domain: "staging-shop.example.com",
      from: "main",
      runner: "github",
    });
    expect(questions[0]?.options?.map((o) => o.value)).toContain("localhost");
    expect(questions[4]?.options?.map((o) => o.value)).toEqual(["main", "prod"]);
    // dev runs on this computer by default.
    expect(environmentQuestions("dev", context, facts)[0]?.default).toBe("localhost");

    // An interactive run gets these questions once and their answers.
    const staging = await createTestPhaseDeps({ root: prod.paths.root, environment: "staging" });
    const asked: string[][] = [];
    const result = await addEnvironment(staging, {
      ask: async (shown) => {
        asked.push(shown.map((q) => q.id));
        return { from: "prod", expectedMonthlyUsers: "1k-10k" };
      },
      design: { catalog: euCatalog() },
    });
    expect(asked).toHaveLength(1);
    expect(result.design.plan.environment?.deploySource).toEqual({
      from: "promote",
      source: "prod",
    });
    expect(await readFile(staging.paths.files.requirements, "utf8")).toContain(
      "expectedMonthlyUsers: 1k-10k",
    );
  });

  it("puts two environments on one own server: prod's connection is the default, its host key kept", async () => {
    const requirements = { ...makeRequirements({ domain: DOMAIN, dnsProvider: "cloudflare" }) };
    const { region: _region, ...ownRequirements } = { ...requirements, provider: "own" as const };
    const connection: OwnServerConnectionInput = {
      host: IPV4,
      port: 22,
      user: "root",
      agent: true,
      reachable: true,
      serve: "dns-only",
      hostKey: HOST_KEY,
      publicIpv4: IPV4,
    };
    const { prod, staging } = await prodApp(
      ownRequirements,
      { ownServer: { facts: SERVER } },
      connection,
    );
    const prodPlan = await readArtifact("plan", prod.paths.files.plan);
    const prodBytes = await readFile(prod.paths.files.plan, "utf8");

    const result = await addEnvironment(staging, {
      answers: { provider: "own" },
      design: {
        ownServer: {
          facts: SERVER,
          apps: [{ name: prodPlan.app.name, memoryMb: 1024, tunnel: false }],
        },
      },
    });
    // The same server, reached and pinned as for prod; the record has nothing of prod's own.
    expect(await readOwnServer(staging.paths)).toEqual(await readOwnServer(prod.paths));
    const { plan } = result.design;
    expect(plan.target).toEqual(prodPlan.target);
    expect(plan.app.name).toBe(`${prodPlan.app.name}-staging`);
    expect(plan.dns).toMatchObject({ domain: "staging-shop.example.com", proxied: false });
    expect(sharedPartsDiffer(prodPlan, plan)).toEqual([]);
    expect(await readFile(prod.paths.files.plan, "utf8")).toBe(prodBytes);
  });

  it("asks the server's follow-ups for another server, with prod's as the defaults", async () => {
    const { region: _region, ...ownRequirements } = {
      ...makeRequirements({ domain: DOMAIN, dnsProvider: "cloudflare" }),
      provider: "own" as const,
    };
    const { staging } = await prodApp(
      ownRequirements,
      { ownServer: { facts: SERVER } },
      {
        host: IPV4,
        port: 22,
        user: "root",
        agent: true,
        reachable: true,
        serve: "dns-only",
        hostKey: HOST_KEY,
      },
    );
    const defaults: Record<string, unknown> = {};
    await addEnvironment(staging, {
      answers: { provider: "own" },
      askServer: async (questions) => {
        for (const q of questions) defaults[q.id] = q.default;
        return { "server.host": "198.51.100.7", "server.user": "admin" };
      },
      design: { ownServer: { facts: SERVER } },
    });
    expect(defaults).toMatchObject({ "server.host": IPV4, "server.user": "root" });
    // Another server: its host key is confirmed at its first connection.
    expect(await readOwnServer(staging.paths)).toEqual({
      host: "198.51.100.7",
      port: 22,
      user: "admin",
      agent: true,
      reachable: true,
      serve: "dns-only",
    });
  });

  it("puts staging in prod's Portainer as another stack, without prod's record of what it made", async () => {
    const first = await createTestPhaseDeps();
    const root = first.paths.root;
    const env = { ...first.env, PORTAINER_API_KEY: fakeSecret("generic-password", "portainer") };
    const prod = await createTestPhaseDeps({ root, env });
    const staging = await createTestPhaseDeps({ root, env, environment: "staging" });
    await writeArtifact(
      "architecture",
      prod.paths.files.architecture,
      architecture(nextPostgresFacts({ name: "shop" })),
    );
    const { region: _region, ...base } = makeRequirements({
      domain: DOMAIN,
      dnsProvider: "cloudflare",
    });
    await writeArtifact("requirements", prod.paths.files.requirements, {
      ...base,
      provider: "portainer",
    });
    await writeArtifact("plan", prod.paths.files.plan, portainerPlan({ web: { mode: "caddy" } }));
    const certificate = `SHA256:${createHash("sha256").update("portainer").digest("hex")}`;
    await recordPortainerConnection(prod.paths, {
      url: PORTAINER_URL,
      certFingerprint: certificate,
      environmentId: 3,
      environmentName: "local",
      arch: "amd64",
      redeploy: "updater",
      web: { mode: "caddy" },
      created: { stacks: [{ id: 4, name: "opscrew-shop", role: "app" }], volumes: ["shop_db"] },
    });
    const prodRecord = await readFile(join(prod.paths.stateDir, "server.json"), "utf8");
    const calls: string[] = [];
    const result = await addEnvironment(staging, {
      answers: { provider: "portainer" },
      portainer: {
        access: {
          fetchCertificateFingerprint: async (url) => {
            calls.push(`fingerprint ${url}`);
            return certificate;
          },
          listEnvironments: async () => [
            { id: 3, name: "local", kind: "docker", up: true, arch: "amd64" },
          ],
        },
      },
    });
    // The pinned certificate of the same address needs no new confirmation.
    expect(calls).toEqual([`fingerprint ${PORTAINER_URL}`]);
    expect(await readPortainerConnection(staging.paths)).toEqual({
      url: PORTAINER_URL,
      certFingerprint: certificate,
      environmentId: 3,
      environmentName: "local",
      arch: "amd64",
      redeploy: "updater",
      web: { mode: "caddy" },
      created: { stacks: [], volumes: [] },
    });
    expect(await readFile(join(prod.paths.stateDir, "server.json"), "utf8")).toBe(prodRecord);
    expect(result.design.plan.target).toMatchObject({ provider: "portainer", environmentId: 3 });
    expect(result.design.plan.app.name).toBe("shop-staging");
  });

  it("refuses a hostname another environment uses, before writing the plan", async () => {
    const { staging } = await prodApp();
    const error = await failure(
      addEnvironment(staging, { answers: { domain: DOMAIN }, design: { catalog: euCatalog() } }),
    );
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.message).toBe(
      "shop.example.com is already the prod environment's hostname, and every environment needs its own. Nothing was changed.",
    );
    expect(error.hint).toBe(
      "Give staging another hostname (domain) in opscrew/environments/staging/requirements.yaml, then run `opscrew design --env staging` again.",
    );
    expect(await exists(staging.paths.files.plan)).toBe(false);
  });

  it("refuses prod's design when its domain becomes one staging uses", async () => {
    const { prod, staging } = await prodApp();
    await addEnvironment(staging, { design: { catalog: euCatalog() } });
    const before = await readFile(prod.paths.files.plan, "utf8");
    const answers = await readArtifact("requirements", prod.paths.files.requirements);
    await writeArtifact("requirements", prod.paths.files.requirements, {
      ...answers,
      answeredAt: "2026-10-11T13:00:00.000Z",
      domain: "staging-shop.example.com",
    });
    const error = await failure(runDesign(prod, { catalog: euCatalog() }));
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.message).toBe(
      "staging-shop.example.com is already the staging environment's hostname, and every environment needs its own. Nothing was changed.",
    );
    expect(error.hint).toBe(
      "Answer another domain with `opscrew interview`, then run `opscrew design` again.",
    );
    expect(await readFile(prod.paths.files.plan, "utf8")).toBe(before);
  });

  it("refuses a runner the target does not take, an unknown source, and writes nothing", async () => {
    const { staging } = await prodApp();
    const local = await failure(addEnvironment(staging, { answers: { runner: "local" } }));
    expect(local.code).toBe("INVALID_INPUT");
    expect(local.message).toContain("needs this computer (localhost) as the target");
    const source = await failure(addEnvironment(staging, { answers: { from: "qa" } }));
    expect(source.message).toBe(
      'from must be main or one of the app\'s environments (prod), not "qa".',
    );
    expect(await exists(staging.paths.files.requirements)).toBe(false);
  });

  it("designs this computer as the environment's target, without prod's domain", async () => {
    const { staging } = await prodApp();
    const { design } = await addEnvironment(staging, {
      answers: { provider: "localhost" },
      design: { localhost: { arch: "x64", portFree: async () => true } },
    });
    expect(design.plan.target).toMatchObject({
      provider: "localhost",
      ports: { https: 443, http: 80 },
    });
    expect(design.plan.dns).toMatchObject({ provider: "none" });
    expect(design.plan.dns.domain).toBeUndefined();
  });

  it("stops for prod, for an environment that exists, and before prod's plan", async () => {
    const { prod, staging } = await prodApp();
    expect((await failure(addEnvironment(prod))).code).toBe("INVALID_INPUT");
    await addEnvironment(staging, { design: { catalog: euCatalog() } });
    const again = await failure(addEnvironment(staging));
    expect(again.message).toBe("The app already has a staging environment.");

    const fresh = await createTestPhaseDeps({ environment: "staging" });
    const early = await failure(addEnvironment(fresh));
    expect(early.code).toBe("PHASE_PRECONDITION");
    expect(early.hint).toBe("Run `opscrew design` first, then add the environment.");
  });
});

describe("env add with branches named like environments (FR-1537)", () => {
  /** prod designed (it follows trunk, the default branch), and `name`'s deps with git's `branches`. */
  async function withBranches(name: string, branches: readonly string[]) {
    const { prod } = await prodApp();
    const runner = remoteWith(branches);
    const deps = await createTestPhaseDeps({ root: prod.paths.root, environment: name, runner });
    return { prod, deps, runner };
  }

  /** An interactive run that answers the setup with `setup` and the rest with `answers`. */
  function terminal(setup: string | undefined, answers: Record<string, string> = {}) {
    const shown: EnvironmentQuestion[][] = [];
    const ask = async (questions: EnvironmentQuestion[]) => {
      shown.push(questions);
      if (questions[0]?.id !== "setup") return { provider: "hetzner", ...answers };
      return setup === undefined ? {} : { setup };
    };
    return { shown, ask };
  }

  const BRANCHES = ["trunk", "develop", "staging", "feature/login"];

  it("in a terminal, shows both setups first and preselects promotion: dev then follows trunk", async () => {
    const { deps } = await withBranches("dev", BRANCHES);
    const run = terminal("promotion");
    const { design } = await addEnvironment(deps, {
      ask: run.ask,
      design: { catalog: euCatalog() },
    });
    expect(run.shown.map((questions) => questions[0]?.id)).toEqual(["setup", "provider"]);
    expect(run.shown[0]).toEqual([
      {
        id: "setup",
        prompt:
          "Your repository has branches named like environments (trunk, develop and staging). How should your environments get new versions?",
        kind: "single-select",
        options: [
          {
            value: "promotion",
            label: "Promotion first: one image moves dev → staging → prod (recommended)",
            hint: "dev is built and deployed on each push to trunk, and the environments after it are promoted with exactly the image it ran",
          },
          {
            value: "branches",
            label:
              "Each environment follows its own branch (dev ← develop, staging ← staging, prod ← trunk)",
            hint: "dev is built and deployed on each push to develop; each branch builds its own image",
          },
        ],
        default: "promotion",
        required: true,
      },
    ]);
    expect(design.plan.environment?.deploySource).toEqual({ from: "main" });
    expect(design.plan.cicd.branch).toBe("trunk");
  });

  it("in a terminal, with each environment on its own branch, dev follows develop", async () => {
    const { deps } = await withBranches("dev", BRANCHES);
    const run = terminal("branches");
    const { design } = await addEnvironment(deps, {
      ask: run.ask,
      design: { catalog: euCatalog() },
    });
    const from = run.shown[1]?.find((question) => question.id === "from");
    expect(from?.default).toBe("main");
    expect(from?.options?.[0]?.label).toBe("Built and deployed on each push to develop");
    expect(design.plan.environment?.deploySource).toEqual({ from: "main" });
    expect(design.plan.cicd.branch).toBe("develop");
    expect((await readArtifact("plan", deps.paths.files.plan)).cicd.branch).toBe("develop");
    // A later design keeps it.
    await runDesign(deps, { catalog: euCatalog() });
    expect((await readArtifact("plan", deps.paths.files.plan)).cicd.branch).toBe("develop");
  });

  it("in a terminal, promotion first promotes a new staging from dev", async () => {
    const { prod } = await withBranches("dev", BRANCHES);
    const dev = await createTestPhaseDeps({
      root: prod.paths.root,
      environment: "dev",
      runner: remoteWith(BRANCHES),
    });
    await addEnvironment(dev, {
      answers: { provider: "hetzner" },
      design: { catalog: euCatalog() },
    });
    const staging = await createTestPhaseDeps({
      root: prod.paths.root,
      environment: "staging",
      runner: remoteWith(BRANCHES),
    });
    const run = terminal("promotion");
    const { design } = await addEnvironment(staging, {
      ask: run.ask,
      design: { catalog: euCatalog() },
    });
    expect(run.shown[0]?.[0]?.options?.[0]?.hint).toBe(
      "staging is promoted from dev, with exactly the image dev runs",
    );
    expect(run.shown[1]?.find((question) => question.id === "from")?.default).toBe("dev");
    expect(design.plan.environment?.deploySource).toEqual({ from: "promote", source: "dev" });
  });

  it("in a terminal, a deploy source answered after the setup wins over its branch", async () => {
    const { deps } = await withBranches("dev", BRANCHES);
    const run = terminal("branches", { from: "prod" });
    const { design } = await addEnvironment(deps, {
      ask: run.ask,
      design: { catalog: euCatalog() },
    });
    expect(design.plan.environment?.deploySource).toEqual({ from: "promote", source: "prod" });
  });

  it("in a script, guesses nothing: the flags decide, and a note names the branches", async () => {
    const { deps } = await withBranches("dev", BRANCHES);
    const { design } = await addEnvironment(deps, {
      answers: { provider: "hetzner" },
      design: { catalog: euCatalog() },
    });
    expect(design.plan.environment?.deploySource).toEqual({ from: "main" });
    expect(design.plan.cicd.branch).toBe("trunk");
    expect(deps.reporter.lines).toContainEqual({
      level: "info",
      message:
        "Your repository has branches named like environments: trunk, develop and staging. In a script OpsCrew guesses nothing, so the flags decide: the dev environment is built and deployed on each push to trunk. To have it follow develop, add --branch develop.",
    });

    const staging = await createTestPhaseDeps({
      root: deps.paths.root,
      environment: "staging",
      runner: remoteWith(BRANCHES),
    });
    const flagged = await addEnvironment(staging, {
      answers: { provider: "hetzner", branch: "staging" },
      design: { catalog: euCatalog() },
    });
    expect(flagged.design.plan.cicd.branch).toBe("staging");
    expect(staging.reporter.text()).toContain(
      "In a script OpsCrew guesses nothing, so the flags decide: the staging environment is built and deployed on each push to staging.\n",
    );
  });

  it("proposes nothing without a branch named like the environment, nor for another name", async () => {
    for (const [name, branches] of [
      ["dev", ["trunk", "staging"]],
      ["qa", BRANCHES],
    ] as const) {
      const { deps } = await withBranches(name, branches);
      const run = terminal("branches");
      await addEnvironment(deps, { ask: run.ask, design: { catalog: euCatalog() } });
      expect(run.shown.map((questions) => questions[0]?.id)).toEqual(["provider"]);
      expect(deps.reporter.text()).not.toContain("named like environments");
    }
  });

  it("says so and proposes nothing when git cannot read the remote's branches", async () => {
    const { prod } = await prodApp();
    const deps = await createTestPhaseDeps({
      root: prod.paths.root,
      environment: "dev",
      runner: new ScriptedRunner(() => ({
        exitCode: 2,
        stdout: "",
        stderr: "error: No such remote 'origin'",
      })),
    });
    const run = terminal("branches");
    await addEnvironment(deps, { ask: run.ask, design: { catalog: euCatalog() } });
    expect(run.shown.map((questions) => questions[0]?.id)).toEqual(["provider"]);
    expect(deps.reporter.text()).toContain(
      "warn: OpsCrew could not read your repository's branches on GitHub, so it proposes no setup for the dev environment: git remote failed: error: No such remote 'origin'",
    );
  });

  it("--branch refuses a branch the repository does not have, and writes nothing", async () => {
    const { deps } = await withBranches("dev", BRANCHES);
    const error = await failure(
      addEnvironment(deps, {
        answers: { provider: "hetzner", branch: "release/1" },
        design: { catalog: euCatalog() },
      }),
    );
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.message).toBe(
      "The repository on GitHub has no branch release/1, so no push to it could deploy the dev environment.",
    );
    expect(await exists(deps.paths.files.requirements)).toBe(false);
    expect(await exists(deps.paths.files.plan)).toBe(false);
  });

  it("--branch refuses a branch another environment follows, naming both, and writes nothing", async () => {
    const { deps } = await withBranches("dev", BRANCHES);
    await addEnvironment(deps, {
      answers: { provider: "hetzner", branch: "develop" },
      design: { catalog: euCatalog() },
    });
    const staging = await createTestPhaseDeps({
      root: deps.paths.root,
      environment: "staging",
      runner: remoteWith(BRANCHES),
    });
    const error = await failure(
      addEnvironment(staging, {
        answers: { provider: "hetzner", branch: "develop" },
        design: { catalog: euCatalog() },
      }),
    );
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.message).toBe(
      "The dev environment already follows develop, so the staging environment cannot follow it too: each push to develop would then build and deploy both.",
    );
    expect(await exists(staging.paths.files.plan)).toBe(false);
  });

  it("--branch with the default branch acts like no --branch, though prod follows it", async () => {
    const { deps } = await withBranches("dev", BRANCHES);
    const { design } = await addEnvironment(deps, {
      answers: { provider: "hetzner", branch: "trunk" },
      design: { catalog: euCatalog() },
    });
    expect(design.plan.cicd.branch).toBe("trunk");
    expect(design.plan.environment?.deploySource).toEqual({ from: "main" });
  });

  it("--branch refuses a promoted environment, which no push builds", async () => {
    const { deps } = await withBranches("dev", BRANCHES);
    const error = await failure(
      addEnvironment(deps, {
        answers: { provider: "hetzner", from: "prod", branch: "develop" },
        design: { catalog: euCatalog() },
      }),
    );
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.message).toBe(
      "A branch goes with from main: the dev environment would be promoted from prod, so no push builds it.",
    );
    expect(await exists(deps.paths.files.plan)).toBe(false);
  });
});

describe("design per environment", () => {
  it("keeps prod's environment block on its next design", async () => {
    const { prod, staging } = await prodApp();
    await addEnvironment(staging, { design: { catalog: euCatalog() } });
    const promoted = await setDeploySource(prod.paths.root, "prod", "staging");
    const before = await readFile(prod.paths.files.plan, "utf8");
    await runDesign(prod, { catalog: euCatalog() });
    expect(await readFile(prod.paths.files.plan, "utf8")).toBe(before);
    expect((await readArtifact("plan", prod.paths.files.plan)).environment).toEqual(
      promoted.environment,
    );
  });

  it("takes prod's shared parts again when staging's copy drifted", async () => {
    const { prod, staging } = await prodApp();
    await addEnvironment(staging, { design: { catalog: euCatalog() } });
    const plan = await readArtifact("plan", staging.paths.files.plan);
    await writeArtifact("plan", staging.paths.files.plan, {
      ...plan,
      app: { ...plan.app, port: 9999 },
    });
    await runDesign(staging, { catalog: euCatalog() });
    const prodPlan = await readArtifact("plan", prod.paths.files.plan);
    const redesigned = await readArtifact("plan", staging.paths.files.plan);
    expect(sharedPartsDiffer(prodPlan, redesigned)).toEqual([]);
  });

  it("stops before prod's plan exists", async () => {
    const deps = await createTestPhaseDeps({ environment: "staging" });
    await writeArtifact(
      "architecture",
      deps.paths.files.architecture,
      architecture(nextPostgresFacts()),
    );
    await writeArtifact(
      "requirements",
      deps.paths.files.shared.requirementsBase,
      makeRequirements(),
    );
    const error = await failure(runDesign(deps, { catalog: euCatalog() }));
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.hint).toBe(
      "Run `opscrew design` for prod first, then `opscrew design --env staging`.",
    );
  });
});

const MACHINE_IPV4 = "192.168.1.30";

/** Records the runner machine `name` on this computer, as `opscrew runner host add` leaves it. */
async function recordMachine(
  deps: TestPhaseDeps,
  name: string,
  o: { arch?: "amd64" | "arm64"; host?: string } = {},
): Promise<void> {
  const dir = join(deps.paths.homeDir, "projects", deps.paths.projectId, "runner-hosts");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `${name}.json`),
    `${JSON.stringify({
      schemaVersion: 1,
      name,
      login: {
        host: o.host ?? MACHINE_IPV4,
        port: 22,
        user: "ana",
        agent: true,
        hostKey: HOST_KEY,
      },
      arch: o.arch ?? "amd64",
      docker: true,
      environments: [],
    })}\n`,
  );
}

describe("an environment on a runner machine", () => {
  it("is added with its runner machine and builds there, offered with the questions which machine and where to build", async () => {
    const { prod, staging } = await prodApp();
    await recordMachine(staging, "home");
    const prodPlan = await readArtifact("plan", prod.paths.files.plan);
    const base = await readArtifact("requirements", prod.paths.files.requirements);
    const facts = nextPostgresFacts({ name: "shop" });
    const questions = environmentQuestions(
      "staging",
      { prodPlan, base, environments: ["prod"], runnerHosts: ["home"] },
      facts,
    );
    expect(questions.map((q) => q.id)).toEqual([
      "provider",
      "region",
      "expectedMonthlyUsers",
      "domain",
      "from",
      "runner",
      "runnerHost",
      "build",
    ]);
    expect(questions.find((q) => q.id === "runner")?.options?.map((o) => o.value)).toEqual([
      "github",
      "server",
      "local",
      "host",
    ]);
    // "This computer" is offered once, among the interview's targets.
    const targets = questions[0]?.options?.map((o) => o.value) ?? [];
    expect(targets.filter((value) => value === "localhost")).toHaveLength(1);

    const { design } = await addEnvironment(staging, {
      answers: { provider: "hetzner", runner: "host", build: "runner" },
      design: { catalog: euCatalog() },
    });
    expect(design.plan.environment).toEqual({
      name: "staging",
      deploySource: { from: "main" },
      runner: "host",
      runnerHost: { name: "home", arch: "amd64" },
      build: "runner",
    });
    // The plan names the machine, never its address.
    expect(await readFile(staging.paths.files.plan, "utf8")).not.toContain(MACHINE_IPV4);
  });

  it("refuses a build on a machine whose CPU is not the server's, naming the server types that match, and writes nothing", async () => {
    const { staging } = await prodApp();
    await recordMachine(staging, "pi", { arch: "arm64" });
    const error = await failure(
      addEnvironment(staging, {
        answers: { provider: "hetzner", runner: "host", runnerHost: "pi", build: "runner" },
        design: { catalog: euCatalog() },
      }),
    );
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.message).toBe(
      "The runner machine pi is arm64, and every server type OpsCrew offers at Hetzner Cloud is amd64 (x86-64): an image built on pi would not run on the server, so it cannot build the staging environment's image.",
    );
    expect(error.hint).toContain("build github");
    expect(await exists(staging.paths.files.requirements)).toBe(false);
    // Its deploy job alone may run there: GitHub's machines build the image for the server.
    const { design } = await addEnvironment(staging, {
      answers: { provider: "hetzner", runner: "host", runnerHost: "pi" },
      design: { catalog: euCatalog() },
    });
    expect(design.plan.environment?.runnerHost).toEqual({ name: "pi", arch: "arm64" });
    expect(design.plan.environment?.build).toBeUndefined();
  });

  it("refuses a runner machine that is the environment's own server, pointing to the server's runner", async () => {
    const { region: _region, ...ownRequirements } = {
      ...makeRequirements({ domain: DOMAIN, dnsProvider: "cloudflare" }),
      provider: "own" as const,
    };
    const { staging } = await prodApp(
      ownRequirements,
      { ownServer: { facts: SERVER } },
      {
        host: IPV4,
        port: 22,
        user: "root",
        agent: true,
        reachable: true,
        serve: "dns-only",
        hostKey: HOST_KEY,
      },
    );
    await recordMachine(staging, "box", { host: IPV4 });
    const error = await failure(
      addEnvironment(staging, {
        answers: { provider: "own", runner: "host", runnerHost: "box" },
        design: { ownServer: { facts: SERVER } },
      }),
    );
    expect(error).toMatchObject({
      code: "INVALID_INPUT",
      message:
        "The runner machine box is the staging environment's own server, so a runner there would be the server's runner.",
    });
    expect(error.hint).toContain("`opscrew env set staging --runner server`");
  });

  it("refuses a runner machine the project does not have, or several without a name", async () => {
    const { staging } = await prodApp();
    const none = await failure(addEnvironment(staging, { answers: { runner: "host" } }));
    expect(none.message).toBe(
      "runner host runs the deploy job on a runner machine, and this computer knows none for the project.",
    );
    await recordMachine(staging, "home");
    await recordMachine(staging, "pi", { arch: "arm64" });
    const several = await failure(addEnvironment(staging, { answers: { runner: "host" } }));
    expect(several.message).toBe(
      "runner host needs the runner machine's name: this project has home and pi.",
    );
    const unknown = await failure(
      addEnvironment(staging, { answers: { runner: "host", runnerHost: "nas" } }),
    );
    expect(unknown.code).toBe("PHASE_PRECONDITION");
    expect(await exists(staging.paths.files.requirements)).toBe(false);

    // Asked in a terminal, with both machines: GitHub's machines need no machine chosen.
    const asked: string[] = [];
    const { design } = await addEnvironment(staging, {
      ask: async (questions) => {
        const machine = questions.find((q) => q.id === "runnerHost");
        expect(machine).toMatchObject({ required: false });
        expect(machine?.default).toBeUndefined();
        asked.push(...(machine?.options ?? []).map((o) => o.value));
        return { runner: "github" };
      },
      design: { catalog: euCatalog() },
    });
    expect(asked).toEqual(["home", "pi"]);
    expect(design.plan.environment).toEqual({
      name: "staging",
      deploySource: { from: "main" },
      runner: "github",
    });
  });

  it("inspects a server of the user's before design, as `opscrew design` does", async () => {
    const { region: _region, ...ownRequirements } = {
      ...makeRequirements({ domain: DOMAIN, dnsProvider: "cloudflare" }),
      provider: "own" as const,
    };
    const { staging } = await prodApp(
      ownRequirements,
      { ownServer: { facts: SERVER } },
      {
        host: IPV4,
        port: 22,
        user: "root",
        agent: true,
        reachable: true,
        serve: "dns-only",
        hostKey: ED25519_FINGERPRINT,
      },
    );
    staging.runner = ownRunner();
    const host = new FakeHostServer(freshFacts({ arch: "arm64" }));
    const { design } = await addEnvironment(staging, {
      answers: { provider: "own" },
      ownServer: { services: { host, remote: (connection) => readyRemote(connection.host) } },
    });
    expect(host.inspections).toBe(1);
    expect(design.plan.target).toMatchObject({ provider: "own", arch: "arm64" });
  });
});

describe("setEnvironmentRunner (env set --runner)", () => {
  it("moves an environment's jobs to a runner machine and back, keeping its build only where it fits", async () => {
    const { staging } = await prodApp();
    await addEnvironment(staging, { design: { catalog: euCatalog() } });
    await recordMachine(staging, "home");
    const before = await readFile(staging.paths.files.plan, "utf8");

    const onMachine = await setEnvironmentRunner(staging.paths, {
      runner: "host",
      runnerHost: "home",
      build: "runner",
    });
    expect(onMachine.environment).toMatchObject({
      name: "staging",
      runner: "host",
      runnerHost: { name: "home", arch: "amd64" },
      build: "runner",
    });
    expect(await readArtifact("plan", staging.paths.files.plan)).toEqual(onMachine);
    // The same machine again, without --build, keeps the build there and changes nothing.
    const written = await readFile(staging.paths.files.plan, "utf8");
    await setEnvironmentRunner(staging.paths, { runner: "host", runnerHost: "home" });
    expect(await readFile(staging.paths.files.plan, "utf8")).toBe(written);

    const back = await setEnvironmentRunner(staging.paths, { runner: "github" });
    expect(back.environment).toEqual({
      name: "staging",
      deploySource: { from: "main" },
      runner: "github",
    });
    expect(await readFile(staging.paths.files.plan, "utf8")).toBe(before);
    const server = await failure(
      setEnvironmentRunner(staging.paths, { runner: "server", build: "runner" }),
    );
    expect(server.message).toBe(
      "The server's runner never builds: the app's build scripts would then run on the server the app serves from.",
    );
  });
});
