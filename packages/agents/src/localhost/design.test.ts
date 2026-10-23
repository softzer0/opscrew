import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type Architecture,
  type Requirements,
  readArtifact,
  writeArtifact,
} from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { runDesign } from "../design/run";
import { addEnvironment } from "../environments";
import { environmentPaths } from "../environments/paths";
import { answersToRequirements } from "../interview/answers";
import { buildQuestions, defaultProvider } from "../interview/questions";
import { providerProfile } from "../providers";
import { requireLocalRunnerImage } from "../runners";
import {
  createTestPhaseDeps,
  makeRequirements,
  nextPostgresFacts,
  type TestPhaseDeps,
} from "../testing";
import { resolveLocalImage } from "./image";
import { localhostHostSettingProblem } from "./preflight";
import { localRoots } from "./services";
import { localSite } from "./site";

const now = new Date("2026-10-11T12:00:00.000Z");

/** This computer as design sees it: its CPU and the ports something else listens on. */
const computer = (arch: string, busy: readonly number[] = []) => ({
  arch,
  portFree: async (port: number) => !busy.includes(port),
});

/** A project whose requirements put the app on this computer (prod's own). */
async function setup(
  requirements: Partial<Requirements> = {},
  facts = nextPostgresFacts(),
): Promise<TestPhaseDeps> {
  const deps = await createTestPhaseDeps();
  const architecture: Architecture = {
    schemaVersion: 1,
    generatedAt: "2026-10-11T10:00:00.000Z",
    generator: { tool: "opscrew", version: "0.0.0-test" },
    facts,
    summary: "A test app.",
    risks: [],
    aiEnriched: false,
  };
  await writeArtifact("architecture", deps.paths.files.architecture, architecture);
  await writeArtifact(
    "requirements",
    deps.paths.files.requirements,
    makeRequirements({ provider: "localhost", region: undefined, ...requirements }),
  );
  return deps;
}

describe("design for this computer", () => {
  it("designs the localhost target: the CPU, the ports probed, a local build, no DNS and no price", async () => {
    // A domain from earlier answers does not apply here.
    const deps = await setup({ dnsProvider: "cloudflare", domain: "shop.example.com" });
    const { plan, chosen } = await runDesign(deps, { localhost: computer("arm64", [443]) });
    expect(plan.target).toEqual({
      provider: "localhost",
      mode: "local-compose",
      arch: "arm64",
      ports: { https: 8443, http: 80 },
      image: "local-build",
      edge: "caddy",
    });
    expect(plan.dns).toMatchObject({ provider: "none", proxied: false });
    expect(plan.dns.domain).toBeUndefined();
    expect(plan.cost.monthly.amount).toBe(0);
    expect(plan.deploy.strategy).toBe("rolling");
    expect(chosen).toMatchObject({ id: "localhost", title: "This computer", recommended: true });
    expect(deps.reporter.text()).toContain("no server cost (it runs in this computer's Docker)");
    expect(deps.reporter.text()).not.toContain("Memory limits:");
  });

  it("keeps the ports OpsCrew's edge on this computer already serves", async () => {
    const deps = await setup();
    const edge = localRoots(deps.paths).edge;
    await mkdir(edge, { recursive: true });
    await writeFile(
      join(edge, "compose.yaml"),
      'services:\n  caddy:\n    ports:\n      - "127.0.0.1:8080:80"\n      - "127.0.0.1:8443:443"\n',
    );
    const { plan } = await runDesign(deps, { localhost: computer("x64") });
    expect(plan.target).toMatchObject({ ports: { https: 8443, http: 8080 } });
  });

  it("refuses a CPU Docker runs no Linux images for", async () => {
    const deps = await setup();
    await expect(runDesign(deps, { localhost: computer("ia32") })).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      message: expect.stringContaining("This computer's CPU (ia32)"),
    });
  });

  it("keeps the search engines external on this computer, saying why", async () => {
    const facts = {
      ...nextPostgresFacts(),
      services: [
        ...nextPostgresFacts().services,
        { kind: "elasticsearch" as const, evidence: ["dependency:@elastic/elasticsearch"] },
      ],
    };
    const deps = await setup({}, facts);
    const { plan } = await runDesign(deps, { localhost: computer("x64") });
    expect(plan.services.map((service) => service.kind)).not.toContain("elasticsearch");
    expect(plan.externalServices).toContain("elasticsearch");
    const line = localhostHostSettingProblem("elasticsearch") as string;
    expect(line).toContain("vm.max_map_count");
    expect(line).toContain("does not change on this computer");
    expect(deps.reporter.text()).toContain(line);
  });
});

describe("a localhost environment beside prod", () => {
  /** Prod designed on Hetzner, then `opscrew env add <name>` for this computer. */
  async function beside(name: string, arch: string, runner?: "local") {
    const deps = await setup({ provider: "hetzner", region: "eu-central" });
    const { euCatalog } = await import("../testing");
    await runDesign(deps, { catalog: euCatalog() });
    const env = { ...deps, paths: environmentPaths(deps.paths, name) };
    const result = await addEnvironment(env, {
      answers: { provider: "localhost", ...(runner !== undefined ? { runner } : {}) },
      design: { localhost: computer(arch) },
    });
    return { deps, env, result };
  }

  it("pulls GitHub's image on the local runner, so its first provision starts from a local build", async () => {
    for (const arch of ["x64", "arm64"]) {
      const { env, result } = await beside("dev", arch, "local");
      const { plan } = result.design;
      expect(plan.target).toMatchObject({ provider: "localhost", image: "registry" });
      expect(env.reporter.text()).not.toContain("No other environment builds the app's image");
      expect(env.reporter.text()).not.toContain("is built for");
      // Provision accepts it on the local runner, and GHCR has no image of dev's yet.
      await requireLocalRunnerImage(env.paths.root, plan);
      await writeFile(join(env.paths.root, "Dockerfile"), "FROM node:22-alpine\n");
      const registry = {
        image: "ghcr.io/acme/shop",
        taggedDigest: async () => undefined,
        login: async () => ({ username: "acme", token: "" }),
      };
      expect(await resolveLocalImage(env, plan, async () => registry)).toMatchObject({
        source: "local-build",
      });
      expect(env.reporter.text()).toContain("dev has no image of its own");
    }
  });

  it("pulls GitHub's image for prod on this computer on the local runner", async () => {
    const deps = await setup();
    const first = await runDesign(deps, { localhost: computer("x64") });
    expect(first.plan.target).toMatchObject({ image: "local-build" });
    await writeArtifact("plan", deps.paths.files.plan, {
      ...first.plan,
      environment: { deploySource: { from: "main" }, runner: "local" },
    });
    const { plan } = await runDesign(deps, { localhost: computer("x64") });
    expect(plan.target).toMatchObject({ image: "registry" });
    expect(deps.reporter.text()).not.toContain("No other environment builds the app's image");
  });

  it("runs the image prod runs when this computer has prod's CPU, at <app>.localhost", async () => {
    const { env, result } = await beside("dev", "x64");
    expect(result.design.plan.target).toMatchObject({
      provider: "localhost",
      arch: "amd64",
      image: "registry",
    });
    expect(result.design.plan.app.name).toMatch(/-dev$/);
    const site = await localSite(env.paths, result.design.plan);
    expect(site.hostname).toBe(`${result.design.plan.app.name.slice(0, -"-dev".length)}.localhost`);
  });

  it("builds the image on Apple silicon and says it differs from production's", async () => {
    const { result, env } = await beside("dev", "arm64");
    expect(result.design.plan.target).toMatchObject({ arch: "arm64", image: "local-build" });
    expect(env.reporter.text()).toContain(
      "This computer runs arm64 and production's image is built for amd64, so OpsCrew builds the app's image on this computer: it differs from production's image.",
    );
  });

  it("names the environment it is promoted from, and warns of nothing on the same CPU", async () => {
    const { deps } = await beside("staging", "x64");
    const staging = await readArtifact("plan", environmentPaths(deps.paths, "staging").files.plan);
    // Staging moves to a server OpsCrew creates, whose images are amd64.
    await writeArtifact("plan", environmentPaths(deps.paths, "staging").files.plan, {
      ...staging,
      target: (await readArtifact("plan", deps.paths.files.plan)).target,
    });
    const dev = { ...deps, paths: environmentPaths(deps.paths, "dev") };
    const promoted = await addEnvironment(dev, {
      answers: { provider: "localhost", from: "staging" },
      design: { localhost: computer("arm64") },
    });
    // A promoted environment runs its source's exact image, under emulation on another CPU.
    expect(promoted.design.plan.target).toMatchObject({ image: "registry" });
    expect(dev.reporter.text()).toContain(
      "This computer runs arm64 and the staging environment's image is built for amd64",
    );
    const qa = { ...deps, paths: environmentPaths(deps.paths, "qa") };
    const said = qa.reporter.lines.length;
    await addEnvironment(qa, {
      answers: { provider: "localhost", from: "staging" },
      design: { localhost: computer("x64") },
    });
    const lines = qa.reporter.lines.slice(said).map((line) => line.message);
    expect(lines.some((line) => line.includes("is built for"))).toBe(false);
  });

  it("designs a new one's components from prod's plan, whose image it pulls", async () => {
    const deps = await setup({ provider: "hetzner", region: "eu-central" });
    const { euCatalog } = await import("../testing");
    const first = (await runDesign(deps, { catalog: euCatalog() })).plan;
    // The user turned prod's Postgres off: prod's app then gets DATABASE_URL from them.
    await writeArtifact("plan", deps.paths.files.plan, {
      ...first,
      services: first.services.map((service) =>
        service.kind === "postgres" ? { ...service, enabled: false } : service,
      ),
    });
    const prod = (await runDesign(deps, { catalog: euCatalog() })).plan;
    const databaseUrl = (plan: typeof prod) =>
      plan.app.env.find((variable) => variable.name === "DATABASE_URL");
    expect(databaseUrl(prod)?.source).not.toBe("derived");
    const env = { ...deps, paths: environmentPaths(deps.paths, "dev") };
    const { design } = await addEnvironment(env, {
      answers: { provider: "localhost" },
      design: { localhost: computer("x64") },
    });
    expect(design.plan.target).toMatchObject({ image: "registry" });
    expect(databaseUrl(design.plan)).toEqual(databaseUrl(prod));
  });

  it("names two localhost environments of one app <env>.<app>.localhost", async () => {
    const { deps, result } = await beside("dev", "x64");
    const qa = { ...deps, paths: environmentPaths(deps.paths, "qa") };
    const second = await addEnvironment(qa, {
      answers: { provider: "localhost" },
      design: { localhost: computer("x64") },
    });
    const app = result.design.plan.app.name.slice(0, -"-dev".length);
    expect(
      (await localSite(environmentPaths(deps.paths, "dev"), result.design.plan)).hostname,
    ).toBe(`dev.${app}.localhost`);
    expect((await localSite(qa.paths, second.design.plan)).hostname).toBe(`qa.${app}.localhost`);
    expect((await readArtifact("plan", qa.paths.files.plan)).target.provider).toBe("localhost");
  });
});

describe("the interview and the provider profile for this computer", () => {
  it("offers this computer, and records no region, domain or DNS for it", () => {
    const facts = nextPostgresFacts();
    const provider = buildQuestions(facts).find((q) => q.id === "provider");
    expect(provider?.options?.map((o) => o.value)).toContain("localhost");
    expect(defaultProvider({ provider: "localhost" })).toBe("localhost");
    const requirements = answersToRequirements(
      {
        expectedMonthlyUsers: "<1k",
        budgetMonthly: "10 EUR",
        provider: "localhost",
        region: "eu-central",
        uptime: "best-effort",
        dataCriticality: "none",
        domain: "shop.example.com",
        dnsProvider: "cloudflare",
      },
      { now, facts },
    );
    expect(requirements).toMatchObject({ provider: "localhost", dnsProvider: "none" });
    expect(requirements.region).toBeUndefined();
    expect(requirements.domain).toBeUndefined();
  });

  it("has a profile with no token, API or price", () => {
    expect(providerProfile("localhost")).toEqual({
      id: "localhost",
      displayName: "This computer",
      tokenVars: [],
    });
  });
});
