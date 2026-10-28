import { posix } from "node:path";
import { ENVIRONMENT_NAME_MESSAGE, ENVIRONMENT_NAME_PATTERN } from "@opscrew/core";
import { z } from "zod";
import { AppKeySchema, infraDirFor, workflowPathFor } from "./apps";
import { PlanServiceSchema, ProcessesSchema, StorageSchema, serviceOf } from "./components";
import { CostEstimateSchema } from "./design";
import {
  type CloudProvider,
  CloudProviderSchema,
  CodeChangeKindSchema,
  CodeChangeStatusSchema,
  CommandLineSchema,
  EnvVarNameSchema,
  FqdnSchema,
  ImageBuilderSchema,
  IsoDateTimeSchema,
  isServerlessProvider,
  MemoryMbSchema,
  onOneServer,
  PlanHashSchema,
  PortSchema,
  RegistrarSchema,
  RepoPathSchema,
  RuntimeLanguageSchema,
  type ServerlessProvider,
  ServiceKindSchema,
  UrlPathSchema,
} from "./enums";
import { AbsolutePathSchema } from "./facts";

/** Services that conflict with a self-hosted Postgres container. */
const POSTGRES_PROVIDERS = new Set(["postgres", "supabase"]);

/**
 * The reverse proxy in front of every OpsCrew app on a server: Caddy (the default) or nginx with
 * certbot. Every OpsCrew app on one server uses the same one.
 */
const EdgeSchema = z.enum(["caddy", "nginx"]).default("caddy");

/**
 * A server OpsCrew creates on Hetzner Cloud or DigitalOcean: provider, location, server size, image,
 * backups and the reverse proxy.
 */
export const CloudTargetSchema = z.strictObject({
  provider: CloudProviderSchema,
  mode: z.literal("vps-compose"),
  /** Provider location or region, for example `nbg1` (Hetzner) or `fra1` (DigitalOcean). */
  location: z.string().min(1),
  /** Provider server type or size, for example `cpx22` or `s-2vcpu-4gb`. */
  serverType: z.string().min(1),
  /**
   * Provider image name; the provider's Ubuntu 24.04 image when omitted (`DEFAULT_IMAGES`). A later
   * design on the same provider keeps it.
   */
  image: z.string().min(1).optional(),
  /** The provider's automated daily backups. */
  backups: z.boolean(),
  edge: EdgeSchema,
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
  edge: EdgeSchema,
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
 * The user's own computer: the app's production stack runs in its Docker, served at
 * `https://<app>.localhost` on 127.0.0.1 only. It has no location, server type, price or DNS
 * record (`dns.provider` is `none`).
 */
export const LocalhostTargetSchema = z.strictObject({
  provider: z.literal("localhost"),
  mode: z.literal("local-compose"),
  /** The computer's CPU architecture, read at design. */
  arch: z.enum(["amd64", "arm64"]),
  /** The ports the edge listens on: 443 and 80 when free, else 8443 and 8080. */
  ports: z.strictObject({ https: z.literal([443, 8443]), http: z.literal([80, 8080]) }),
  /** `registry`: the production image. `local-build`: built on the computer for its architecture. */
  image: z.enum(["registry", "local-build"]),
  edge: EdgeSchema,
});

/**
 * How the deploy job builds a server-less site (`target.site`), in `app.buildContext`: the tool,
 * the build command and the folder of files it uploads, and for server rendering on Cloudflare the
 * Worker module the adapter builds and its compatibility flags (`entry` and `compatibilityFlags`,
 * checked by each target).
 */
export const SiteSchema = z
  .strictObject({
    /** `node` or `hugo` builds the site; `none`: the files are in the repository as they are. */
    tool: z.enum(["node", "hugo", "none"]),
    /** The package manager that installs and builds a `node` site. */
    packageManager: z.enum(["npm", "pnpm", "yarn", "bun"]).optional(),
    /**
     * Node.js for a `node` site: as the app declares it, else OpsCrew's default. Design sets it
     * from what analyze detects. A later design keeps yours unless the app declares an exact
     * version, or a range yours is outside of, and then says which version it uses.
     */
    nodeVersion: z
      .string()
      .regex(/^\d+(?:\.\d+){0,2}$/, { message: "must be a version such as `24` or `22.12`" })
      .optional(),
    /**
     * The build command. Design sets it from what analyze detects; a later design keeps yours
     * and names what analyze found, unless analyze finds another kind of site or folder.
     */
    command: CommandLineSchema.optional(),
    /**
     * The folder of static files that is uploaded. Design sets it from what analyze detects; a
     * later design keeps yours and names what analyze found, unless analyze finds another kind of
     * site or folder.
     */
    outputDir: RepoPathSchema,
    /** The Worker module the adapter builds, for server rendering on Cloudflare only. */
    entry: RepoPathSchema.optional(),
    /**
     * The Cloudflare compatibility flags the adapter's Worker needs, such as `nodejs_compat`, for
     * server rendering on Cloudflare only. Design sets them from the framework's adapter. Absent
     * (or empty) means none.
     */
    compatibilityFlags: z
      .array(
        z.string().regex(/^[a-z0-9_]+$/, {
          message:
            "must be a Cloudflare compatibility flag such as `nodejs_compat`: lower-case letters, digits and underscores",
        }),
      )
      .optional(),
  })
  .superRefine((site, ctx) => {
    const node = site.tool === "node";
    if (node !== (site.packageManager !== undefined)) {
      ctx.addIssue({
        code: "custom",
        path: ["packageManager"],
        message: node
          ? 'is required with tool "node": it installs the site\'s dependencies and runs its build (required with node, refused otherwise)'
          : `is refused with tool "${site.tool}": a package manager is required with node and refused otherwise`,
      });
    }
    if (!node && site.nodeVersion !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["nodeVersion"],
        message: `is refused with tool "${site.tool}": the Node.js version is for a node site only`,
      });
    }
    const builds = site.tool !== "none";
    if (builds !== (site.command !== undefined)) {
      ctx.addIssue({
        code: "custom",
        path: ["command"],
        message: builds
          ? `is required with tool "${site.tool}": the command that builds the site (required with node and hugo, refused with none)`
          : 'is refused with tool "none": the files are in the repository as they are, with nothing to build (required with node and hugo, refused with none)',
      });
    }
  });

/** A Worker's name at Cloudflare: lower-case letters, digits and hyphens, up to 63. */
const WorkerNameSchema = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/, {
  message:
    "must be a Worker name: 1-63 lower-case letters, digits or hyphens, starting and ending with a letter or digit",
});

/**
 * Cloudflare's hosting, on Workers with static assets: Cloudflare serves the built site from its
 * edge, and runs the app's server code as the Worker for a server-rendered app (`render: ssr`).
 * There is no server: no location, server type, image or reverse proxy.
 */
export const CloudflareWorkersTargetSchema = z
  .strictObject({
    provider: z.literal("cloudflare-workers"),
    mode: z.literal("workers-assets"),
    /**
     * The Worker's name, unique in the account: the app's name, `<app>-<env>` for another
     * environment. A later design keeps it.
     */
    worker: WorkerNameSchema,
    /** `static`: files only. `ssr`: the adapter's Worker renders pages per request. */
    render: z.enum(["static", "ssr"]),
    /**
     * What a path that is no file gets: the app itself (a single-page app), `404.html`, or a
     * plain 404. Design sets it from what analyze detects; a later design keeps yours and names
     * what analyze found, unless the site's rendering changed.
     */
    notFound: z.enum(["single-page-application", "404-page", "none"]),
    /** The Worker's `workers.dev` address. Off unless set here; a later design keeps it. */
    workersDev: z.boolean().default(false),
    /** Cloudflare's URL for each version. Off unless set here; a later design keeps it. */
    previewUrls: z.boolean().default(false),
    site: SiteSchema,
  })
  .superRefine((target, ctx) => {
    const ssr = target.render === "ssr";
    if (ssr !== (target.site.entry !== undefined)) {
      ctx.addIssue({
        code: "custom",
        path: ["site", "entry"],
        message: ssr
          ? 'is required with render "ssr": the Worker module the adapter builds (Cloudflare with render "ssr" only, and required there)'
          : 'is refused with render "static": a static site runs no server code (Cloudflare with render "ssr" only, and required there)',
      });
    }
    if (!ssr && (target.site.compatibilityFlags ?? []).length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["site", "compatibilityFlags"],
        message:
          'is refused with render "static": compatibility flags are for server-rendered apps on Cloudflare',
      });
    }
  });

/**
 * GitHub Pages: the repository's own workflow builds the site and GitHub publishes it, static files
 * only. There is no server, and no server code.
 */
export const GithubPagesTargetSchema = z
  .strictObject({
    provider: z.literal("github-pages"),
    mode: z.literal("pages-workflow"),
    site: SiteSchema,
  })
  .superRefine((target, ctx) => {
    if (target.site.entry !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["site", "entry"],
        message:
          'is refused with GitHub Pages: it serves static files only and runs no server code (Cloudflare with render "ssr" only)',
      });
    }
    if ((target.site.compatibilityFlags ?? []).length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["site", "compatibilityFlags"],
        message:
          "is refused with GitHub Pages: compatibility flags are for server-rendered apps on Cloudflare",
      });
    }
  });

/**
 * Where the app runs: a server OpsCrew creates (Hetzner, DigitalOcean), the user's own server, the
 * user's existing Portainer, the user's own computer, Cloudflare's hosting or GitHub Pages.
 */
export const DeployTargetSchema = z.discriminatedUnion("provider", [
  CloudTargetSchema,
  OwnTargetSchema,
  PortainerTargetSchema,
  LocalhostTargetSchema,
  CloudflareWorkersTargetSchema,
  GithubPagesTargetSchema,
]);

/** True for a server-less target (Cloudflare's hosting, GitHub Pages), narrowing it to them. */
export function isServerlessTarget<T extends { provider: string }>(
  target: T,
): target is Extract<T, { provider: ServerlessProvider }> {
  return isServerlessProvider(target.provider);
}

/**
 * The CPU architecture the app runs on, and its image is built for: the target's `arch`, or
 * `amd64` on a server OpsCrew creates (design offers x86 server types only).
 */
export function targetArch(target: z.output<typeof DeployTargetSchema>): "amd64" | "arm64" {
  return "arch" in target ? target.arch : "amd64";
}

/** An environment's name: lower-case letters, digits and hyphens, starting with a letter. */
export const EnvironmentNameSchema = z.string().regex(ENVIRONMENT_NAME_PATTERN, {
  message: ENVIRONMENT_NAME_MESSAGE,
});

/** A runner machine's name, unique in the project (`environment.runnerHost.name`). */
export const RUNNER_HOST_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
/** Why a name does not match {@link RUNNER_HOST_NAME_PATTERN}, starting with "must be". */
export const RUNNER_HOST_NAME_MESSAGE =
  "must be 1-32 lower-case letters, digits or hyphens and start with a letter: the name of a runner machine of the project, never its address";

/**
 * `plan.environment`: which of the app's environments this plan deploys, and how. Absent, or
 * without a `name`, the plan is the app's `prod` environment (`opscrew/plan.yaml`); every other
 * environment's plan names it (`opscrew/environments/<name>/plan.yaml`).
 */
export const EnvironmentSchema = z.strictObject({
  /** Absent for prod, which is never written by name. */
  name: EnvironmentNameSchema.refine((name) => name !== "prod", {
    message:
      'must not be "prod": the prod environment is the plan without a name (opscrew/plan.yaml)',
  }).optional(),
  /**
   * `main`: built and deployed on each push to `cicd.branch`. `promote`: deployed only by
   * `opscrew promote`, with the image the `source` environment runs.
   */
  deploySource: z
    .discriminatedUnion("from", [
      z.strictObject({ from: z.literal("main") }),
      z.strictObject({ from: z.literal("promote"), source: EnvironmentNameSchema }),
    ])
    .default(() => ({ from: "main" as const })),
  /**
   * Where the deploy job runs: `github` (GitHub's machines), `server` (a runner OpsCrew installs on
   * the server), `local` (a runner on the user's computer, for the localhost target) or `host` (a
   * runner on a runner machine of the project, `runnerHost`, which deploys over SSH).
   */
  runner: z.enum(["github", "server", "local", "host"]).default("github"),
  /**
   * The runner machine of `runner: host`, by name (its address and SSH login stay in the project's
   * home folder), and its CPU architecture from inspection.
   */
  runnerHost: z
    .strictObject({
      name: z.string().regex(RUNNER_HOST_NAME_PATTERN, { message: RUNNER_HOST_NAME_MESSAGE }),
      arch: z.enum(["amd64", "arm64"]),
    })
    .optional(),
  /**
   * Where the image is built: on GitHub's machines (`github`, also when absent) or on the
   * environment's own runner (`runner`, a local runner or a runner machine).
   */
  build: z.enum(["github", "runner"]).optional(),
  /**
   * Where the deploy secrets live, written by provision after it checked what the repository's
   * GitHub plan supports: a GitHub environment of this name, or repository secrets prefixed with it.
   */
  secrets: z.enum(["environment", "prefixed"]).optional(),
});

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

/** An `https://` URL. */
const HttpsUrlSchema = z.url({
  protocol: /^https$/,
  error: "must be an https:// URL",
});

/** The scheduled check's run interval in minutes (`observability.check.intervalMinutes`). */
const CHECK_INTERVALS = [5, 10, 15, 20, 30, 60] as const;

/**
 * The scheduled check in GitHub Actions (`observability.check`). Design turns it on for prod and
 * off for the other environments. The interval and the webhook are repository-wide: only the
 * first app's prod plan sets them (agents refuse them in any other plan).
 */
export const ObservabilityCheckSchema = z.strictObject({
  /** Refused on localhost: GitHub can't reach the user's computer. */
  enabled: z.boolean().optional(),
  /** Absent: 15 in a public repository, 60 in a private one. */
  intervalMinutes: z
    .literal(CHECK_INTERVALS, { error: "must be 5, 10, 15, 20, 30 or 60 (minutes)" })
    .optional(),
  /** Where alerts are also posted. Its address is a GitHub secret, never in the plan. */
  webhook: z
    .enum(["slack", "discord", "ntfy"], { error: 'must be "slack", "discord" or "ntfy"' })
    .optional(),
});

/** Beszel's hub public key, as the hub shows it: `ssh-ed25519 AAAA…` (public, not a secret). */
const ED25519_PUBLIC_KEY = /^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5[A-Za-z0-9+/]{48}$/;

/**
 * Beszel (`observability.beszel`), on a cloud server or the user's own: the hub and its agent on
 * this server (`hub`), or only the agent, connected out to the user's hub (`agent`).
 */
export const BeszelSchema = z
  .strictObject({
    enabled: z.boolean().default(false),
    /** The hub's and the agent's pinned version. */
    version: PinnedVersionSchema,
    mode: z.enum(["hub", "agent"]).default("hub"),
    /**
     * `hub` mode only. `local`: through an SSH tunnel. `subdomain`: behind Cloudflare Access, as
     * Portainer's.
     */
    access: z.enum(["local", "subdomain"]).default("local"),
    /** A subdomain of the app's Cloudflare zone; with `subdomain` only, and required there. */
    hostname: FqdnSchema.optional(),
    /** Email addresses Cloudflare Access lets in; with `subdomain` only, at least one there. */
    allowedEmails: z.array(z.email()).optional(),
    /** The user's hub; `agent` mode only, and required there. */
    hubUrl: HttpsUrlSchema.optional(),
    /** The hub's public key; `agent` mode only, and required there. */
    hubKey: z
      .string()
      .regex(ED25519_PUBLIC_KEY, {
        message: "must be the hub's public key as Beszel shows it: ssh-ed25519 AAAA…",
      })
      .optional(),
    /** The containers' memory limits in MB. */
    memoryMb: z
      .strictObject({
        hub: z.int().positive().default(128),
        agent: z.int().positive().default(64),
        proxy: z.int().positive().default(32),
      })
      .prefault({}),
  })
  .superRefine((beszel, ctx) => {
    const issue = (field: string, message: string) =>
      ctx.addIssue({ code: "custom", path: [field], message });
    const agent = beszel.mode === "agent";
    if (agent && beszel.access === "subdomain") {
      issue(
        "access",
        'is for "hub" mode only: in "agent" mode the dashboard is your own hub; leave access out, or use mode "hub"',
      );
    }
    for (const field of ["hubUrl", "hubKey"] as const) {
      if (agent && beszel[field] === undefined) {
        issue(field, `is required in "agent" mode: the agent connects out to your hub`);
      }
      if (!agent && beszel[field] !== undefined) {
        issue(field, 'is "agent" mode only: in "hub" mode the hub runs on this server');
      }
    }
    if (beszel.access !== "subdomain") {
      for (const field of ["hostname", "allowedEmails"] as const) {
        if (beszel[field] !== undefined) {
          issue(field, 'is only allowed when access is "subdomain"');
        }
      }
      return;
    }
    if (beszel.hostname === undefined) issue("hostname", 'is required when access is "subdomain"');
    if ((beszel.allowedEmails ?? []).length === 0) {
      issue("allowedEmails", 'must list at least one email address when access is "subdomain"');
    }
  });

/** A Grafana Cloud stack's endpoint: its URL and the numeric user id that goes with it. */
const GrafanaEndpointSchema = z.strictObject({
  url: HttpsUrlSchema,
  user: z.string().regex(/^\d+$/, { message: "must be the stack's numeric user id" }),
});

/**
 * Grafana Cloud through Grafana Alloy (`observability.grafanaCloud`), on a cloud server or the
 * user's own: masked logs and the server's metrics sent to the user's stack.
 */
export const GrafanaCloudSchema = z
  .strictObject({
    enabled: z.boolean().default(false),
    /** Alloy's pinned version. */
    version: PinnedVersionSchema,
    /** The stack's Prometheus `remote_write` URL (`https://…/api/prom/push`) and its user id. */
    metrics: GrafanaEndpointSchema.optional(),
    /** The stack's Loki push URL (`https://…/loki/api/v1/push`) and its user id. */
    logs: GrafanaEndpointSchema.optional(),
    /** The percentage of log lines sent. */
    logSampling: z.int().min(1).max(100).default(100),
    /** The containers' memory limits in MB. */
    memoryMb: z
      .strictObject({
        alloy: z.int().positive().default(192),
        proxy: z.int().positive().default(32),
      })
      .prefault({}),
  })
  .superRefine((grafana, ctx) => {
    if (!grafana.enabled) return;
    for (const field of ["metrics", "logs"] as const) {
      if (grafana[field] === undefined) {
        ctx.addIssue({
          code: "custom",
          path: [field],
          message: `is required when enabled: the stack's ${field === "metrics" ? "Prometheus" : "Loki"} URL and user id`,
        });
      }
    }
  });

/**
 * `plan.observability`: the scheduled check, and the Beszel and Grafana Cloud add-ons. Every part
 * is optional and off unless design or the user turns it on.
 */
export const ObservabilitySchema = z.strictObject({
  check: ObservabilityCheckSchema.optional(),
  beszel: BeszelSchema.optional(),
  grafanaCloud: GrafanaCloudSchema.optional(),
});

/**
 * The add-ons and the check where the target allows them: Beszel and Grafana Cloud run on a cloud
 * server or the user's own, and the check can't reach the localhost target.
 */
function checkObservability(plan: DeployPlanFields, ctx: z.RefinementCtx): void {
  const { observability, target } = plan;
  const addons = [
    ["beszel", "Beszel"],
    ["grafanaCloud", "Grafana Cloud"],
  ] as const;
  for (const [field, name] of addons) {
    if (observability?.[field]?.enabled !== true || onOneServer(target.provider)) continue;
    ctx.addIssue({
      code: "custom",
      path: ["observability", field, "enabled"],
      message: `can be true only on a server: Beszel and Grafana Cloud run on a server OpsCrew deploys to (a cloud server or your own); set observability.${field}.enabled to false, or choose a server target for ${name}`,
    });
  }
  if (observability?.check?.enabled === true && target.provider === "localhost") {
    ctx.addIssue({
      code: "custom",
      path: ["observability", "check", "enabled"],
      message:
        "must be false with the localhost target: GitHub can't reach your computer, so the scheduled check could never see the app; set observability.check.enabled to false",
    });
  }
}

/**
 * The web interfaces at a subdomain, Portainer's and Beszel's, each at its `hostname` behind
 * Cloudflare Access.
 */
function subdomains(plan: DeployPlanFields): { field: string; hostname: string | undefined }[] {
  const all = [
    { field: "portainer", settings: plan.portainer },
    { field: "observability.beszel", settings: plan.observability?.beszel },
  ];
  return all.flatMap(({ field, settings }) =>
    settings?.access === "subdomain" ? [{ field, hostname: settings.hostname }] : [],
  );
}

/**
 * A subdomain (Portainer's, Beszel's) is served through Cloudflare (tunnel and Access), so it needs
 * the app's Cloudflare DNS: a hostname inside the zone, but not the app's own domain or its `www.`
 * alias.
 */
function checkSubdomains(plan: DeployPlanFields, ctx: z.RefinementCtx): void {
  const { dns } = plan;
  const at = (field: string, ...rest: string[]) => [...field.split("."), ...rest];
  for (const { field, hostname } of subdomains(plan)) {
    if (dns.provider !== "cloudflare") {
      ctx.addIssue({
        code: "custom",
        path: at(field, "access"),
        message:
          'can be "subdomain" only when dns.provider is "cloudflare": the subdomain is served through Cloudflare',
      });
      continue;
    }
    if (dns.zone === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["dns", "zone"],
        message: `is required when ${field}.access is "subdomain"`,
      });
      continue;
    }
    // A missing or malformed hostname already has its own issue.
    if (hostname === undefined || !FqdnSchema.safeParse(hostname).success) continue;
    if (!hostname.endsWith(`.${dns.zone}`)) {
      ctx.addIssue({
        code: "custom",
        path: at(field, "hostname"),
        message: `must be a subdomain of ${dns.zone}, the app's Cloudflare zone`,
      });
    }
    if (dns.domain !== undefined && (hostname === dns.domain || hostname === `www.${dns.domain}`)) {
      ctx.addIssue({
        code: "custom",
        path: at(field, "hostname"),
        message: `must differ from the app's domain (${dns.domain}) and its www. alias`,
      });
    }
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
 * then, and a Portainer or Beszel subdomain. DNS-only names get Caddy's own certificates and are unaffected,
 * and so are the server-less targets: a Worker's custom domain gets a certificate of its own, and
 * GitHub issues GitHub Pages' certificates.
 */
function checkCloudflareEdgeNames(plan: DeployPlanFields, ctx: z.RefinementCtx): void {
  const { dns, target } = plan;
  const zone = dns.zone;
  if (dns.provider !== "cloudflare" || zone === undefined) return;
  if (isServerlessTarget(target)) return;
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
  for (const { field, hostname } of subdomains(plan)) {
    // The app's own names as a subdomain's hostname already have their own issue.
    if (hostname === undefined || hostname === domain || hostname === `www.${domain}`) continue;
    const deep = cloudflareEdgeCoverage(hostname, zone);
    if (deep !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: [...field.split("."), "hostname"],
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

/**
 * The rules of the localhost target: the app is served at `<app>.localhost` on the computer itself,
 * with no DNS record, and it never moves to or from a server.
 */
function checkLocalhostTarget(plan: DeployPlanFields, ctx: z.RefinementCtx): void {
  if (plan.dns.provider !== "none") {
    ctx.addIssue({
      code: "custom",
      path: ["dns", "provider"],
      message:
        'must be "none" with the localhost target: the app is served at <app>.localhost on this computer, with no DNS record',
    });
  }
  if (plan.retarget !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["retarget"],
      message: "moving an app to or from the localhost target is not available",
    });
  }
}

/** A repository path without `./` or a trailing `/`: `.` for the folder itself. */
export function cleanRepoPath(path: string): string {
  return posix.normalize(path).replace(/\/+$/, "") || ".";
}

/**
 * The rules of the server-less targets, Cloudflare's hosting and GitHub Pages: the site answers on
 * a domain on Cloudflare (behind Cloudflare's proxy on Cloudflare, DNS-only on GitHub Pages, with
 * `www` only at the zone's apex), nothing in the plan needs a server or an image, the uploaded
 * folder is never the app's folder itself, a server-rendered app handles its own not-found pages,
 * and the app does not move to or from a server.
 */
function checkServerlessTarget(
  target: z.output<typeof CloudflareWorkersTargetSchema> | z.output<typeof GithubPagesTargetSchema>,
  plan: DeployPlanFields,
  ctx: z.RefinementCtx,
): void {
  const pages = target.provider === "github-pages";
  const name = pages ? "GitHub Pages" : "Cloudflare hosting";
  const issue = (path: (string | number)[], message: string) =>
    ctx.addIssue({ code: "custom", path, message });
  const { dns } = plan;
  if (dns.provider !== "cloudflare") {
    const why = pages
      ? "OpsCrew creates the site's DNS records, and GitHub's verification record, in the domain's Cloudflare zone"
      : "the site answers on your domain as a custom domain of its Worker, which needs the domain on Cloudflare";
    issue(
      ["dns", "provider"],
      `must be "cloudflare" with ${name}: ${why}; move your domain's DNS to Cloudflare (opscrew domain connect), then set dns.provider to "cloudflare" with dns.domain`,
    );
  }
  if (!pages && !dns.proxied) {
    issue(
      ["dns", "proxied"],
      "must be true with Cloudflare hosting: a custom domain of a Worker is always behind Cloudflare's proxy; set dns.proxied to true",
    );
  }
  if (pages && dns.proxied) {
    issue(
      ["dns", "proxied"],
      "must be false with GitHub Pages: Cloudflare's proxy stops GitHub from issuing and renewing the site's certificate; set dns.proxied to false (DNS only)",
    );
  }
  if (pages && plan.security.wafCustomRules) {
    issue(
      ["security", "wafCustomRules"],
      "must be false with GitHub Pages: the site's hostnames are DNS-only, so Cloudflare's WAF never sees their traffic; set security.wafCustomRules to false",
    );
  }
  const { domain } = dns;
  // Before provision learns the zone from Cloudflare, the zone the domain most likely belongs to.
  const zone = domain === undefined ? undefined : (dns.zone ?? likelyCloudflareZone(domain));
  if (pages && dns.www && domain !== undefined && domain !== zone) {
    issue(
      ["dns", "www"],
      `can be true with GitHub Pages only when dns.domain is the zone's apex (${zone}): GitHub redirects between www and the domain only for an apex domain, so the record for www.${domain} would point at GitHub with no Pages site claiming it, which another GitHub user could take over; set dns.www to false, or use ${zone} as dns.domain`,
    );
  }
  if (!pages && target.render === "ssr" && target.notFound !== "none") {
    const instead =
      target.notFound === "single-page-application"
        ? "index.html for every page load, before the Worker runs, so the server-rendered pages would never render"
        : "the site's 404.html";
    issue(
      ["target", "notFound"],
      `must be "none" with render "ssr": the app's server renders every page, its own not-found page included, and with "${target.notFound}" Cloudflare would answer paths that are no file itself, with ${instead}; set target.notFound to "none"`,
    );
  }
  if (cleanRepoPath(target.site.outputDir) === ".") {
    const folder = cleanRepoPath(plan.app.buildContext);
    const what =
      folder === "."
        ? "the whole repository (opscrew/, .github/, .git and the app's sources)"
        : `everything in ${folder}, the app's sources included`;
    issue(
      ["target", "site", "outputDir"],
      `must be a folder inside the app's folder (app.buildContext ${folder}), not that folder itself: ${name} would publish ${what}; put the site's files in a folder of their own, for example public/, and set target.site.outputDir to it`,
    );
  }
  for (const [i, service] of plan.services.entries()) {
    issue(
      ["services", i],
      `is refused with ${name}: the service ${service.name} (${service.kind}) runs on a server, and ${name} has none; keep the app's own hosted service instead, or choose a server target`,
    );
  }
  for (const [i, worker] of plan.processes.workers.entries()) {
    issue(
      ["processes", "workers", i],
      `is refused with ${name}: the worker ${worker.name} runs as a process on a server, and ${name} has none; choose a server target`,
    );
  }
  for (const [i, job] of plan.processes.cron.entries()) {
    issue(
      ["processes", "cron", i],
      `is refused with ${name}: the cron job ${job.name} runs on a server, and ${name} has none; choose a server target`,
    );
  }
  if (plan.storage?.sqlite !== undefined) {
    issue(
      ["storage", "sqlite"],
      `is refused with ${name}: an SQLite database keeps its file on a server's disk, and ${name} has none; use a hosted database, or choose a server target`,
    );
  }
  if (plan.storage?.objectStorage !== undefined) {
    issue(
      ["storage", "objectStorage"],
      `is refused with ${name}: OpsCrew's bucket (${plan.storage.objectStorage.bucket}) gives its keys to the app on a server, and ${name} has none; keep the app's own storage, or choose a server target`,
    );
  }
  if (plan.app.releaseCommand !== undefined) {
    issue(
      ["app", "releaseCommand"],
      `is refused with ${name}: it runs in a container of the app's image on the server before each deploy, and ${name} has no server or image; remove it, or choose a server target`,
    );
  }
  if (plan.portainer !== undefined) {
    issue(
      ["portainer"],
      `is refused with ${name}: Portainer CE runs on a server, and ${name} has none; remove it`,
    );
  }
  if (plan.supplyChain.sign) {
    issue(
      ["supplyChain", "sign"],
      `must be false with ${name}: cosign signs the app's image, and ${name} builds no image`,
    );
  }
  if (plan.retarget !== undefined) {
    issue(
      ["retarget"],
      `moving an app to or from ${name} is not available yet: moving to and from server-less targets comes with retarget anywhere`,
    );
  }
}

/**
 * The rules of `plan.environment`: an environment is never promoted from itself, its runner fits
 * its target, and a named environment's app name ends with `-<name>`.
 */
function checkEnvironment(
  environment: NonNullable<DeployPlanFields["environment"]>,
  plan: DeployPlanFields,
  ctx: z.RefinementCtx,
): void {
  const name = environment.name ?? "prod";
  const { deploySource, runner } = environment;
  if (deploySource.from === "promote" && deploySource.source === name) {
    ctx.addIssue({
      code: "custom",
      path: ["environment", "deploySource", "source"],
      message: `must name another environment: "${name}" cannot be promoted from itself`,
    });
  }
  const { provider } = plan.target;
  // A positive list, so a new target is never taken for a server.
  const onServer = onOneServer(provider);
  if (runner === "server" && !onServer) {
    ctx.addIssue({
      code: "custom",
      path: ["environment", "runner"],
      message:
        'can be "server" only on a server OpsCrew creates or your own server (target.provider hetzner, digitalocean or own); use "github" here',
    });
  }
  if (runner === "host" && !onServer) {
    ctx.addIssue({
      code: "custom",
      path: ["environment", "runner"],
      message:
        'can be "host" only on a server OpsCrew creates or your own server (target.provider hetzner, digitalocean or own): a runner machine deploys to the server over SSH; use "github" here',
    });
  }
  if (runner === "host" && environment.runnerHost === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["environment", "runnerHost"],
      message:
        'is required when runner is "host": the runner machine the deploy job runs on, by its name (opscrew runner host list)',
    });
  }
  if (runner !== "host" && environment.runnerHost !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["environment", "runnerHost"],
      message: 'is only allowed when runner is "host"',
    });
  }
  if (environment.build === "runner") checkRunnerBuild(environment, plan, ctx);
  if (runner === "local" && provider !== "localhost") {
    ctx.addIssue({
      code: "custom",
      path: ["environment", "runner"],
      message: `can be "local" only with the localhost target (the runner deploys to this computer's Docker); use ${onServer ? '"github" or "server"' : '"github"'} here`,
    });
  }
  if (environment.name !== undefined && !plan.app.name.endsWith(`-${environment.name}`)) {
    ctx.addIssue({
      code: "custom",
      path: ["app", "name"],
      message: `must end with "-${environment.name}" in the ${environment.name} environment's plan: the app's name, then the environment's`,
    });
  }
}

/**
 * The rules of `build: runner`: only a local runner or a runner machine builds (never GitHub's
 * runner choice or the server's runner), only for an environment that follows main, and only for
 * the target's architecture.
 */
function checkRunnerBuild(
  environment: NonNullable<DeployPlanFields["environment"]>,
  plan: DeployPlanFields,
  ctx: z.RefinementCtx,
): void {
  const { runner, runnerHost } = environment;
  const path = ["environment", "build"];
  if (runner === "github" || runner === "server") {
    ctx.addIssue({
      code: "custom",
      path,
      message: `can be "runner" only when runner is "local" or "host": ${
        runner === "github"
          ? 'with runner "github" the deploy job already runs on GitHub\'s machines, so build there too (build "github")'
          : 'the server\'s runner never builds, since the app\'s build scripts would then run on the server the app serves from; build on GitHub\'s machines (build "github") or on a runner machine (runner "host")'
      }`,
    });
    return;
  }
  if (environment.deploySource.from !== "main") {
    ctx.addIssue({
      code: "custom",
      path,
      message:
        'can be "runner" only for an environment that follows main (deploySource.from "main"): a promoted environment deploys the image its source built and builds none; leave build out',
    });
  }
  // A local runner builds on the localhost target's own computer, so only a runner machine can
  // differ.
  const target = targetArch(plan.target);
  if (runnerHost !== undefined && runnerHost.arch !== target) {
    ctx.addIssue({
      code: "custom",
      path,
      message: `can be "runner" only when the runner machine's architecture (${runnerHost.arch}) is the server's (${target}): an image built there would not run on the server; use a runner machine with ${target}, or build on GitHub's machines (build "github")`,
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
 * How the app's image is built. Design sets it; with `chosen: user` later designs keep the user's
 * builder unless the baseline or the architecture rules it out.
 */
export const AppBuildSchema = z.strictObject({
  builder: ImageBuilderSchema,
  /** `auto`: design chose the builder. `user`: the user set it. */
  chosen: z.enum(["auto", "user"]),
  /** One plain sentence naming the fact that decided the builder. */
  reason: z.string().min(1),
  /**
   * What the builder is given: the version as the app declares it, else OpsCrew's default for the
   * language. Only `other` may leave the version out.
   */
  runtime: z
    .strictObject({
      language: RuntimeLanguageSchema,
      version: z
        .string()
        .regex(/^\d+(?:\.\d+){0,2}$/, {
          message: "must be a version such as `24`, `3.13` or `4.0.7`",
        })
        .optional(),
    })
    .superRefine((runtime, ctx) => {
      if (runtime.language !== "other" && runtime.version === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["version"],
          message: 'is required for every language except "other"',
        });
      }
    }),
  /**
   * How the app service's Compose health check probes the health route, for a tool the image
   * has: the app's runtime (`node`, `python`, `ruby`, `php`), busybox `wget` (static sites on
   * Caddy), bash's `/dev/tcp` (images with bash but no interpreter, such as Go, Java, .NET and
   * Rust), or `none` (the user's own Dockerfile keeps its own `HEALTHCHECK`). Set by design.
   */
  probe: z.enum(["node", "python", "ruby", "php", "wget", "bash", "none"]),
  /**
   * The builder an automatic choice would pick, recorded by design so a failed deploy can name it
   * when the user chose another one.
   */
  automatic: ImageBuilderSchema.optional(),
  /**
   * For the user's own Dockerfile only: the working directory of its last stage, where the app
   * runs in the image, as detection read it (`facts.build.workdir`). Set by design.
   */
  workdir: AbsolutePathSchema.optional(),
});
export type AppBuild = z.output<typeof AppBuildSchema>;

/** How a new version replaces the running one (`plan.deploy`). */
export const DeploySettingsSchema = z.strictObject({
  /** `rolling`: the new copy takes traffic once healthy. `recreate`: stop, then start. */
  strategy: z.enum(["rolling", "recreate"]).default("rolling"),
  /** Seconds the old copy keeps for open requests. */
  drainSeconds: z.int().min(5).max(300).default(30),
  /** Why the strategy is not `rolling`, for example "the server has 512 MB of memory". */
  reason: z.string().min(1).optional(),
});

/**
 * A move to another provider in progress (`opscrew retarget`). `plan.target` is already the new
 * target; `plan.deployment` describes the deployment that receives traffic (the old server until
 * the DNS switch). The servers' addresses are never committed: OpsCrew keeps them in its local
 * state (`.opscrew/server.json`). Moves to or from a server the user owns are not available.
 */
export const RetargetSchema = z.strictObject({
  /**
   * The deployment being replaced: its target, deploy settings and image build, which an abort
   * restores (the move may change the strategy and the builder for the new server).
   */
  from: z.strictObject({
    target: CloudTargetSchema,
    deploy: DeploySettingsSchema.prefault({}),
    build: AppBuildSchema.optional(),
  }),
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
  /** The environment this plan deploys; absent for prod. */
  environment: EnvironmentSchema.optional(),
  app: z.strictObject({
    /**
     * DNS-label safe; used for resource names. Unique in the repository: a further app's is its
     * key unless the user names it, and another environment's is `<name>-<env>`. A later design
     * keeps it.
     */
    name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/, {
      message:
        "must be 1-41 lower-case letters, digits or hyphens and start with a letter or digit",
    }),
    /**
     * A further app's key (`opscrew/apps/<key>/`), in every environment's plan of the app; absent
     * for the repository's first app. Every per-repository name derives from it (`workflowPathFor`,
     * `deploySecretPrefix`, `githubEnvironmentFor`, `ghcrImageFor`, `appBranch`).
     */
    key: AppKeySchema.optional(),
    /**
     * Container port. Design sets it from what analyze detects; a later design keeps yours and
     * names what analyze found.
     */
    port: PortSchema,
    /**
     * The health route. Design sets it from what analyze detects; a later design keeps yours and
     * names what analyze found.
     */
    healthPath: UrlPathSchema.default("/health"),
    buildContext: RepoPathSchema.default("."),
    dockerfile: RepoPathSchema.default("Dockerfile"),
    /**
     * The folders outside the app's folder that its build uses; its deploy runs when they change.
     * A file works too, and `.` is the whole repository. Design sets them from detection (the
     * local workspace packages the build uses). Add your own: a later design keeps every entry
     * here and adds back any folder detection finds, so a detected one you remove returns.
     * Absent means none.
     */
    sharedPaths: z.array(RepoPathSchema).optional(),
    /**
     * Runs before each new version takes traffic (database migrations), in a one-off container
     * of the new image with the app's environment, from the image's working folder. A failure
     * stops the deploy and the previous version keeps serving. Design sets it from what analyze
     * detects; a later design keeps yours and names what analyze found. A removed one comes back
     * while analyze finds a command (a later design says so).
     */
    releaseCommand: CommandLineSchema.optional(),
    /** The web process's memory limit. */
    memoryMb: MemoryMbSchema.default(512),
    /** The largest request body nginx accepts, in MB (`client_max_body_size`); Caddy sets none. */
    maxBodyMb: z.int().min(1).max(2048).default(100),
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
    /** Absent until design sets it. */
    build: AppBuildSchema.optional(),
  }),
  target: DeployTargetSchema,
  /** How a new version replaces the running one. */
  deploy: DeploySettingsSchema.prefault({}),
  /** Workers and cron jobs, from the app's image. */
  processes: ProcessesSchema,
  /** The backing services OpsCrew runs next to the app (read them with `serviceOf`). */
  services: z.array(PlanServiceSchema).default(() => []),
  /** Services the app keeps using where they are hosted now. */
  externalServices: z.array(ServiceKindSchema),
  /** Persistent storage; absent when the app keeps no files. */
  storage: StorageSchema.optional(),
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
      /** Defaults to the app's environment's own, `infraDirFor(app.key, environment.name)`. */
      dir: RepoPathSchema.optional(),
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
    /**
     * Behind Cloudflare's proxy. Design sets it from the target and the interview; on a server
     * OpsCrew creates, a later design keeps it.
     */
    proxied: z.boolean().default(true),
    /** Also serve `www.<domain>`. A later design keeps it while the domain stays the same. */
    www: z.boolean().default(false),
    /**
     * Set when OpsCrew bought the domain (`opscrew domain buy`). A later design keeps it, with
     * `zone`, while the domain stays inside the zone.
     */
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
    /**
     * Defaults to the app's environment's own, `workflowPathFor(app.key, environment.name)`. A
     * later design keeps it.
     */
    workflowPath: RepoPathSchema.optional(),
    registry: z.literal("ghcr"),
    /** Deploys run on pushes to this branch. */
    branch: z.string().min(1).default("main"),
    /** A `deploy-<UTC time>` tag on the commit after each healthy deploy. */
    deployTags: z
      .strictObject({
        enabled: z.boolean().default(false),
        /** Also a GitHub Release naming the image digest. */
        release: z.boolean().default(false),
      })
      .prefault({}),
    /**
     * After a healthy deploy, keep the newest `keep` deployed images (with their SBOM and
     * provenance); never the running or the previous one.
     */
    imageRetention: z
      .strictObject({
        enabled: z.boolean().default(true),
        keep: z.int().min(2).max(100).default(10),
      })
      .prefault({}),
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
  supplyChain: z
    .strictObject({
      /**
       * Keyless cosign signature of the image. For a private repository, its name and workflow
       * path become public in the transparency log.
       */
      sign: z.boolean().default(false),
    })
    .prefault({}),
  /** Portainer CE on the server; absent means off. */
  portainer: PortainerSchema.optional(),
  /** The scheduled check and the Beszel and Grafana Cloud add-ons; absent (or a part absent) is off. */
  observability: ObservabilitySchema.optional(),
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
      /** The app's public URL on its domain; absent without a domain. */
      url: DomainUrlSchema.optional(),
      lastPlanHash: PlanHashSchema.optional(),
      lastApplyAt: IsoDateTimeSchema.optional(),
      /** When the first deploy `opscrew verify` saw succeed started; set once, never updated. */
      firstDeployAt: IsoDateTimeSchema.optional(),
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
  if (plan.target.provider === "localhost") checkLocalhostTarget(plan, ctx);
  if (isServerlessTarget(plan.target)) checkServerlessTarget(plan.target, plan, ctx);
  if (plan.environment !== undefined) checkEnvironment(plan.environment, plan, ctx);
  checkSubdomains(plan, ctx);
  checkObservability(plan, ctx);
  checkCloudflareEdgeNames(plan, ctx);
  checkComponents(plan, ctx);
});

/**
 * Worker and service names are unique within the app (each is a Compose service), a self-hosted
 * Postgres excludes an external one, and an app on SQLite stops its old copy before starting the
 * new one.
 */
function checkComponents(plan: DeployPlanFields, ctx: z.RefinementCtx): void {
  const names = new Set<string>();
  const unique = (name: string, path: (string | number)[]) => {
    if (names.has(name)) {
      ctx.addIssue({
        code: "custom",
        path,
        message: `"${name}" is already the name of another worker or service; give each its own`,
      });
    }
    names.add(name);
  };
  for (const [i, worker] of plan.processes.workers.entries()) {
    unique(worker.name, ["processes", "workers", i, "name"]);
  }
  for (const [i, service] of plan.services.entries()) unique(service.name, ["services", i, "name"]);
  // One variable holds one address: two running services cannot both fill it.
  const variables = new Map<string, string>();
  for (const [i, service] of plan.services.entries()) {
    if (!service.enabled || service.variable === undefined) continue;
    const other = variables.get(service.variable);
    if (other !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["services", i, "variable"],
        message: `"${service.variable}" already gets the address of the service ${other}; give each service its own variable`,
      });
    }
    variables.set(service.variable, service.name);
  }
  if (serviceOf(plan, "postgres")) {
    plan.externalServices.forEach((service, i) => {
      if (POSTGRES_PROVIDERS.has(service)) {
        ctx.addIssue({
          code: "custom",
          path: ["externalServices", i],
          message: `"${service}" conflicts with the Postgres service: use either the self-hosted Postgres container or the external database, not both`,
        });
      }
    });
  }
  if (plan.storage?.sqlite !== undefined && plan.deploy.strategy !== "recreate") {
    ctx.addIssue({
      code: "custom",
      path: ["deploy", "strategy"],
      message:
        'must be "recreate" when storage.sqlite is set: one SQLite database cannot serve the old and the new copy of the app at once',
    });
  }
}

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

/** True for a server OpsCrew creates on Hetzner Cloud or DigitalOcean. */
function isCloudTarget(
  target: z.output<typeof DeployTargetSchema>,
): target is z.output<typeof CloudTargetSchema> {
  return CloudProviderSchema.safeParse(target.provider).success;
}

/** The target with a cloud target's image filled in; any other target as it is. */
function withTargetDefaults(target: z.output<typeof DeployTargetSchema>) {
  return isCloudTarget(target) ? withImage(target) : target;
}

/**
 * `opscrew/plan.yaml`: the chosen deployment. Parsing fills every documented default, including
 * `security.httpAllowedFrom` (`cloudflare` when `dns.proxied`, else `any`), and `infra.dir` and
 * `cicd.workflowPath` from the app's key and the environment's name. The filled objects keep
 * their fields' order, so a plan's file keeps its bytes.
 */
export const DeployPlanSchema = DeployPlanObjectSchema.transform((plan) => {
  const { engine, dir, ...infra } = plan.infra;
  const { provider, workflowPath, ...cicd } = plan.cicd;
  const key = plan.app.key;
  const environment = plan.environment?.name;
  return {
    ...plan,
    target: withTargetDefaults(plan.target),
    infra: { engine, dir: dir ?? infraDirFor(key, environment), ...infra },
    cicd: { provider, workflowPath: workflowPath ?? workflowPathFor(key, environment), ...cicd },
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
  };
});
export type DeployPlan = z.output<typeof DeployPlanSchema>;

/** Where the app runs, with a cloud target's image filled in. */
export type DeployTarget = DeployPlan["target"];
/** A server OpsCrew creates on Hetzner Cloud or DigitalOcean, with its image filled in. */
export type CloudDeployTarget = Extract<DeployTarget, { provider: CloudProvider }>;
/** A server the user already owns. */
export type OwnDeployTarget = Extract<DeployTarget, { provider: "own" }>;
/** A Portainer the user already runs. */
export type PortainerDeployTarget = Extract<DeployTarget, { provider: "portainer" }>;
/** The user's own computer. */
export type LocalhostDeployTarget = Extract<DeployTarget, { provider: "localhost" }>;
/** Cloudflare's hosting, on Workers with static assets. */
export type CloudflareWorkersDeployTarget = Extract<
  DeployTarget,
  { provider: "cloudflare-workers" }
>;
/** GitHub Pages. */
export type GithubPagesDeployTarget = Extract<DeployTarget, { provider: "github-pages" }>;
/** How the deploy job builds a server-less site. */
export type Site = z.output<typeof SiteSchema>;
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
/** The scheduled check and the add-ons, with their defaults filled in. */
export type Observability = NonNullable<DeployPlan["observability"]>;
/** Beszel's settings with their defaults filled in. */
export type BeszelSettings = NonNullable<Observability["beszel"]>;
/** Grafana Cloud's settings with their defaults filled in. */
export type GrafanaCloudSettings = NonNullable<Observability["grafanaCloud"]>;
