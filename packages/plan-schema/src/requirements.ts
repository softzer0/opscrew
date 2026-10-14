import { z } from "zod";
import {
  CurrencySchema,
  DataCriticalitySchema,
  FqdnSchema,
  IsoDateTimeSchema,
  RegionSchema,
  RepoPathSchema,
  ServiceKindSchema,
  UptimeSchema,
  UserScaleSchema,
  VpsProviderSchema,
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
    /** Where to run the app; absent in files written before feature 004, which means Hetzner. */
    provider: VpsProviderSchema.optional(),
    /**
     * Where most users are; picks the provider's location. Required unless `provider` is `own`
     * (a server the user owns stays where it is, so a region given for it is ignored).
     */
    region: RegionSchema.optional(),
    uptime: UptimeSchema,
    dataCriticality: DataCriticalitySchema,
    /** Lower-case FQDN, for example `app.example.com`. */
    domain: FqdnSchema.optional(),
    /** `cloudflare` or `other` requires `domain`. */
    dnsProvider: z.enum(["cloudflare", "other", "none"]),
    /** External services to keep (for example `supabase` instead of self-hosting Postgres). */
    keepExternalServices: z.array(ServiceKindSchema),
    /** Used for TLS certificate registration. */
    contactEmail: z.email().optional(),
    /** In a repository with several apps: the repo-relative directory of the app to deploy. */
    appDir: RepoPathSchema.optional(),
    /** Free text from the user. */
    notes: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.provider !== "own" && value.region === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["region"],
        message: `is required when provider is "${value.provider ?? "hetzner"}"`,
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
