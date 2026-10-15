import { OpsCrewError } from "@opscrew/core";
import { containerPort, detectStack, releaseCommandInImage } from "@opscrew/iac-templates";
import {
  type DeployPlan,
  DeployPlanSchema,
  type DesignOption,
  type ProjectFacts,
  type Requirements,
} from "@opscrew/plan-schema";
import { deepDomainProblem } from "../interview/answers";
import { providerProfile } from "../providers";
import { hostListKind, serviceUrlKind } from "../shared";
import {
  appDirOf,
  appDockerfile,
  type CodeChange,
  type CodeChangeSignals,
  healthRouteFor,
} from "./code-changes";
import type { OwnServerAccess, OwnServerServing } from "./own";
import type { PortainerDesignChoice } from "./portainer";

export interface OptionToPlanInput {
  facts: ProjectFacts;
  requirements: Requirements;
  now: Date;
  codeChanges: CodeChange[];
  /** Repository signals used to pick the health path (see `collectCodeChangeSignals`). */
  signals?: CodeChangeSignals;
  /** `createdAt` of the plan being replaced, kept so the history stays readable. */
  createdAt?: string;
  /**
   * A server the user owns only (required there): how the internet reaches it, `public` or
   * `tunnel` (a Cloudflare Tunnel).
   */
  access?: OwnServerAccess;
  /**
   * A server the user owns: how the site is served. `proxy` keeps the Cloudflare domain proxied
   * (OpsCrew's web filter lets only Cloudflare in); `dns-only`, and a public server without it,
   * turns the proxy off (DNS only).
   */
  serving?: OwnServerServing;
  /**
   * An existing Portainer only (required there): the environment, its architecture and the
   * redeploy and web modes from the interview's answers.
   */
  portainer?: PortainerDesignChoice;
}

/**
 * The plan's target for the chosen option: a cloud server with the provider's default image and
 * the option's backups, the user's own server with its architecture and access mode (never its
 * address or login, which stay in local state), or the user's Portainer with the environment and
 * the chosen modes (never its address).
 */
function targetFor(
  option: DesignOption,
  access: OwnServerAccess | undefined,
  portainer: PortainerDesignChoice | undefined,
) {
  const { target } = option;
  if (target.provider === "own") {
    if (access === undefined) {
      throw new Error("A design for a server the user owns needs its access mode.");
    }
    return {
      provider: "own",
      mode: "vps-compose",
      arch: target.architecture === "arm" ? "arm64" : "amd64",
      access,
    } as const;
  }
  if (target.provider === "portainer") {
    if (portainer === undefined) {
      throw new Error("A design for an existing Portainer needs the interview's answers.");
    }
    return {
      provider: "portainer",
      mode: "portainer-stack",
      environmentId: portainer.environmentId,
      arch: portainer.arch,
      redeploy: portainer.redeploy,
      web: portainer.web,
    } as const;
  }
  return {
    provider: target.provider,
    mode: "vps-compose",
    location: target.location,
    serverType: target.serverType,
    image: providerProfile(target.provider).defaultImage,
    backups: option.backups,
  } as const;
}

/**
 * Variables whose production value OpsCrew generates as a random secret: only keys the app signs
 * with itself, including those Flask loads by prefix (`FLASK_SECRET_KEY`, `FLASK_JWT_SECRET_KEY`,
 * `FLASK_WTF_CSRF_SECRET_KEY`). Another provider's key (`FLASK_STRIPE_SECRET_KEY`) is the user's.
 */
const GENERATED_SECRETS =
  /^(?:DJANGO_)?SECRET_KEY$|^(?:NEXTAUTH|AUTH|BETTER_AUTH|SESSION|JWT|COOKIE)_SECRET$|^FLASK_(?:SECRET_KEY|JWT_SECRET_KEY|WTF_CSRF_SECRET_KEY)$/;

/** DNS-label-safe app name (`^[a-z0-9][a-z0-9-]{0,40}$`) from the project name. */
export function appNameFor(facts: ProjectFacts): string {
  const name = facts.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 41)
    .replace(/-+$/, "");
  return name === "" ? "app" : name;
}

/** Port the app container listens on (static sites are served by Caddy on 8080). */
export function appPortFor(facts: ProjectFacts): number {
  const fallback = facts.languages.includes("python") ? 8000 : 3000;
  const port = facts.port ?? fallback;
  const stack = detectStack(facts);
  return stack === undefined ? port : containerPort(stack, port);
}

/**
 * Turns the chosen option into `opscrew/plan.yaml` content: app (name, port, health path, release command,
 * environment variable names), target (the option's provider and its default image; for the user's
 * own server its architecture and `input.access`), services, cost, code changes, DNS from the requirements and
 * GitHub Actions + GHCR for CI/CD. Every documented default is filled by `DeployPlanSchema`.
 * @throws ZodError when the result is not a valid plan (a bug, never user input).
 */
export function optionToPlan(option: DesignOption, input: OptionToPlanInput): DeployPlan {
  const { facts, requirements } = input;
  const now = input.now.toISOString();
  const services = option.services;

  const env = new Map<string, DeployPlan["app"]["env"][number]>();
  for (const variable of facts.envVars) {
    if (variable.name === "PORT") continue;
    // The app's own names for the database and Redis URLs are filled from the services OpsCrew
    // runs (FR-814), whatever default the code has for development, unless a committed example
    // gives the variable another kind of URL (`CELERY_BROKER_URL=amqp://…`).
    const service = serviceUrlKind(variable.name);
    if (
      service !== undefined &&
      services[service] &&
      (variable.urlScheme === undefined || variable.urlScheme === service)
    ) {
      env.set(variable.name, derived(variable.name, service === "postgres"));
      continue;
    }
    env.set(variable.name, {
      name: variable.name,
      secret: variable.secretLikely,
      // Host lists come from the deployment (its domain or server), never from the user.
      source: GENERATED_SECRETS.test(variable.name)
        ? "generated"
        : hostListKind(variable.name) !== undefined
          ? "derived"
          : "user",
      // A code default for a secret is a development placeholder: production needs a value.
      ...(variable.hasDefault === true && !variable.secretLikely ? { optional: true } : {}),
    });
  }
  if (services.postgres) env.set("DATABASE_URL", derived("DATABASE_URL", true));
  if (services.redis) env.set("REDIS_URL", derived("REDIS_URL", false));

  // A server the user owns serves directly behind Cloudflare's proxy only with OpsCrew's web
  // filter (the explicit `proxy` choice); otherwise a public server is DNS only.
  const ownDirect = option.target.provider === "own" && input.access === "public";
  // In a Portainer only the tunnel goes through Cloudflare: OpsCrew cannot keep visitors from
  // going around Cloudflare's proxy on a host it does not manage, so the other modes are DNS only.
  const portainerDirect =
    option.target.provider === "portainer" && input.portainer?.web.mode !== "tunnel";
  if (
    requirements.dnsProvider === "cloudflare" &&
    requirements.domain !== undefined &&
    (!ownDirect || input.serving === "proxy") &&
    !portainerDirect
  ) {
    refuseDeepDomain(requirements.domain, option.target.provider, input.access);
  }
  const dns: Record<string, unknown> =
    requirements.dnsProvider === "cloudflare" && requirements.domain !== undefined
      ? {
          provider: "cloudflare",
          domain: requirements.domain,
          ...((ownDirect && input.serving !== "proxy") || portainerDirect
            ? { proxied: false }
            : {}),
        }
      : {
          // Without Cloudflare nothing proxies the traffic, so HTTP must stay open to everyone.
          provider: "none",
          proxied: false,
          ...(requirements.domain !== undefined ? { domain: requirements.domain } : {}),
        };

  const releaseCommand = releaseCommandInImage(facts);

  return DeployPlanSchema.parse({
    schemaVersion: 1,
    createdAt: input.createdAt ?? now,
    updatedAt: now,
    app: {
      name: appNameFor(facts),
      port: appPortFor(facts),
      healthPath: healthRouteFor(facts, input.signals).path,
      // An app in a subfolder is built from the repository root (`buildContext` stays `.`).
      ...(appDirOf(facts) !== "." ? { dockerfile: appDockerfile(facts).path } : {}),
      // Database migrations, run before each new version takes traffic (FR-813).
      ...(releaseCommand !== undefined ? { releaseCommand } : {}),
      env: [...env.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    },
    target: targetFor(option, input.access, input.portainer),
    services: { postgres: services.postgres, redis: services.redis },
    externalServices: [...option.externalServices],
    cost: option.cost,
    codeChanges: input.codeChanges,
    dns,
    ...(ownDirect && input.serving === "proxy"
      ? { security: { httpAllowedFrom: "cloudflare" } }
      : {}),
    cicd: {
      provider: "github-actions",
      registry: "ghcr",
      branch: facts.git.defaultBranch ?? facts.git.currentBranch ?? "main",
    },
  });
}

/**
 * Stops design, before plan.yaml is written, when Cloudflare would serve the domain (proxied or
 * through the tunnel) more than one level below its likely zone, where Cloudflare's free
 * certificate does not reach. Provision checks the real zone again through the plan schema.
 */
function refuseDeepDomain(
  domain: string,
  provider: DesignOption["target"]["provider"],
  access: OwnServerAccess | undefined,
): void {
  const otherwise =
    provider === "portainer"
      ? "serve it with Caddy or your own reverse proxy and DNS only (portainer.web caddy or proxy)"
      : provider !== "own"
        ? "answer other for dnsProvider to manage its DNS yourself, without Cloudflare's proxy"
        : access === "tunnel"
          ? "if the internet can reach your server, serve it with DNS only (server.reachable yes, server.serve dns-only)"
          : "serve it with DNS only (server.serve dns-only)";
  const problem = deepDomainProblem(domain, otherwise);
  if (problem === undefined) return;
  throw new OpsCrewError("INVALID_INPUT", `${problem.reason}. plan.yaml was not changed.`, {
    hint: `In \`opscrew interview\`, ${problem.next}.`,
  });
}

function derived(name: string, secret: boolean): DeployPlan["app"]["env"][number] {
  return { name, secret, source: "derived" };
}
