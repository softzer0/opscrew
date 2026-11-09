import { randomBytes } from "node:crypto";
import { OpsCrewError } from "@opscrew/core";
import {
  appRoot,
  appVariables,
  type DatabaseSettings,
  type GeneratedSecret,
  isClientExposedEnvName,
  PREVIOUS_VALUES,
  type PreviewSecretFormat,
  previewSecret,
  previousValueVariables,
  serviceSpec,
  siteHosts,
  splitDatabaseSettings,
} from "@opscrew/iac-templates";
import {
  type DeployPlan,
  type HostListKind,
  hostListKind,
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
  /** The environment the value is for: `prod`, or another environment's name. */
  environment: string;
  /** The local file values are offered from: `.env` for prod, `.env.<env>` for another. */
  localFile: string;
  /** True when {@link localFile} has a value the user may reuse for the environment. */
  localValueAvailable: boolean;
  /**
   * True when the app's code has a default for the variable: leaving it unset (an empty answer)
   * keeps that default. Always set by {@link assembleAppEnv}.
   */
  optional?: boolean;
}

// The host lists (`design` plans them as `derived`, `assembleAppEnv` fills them), from plan-schema,
// where the deploy job's masking file reads the same names.
export { type HostListKind, hostListKind } from "@opscrew/plan-schema";

/**
 * True for a variable that holds the app's own address, which `design` plans as `derived` and
 * {@link assembleAppEnv} fills from the deployment: the host lists and `APP_URL` (FR-1338). They
 * hold no secret.
 */
export function addressVariable(name: string): boolean {
  return hostListKind(name) !== undefined || name === "APP_URL";
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
      generated: Readonly<Record<string, PreviewSecretFormat>>;
    }
  >
> = {
  rails: { fixed: { RAILS_ENV: "production" }, generated: { SECRET_KEY_BASE: "hex64" } },
  laravel: {
    fixed: { APP_ENV: "production", APP_DEBUG: "false", LOG_CHANNEL: "stderr" },
    // `php artisan key:generate`'s format for the default cipher, AES-256-CBC.
    generated: { APP_KEY: "b64k32" },
  },
};

const FIXED_VALUES = new Map(Object.values(FRAMEWORK_ENV).flatMap((f) => Object.entries(f.fixed)));
const GENERATED_FORMATS = new Map(
  Object.values(FRAMEWORK_ENV).flatMap((f) => Object.entries(f.generated)),
);

/**
 * A new random value in `format`, as a preview server makes one: 32 or 64 random bytes as hex,
 * `base64:` and 32 random bytes in base64 (Laravel's key), or `GK` and 12 random bytes as hex.
 */
function randomValue(format: PreviewSecretFormat): string {
  switch (format) {
    case "hex32":
      return randomBytes(32).toString("hex");
    case "hex64":
      return randomBytes(64).toString("hex");
    case "b64k32":
      return `base64:${randomBytes(32).toString("base64")}`;
    case "gk":
      return `GK${randomBytes(12).toString("hex")}`;
  }
}

/** A catalog secret's format as a value's format: a Garage key id, or 32 random bytes as hex. */
function secretFormat(format: GeneratedSecret["format"] | undefined): PreviewSecretFormat {
  return format === "garage-key-id" ? "gk" : "hex32";
}

/**
 * A new value of a service's secret in the catalog's `format`: `GK` and 12 random bytes as hex (a
 * Garage key id), else 32 random bytes as hex.
 */
export function newSecretValue(format: GeneratedSecret["format"] | undefined): string {
  return randomValue(secretFormat(format));
}

/**
 * A new value for the generated app variable `name`: in its {@link FRAMEWORK_ENV} format (Laravel's
 * `APP_KEY`), else a random password, as {@link assembleAppEnv} makes one.
 */
export function newGeneratedValue(name: string): string {
  const format = GENERATED_FORMATS.get(name);
  return format === undefined ? randomPassword() : randomValue(format);
}

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
 * The names an app reads a SQL database's settings by one by one, and the setting each holds
 * (FR-1337).
 */
const SPLIT_SETTINGS: Readonly<Record<string, keyof DatabaseSettings>> = {
  DB_HOST: "host",
  DB_PORT: "port",
  DB_DATABASE: "database",
  DB_NAME: "database",
  DB_USERNAME: "user",
  DB_USER: "user",
  DB_PASSWORD: "password",
  DB_PASS: "password",
};

/**
 * True for a split setting that holds no secret: a SQL database's host, port, database or user,
 * or Redis's host or port (their passwords are secrets).
 */
export function publicSplitSetting(name: string): boolean {
  const setting = SPLIT_SETTINGS[name];
  return (setting !== undefined && setting !== "password") || /^REDIS_(?:HOST|PORT)$/.test(name);
}

/** The running SQL databases (PostgreSQL, MySQL, MariaDB) of `owner`, a plan or components. */
export function sqlDatabases(owner: { readonly services: readonly PlanService[] }): PlanService[] {
  return owner.services.filter(
    (s) => s.enabled && serviceSpec(s.kind).databaseSettings !== undefined,
  );
}

/**
 * The running SQL database whose settings an app reading `DB_HOST` receives: the one that has
 * `DATABASE_URL` as its variable, else the first ({@link sqlDatabases}).
 */
export function splitDatabase(owner: {
  readonly services: readonly PlanService[];
}): PlanService | undefined {
  const sql = sqlDatabases(owner);
  return sql.find((s) => s.variable === "DATABASE_URL") ?? sql[0];
}

/** Laravel's `DB_CONNECTION` for each SQL database. */
const LARAVEL_CONNECTIONS: Readonly<Partial<Record<SelfHostedServiceKind, string>>> = {
  postgres: "pgsql",
  mysql: "mysql",
  mariadb: "mariadb",
};

/** The settings that choose a service (Laravel's), and their value while that service runs. */
const CHOOSING_SETTINGS: Readonly<
  Record<string, (owner: { readonly services: readonly PlanService[] }) => string | undefined>
> = {
  DB_CONNECTION: (owner) => {
    const database = splitDatabase(owner);
    return database === undefined ? undefined : LARAVEL_CONNECTIONS[database.kind];
  },
  ...Object.fromEntries(
    ["QUEUE_CONNECTION", "CACHE_STORE", "CACHE_DRIVER", "SESSION_DRIVER"].map((name) => [
      name,
      (owner: { readonly services: readonly PlanService[] }) =>
        urlService(owner, "redis") === undefined ? undefined : "redis",
    ]),
  ),
};

/**
 * The value of a setting that chooses a service, while that service runs in `owner` (a plan or
 * design's components): `DB_CONNECTION` the connection of the {@link splitDatabase} (`pgsql`,
 * `mysql`, `mariadb`), and `QUEUE_CONNECTION`, `CACHE_STORE`, `CACHE_DRIVER` and `SESSION_DRIVER`
 * `redis` while Valkey, Redis 8 or Dragonfly runs. `design` plans it as `derived` where the
 * app's example gives it that value; undefined for any other name or without the service.
 */
export function choosingSettingValue(
  name: string,
  owner: { readonly services: readonly PlanService[] },
): string | undefined {
  return CHOOSING_SETTINGS[name]?.(owner);
}

/**
 * The app's variables each running service gives it, from the catalog (`appVariables`, FR-1314):
 * the conventional names and the service's own `variable`. A name one service has as its
 * `variable` comes only from that one (the database whose variable is `DATABASE_URL` keeps it);
 * a name two services give otherwise comes from the first. Client-exposed names are never filled.
 * An app whose variables include `DB_HOST` also gets the settings of its {@link splitDatabase} by
 * each of {@link SPLIT_SETTINGS}' names it has (FR-1337), and an app with Laravel's split Redis
 * settings those of the Redis it reaches ({@link urlService}, {@link redisSettings}). Each secret is
 * what `secret` returns for the service and the secret's name.
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
  const reads = new Set(plan.app.env.map((variable) => variable.name));
  const fill = (settings: Partial<Record<string, string>>) => {
    for (const [name, value] of Object.entries(settings)) {
      if (value !== undefined && reads.has(name) && !values.has(name)) values.set(name, value);
    }
  };
  const database = reads.has("DB_HOST") ? splitDatabase(plan) : undefined;
  const settings =
    database &&
    splitDatabaseSettings({ plan, service: database, secretRef: (name) => secret(database, name) });
  if (settings !== undefined) {
    fill(
      Object.fromEntries(
        Object.entries(SPLIT_SETTINGS).map(([name, setting]) => [name, settings[setting]]),
      ),
    );
  }
  const redis = urlService(plan, "redis");
  if (redis !== undefined) fill(redisSettings(plan, redis, secret));
  return values;
}

/**
 * Laravel's split Redis settings (`REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`) of a Valkey, Redis
 * 8 or Dragonfly: the host and port its address has, and the secret its address logs in with.
 */
function redisSettings(
  plan: DeployPlan,
  service: PlanService,
  secret: (service: PlanService, name: string) => string,
): Record<string, string | undefined> {
  // The address's parts are read with a stand-in for the secret, whatever characters it has.
  let login: string | undefined;
  const address = serviceSpec(service.kind).address({
    plan,
    service,
    secretRef: (name) => {
      login = name;
      return "secret";
    },
  });
  const url = new URL(address);
  return {
    REDIS_HOST: url.hostname,
    REDIS_PORT: url.port,
    REDIS_PASSWORD: login === undefined ? undefined : secret(service, login),
  };
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

/** R2's S3 endpoint, which names the user's Cloudflare account. */
export function r2Endpoint(accountId: string): string {
  return `https://${accountId}.r2.cloudflarestorage.com`;
}

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
 * The app's variables OpsCrew fills from what runs (FR-1314): the services' (catalog names, own
 * variables and the split database settings), the aliases of a running Postgres or Valkey, the
 * settings that chose a running service ({@link choosingSettingValue}), the object storage's, and
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
    if (choosingSettingValue(name, plan) !== undefined) names.add(name);
  }
  return names;
}

/** `APP_URL`'s value: the domain over HTTPS, else the server's address; undefined with neither. */
function appUrlValue(plan: DeployPlan, serverHost: string | undefined): string | undefined {
  if (plan.dns.domain !== undefined) return `https://${plan.dns.domain}`;
  return serverHost === undefined || serverHost === "" ? undefined : `http://${serverHost}`;
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
  /**
   * Contents of the environment's local file (interactive, `local.file`) or of
   * `OPSCREW_APP_ENV_FILE` (non-interactive).
   */
  dotenvText?: string;
  /** Interactive prompt; when absent, values come from `dotenvText` only. */
  ask?: (question: EnvQuestion) => Promise<EnvAnswer>;
  /**
   * The environment an interactive run is for, and the local file its values are offered from,
   * which `ask`'s questions name (default prod's `.env`).
   */
  local?: { environment: string; file: string };
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
  /**
   * A preview environment's env templates instead of values (ADR 0026): each value OpsCrew would
   * generate is the preview server's placeholder in the format it needs (`previewSecret`: a
   * service's secret as `<service>-<secret>`, an app variable by its name), never recorded in
   * `generated`; the user's own values from `dotenvText` stay out of `appEnv`, in
   * {@link AppEnvironment.preview}, and never replace a generated value or fixed setting. A
   * missing value is listed there instead of stopping the run. `previous` and `password` are not
   * read.
   */
  previewTemplates?: boolean;
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
  /**
   * With `previewTemplates` only: the user's own app values by name, which `appEnv` leaves out
   * (the preview server's `values.env`), and the required variables without a value.
   */
  preview?: { values: Record<string, string>; missing: string[] };
}

/**
 * Builds the production environment for the deploy secrets. Values the app needs come from the
 * user (local `.env` only after confirmation, or typed in), are generated (database password, app
 * keys in the format {@link FRAMEWORK_ENV} gives) or derived (DATABASE_URL, REDIS_URL and the app's
 * own names for them pointing at the containers, see {@link serviceUrlKind}; the split database
 * settings; the settings that chose a running service, {@link choosingSettingValue}; host lists
 * and `APP_URL` from the domain or the server's address; the fixed settings of
 * {@link FRAMEWORK_ENV}). A generated value
 * or fixed setting the env file of a non-interactive run sets wins, and is not stored as generated.
 * An optional variable (the code has a default) without a value is left unset instead of stopping
 * the run. Values are never logged. With `previewTemplates`, a preview environment's env templates
 * instead (see there).
 * @throws OpsCrewError `INVALID_INPUT` when a required value is missing in a non-interactive run.
 */
export async function assembleAppEnv(options: AssembleAppEnvOptions): Promise<AppEnvironment> {
  const { plan } = options;
  const templates = options.previewTemplates === true;
  const local = parseDotenv(options.dotenvText ?? "");
  const app = new Map<string, string>();
  const own = new Map<string, string>();
  const build = new Map<string, string>();
  const buildSecrets = new Map<string, string>();
  const missing: string[] = [];
  const defaulted: string[] = [];
  const unresolved: string[] = [];
  const newPassword = options.password ?? randomPassword;
  const generatedEnv: Record<string, string> = {};
  const generated: GeneratedValues = { env: generatedEnv };

  // Each running service's secrets: generated once, then kept (Postgres's as `dbPassword`); for
  // preview templates, the server's placeholder.
  const secrets: Record<string, Record<string, string>> = {};
  const secret = (service: PlanService, name: string): string => {
    const known = secrets[service.name]?.[name];
    if (known !== undefined) return known;
    const format = serviceSpec(service.kind).secrets.find((s) => s.name === name)?.format;
    let value: string;
    if (templates) {
      value = previewSecret(`${service.name}-${name}`, secretFormat(format));
    } else if (service.kind === "postgres" && name === "password") {
      value = options.previous?.dbPassword ?? newPassword();
      generated.dbPassword = value;
    } else {
      value =
        options.previous?.services?.[service.name]?.[name] ??
        options.password?.() ??
        newSecretValue(format);
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
            sqliteVariableValue(variable.name, plan) ??
            choosingSettingValue(variable.name, plan))
          : undefined
        : serviceSpec(aliased.kind).address({
            plan,
            service: aliased,
            secretRef: (name) => secret(aliased, name),
          });
    const fixed = derived ? FIXED_VALUES.get(variable.name) : undefined;
    // The file of a non-interactive run holds production values; the local `.env` of an
    // interactive run holds development ones (`APP_ENV=local`), so it never overrides a default,
    // nor a preview's values file, whose generated values the preview server makes.
    const userValue = options.ask || templates ? undefined : local.get(variable.name);
    const format = GENERATED_FORMATS.get(variable.name);
    /** The value is the user's own, which preview templates keep apart. */
    let users = false;
    let value: string | undefined;
    if (serviceUrl !== undefined) {
      value = serviceUrl;
    } else if (hostList !== undefined || (derived && variable.name === "APP_URL")) {
      value =
        hostList === undefined
          ? appUrlValue(plan, options.serverHost)
          : hostListValue(hostList, plan, options.serverHost);
      if (value === undefined) {
        unresolved.push(variable.name);
        continue;
      }
    } else if (fixed !== undefined) {
      value = userValue ?? fixed;
    } else if (variable.source === "generated" && templates) {
      value = previewSecret(variable.name, format ?? "hex32");
    } else if (variable.source === "generated") {
      // An injected source wins, so a caller that cannot know new values (drift) sees its marker.
      const generate = options.password ?? (() => newGeneratedValue(variable.name));
      value = userValue ?? options.previous?.env?.[variable.name] ?? generate();
      if (userValue === undefined) generatedEnv[variable.name] = value;
    } else if (options.ask) {
      const answer = await options.ask({
        name: variable.name,
        secret: variable.secret,
        environment: options.local?.environment ?? "prod",
        localFile: options.local?.file ?? ".env",
        localValueAvailable: local.has(variable.name),
        optional,
      });
      if ("useLocal" in answer) value = local.get(variable.name);
      else if ("value" in answer) value = answer.value;
    } else {
      value = local.get(variable.name);
      users = true;
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
      (users && templates ? own : app).set(variable.name, value);
    }
  }

  // The earlier values a rotation kept beside a generated secret (`APP_PREVIOUS_KEYS`), while
  // OpsCrew still generates that secret and gives the variable (not one the plan names itself).
  for (const [name, variable] of Object.entries(PREVIOUS_VALUES)) {
    const kept = options.previous?.env?.[variable];
    if (
      generatedEnv[name] === undefined ||
      !kept ||
      !previousValueVariables(plan).includes(variable)
    ) {
      continue;
    }
    app.set(variable, kept);
    generatedEnv[variable] = kept;
  }

  if (missing.length > 0 && !options.ask && !templates) {
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
  const sorted = (entries: Iterable<[string, string]>) =>
    Object.fromEntries([...entries].sort(([a], [b]) => a.localeCompare(b)));
  const allBuild = [...build.entries(), ...buildSecrets.entries()];
  return {
    appEnv: `${sortedLines(app, dotenvLine).join("\n")}\n`,
    buildEnv: buildLines(build),
    buildSecrets: buildLines(buildSecrets),
    names: [...new Set([...app.keys(), ...own.keys(), ...allBuild.map(([name]) => name)])].sort(),
    defaulted,
    unresolved,
    generated,
    values: {
      app: sorted(app.entries()),
      build: sorted(allBuild),
      ...(db !== undefined ? { db } : {}),
      services: secrets,
    },
    ...(templates ? { preview: { values: sorted(own.entries()), missing } } : {}),
  };
}
