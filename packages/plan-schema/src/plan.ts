import { z } from "zod";
import { CostEstimateSchema } from "./design";
import {
  CodeChangeKindSchema,
  CodeChangeStatusSchema,
  EnvVarNameSchema,
  FqdnSchema,
  IsoDateTimeSchema,
  PhaseNameSchema,
  PlanHashSchema,
  PortSchema,
  RepoPathSchema,
  ServiceKindSchema,
  UrlPathSchema,
} from "./enums";

/** Services that conflict with a self-hosted Postgres container. */
const POSTGRES_PROVIDERS = new Set(["postgres", "supabase"]);

const DeployPlanObjectSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
    app: z.strictObject({
      /** DNS-label safe; used for resource names. */
      name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/, {
        message:
          "must be 1-41 lower-case letters, digits or hyphens and start with a letter or digit",
      }),
      /** Container port. */
      port: PortSchema,
      healthPath: UrlPathSchema.default("/health"),
      buildContext: RepoPathSchema.default("."),
      dockerfile: RepoPathSchema.default("Dockerfile"),
      /** Names only, never values. */
      env: z.array(
        z.strictObject({
          name: EnvVarNameSchema,
          secret: z.boolean(),
          source: z.enum(["user", "generated", "derived"]),
        }),
      ),
    }),
    target: z.strictObject({
      provider: z.literal("hetzner"),
      mode: z.literal("vps-compose"),
      /** For example `nbg1`. */
      location: z.string().min(1),
      /** For example `cpx22`. */
      serverType: z.string().min(1),
      image: z.string().min(1).default("ubuntu-24.04"),
      /** Hetzner automated backups. */
      backups: z.boolean(),
    }),
    services: z.strictObject({ postgres: z.boolean(), redis: z.boolean() }),
    externalServices: z.array(ServiceKindSchema),
    cost: CostEstimateSchema,
    codeChanges: z.array(
      z.strictObject({
        id: z.string().min(1),
        kind: CodeChangeKindSchema,
        path: RepoPathSchema,
        reason: z.string().min(1),
        status: CodeChangeStatusSchema,
      }),
    ),
    infra: z
      .strictObject({
        engine: z.enum(["auto", "tofu", "terraform"]).default("auto"),
        dir: RepoPathSchema.default("opscrew/infra/prod"),
        /** Effective only with OpenTofu. */
        stateEncryption: z.boolean().default(true),
      })
      .prefault({}),
    dns: z.strictObject({
      provider: z.enum(["cloudflare", "none"]),
      /** Required when `provider` is `cloudflare`. */
      domain: FqdnSchema.optional(),
      /** Registrable zone, for example `example.com`. */
      zone: FqdnSchema.optional(),
      proxied: z.boolean().default(true),
      /** Also serve `www.<domain>`. */
      www: z.boolean().default(false),
    }),
    cicd: z.strictObject({
      provider: z.literal("github-actions"),
      workflowPath: RepoPathSchema.default(".github/workflows/opscrew-deploy.yml"),
      registry: z.literal("ghcr"),
      /** Deploys run on pushes to this branch. */
      branch: z.string().min(1).default("main"),
    }),
    security: z
      .strictObject({
        sshAllowedCidrs: z
          .array(z.union([z.cidrv4(), z.cidrv6()]))
          .default(() => ["0.0.0.0/0", "::/0"]),
        /** Defaults to `cloudflare` when `dns.proxied`, else `any`. */
        httpAllowedFrom: z.enum(["any", "cloudflare"]).optional(),
        wafCustomRules: z.boolean().default(true),
        imageScan: z.boolean().default(true),
      })
      .prefault({}),
    /** Informational copy of approvals; the approval store is authoritative. */
    approvals: z
      .array(
        z.strictObject({
          planHash: PlanHashSchema,
          approver: z.string().min(1),
          at: IsoDateTimeSchema,
          kind: z.string().min(1),
        }),
      )
      .default(() => []),
    deployment: z
      .strictObject({
        lastCompletedPhase: PhaseNameSchema.optional(),
        serverIpv4: z.ipv4().optional(),
        serverIpv6: z.ipv6().optional(),
        url: z.url({ protocol: /^https?$/ }).optional(),
        lastPlanHash: PlanHashSchema.optional(),
        lastApplyAt: IsoDateTimeSchema.optional(),
        lastDeployAt: IsoDateTimeSchema.optional(),
      })
      .prefault({}),
  })
  .superRefine((plan, ctx) => {
    if (plan.dns.provider === "cloudflare" && plan.dns.domain === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["dns", "domain"],
        message: 'is required when dns.provider is "cloudflare"',
      });
    }
    if (plan.services.postgres) {
      plan.externalServices.forEach((service, i) => {
        if (POSTGRES_PROVIDERS.has(service)) {
          ctx.addIssue({
            code: "custom",
            path: ["externalServices", i],
            message: `"${service}" conflicts with services.postgres: use either the self-hosted Postgres container or the external database, not both`,
          });
        }
      });
    }
  });

/**
 * `opscrew/plan.yaml`: the chosen deployment. Parsing fills every documented default, including
 * `security.httpAllowedFrom` (`cloudflare` when `dns.proxied`, else `any`).
 */
export const DeployPlanSchema = DeployPlanObjectSchema.transform((plan) => ({
  ...plan,
  security: {
    sshAllowedCidrs: plan.security.sshAllowedCidrs,
    httpAllowedFrom:
      plan.security.httpAllowedFrom ??
      (plan.dns.proxied ? ("cloudflare" as const) : ("any" as const)),
    wafCustomRules: plan.security.wafCustomRules,
    imageScan: plan.security.imageScan,
  },
}));
export type DeployPlan = z.output<typeof DeployPlanSchema>;
