/**
 * Signals about how the app reaches its services, read from committed env and compose files:
 * URL schemes of values (never the values), Redis services in compose files, and the names of
 * variables Flask loads by prefix (`app.config.from_prefixed_env()`). Pure functions over text.
 */
import type { EnvUrlScheme } from "@opscrew/plan-schema";
import { isEnvExampleFile } from "./env";
import { basenameRel } from "./paths";

/**
 * True for env files committed with the app: example files (`.env.example`, `.env.sample`,
 * `.env.template`), any `.env*` file under a `docker/` directory, and `*.env` files
 * (`config/prod.env`). A bare `.env` or `.env.local` elsewhere is a local file and never counts.
 */
export function isCommittedEnvFile(path: string): boolean {
  if (isEnvExampleFile(path)) return true;
  const name = basenameRel(path);
  if (/(?:^|\/)docker\/(?:.+\/)?\.env(?:\.[\w-]+)*$/.test(path)) return true;
  return /^[\w-][\w.-]*\.env$/.test(name);
}

/** True for Docker Compose files (`compose.yaml`, `docker-compose.dev.yml`). */
export function isComposeFile(path: string): boolean {
  return /^(?:docker-)?compose(?:\.[\w-]+)?\.ya?ml$/i.test(basenameRel(path));
}

/** A URL scheme at the start of a value; the capture is the scheme (`postgresql+psycopg2`). */
const VALUE_SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//;
/** Web URLs (`http://localhost:3000`) say nothing about how the app reaches a service. */
const WEB_SCHEMES = new Set(["http", "https", "ws", "wss"]);
const SCHEME_KINDS = new Map<string, EnvUrlScheme>([
  ["postgres", "postgres"],
  ["postgresql", "postgres"],
  ["mysql", "mysql"],
  ["mariadb", "mysql"],
  ["mongodb", "mongodb"],
  ["redis", "redis"],
  ["rediss", "redis"],
  ["amqp", "amqp"],
  ["amqps", "amqp"],
  ["pyamqp", "amqp"],
  ["sqlite", "sqlite"],
]);

/**
 * The kind of a URL scheme, from its part before any `+` driver suffix: `postgresql+psycopg2` →
 * `postgres`, `rediss` → `redis`, `mongodb+srv` → `mongodb`, `rpc` or `db+postgresql` → `other`.
 * Undefined for web schemes.
 */
export function schemeKind(scheme: string): EnvUrlScheme | undefined {
  const base = scheme.toLowerCase().split("+")[0] ?? "";
  if (WEB_SCHEMES.has(base)) return undefined;
  return SCHEME_KINDS.get(base) ?? "other";
}

/**
 * The kind of URL each variable of an env file holds (`CELERY_BROKER_URL` → `redis` for
 * `redis://…`), for values that start with a non-web URL scheme. Only the scheme is looked at;
 * values are never returned or kept.
 */
export function envFileSchemes(text: string): Map<string, EnvUrlScheme> {
  const schemes = new Map<string, EnvUrlScheme>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*["']?(.*)$/.exec(line);
    const scheme = match?.[2] === undefined ? undefined : VALUE_SCHEME.exec(match[2])?.[1];
    const kind = scheme === undefined ? undefined : schemeKind(scheme);
    if (match?.[1] && kind) schemes.set(match[1], kind);
  }
  return schemes;
}

/**
 * True when a compose file runs Redis (a service named `redis`, or an image named `redis`,
 * `bitnami/redis` or `redis/redis-stack…`) or passes a `redis://` URL to a service.
 */
export function composeUsesRedis(text: string): boolean {
  if (/^[ \t]+redis:[ \t]*(?:#.*)?$/m.test(text)) return true;
  if (/rediss?:\/\//.test(text)) return true;
  return /^[ \t]*image:[ \t]*["']?(?:[\w.-]+(?::\d+)?\/)?(?:library\/|bitnami\/)?redis(?:\/redis-stack[\w-]*)?(?=[:@"'\s]|$)/m.test(
    text,
  );
}

/** Flask settings read by the `flask` command itself, not by the app's config. */
const FLASK_CLI_NAMES = /^FLASK_(?:APP|ENV|DEBUG|RUN_\w+|SKIP_DOTENV)$/;

/**
 * Names Flask loads into the app's config with `from_prefixed_env(prefix)`: those starting with
 * `<prefix>_` (sorted, unique). Flask's own command settings (`FLASK_APP`, `FLASK_DEBUG`,
 * `FLASK_ENV`, `FLASK_RUN_*`) are left out: the production image does not need them.
 */
export function prefixedConfigNames(names: Iterable<string>, prefixes: Iterable<string>): string[] {
  const wanted = [...prefixes].map((prefix) => `${prefix}_`);
  const found = new Set<string>();
  for (const name of names) {
    if (FLASK_CLI_NAMES.test(name)) continue;
    if (wanted.some((prefix) => name.startsWith(prefix) && name.length > prefix.length)) {
      found.add(name);
    }
  }
  return [...found].sort();
}
