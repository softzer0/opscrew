import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
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
  euCatalog,
  makeRequirements,
  nextPostgresFacts,
  PORTAINER_URL,
  portainerPlan,
  type TestPhaseDeps,
} from "../testing";
import {
  addEnvironment,
  environmentQuestions,
  listEnvironments,
  setDeploySource,
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
      { name: "prod", target: "hetzner", from: "main", runner: "github", deployed: false },
      { name: "staging", target: "hetzner", from: "main", runner: "github", deployed: false },
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
    ]);
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

  it("offers this computer, whose design comes with the localhost target's own task", async () => {
    const { staging } = await prodApp();
    const error = await failure(addEnvironment(staging, { answers: { provider: "localhost" } }));
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toContain("not supported for the localhost target yet");
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
