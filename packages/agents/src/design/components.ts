/**
 * The app's components besides the web process (FR-1301–FR-1304): workers and cron jobs, the
 * services OpsCrew runs from its catalog, and storage, each only when the app already uses it
 * (FR-1302), with the user's edits to an earlier plan kept (FR-1304).
 */
import { canonicalJson, formatMoney, isUserFacingError, listText } from "@opscrew/core";
import {
  DRAGONFLY_MIN_VCPUS,
  portainerHostSettingProblem,
  renderPortainerStack,
  renderRuntimeFiles,
  STORAGE_NAMES,
  serviceSpec,
} from "@opscrew/iac-templates";
import {
  ComponentNameSchema,
  type DeployPlan,
  isServerlessProvider,
  type Money,
  type PlanService,
  PlanServiceSchema,
  type ProjectFacts,
  REDIS_PROTOCOL_KINDS,
  type Requirements,
  type SelfHostedServiceKind,
  type ServiceKind,
  ServiceKindSchema,
} from "@opscrew/plan-schema";
import { localhostHostSettingProblem } from "../localhost/preflight";
import { appMemoryLimits, SYSTEM_RESERVE_MB } from "../shared/memory";
import { backgroundJobLibraries } from "./background-jobs";
import { convertMoney } from "./cost";
import {
  defaultStorageOffer,
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

/** Engines for the same clients (FR-1320: Kafka and Redpanda; FR-1321a: Redis's protocol). */
const ENGINE_FAMILIES: readonly (readonly SelfHostedServiceKind[])[] = [
  ["kafka", "redpanda"],
  REDIS_PROTOCOL_KINDS,
];

/**
 * True when a previous plan's service of kind `previous` is kept where design plans `fresh`: the
 * same kind, or another engine of its family the user switched to in plan.yaml (Redpanda, Redis 8,
 * Dragonfly). A previous Valkey never is: it is design's default, so design's engine replaces it
 * once the app needs Redis 8 or its Compose file runs Dragonfly.
 */
function keptKind(previous: SelfHostedServiceKind, fresh: SelfHostedServiceKind): boolean {
  if (previous === fresh) return true;
  if (previous === "valkey") return false;
  return ENGINE_FAMILIES.some((family) => family.includes(previous) && family.includes(fresh));
}

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
    const runs = hosted.kind === "redis" ? redisEngine(facts).kind : RUNS[hosted.kind];
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

/**
 * The app's services OpsCrew would run next to it on a server, by kind with their names: each kind
 * OpsCrew can run (Redis as Valkey) that the app does not keep where it is hosted
 * ({@link keepsExternal}), in schema order. A server-less target has no server for them.
 */
export function selfHostedServices(
  facts: ProjectFacts,
  answers: Requirements["keepExternalServices"],
): { kind: ServiceKind; title: string }[] {
  const keeps = keepsExternal(facts, answers);
  const used = new Set(facts.services.map((service) => service.kind));
  return ServiceKindSchema.options.flatMap((kind) => {
    const runs = RUNS[kind];
    if (runs === undefined || !used.has(kind) || keeps(kind)) return [];
    return [{ kind, title: kind === "redis" ? "Redis" : serviceSpec(runs).title }];
  });
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
function freshServices(
  facts: ProjectFacts,
  kept: (kind: ServiceKind) => boolean,
  dragonflyOffered: boolean,
): PlanService[] {
  const used = new Set(facts.services.map((service) => service.kind));
  const services: PlanService[] = [];
  for (const kind of Object.keys(RUNS) as ServiceKind[]) {
    const runs = RUNS[kind];
    if (!used.has(kind) || runs === undefined || kept(kind)) continue;
    // MariaDB only when the app declares it, and then instead of MySQL (FR-1311).
    if (kind === "mysql" && used.has("mariadb")) continue;
    const spec = serviceSpec(runs);
    const variable = detectedVariable(facts, kind);
    if (kind === "redis") {
      services.push(...redisServices(facts, variable, dragonflyOffered));
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

/** An engine on Redis's protocol for the app, and the sentence that says why (FR-1321a). */
interface RedisEngine {
  kind: "valkey" | "redis" | "dragonfly";
  why: string;
}

/** The values of Redis's evidence that start with `prefix` (`redis-modules:`), without it. */
function redisEvidence(facts: ProjectFacts, prefix: string): string[] {
  const evidence = facts.services.find((s) => s.kind === "redis")?.evidence ?? [];
  return evidence.filter((e) => e.startsWith(prefix)).map((e) => e.slice(prefix.length));
}

/**
 * The engine an app on Redis gets (FR-1321a): Redis 8 for a client that needs Redis's own data
 * types (`redis-modules:` evidence), else the engine its own Compose file runs (`compose-image:`):
 * Dragonfly or Redis 8, and Valkey for KeyDB; else Valkey.
 */
function redisEngine(facts: ProjectFacts): RedisEngine {
  const modules = redisEvidence(facts, "redis-modules:");
  const compose = new Set(redisEvidence(facts, "compose-image:"));
  if (modules.length > 0) {
    return {
      kind: "redis",
      why: `${listText(modules)} ${modules.length === 1 ? "needs" : "need"} Redis's own data types (Search, JSON, Time Series or probabilistic structures), which only Redis 8 has together, so Redis 8 runs it.`,
    };
  }
  if (compose.has("dragonfly")) {
    return {
      kind: "dragonfly",
      why: "The app's Compose file runs Dragonfly, so Dragonfly runs it here too.",
    };
  }
  if (compose.has("redis")) {
    return {
      kind: "redis",
      why: "The app's Compose file runs Redis, so Redis 8 runs it here too.",
    };
  }
  if (compose.has("keydb")) {
    return {
      kind: "valkey",
      why: "The app's Compose file runs KeyDB, which has had no release since 2023, so Valkey, which speaks the same protocol, runs instead.",
    };
  }
  return { kind: "valkey", why: "Valkey, Redis's open-source fork, runs it." };
}

/** True when an app on Redis uses BullMQ, whose scripts need Dragonfly's hashtag locks. */
function usesBullmq(facts: ProjectFacts): boolean {
  return facts.services.some((s) => s.evidence.includes("dependency:bullmq"));
}

/**
 * The Redis-protocol services for an app on Redis (FR-1321, FR-1321a), on {@link redisEngine}'s
 * engine: a queue that never evicts and keeps its data on disk when a job library keeps its jobs
 * there, with a separate cache only when the app reads a separate cache address; else a cache.
 * Valkey's reason names Dragonfly as the other choice where it is offered.
 */
function redisServices(
  facts: ProjectFacts,
  variable: string | undefined,
  dragonflyOffered: boolean,
): PlanService[] {
  const engine = redisEngine(facts);
  const { title } = serviceSpec(engine.kind);
  const offer =
    engine.kind === "valkey" && dragonflyOffered
      ? " Dragonfly is the other choice: set this service's kind to dragonfly in opscrew/plan.yaml."
      : "";
  if (!queueOnRedis(facts)) {
    return [
      entry(engine.kind, `${usesText(facts, "redis", "Redis")} ${engine.why}${offer}`, {
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
      engine.kind,
      `${jobs} keeps its jobs in Redis, so it runs as a queue: it never evicts a job and keeps them on disk. ${engine.why}${offer}${insteadText(facts, "redis")}`,
      { options: { mode: "queue" }, variable },
    ),
    ...(cache === undefined
      ? []
      : [
          entry(
            engine.kind,
            `The app reads a separate cache address (${cache}), so the cache gets a ${title} of its own, which drops the least used keys when it is full.`,
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

/**
 * The options of a kept service: the previous plan's, or on a switch to another engine of its
 * family the mode alone (Redis's protocol) or none, the new engine's defaults filling the rest.
 */
function keptOptions(before: PlanService, fresh: PlanService): object {
  if (before.kind === fresh.kind) return before.options;
  return "mode" in before.options ? { mode: before.options.mode } : {};
}

/**
 * `memory 768 MB, turned off` for the fields of `after` that differ from `before`; options only
 * between services of one kind (a switched kind is its own edit), without Dragonfly's threads
 * and hashtag locks, which the plan gets from its server (`optionToPlan`) and the app's libraries.
 */
function serviceEdits(before: PlanService, after: PlanService): string[] {
  const settings = (service: PlanService) => {
    const {
      threads: _server,
      lockOnHashtags: _libraries,
      ...rest
    } = service.options as {
      threads?: number;
      lockOnHashtags?: boolean;
    };
    return canonicalJson(rest);
  };
  const options = before.kind === after.kind && settings(before) !== settings(after);
  return [
    ...(before.version !== after.version ? [`version ${after.version}`] : []),
    ...(before.memoryMb !== after.memoryMb ? [`memory ${after.memoryMb} MB`] : []),
    ...(before.enabled !== after.enabled ? [after.enabled ? "turned on" : "turned off"] : []),
    ...(options ? ["its options"] : []),
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
    const before = previous.find((p) => p.name === service.name && keptKind(p.kind, service.kind));
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
      options: keptOptions(before, service),
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

/**
 * The previous plan's services with a Dragonfly the user chose (where design plans another engine
 * of Redis's protocol) replaced by design's engine, on a server with fewer vCPUs than Dragonfly
 * is offered on (FR-1321a), each with a line saying so.
 */
function withoutChosenDragonfly(
  fresh: readonly PlanService[],
  previous: readonly PlanService[] | undefined,
  vcpus: number,
  notes: Notes,
): PlanService[] | undefined {
  return previous?.map((before) => {
    const planned = fresh.find((service) => service.name === before.name);
    const chosen =
      before.kind === "dragonfly" &&
      planned !== undefined &&
      planned.kind !== "dragonfly" &&
      "mode" in planned.options;
    if (!chosen) return before;
    notes.changed.push(
      `The service ${before.name} runs ${serviceSpec(planned.kind).title}, not the Dragonfly opscrew/plan.yaml chose: Dragonfly runs only on a server with ${DRAGONFLY_MIN_VCPUS} or more vCPUs, and yours has ${vcpus}.`,
    );
    return planned;
  });
}

/**
 * Dragonfly's hashtag locks on its queue for an app on BullMQ (FR-1321a), on a Dragonfly the user
 * chose too.
 */
function withBullmqLocks(services: readonly PlanService[], bullmq: boolean): PlanService[] {
  return services.map((service) =>
    service.kind === "dragonfly"
      ? {
          ...service,
          options: {
            ...service.options,
            lockOnHashtags: bullmq && service.options.mode === "queue",
          },
        }
      : service,
  );
}

/** The warning that each BullMQ queue needs a hashtag of its own, per Dragonfly that locks by them. */
function hashtagWarnings(services: readonly PlanService[]): string[] {
  return services.flatMap((service) =>
    service.kind === "dragonfly" && service.enabled && service.options.lockOnHashtags
      ? [
          `Dragonfly (${service.name}) runs with --cluster_mode=emulated --lock_on_hashtags, as BullMQ needs: give each queue's name or prefix its own hashtag, such as {myqueue} (new Queue("{myqueue}") or prefix: "{myqueue}"), or BullMQ's scripts fail. See https://www.dragonflydb.io/docs/integrations/bullmq.`,
        ]
      : [],
  );
}

/**
 * For each Dragonfly the app's Compose file runs on the user's server with fewer vCPUs than it is
 * offered on (FR-1321a: it still runs): it runs one thread there, as Valkey would.
 */
function oneThreadWarnings(services: readonly PlanService[], vcpus: number): string[] {
  return services.flatMap((service) =>
    service.kind === "dragonfly" && service.enabled
      ? [
          `Dragonfly (${service.name}) runs with one thread, because your server has ${vcpus} vCPU and Dragonfly uses one thread per vCPU, so Valkey would do the same job here. It runs because the app's Compose file runs it.`,
        ]
      : [],
  );
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

/** What rendering a Portainer stack needs here: nothing of it reaches a file. */
const STACK_CONTEXT = {
  opscrewVersion: "",
  github: { owner: "", repo: "" },
  deploySshPublicKey: "",
};

/**
 * True when the plan's image can call the app's routes with a cron job's secret, by the target's
 * renderer's own rule (the server's runtime files or the Portainer stack; each refuses a route job
 * otherwise): rendering one route job tells.
 */
function callsRoutes(plan: DeployPlan): boolean {
  const job = { name: "route", schedule: "@daily", route: "/", enabled: true };
  const probe = { ...plan, services: [], processes: { workers: [], cron: [job] } };
  try {
    if (plan.target.provider === "portainer") renderPortainerStack(probe, STACK_CONTEXT);
    else renderRuntimeFiles(probe);
    return true;
  } catch (error) {
    if (isUserFacingError(error) && error.code === "INVALID_INPUT") return false;
    throw error;
  }
}

/**
 * The names of the plan's new cron jobs on routes its image cannot call (FR-1309), which design
 * plans turned off: jobs the previous plan did not have. A job the user turned on stays on, and
 * the renderer refuses it at provision while it still cannot run.
 */
export function uncallableRouteJobs(plan: DeployPlan, previous: DeployPlan | undefined): string[] {
  const added = plan.processes.cron.filter(
    (job) =>
      job.enabled &&
      job.route !== undefined &&
      !(previous?.processes.cron ?? []).some((old) => old.route === job.route),
  );
  if (added.length === 0 || callsRoutes(plan)) return [];
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
 * Object storage for an app with an S3 client, never replacing the app's storage unasked
 * (FR-1316a): none when the interview keeps the app's own storage, or has not answered and the
 * plan has no bucket yet. Otherwise the plan's bucket when it still works there (a bucket at a
 * provider stays where it is, whatever a newer interview answered: moving it is a plan.yaml edit),
 * else the interview's choice when it is offered here, else the cheapest option that is not
 * opt-in, priced for the expected use (FR-1316). Undefined with the options when nothing fits;
 * with a line or a warning for a bucket that stays elsewhere than answered or is no longer planned.
 */
function objectStorageFor(input: StorageInput): {
  storage?: ObjectStorage;
  offers: StorageOffer[];
  line?: string;
  warning?: string;
} {
  const { facts, requirements } = input;
  const found = facts.objectStorage;
  const old = input.previous?.storage?.objectStorage;
  const s3 = requirements.keepExternalServices.s3;
  if (found === undefined || s3 === true || (s3 === undefined && old === undefined)) {
    return {
      offers: [],
      ...(found !== undefined && s3 === true && old !== undefined
        ? {
            warning: `opscrew/plan.yaml had the bucket ${old.bucket} at ${STORAGE_NAMES[old.provider]}; OpsCrew no longer plans it because the interview keeps the app's own storage. Its files stay there (destroy never deletes them). To keep using it, answer keepExternalServices.s3: false.`,
          }
        : {}),
    };
  }
  const expected =
    old !== undefined && !input.answeredLater
      ? old.expected
      : expectedStorageUse(requirements.expectedMonthlyUsers);
  const offers = storageOffers(requirements, expected);
  const asked = offers.find((offer) => offer.provider === requirements.objectStorage);
  // The plan's choice stays when it is offered here, and a provider's bucket wherever the app runs
  // (after a retarget it stays where it is).
  const keepsOld =
    old !== undefined &&
    (offers.some((offer) => offer.provider === old.provider) ||
      old.provider === "hetzner" ||
      old.provider === "digitalocean");
  const chosen = keepsOld
    ? { provider: old.provider, region: old.provider === "garage" ? "garage" : old.region }
    : (asked ?? defaultStorageOffer(offers));
  if (chosen === undefined) return { offers };
  const price = storagePrice(chosen.provider, expected);
  return {
    offers,
    ...(keepsOld && asked !== undefined && asked.provider !== old.provider
      ? {
          line: `The bucket ${old.bucket} stays at ${STORAGE_NAMES[old.provider]}, where the app's files are; to move it, set storage.objectStorage.provider in opscrew/plan.yaml and move the files yourself.`,
        }
      : {}),
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
  dragonfly: ["redis"],
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
 * - object storage for an app with an S3 client only when the interview lets OpsCrew create a
 *   bucket (FR-1316a): the interview's choice, else the cheapest option for where it runs that is
 *   not opt-in, with Garage as a service on the server when it is the choice;
 * - the previous plan's edits kept: counts, memory, versions, options, a component turned off,
 *   the web process's memory, the object storage choice;
 * - with two databases on `DATABASE_URL`, the one the app reads it for keeps it.
 */
export function designComponents(input: {
  facts: ProjectFacts;
  requirements: Requirements;
  /** The plan being replaced, whose component edits are kept. */
  previous?: DeployPlan | undefined;
  /** The inspected vCPUs of the user's own server, which decide whether Dragonfly is offered. */
  vcpus?: number | undefined;
}): DesignedComponents {
  const { facts, requirements, previous } = input;
  const lines: string[] = [];
  const warnings: string[] = [];
  const notes: Notes = { kept: [], changed: [] };
  const answeredLater =
    previous !== undefined && Date.parse(requirements.answeredAt) > Date.parse(previous.updatedAt);
  const keeps = keepsExternal(facts, requirements.keepExternalServices);
  // A Portainer target and this computer cannot run the engines that need a setting of the Docker
  // host: they stay where the app reaches them, with the line that says why.
  const portainer = requirements.provider === "portainer";
  const local = requirements.provider === "localhost";
  const settingProblem = portainer
    ? portainerHostSettingProblem
    : local
      ? localhostHostSettingProblem
      : undefined;
  const kept = (kind: ServiceKind) => {
    const runs = RUNS[kind];
    return (
      keeps(kind) ||
      (settingProblem !== undefined && runs !== undefined && settingProblem(runs) !== undefined)
    );
  };

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
  // Whether the server has the vCPUs Dragonfly needs: OpsCrew sizes a server it creates for it,
  // the user's own server has its inspected count, and a Portainer host or this computer is not
  // known. A server-less target has no server at all.
  const dragonflyFits =
    portainer || local || isServerlessProvider(requirements.provider)
      ? undefined
      : requirements.provider !== "own"
        ? true
        : input.vcpus === undefined
          ? undefined
          : input.vcpus >= DRAGONFLY_MIN_VCPUS;
  const fresh = [...freshServices(facts, kept, dragonflyFits === true), ...garage];
  const before =
    dragonflyFits === false
      ? withoutChosenDragonfly(fresh, previous?.services, input.vcpus ?? 0, notes)
      : previous?.services;
  const services = resolveVariables(
    withBullmqLocks(keepServices(fresh, before, notes), usesBullmq(facts)),
    lines,
  );
  warnings.push(...hashtagWarnings(services));
  if (dragonflyFits === false) warnings.push(...oneThreadWarnings(services, input.vcpus ?? 0));
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
  lines.push(...externalLines(facts, externalServices, settingProblem));
  if (facts.objectStorage !== undefined) {
    const text = storageText(components, storage.offers);
    const { client } = facts.objectStorage;
    if (storage.line !== undefined) lines.push(storage.line);
    if (storage.warning !== undefined) warnings.push(storage.warning);
    if (text !== undefined) lines.push(text);
    else if (requirements.keepExternalServices.s3 !== false) {
      lines.push(
        `The app keeps its files where it stores them now (S3 through ${client}), so OpsCrew plans no bucket. To let OpsCrew create one, answer keepExternalServices.s3: false in \`opscrew interview\`, which lists the options and their prices.`,
      );
    } else {
      warnings.push(
        `The app stores files through S3 (${client}), but OpsCrew offers no bucket by default where it runs. Choose Garage on the server (objectStorage: garage in \`opscrew interview\`; the files then live on that server only), put the domain on Cloudflare to use Cloudflare R2, or keep the storage the app uses now (keepExternalServices.s3: true).`,
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

/**
 * What the app keeps using where it is hosted, and why OpsCrew does not run it (with
 * `settingProblem`, a Portainer's or this computer's, also for the engines the target cannot run).
 */
function externalLines(
  facts: ProjectFacts,
  external: readonly ServiceKind[],
  settingProblem: ((kind: SelfHostedServiceKind) => string | undefined) | undefined,
): string[] {
  const lines: string[] = [];
  for (const kind of external) {
    const hosted = (facts.hostedServices ?? []).filter((h) => h.kind === kind);
    const runs = RUNS[kind];
    const problem = runs === undefined ? undefined : settingProblem?.(runs);
    if (hosted.length > 0) {
      const providers = [...new Set(hosted.map((h) => h.provider))];
      lines.push(
        `The app keeps using ${listText(providers)} for ${kind} (${listText(hosted.map((h) => h.variable))}); set its address in the app's production environment.`,
      );
    } else if (problem !== undefined) {
      lines.push(problem);
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
  // Offers are cheapest first; a tie with the first counts.
  const inEur = (price: Money) => convertMoney(price, "EUR").amount;
  const cheapest = offers[0] !== undefined && inEur(chosen.price) <= inEur(offers[0].price);
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

/**
 * The containers' memory on a server of `serverMb`, next to the edge's `edgeMb`, each with its
 * share of the server's monthly price when there is one (SC-1308): `Memory limits: the app 512 MB
 * (€1.37/month), mysql 512 MB (€1.37/month); OpsCrew's edge and the system 512 MB; 1.0 GB of 2 GB
 * free.` A plan's enabled add-ons (Beszel, Grafana Alloy) count as containers too. With `server`,
 * the line names the server (`Memory limits on server app: …`).
 */
export function memoryText(
  components: Pick<Components, "app" | "processes" | "services"> &
    Partial<Pick<DeployPlan, "observability">>,
  serverMb: number,
  edgeMb: number,
  monthly?: Money,
  server?: string,
): string {
  const shared = { label: "OpsCrew's edge and the system", mb: edgeMb + SYSTEM_RESERVE_MB };
  return limitsText(appMemoryLimits(components), shared, serverMb, monthly, server);
}

/**
 * The memory of the extra server `server` (feature 018): its (enabled) services' limits, each with
 * its share of the server's monthly price when there is one, the system's share and what stays
 * free: `Memory limits on server db: db 512 MB (€0.78/month); the system 384 MB; 3.1 GB of 4.0 GB
 * free.`
 */
export function serverMemoryText(
  server: string,
  services: readonly PlanService[],
  serverMb: number,
  monthly?: Money,
): string {
  const limits = services.map((service) => ({ name: service.name, memoryMb: service.memoryMb }));
  return limitsText(
    limits,
    { label: "the system", mb: SYSTEM_RESERVE_MB },
    serverMb,
    monthly,
    server,
  );
}

/** The memory line of a server: each limit with its share of `monthly`, `shared`, and what stays free. */
function limitsText(
  limits: readonly { name: string; memoryMb: number }[],
  shared: { label: string; mb: number },
  serverMb: number,
  monthly: Money | undefined,
  server: string | undefined,
): string {
  const share = (mb: number) =>
    monthly === undefined
      ? ""
      : ` (${formatMoney({ amount: (monthly.amount * mb) / serverMb, currency: monthly.currency })}/month)`;
  const used = limits.reduce((sum, limit) => sum + limit.memoryMb, 0);
  const free = Math.max(0, serverMb - used - shared.mb);
  const gb = (mb: number) => `${(mb / 1024).toFixed(1)} GB`;
  const where = server === undefined ? "" : ` on server ${server}`;
  return `Memory limits${where}: ${limits.map((l) => `${l.name} ${l.memoryMb} MB${share(l.memoryMb)}`).join(", ")}; ${shared.label} ${shared.mb} MB; ${gb(free)} of ${gb(serverMb)} free.`;
}
