import { z } from "zod";
import {
  AppKindSchema,
  CommandLineSchema,
  EnvVarNameSchema,
  LanguageSchema,
  PackageManagerSchema,
  PlanHashSchema,
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

/**
 * An absolute POSIX path in an image, such as `/app` or `/srv/app`: no trailing `/`, spaces or
 * variables.
 */
export const AbsolutePathSchema = z.string().regex(/^\/(?:[^/\s\\$]+(?:\/[^/\s\\$]+)*)?$/, {
  message: "must be an absolute path such as /app, without spaces, variables or a trailing slash",
});

/** Matches `scheme://userinfo@host...`; credentials must never be stored in a remote URL. */
const URL_WITH_USERINFO = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*@/;

/** One runtime version hint and where it was found (see `runtimeEvidence`). */
const RuntimeEvidenceSchema = z.strictObject({
  value: z.string().min(1),
  source: z.string().min(1),
});

/**
 * A `vercel.json` source pattern: path-to-regexp (`/blog/:slug`, `/:path*`, `/(.*)`) or the regex
 * form (`^/articles/(\d{4})$`). Matched case-sensitively against the path only.
 */
export const VercelSourceSchema = z.string().regex(/^[/^]\S*$/, {
  message: "must start with `/` (a path pattern) or `^` (a regular expression)",
});

/** A rule's position in its `vercel.json` array, so skipped rules can be named. */
const RuleIndexSchema = z.int().min(0);

/** The `vercel.json` properties OpsCrew reads for routing. */
const VercelRoutingPropertySchema = z.enum([
  "redirects",
  "rewrites",
  "headers",
  "cleanUrls",
  "trailingSlash",
  "routes",
]);

/**
 * The routing rules of a `vercel.json`, for apps leaving Vercel (FR-1446). Redirects carry their
 * status code: `permanent: true` (Vercel's default) is 308 and `false` is 307.
 */
export const PlatformRoutingSchema = z.strictObject({
  source: z.literal("vercel.json"),
  /** The file's SHA-256, so a later change to it can be noticed. */
  sha256: PlanHashSchema,
  redirects: z.array(
    z.strictObject({
      index: RuleIndexSchema,
      source: VercelSourceSchema,
      destination: z.string().min(1),
      statusCode: z.literal([301, 302, 303, 307, 308]),
    }),
  ),
  rewrites: z.array(
    z.strictObject({
      index: RuleIndexSchema,
      source: VercelSourceSchema,
      destination: z.string().min(1),
    }),
  ),
  headers: z.array(
    z.strictObject({
      index: RuleIndexSchema,
      source: VercelSourceSchema,
      headers: z.array(z.strictObject({ key: z.string().min(1), value: z.string() })).min(1),
    }),
  ),
  cleanUrls: z.boolean().optional(),
  trailingSlash: z.boolean().optional(),
  /** What is not translated (`routes`, `has` and `missing` conditions, malformed rules), and why. */
  unsupported: z.array(
    z.strictObject({
      property: VercelRoutingPropertySchema,
      /** The rule's index in the property's array; absent for the property as a whole. */
      index: RuleIndexSchema.optional(),
      reason: z.string().min(1),
    }),
  ),
});
export type PlatformRouting = z.infer<typeof PlatformRoutingSchema>;

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
    /**
     * The working directory of the last stage of the app's own Dockerfile (its last `WORKDIR`,
     * resolved), where the app runs in the image. Absent without a Dockerfile, or when it is not
     * known (no `WORKDIR` there, a relative one with nothing to resolve against, or a variable).
     */
    workdir: AbsolutePathSchema.optional(),
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
  /**
   * Hints at the Node and Python versions the app runs on when it declares none (FR-1228 rule 3),
   * in this order: CI workflows (`node-version:` / `python-version:`, each matrix value),
   * `.tool-versions`, `mise.toml`, a Dockerfile's `FROM`, the `@types/node` major, and the Python
   * range of the installed Django. `value` is as written (`20`, `3.11`, `>=3.10,<3.15`); `source`
   * is the file it came from, or the framework and version for a table (`Django 5.2`). Absent when
   * nothing was found.
   */
  runtimeEvidence: z
    .strictObject({
      node: z.array(RuntimeEvidenceSchema).min(1).optional(),
      python: z.array(RuntimeEvidenceSchema).min(1).optional(),
    })
    .optional(),
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
        /** The variable the app reads the service's URL from, when detection finds it. */
        variable: EnvVarNameSchema.optional(),
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
  /** Processes besides the web process: Procfile types and job libraries. Absent when none. */
  workers: z
    .array(
      z.strictObject({
        /** The Procfile type, or the library's conventional name. */
        name: z.string().min(1),
        /** Absent when no convention gives it (BullMQ): the interview asks. */
        command: CommandLineSchema.optional(),
        source: z.enum(["procfile", "library"]),
        /** A scheduler that must run exactly once. */
        single: z.boolean(),
        evidence: z.array(z.string().min(1)),
      }),
    )
    .min(1)
    .optional(),
  /** Scheduled calls of the app's routes. Absent when none. */
  cronJobs: z
    .array(
      z.strictObject({
        schedule: z.string().min(1),
        route: UrlPathSchema,
        source: z.literal("vercel.json"),
      }),
    )
    .min(1)
    .optional(),
  /** Routing rules from `vercel.json`. Absent when the file has none. */
  platformRouting: PlatformRoutingSchema.optional(),
  /** Services the app reaches at a hosting provider (Atlas, PlanetScale, Upstash, Neon). */
  hostedServices: z
    .array(
      z.strictObject({
        kind: ServiceKindSchema,
        /** The variable that holds the service's URL. */
        variable: EnvVarNameSchema,
        /** The provider's name, for example `MongoDB Atlas`. */
        provider: z.string().min(1),
      }),
    )
    .min(1)
    .optional(),
  /** SQLite's database files, relative to the app, and their folder. Absent without SQLite. */
  sqlite: z
    .strictObject({
      paths: z.array(RepoPathSchema).min(1),
      dir: RepoPathSchema,
    })
    .optional(),
  /** The app's S3 client. Absent without one. */
  objectStorage: z
    .strictObject({
      /** The client library, for example `@aws-sdk/client-s3`. */
      client: z.string().min(1),
      /** True when the app hands browsers presigned upload URLs (the bucket then needs CORS). */
      presignedUploads: z.boolean(),
      /** The variable names the app reads its bucket and endpoint from. */
      variables: z.array(EnvVarNameSchema),
    })
    .optional(),
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
