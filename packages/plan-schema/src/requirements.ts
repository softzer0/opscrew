import { z } from "zod";
import { ComponentNameSchema, StorageSchema } from "./components";
import {
  CommandLineSchema,
  CurrencySchema,
  DataCriticalitySchema,
  DeployProviderSchema,
  FqdnSchema,
  IsoDateTimeSchema,
  RegionSchema,
  RepoPathSchema,
  ServiceKindSchema,
  UptimeSchema,
  UserScaleSchema,
} from "./enums";

/** `opscrew/requirements.yaml`: the user's answers from the interview. */
export const RequirementsSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    answeredAt: IsoDateTimeSchema,
    expectedMonthlyUsers: UserScaleSchema,
    budgetMonthly: z.strictObject({
      amount: z.number().positive(),
      currency: CurrencySchema,
    }),
    /** Where to run the app. */
    provider: DeployProviderSchema,
    /**
     * Where most users are; picks the provider's location. Required unless `provider` is `own` or
     * `portainer` (a server the user owns or runs Portainer on stays where it is, so a region given
     * for it is ignored).
     */
    region: RegionSchema.optional(),
    uptime: UptimeSchema,
    dataCriticality: DataCriticalitySchema,
    /** Lower-case FQDN, for example `app.example.com`. */
    domain: FqdnSchema.optional(),
    /** `cloudflare` or `other` requires `domain`. */
    dnsProvider: z.enum(["cloudflare", "other", "none"]),
    /**
     * Whether the app keeps each service where it is hosted now, by kind: `true` keeps it (for
     * example `supabase` instead of Postgres on the server), `false` lets OpsCrew run one on the
     * server. A hosted service the app uses with no answer is kept; any other kind is kept only
     * when its answer is `true`. For `s3`, only `false` lets OpsCrew plan a bucket: `true` and no
     * answer keep the app's own storage (FR-1316a).
     */
    keepExternalServices: z.partialRecord(ServiceKindSchema, z.boolean()).default(() => ({})),
    /**
     * Where OpsCrew creates the app's bucket when `keepExternalServices.s3` is `false`: one of the
     * providers design offers for the target (`garage` on every target). Absent: design picks the
     * default.
     */
    objectStorage: StorageSchema.shape.objectStorage.unwrap().shape.provider.optional(),
    /** Commands of detected workers that no convention gives one (BullMQ, asynq, river), by worker name. */
    workerCommands: z.record(ComponentNameSchema, CommandLineSchema).optional(),
    /** Used for TLS certificate registration. */
    contactEmail: z.email().optional(),
    /** In a repository with several apps: the repo-relative directory of the app to deploy. */
    appDir: RepoPathSchema.optional(),
    /**
     * Sign each pushed image with cosign keyless (absent means no). For a private repository, the
     * repository's name and workflow appear in Sigstore's public log; the interview says so.
     */
    signImages: z.boolean().optional(),
    /**
     * Tag each deploy that passes its health check: a git tag, or a tag plus a GitHub Release naming
     * the image digest (absent means off).
     */
    deployTags: z.enum(["off", "tag", "tag-and-release"]).optional(),
    /** Free text from the user. */
    notes: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.provider !== "own" && value.provider !== "portainer" && value.region === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["region"],
        message: `is required when provider is "${value.provider}"`,
      });
    }
    if (value.dnsProvider !== "none" && value.domain === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["domain"],
        message: `is required when dnsProvider is "${value.dnsProvider}"`,
      });
    }
  });
export type Requirements = z.infer<typeof RequirementsSchema>;
