import { randomBytes } from "node:crypto";
import { OpsCrewError } from "@opscrew/core";
import { isClientExposedEnvName, siteHosts } from "@opscrew/iac-templates";
import { type DeployPlan, type SelfHostedServiceKind, serviceOf } from "@opscrew/plan-schema";
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

/** The service OpsCrew runs for each kind of URL: Postgres, and Valkey for Redis. */
export const URL_SERVICE_KINDS = {
  postgres: "postgres",
  redis: "valkey",
} as const satisfies Record<ServiceUrlKind, SelfHostedServiceKind>;

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
 * The service whose connection URL a variable holds, from its name: `DATABASE_URL` and the
 * names apps use for it (`DATABASE_URI`, `SQLALCHEMY_DATABASE_URI`, `POSTGRES_URL`, `DB_URL`,
 * `*_DATABASE_URL`/`_URI`) hold Postgres; `REDIS_URL`/`_URI`, `*_REDIS_URL`/`_URI`, Celery's broker
 * and result backend hold Redis. Undefined for any other name, for names bundlers expose to
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
}

/** Generated values to keep between runs (stored privately, never committed or logged). */
export interface GeneratedValues {
  dbPassword?: string;
  /** Generated app variables by name. */
  env?: Record<string, string>;
}

export interface AppEnvironment {
  /** Contents of the `OPSCREW_APP_ENV` secret (Compose env_file for the app). */
  appEnv: string;
  /** Contents of `OPSCREW_DB_ENV` when Postgres is self-hosted. */
  dbEnv?: string;
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
   * what {@link buildEnv} and {@link buildSecrets} hold, `db` what {@link dbEnv} holds. Never
   * logged.
   */
  values: {
    app: Record<string, string>;
    build: Record<string, string>;
    db?: { user: string; name: string; password: string };
  };
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
  let db: { user: string; name: string; password: string } | undefined;
  const newPassword = options.password ?? randomPassword;
  const generatedEnv: Record<string, string> = {};
  const generated: GeneratedValues = { env: generatedEnv };

  // Connection URLs of the services OpsCrew runs, by kind.
  const serviceUrls = new Map<ServiceUrlKind, string>();
  if (serviceOf(plan, "postgres")) {
    const password = options.previous?.dbPassword ?? newPassword();
    generated.dbPassword = password;
    db = { user: "app", name: "app", password };
    // `postgresql://` for every name: SQLAlchemy rejects `postgres://`, while libpq, node-postgres,
    // Prisma, Sequelize, dj-database-url, Rails and the Go and Rust drivers accept both.
    const url = `postgresql://app:${password}@db:5432/app`;
    app.set("DATABASE_URL", url);
    serviceUrls.set("postgres", url);
  }
  if (serviceOf(plan, "valkey")) {
    app.set("REDIS_URL", "redis://cache:6379");
    serviceUrls.set("redis", "redis://cache:6379");
  }

  for (const variable of plan.app.env) {
    if (app.has(variable.name) || variable.name === "PORT") continue;
    const optional = variable.optional === true;
    const derived = variable.source === "derived";
    const hostList = derived ? hostListKind(variable.name) : undefined;
    const serviceKind = derived ? serviceUrlKind(variable.name) : undefined;
    const serviceUrl = serviceKind !== undefined ? serviceUrls.get(serviceKind) : undefined;
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
    ...(db !== undefined
      ? {
          dbEnv: [
            `POSTGRES_USER=${db.user}`,
            `POSTGRES_DB=${db.name}`,
            `POSTGRES_PASSWORD=${db.password}`,
            "",
          ].join("\n"),
        }
      : {}),
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
    },
  };
}
