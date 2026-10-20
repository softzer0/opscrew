import { randomBytes } from "node:crypto";
import { OpsCrewError } from "@opscrew/core";
import {
  appRoot,
  appVariables,
  type GeneratedSecret,
  isClientExposedEnvName,
  serviceSpec,
  siteHosts,
} from "@opscrew/iac-templates";
import {
  type DeployPlan,
  type PlanService,
  REDIS_PROTOCOL_KINDS,
  type SelfHostedServiceKind,
  serviceOf,
} from "@opscrew/plan-schema";
import { randomPassword } from "./ssh-keys";

/** Parses a dotenv file (quotes, `export` prefixes, `#` comments, escaped newlines). */
export function parseDotenv(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const raw of text.replace(/^﻿/, "").split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const name = match[1] as string;
    let value = (match[2] as string).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1).replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    } else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "");
    }
    values.set(name, value);
  }
  return values;
}

/** One `NAME=value` line for a Docker Compose env_file, quoted so Compose reads it literally. */
export function dotenvLine(name: string, value: string): string {
  if (/^[A-Za-z0-9_.,:/@+=-]*$/.test(value)) return `${name}=${value}`;
  if (!value.includes("'") && !value.includes("\n")) return `${name}='${value}'`;
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\$/g, "$$$$");
  return `${name}="${escaped}"`;
}

export type EnvAnswer = { useLocal: true } | { value: string } | { skip: true };

export interface EnvQuestion {
  name: string;
  secret: boolean;
  /** True when the local `.env` has a value the user may reuse for production. */
  localValueAvailable: boolean;
  /**
   * True when the app's code has a default for the variable: leaving it unset (an empty answer)
   * keeps that default. Always set by {@link assembleAppEnv}.
   */
  optional?: boolean;
}

/** What a host-list variable holds: host names or origins (`https://<host>`). */
export type HostListKind = "hosts" | "origins";

/**
 * The host list a variable holds, from its name: `ALLOWED_HOSTS` and `*_ALLOWED_HOSTS` hold host
 * names, `CSRF_TRUSTED_ORIGINS` and `*_CSRF_TRUSTED_ORIGINS` origins. Undefined for any other name.
 * `design` plans these as `derived`, and {@link assembleAppEnv} fills them from the deployment.
 */
export function hostListKind(name: string): HostListKind | undefined {
  if (/^(?:\w+_)?ALLOWED_HOSTS$/.test(name)) return "hosts";
  if (/^(?:\w+_)?CSRF_TRUSTED_ORIGINS$/.test(name)) return "origins";
  return undefined;
}

/**
 * Production settings for frameworks that otherwise start in development, by framework name
 * (`facts.frameworks`): `fixed` settings, which `design` plans as `derived`, and the keys the app
 * signs or encrypts with, which it plans as `generated`, each with its format. A value the user
 * sets in the production env file wins (see {@link assembleAppEnv}).
 */
export const FRAMEWORK_ENV: Readonly<
  Record<
    string,
    {
      fixed: Readonly<Record<string, string>>;
      generated: Readonly<Record<string, () => string>>;
    }
  >
> = {
  rails: {
    fixed: { RAILS_ENV: "production" },
    generated: { SECRET_KEY_BASE: () => randomBytes(64).toString("hex") },
  },
  laravel: {
    fixed: { APP_ENV: "production", APP_DEBUG: "false", LOG_CHANNEL: "stderr" },
    // `php artisan key:generate`'s format for the default cipher, AES-256-CBC.
    generated: { APP_KEY: () => `base64:${randomBytes(32).toString("base64")}` },
  },
};

const FIXED_VALUES = new Map(Object.values(FRAMEWORK_ENV).flatMap((f) => Object.entries(f.fixed)));
const GENERATORS = new Map(
  Object.values(FRAMEWORK_ENV).flatMap((f) => Object.entries(f.generated)),
);

/** The fixed production value of a {@link FRAMEWORK_ENV} setting (`RAILS_ENV`), else undefined. */
export function fixedProductionValue(name: string): string | undefined {
  return FIXED_VALUES.get(name);
}

/** A service OpsCrew runs next to the app, whose connection URL a variable can hold. */
export type ServiceUrlKind = "postgres" | "redis";

/** The services OpsCrew runs for each kind of URL: Postgres, and Valkey, Redis 8 or Dragonfly. */
const URL_SERVICE_KINDS: Readonly<Record<ServiceUrlKind, readonly SelfHostedServiceKind[]>> = {
  postgres: ["postgres"],
  redis: REDIS_PROTOCOL_KINDS,
};

/**
 * The running service whose address a {@link serviceUrlKind} variable holds, in a plan or design's
 * components: Postgres, or for Redis the queue of Valkey, Redis 8 or Dragonfly, else the first of
 * them that runs.
 */
export function urlService(
  owner: { readonly services: readonly PlanService[] },
  kind: ServiceUrlKind,
): PlanService | undefined {
  const running = owner.services.filter(
    (s) => s.enabled && URL_SERVICE_KINDS[kind].includes(s.kind),
  );
  return running.find((s) => "mode" in s.options && s.options.mode === "queue") ?? running[0];
}

const POSTGRES_URL_NAME =
  /^(?:DATABASE_URL|DATABASE_URI|SQLALCHEMY_DATABASE_URI|POSTGRES_UR[LI]|DB_UR[LI])$/;
const REDIS_URL_NAME = /^(?:REDIS_UR[LI]|CELERY_BROKER_UR[LI]|BROKER_URL|CELERY_RESULT_BACKEND)$/;
/** `<prefix>_DATABASE_URL`/`_URI` and `<prefix>_REDIS_URL`/`_URI`; the capture is the prefix. */
const PREFIXED_URL_NAME = /^(\w+?)_(DATABASE|REDIS)_UR[LI]$/;
/**
 * Prefix segments that mark another database engine or a database that is not production's
 * (tests, Prisma's shadow database, local development): such names are never derived.
 */
const OTHER_DATABASE_SEGMENTS = new Set([
  "MONGO",
  "MONGODB",
  "MYSQL",
  "MARIADB",
  "SQLITE",
  "CLICKHOUSE",
  "MSSQL",
  "SQLSERVER",
  "ORACLE",
  "COCKROACH",
  "COCKROACHDB",
  "TIMESCALE",
  "NEO4J",
  "CASSANDRA",
  "LIBSQL",
  "TURSO",
  "PLANETSCALE",
  "REDIS",
  "ELASTIC",
  "ELASTICSEARCH",
  "TEST",
  "TESTS",
  "TESTING",
  "SHADOW",
  "DEV",
  "DEVELOPMENT",
  "LOCAL",
  "E2E",
  "CI",
  "STAGING",
]);

/**
 * The service whose connection URL a variable holds, from its name, for the aliases an app reads
 * besides the names the catalog gives (`DATABASE_URL`, `REDIS_URL`) and the variable detection
 * found (`services[].variable`): `DATABASE_URI`, `SQLALCHEMY_DATABASE_URI`, `POSTGRES_URL`,
 * `DB_URL` and `*_DATABASE_URL`/`_URI` hold Postgres; `REDIS_URI`, `*_REDIS_URL`/`_URI`, Celery's
 * broker and result backend hold Redis. Undefined for any other name, for names bundlers expose to
 * browsers (`NEXT_PUBLIC_DATABASE_URL`) and for prefixes naming another engine or a non-production
 * database (`MONGO_DATABASE_URL`, `TEST_DATABASE_URL`). `design` plans these as `derived` when the
 * service runs on the server, and {@link assembleAppEnv} fills them in.
 */
export function serviceUrlKind(name: string): ServiceUrlKind | undefined {
  if (isClientExposedEnvName(name)) return undefined;
  if (POSTGRES_URL_NAME.test(name)) return "postgres";
  if (REDIS_URL_NAME.test(name)) return "redis";
  const prefixed = PREFIXED_URL_NAME.exec(name);
  if (!prefixed) return undefined;
  const segments = (prefixed[1] ?? "").split("_");
  if (segments.some((segment) => OTHER_DATABASE_SEGMENTS.has(segment))) return undefined;
  return prefixed[2] === "DATABASE" ? "postgres" : "redis";
}

/**
 * The app's variables each running service gives it, from the catalog (`appVariables`, FR-1314):
 * the conventional names and the service's own `variable`. A name one service has as its
 * `variable` comes only from that one (the database whose variable is `DATABASE_URL` keeps it);
 * a name two services give otherwise comes from the first. Client-exposed names are never filled.
 * Each secret is what `secret` returns for the service and the secret's name.
 */
export function serviceAppVariables(
  plan: DeployPlan,
  secret: (service: PlanService, name: string) => string,
): Map<string, string> {
  const running = plan.services.filter((service) => service.enabled);
  const own = new Set(running.flatMap((s) => (s.variable === undefined ? [] : [s.variable])));
  const values = new Map<string, string>();
  for (const service of running) {
    const variables = appVariables({
      plan,
      service,
      secretRef: (name) => secret(service, name),
      ...(service.variable === undefined ? {} : { variable: service.variable }),
    });
    for (const [name, value] of Object.entries(variables)) {
      if (values.has(name) || isClientExposedEnvName(name)) continue;
      if (own.has(name) && service.variable !== name) continue;
      values.set(name, value);
    }
  }
  return values;
}

/** What an object storage variable holds, from its name. */
export type StorageVariableKind = "key" | "bucket" | "region" | "endpoint" | "path-style";

/** The S3 keys every SDK reads, and the region and endpoint names besides the app's own. */
const STORAGE_KEYS = new Set(["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"]);
/** The object storage variables every plan with a bucket gives the app, the keys included. */
export const STORAGE_VARIABLES: ReadonlySet<string> = new Set([
  ...STORAGE_KEYS,
  "AWS_REGION",
  "AWS_ENDPOINT_URL_S3",
]);
const STORAGE_REGIONS = new Set(["AWS_REGION", "AWS_DEFAULT_REGION"]);
/** The variables an S3 client reads, as detection names them (`S3_BUCKET`, `AWS_S3_ENDPOINT_URL`). */
const BUCKET_VARIABLE = /(?:^|_)BUCKET(?:_NAME)?$/;
const ENDPOINT_VARIABLE = /(?:^|_)ENDPOINT(?:_URL)?(?:_S3)?$/;

/**
 * What an object storage variable holds (plan.md "6."): the keys, the bucket, the region, the
 * endpoint (`AWS_ENDPOINT_URL_S3` and the app's own name for it) or Laravel's path-style switch.
 */
export function storageVariableKind(name: string): StorageVariableKind | undefined {
  if (STORAGE_KEYS.has(name)) return "key";
  if (STORAGE_REGIONS.has(name)) return "region";
  if (name === "AWS_USE_PATH_STYLE_ENDPOINT") return "path-style";
  if (BUCKET_VARIABLE.test(name)) return "bucket";
  if (ENDPOINT_VARIABLE.test(name)) return "endpoint";
  return undefined;
}

/** The S3 endpoints of the providers whose endpoint the plan alone gives (R2's needs the account). */
export const STORAGE_ENDPOINTS: Readonly<Record<string, (region: string) => string>> = {
  hetzner: (region) => `https://${region}.your-objectstorage.com`,
  digitalocean: (region) => `https://${region}.digitaloceanspaces.com`,
};

/**
 * The user's key for a provider's bucket (Spaces, Hetzner, or an R2 token's S3 keys) and, for R2,
 * the endpoint, which names the user's Cloudflare account. Provision keeps it like a provider
 * token; it is never logged.
 */
export interface StorageLogin {
  accessKeyId: string;
  secretAccessKey: string;
  /** R2's `https://<account>.r2.cloudflarestorage.com`; the other providers' come from the plan. */
  endpoint?: string;
}

/**
 * The value of a derived object storage variable from the plan's bucket and the user's `login`,
 * or undefined: Garage's keys come from its catalog entry, and without `login` a provider's keys
 * and R2's endpoint are not known.
 */
function storageValue(
  name: string,
  plan: DeployPlan,
  login: StorageLogin | undefined,
): string | undefined {
  const storage = plan.storage?.objectStorage;
  if (storage === undefined) return undefined;
  switch (storageVariableKind(name)) {
    case "bucket":
      return storage.bucket;
    case "region":
      return storage.region;
    case "path-style":
      return "true";
    case "endpoint":
      return STORAGE_ENDPOINTS[storage.provider]?.(storage.region) ?? login?.endpoint;
    case "key":
      return name === "AWS_ACCESS_KEY_ID" ? login?.accessKeyId : login?.secretAccessKey;
    default:
      return undefined;
  }
}

/**
 * The file of a SQLite database moved into a folder of its own (`storage.sqlite.dir`), by the
 * variable that points the app at it: Laravel's `DB_DATABASE`, Prisma's `DATABASE_URL`.
 */
const MOVED_SQLITE: Readonly<Record<string, (path: string) => string>> = {
  DB_DATABASE: (folder) => `${folder}/database.sqlite`,
  DATABASE_URL: (folder) => `file:${folder}/app.db`,
};

/**
 * The value of the variable that points the app at its SQLite database in a folder of its own,
 * in the image (`<appRoot>/<dir>/<file>`, see `appRoot`): `/app/storage/database/database.sqlite`
 * for Laravel's `DB_DATABASE`, `file:/app/data/app.db` for Prisma's `DATABASE_URL`. Undefined for
 * any other variable, without SQLite, or when the image's layout is unknown.
 */
export function sqliteVariableValue(name: string, plan: DeployPlan): string | undefined {
  const dir = plan.storage?.sqlite?.dir;
  const root = appRoot(plan);
  const value = MOVED_SQLITE[name];
  if (dir === undefined || root === undefined || value === undefined) return undefined;
  return value(`${root}/${dir}`);
}

/**
 * The app's variables OpsCrew fills from what runs (FR-1314): the services' (catalog names and
 * own variables), the aliases of a running Postgres or Valkey, the object storage's, and
 * `CRON_SECRET` for the cron jobs that call the app's routes.
 */
export function serviceFilledNames(plan: DeployPlan): Set<string> {
  const names = new Set(serviceAppVariables(plan, () => "").keys());
  if (plan.processes.cron.some((job) => job.enabled && job.route !== undefined)) {
    names.add("CRON_SECRET");
  }
  const storage = plan.storage?.objectStorage !== undefined;
  for (const variable of plan.app.env) {
    const { name } = variable;
    // Only what OpsCrew planned as its own: a user's variable that merely looks like one stays.
    if (storage && STORAGE_VARIABLES.has(name)) names.add(name);
    if (variable.source !== "derived") continue;
    const alias = serviceUrlKind(name);
    if (alias !== undefined && urlService(plan, alias) !== undefined) names.add(name);
    if (storage && storageVariableKind(name) !== undefined) names.add(name);
    if (sqliteVariableValue(name, plan) !== undefined) names.add(name);
  }
  return names;
}

/**
 * The value of a host list: the hosts the plan serves (the domain, and `www.<domain>` when
 * planned), or without a domain the server's address. Comma-separated; origins use `https://` on
 * a domain and `http://` on the bare address (it has no certificate). Undefined when neither is
 * known.
 */
function hostListValue(
  kind: HostListKind,
  plan: DeployPlan,
  serverHost: string | undefined,
): string | undefined {
  const hosts = siteHosts(plan);
  if (hosts.length > 0) {
    return (kind === "hosts" ? hosts : hosts.map((host) => `https://${host}`)).join(",");
  }
  if (serverHost === undefined || serverHost === "") return undefined;
  return kind === "hosts" ? serverHost : `http://${serverHost}`;
}

export interface AssembleAppEnvOptions {
  plan: DeployPlan;
  /** Contents of the local `.env` (interactive) or of `OPSCREW_APP_ENV_FILE` (non-interactive). */
  dotenvText?: string;
  /** Interactive prompt; when absent, values come from `dotenvText` only. */
  ask?: (question: EnvQuestion) => Promise<EnvAnswer>;
  /**
   * Makes every value this run generates, in place of the database password and the formats of
   * {@link FRAMEWORK_ENV} (tests, and drift's marker for a value it cannot know).
   */
  password?: () => string;
  /**
   * The server's public address from OpsCrew's local state (`.opscrew/server.json`), used for
   * host lists when the plan has no domain. It only ever goes into the assembled environment (the
   * deploy secrets), never into the plan, a committed file, a log or an error message.
   */
  serverHost?: string;
  /**
   * Values generated by an earlier run (see {@link AppEnvironment.generated}). Reused so a re-run
   * keeps the database password Postgres was initialised with and keeps app secrets stable.
   */
  previous?: GeneratedValues;
  /** The user's key for the plan's provider bucket, and R2's endpoint (see {@link StorageLogin}). */
  storage?: StorageLogin;
}

/** Generated values to keep between runs (stored privately, never committed or logged). */
export interface GeneratedValues {
  /** Postgres's password. */
  dbPassword?: string;
  /** Generated app variables by name. */
  env?: Record<string, string>;
  /** The other services' generated secrets, by service name and the catalog's secret name. */
  services?: Record<string, Record<string, string>>;
}

export interface AppEnvironment {
  /** Contents of the `OPSCREW_APP_ENV` secret (Compose env_file for the app). */
  appEnv: string;
  /**
   * Contents of `OPSCREW_BUILD_ENV`: the client-exposed values the plan does not mark secret,
   * passed to the build as build arguments (baked into the image).
   */
  buildEnv: string;
  /**
   * Contents of `OPSCREW_BUILD_SECRETS`: the client-exposed values the plan marks secret (the
   * Dockerfile's rule), which reach the build only as BuildKit secret mounts.
   */
  buildSecrets: string;
  /** Variable names set (never values), for display and audit. */
  names: string[];
  /** Optional variables left unset: the app uses the default in its code. */
  defaulted: string[];
  /**
   * Host-list variables left unset because the plan has no domain and the server's address was
   * not given: the next run that knows the address fills them in.
   */
  unresolved: string[];
  /** Everything this run generated or reused, to pass as `previous` next time. */
  generated: GeneratedValues;
  /**
   * The same values by name, exactly as set (no env-file quoting), for a target that takes them one
   * by one, such as a Portainer stack's environment: `app` holds what {@link appEnv} holds, `build`
   * what {@link buildEnv} and {@link buildSecrets} hold, `db` Postgres's login. Never logged.
   */
  values: {
    app: Record<string, string>;
    build: Record<string, string>;
    db?: { user: string; name: string; password: string };
    /**
     * Each running service's secrets (Postgres's too) by service name and the catalog's secret
     * name, for the service's own environment (`environment(ctx)`).
     */
    services: Record<string, Record<string, string>>;
  };
}

/** A new secret in the catalog's format: 32 random bytes as hex, or a Garage key ID. */
function newSecret(format: GeneratedSecret["format"]): string {
  return format === "garage-key-id"
    ? `GK${randomBytes(12).toString("hex")}`
    : randomBytes(32).toString("hex");
}

/**
 * Builds the production environment for the deploy secrets. Values the app needs come from the
 * user (local `.env` only after confirmation, or typed in), are generated (database password, app
 * keys in the format {@link FRAMEWORK_ENV} gives) or derived (DATABASE_URL, REDIS_URL and the app's
 * own names for them pointing at the containers, see {@link serviceUrlKind}; host lists from the
 * domain or the server's address; the fixed settings of {@link FRAMEWORK_ENV}). A generated value
 * or fixed setting the env file of a non-interactive run sets wins, and is not stored as generated.
 * An optional variable (the code has a default) without a value is left unset instead of stopping
 * the run. Values are never logged.
 * @throws OpsCrewError `INVALID_INPUT` when a required value is missing in a non-interactive run.
 */
export async function assembleAppEnv(options: AssembleAppEnvOptions): Promise<AppEnvironment> {
  const { plan } = options;
  const local = parseDotenv(options.dotenvText ?? "");
  const app = new Map<string, string>();
  const build = new Map<string, string>();
  const buildSecrets = new Map<string, string>();
  const missing: string[] = [];
  const defaulted: string[] = [];
  const unresolved: string[] = [];
  const newPassword = options.password ?? randomPassword;
  const generatedEnv: Record<string, string> = {};
  const generated: GeneratedValues = { env: generatedEnv };

  // Each running service's secrets: generated once, then kept (Postgres's as `dbPassword`).
  const secrets: Record<string, Record<string, string>> = {};
  const secret = (service: PlanService, name: string): string => {
    const known = secrets[service.name]?.[name];
    if (known !== undefined) return known;
    let value: string;
    if (service.kind === "postgres" && name === "password") {
      value = options.previous?.dbPassword ?? newPassword();
      generated.dbPassword = value;
    } else {
      const format = serviceSpec(service.kind).secrets.find((s) => s.name === name)?.format;
      value =
        options.previous?.services?.[service.name]?.[name] ??
        options.password?.() ??
        newSecret(format ?? "hex32");
      generated.services ??= {};
      generated.services[service.name] = { ...generated.services[service.name], [name]: value };
    }
    secrets[service.name] = { ...secrets[service.name], [name]: value };
    return value;
  };
  for (const service of plan.services.filter((s) => s.enabled)) {
    for (const { name } of serviceSpec(service.kind).secrets) secret(service, name);
  }
  const postgres = serviceOf(plan, "postgres");
  const db =
    postgres === undefined
      ? undefined
      : { user: "app", name: "app", password: secret(postgres, "password") };
  for (const [name, value] of serviceAppVariables(plan, secret)) app.set(name, value);

  for (const variable of plan.app.env) {
    if (app.has(variable.name) || variable.name === "PORT") continue;
    const optional = variable.optional === true;
    const derived = variable.source === "derived";
    const hostList = derived ? hostListKind(variable.name) : undefined;
    const alias = derived ? serviceUrlKind(variable.name) : undefined;
    const aliased = alias === undefined ? undefined : urlService(plan, alias);
    const serviceUrl =
      aliased === undefined
        ? derived
          ? (storageValue(variable.name, plan, options.storage) ??
            sqliteVariableValue(variable.name, plan))
          : undefined
        : serviceSpec(aliased.kind).address({
            plan,
            service: aliased,
            secretRef: (name) => secret(aliased, name),
          });
    const fixed = derived ? FIXED_VALUES.get(variable.name) : undefined;
    // The file of a non-interactive run holds production values; the local `.env` of an
    // interactive run holds development ones (`APP_ENV=local`), so it never overrides a default.
    const userValue = options.ask ? undefined : local.get(variable.name);
    let value: string | undefined;
    if (serviceUrl !== undefined) {
      value = serviceUrl;
    } else if (hostList !== undefined) {
      value = hostListValue(hostList, plan, options.serverHost);
      if (value === undefined) {
        unresolved.push(variable.name);
        continue;
      }
    } else if (fixed !== undefined) {
      value = userValue ?? fixed;
    } else if (variable.source === "generated") {
      // An injected source wins, so a caller that cannot know new values (drift) sees its marker.
      const generate = options.password ?? GENERATORS.get(variable.name) ?? randomPassword;
      value = userValue ?? options.previous?.env?.[variable.name] ?? generate();
      if (userValue === undefined) generatedEnv[variable.name] = value;
    } else if (options.ask) {
      const answer = await options.ask({
        name: variable.name,
        secret: variable.secret,
        localValueAvailable: local.has(variable.name),
        optional,
      });
      if ("useLocal" in answer) value = local.get(variable.name);
      else if ("value" in answer) value = answer.value;
    } else {
      value = local.get(variable.name);
    }
    if (value === undefined) {
      (optional ? defaulted : missing).push(variable.name);
      continue;
    }
    if (isClientExposedEnvName(variable.name)) {
      if (/[\r\n]/.test(value)) {
        throw new OpsCrewError("INVALID_INPUT", `${variable.name} must be a single line.`);
      }
      (variable.secret ? buildSecrets : build).set(variable.name, value);
    } else {
      app.set(variable.name, value);
    }
  }

  if (missing.length > 0 && !options.ask) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `Production values are missing for: ${missing.join(", ")}.`,
      {
        hint: "Add them to the file in OPSCREW_APP_ENV_FILE, or run `opscrew provision` in a terminal to type them in.",
      },
    );
  }

  const sortedLines = (values: Map<string, string>, format: (n: string, v: string) => string) =>
    [...values.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([n, v]) => format(n, v));
  const buildLines = (values: Map<string, string>) =>
    `${sortedLines(values, (n, v) => `${n}=${v}`).join("\n")}\n`;
  const allBuild = [...build.entries(), ...buildSecrets.entries()];
  return {
    appEnv: `${sortedLines(app, dotenvLine).join("\n")}\n`,
    buildEnv: buildLines(build),
    buildSecrets: buildLines(buildSecrets),
    names: [...new Set([...app.keys(), ...allBuild.map(([name]) => name)])].sort(),
    defaulted,
    unresolved,
    generated,
    values: {
      app: Object.fromEntries([...app.entries()].sort(([a], [b]) => a.localeCompare(b))),
      build: Object.fromEntries(allBuild.sort(([a], [b]) => a.localeCompare(b))),
      ...(db !== undefined ? { db } : {}),
      services: secrets,
    },
  };
}
