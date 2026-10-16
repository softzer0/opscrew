import { z } from "zod";
import { CostEstimateSchema } from "./design";
import {
  type CloudProvider,
  CloudProviderSchema,
  CodeChangeKindSchema,
  CodeChangeStatusSchema,
  CommandLineSchema,
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
} from "./enums";

/** Services that conflict with a self-hosted Postgres container. */
const POSTGRES_PROVIDERS = new Set(["postgres", "supabase"]);

/**
 * A server OpsCrew creates on Hetzner Cloud or DigitalOcean: provider, location, server size, image
 * and backups.
 */
export const CloudTargetSchema = z.strictObject({
  provider: CloudProviderSchema,
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

/**
 * A server the user already owns. OpsCrew neither creates nor deletes it and has no say over its
 * location, size, operating system or backups. Its address and SSH login are never committed:
 * they live in OpsCrew's local state (`.opscrew/server.json`).
 */
export const OwnTargetSchema = z.strictObject({
  provider: z.literal("own"),
  mode: z.literal("vps-compose"),
  /** The server's CPU architecture, from inspection; the app image is built for it. */
  arch: z.enum(["amd64", "arm64"]),
  /**
   * `public`: the internet reaches the server directly. `tunnel`: the server has no public address
   * and is served through a Cloudflare Tunnel (which needs a domain on Cloudflare).
   */
  access: z.enum(["public", "tunnel"]),
});

/**
 * How visitors reach an app on a Portainer target. `tunnel`: a Cloudflare Tunnel connector in the
 * app's stack (needs a domain on Cloudflare). `proxy`: the app is published on a host port the
 * user routes to (no TLS from OpsCrew). `caddy`: Caddy publishes ports 80 and 443 with automatic
 * certificates (needs a domain).
 */
export const PortainerWebSchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("tunnel") }),
  z.strictObject({
    mode: z.literal("proxy"),
    /** The host port the app is published on. */
    port: PortSchema,
  }),
  z.strictObject({ mode: z.literal("caddy") }),
]);

/**
 * A Portainer the user already runs: OpsCrew deploys the app as Portainer stacks in one Docker
 * environment and never changes the host. Portainer's address and certificate are never committed:
 * they live in OpsCrew's local state (`.opscrew/server.json`), the access token only in the
 * environment (`PORTAINER_API_KEY`).
 */
export const PortainerTargetSchema = z.strictObject({
  provider: z.literal("portainer"),
  mode: z.literal("portainer-stack"),
  /** Portainer's id of the environment (a single Docker host) the stacks run in. */
  environmentId: z.int().positive(),
  /** The environment's CPU architecture, from its Docker info; the app image is built for it. */
  arch: z.enum(["amd64", "arm64"]),
  /**
   * How a new image reaches Portainer. `updater`: a small stack calls the app stack's webhook
   * inside the host. `cloudflare`: the deploy workflow calls the webhook through Cloudflare Access
   * (needs a domain on Cloudflare).
   */
  redeploy: z.enum(["updater", "cloudflare"]),
  web: PortainerWebSchema,
});

/**
 * Where the app runs: a server OpsCrew creates (Hetzner, DigitalOcean), the user's own server, or
 * the user's existing Portainer.
 */
export const DeployTargetSchema = z.discriminatedUnion("provider", [
  CloudTargetSchema,
  OwnTargetSchema,
  PortainerTargetSchema,
]);

/**
 * A pinned release version such as `2.33.1` (optionally with a suffix such as `2.33.1-alpine`);
 * floating tags (`latest`, `lts`, `sts`) are refused so every server runs the version in the plan.
 */
const PinnedVersionSchema = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/, {
  message: "must be a pinned version such as `2.33.1`, not a floating tag such as `latest`",
});

/**
 * Portainer CE, an optional web interface for the server's containers. Off by default; when on, it
 * listens only on the server itself unless the user opts in to a subdomain behind Cloudflare Access.
 */
export const PortainerSchema = z
  .strictObject({
    enabled: z.boolean().default(false),
    /** Pinned Portainer CE image version. */
    version: PinnedVersionSchema,
    /** `local`: reachable only through an SSH tunnel. `subdomain`: behind Cloudflare Access. */
    access: z.enum(["local", "subdomain"]).default("local"),
    /**
     * Subdomain of the app's Cloudflare zone (not the app's own domain); only and always with
     * `subdomain`.
     */
    hostname: FqdnSchema.optional(),
    /** Email addresses Cloudflare Access lets in; only with `subdomain`, at least one there. */
    allowedEmails: z.array(z.email()).optional(),
  })
  .superRefine((portainer, ctx) => {
    if (portainer.access !== "subdomain") {
      for (const field of ["hostname", "allowedEmails"] as const) {
        if (portainer[field] !== undefined) {
          ctx.addIssue({
            code: "custom",
            path: [field],
            message: 'is only allowed when access is "subdomain"',
          });
        }
      }
      return;
    }
    if (portainer.hostname === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["hostname"],
        message: 'is required when access is "subdomain"',
      });
    }
    if ((portainer.allowedEmails ?? []).length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["allowedEmails"],
        message: 'must list at least one email address when access is "subdomain"',
      });
    }
  });

/**
 * A Portainer subdomain is served through Cloudflare (tunnel and Access), so it needs the app's
 * Cloudflare DNS: a hostname inside the zone, but not the app's own domain or its `www.` alias.
 */
function checkPortainerSubdomain(plan: DeployPlanFields, ctx: z.RefinementCtx): void {
  const { dns, portainer } = plan;
  if (portainer?.access !== "subdomain") return;
  if (dns.provider !== "cloudflare") {
    ctx.addIssue({
      code: "custom",
      path: ["portainer", "access"],
      message:
        'can be "subdomain" only when dns.provider is "cloudflare": the subdomain is served through Cloudflare',
    });
    return;
  }
  if (dns.zone === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["dns", "zone"],
      message: 'is required when portainer.access is "subdomain"',
    });
    return;
  }
  const { hostname } = portainer;
  // A missing or malformed hostname already has its own issue.
  if (hostname === undefined || !FqdnSchema.safeParse(hostname).success) return;
  if (!hostname.endsWith(`.${dns.zone}`)) {
    ctx.addIssue({
      code: "custom",
      path: ["portainer", "hostname"],
      message: `must be a subdomain of ${dns.zone}, the app's Cloudflare zone`,
    });
  }
  if (dns.domain !== undefined && (hostname === dns.domain || hostname === `www.${dns.domain}`)) {
    ctx.addIssue({
      code: "custom",
      path: ["portainer", "hostname"],
      message: `must differ from the app's domain (${dns.domain}) and its www. alias`,
    });
  }
}

/**
 * Why a name Cloudflare's proxy serves would fail HTTPS at Cloudflare's edge, with a name that
 * would work. Cloudflare's free (Universal SSL) certificate covers only the zone and its
 * first-level subdomains (`<zone>` and `*.<zone>`), not deeper names such as
 * `portainer.shop.example.com`:
 * https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/limitations/
 * Returns `undefined` for the zone itself, a name exactly one label below it, or a name outside
 * the zone (checked elsewhere).
 */
export function cloudflareEdgeCoverage(
  name: string,
  zone: string,
): { reason: string; suggestion: string } | undefined {
  if (!name.endsWith(`.${zone}`)) return undefined;
  const labels = name.slice(0, -(zone.length + 1)).split(".");
  if (labels.length < 2) return undefined;
  return {
    reason: `Cloudflare's free certificate covers only ${zone} and *.${zone}, so ${name} would fail HTTPS at Cloudflare's edge`,
    suggestion: `${labels.join("-")}.${zone}`,
  };
}

/** Second-level labels under a country code that are registries, not names (`co.uk`, `com.au`). */
const COUNTRY_SECOND_LEVELS = new Set([
  "ac",
  "co",
  "com",
  "edu",
  "gob",
  "gov",
  "ltd",
  "ne",
  "net",
  "nom",
  "or",
  "org",
  "plc",
]);

/**
 * The Cloudflare zone a domain most likely belongs to, for checks made before Cloudflare is asked
 * (the interview, design): the registrable domain, `example.com` for `api.shop.example.com` and
 * `example.co.uk` for `shop.example.co.uk`. A guess without the public suffix list; once
 * provision learns the real zone (`dns.zone`) the plan schema checks against that.
 */
export function likelyCloudflareZone(domain: string): string {
  const labels = domain.split(".");
  const tld = labels.at(-1) ?? "";
  const second = labels.at(-2) ?? "";
  const size = tld.length === 2 && COUNTRY_SECOND_LEVELS.has(second) ? 3 : 2;
  return labels.slice(-size).join(".");
}

/**
 * Every name Cloudflare's proxy serves for the app must be the zone or one label below it (see
 * {@link cloudflareEdgeCoverage}): the domain when proxied or behind the tunnel, its `www.` alias
 * then, and a Portainer subdomain. DNS-only names get Caddy's own certificates and are unaffected.
 */
function checkCloudflareEdgeNames(plan: DeployPlanFields, ctx: z.RefinementCtx): void {
  const { dns, target, portainer } = plan;
  const zone = dns.zone;
  if (dns.provider !== "cloudflare" || zone === undefined) return;
  const ownTunnel = target.provider === "own" && target.access === "tunnel";
  const portainerTunnel = target.provider === "portainer" && target.web?.mode === "tunnel";
  const served = dns.proxied || ownTunnel || portainerTunnel;
  const instead = ownTunnel
    ? 'if the internet can reach your server, serve it directly with DNS only instead of the tunnel (target.access "public", dns.proxied false)'
    : portainerTunnel
      ? 'if the internet can reach your Portainer host, serve it with Caddy and DNS only instead of the tunnel (target.web.mode "caddy", dns.proxied false)'
      : undefined;
  const domain = dns.domain;
  if (served && domain !== undefined) {
    const deep = cloudflareEdgeCoverage(domain, zone);
    if (deep !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["dns", "domain"],
        message: `must be ${zone} or one level below it: ${deep.reason}; use a name one level below ${zone}, such as ${deep.suggestion}, or ${
          instead ?? "serve it without Cloudflare's proxy (dns.proxied false)"
        }`,
      });
    } else if (dns.www) {
      const www = cloudflareEdgeCoverage(`www.${domain}`, zone);
      if (www !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["dns", "www"],
          message: `can be true only when the domain is ${zone} itself while Cloudflare serves it: ${www.reason}; turn off the www. alias (dns.www false), or ${
            instead ?? "serve the domain without Cloudflare's proxy (dns.proxied false)"
          }`,
        });
      }
    }
  }
  const hostname = portainer?.access === "subdomain" ? portainer.hostname : undefined;
  // The app's own names as Portainer's hostname already have their own issue.
  if (hostname !== undefined && hostname !== domain && hostname !== `www.${domain}`) {
    const deep = cloudflareEdgeCoverage(hostname, zone);
    if (deep !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["portainer", "hostname"],
        message: `must be one level below ${zone}: ${deep.reason}; use a name one level below ${zone}, such as ${deep.suggestion}`,
      });
    }
  }
}

/**
 * The rules of a Portainer target: what Cloudflare serves (the tunnel, the webhook behind Access)
 * needs a domain on Cloudflare, Caddy's certificates need a domain, a move to or from Portainer is
 * not available, and OpsCrew never installs Portainer CE next to an existing Portainer.
 */
function checkPortainerTarget(
  target: z.output<typeof PortainerTargetSchema>,
  plan: DeployPlanFields,
  ctx: z.RefinementCtx,
): void {
  const { dns } = plan;
  // The zone is learned from Cloudflare at provision, before rendering (as for an own tunnel).
  const onCloudflare = dns.provider === "cloudflare" && dns.domain !== undefined;
  if (target.web.mode === "tunnel" && !onCloudflare) {
    ctx.addIssue({
      code: "custom",
      path: ["target", "web", "mode"],
      message:
        'can be "tunnel" only with a domain on Cloudflare (dns.provider "cloudflare" with dns.domain): the tunnel serves the app on that domain; without one, use "proxy" (a port you route to) or "caddy" (with a domain)',
    });
  }
  if (target.redeploy === "cloudflare" && !onCloudflare) {
    ctx.addIssue({
      code: "custom",
      path: ["target", "redeploy"],
      message:
        'can be "cloudflare" only with a domain on Cloudflare (dns.provider "cloudflare" with dns.domain): the deploy workflow reaches Portainer through Cloudflare Access in that zone; without one, use "updater"',
    });
  }
  if (target.web.mode === "caddy" && dns.domain === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["target", "web", "mode"],
      message:
        'can be "caddy" only with a domain (dns.domain): Caddy gets the certificates for that name; without one, use "proxy"',
    });
  }
  if (plan.retarget !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["retarget"],
      message: "moving an app to or from an existing Portainer is not available",
    });
  }
  if (plan.portainer !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["portainer"],
      message:
        "is not available with a Portainer target: OpsCrew deploys into your existing Portainer and does not install another one",
    });
  }
}

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
 * state (`.opscrew/server.json`). Moves to or from a server the user owns are not available.
 */
export const RetargetSchema = z.strictObject({
  /** The deployment being replaced. */
  from: z.strictObject({ target: CloudTargetSchema }),
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

const DeployPlanFieldsSchema = z.strictObject({
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
    /**
     * Runs before each new version takes traffic (database migrations), in a one-off container
     * of the new image with the app's environment, from the image's working folder. A failure
     * stops the deploy and the previous version keeps serving. Change or remove it freely.
     */
    releaseCommand: CommandLineSchema.optional(),
    /** Names only, never values. */
    env: z.array(
      z.strictObject({
        name: EnvVarNameSchema,
        secret: z.boolean(),
        /**
         * `user`: the user provides it; `generated`: a random secret OpsCrew creates;
         * `derived`: OpsCrew fills it from the deployment (container URLs, the domain).
         */
        source: z.enum(["user", "generated", "derived"]),
        /**
         * True when the code has a default for it: `provision` may leave it unset and the app
         * keeps that default. Absent means false (a value is required).
         */
        optional: z.boolean().optional(),
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
  /** Portainer CE on the server; absent means off. */
  portainer: PortainerSchema.optional(),
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
});

/** A parsed plan before its cross-field rules and its defaults that depend on other fields. */
type DeployPlanFields = z.output<typeof DeployPlanFieldsSchema>;

const DeployPlanObjectSchema = DeployPlanFieldsSchema.superRefine((plan, ctx) => {
  if (plan.dns.provider === "cloudflare" && plan.dns.domain === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["dns", "domain"],
      message: 'is required when dns.provider is "cloudflare"',
    });
  }
  if (
    plan.target.provider === "own" &&
    plan.target.access === "tunnel" &&
    // The zone is learned from Cloudflare at provision, before rendering (the renderer requires it).
    (plan.dns.provider !== "cloudflare" || plan.dns.domain === undefined)
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["target", "access"],
      message:
        'can be "tunnel" only with a domain on Cloudflare (dns.provider "cloudflare" with dns.domain): the tunnel serves the app on that domain',
    });
  }
  if (
    plan.target.provider === "own" &&
    plan.target.access === "public" &&
    plan.dns.provider === "cloudflare" &&
    plan.dns.proxied &&
    plan.security.httpAllowedFrom === "any"
  ) {
    // Docker-published ports bypass the server's firewall: behind the proxy only OpsCrew's
    // filter for Cloudflare's addresses keeps visitors from going around Cloudflare.
    ctx.addIssue({
      code: "custom",
      path: ["security", "httpAllowedFrom"],
      message:
        'must be "cloudflare" when your own server serves the site directly behind Cloudflare\'s proxy (only OpsCrew\'s filter then keeps visitors from reaching the server around Cloudflare); to let everyone reach the server, set dns.proxied to false (DNS only), or use a Cloudflare Tunnel (target.access "tunnel")',
    });
  }
  if (plan.retarget !== undefined && plan.target.provider === "own") {
    ctx.addIssue({
      code: "custom",
      path: ["retarget"],
      message: "moving an app to or from a server you already own is not available",
    });
  }
  if (plan.target.provider === "portainer") checkPortainerTarget(plan.target, plan, ctx);
  checkPortainerSubdomain(plan, ctx);
  checkCloudflareEdgeNames(plan, ctx);
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
 * Ubuntu 24.04 LTS image name per cloud provider, used when `target.image` is omitted. A server the
 * user owns has no image: OpsCrew never installs its operating system.
 */
export const DEFAULT_IMAGES: Readonly<Record<CloudProvider, string>> = {
  hetzner: "ubuntu-24.04",
  digitalocean: "ubuntu-24-04-x64",
};

/** A cloud target with its image filled in from `DEFAULT_IMAGES` when omitted. */
function withImage(target: z.output<typeof CloudTargetSchema>) {
  return { ...target, image: target.image ?? DEFAULT_IMAGES[target.provider] };
}

/** The target with a cloud target's image filled in; an own-server or Portainer target as it is. */
function withTargetDefaults(target: z.output<typeof DeployTargetSchema>) {
  return target.provider === "own" || target.provider === "portainer" ? target : withImage(target);
}

/**
 * `opscrew/plan.yaml`: the chosen deployment. Parsing fills every documented default, including
 * `security.httpAllowedFrom` (`cloudflare` when `dns.proxied`, else `any`).
 */
export const DeployPlanSchema = DeployPlanObjectSchema.transform((plan) => ({
  ...plan,
  target: withTargetDefaults(plan.target),
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

/** Where the app runs, with a cloud target's image filled in. */
export type DeployTarget = DeployPlan["target"];
/** A server OpsCrew creates on Hetzner Cloud or DigitalOcean, with its image filled in. */
export type CloudDeployTarget = Extract<DeployTarget, { provider: CloudProvider }>;
/** A server the user already owns. */
export type OwnDeployTarget = Extract<DeployTarget, { provider: "own" }>;
/** A Portainer the user already runs. */
export type PortainerDeployTarget = Extract<DeployTarget, { provider: "portainer" }>;
/** A target on one server: Hetzner Cloud, DigitalOcean or a server the user owns. */
export type VpsDeployTarget = Exclude<DeployTarget, { provider: "portainer" }>;

/** True when the app runs on one server (Hetzner Cloud, DigitalOcean, own), not in a Portainer. */
export function isVpsTarget(target: DeployTarget): target is VpsDeployTarget {
  return target.provider !== "portainer";
}

/**
 * The plain refusal (code `PHASE_PRECONDITION`) of a command that does not handle a Portainer
 * target yet, while feature 010 is built. Callers throw it as an `OpsCrewError`.
 */
export const PORTAINER_TARGET_NOT_YET = {
  message: "A Portainer target is not supported by this command yet.",
  hint: "Deploy to Hetzner Cloud, DigitalOcean or a server you own for now: run `opscrew interview` and `opscrew design` again and choose one of them.",
} as const;

/**
 * The plain refusal (code `PHASE_PRECONDITION`) of `opscrew retarget` for a Portainer target,
 * which never moves to or from another target. Callers throw it as an `OpsCrewError`.
 */
export const PORTAINER_TARGET_NO_MOVE = {
  message:
    "Moving an app to or from a Portainer target is not supported; destroy it and provision again.",
  hint: "Run `opscrew destroy`, then `opscrew interview`, `opscrew design` and `opscrew provision` for the new target.",
} as const;
/** How visitors reach an app on a Portainer target. */
export type PortainerWeb = PortainerDeployTarget["web"];
/** A move to another provider in progress. */
export type Retarget = NonNullable<DeployPlan["retarget"]>;
/** Portainer CE settings with their defaults filled in. */
export type PortainerSettings = NonNullable<DeployPlan["portainer"]>;
