/**
 * The app's components besides the web process, in `opscrew/plan.yaml`: workers and cron jobs
 * (`processes`), the backing services OpsCrew runs (`services`) and persistent storage (`storage`).
 */
import { z } from "zod";
import {
  CommandLineSchema,
  CurrencySchema,
  MemoryMbSchema,
  RepoPathSchema,
  SelfHostedServiceKindSchema,
  UrlPathSchema,
} from "./enums";

/** Compose service names OpsCrew gives its own containers. */
const RESERVED_NAMES: ReadonlySet<string> = new Set(["app", "release", "cron", "proxy", "caddy"]);

/** A name in the app's Compose project and data folders: `worker`, `db`, `mail-2`. */
const NAME = /^[a-z][a-z0-9-]*$/;
const NAME_MESSAGE = "must start with a lower-case letter and hold only letters, digits or hyphens";

/** A worker's or service's name: its Compose service and data folder, never one of OpsCrew's own. */
const ComponentNameSchema = z
  .string()
  .regex(NAME, { message: NAME_MESSAGE })
  .refine((name) => !RESERVED_NAMES.has(name), {
    message: `is a name OpsCrew uses itself (${[...RESERVED_NAMES].join(", ")}); choose another`,
  });

/** A process that runs from the app's image next to the web process, for example a job queue. */
const WorkerSchema = z
  .strictObject({
    name: ComponentNameSchema,
    command: CommandLineSchema,
    /** `procfile` and `library`: detected; `user`: the user added or wrote it. */
    source: z.enum(["procfile", "library", "user"]),
    /** Copies that run; always 1 for a `single` worker. */
    count: z.int().min(1).max(10).default(1),
    /** A scheduler that must run exactly once (Celery beat, Laravel's scheduler). */
    single: z.boolean().default(false),
    /** Seconds a stopping copy gets to finish its job. */
    stopGraceSeconds: z.int().min(5).max(600).default(30),
    memoryMb: MemoryMbSchema.default(256),
    /** `false` keeps the entry and runs nothing. */
    enabled: z.boolean().default(true),
  })
  .superRefine((worker, ctx) => {
    if (worker.single && worker.count !== 1) {
      ctx.addIssue({
        code: "custom",
        path: ["count"],
        message: "must be 1 when single is true: a scheduler that runs twice runs every job twice",
      });
    }
  });

/**
 * A scheduled job: a command in the app's image, or a GET on one of the app's routes. Schedules are
 * in UTC, as Vercel's are: supercronic's `CRON_TZ` covers the whole crontab, and Alpine images have
 * no tzdata (research.md "Spike results").
 */
const CronJobSchema = z
  .strictObject({
    name: z.string().regex(NAME, { message: NAME_MESSAGE }),
    /** supercronic's syntax: five fields, an optional seconds field and year, or `@daily`. */
    schedule: z.string().regex(/^(?:@[a-z]+|\S+(?: +\S+){4,6})$/, {
      message: "must be a cron schedule such as `*/15 * * * *` or `@daily`, on one line",
    }),
    command: CommandLineSchema.optional(),
    /** Called with `Authorization: Bearer $CRON_SECRET` (`vercel.json` crons). */
    route: UrlPathSchema.optional(),
    enabled: z.boolean().default(true),
  })
  .superRefine((job, ctx) => {
    if ((job.command === undefined) === (job.route === undefined)) {
      ctx.addIssue({ code: "custom", message: "needs exactly one of command and route" });
    }
  });

/** Workers and cron jobs; both empty when absent. */
export const ProcessesSchema = z
  .strictObject({
    workers: z.array(WorkerSchema).default(() => []),
    cron: z.array(CronJobSchema).default(() => []),
  })
  .prefault({});

/** A service entry of the kinds `kind` accepts, with their settings `options` (data-model.md's order). */
function serviceEntry<K extends z.ZodType, O extends z.ZodType>(kind: K, options: O) {
  return z.strictObject({
    /** The Compose service and data folder name; see {@link defaultServiceName}. */
    name: ComponentNameSchema.optional(),
    kind,
    version: z.string().regex(/^\d+(?:\.\d+){0,2}$/, {
      message: "must be a version such as `17`, `8.4` or `4.1.0`, without a tag suffix",
    }),
    memoryMb: MemoryMbSchema,
    /** `false` keeps the entry and runs nothing. */
    enabled: z.boolean().default(true),
    options,
    /** One plain sentence on why the app gets it, for example "The app uses mysql2." */
    reason: z.string().min(1),
    /** The catalog's SPDX id or name, shown at design when it is not permissive. */
    licence: z.string().min(1),
  });
}

/** Kinds with options of their own; every other kind has none. */
const KINDS_WITH_OPTIONS = ["valkey", "mongodb", "kafka"] as const;

/** A service entry as written, its name perhaps left out. */
const ServiceEntrySchema = z.discriminatedUnion("kind", [
  serviceEntry(
    z.literal("valkey"),
    // `cache`: evicts the least recently used keys, no persistence. `queue`: never evicts, AOF.
    z.strictObject({ mode: z.enum(["cache", "queue"]) }),
  ),
  serviceEntry(
    z.literal("mongodb"),
    // A one-node replica set, for clients that need transactions (Prisma).
    z.strictObject({ replicaSet: z.boolean().default(false) }).prefault({}),
  ),
  serviceEntry(
    z.literal("kafka"),
    z
      .strictObject({
        retentionHours: z.int().positive().optional(),
        retentionGb: z.int().positive().optional(),
      })
      .prefault({}),
  ),
  serviceEntry(
    SelfHostedServiceKindSchema.exclude(KINDS_WITH_OPTIONS),
    z.strictObject({}).prefault({}),
  ),
]);

/**
 * A service's name when the plan gives none: `db` for Postgres, `cache` or `queue` for Valkey (by
 * its mode), else its kind.
 */
function defaultServiceName(service: z.output<typeof ServiceEntrySchema>): string {
  if (service.kind === "postgres") return "db";
  if (service.kind === "valkey") return service.options.mode;
  return service.kind;
}

/** A backing service OpsCrew runs as a container next to the app, with its name filled in. */
export const PlanServiceSchema = ServiceEntrySchema.transform((service) => ({
  ...service,
  name: service.name ?? defaultServiceName(service),
}));
export type PlanService = z.output<typeof PlanServiceSchema>;

/**
 * The enabled service of a kind in a plan or design option, or `undefined` when there is none or
 * it is turned off. With several of a kind (a Valkey cache and queue), the first.
 */
export function serviceOf<K extends PlanService["kind"]>(
  owner: { readonly services: readonly PlanService[] },
  kind: K,
): (PlanService & { kind: K }) | undefined {
  return owner.services.find(
    (service): service is PlanService & { kind: K } => service.kind === kind && service.enabled,
  );
}

/** Object storage: an S3-compatible bucket at a provider, or Garage on the user's own server. */
const ObjectStorageSchema = z.strictObject({
  provider: z.enum(["r2", "digitalocean", "hetzner", "garage"]),
  bucket: z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/, {
    message: "must be 3–63 lower-case letters, digits or hyphens, starting and ending with one",
  }),
  /** The provider's region or location, for example `auto` (R2) or `fsn1`. */
  region: z.string().min(1),
  /** A CORS rule for presigned browser uploads, only when detection finds them. */
  cors: z.boolean().default(false),
  /** What the app is expected to store and serve, from the interview's scale; prices use it. */
  expected: z.strictObject({
    storageGb: z.number().nonnegative(),
    egressGbPerMonth: z.number().nonnegative(),
  }),
  price: z.strictObject({
    monthly: z.number().nonnegative(),
    currency: CurrencySchema,
    /** Where the price comes from. */
    source: z.string().min(1),
    checkedOn: z.iso.date(),
  }),
});

/**
 * Persistent storage. No storage key is ever here: the user's key is kept locally like a provider
 * token.
 */
export const StorageSchema = z.strictObject({
  /** SQLite's database folder, relative to the app; a persistent volume. */
  sqlite: z.strictObject({ dir: RepoPathSchema }).optional(),
  objectStorage: ObjectStorageSchema.optional(),
});
