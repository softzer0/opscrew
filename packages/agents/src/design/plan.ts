import { containerPort, detectStack, releaseCommandInImage } from "@opscrew/iac-templates";
import {
  type DeployPlan,
  DeployPlanSchema,
  type DesignOption,
  type ProjectFacts,
  type Requirements,
} from "@opscrew/plan-schema";
import { providerProfile } from "../providers";
import { hostListKind, serviceUrlKind } from "../shared";
import {
  appDirOf,
  appDockerfile,
  type CodeChange,
  type CodeChangeSignals,
  healthRouteFor,
} from "./code-changes";
import type { OwnServerAccess } from "./own";

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
}

/**
 * The plan's target for the chosen option: a cloud server with the provider's default image and
 * the option's backups, or the user's own server with its architecture and access mode (never its
 * address or login, which stay in local state).
 */
function targetFor(option: DesignOption, access: OwnServerAccess | undefined) {
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

  const dns: Record<string, unknown> =
    requirements.dnsProvider === "cloudflare" && requirements.domain !== undefined
      ? { provider: "cloudflare", domain: requirements.domain }
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
    target: targetFor(option, input.access),
    services: { postgres: services.postgres, redis: services.redis },
    externalServices: [...option.externalServices],
    cost: option.cost,
    codeChanges: input.codeChanges,
    dns,
    cicd: {
      provider: "github-actions",
      registry: "ghcr",
      branch: facts.git.defaultBranch ?? facts.git.currentBranch ?? "main",
    },
  });
}

function derived(name: string, secret: boolean): DeployPlan["app"]["env"][number] {
  return { name, secret, source: "derived" };
}
