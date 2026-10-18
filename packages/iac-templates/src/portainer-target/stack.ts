// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are Compose and shell syntax, not JavaScript templates.
import { OpsCrewError, sha256Hex } from "@opscrew/core";
import type { DeployPlan, PortainerWeb } from "@opscrew/plan-schema";
import { stringify } from "yaml";
import { isClientExposedEnvName } from "../docker";
import { IMAGES } from "../pins";
import { portainerTarget } from "../providers";
import { siteHosts } from "../runtime";
import {
  CADDY_IMAGE,
  cacheService,
  caddyfile,
  cloudflaredService,
  composeLiteral,
  dbService,
  hardened,
  RELEASE_NOTE,
} from "../runtime/services";
import type { RenderContext, RenderedFile } from "../types";
import { DIGEST_REF_PATTERN } from "../workflow/shared";

/** The official curl image of the updater stack and the placeholder stack, from `pins.ts`. */
export const CURL_IMAGE = IMAGES.curl.ref;

/** Branch of the app's repository that holds only the stack file Portainer deploys. */
export const PORTAINER_DEPLOY_BRANCH = "opscrew-deploy";

/** The stack file on {@link PORTAINER_DEPLOY_BRANCH} (Portainer's `ComposeFile`). */
export const PORTAINER_COMPOSE_FILE = "compose.yaml";

/** Where the app stack's template is committed; the deploy workflow fills it in. */
export const PORTAINER_STACK_TEMPLATE_PATH = "opscrew/runtime/compose.yaml";

/** Stands for the image in the template; the deploy workflow writes the digest it built. */
export const PORTAINER_IMAGE_PLACEHOLDER = "__OPSCREW_APP_IMAGE__";

/** Stands for {@link portainerImageVersion} of that image in the template. */
export const PORTAINER_VERSION_PLACEHOLDER = "__OPSCREW_APP_VERSION__";

/**
 * Response header Caddy adds with {@link portainerImageVersion} of the running image: the deploy
 * workflow knows the new version runs when the site answers with it.
 */
export const PORTAINER_VERSION_HEADER = "X-OpsCrew-Image";

/** A GHCR image pinned by digest, `ghcr.io/<owner>/<repo>@sha256:<hex>`. */
const GHCR_DIGEST_REF = new RegExp(DIGEST_REF_PATTERN);

/**
 * OpsCrew's own variables in the app stack's environment in Portainer (`Env`), by what each holds.
 * A stack has one environment for all its services, so OpsCrew's values carry the `OPSCREW_`
 * prefix, which the app's variables may not use: the Postgres user, database name and password
 * (`POSTGRES_USER`, `POSTGRES_DB`, `POSTGRES_PASSWORD` in the `db` service, the values of
 * `OPSCREW_DB_ENV` on other targets) and the app tunnel's token (`tunnel_token` of the root
 * module, `TUNNEL_TOKEN` in the `cloudflared` service).
 */
export const PORTAINER_STACK_VARIABLES = {
  dbUser: "OPSCREW_DB_USER",
  dbName: "OPSCREW_DB_NAME",
  dbPassword: "OPSCREW_DB_PASSWORD",
  tunnelToken: "OPSCREW_TUNNEL_TOKEN",
} as const;

/** The Postgres service's variables and the stack variable each one reads. */
const DB_ENV = [
  ["POSTGRES_USER", PORTAINER_STACK_VARIABLES.dbUser],
  ["POSTGRES_DB", PORTAINER_STACK_VARIABLES.dbName],
  ["POSTGRES_PASSWORD", PORTAINER_STACK_VARIABLES.dbPassword],
] as const;

/** Variable the tunnel connectors read their token from. */
const TUNNEL_TOKEN = "TUNNEL_TOKEN";

/**
 * Prefixes the app's variables may not use in a stack: OpsCrew's own values, and the settings
 * Docker Compose reads from the environment it runs in (`COMPOSE_PROJECT_NAME`, `COMPOSE_FILE`, …).
 */
const RESERVED_PREFIXES = [
  { prefix: "OPSCREW_", reason: "OpsCrew keeps for its own values in the stack's environment" },
  { prefix: "COMPOSE_", reason: "Docker Compose reads as its own settings" },
] as const;

/** A stack OpsCrew creates in Portainer from a string (never a file in the repository). */
export interface PortainerStackFile {
  /** Portainer stack name, also the Compose project name. */
  name: string;
  /** The compose file. */
  content: string;
}

/** The app's stack in Portainer: `opscrew-<app>`. */
export function portainerStackName(plan: DeployPlan): string {
  return `opscrew-${plan.app.name}`;
}

/** The updater stack: `opscrew-<app>-updater`. */
export function portainerUpdaterStackName(plan: DeployPlan): string {
  return `${portainerStackName(plan)}-updater`;
}

/** The stack of the connector that serves Portainer's webhook: `opscrew-<app>-portainer-tunnel`. */
export function portainerConnectorStackName(plan: DeployPlan): string {
  return `${portainerStackName(plan)}-portainer-tunnel`;
}

/** The first 12 hex digits of the image's digest, which Caddy reports in {@link PORTAINER_VERSION_HEADER}. */
export function portainerImageVersion(image: string): string {
  return checkImage(image)
    .slice(image.indexOf("@sha256:") + "@sha256:".length)
    .slice(0, 12);
}

function checkImage(image: string): string {
  if (!GHCR_DIGEST_REF.test(image)) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      "The app's image must be a GitHub Container Registry image pinned by digest (ghcr.io/<owner>/<repo>@sha256:<64 hex digits>).",
      { hint: "Use the digest the deploy workflow pushed (its build job reports it)." },
    );
  }
  return image;
}

/**
 * The template with the image filled in, exactly as the deploy workflow writes it to the deploy
 * branch: every {@link PORTAINER_IMAGE_PLACEHOLDER} becomes `image`, every
 * {@link PORTAINER_VERSION_PLACEHOLDER} its {@link portainerImageVersion}.
 */
export function fillPortainerStack(template: string, image: string): string {
  const version = portainerImageVersion(image);
  return template
    .replaceAll(PORTAINER_IMAGE_PLACEHOLDER, image)
    .replaceAll(PORTAINER_VERSION_PLACEHOLDER, version);
}

/**
 * The app's variables in its stack: the Postgres and Redis URLs OpsCrew sets and every variable of
 * `app.env`, except `PORT` (fixed) and the build-time variables of the frontend (they go to the
 * image build, as on other targets). Sorted by code point.
 */
function appEnvKeys(plan: DeployPlan): string[] {
  const names = new Set<string>();
  if (plan.services.postgres) names.add("DATABASE_URL");
  if (plan.services.redis) names.add("REDIS_URL");
  for (const variable of plan.app.env) {
    if (variable.name === "PORT" || isClientExposedEnvName(variable.name)) continue;
    names.add(variable.name);
  }
  return [...names].sort();
}

/**
 * Refuses app variables whose names the stack's one environment keeps for OpsCrew or Compose.
 * @throws OpsCrewError `INVALID_INPUT` naming every such variable.
 */
function checkAppEnvNames(plan: DeployPlan): void {
  for (const { prefix, reason } of RESERVED_PREFIXES) {
    const taken = plan.app.env
      .map((variable) => variable.name)
      .filter((name) => name.toUpperCase().startsWith(prefix));
    if (taken.length === 0) continue;
    const names = taken.join(", ");
    throw new OpsCrewError(
      "INVALID_INPUT",
      `The app's ${taken.length === 1 ? "variable" : "variables"} ${names} ${taken.length === 1 ? "starts" : "start"} with ${prefix}, which ${reason}, and a Portainer stack has one environment for all its services.`,
      {
        hint: `Rename ${names} in the app and in opscrew/plan.yaml (app.env), then run the command again.`,
      },
    );
  }
}

/** The variables of an app stack's environment in Portainer, by whose values they hold. */
export interface PortainerStackEnvKeys {
  /**
   * The app's variables: `DATABASE_URL` and `REDIS_URL` when OpsCrew runs those services, and every
   * variable of `app.env` except `PORT` and the frontend's build-time variables. Their values are
   * the app's production environment (`OPSCREW_APP_ENV` on other targets); an optional variable
   * left unset is sent as an empty string.
   */
  app: string[];
  /** OpsCrew's own variables, from {@link PORTAINER_STACK_VARIABLES}. */
  opscrew: string[];
}

/**
 * Every variable the app stack interpolates, each list sorted: what its environment in Portainer
 * (`Env`, set through the API, values never in files) must hold. Portainer fills only the
 * `${VARS}` a stack references. The app's and OpsCrew's names never overlap.
 * @throws OpsCrewError `INVALID_INPUT` for an app variable named `OPSCREW_*` or `COMPOSE_*`.
 */
export function portainerStackEnvKeys(plan: DeployPlan): PortainerStackEnvKeys {
  const { web } = portainerTarget(plan.target);
  checkAppEnvNames(plan);
  const opscrew: string[] = [];
  if (plan.services.postgres) opscrew.push(...DB_ENV.map(([, variable]) => variable));
  if (web.mode === "tunnel") opscrew.push(PORTAINER_STACK_VARIABLES.tunnelToken);
  return { app: appEnvKeys(plan), opscrew: opscrew.sort() };
}

/** Named volumes of the app stack, in the order the stack declares them. */
function volumeNames(plan: DeployPlan, web: PortainerWeb): string[] {
  return [
    ...(plan.services.postgres ? ["postgres_data"] : []),
    ...(plan.services.redis ? ["valkey_data"] : []),
    ...(web.mode === "caddy" ? ["caddy_data", "caddy_config"] : []),
  ];
}

/**
 * The Docker volumes the app stack creates (`<stack>_<volume>`): Postgres and Valkey data, and
 * Caddy's certificates in `caddy` mode. Stack deletion keeps them; they go only with data deletion.
 */
export function portainerStackVolumes(plan: DeployPlan): string[] {
  const { web } = portainerTarget(plan.target);
  return volumeNames(plan, web).map((volume) => `${portainerStackName(plan)}_${volume}`);
}

/** Caddy's published ports: none behind the tunnel, the chosen port for a proxy, else 80/443. */
function caddyPorts(web: PortainerWeb): string[] | undefined {
  if (web.mode === "tunnel") return undefined;
  if (web.mode === "proxy") return [`${web.port}:80`];
  return ["80:80", "443:443", "443:443/udp"];
}

function yamlDocument(header: string, document: unknown): string {
  return `${header}\n${stringify(document, { lineWidth: 0, aliasDuplicateObjects: false })}`;
}

const STACK_HEADER = [
  "# Generated by OpsCrew from opscrew/plan.yaml; `opscrew provision` regenerates it.",
  "# The app's stack in your Portainer. The deploy workflow fills in the image it built and writes",
  "# this file to the opscrew-deploy branch, which Portainer deploys. The variables' values live only",
  "# in the stack's environment in Portainer.",
].join("\n");

/**
 * The app's stack (`opscrew-<app>`) for a Portainer target: the template committed at
 * {@link PORTAINER_STACK_TEMPLATE_PATH}, which the deploy workflow fills in
 * ({@link fillPortainerStack}) and writes to {@link PORTAINER_DEPLOY_BRANCH}.
 *
 * Every app variable is an explicit `${VAR}` in `environment:` (values only in the stack's `Env`,
 * see {@link portainerStackEnvKeys}; OpsCrew's own values are `OPSCREW_*` variables, see
 * {@link PORTAINER_STACK_VARIABLES}); the release command runs as the one-off service `release` the
 * app waits for; Postgres and Valkey keep their data in named volumes; Caddy's configuration is
 * inline (`configs.<name>.content`, Compose 2.23 or newer), so no file sits next to the stack; the
 * web mode adds a cloudflared service (`tunnel`), publishes the chosen port (`proxy`) or ports
 * 80/443 (`caddy`); every service rotates its logs and runs with `no-new-privileges`.
 * @throws OpsCrewError `INVALID_INPUT` for an app variable named `OPSCREW_*` or `COMPOSE_*`.
 */
export function renderPortainerStack(plan: DeployPlan, ctx: RenderContext): RenderedFile {
  const { web } = portainerTarget(plan.target);
  checkAppEnvNames(plan);
  const environment = () => ({
    PORT: String(plan.app.port),
    ...Object.fromEntries(appEnvKeys(plan).map((name) => [name, `\${${name}}`])),
  });
  const backing = () => ({
    ...(plan.services.postgres ? { db: { condition: "service_healthy" } } : {}),
    ...(plan.services.redis ? { cache: { condition: "service_started" } } : {}),
  });

  const app: Record<string, unknown> = {
    image: PORTAINER_IMAGE_PLACEHOLDER,
    restart: "unless-stopped",
    environment: environment(),
    ...hardened({ noCapabilities: true, internal: true }),
  };
  const services: Record<string, unknown> = { app };
  const release = plan.app.releaseCommand;
  const appDependsOn: Record<string, { condition: string }> = backing();
  if (release !== undefined) {
    // A one-off container of the new image: Compose starts the app only after it succeeded.
    const releaseDependsOn = backing();
    services.release = {
      image: PORTAINER_IMAGE_PLACEHOLDER,
      environment: environment(),
      // `$$` keeps Compose from substituting variables: the shell in the container sees `$`.
      command: ["sh", "-c", composeLiteral(release)],
      ...(Object.keys(releaseDependsOn).length > 0 ? { depends_on: releaseDependsOn } : {}),
      ...hardened({ noCapabilities: true, internal: true }),
    };
    appDependsOn.release = { condition: "service_completed_successfully" };
  }
  if (Object.keys(appDependsOn).length > 0) app.depends_on = appDependsOn;
  if (plan.services.postgres) {
    const credentials = DB_ENV.map(([name, variable]) => [name, `\${${variable}}`]);
    services.db = dbService({ environment: Object.fromEntries(credentials) }, "postgres_data");
  }
  if (plan.services.redis) services.cache = cacheService("valkey_data");

  const config = caddyfile({
    mode: web.mode === "caddy" ? "direct" : web.mode,
    hosts: siteHosts(plan),
    // Portainer recreates the stack, so Caddy reaches the app directly (no kamal-proxy).
    upstream: `app:${plan.app.port}`,
    acmeEmail: ctx.acmeEmail,
    // Caddy reads the variable when it starts: the version of the image the stack runs.
    headers: [`\t\t${PORTAINER_VERSION_HEADER} "{$OPSCREW_APP_VERSION}"`],
  }).join("\n");
  const ports = caddyPorts(web);
  services.caddy = {
    image: CADDY_IMAGE,
    restart: "unless-stopped",
    ...(ports === undefined ? {} : { ports }),
    environment: { OPSCREW_APP_VERSION: PORTAINER_VERSION_PLACEHOLDER },
    // A changed Caddyfile changes this label, so Compose recreates Caddy with the new configuration.
    labels: { "dev.opscrew.caddyfile-sha256": sha256Hex(config) },
    configs: [{ source: "caddyfile", target: "/etc/caddy/Caddyfile" }],
    ...(web.mode === "caddy" ? { volumes: ["caddy_data:/data", "caddy_config:/config"] } : {}),
    depends_on: ["app"],
    ...hardened({ internal: true }),
  };
  if (web.mode === "tunnel") {
    // The connector reaches Caddy on the stack's network (http://caddy:80).
    services.cloudflared = cloudflaredService(
      {
        environment: { [TUNNEL_TOKEN]: `\${${PORTAINER_STACK_VARIABLES.tunnelToken}}` },
        depends_on: ["caddy"],
      },
      true,
    );
  }

  const volumes = volumeNames(plan, web);
  const document = {
    name: portainerStackName(plan),
    services,
    networks: { internal: {} },
    ...(volumes.length > 0 ? { volumes: Object.fromEntries(volumes.map((v) => [v, {}])) } : {}),
    configs: { caddyfile: { content: composeLiteral(config) } },
  };
  const header = release === undefined ? STACK_HEADER : `${STACK_HEADER}\n${RELEASE_NOTE}`;
  return {
    path: PORTAINER_STACK_TEMPLATE_PATH,
    content: yamlDocument(header, document),
    kind: "runtime",
  };
}

/**
 * The first `compose.yaml` of {@link PORTAINER_DEPLOY_BRANCH} (research R11): Portainer deploys a
 * Git stack as soon as it is created, before the deploy workflow built the app's image, so the
 * branch starts with one service from the pinned curl image that only sleeps (no ports, no
 * variables). It is named `app`, so the first real deploy replaces it.
 */
export function renderPlaceholderStack(plan: DeployPlan): RenderedFile {
  const document = {
    name: portainerStackName(plan),
    services: {
      app: {
        image: CURL_IMAGE,
        restart: "unless-stopped",
        entrypoint: ["/bin/sh", "-c", "while true; do sleep 3600; done"],
        init: true,
        read_only: true,
        ...hardened({ noCapabilities: true, internal: true }),
      },
    },
    networks: { internal: {} },
  };
  const header = [
    "# Generated by OpsCrew: a placeholder until the deploy workflow writes the app's first version",
    "# to this branch. It only sleeps.",
  ].join("\n");
  return { path: PORTAINER_COMPOSE_FILE, content: yamlDocument(header, document), kind: "runtime" };
}

/**
 * The updater's loop (sh, after Compose turned `$$` into `$`): ask Portainer once a minute to
 * redeploy the app stack from the deploy branch (Portainer fetches it and redeploys only when it
 * changed). With a pinned key, curl checks Portainer's public key instead of a certificate
 * authority (Portainer's own certificate is self-signed); libcurl checks the pin even with
 * `--insecure`. A failed call is logged without the URL (the webhook is a secret) and the loop goes
 * on. The URL and the key are only ever expanded inside double quotes.
 */
const UPDATER_LOOP = [
  'if [ -n "$PORTAINER_PINNED_KEY" ]; then',
  '  set -- --insecure --pinnedpubkey "$PORTAINER_PINNED_KEY"',
  "fi",
  "while true; do",
  '  curl -fsS --connect-timeout 10 --max-time 900 -X POST -o /dev/null "$@" "$PORTAINER_WEBHOOK_URL" ||',
  '    echo "OpsCrew updater: asking Portainer to redeploy the app failed; trying again in 60 seconds." >&2',
  "  sleep 60",
  "done",
].join("\n");

/**
 * The updater stack (`opscrew-<app>-updater`, research R5): the pinned curl image calls
 * `POST ${PORTAINER_WEBHOOK_URL}` every 60 seconds with `--pinnedpubkey ${PORTAINER_PINNED_KEY}`.
 * Both come from the stack's environment in Portainer, never from a file: the webhook URL
 * (`<portainer>/api/stacks/webhooks/<uuid>`, a secret) and Portainer's pinned public key
 * (`sha256//<base64 of the SHA-256 of its SubjectPublicKeyInfo>`; empty for a certificate a public
 * authority signed, or plain HTTP). `host.docker.internal` reaches the host when Portainer's
 * address is not reachable from containers. Its own stack, so a failed app update cannot stop it.
 */
export function renderUpdaterStack(plan: DeployPlan): PortainerStackFile {
  const name = portainerUpdaterStackName(plan);
  const document = {
    name,
    services: {
      updater: {
        image: CURL_IMAGE,
        restart: "unless-stopped",
        entrypoint: ["/bin/sh", "-c", composeLiteral(UPDATER_LOOP)],
        environment: {
          PORTAINER_WEBHOOK_URL: "${PORTAINER_WEBHOOK_URL}",
          PORTAINER_PINNED_KEY: "${PORTAINER_PINNED_KEY}",
        },
        extra_hosts: ["host.docker.internal:host-gateway"],
        init: true,
        read_only: true,
        ...hardened({ noCapabilities: true }),
      },
    },
  };
  const header = [
    "# Generated by OpsCrew. Asks Portainer once a minute to redeploy the app's stack from the",
    "# opscrew-deploy branch; Portainer redeploys only when the branch changed. The webhook URL and",
    "# Portainer's pinned public key are in this stack's environment in Portainer, never in a file.",
  ].join("\n");
  return { name, content: yamlDocument(header, document) };
}

/**
 * The connector of the tunnel that serves Portainer's webhook behind Cloudflare Access (redeploy
 * mode `cloudflare`), as its own stack `opscrew-<app>-portainer-tunnel`, so a failed app update
 * cannot stop it. Its token (`portainer_tunnel_token` of the root module) is `TUNNEL_TOKEN` in the
 * stack's environment; `host.docker.internal` reaches the host when Portainer's address is not
 * reachable from containers.
 */
export function renderPortainerConnectorStack(plan: DeployPlan): PortainerStackFile {
  const name = portainerConnectorStackName(plan);
  const document = {
    name,
    services: {
      cloudflared: cloudflaredService({
        environment: { [TUNNEL_TOKEN]: `\${${TUNNEL_TOKEN}}` },
        extra_hosts: ["host.docker.internal:host-gateway"],
      }),
    },
  };
  const header = [
    "# Generated by OpsCrew. The Cloudflare Tunnel connector that lets the deploy workflow reach",
    "# Portainer's webhook through Cloudflare Access; it opens no port. Its token is in this stack's",
    "# environment in Portainer, never in a file.",
  ].join("\n");
  return { name, content: yamlDocument(header, document) };
}
