/**
 * Backing-service detection from dependencies, configuration and environment-variable names.
 * Evidence strings look like `dependency:pg`, `devDependency:prisma`, `prisma:postgresql`,
 * `config:django.db.backends.postgresql` or `env:DATABASE_URL`.
 */
import type { ServiceKind } from "@opscrew/plan-schema";
import type { Dependency, DependencyEcosystem, Unit } from "./manifests";
import { sortStrings } from "./paths";

/** A detected service with sorted, unique evidence. */
export interface DetectedService {
  kind: ServiceKind;
  evidence: string[];
}

const DEPENDENCY_SERVICES: Record<
  Exclude<DependencyEcosystem, "composer">,
  Record<string, ServiceKind[]>
> = {
  npm: {
    pg: ["postgres"],
    postgres: ["postgres"],
    "@neondatabase/serverless": ["postgres"],
    "@vercel/postgres": ["postgres"],
    mysql: ["mysql"],
    mysql2: ["mysql"],
    mongoose: ["mongodb"],
    mongodb: ["mongodb"],
    redis: ["redis"],
    ioredis: ["redis"],
    "@upstash/redis": ["redis"],
    "redis-om": ["redis"],
    bullmq: ["queue", "redis"],
    bull: ["queue", "redis"],
    "bee-queue": ["queue", "redis"],
    agenda: ["queue", "mongodb"],
    "@temporalio/worker": ["queue"],
    "better-sqlite3": ["sqlite"],
    sqlite3: ["sqlite"],
    "@supabase/supabase-js": ["supabase"],
    "@supabase/ssr": ["supabase"],
    firebase: ["firebase"],
    "firebase-admin": ["firebase"],
    "@aws-sdk/client-s3": ["s3"],
    stripe: ["stripe"],
    nodemailer: ["email"],
    resend: ["email"],
    "@sendgrid/mail": ["email"],
    postmark: ["email"],
    "socket.io": ["websocket"],
    ws: ["websocket"],
    "node-cron": ["cron"],
    cron: ["cron"],
  },
  pypi: {
    psycopg: ["postgres"],
    "psycopg-binary": ["postgres"],
    psycopg2: ["postgres"],
    "psycopg2-binary": ["postgres"],
    asyncpg: ["postgres"],
    pymysql: ["mysql"],
    mysqlclient: ["mysql"],
    pymongo: ["mongodb"],
    motor: ["mongodb"],
    redis: ["redis"],
    "flask-redis": ["redis"],
    "django-redis": ["redis"],
    "redis-om": ["redis"],
    rq: ["queue", "redis"],
    celery: ["queue"],
    dramatiq: ["queue"],
    huey: ["queue"],
    arq: ["queue", "redis"],
    supabase: ["supabase"],
    "firebase-admin": ["firebase"],
    boto3: ["s3"],
    stripe: ["stripe"],
    websockets: ["websocket"],
    apscheduler: ["cron"],
  },
  gem: {
    pg: ["postgres"],
    mysql2: ["mysql"],
    redis: ["redis"],
    sidekiq: ["queue", "redis"],
    sqlite3: ["sqlite"],
    stripe: ["stripe"],
  },
};

const PRISMA_PROVIDERS: Record<string, ServiceKind> = {
  postgresql: "postgres",
  postgres: "postgres",
  cockroachdb: "postgres",
  mysql: "mysql",
  sqlite: "sqlite",
  mongodb: "mongodb",
};

const DJANGO_ENGINES: Record<string, ServiceKind> = {
  postgresql: "postgres",
  postgresql_psycopg2: "postgres",
  mysql: "mysql",
  sqlite3: "sqlite",
};

/** Accumulates evidence per service kind. */
export class ServiceCollector {
  private readonly byKind = new Map<ServiceKind, Set<string>>();

  add(kind: ServiceKind, evidence: string): void {
    const set = this.byKind.get(kind) ?? new Set<string>();
    set.add(evidence);
    this.byKind.set(kind, set);
  }

  has(kind: ServiceKind): boolean {
    return this.byKind.has(kind);
  }

  /** Services sorted by kind, each with sorted evidence. */
  toList(): DetectedService[] {
    return sortStrings(this.byKind.keys()).map((kind) => ({
      kind: kind as ServiceKind,
      evidence: sortStrings(this.byKind.get(kind as ServiceKind) ?? []),
    }));
  }
}

function dependencyEvidence(dep: Dependency): string {
  return `${dep.dev ? "devDependency" : "dependency"}:${dep.name}`;
}

/**
 * Adds services implied by a unit's dependencies. ORMs (Prisma, Drizzle, TypeORM, Sequelize) are
 * covered by their database driver or schema; SQLAlchemy counts as Postgres only when a
 * `postgres://` URL appears in Python code, and Celery adds Redis only for a Redis broker:
 * `celery[redis]`, a `redis://` URL in Python code or committed env/compose files
 * (`configUrlSchemes`), or a Redis service in a committed compose file (`composeRedis`).
 */
export function addDependencyServices(
  collector: ServiceCollector,
  unit: Unit,
  context: {
    pythonUrlSchemes: ReadonlySet<string>;
    configUrlSchemes?: ReadonlySet<string>;
    composeRedis?: boolean;
  },
): void {
  for (const dep of unit.dependencies) {
    if (dep.ecosystem === "composer") continue;
    const evidence = dependencyEvidence(dep);
    for (const kind of DEPENDENCY_SERVICES[dep.ecosystem][dep.name] ?? []) {
      collector.add(kind, evidence);
    }
    if (dep.ecosystem === "pypi" && dep.name === "celery") {
      if (dep.extras.includes("redis")) collector.add("redis", `${evidence}[redis]`);
      else if (context.pythonUrlSchemes.has("redis") || context.configUrlSchemes?.has("redis")) {
        collector.add("redis", "config:redis-broker");
      } else if (context.composeRedis) collector.add("redis", "compose:redis");
    }
    if (
      dep.ecosystem === "pypi" &&
      dep.name === "sqlalchemy" &&
      context.pythonUrlSchemes.has("postgres")
    ) {
      collector.add("postgres", evidence);
    }
  }
}

/**
 * Adds the datasource provider of a Prisma schema (`prisma:postgresql`), plus the Prisma client
 * dependency of the given units as evidence for the same service.
 */
export function addPrismaServices(
  collector: ServiceCollector,
  schemaText: string,
  units: readonly Unit[],
): void {
  const provider = /datasource\s+\w+\s*\{[^}]*?\bprovider\s*=\s*"(\w+)"/s.exec(schemaText)?.[1];
  const kind = provider ? PRISMA_PROVIDERS[provider] : undefined;
  if (!provider || !kind) return;
  collector.add(kind, `prisma:${provider}`);
  for (const unit of units) {
    for (const dep of unit.dependencies) {
      if (dep.ecosystem === "npm" && dep.name === "@prisma/client") {
        collector.add(kind, dependencyEvidence(dep));
      }
    }
  }
}

/** Adds database engines named in Django settings (`config:django.db.backends.postgresql`). */
export function addDjangoServices(collector: ServiceCollector, settingsText: string): void {
  for (const match of settingsText.matchAll(/["']django\.db\.backends\.(\w+)["']/g)) {
    const engine = match[1] ?? "";
    const kind = DJANGO_ENGINES[engine];
    if (kind) collector.add(kind, `config:django.db.backends.${engine}`);
  }
}

/**
 * Adds services implied by environment-variable names: `POSTGRES_*` → postgres, `REDIS_URL` →
 * redis, and `DATABASE_URL` → postgres unless another database (MySQL, SQLite, MongoDB) was
 * already detected without Postgres.
 */
export function addEnvServices(collector: ServiceCollector, envNames: Iterable<string>): void {
  const names = sortStrings(envNames);
  const otherDatabase =
    !collector.has("postgres") &&
    (collector.has("mysql") || collector.has("sqlite") || collector.has("mongodb"));
  for (const name of names) {
    if (name.startsWith("POSTGRES_")) collector.add("postgres", `env:${name}`);
    if (name === "DATABASE_URL" && !otherDatabase) collector.add("postgres", `env:${name}`);
    if (name === "REDIS_URL") collector.add("redis", `env:${name}`);
  }
}
