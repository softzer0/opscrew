/**
 * Shared enumerations and primitive schemas used by every OpsCrew artefact.
 * The enum values are exhaustive for schema v1 (see data-model.md).
 */
import { PHASES } from "@opscrew/contracts";
import { z } from "zod";

/** Programming languages detected in a repository. */
export const LanguageSchema = z.enum([
  "javascript",
  "typescript",
  "python",
  "go",
  "ruby",
  "php",
  "java",
  "rust",
  "other",
]);
export type Language = z.infer<typeof LanguageSchema>;

/** The runtime an image builder is given, one per app. */
export const RuntimeLanguageSchema = z.enum([
  "node",
  "python",
  "ruby",
  "go",
  "java",
  "dotnet",
  "php",
  "rust",
  "other",
]);
export type RuntimeLanguage = z.infer<typeof RuntimeLanguageSchema>;

/** Who builds the app's image. */
export const ImageBuilderSchema = z.enum([
  "generated-dockerfile",
  "own-dockerfile",
  "buildpacks",
  "railpack",
]);
export type ImageBuilder = z.infer<typeof ImageBuilderSchema>;

/** Package managers detected in a repository. */
export const PackageManagerSchema = z.enum([
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "pip",
  "poetry",
  "uv",
  "pipenv",
  "none",
]);
export type PackageManager = z.infer<typeof PackageManagerSchema>;

/** Broad shape of the application. */
export const AppKindSchema = z.enum(["static-spa", "ssr", "api", "fullstack", "worker", "unknown"]);
export type AppKind = z.infer<typeof AppKindSchema>;

/** Hosted builder the code was exported from, if any. */
export const PlatformExportSchema = z.enum(["lovable", "bolt", "replit", "v0", "base44", "none"]);
export type PlatformExport = z.infer<typeof PlatformExportSchema>;

/**
 * Backing services an application uses, as detection names them: by what the app talks to (`redis`
 * for a Redis client, `amqp` for an AMQP client), not by what OpsCrew runs for it
 * ({@link SelfHostedServiceKindSchema}).
 */
export const ServiceKindSchema = z.enum([
  "postgres",
  "mysql",
  "mongodb",
  "redis",
  "sqlite",
  "supabase",
  "firebase",
  "s3",
  "stripe",
  "email",
  "queue",
  "websocket",
  "cron",
  "mariadb",
  "amqp",
  "nats",
  "kafka",
  "opensearch",
  "elasticsearch",
  "meilisearch",
  "typesense",
  "clickhouse",
  "neo4j",
  "cassandra",
]);
export type ServiceKind = z.infer<typeof ServiceKindSchema>;

/**
 * Backing services OpsCrew runs as containers next to the app (`plan.services[].kind`), one entry
 * per kind in the service catalog: Valkey for an app on Redis (or Redis 8 or Dragonfly), RabbitMQ
 * for AMQP, Garage for object storage.
 */
export const SelfHostedServiceKindSchema = z.enum([
  "postgres",
  "mysql",
  "mariadb",
  "mongodb",
  "valkey",
  "redis",
  "dragonfly",
  "rabbitmq",
  "nats",
  "kafka",
  "redpanda",
  "garage",
  "opensearch",
  "elasticsearch",
  "meilisearch",
  "typesense",
  "clickhouse",
  "neo4j",
]);
export type SelfHostedServiceKind = z.infer<typeof SelfHostedServiceKindSchema>;

/** Provider-neutral deployment regions. */
export const RegionSchema = z.enum([
  "eu-central",
  "eu-north",
  "us-east",
  "us-west",
  "ap-southeast",
]);
export type Region = z.infer<typeof RegionSchema>;

/**
 * Where OpsCrew deploys a single server (`vps-compose` mode): a server it creates on Hetzner Cloud
 * or DigitalOcean, or a server the user already owns (`own`), which OpsCrew prepares over SSH but
 * never creates or deletes.
 */
export const VpsProviderSchema = z.enum(["hetzner", "digitalocean", "own"]);
export type VpsProvider = z.infer<typeof VpsProviderSchema>;

/** Cloud providers on which OpsCrew creates the server itself. */
export const CloudProviderSchema = VpsProviderSchema.exclude(["own"]);
export type CloudProvider = z.infer<typeof CloudProviderSchema>;

/**
 * The server-less targets, which have no server at all: Cloudflare's hosting (`cloudflare-workers`,
 * Workers with static assets) and GitHub Pages (`github-pages`).
 */
export const ServerlessProviderSchema = z.enum(["cloudflare-workers", "github-pages"]);
export type ServerlessProvider = z.infer<typeof ServerlessProviderSchema>;

/**
 * Every place OpsCrew can deploy to, as `opscrew/requirements.yaml` and design options name it: a
 * single server ({@link VpsProviderSchema}), a Portainer the user already runs (`portainer`), the
 * user's own computer (`localhost`, its Docker) or a server-less target
 * ({@link ServerlessProviderSchema}). Only the single servers have a server for OpsCrew to
 * create, size or price.
 */
export const DeployProviderSchema = z.enum([
  ...VpsProviderSchema.options,
  "portainer",
  "localhost",
  ...ServerlessProviderSchema.options,
]);
export type DeployProvider = z.infer<typeof DeployProviderSchema>;

/** True for a target on one server: one OpsCrew creates (Hetzner, DigitalOcean) or the user's. */
export function onOneServer(provider: string): provider is VpsProvider {
  return VpsProviderSchema.safeParse(provider).success;
}

/** True for a server-less target's provider: Cloudflare's hosting or GitHub Pages. */
export function isServerlessProvider(provider: string | undefined): provider is ServerlessProvider {
  return ServerlessProviderSchema.safeParse(provider).success;
}

/** Registrars OpsCrew can buy domains with. */
export const RegistrarSchema = z.enum(["cloudflare", "namecheap", "porkbun", "godaddy"]);
export type Registrar = z.infer<typeof RegistrarSchema>;

/** Expected monthly active users. */
export const UserScaleSchema = z.enum(["<1k", "1k-10k", "10k-100k", ">100k"]);
export type UserScale = z.infer<typeof UserScaleSchema>;

/** Uptime expectation. */
export const UptimeSchema = z.enum(["best-effort", "standard", "high"]);
export type Uptime = z.infer<typeof UptimeSchema>;

/** How bad losing the application's data would be. */
export const DataCriticalitySchema = z.enum(["none", "important", "critical"]);
export type DataCriticality = z.infer<typeof DataCriticalitySchema>;

/** Kinds of changes the Code-change agent proposes to the user's repository. */
export const CodeChangeKindSchema = z.enum([
  "dockerfile",
  "dockerignore",
  "health-endpoint",
  "port-config",
  "env-example",
  "build-config",
  "secret-removal",
  "other",
]);
export type CodeChangeKind = z.infer<typeof CodeChangeKindSchema>;

/** Lifecycle of a proposed code change. */
export const CodeChangeStatusSchema = z.enum(["pending", "applied", "skipped"]);
export type CodeChangeStatus = z.infer<typeof CodeChangeStatusSchema>;

/** OpsCrew phase names (`PHASES` from `@opscrew/contracts`). Type: `PhaseName` from contracts. */
export const PhaseNameSchema = z.enum(PHASES);

/** Supported currencies. Type: `Currency` from contracts. */
export const CurrencySchema = z.enum(["EUR", "USD"]);

/** An amount of money (`amount` >= 0, finite). Type: `Money` from contracts. */
export const MoneySchema = z.strictObject({
  amount: z.number().nonnegative(),
  currency: CurrencySchema,
});

/** ISO-8601 UTC timestamp, for example `2026-10-11T14:03:00.000Z`. */
export const IsoDateTimeSchema = z.iso.datetime();

/** Repo-relative POSIX path (`apps/web/Dockerfile`, `.` for the root); never absolute. */
export const RepoPathSchema = z
  .string()
  .regex(/^(?!\/)(?![A-Za-z]:)(?!.*\\)(?!(?:.*\/)?\.\.(?:\/|$)).+$/, {
    message:
      "must be a repo-relative path with forward slashes such as `apps/web/Dockerfile` (no leading `/`, drive letter, backslash or `..`)",
  });

/**
 * One shell command on a single line, for example `python manage.py migrate --noinput`: not
 * blank, no line breaks or NUL characters.
 */
export const CommandLineSchema = z.string().regex(/^[^\r\n\0]*\S[^\r\n\0]*$/, {
  message: "must be one shell command on a single line",
});

/** Lower-case fully qualified domain name, for example `app.example.com`. */
export const FqdnSchema = z
  .string()
  .regex(
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/,
    { message: "must be a lower-case domain name such as `app.example.com`" },
  );

/** URL path starting with `/`, for example `/health`. */
export const UrlPathSchema = z
  .string()
  .regex(/^\/\S*$/, { message: "must start with `/`, for example `/health`" });

/** Environment variable name (names only, never values). */
export const EnvVarNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, {
  message: "must be an environment variable name such as `DATABASE_URL` (never a value)",
});

/** What a host-list variable holds: host names or origins (`https://<host>`). */
export type HostListKind = "hosts" | "origins";

/**
 * The host list a variable holds, from its name: `ALLOWED_HOSTS` and `*_ALLOWED_HOSTS` hold host
 * names, `CSRF_TRUSTED_ORIGINS` and `*_CSRF_TRUSTED_ORIGINS` origins. Undefined for any other name.
 * `design` plans these as `derived`, and agents fill them from the deployment; they hold no secret.
 */
export function hostListKind(name: string): HostListKind | undefined {
  if (/^(?:\w+_)?ALLOWED_HOSTS$/.test(name)) return "hosts";
  if (/^(?:\w+_)?CSRF_TRUSTED_ORIGINS$/.test(name)) return "origins";
  return undefined;
}

/** SHA-256 hash of a plan file: 64 hex characters. */
export const PlanHashSchema = z
  .string()
  .regex(/^[0-9a-fA-F]{64}$/, { message: "must be a SHA-256 hash (64 hex characters)" });

/** TCP port number. */
export const PortSchema = z.int().min(1).max(65535);

/** A container's memory limit in MB (Compose `mem_limit`). */
export const MemoryMbSchema = z.int().positive();
