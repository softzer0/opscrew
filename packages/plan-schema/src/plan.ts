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
  RegistrarSchema,
  RepoPathSchema,
  ServiceKindSchema,
  UrlPathSchema,
  type VpsProvider,
  VpsProviderSchema,
} from "./enums";

/** Services that conflict with a self-hosted Postgres container. */
const POSTGRES_PROVIDERS = new Set(["postgres", "supabase"]);

/** Where the app runs: provider, location, server size, image and backups. */
export const DeployTargetSchema = z.strictObject({
  provider: VpsProviderSchema,
  mode: z.literal("vps-compose"),
  /** Provider location or region, for example `nbg1` (Hetzner) or `fra1` (DigitalOcean). */
  location: z.string().min(1),
  /** Provider server type or size, for example `cpx22` or `s-2vcpu-4gb`. */
  serverType: z.string().min(1),
  /** Provider image name; the provider's Ubuntu 24.04 image when omitted (`DEFAULT_IMAGES`). */
  image: z.string().min(1).optional(),
  /** The provider's automated daily backups. */
  backups: z.boolean(),
});

/** True when `host` (a URL's hostname) is an IPv4 or bracketed IPv6 address, not a name. */
function isIpHost(host: string): boolean {
  return (
    z.ipv4().safeParse(host).success || z.ipv6().safeParse(host.replace(/^\[|\]$/g, "")).success
  );
}

/**
 * The app's public URL as committed in `opscrew/plan.yaml`: it must name a domain. A URL on the
 * server's IP address would publish the address, which OpsCrew keeps in its local state
 * (`.opscrew/server.json`) instead.
 */
const DomainUrlSchema = z
  .url({ protocol: /^https?$/ })
  .refine((url) => !isIpHost(new URL(url).hostname), {
    message:
      "must name the app's domain, not the server's IP address (OpsCrew keeps the address in .opscrew/server.json, outside the repository)",
  });

/**
 * A move to another provider in progress (`opscrew retarget`). `plan.target` is already the new
 * target; `plan.deployment` describes the deployment that receives traffic (the old server until
 * the DNS switch). The servers' addresses are never committed: OpsCrew keeps them in its local
 * state (`.opscrew/server.json`).
 */
export const RetargetSchema = z.strictObject({
  /** The deployment being replaced. */
  from: z.strictObject({ target: DeployTargetSchema }),
  /** Last completed step. */
  step: z.enum(["started", "renamed", "created", "deployed", "migrated", "switched"]),
  /** Set while OpsCrew keeps the old server's app stopped (maintenance window, after the switch). */
  oldAppStoppedAt: IsoDateTimeSchema.optional(),
  /** Present once `opscrew retarget --abort` began: its last completed step. */
  abort: z
    .strictObject({ step: z.enum(["started", "new-removed", "secrets-restored"]) })
    .optional(),
  startedAt: IsoDateTimeSchema,
});

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
    target: DeployTargetSchema,
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
      /** Set when OpsCrew bought the domain (`opscrew domain buy`). */
      registration: z
        .strictObject({
          registrar: RegistrarSchema,
          registeredAt: IsoDateTimeSchema.optional(),
          expiresAt: IsoDateTimeSchema.optional(),
          autoRenew: z.boolean(),
          privacy: z.boolean(),
          dnssec: z.boolean(),
        })
        .optional(),
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
    /**
     * What was deployed and when. The server's IP addresses are never committed (in a public
     * repository they would let anyone go around Cloudflare's proxy): OpsCrew keeps them in its
     * local state, `.opscrew/server.json`.
     */
    deployment: z
      .strictObject({
        lastCompletedPhase: PhaseNameSchema.optional(),
        /** The app's public URL on its domain; absent without a domain. */
        url: DomainUrlSchema.optional(),
        lastPlanHash: PlanHashSchema.optional(),
        lastApplyAt: IsoDateTimeSchema.optional(),
        lastDeployAt: IsoDateTimeSchema.optional(),
        /** When `opscrew destroy` removed the infrastructure. */
        destroyedAt: IsoDateTimeSchema.optional(),
      })
      .prefault({}),
    retarget: RetargetSchema.optional(),
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

/** Ubuntu 24.04 LTS image name per provider, used when `target.image` is omitted. */
export const DEFAULT_IMAGES: Readonly<Record<VpsProvider, string>> = {
  hetzner: "ubuntu-24.04",
  digitalocean: "ubuntu-24-04-x64",
};

/** The target with its image filled in from `DEFAULT_IMAGES` when omitted. */
function withImage(target: z.output<typeof DeployTargetSchema>) {
  return { ...target, image: target.image ?? DEFAULT_IMAGES[target.provider] };
}

/**
 * `opscrew/plan.yaml`: the chosen deployment. Parsing fills every documented default, including
 * `security.httpAllowedFrom` (`cloudflare` when `dns.proxied`, else `any`).
 */
export const DeployPlanSchema = DeployPlanObjectSchema.transform((plan) => ({
  ...plan,
  target: withImage(plan.target),
  ...(plan.retarget === undefined
    ? {}
    : {
        retarget: {
          ...plan.retarget,
          from: { ...plan.retarget.from, target: withImage(plan.retarget.from.target) },
        },
      }),
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

/** Where the app runs, with the image filled in. */
export type DeployTarget = DeployPlan["target"];
/** A move to another provider in progress. */
export type Retarget = NonNullable<DeployPlan["retarget"]>;
