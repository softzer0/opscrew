import { z } from "zod";
import {
  AppKindSchema,
  CommandLineSchema,
  EnvVarNameSchema,
  LanguageSchema,
  PackageManagerSchema,
  PlatformExportSchema,
  PortSchema,
  RepoPathSchema,
  ServiceKindSchema,
  UrlPathSchema,
} from "./enums";

/** Normalised URL scheme of an env var's example value (see `envVars[].urlScheme`). */
export const EnvUrlSchemeSchema = z.enum([
  "postgres",
  "mysql",
  "mongodb",
  "redis",
  "amqp",
  "sqlite",
  "other",
]);
export type EnvUrlScheme = z.infer<typeof EnvUrlSchemeSchema>;

/**
 * Array refinement: items must be strictly ascending by `key` (sorted and unique), so detection
 * output is deterministic. The issue points at the first offending item.
 */
function strictlyAscending<T>(key: (item: T) => string, what: string) {
  return (items: T[], ctx: z.RefinementCtx<T[]>) => {
    for (let i = 1; i < items.length; i++) {
      const prev = key(items[i - 1] as T);
      const cur = key(items[i] as T);
      if (prev === cur) {
        ctx.addIssue({ code: "custom", path: [i], message: `duplicate ${what} "${cur}"` });
        return;
      }
      if (prev > cur) {
        ctx.addIssue({
          code: "custom",
          path: [i],
          message: `${what} must be sorted alphabetically ("${cur}" comes before "${prev}")`,
        });
        return;
      }
    }
  };
}

/** Matches `scheme://userinfo@host...`; credentials must never be stored in a remote URL. */
const URL_WITH_USERINFO = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*@/;

/** Deterministic facts about a repository, produced by `@opscrew/detect`. */
export const ProjectFactsSchema = z.strictObject({
  name: z.string().min(1).max(100),
  languages: z.array(LanguageSchema).superRefine(strictlyAscending((l) => l, "language")),
  packageManager: PackageManagerSchema,
  frameworks: z.array(
    z.strictObject({
      name: z.string().min(1),
      version: z.string().min(1).optional(),
      path: RepoPathSchema,
    }),
  ),
  appKind: AppKindSchema,
  platformExport: z.strictObject({
    platform: PlatformExportSchema,
    evidence: z.array(z.string().min(1)),
  }),
  build: z.strictObject({
    installCommand: z.string().min(1).optional(),
    buildCommand: z.string().min(1).optional(),
    startCommand: z.string().min(1).optional(),
    /**
     * Command that prepares the database before each new version takes traffic (migrations), run
     * from the repository root like `startCommand`. Absent when the app has none.
     */
    releaseCommand: CommandLineSchema.optional(),
    /**
     * Detection's note on migrations, in plain English that says what to do next: why there is no
     * release command (the app runs them itself when it starts, `atStartup`, or the tool would be
     * missing where the command runs), or which package script it did not use and why.
     */
    releaseNote: z
      .strictObject({
        text: z.string().min(1),
        atStartup: z.boolean(),
      })
      .optional(),
    outputDir: z.string().min(1).optional(),
  }),
  port: PortSchema.optional(),
  /** Runtime versions as the app declares them, not yet normalised. */
  runtimeVersions: z.strictObject({
    node: z.string().min(1).optional(),
    python: z.string().min(1).optional(),
    /** `.ruby-version`, else the Gemfile's `ruby "…"`. */
    ruby: z.string().min(1).optional(),
    /** `go.mod`'s `toolchain go…`, else its `go …`. */
    go: z.string().min(1).optional(),
    /** Maven `maven.compiler.release` or `java.version`, Gradle toolchain `languageVersion`. */
    java: z.string().min(1).optional(),
    /** The project file's `TargetFramework` `netX.Y`, as `X.Y`. */
    dotnet: z.string().min(1).optional(),
    /** `composer.json`'s `require.php`. */
    php: z.string().min(1).optional(),
    /** `rust-toolchain.toml`'s `channel`, else `rust-toolchain`. */
    rust: z.string().min(1).optional(),
  }),
  envVars: z
    .array(
      z.strictObject({
        name: EnvVarNameSchema,
        files: z.array(RepoPathSchema),
        clientExposed: z.boolean(),
        secretLikely: z.boolean(),
        /**
         * True when every read in the code falls back to a default when the variable is unset
         * (`os.environ.get("X", "…")`, `process.env.X ?? "…"`); absent means false.
         */
        hasDefault: z.boolean().optional(),
        /**
         * Kind of URL a committed example env file gives the variable (`postgres` for
         * `postgresql://…`, `redis` for `rediss://…`, `other` for any non-web scheme such as
         * `rpc://`); absent when no file gives one. Only the scheme is recorded, never the value.
         */
        urlScheme: EnvUrlSchemeSchema.optional(),
      }),
    )
    .superRefine(strictlyAscending((v) => v.name, "environment variable")),
  services: z
    .array(
      z.strictObject({
        kind: ServiceKindSchema,
        evidence: z.array(z.string().min(1)),
      }),
    )
    .superRefine((items, ctx) => {
      const seen = new Set<string>();
      items.forEach((item, i) => {
        if (seen.has(item.kind)) {
          ctx.addIssue({
            code: "custom",
            path: [i, "kind"],
            message: `duplicate service "${item.kind}"`,
          });
        }
        seen.add(item.kind);
      });
    }),
  docker: z.strictObject({
    dockerfile: RepoPathSchema.optional(),
    compose: RepoPathSchema.optional(),
    dockerignore: RepoPathSchema.optional(),
  }),
  healthEndpoint: UrlPathSchema.optional(),
  monorepo: z.boolean(),
  /** Repo-relative directory of the app the facts describe (`.` for the repository root). */
  appDir: RepoPathSchema,
  /**
   * Plain-English notes on what OpsCrew deploys that the user must know, for example a part of the
   * app it does not serve yet; `design` and the adapt pull request show them. Absent when none.
   */
  notes: z.array(z.string().min(1)).min(1).optional(),
  git: z.strictObject({
    remoteUrl: z
      .string()
      .min(1)
      .refine((url) => !URL_WITH_USERINFO.test(url), {
        message: "must not contain a user name, password or token; remove the part before `@`",
      })
      .optional(),
    owner: z.string().min(1).optional(),
    repo: z.string().min(1).optional(),
    defaultBranch: z.string().min(1).optional(),
    currentBranch: z.string().min(1).optional(),
  }),
});
export type ProjectFacts = z.infer<typeof ProjectFactsSchema>;
