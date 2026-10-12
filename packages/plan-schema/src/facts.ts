import { z } from "zod";
import {
  AppKindSchema,
  EnvVarNameSchema,
  LanguageSchema,
  PackageManagerSchema,
  PlatformExportSchema,
  PortSchema,
  RepoPathSchema,
  ServiceKindSchema,
  UrlPathSchema,
} from "./enums";

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
    outputDir: z.string().min(1).optional(),
  }),
  port: PortSchema.optional(),
  runtimeVersions: z.strictObject({
    node: z.string().min(1).optional(),
    python: z.string().min(1).optional(),
  }),
  envVars: z
    .array(
      z.strictObject({
        name: EnvVarNameSchema,
        files: z.array(RepoPathSchema),
        clientExposed: z.boolean(),
        secretLikely: z.boolean(),
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
  /** Repo-relative directory of the app the facts describe (absent or `.` for the root). */
  appDir: RepoPathSchema.optional(),
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
