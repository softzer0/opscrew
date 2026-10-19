import { readFile } from "node:fs/promises";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { z } from "zod";
import {
  ArchitectureSchema,
  DeployPlanSchema,
  type PlanService,
  ProjectFactsSchema,
  parseArtifact,
  serviceOf,
} from "./index";

const FIXTURES = new URL("./__fixtures__/", import.meta.url);
const fixture = (name: string) => readFile(new URL(name, FIXTURES), "utf8");
const validPlan = async () => parseArtifact("plan", await fixture("plan.yaml"), "fixture");

function pathsOf(result: { success: boolean; error?: z.ZodError }) {
  expect(result.success).toBe(false);
  return result.error?.issues.map((i) => i.path.join(".")) ?? [];
}

const postgres = {
  kind: "postgres",
  version: "17",
  memoryMb: 512,
  reason: "The app uses PostgreSQL.",
  licence: "PostgreSQL",
} as const;
const valkey = (mode: "cache" | "queue") => ({
  kind: "valkey",
  version: "8",
  memoryMb: 128,
  options: { mode },
  reason: "The app uses Redis.",
  licence: "BSD-3-Clause",
});
const worker = { name: "worker", command: "celery -A app worker", source: "library" } as const;

describe("DeployPlan components", () => {
  it("fills the web process's memory and empty processes and services; storage is absent", async () => {
    const { processes: _p, services: _s, ...plan } = await validPlan();
    const parsed = DeployPlanSchema.parse({ ...plan, app: { ...plan.app, memoryMb: undefined } });
    expect(parsed.app.memoryMb).toBe(512);
    expect(parsed.processes).toEqual({ workers: [], cron: [] });
    expect(parsed.services).toEqual([]);
    expect(parsed.storage).toBeUndefined();
  });

  it("fills a worker's defaults, and runs a single worker exactly once", async () => {
    const plan = await validPlan();
    const parsed = DeployPlanSchema.parse({ ...plan, processes: { workers: [worker] } });
    expect(parsed.processes.workers).toEqual([
      {
        ...worker,
        count: 1,
        single: false,
        stopGraceSeconds: 30,
        memoryMb: 256,
        enabled: true,
      },
    ]);
    const beat = { ...worker, name: "beat", single: true };
    expect(DeployPlanSchema.parse({ ...plan, processes: { workers: [beat] } })).toMatchObject({
      processes: { workers: [{ name: "beat", single: true, count: 1 }] },
    });
    const twice = { processes: { workers: [{ ...beat, count: 2 }] } };
    expect(pathsOf(DeployPlanSchema.safeParse({ ...plan, ...twice }))).toEqual([
      "processes.workers.0.count",
    ]);
  });

  it("keeps a worker's count within 1–10 and its stop grace within 5–600 seconds", async () => {
    const plan = await validPlan();
    const paths = (fields: object) =>
      pathsOf(
        DeployPlanSchema.safeParse({ ...plan, processes: { workers: [{ ...worker, ...fields }] } }),
      );
    for (const count of [0, 11, 1.5]) {
      expect(paths({ count }), String(count)).toEqual(["processes.workers.0.count"]);
    }
    for (const stopGraceSeconds of [4, 601]) {
      expect(paths({ stopGraceSeconds }), String(stopGraceSeconds)).toEqual([
        "processes.workers.0.stopGraceSeconds",
      ]);
    }
    expect(paths({ source: "guess" })).toEqual(["processes.workers.0.source"]);
    expect(paths({ command: "a\nb" })).toEqual(["processes.workers.0.command"]);
    const edges = { workers: [{ ...worker, count: 10, stopGraceSeconds: 600 }] };
    expect(DeployPlanSchema.safeParse({ ...plan, processes: edges }).success).toBe(true);
  });

  it("names a service db, cache, queue or its kind unless the plan names it", async () => {
    const plan = await validPlan();
    const parsed = DeployPlanSchema.parse({
      ...plan,
      externalServices: [],
      services: [
        postgres,
        valkey("cache"),
        valkey("queue"),
        { ...postgres, kind: "mysql", version: "8.4", licence: "GPL-2.0" },
        { ...postgres, name: "reports", kind: "mysql", version: "8.4", licence: "GPL-2.0" },
      ],
    });
    expect(parsed.services.map((s) => s.name)).toEqual([
      "db",
      "cache",
      "queue",
      "mysql",
      "reports",
    ]);
    expect(parsed.services[0]).toEqual({ name: "db", ...postgres, enabled: true, options: {} });
  });

  it("checks each kind's options", async () => {
    const plan = await validPlan();
    const parse = (service: object) =>
      DeployPlanSchema.safeParse({ ...plan, externalServices: [], services: [service] });
    const mongodb = { ...postgres, kind: "mongodb", version: "8.0", licence: "SSPL-1.0" };
    expect(parse(mongodb).data?.services[0]?.options).toEqual({ replicaSet: false });
    expect(parse({ ...mongodb, options: { replicaSet: true } }).data?.services[0]?.options).toEqual(
      { replicaSet: true },
    );
    const kafka = { ...postgres, kind: "kafka", version: "4.1", licence: "Apache-2.0" };
    const retention = { retentionHours: 168, retentionGb: 5 };
    expect(parse({ ...kafka, options: retention }).data?.services[0]?.options).toEqual(retention);
    expect(pathsOf(parse({ ...valkey("cache"), options: {} }))).toEqual([
      "services.0.options.mode",
    ]);
    expect(pathsOf(parse({ ...valkey("cache"), options: { mode: "lru" } }))).toEqual([
      "services.0.options.mode",
    ]);
    expect(pathsOf(parse({ ...postgres, options: { mode: "cache" } }))).toEqual([
      "services.0.options",
    ]);
    expect(pathsOf(parse({ ...postgres, kind: "redis" }))).toEqual(["services.0.kind"]);
    for (const field of ["version", "memoryMb", "reason", "licence"] as const) {
      const { [field]: _gone, ...rest } = postgres;
      expect(pathsOf(parse(rest)), field).toEqual([`services.0.${field}`]);
    }
    for (const version of ["latest", "17-alpine", ""]) {
      expect(pathsOf(parse({ ...postgres, version })), version).toEqual(["services.0.version"]);
    }
  });

  it("keeps worker and service names unique, well formed and clear of OpsCrew's own", async () => {
    const plan = await validPlan();
    const parse = (workers: object[], services: object[]) =>
      DeployPlanSchema.safeParse({
        ...plan,
        externalServices: [],
        processes: { workers },
        services,
      });
    expect(pathsOf(parse([{ ...worker, name: "db" }], [postgres]))).toEqual(["services.0.name"]);
    expect(pathsOf(parse([worker, worker], []))).toEqual(["processes.workers.1.name"]);
    expect(pathsOf(parse([], [valkey("cache"), valkey("cache")]))).toEqual(["services.1.name"]);
    for (const name of ["app", "release", "cron", "proxy", "caddy", "Worker", "1st", "a_b", ""]) {
      expect(pathsOf(parse([{ ...worker, name }], [])), name).toEqual(["processes.workers.0.name"]);
      expect(pathsOf(parse([], [{ ...postgres, name }])), name).toEqual(["services.0.name"]);
    }
    expect(parse([{ ...worker, name: "mail-2" }], [postgres]).success).toBe(true);
  });

  it("runs a cron job's command or calls its route, never both or neither", async () => {
    const plan = await validPlan();
    const parse = (job: object) =>
      DeployPlanSchema.safeParse({ ...plan, processes: { cron: [job] } });
    const command = { name: "cleanup", schedule: "*/15 * * * *", command: "python manage.py x" };
    expect(parse(command).data?.processes.cron).toEqual([
      { ...command, timeZone: "UTC", enabled: true },
    ]);
    const route = { name: "digest", schedule: "0 7 * * *", route: "/api/cron/digest" };
    const zoned = { ...route, timeZone: "Europe/Belgrade", enabled: false };
    expect(parse(zoned).data?.processes.cron).toEqual([zoned]);
    expect(pathsOf(parse({ ...command, route: "/api/cron/x" }))).toEqual(["processes.cron.0"]);
    expect(pathsOf(parse({ name: "x", schedule: "@daily" }))).toEqual(["processes.cron.0"]);
    expect(parse({ ...command, schedule: "*/10 * * * * * *" }).success).toBe(true);
    for (const schedule of ["", "* * * *", "* * * * *\n* * * * * rm"]) {
      expect(pathsOf(parse({ ...command, schedule })), schedule).toEqual([
        "processes.cron.0.schedule",
      ]);
    }
    expect(pathsOf(parse({ ...command, timeZone: "Mars/Olympus" }))).toEqual([
      "processes.cron.0.timeZone",
    ]);
    expect(pathsOf(parse({ ...route, route: "api/x" }))).toEqual(["processes.cron.0.route"]);
  });

  it("records SQLite's folder and object storage with its expected use and price", async () => {
    const plan = await validPlan();
    const objectStorage = {
      provider: "r2",
      bucket: "shop-uploads",
      region: "auto",
      expected: { storageGb: 10, egressGbPerMonth: 50 },
      price: {
        monthly: 0,
        currency: "USD",
        source: "Cloudflare R2 pricing",
        checkedOn: "2026-10-19",
      },
    };
    const storage = { sqlite: { dir: "storage" }, objectStorage };
    const parsed = DeployPlanSchema.parse({ ...plan, deploy: { strategy: "recreate" }, storage });
    expect(parsed.storage).toEqual({
      sqlite: { dir: "storage" },
      objectStorage: { ...objectStorage, cors: false },
    });
    const paths = (fields: object) =>
      pathsOf(
        DeployPlanSchema.safeParse({
          ...plan,
          storage: { objectStorage: { ...objectStorage, ...fields } },
        }),
      );
    for (const provider of ["digitalocean", "hetzner", "garage"]) {
      expect(
        DeployPlanSchema.safeParse({
          ...plan,
          storage: { objectStorage: { ...objectStorage, provider } },
        }).success,
      ).toBe(true);
    }
    expect(paths({ provider: "minio" })).toEqual(["storage.objectStorage.provider"]);
    expect(paths({ expected: { storageGb: 10 } })).toEqual([
      "storage.objectStorage.expected.egressGbPerMonth",
    ]);
    expect(paths({ bucket: "Shop_Uploads" })).toEqual(["storage.objectStorage.bucket"]);
    expect(paths({ accessKeyId: "x" })).toEqual(["storage.objectStorage"]);
    const outside = { storage: { sqlite: { dir: "../data" } }, deploy: { strategy: "recreate" } };
    expect(pathsOf(DeployPlanSchema.safeParse({ ...plan, ...outside }))).toEqual([
      "storage.sqlite.dir",
    ]);
  });

  it("replaces the old copy before starting the new one when the app keeps SQLite", async () => {
    const plan = await validPlan();
    const storage = { sqlite: { dir: "storage" } };
    expect(pathsOf(DeployPlanSchema.safeParse({ ...plan, storage }))).toEqual(["deploy.strategy"]);
    const rolling = { ...plan, storage, deploy: { strategy: "rolling" } };
    expect(pathsOf(DeployPlanSchema.safeParse(rolling))).toEqual(["deploy.strategy"]);
    const recreate = { ...plan, storage, deploy: { strategy: "recreate" } };
    expect(DeployPlanSchema.parse(recreate).deploy.strategy).toBe("recreate");
  });

  it("conflicts a self-hosted Postgres with an external one, unless it is turned off", async () => {
    const plan = await validPlan();
    const both = { ...plan, services: [postgres], externalServices: ["stripe", "supabase"] };
    expect(pathsOf(DeployPlanSchema.safeParse(both))).toEqual(["externalServices.1"]);
    const off = { ...both, services: [{ ...postgres, enabled: false }] };
    expect(DeployPlanSchema.safeParse(off).success).toBe(true);
  });
});

describe("serviceOf", () => {
  it("returns the enabled service of a kind, or nothing", async () => {
    const plan = DeployPlanSchema.parse({
      ...(await validPlan()),
      externalServices: [],
      services: [{ ...postgres, enabled: false }, valkey("queue")],
    });
    expect(serviceOf(plan, "postgres")).toBeUndefined();
    expect(serviceOf(plan, "mysql")).toBeUndefined();
    const queue = serviceOf(plan, "valkey");
    expect(queue?.name).toBe("queue");
    expectTypeOf(queue).toEqualTypeOf<(PlanService & { kind: "valkey" }) | undefined>();
    expectTypeOf<NonNullable<typeof queue>["options"]>().toEqualTypeOf<{
      mode: "cache" | "queue";
    }>();
  });
});

describe("ProjectFacts components", () => {
  async function facts() {
    return ArchitectureSchema.parse(JSON.parse(await fixture("architecture.json"))).facts;
  }

  it("leaves workers, cron jobs, hosted services, SQLite and object storage out when none", async () => {
    const f = await facts();
    const parsed = ProjectFactsSchema.parse(f);
    expect(parsed).toEqual(f);
    for (const field of ["workers", "cronJobs", "hostedServices", "sqlite", "objectStorage"]) {
      expect(parsed, field).not.toHaveProperty(field);
    }
  });

  it("records what detection finds about components", async () => {
    const f = await facts();
    const found = {
      workers: [
        {
          name: "worker",
          command: "celery -A app worker",
          source: "library",
          single: false,
          evidence: ["requirements.txt: celery"],
        },
        { name: "jobs", source: "library", single: false, evidence: ["package.json: bullmq"] },
        {
          name: "clock",
          command: "python clock.py",
          source: "procfile",
          single: true,
          evidence: ["Procfile"],
        },
      ],
      cronJobs: [{ schedule: "0 5 * * *", route: "/api/cron", source: "vercel.json" }],
      hostedServices: [{ kind: "mongodb", variable: "MONGODB_URI", provider: "MongoDB Atlas" }],
      sqlite: { paths: ["storage/production.sqlite3"], dir: "storage" },
      objectStorage: {
        client: "@aws-sdk/client-s3",
        presignedUploads: true,
        variables: ["S3_BUCKET", "S3_ENDPOINT"],
      },
      services: [{ kind: "amqp", evidence: ["package.json: amqplib"], variable: "AMQP_URL" }],
    };
    expect(ProjectFactsSchema.parse({ ...f, ...found })).toEqual({ ...f, ...found });
    const paths = (fields: object) => pathsOf(ProjectFactsSchema.safeParse({ ...f, ...fields }));
    expect(paths({ workers: [] })).toEqual(["workers"]);
    expect(paths({ workers: [{ ...found.workers[0], source: "user" }] })).toEqual([
      "workers.0.source",
    ]);
    expect(
      paths({ cronJobs: [{ schedule: "0 5 * * *", route: "x", source: "vercel.json" }] }),
    ).toEqual(["cronJobs.0.route"]);
    expect(
      paths({ hostedServices: [{ kind: "mongodb", variable: "a=b", provider: "Atlas" }] }),
    ).toEqual(["hostedServices.0.variable"]);
    expect(paths({ sqlite: { paths: [], dir: "storage" } })).toEqual(["sqlite.paths"]);
    expect(paths({ objectStorage: { ...found.objectStorage, variables: ["S3 KEY"] } })).toEqual([
      "objectStorage.variables.0",
    ]);
  });
});
