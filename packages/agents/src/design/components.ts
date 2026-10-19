/**
 * The app's components besides the web process (FR-1301–FR-1304): workers and cron jobs, the
 * services OpsCrew runs from its catalog, and storage, each only when the app already uses it
 * (FR-1302), with the user's edits to an earlier plan kept (FR-1304).
 */
import { canonicalJson, formatMoney, isUserFacingError, listText } from "@opscrew/core";
import { renderRuntimeFiles, serviceSpec } from "@opscrew/iac-templates";
import {
  ComponentNameSchema,
  type DeployPlan,
  type Money,
  type PlanService,
  PlanServiceSchema,
  type ProjectFacts,
  type Requirements,
  type SelfHostedServiceKind,
  type ServiceKind,
  ServiceKindSchema,
} from "@opscrew/plan-schema";
import { EDGE_MEMORY_MB, SYSTEM_RESERVE_MB } from "../shared/memory";
import { backgroundJobLibraries } from "./background-jobs";
import {
  expectedStorageUse,
  type ObjectStorage,
  type StorageOffer,
  sqliteMove,
  storageOffers,
  storageOfferText,
  storagePrice,
} from "./storage";

type Worker = DeployPlan["processes"]["workers"][number];
type CronJob = DeployPlan["processes"]["cron"][number];

/** What design plans next to the web process, as `opscrew/plan.yaml` holds it. */
export interface Components {
  /** The web process's memory limit. */
  app: { memoryMb: number };
  processes: { workers: Worker[]; cron: CronJob[] };
  services: PlanService[];
  storage?: NonNullable<DeployPlan["storage"]>;
  /** Services the app keeps using where they are hosted now. */
  externalServices: ServiceKind[];
}

/** {@link designComponents}'s result. */
export interface DesignedComponents {
  components: Components;
  /** One plain sentence per component, choice and kept edit, for design's output. */
  lines: string[];
  /** What the user must act on, such as a worker without a command. */
  warnings: string[];
}

/** The web process's memory limit unless the plan sets another. */
const APP_MEMORY_MB = 512;

/** The service OpsCrew runs for each kind of service an app uses, in the plan's order. */
const RUNS: Readonly<Partial<Record<ServiceKind, SelfHostedServiceKind>>> = {
  postgres: "postgres",
  mysql: "mysql",
  mariadb: "mariadb",
  mongodb: "mongodb",
  redis: "valkey",
  amqp: "rabbitmq",
  nats: "nats",
  kafka: "kafka",
  opensearch: "opensearch",
  elasticsearch: "elasticsearch",
  meilisearch: "meilisearch",
  typesense: "typesense",
  clickhouse: "clickhouse",
  neo4j: "neo4j",
};

/** A user's choice of another engine for the same clients (FR-1320: Redpanda for Kafka). */
const ALTERNATIVES: Readonly<Partial<Record<SelfHostedServiceKind, SelfHostedServiceKind>>> = {
  kafka: "redpanda",
};

/** Kinds the app may reach where they are hosted now (`externalServices`). */
const EXTERNAL_KINDS: ReadonlySet<ServiceKind> = new Set([
  ...(Object.keys(RUNS) as ServiceKind[]),
  "supabase",
  "firebase",
  "s3",
  "stripe",
  "email",
  "cassandra",
]);

/** MongoDB Atlas gives out its SRV form, which an app keeps without being asked (FR-1315). */
const ATLAS = "MongoDB Atlas";

/** A hosted service the interview asks about (FR-1315): keep it, or let OpsCrew run one. */
export interface HostedChoice {
  /** The kind in `keepExternalServices`. */
  kind: ServiceKind;
  /** The hosting providers, for example `Neon`. */
  providers: string[];
  /** The variables the app reaches it with. */
  variables: string[];
  /** The service OpsCrew would run instead. */
  runs: SelfHostedServiceKind;
}

/**
 * The hosted services the interview asks about, by kind: Supabase, and each hosted service OpsCrew
 * could run instead (Neon, PlanetScale, Upstash, CloudAMQP …). MongoDB Atlas and services OpsCrew
 * cannot run are kept without asking.
 */
export function hostedChoices(facts: ProjectFacts): HostedChoice[] {
  const choices = new Map<ServiceKind, HostedChoice>();
  if (facts.services.some((service) => service.kind === "supabase")) {
    choices.set("supabase", {
      kind: "supabase",
      providers: ["Supabase"],
      variables: [],
      runs: "postgres",
    });
  }
  for (const hosted of facts.hostedServices ?? []) {
    const runs = RUNS[hosted.kind];
    if (runs === undefined || hosted.provider === ATLAS) continue;
    const choice = choices.get(hosted.kind) ?? {
      kind: hosted.kind,
      providers: [],
      variables: [],
      runs,
    };
    if (!choice.providers.includes(hosted.provider)) choice.providers.push(hosted.provider);
    choice.variables.push(hosted.variable);
    choices.set(hosted.kind, choice);
  }
  return ServiceKindSchema.options.flatMap((kind) => choices.get(kind) ?? []);
}

/**
 * The kinds the app keeps where they are hosted unless the interview says otherwise: every hosted
 * service (and Supabase), in schema order.
 */
export function hostedKinds(facts: ProjectFacts): ServiceKind[] {
  const kinds = new Set<ServiceKind>((facts.hostedServices ?? []).map((hosted) => hosted.kind));
  if (facts.services.some((service) => service.kind === "supabase")) kinds.add("supabase");
  return ServiceKindSchema.options.filter((kind) => kinds.has(kind));
}

/**
 * Whether the app keeps a kind where it is hosted now, by the interview's answers (FR-1315): its
 * answer, else `true` for a hosted service the app uses (`hostedKinds`) and `false` for any other
 * kind. Postgres stays where it is with a kept Supabase.
 */
function keepsExternal(
  facts: ProjectFacts,
  answers: Requirements["keepExternalServices"],
): (kind: ServiceKind) => boolean {
  const hosted = new Set(hostedKinds(facts));
  const keeps = (kind: ServiceKind) => answers[kind] ?? hosted.has(kind);
  return (kind) =>
    keeps(kind) || (kind === "postgres" && hosted.has("supabase") && keeps("supabase"));
}

/** `text` in the plan's name form (`[a-z][a-z0-9-]*`), or empty: `celery_beat` → `celery-beat`. */
function nameOf(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .replace(/-+/g, "-")
    .replace(/-$/, "");
}

/**
 * A worker's name in the plan (`[a-z][a-z0-9-]*`, never one of OpsCrew's own): `celery_beat`
 * becomes `celery-beat`, `cron` becomes `cron-worker`. The interview keys worker commands by it.
 */
export function workerName(name: string): string {
  const valid = nameOf(name) || "worker";
  return ComponentNameSchema.safeParse(valid).success ? valid : `${valid}-worker`;
}

/** The detected workers no convention gives a command, by their plan name (BullMQ, asynq, river). */
export function workersWithoutCommand(facts: ProjectFacts): string[] {
  return (facts.workers ?? [])
    .filter((worker) => worker.command === undefined)
    .map((worker) => workerName(worker.name));
}

/** The library a detected service comes from (`dependency:mysql2` → `mysql2`), when one does. */
function library(facts: ProjectFacts, kind: ServiceKind): string | undefined {
  const evidence = facts.services
    .find((service) => service.kind === kind)
    ?.evidence.find((item) => item.startsWith("dependency:"));
  return evidence?.slice("dependency:".length).replace(/\[[^\]]*\]$/, "");
}

/** The variable detection found the app reading `kind`'s address from. */
function detectedVariable(facts: ProjectFacts, kind: ServiceKind): string | undefined {
  return facts.services.find((service) => service.kind === kind)?.variable;
}

/**
 * For a kind the app reaches at a hosting provider that OpsCrew runs anyway (the interview did
 * not keep it): ` It runs on your server instead of Neon, as the interview answered: …`.
 */
function insteadText(facts: ProjectFacts, kind: ServiceKind): string {
  const hosts = new Set(
    (facts.hostedServices ?? []).filter((h) => h.kind === kind).map((h) => h.provider),
  );
  if (kind === "postgres" && facts.services.some((s) => s.kind === "supabase")) {
    hosts.add("Supabase");
  }
  if (hosts.size === 0) return "";
  return ` It runs on your server instead of ${listText([...hosts])}, as the interview answered: move the data yourself.`;
}

/** `The app uses MySQL through mysql2.` */
function usesText(facts: ProjectFacts, kind: ServiceKind, title: string): string {
  const lib = library(facts, kind);
  return `The app uses ${title}${lib === undefined ? "" : ` through ${lib}`}.${insteadText(facts, kind)}`;
}

/**
 * True when the app's job library keeps its jobs in Redis (FR-1321): Redis comes from the same
 * evidence as the queue (BullMQ, RQ, Sidekiq, Laravel's `QUEUE_CONNECTION=redis`, `celery[redis]`),
 * or Celery's broker URL is Redis's.
 */
function queueOnRedis(facts: ProjectFacts): boolean {
  const strip = (evidence: string) => evidence.replace(/\[[^\]]*\]$/, "");
  const of = (kind: ServiceKind) => facts.services.find((s) => s.kind === kind)?.evidence ?? [];
  const queue = new Set(of("queue").map(strip));
  return of("redis").some((e) => e === "config:redis-broker" || queue.has(strip(e)));
}

/** A cache address the app reads besides the queue's (`REDIS_CACHE_URL`, `CACHE_URL`). */
const CACHE_VARIABLE = /^(?:\w+_)?(?:REDIS_CACHE|CACHE_REDIS|CACHE)_UR[LI]$/;

function separateCacheVariable(facts: ProjectFacts, queue: string | undefined): string | undefined {
  return facts.envVars.find(
    (v) =>
      v.name !== queue &&
      !v.clientExposed &&
      CACHE_VARIABLE.test(v.name) &&
      (v.urlScheme === "redis" || (v.urlScheme === undefined && v.name.includes("REDIS"))),
  )?.name;
}

/** A service entry with the catalog's defaults (FR-1311, FR-1326) and its reason. */
function entry(
  kind: SelfHostedServiceKind,
  reason: string,
  extra: { name?: string; options?: object; variable?: string | undefined } = {},
): PlanService {
  const spec = serviceSpec(kind);
  return PlanServiceSchema.parse({
    ...(extra.name === undefined ? {} : { name: extra.name }),
    kind,
    version: spec.defaultVersion,
    memoryMb: spec.memory.defaultMb,
    enabled: true,
    ...(extra.options === undefined ? {} : { options: extra.options }),
    ...(extra.variable === undefined ? {} : { variable: extra.variable }),
    reason,
    licence: spec.licence.id,
  });
}

/** The services for what the app uses, unless it keeps them where they are hosted. */
function freshServices(facts: ProjectFacts, kept: (kind: ServiceKind) => boolean): PlanService[] {
  const used = new Set(facts.services.map((service) => service.kind));
  const services: PlanService[] = [];
  for (const kind of Object.keys(RUNS) as ServiceKind[]) {
    const runs = RUNS[kind];
    if (!used.has(kind) || runs === undefined || kept(kind)) continue;
    // MariaDB only when the app declares it, and then instead of MySQL (FR-1311).
    if (kind === "mysql" && used.has("mariadb")) continue;
    const spec = serviceSpec(runs);
    const variable = detectedVariable(facts, kind);
    if (runs === "valkey") {
      services.push(...valkeyServices(facts, variable));
    } else if (runs === "mongodb") {
      // Prisma needs transactions, which MongoDB has only in a replica set.
      const replicaSet = facts.services.some(
        (s) => s.kind === "mongodb" && s.evidence.includes("prisma:mongodb"),
      );
      const why = replicaSet ? " It runs as a one-node replica set, because Prisma needs one." : "";
      services.push(
        entry(runs, `${usesText(facts, kind, spec.title)}${why}`, {
          options: { replicaSet },
          variable,
        }),
      );
    } else if (runs === "rabbitmq") {
      services.push(
        entry(runs, `${usesText(facts, kind, "AMQP")} RabbitMQ is the broker that speaks it.`, {
          variable,
        }),
      );
    } else if (runs === "kafka") {
      services.push(
        entry(
          runs,
          `${usesText(facts, kind, "Kafka")} Apache Kafka runs it; Redpanda is the other choice (set this service's kind to redpanda in opscrew/plan.yaml).`,
          { variable },
        ),
      );
    } else {
      services.push(entry(runs, usesText(facts, kind, spec.title), { variable }));
    }
  }
  return services;
}

/**
 * Valkey for an app on Redis (FR-1321): a queue that never evicts and keeps its data on disk when
 * a job library keeps its jobs there, with a separate cache only when the app reads a separate
 * cache address; else a cache.
 */
function valkeyServices(facts: ProjectFacts, variable: string | undefined): PlanService[] {
  const instead = insteadText(facts, "redis");
  if (!queueOnRedis(facts)) {
    return [
      entry("valkey", `The app uses Redis; Valkey is its open-source fork.${instead}`, {
        options: { mode: "cache" },
        variable,
      }),
    ];
  }
  const libraries = backgroundJobLibraries(facts);
  const jobs = libraries.length > 0 ? listText(libraries) : "The app's job library";
  const cache = separateCacheVariable(facts, variable);
  return [
    entry(
      "valkey",
      `${jobs} keeps its jobs in Redis, so Valkey, Redis's open-source fork, runs as a queue: it never evicts a job and keeps them on disk.${instead}`,
      { options: { mode: "queue" }, variable },
    ),
    ...(cache === undefined
      ? []
      : [
          entry(
            "valkey",
            `The app reads a separate cache address (${cache}), so the cache gets a Valkey of its own, which drops the least used keys when it is full.`,
            { options: { mode: "cache" }, variable: cache },
          ),
        ]),
  ];
}

/** What a kept edit and a change say, collected for design's output. */
interface Notes {
  /** `the service mysql: memory 768 MB`, for one sentence. */
  kept: string[];
  /** Whole sentences on what design added, removed or changed. */
  changed: string[];
}

/** `memory 768 MB, turned off` for the fields of `after` that differ from `before`. */
function serviceEdits(before: PlanService, after: PlanService): string[] {
  return [
    ...(before.version !== after.version ? [`version ${after.version}`] : []),
    ...(before.memoryMb !== after.memoryMb ? [`memory ${after.memoryMb} MB`] : []),
    ...(before.enabled !== after.enabled ? [after.enabled ? "turned on" : "turned off"] : []),
    ...(canonicalJson(before.options) !== canonicalJson(after.options) ? ["its options"] : []),
    ...(before.variable !== after.variable && after.variable !== undefined
      ? [`variable ${after.variable}`]
      : []),
  ];
}

/**
 * The fresh services with the user's edits of the previous plan's (same name, and the same kind or
 * its alternative): version, memory (at least the catalog's minimum), turned off, options and
 * variable. A previous service detection no longer finds stays, with a line saying so: plan.yaml
 * may hold data in it, or the user added it.
 */
function keepServices(
  fresh: PlanService[],
  previous: readonly PlanService[] | undefined,
  notes: Notes,
): PlanService[] {
  if (previous === undefined) return fresh;
  const services = fresh.map((service) => {
    const before = previous.find(
      (p) =>
        p.name === service.name &&
        (p.kind === service.kind || ALTERNATIVES[service.kind] === p.kind),
    );
    if (before === undefined) {
      notes.changed.push(
        `Added the service ${service.name} (${serviceSpec(service.kind).title}). ${service.reason}`,
      );
      return service;
    }
    const spec = serviceSpec(before.kind);
    const kept = PlanServiceSchema.parse({
      ...service,
      kind: before.kind,
      version: before.version,
      memoryMb: Math.max(before.memoryMb, spec.memory.minimumMb),
      enabled: before.enabled,
      options: before.kind === service.kind ? before.options : {},
      ...(before.variable === undefined ? {} : { variable: before.variable }),
      ...(before.kind === service.kind
        ? {}
        : {
            reason: `${service.reason.split(". ")[0]}. You chose ${spec.title} in opscrew/plan.yaml.`,
            licence: spec.licence.id,
          }),
    });
    const raised = before.memoryMb < spec.memory.minimumMb;
    if (raised) {
      notes.changed.push(
        `Raised the service ${kept.name}'s memory from ${before.memoryMb} MB to ${kept.memoryMb} MB, the least ${spec.title} runs with.`,
      );
    }
    const edits = [
      ...(before.kind === service.kind ? [] : [spec.title]),
      ...serviceEdits(service, raised ? { ...kept, memoryMb: service.memoryMb } : kept),
    ];
    if (edits.length > 0) notes.kept.push(`the service ${kept.name} (${listText(edits)})`);
    return kept;
  });
  for (const before of previous) {
    if (services.some((service) => service.name === before.name)) continue;
    notes.changed.push(
      `${before.name} stays because plan.yaml lists it, though the app no longer seems to use it. Delete it there to remove it.`,
    );
    services.push(before);
  }
  return services;
}

/** `name`, or `name-2`, `name-3` … when `taken` has it. */
function unique(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name;
  let i = 2;
  while (taken.has(`${name}-${i}`)) i++;
  return `${name}-${i}`;
}

interface WorkersInput {
  facts: ProjectFacts;
  requirements: Requirements;
  previous: DeployPlan | undefined;
  /** True when the interview was answered after the previous plan was written. */
  answeredLater: boolean;
  /** Service names, which a worker's name must not take. */
  serviceNames: ReadonlySet<string>;
}

/**
 * The workers from the Procfile and the job libraries (FR-1305): their command from detection,
 * else from the plan or the interview (the newer of the two), else none, which the warnings say.
 * A previous worker keeps its count, memory, stop grace and whether it runs; a worker the user
 * added stays; a detected one the app no longer has goes.
 */
function workersFor(input: WorkersInput, notes: Notes, warnings: string[]): Worker[] {
  const { facts, requirements, previous } = input;
  const before = new Map((previous?.processes.workers ?? []).map((w) => [w.name, w]));
  const taken = new Set(input.serviceNames);
  const workers: Worker[] = [];
  for (const found of facts.workers ?? []) {
    const base = workerName(found.name);
    const name = unique(base, taken);
    taken.add(name);
    const old = before.get(name);
    const answered = requirements.workerCommands?.[base];
    const command =
      found.command ??
      (input.answeredLater ? (answered ?? old?.command) : (old?.command ?? answered));
    if (command === undefined) {
      warnings.push(
        `OpsCrew found the worker ${name} (${found.evidence.join(", ")}) but no command that starts it, so it is not in the plan. Give its command with \`opscrew interview\`, or add the worker to processes.workers in opscrew/plan.yaml, then run \`opscrew design\` again.`,
      );
      continue;
    }
    const fresh: Worker = {
      name,
      command,
      source: found.source,
      count: 1,
      single: found.single,
      stopGraceSeconds: 30,
      memoryMb: 256,
      enabled: true,
    };
    if (old === undefined) {
      if (previous !== undefined) notes.changed.push(`Added the worker ${name}: ${command}`);
      workers.push(fresh);
      continue;
    }
    const kept: Worker = {
      ...fresh,
      count: found.single ? 1 : old.count,
      stopGraceSeconds: old.stopGraceSeconds,
      memoryMb: old.memoryMb,
      enabled: old.enabled,
    };
    const edits = [
      ...(kept.count !== fresh.count ? [`${kept.count} copies`] : []),
      ...(kept.memoryMb !== fresh.memoryMb ? [`memory ${kept.memoryMb} MB`] : []),
      ...(kept.stopGraceSeconds !== fresh.stopGraceSeconds
        ? [`stop grace ${kept.stopGraceSeconds} seconds`]
        : []),
      ...(kept.enabled ? [] : ["turned off"]),
    ];
    if (edits.length > 0) notes.kept.push(`the worker ${name} (${listText(edits)})`);
    workers.push(kept);
  }
  for (const old of previous?.processes.workers ?? []) {
    if (workers.some((worker) => worker.name === old.name)) continue;
    if (old.source === "user") {
      workers.push(old);
    } else {
      notes.changed.push(
        `Removed the worker ${old.name}: OpsCrew no longer finds it in the app's Procfile or job libraries.`,
      );
    }
  }
  return workers;
}

/** A cron job's name from its route: `/api/cron/cleanup` → `cleanup`. */
function cronName(route: string): string {
  return nameOf(route.split("?")[0]?.split("/").filter(Boolean).at(-1) ?? "") || "job";
}

/**
 * The cron jobs of `vercel.json` (FR-1308, FR-1309), each calling its route; a previous job for
 * the same route keeps its name and whether it runs, and the user's command jobs stay.
 */
function cronFor(facts: ProjectFacts, previous: DeployPlan | undefined, notes: Notes): CronJob[] {
  const before = previous?.processes.cron ?? [];
  const taken = new Set<string>();
  const jobs: CronJob[] = [];
  for (const found of facts.cronJobs ?? []) {
    const old = before.find((job) => job.route === found.route);
    const name = old?.name ?? unique(cronName(found.route), taken);
    taken.add(name);
    jobs.push({
      name,
      schedule: found.schedule,
      route: found.route,
      enabled: old?.enabled ?? true,
    });
    if (old?.enabled === false) notes.kept.push(`the cron job ${name} (turned off)`);
    if (old === undefined && previous !== undefined) {
      notes.changed.push(`Added the cron job ${name}: GET ${found.route} on ${found.schedule}.`);
    }
  }
  for (const old of before) {
    if (old.command !== undefined) {
      jobs.push(old);
    } else if (!jobs.some((job) => job.route === old.route)) {
      notes.changed.push(
        `Removed the cron job ${old.name}: vercel.json no longer calls ${old.route}.`,
      );
    }
  }
  return jobs;
}

/**
 * True when the plan's image can call the app's routes with a cron job's secret, by the crontab
 * renderer's own rule (it refuses a route job otherwise): rendering one route job tells.
 */
function callsRoutes(plan: DeployPlan): boolean {
  const job = { name: "route", schedule: "@daily", route: "/", enabled: true };
  try {
    renderRuntimeFiles({ ...plan, services: [], processes: { workers: [], cron: [job] } });
    return true;
  } catch (error) {
    if (isUserFacingError(error) && error.code === "INVALID_INPUT") return false;
    throw error;
  }
}

/**
 * The names of the plan's new cron jobs on routes its image cannot call (FR-1309), which design
 * plans turned off: on a server, jobs the previous plan did not have. A job the user turned on
 * stays on, and the renderer refuses it at provision while it still cannot run. (A Portainer
 * stack's renderer checks its own.)
 */
export function uncallableRouteJobs(plan: DeployPlan, previous: DeployPlan | undefined): string[] {
  const added = plan.processes.cron.filter(
    (job) =>
      job.enabled &&
      job.route !== undefined &&
      !(previous?.processes.cron ?? []).some((old) => old.route === job.route),
  );
  if (added.length === 0 || plan.target.provider === "portainer" || callsRoutes(plan)) return [];
  return added.map((job) => job.name);
}

/** Why the route jobs `names` are turned off, and what makes them run, for the plan's builder. */
export function routeJobsOffText(names: readonly string[], plan: DeployPlan): string {
  const jobs = `${names.length === 1 ? "The cron job" : "The cron jobs"} ${listText([...names])}`;
  const why =
    plan.app.build?.builder === "own-dockerfile"
      ? "your own Dockerfile builds the image, so OpsCrew knows no tool in it that can call a route with the job's secret"
      : "the image is a static site served by Caddy, whose busybox wget cannot send the job's secret, and a static site answers no route";
  const fix =
    plan.app.build?.builder === "own-dockerfile"
      ? "let OpsCrew build the image (app.build.builder: railpack with app.build.chosen: user)"
      : "deploy the app with a server that answers the routes (app.build.builder: railpack with app.build.chosen: user)";
  return `${jobs} ${names.length === 1 ? "calls" : "call"} the app's routes, but ${why}, so OpsCrew turned ${names.length === 1 ? "it" : "them"} off in opscrew/plan.yaml (processes.cron). To run ${names.length === 1 ? "it" : "them"}, ${fix}, or give each job a command that runs its code in the image instead of the route; then set enabled: true.`;
}

interface StorageInput {
  facts: ProjectFacts;
  requirements: Requirements;
  previous: DeployPlan | undefined;
  answeredLater: boolean;
  /** The bucket's name when the plan has none: `<app>-uploads`. */
  appName: string;
}

/**
 * Object storage for an app with an S3 client (FR-1316): the cheapest option for where it runs,
 * priced for the expected use, unless the plan already chose one that still works there (a bucket
 * at a provider stays where it is). Undefined with the options when nothing is offered here.
 */
function objectStorageFor(input: StorageInput): {
  storage?: ObjectStorage;
  offers: StorageOffer[];
} {
  const { facts, requirements } = input;
  const found = facts.objectStorage;
  if (found === undefined || requirements.keepExternalServices.s3 === true) {
    return { offers: [] };
  }
  const old = input.previous?.storage?.objectStorage;
  const expected =
    old !== undefined && !input.answeredLater
      ? old.expected
      : expectedStorageUse(requirements.expectedMonthlyUsers);
  const offers = storageOffers(requirements, expected);
  // The plan's choice stays when it is offered here, and a provider's bucket wherever the app runs
  // (after a retarget it stays where it is).
  const keepsOld =
    old !== undefined &&
    (offers.some((offer) => offer.provider === old.provider) ||
      old.provider === "hetzner" ||
      old.provider === "digitalocean");
  const chosen = keepsOld
    ? { provider: old.provider, region: old.region }
    : (offers[0] ?? undefined);
  if (chosen === undefined) return { offers };
  const price = storagePrice(chosen.provider, expected);
  return {
    offers,
    storage: {
      provider: chosen.provider,
      bucket: keepsOld ? old.bucket : `${input.appName}-uploads`,
      region: chosen.region,
      cors: found.presignedUploads,
      expected,
      price: {
        monthly: price.amount,
        currency: price.currency,
        source: price.source,
        checkedOn: price.checkedOn,
      },
    },
  };
}

/** The databases whose catalog entries give the app `DATABASE_URL`, and the name each has otherwise. */
const OWN_DATABASE_VARIABLE: Readonly<Partial<Record<SelfHostedServiceKind, string>>> = {
  postgres: "POSTGRES_URL",
  mysql: "MYSQL_URL",
  mariadb: "MARIADB_URL",
  mongodb: "MONGODB_URI",
};

/**
 * Two databases that both give the app `DATABASE_URL`: the one whose variable the app reads it
 * for keeps it (else the first), and each other one gets a name of its own, which design says.
 * A variable two services would both fill stays with the first.
 */
function resolveVariables(services: PlanService[], lines: string[]): PlanService[] {
  const databases = services.filter(
    (s) => s.enabled && OWN_DATABASE_VARIABLE[s.kind] !== undefined,
  );
  const owner = databases.find((s) => s.variable === "DATABASE_URL") ?? databases[0];
  const resolved = services.map((service) => {
    if (databases.length < 2 || !databases.includes(service)) return service;
    if (service === owner) return { ...service, variable: "DATABASE_URL" };
    const own =
      service.variable !== undefined && service.variable !== "DATABASE_URL"
        ? service.variable
        : (OWN_DATABASE_VARIABLE[service.kind] as string);
    const title = (s: PlanService) => serviceSpec(s.kind).title;
    lines.push(
      `The app has two databases that both use DATABASE_URL: ${title(owner as PlanService)} keeps it, and ${title(service)}'s address goes to ${own}. Make sure the app reads ${title(service)}'s address from ${own}.`,
    );
    return { ...service, variable: own };
  });
  const seen = new Set<string>();
  return resolved.map((service) => {
    if (!service.enabled || service.variable === undefined) return service;
    if (!seen.has(service.variable)) {
      seen.add(service.variable);
      return service;
    }
    const { variable: _taken, ...rest } = service;
    return rest;
  });
}

/** The kinds the running services stand for when not their own: Valkey for Redis. */
const STANDS_FOR: Readonly<Partial<Record<SelfHostedServiceKind, readonly ServiceKind[]>>> = {
  postgres: ["postgres", "supabase"],
  mariadb: ["mariadb", "mysql"],
  valkey: ["redis"],
  rabbitmq: ["amqp"],
  redpanda: ["kafka"],
};

/**
 * The app's components from its facts, the interview's answers and the plan being replaced
 * (FR-1301–FR-1304, FR-1308, FR-1309, FR-1311–FR-1321):
 * - services by kind with the catalog's version and memory and one reason each; a kind is kept
 *   external when the interview keeps it, a hosted one unless it answered no
 *   (`keepExternalServices`), or when OpsCrew cannot run it (Cassandra);
 * - workers and cron jobs, and `storage.sqlite` for an app on SQLite;
 * - object storage for an app with an S3 client, the cheapest option for where it runs, with
 *   Garage as a service on a server the user owns or a Portainer;
 * - the previous plan's edits kept: counts, memory, versions, options, a component turned off,
 *   the web process's memory, the object storage choice;
 * - with two databases on `DATABASE_URL`, the one the app reads it for keeps it.
 */
export function designComponents(input: {
  facts: ProjectFacts;
  requirements: Requirements;
  /** The plan being replaced, whose component edits are kept. */
  previous?: DeployPlan | undefined;
}): DesignedComponents {
  const { facts, requirements, previous } = input;
  const lines: string[] = [];
  const warnings: string[] = [];
  const notes: Notes = { kept: [], changed: [] };
  const answeredLater =
    previous !== undefined && Date.parse(requirements.answeredAt) > Date.parse(previous.updatedAt);
  const kept = keepsExternal(facts, requirements.keepExternalServices);

  const storage = objectStorageFor({
    facts,
    requirements,
    previous,
    answeredLater,
    appName: appNameFor(facts),
  });
  const garage =
    storage.storage?.provider === "garage"
      ? [
          entry(
            "garage",
            `The app stores files through S3 (${facts.objectStorage?.client}), and Garage keeps them on this server only, with no copy elsewhere.`,
            {
              variable: facts.objectStorage?.variables.find((name) => name.includes("ENDPOINT")),
            },
          ),
        ]
      : [];
  const services = resolveVariables(
    keepServices([...freshServices(facts, kept), ...garage], previous?.services, notes),
    lines,
  );
  const workers = workersFor(
    {
      facts,
      requirements,
      previous,
      answeredLater,
      serviceNames: new Set(services.map((s) => s.name)),
    },
    notes,
    warnings,
  );
  const cron = cronFor(facts, previous, notes);
  const memoryMb = previous?.app.memoryMb ?? APP_MEMORY_MB;
  if (memoryMb !== APP_MEMORY_MB) notes.kept.unshift(`the app's memory (${memoryMb} MB)`);

  const runs = new Set(
    services
      .filter((service) => service.enabled)
      .flatMap((service) => STANDS_FOR[service.kind] ?? (service.kind as ServiceKind)),
  );
  if (storage.storage !== undefined) runs.add("s3");
  const answered = Object.entries(requirements.keepExternalServices).flatMap(([kind, keep]) =>
    keep ? [kind as ServiceKind] : [],
  );
  const used = new Set([...facts.services.map((s) => s.kind), ...answered]);
  const externalServices = ServiceKindSchema.options.filter(
    (kind) => used.has(kind) && EXTERNAL_KINDS.has(kind) && !runs.has(kind),
  );
  const sqlite =
    facts.sqlite === undefined ? undefined : { dir: sqliteMove(facts)?.dir ?? facts.sqlite.dir };
  const components: Components = {
    app: { memoryMb },
    processes: { workers, cron },
    services,
    ...(sqlite !== undefined || storage.storage !== undefined
      ? {
          storage: {
            ...(sqlite === undefined ? {} : { sqlite }),
            ...(storage.storage === undefined ? {} : { objectStorage: storage.storage }),
          },
        }
      : {}),
    externalServices,
  };

  lines.push(...componentLines(components, facts));
  lines.push(...externalLines(facts, externalServices));
  if (facts.objectStorage !== undefined) {
    const text = storageText(components, storage.offers);
    if (text !== undefined) lines.push(text);
    else if (requirements.keepExternalServices.s3 !== true) {
      warnings.push(
        `The app stores files through S3 (${facts.objectStorage.client}), but no object storage OpsCrew offers is available where it runs. Put the domain on Cloudflare to use Cloudflare R2, or keep the storage the app uses now (answer keepExternalServices.s3: true in \`opscrew interview\`).`,
      );
    }
  }
  if (notes.kept.length > 0) {
    lines.push(`Kept your changes in opscrew/plan.yaml: ${listText(notes.kept)}.`);
  }
  lines.push(...notes.changed);
  return { components, lines, warnings };
}

/** The components, one plain sentence each, with each licence that is not permissive (FR-1327). */
function componentLines(components: Components, facts: ProjectFacts): string[] {
  const lines: string[] = [];
  for (const service of components.services) {
    const spec = serviceSpec(service.kind);
    if (!service.enabled) {
      lines.push(`${spec.title} (${service.name}) is turned off in opscrew/plan.yaml.`);
      continue;
    }
    lines.push(
      `${spec.title} ${service.version} (${service.name}, ${service.memoryMb} MB): ${service.reason}`,
    );
  }
  for (const worker of components.processes.workers.filter((w) => w.enabled)) {
    const copies = worker.single
      ? ", one copy only: it schedules jobs"
      : worker.count > 1
        ? `, ${worker.count} copies`
        : "";
    lines.push(`Worker ${worker.name} (${worker.memoryMb} MB${copies}): ${worker.command}`);
  }
  for (const job of components.processes.cron.filter((j) => j.enabled)) {
    lines.push(
      job.route === undefined
        ? `Cron job ${job.name} (${job.schedule}, UTC): ${job.command}`
        : `Cron job ${job.name} (${job.schedule}, UTC): GET ${job.route}, with the generated CRON_SECRET as its bearer token, as Vercel sends it.`,
    );
  }
  const sqlite = components.storage?.sqlite;
  if (sqlite !== undefined) {
    const files = facts.sqlite?.paths ?? [];
    const move = sqliteMove(facts);
    lines.push(
      `The app keeps its SQLite database${files.length > 1 ? "s" : ""} in ${sqlite.dir}/ on a persistent volume, so each deploy stops the old version before the new one starts: two copies never write to it at once.${
        move === undefined
          ? ""
          : ` The database moves there from ${move.from}/, which also holds the app's own files, and ${move.variable} points ${move.reader} at it.`
      }`,
    );
  }
  const licences = new Set<string>();
  for (const service of components.services.filter((s) => s.enabled)) {
    const note = serviceSpec(service.kind).licence;
    if (!note.permissive && note.note !== undefined) licences.add(note.note);
  }
  lines.push(...licences);
  return lines;
}

/** What the app keeps using where it is hosted, and why OpsCrew does not run it. */
function externalLines(facts: ProjectFacts, external: readonly ServiceKind[]): string[] {
  const lines: string[] = [];
  for (const kind of external) {
    const hosted = (facts.hostedServices ?? []).filter((h) => h.kind === kind);
    if (hosted.length > 0) {
      const providers = [...new Set(hosted.map((h) => h.provider))];
      lines.push(
        `The app keeps using ${listText(providers)} for ${kind} (${listText(hosted.map((h) => h.variable))}); set its address in the app's production environment.`,
      );
    } else if (kind === "cassandra") {
      lines.push(
        "Cassandra stays where the app reaches it now: OpsCrew does not run it next to the app, because it needs several nodes and more memory than a small server has. A hosted Cassandra such as DataStax Astra DB works with the app's Cassandra driver.",
      );
    }
  }
  return lines;
}

/** The object storage choice with the other options and their prices, or undefined without one. */
function storageText(components: Components, offers: readonly StorageOffer[]): string | undefined {
  const storage = components.storage?.objectStorage;
  if (storage === undefined) return undefined;
  const { storageGb, egressGbPerMonth } = storage.expected;
  const chosen = {
    provider: storage.provider,
    price: storagePrice(storage.provider, storage.expected),
  };
  const others = offers.filter((offer) => offer.provider !== storage.provider);
  const cheapest = offers[0]?.provider === storage.provider;
  // What each price leaves out, such as a base price charged once per account.
  const notes = [...new Set([chosen, ...others].flatMap((offer) => offer.price.note ?? []))];
  return [
    `Object storage for the app's files, in the private bucket ${storage.bucket}, priced for ${storageGb} GB stored and ${egressGbPerMonth} GB sent a month (storage.objectStorage.expected): ${storageOfferText(chosen)}${cheapest ? ", the cheapest" : ""}.`,
    ...(others.length > 0
      ? [
          `Also offered here: ${others.map(storageOfferText).join("; ")}. To use another, set storage.objectStorage.provider in opscrew/plan.yaml.`,
        ]
      : []),
    ...notes,
    ...(storage.cors ? ["It accepts browser uploads from the app's own domain only."] : []),
  ].join(" ");
}

/** DNS-label-safe app name (`^[a-z0-9][a-z0-9-]{0,40}$`) from the project name. */
export function appNameFor(facts: ProjectFacts): string {
  const name = facts.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 41)
    .replace(/-+$/, "");
  return name === "" ? "app" : name;
}

/** Each running container's memory limit with its name, the web process first. */
function memoryLimits(components: Pick<Components, "app" | "processes" | "services">): {
  name: string;
  memoryMb: number;
}[] {
  const { workers, cron } = components.processes;
  return [
    { name: "the app", memoryMb: components.app.memoryMb },
    ...workers
      .filter((worker) => worker.enabled)
      .map((worker) => ({ name: worker.name, memoryMb: worker.memoryMb * worker.count })),
    ...(cron.some((job) => job.enabled)
      ? [{ name: "cron", memoryMb: components.app.memoryMb }]
      : []),
    ...components.services
      .filter((service) => service.enabled)
      .map((service) => ({ name: service.name, memoryMb: service.memoryMb })),
  ];
}

/**
 * The containers' memory on a server of `serverMb`, each with its share of the server's monthly
 * price when there is one (SC-1308): `Memory: the app 512 MB (€1.37/month), mysql 512 MB
 * (€1.37/month); OpsCrew's edge and the system 512 MB; 1.0 GB of 2 GB free.`
 */
export function memoryText(
  components: Pick<Components, "app" | "processes" | "services">,
  serverMb: number,
  monthly?: Money,
): string {
  const limits = memoryLimits(components);
  const share = (mb: number) =>
    monthly === undefined
      ? ""
      : ` (${formatMoney({ amount: (monthly.amount * mb) / serverMb, currency: monthly.currency })}/month)`;
  const shared = EDGE_MEMORY_MB + SYSTEM_RESERVE_MB;
  const used = limits.reduce((sum, limit) => sum + limit.memoryMb, 0);
  const free = Math.max(0, serverMb - used - shared);
  const gb = (mb: number) => `${(mb / 1024).toFixed(1)} GB`;
  return `Memory limits: ${limits.map((l) => `${l.name} ${l.memoryMb} MB${share(l.memoryMb)}`).join(", ")}; OpsCrew's edge and the system ${shared} MB; ${gb(free)} of ${gb(serverMb)} free.`;
}
