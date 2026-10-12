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

/** Backing services an application uses. */
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
]);
export type ServiceKind = z.infer<typeof ServiceKindSchema>;

/** Provider-neutral deployment regions. */
export const RegionSchema = z.enum([
  "eu-central",
  "eu-north",
  "us-east",
  "us-west",
  "ap-southeast",
]);
export type Region = z.infer<typeof RegionSchema>;

/** Cloud providers OpsCrew deploys a single server to (`vps-compose` mode). */
export const VpsProviderSchema = z.enum(["hetzner", "digitalocean"]);
export type VpsProvider = z.infer<typeof VpsProviderSchema>;

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

/** SHA-256 hash of a plan file: 64 hex characters. */
export const PlanHashSchema = z
  .string()
  .regex(/^[0-9a-fA-F]{64}$/, { message: "must be a SHA-256 hash (64 hex characters)" });

/** TCP port number. */
export const PortSchema = z.int().min(1).max(65535);
