/**
 * Signals about how the app reaches its services, read from committed env and compose files:
 * URL schemes and hosts of values (never the rest of the values), the hosting providers those
 * hosts belong to, Redis services in compose files, and the names of variables Flask loads by
 * prefix (`app.config.from_prefixed_env()`). Pure functions over text.
 */
import type { EnvUrlScheme, ServiceKind } from "@opscrew/plan-schema";
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
  for (const [name, url] of envFileUrls(text)) {
    const kind = url.scheme === "" ? undefined : schemeKind(url.scheme);
    if (kind) schemes.set(name, kind);
  }
  return schemes;
}

/**
 * The scheme and host of a URL an env file gives a variable, or the host of a bare address
 * (`broker.example.com:9092`); the rest of the value is dropped.
 */
export interface EnvUrl {
  /**
   * In lower case, with any `+` suffix (`mongodb+srv`, `postgresql+psycopg2`); empty for a bare
   * address.
   */
  scheme: string;
  /** In lower case, without user info or port; the first one of a host list. */
  host: string;
}

/** One `NAME=value` line of an env file: the name, then the value as written. */
export const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;
/** A bare host name, with an optional port, alone or first in a list. */
const BARE_HOST = /^["']?([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)(?::\d+)?(?:,|["']?\s*$)/;

/** The URL or bare address each variable of an env file holds, as its scheme and host only. */
export function envFileUrls(text: string): Map<string, EnvUrl> {
  const urls = new Map<string, EnvUrl>();
  for (const line of text.split(/\r?\n/)) {
    const match = ENV_LINE.exec(line);
    if (!match?.[1]) continue;
    const value = match[2] ?? "";
    const url = /^["']?([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#\s"']*)/.exec(value);
    if (url?.[1]) {
      const authority = url[2] ?? "";
      const host = (authority.slice(authority.lastIndexOf("@") + 1).split(",")[0] ?? "")
        .replace(/:\d*$/, "")
        .toLowerCase();
      urls.set(match[1], { scheme: url[1].toLowerCase(), host });
      continue;
    }
    const bare = BARE_HOST.exec(value)?.[1];
    if (bare) urls.set(match[1], { scheme: "", host: bare.toLowerCase() });
  }
  return urls;
}

/**
 * The value an env file gives `name`, without quotes or a trailing comment; for plain settings
 * such as Laravel's `DB_CONNECTION`, never for secrets.
 */
export function envFileValue(text: string, name: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const match = ENV_LINE.exec(line);
    if (match?.[1] !== name) continue;
    const raw = (match[2] ?? "").trim();
    const quoted = /^(["'])(.*?)\1/.exec(raw);
    const value = quoted ? quoted[2] : raw.replace(/\s+#.*$/, "");
    return value || undefined;
  }
  return undefined;
}

/** The services URL schemes name, by the part before any `+`. */
const SCHEME_SERVICES = new Map<string, ServiceKind>([
  ["postgres", "postgres"],
  ["postgresql", "postgres"],
  ["mysql", "mysql"],
  ["mariadb", "mariadb"],
  ["mongodb", "mongodb"],
  ["redis", "redis"],
  ["rediss", "redis"],
  ["amqp", "amqp"],
  ["amqps", "amqp"],
  ["pyamqp", "amqp"],
  ["nats", "nats"],
  ["neo4j", "neo4j"],
  ["bolt", "neo4j"],
  ["clickhouse", "clickhouse"],
]);

/** The service a URL scheme names (`mongodb+srv` → `mongodb`, `pyamqp` → `amqp`). */
export function serviceOfScheme(scheme: string): ServiceKind | undefined {
  return SCHEME_SERVICES.get(scheme.toLowerCase().split("+")[0] ?? "");
}

/**
 * Hosting providers by the host names of the URLs they give out, with the service a web URL
 * (`https://…`) or a bare address of theirs is, for providers of one kind of service.
 */
const HOSTED_PROVIDERS: readonly (readonly [RegExp, string, ServiceKind?])[] = [
  [/(?:^|\.)mongodb\.net$/, "MongoDB Atlas", "mongodb"],
  [/(?:^|\.)psdb\.cloud$/, "PlanetScale"],
  [/(?:^|\.)upstash\.io$/, "Upstash", "redis"],
  [/(?:^|\.)neon\.tech$/, "Neon", "postgres"],
  [/(?:^|\.)(?:supabase\.co|pooler\.supabase\.com)$/, "Supabase"],
  [/(?:^|\.)cloudamqp\.com$/, "CloudAMQP", "amqp"],
  [/(?:^|\.)(?:redis-cloud|redislabs)\.com$/, "Redis Cloud", "redis"],
  [/(?:^|\.)(?:elastic-cloud\.com|cloud\.es\.io)$/, "Elastic Cloud", "elasticsearch"],
  [/(?:^|\.)clickhouse\.cloud$/, "ClickHouse Cloud", "clickhouse"],
  [/(?:^|\.)typesense\.net$/, "Typesense Cloud", "typesense"],
  [/(?:^|\.)meilisearch\.io$/, "Meilisearch Cloud", "meilisearch"],
  [/(?:^|\.)confluent\.cloud$/, "Confluent Cloud", "kafka"],
  [/(?:^|\.)databases\.neo4j\.io$/, "Neo4j Aura", "neo4j"],
  [/(?:^|\.)aivencloud\.com$/, "Aiven"],
  [/(?:^|\.)cockroachlabs\.cloud$/, "CockroachDB Cloud", "postgres"],
  [/(?:^|\.)ondigitalocean\.com$/, "DigitalOcean Managed Databases"],
  [/(?:^|\.)rds\.amazonaws\.com$/, "Amazon RDS"],
  [/(?:^|\.)cache\.amazonaws\.com$/, "Amazon ElastiCache", "redis"],
];

/**
 * The hosted service a URL or bare address points at: the provider's name from the host (MongoDB
 * Atlas for the `mongodb+srv` form), and the kind from the URL's scheme, else the provider's.
 * Undefined for no known provider, or no kind.
 */
export function hostedService(url: EnvUrl): { kind: ServiceKind; provider: string } | undefined {
  const known = HOSTED_PROVIDERS.find(([host]) => host.test(url.host));
  const provider = known?.[1] ?? (url.scheme === "mongodb+srv" ? "MongoDB Atlas" : undefined);
  const kind = serviceOfScheme(url.scheme) ?? known?.[2];
  return provider === undefined || kind === undefined ? undefined : { kind, provider };
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
