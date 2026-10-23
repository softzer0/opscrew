import { OpsCrewError } from "@opscrew/core";
import {
  appRoot,
  containerPort,
  detectStack,
  releaseCommandInImage,
  serviceSpec,
} from "@opscrew/iac-templates";
import {
  type DeployPlan,
  DeployPlanSchema,
  type DesignOption,
  isServerlessProvider,
  onOneServer,
  type PlanService,
  type ProjectFacts,
  type Requirements,
} from "@opscrew/plan-schema";
import { defaultBranchOf } from "../environments/branches";
import { type LocalhostDesignChoice, localhostTarget } from "../localhost/design";
import { providerProfile } from "../providers";
import {
  deepDomainProblem,
  FRAMEWORK_ENV,
  hostListKind,
  STORAGE_VARIABLES,
  serviceAppVariables,
  serviceUrlKind,
  storageVariableKind,
  urlService,
} from "../shared";
import type { BuilderChoice } from "./builder";
import {
  appDirOf,
  appDockerfile,
  buildContextFor,
  type CodeChange,
  type CodeChangeSignals,
  healthRouteFor,
} from "./code-changes";
import { appNameFor, type Components, designComponents } from "./components";
import type { OwnServerAccess, OwnServerServing } from "./own";
import type { PortainerDesignChoice } from "./portainer";
import { type ServerlessDesignChoice, serverlessTargetFor } from "./serverless";
import { sqliteMove } from "./storage";
import { deployStrategyFor } from "./strategy";

export interface OptionToPlanInput {
  facts: ProjectFacts;
  requirements: Requirements;
  now: Date;
  /** A further app's key (`app.key`), which also names it (`app.name`); none for the first app. */
  key?: string | undefined;
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
  /** This computer only (required there): its CPU, the edge's ports and the image's source. */
  localhost?: LocalhostDesignChoice;
  /** A server-less target only (required there): the site as detection describes it. */
  serverless?: ServerlessDesignChoice;
  /** Who builds the image (`chooseBuilder`); required on every target with an image. */
  build?: BuilderChoice;
  /** What runs next to the app (`designComponents`); by default designed from the facts. */
  components?: Components;
}

/**
 * The plan's target for the chosen option: a cloud server with the provider's default image and
 * the option's backups, the user's own server with its architecture and access mode (never its
 * address or login, which stay in local state), the user's Portainer with the environment and
 * the chosen modes (never its address), this computer with its CPU, ports and image source, or a
 * server-less target with its site block (on Cloudflare a Worker named `appName`).
 */
function targetFor(
  option: DesignOption,
  input: Pick<OptionToPlanInput, "access" | "portainer" | "localhost" | "build" | "serverless">,
  components: Components,
  appName: string,
) {
  const { access, portainer } = input;
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
  if (target.provider === "localhost") {
    if (input.localhost === undefined) {
      throw new Error("A design for this computer needs its CPU and the edge's ports.");
    }
    return localhostTarget(input.localhost, {
      builder: input.build?.builder,
      cron: components.processes.cron.some((job) => job.enabled),
      sqlite: components.storage?.sqlite !== undefined,
    });
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
  if (isServerlessProvider(target.provider)) {
    if (input.serverless === undefined) {
      throw new Error("A design for a server-less target needs the site's detection.");
    }
    return serverlessTargetFor(input.serverless, appName);
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

/** Port the app container listens on (static sites are served by Caddy on 8080). */
export function appPortFor(facts: ProjectFacts): number {
  const fallback = facts.languages.includes("python") ? 8000 : 3000;
  const port = facts.port ?? fallback;
  const stack = detectStack(facts);
  return stack === undefined ? port : containerPort(stack, port);
}

/**
 * The services with each Dragonfly's most threads (`options.threads`) set to the chosen server's
 * vCPUs, unless plan.yaml already sets them (an edit is kept). Only a server's are known: not a
 * Portainer host's or this computer's.
 */
function withServerThreads(services: readonly PlanService[], option: DesignOption): PlanService[] {
  return services.map((service) =>
    service.kind === "dragonfly" &&
    service.options.threads === undefined &&
    onOneServer(option.target.provider)
      ? { ...service, options: { ...service.options, threads: option.target.vcpus } }
      : service,
  );
}

/**
 * Turns the chosen option into `opscrew/plan.yaml` content: app (name, port, health path, release
 * command, memory limit, environment variable names), target (the option's provider and its default
 * image; for the user's own server its architecture and `input.access`), the components
 * (`input.components`: workers, cron jobs, services and storage), cost, code changes, DNS from the
 * requirements and GitHub Actions + GHCR for CI/CD, with deploy tags and signing as the interview
 * answered. The image's builder comes from `input.build` (Buildpacks and Railpack build an app in a
 * subfolder from that folder), and the deploy strategy from the option's server and SQLite
 * (`deployStrategyFor`). The variables the services and the object storage fill come from the
 * catalog ({@link serviceAppVariables}), and `CRON_SECRET` is generated for route jobs. Every
 * documented default is filled by `DeployPlanSchema`.
 * @throws ZodError when the result is not a valid plan (a bug, never user input).
 */
export function optionToPlan(option: DesignOption, input: OptionToPlanInput): DeployPlan {
  const { facts, requirements } = input;
  const now = input.now.toISOString();
  const components = input.components ?? designComponents({ facts, requirements }).components;

  const env = new Map<string, DeployPlan["app"]["env"][number]>();
  for (const variable of facts.envVars) {
    if (variable.name === "PORT") continue;
    // The app's own names for the database and Redis URLs are filled from the services OpsCrew
    // runs (FR-814), whatever default the code has for development, unless a committed example
    // gives the variable another kind of URL (`CELERY_BROKER_URL=amqp://…`). It is a secret when
    // the address carries the service's login (Postgres, Redis 8, Dragonfly).
    const service = serviceUrlKind(variable.name);
    const running = service === undefined ? undefined : urlService(components, service);
    if (
      running !== undefined &&
      (variable.urlScheme === undefined || variable.urlScheme === service)
    ) {
      env.set(
        variable.name,
        derived(variable.name, serviceSpec(running.kind).auth !== "internal-only"),
      );
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
  // Rails and Laravel start in development unless told otherwise, and need a key to sign with.
  for (const framework of facts.frameworks) {
    const defaults = FRAMEWORK_ENV[framework.name];
    for (const name of Object.keys(defaults?.fixed ?? {})) env.set(name, derived(name, false));
    for (const name of Object.keys(defaults?.generated ?? {})) {
      env.set(name, { name, secret: true, source: "generated" });
    }
  }
  // Vercel's cron jobs send the generated secret the app checks (FR-1309).
  if (components.processes.cron.some((job) => job.enabled && job.route !== undefined)) {
    env.set("CRON_SECRET", { name: "CRON_SECRET", secret: true, source: "generated" });
  }
  const { build, serverless } = input;
  // A server-less site is published on its domain by Cloudflare (always behind its proxy) or by
  // GitHub (DNS only), and builds no image.
  const pages = serverless?.provider === "github-pages";
  // A server the user owns serves directly behind Cloudflare's proxy only with OpsCrew's web
  // filter (the explicit `proxy` choice); otherwise a public server is DNS only.
  const ownDirect = option.target.provider === "own" && input.access === "public";
  const webFilter = ownDirect && input.serving === "proxy";
  // In a Portainer only the tunnel goes through Cloudflare: OpsCrew cannot keep visitors from
  // going around Cloudflare's proxy on a host it does not manage, so the other modes are DNS only.
  const dnsOnly =
    pages ||
    (ownDirect && !webFilter) ||
    (option.target.provider === "portainer" && input.portainer?.web.mode !== "tunnel");
  const onCloudflare = requirements.dnsProvider === "cloudflare" ? requirements.domain : undefined;
  // A Worker's custom domain gets a certificate of its own, so any depth below the zone works.
  if (onCloudflare !== undefined && !dnsOnly && serverless === undefined) {
    refuseDeepDomain(onCloudflare, option.target.provider, input.access);
  }
  const dns: Record<string, unknown> =
    onCloudflare !== undefined
      ? { provider: "cloudflare", domain: onCloudflare, ...(dnsOnly ? { proxied: false } : {}) }
      : {
          // Without Cloudflare nothing proxies the traffic, so HTTP must stay open to everyone.
          provider: "none",
          proxied: false,
          ...(requirements.domain !== undefined ? { domain: requirements.domain } : {}),
        };

  let buildContext: string;
  if (serverless !== undefined) buildContext = serverless.site.dir;
  else if (build !== undefined) buildContext = buildContextFor(facts, build.builder);
  else throw new Error("A design for a target with an image needs its image builder.");
  const releaseCommand = serverless === undefined ? releaseCommandInImage(facts) : undefined;
  const tags = requirements.deployTags;
  // The user's own Dockerfile is built where detection found it; OpsCrew's goes into the app's
  // folder. A server-less site is built in its own folder, with no Dockerfile.
  const dockerfile =
    build === undefined
      ? undefined
      : build.builder === "own-dockerfile" && facts.docker.dockerfile !== undefined
        ? facts.docker.dockerfile
        : appDirOf(facts) !== "."
          ? appDockerfile(facts).path
          : undefined;
  // A further app is named after its key, which is unique in the repository; the first app after
  // what detection found.
  const { key } = input;
  const name = key ?? appNameFor(facts);

  const plan = DeployPlanSchema.parse({
    schemaVersion: 1,
    createdAt: input.createdAt ?? now,
    updatedAt: now,
    app: {
      name,
      ...(key === undefined ? {} : { key }),
      port: appPortFor(facts),
      healthPath: healthRouteFor(facts, input.signals).path,
      buildContext,
      ...(dockerfile !== undefined ? { dockerfile } : {}),
      // Database migrations, run before each new version takes traffic (FR-813).
      ...(releaseCommand !== undefined ? { releaseCommand } : {}),
      memoryMb: components.app.memoryMb,
      env: [...env.values()],
      ...(build === undefined
        ? {}
        : {
            build: {
              builder: build.builder,
              chosen: build.chosen,
              reason: build.reason,
              runtime: build.runtime,
              probe: build.probe,
              automatic: build.automatic,
              // Where the app runs in the user's own image, as detection read it.
              ...(build.builder === "own-dockerfile" && facts.build.workdir !== undefined
                ? { workdir: facts.build.workdir }
                : {}),
            },
          }),
    },
    target: targetFor(option, input, components, name),
    deploy: deployStrategyFor(option, components.storage?.sqlite !== undefined),
    processes: components.processes,
    services: withServerThreads(components.services, option),
    externalServices: [...components.externalServices],
    ...(components.storage === undefined ? {} : { storage: components.storage }),
    cost: option.cost,
    codeChanges: input.codeChanges,
    dns,
    ...(webFilter ? { security: { httpAllowedFrom: "cloudflare" } } : {}),
    // GitHub Pages' hostnames are DNS-only, so Cloudflare's WAF never sees their traffic.
    ...(pages ? { security: { wafCustomRules: false } } : {}),
    cicd: {
      provider: "github-actions",
      registry: "ghcr",
      branch: defaultBranchOf(facts),
      deployTags: {
        enabled: tags !== undefined && tags !== "off",
        release: tags === "tag-and-release",
      },
    },
    // cosign signs an image, and a server-less site has none.
    supplyChain: { sign: serverless === undefined && (requirements.signImages ?? false) },
  });
  for (const variable of storageEnv(facts, plan)) env.set(variable.name, variable);
  // The SQLite volume is mounted in the folder the app runs in, which OpsCrew must know (the user's
  // own Dockerfile needs a literal WORKDIR). A database moved into a folder of its own: its
  // variable points the app there.
  const sqlite = components.storage?.sqlite;
  const move = sqlite === undefined ? undefined : sqliteMove(facts);
  if (sqlite !== undefined && appRoot(plan) === undefined) {
    const unknown = `OpsCrew does not know the folder the app runs in, because the last stage of your Dockerfile (${plan.app.dockerfile}) has no WORKDIR with an absolute path. plan.yaml was not changed.`;
    throw new OpsCrewError(
      "INVALID_INPUT",
      move === undefined
        ? `The app keeps its SQLite database in ${sqlite.dir}/ on a persistent volume, but ${unknown}`
        : `The app keeps its SQLite database in ${move.from}/, which also holds the app's own files, so OpsCrew would move it to ${move.dir}/ and point ${move.variable} there. It cannot: ${unknown}`,
      {
        hint: `Add a WORKDIR with an absolute path to the last stage of ${plan.app.dockerfile} (for example WORKDIR /app), then run \`opscrew analyze\` and \`opscrew design\` again.`,
      },
    );
  }
  if (move !== undefined) env.set(move.variable, derived(move.variable, false));
  // What the services give the app, from the catalog (FR-1314); a secret shows as SECRET.
  const SECRET = "\u0000secret\u0000";
  for (const [name, value] of serviceAppVariables(plan, () => SECRET)) {
    env.set(name, derived(name, value.includes(SECRET)));
  }
  return DeployPlanSchema.parse({
    ...plan,
    app: {
      ...plan.app,
      env: [...env.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    },
  });
}

/**
 * The object storage variables of the app (plan.md "6."): the keys, `AWS_REGION`,
 * `AWS_ENDPOINT_URL_S3` and the bucket and endpoint names the app reads, plus Laravel's region
 * and path-style switch when it reads them. All are derived: from the bucket, from the key
 * provision asks the user for once (and R2's endpoint from the Cloudflare account), or for Garage
 * from its catalog entry.
 */
function storageEnv(facts: ProjectFacts, plan: DeployPlan): DeployPlan["app"]["env"] {
  const storage = plan.storage?.objectStorage;
  if (storage === undefined) return [];
  const names = new Set([
    ...STORAGE_VARIABLES,
    ...(facts.objectStorage?.variables ?? []),
    ...facts.envVars
      .map((variable) => variable.name)
      .filter((name) => name === "AWS_DEFAULT_REGION" || name === "AWS_USE_PATH_STYLE_ENDPOINT"),
  ]);
  return [...names].flatMap((name) => {
    const kind = storageVariableKind(name);
    if (kind === undefined) return [];
    return [derived(name, kind === "key")];
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
