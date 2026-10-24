import {
  type DeployPlan,
  DeployPlanSchema,
  type PlanService,
  type ProjectFacts,
  writeArtifact,
} from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { digestOf, inEnvironment, promoteWorld } from "../promote/__fixtures__/world";
import {
  createTestPhaseDeps,
  euCatalog,
  makeFacts,
  makeRequirements,
  nextPostgresFacts,
} from "../testing";
import { type RunDesignOptions, runDesign } from "./run";
import { selfHostedServices } from "./sizing";

const DB_ONLY = selfHostedServices({ postgres: true, redis: false });
const WITH_CACHE = selfHostedServices({ postgres: true, redis: true });
const DEV_IMAGE = digestOf("dev");

/** A variable the code reads, holding a secret. */
const reads = (name: string) => ({
  name,
  files: ["src/cache.ts"],
  clientExposed: false,
  secretLikely: true,
});

/** The code still uses Redis (ioredis); `envVars` are the names it reads besides DATABASE_URL. */
function redisFacts(envVars: string[] = []): ProjectFacts {
  const base = nextPostgresFacts({ name: "shop", git: { defaultBranch: "main" } });
  return {
    ...base,
    envVars: [...base.envVars, ...envVars.map(reads)],
    services: [...base.services, { kind: "redis", evidence: ["dependency:ioredis"] }],
  };
}

/**
 * dev (built on each push to main) has only Postgres, and no cron job or SQLite; staging is
 * promoted from dev and its plan still has the cache. The code here is `facts`. GHCR labels dev's
 * image `opscrew-dev`, and staging's `opscrew-staging` is `stagingImage`; `ports` are the ones the
 * user set in prod's and dev's plans. Gives staging's design and what it said.
 */
async function designStaging(input: {
  facts: ProjectFacts;
  stagingImage: string;
  ports?: { prod: number; dev: number };
}) {
  const world = await promoteWorld({
    ...(input.ports === undefined
      ? {}
      : { prod: (plan) => ({ ...plan, app: { ...plan.app, port: input.ports?.prod ?? 0 } }) }),
    staging: (plan) =>
      DeployPlanSchema.parse({
        ...plan,
        environment: { ...plan.environment, deploySource: { from: "promote", source: "dev" } },
        services: WITH_CACHE,
      }),
  });
  const { paths } = world.deps;
  await writeArtifact("architecture", paths.files.architecture, {
    schemaVersion: 1,
    generatedAt: "2026-10-11T09:00:00.000Z",
    generator: { tool: "opscrew", version: "0.0.0-test" },
    facts: input.facts,
    summary: "A shop.",
    risks: [],
    aiEnriched: false,
  });
  await writeArtifact("requirements", paths.files.requirements, makeRequirements());
  const dev = inEnvironment(world.prodPlan, "dev");
  const app = input.ports === undefined ? dev.app : { ...dev.app, port: input.ports.dev };
  await world.writePlan("dev", DeployPlanSchema.parse({ ...dev, app, services: DB_ONLY }));
  const tags = new Map([
    ["opscrew-dev", DEV_IMAGE],
    ["opscrew-staging", input.stagingImage],
  ]);
  const options: RunDesignOptions = {
    catalog: euCatalog(),
    registry: { taggedDigest: async (tag) => tags.get(tag) },
  };
  const staging = await createTestPhaseDeps({ root: paths.root, environment: "staging" });
  const { plan } = await runDesign(staging, options);
  return { plan, said: staging.reporter.text() };
}

const names = (plan: DeployPlan, list: readonly PlanService[] = plan.services) =>
  list.map((service) => service.name);
const variable = (plan: DeployPlan, name: string) => plan.app.env.find((v) => v.name === name);

describe("the variables what runs fills follow the written plan (FR-1539)", () => {
  it("dev drops Redis, staging is promoted to dev's image: staging's design writes no REDIS_URL", async () => {
    const { plan } = await designStaging({ facts: redisFacts(), stagingImage: DEV_IMAGE });
    expect(names(plan)).toEqual(["db"]);
    expect(variable(plan, "REDIS_URL")).toBeUndefined();
    expect(variable(plan, "DATABASE_URL")).toMatchObject({ source: "derived" });
  });

  it("keeps REDIS_URL derived while staging keeps the cache for the image it still runs", async () => {
    const { plan } = await designStaging({ facts: redisFacts(), stagingImage: digestOf("older") });
    expect(names(plan)).toEqual(["db", "cache"]);
    expect(variable(plan, "REDIS_URL")).toMatchObject({ source: "derived" });
  });

  it("leaves a name the code reads to the user once no service fills it", async () => {
    const { plan } = await designStaging({
      facts: redisFacts(["REDIS_URL"]),
      stagingImage: DEV_IMAGE,
    });
    expect(names(plan)).toEqual(["db"]);
    expect(variable(plan, "REDIS_URL")).toMatchObject({ source: "user" });
  });

  it("writes no CRON_SECRET when the code here has a route cron job dev's plan does not", async () => {
    const facts: ProjectFacts = {
      ...nextPostgresFacts({ name: "shop", git: { defaultBranch: "main" } }),
      cronJobs: [{ schedule: "*/10 * * * *", route: "/api/cron", source: "vercel.json" }],
    };
    const { plan } = await designStaging({ facts, stagingImage: DEV_IMAGE });
    expect(plan.processes.cron).toEqual([]);
    expect(variable(plan, "CRON_SECRET")).toBeUndefined();
  });

  it("does not point DB_DATABASE at a moved SQLite database dev's plan does not have", async () => {
    // Laravel's stock database would move to storage/database, with DB_DATABASE pointing there.
    const facts = makeFacts({
      name: "shop",
      git: { defaultBranch: "main" },
      languages: ["php"],
      packageManager: "none",
      frameworks: [{ name: "laravel", path: "." }],
      build: { workdir: "/var/www/html" },
      docker: { dockerfile: "Dockerfile" },
      sqlite: { paths: ["database/database.sqlite"], dir: "database" },
    });
    const { plan } = await designStaging({ facts, stagingImage: DEV_IMAGE });
    expect(plan.storage?.sqlite).toBeUndefined();
    expect(variable(plan, "DB_DATABASE")).toBeUndefined();
  });
});

describe("a promoted environment's kept edits (T1616)", () => {
  it("names the source plan's file and value, not prod's", async () => {
    const { plan, said } = await designStaging({
      facts: redisFacts(),
      stagingImage: DEV_IMAGE,
      ports: { prod: 9000, dev: 4000 },
    });
    expect(plan.app.port).toBe(4000);
    expect(said).toContain(
      "Kept app.port 4000 from opscrew/environments/dev/plan.yaml; analyze found 3000. To use it, set app.port to 3000 in opscrew/environments/dev/plan.yaml.",
    );
    expect(said).not.toContain("9000");
  });
});
