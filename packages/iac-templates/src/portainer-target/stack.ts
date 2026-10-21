// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are Compose and shell syntax, not JavaScript templates.

import { listText, OpsCrewError, sha256Hex } from "@opscrew/core";
import type {
  DeployPlan,
  PlanService,
  PortainerWeb,
  SelfHostedServiceKind,
} from "@opscrew/plan-schema";
import { stringify } from "yaml";
import { appVariables, enabledServices, renderContext, serviceSpec } from "../catalog";
import type { ServiceSpec } from "../catalog/types";
import { isClientExposedEnvName } from "../docker";
import { CADDY_MEMORY_MB } from "../edge";
import { IMAGES } from "../pins";
import { portainerTarget } from "../providers";
import { type RuntimeContext, siteHosts } from "../runtime";
import {
  appVolumes,
  crontab,
  memoryLimit,
  type RenderedServices,
  renderProcesses,
  renderServices,
  STACK_CRONTAB,
} from "../runtime/components";
import {
  caddyfile,
  cloudflaredService,
  composeLiteral,
  hardened,
  originTlsDir,
  RELEASE_NOTE,
  shellQuote,
} from "../runtime/services";
import { CONNECTOR_MEMORY_MB } from "../tunnel";
import type { RenderedFile } from "../types";
import { DIGEST_REF_PATTERN, hasCronJobs } from "../workflow/shared";
import type { ServiceInitStep } from "../workflow/switch";

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

/** A GHCR image pinned by digest, `ghcr.io/<owner>/<repo>@sha256:<hex>`. */
const GHCR_DIGEST_REF = new RegExp(DIGEST_REF_PATTERN);

/**
 * OpsCrew's own variables in the app stack's environment in Portainer (`Env`), by what each holds.
 * A stack has one environment for all its services, so OpsCrew's values carry the `OPSCREW_`
 * prefix, which the app's variables may not use: the Postgres user, database name and password
 * (`POSTGRES_USER`, `POSTGRES_DB`, `POSTGRES_PASSWORD` in the `db` service, the values of
 * `OPSCREW_SERVICE_DB_ENV` on other targets), the app tunnel's token (`tunnel_token` of the root
 * module, `TUNNEL_TOKEN` in the `cloudflared` service) and, with origin TLS, the stack Caddy's
 * certificates.
 */
export const PORTAINER_STACK_VARIABLES = {
  dbUser: "OPSCREW_DB_USER",
  dbName: "OPSCREW_DB_NAME",
  dbPassword: "OPSCREW_DB_PASSWORD",
  tunnelToken: "OPSCREW_TUNNEL_TOKEN",
  /**
   * With origin TLS in web mode `caddy`: the app's Cloudflare origin certificate, its private key,
   * then the client certificate Cloudflare presents (`pull.pem`), as one PEM text in base64:
   * Portainer writes the stack's variables to an env file one line each, which a PEM's lines would
   * break.
   */
  originTls: "OPSCREW_ORIGIN_TLS",
} as const;

/**
 * The Postgres service's variables and the stack variable each one reads: Postgres keeps the
 * variables it had before the other services, which provision and drift fill in.
 */
const DB_ENV = [
  ["POSTGRES_USER", PORTAINER_STACK_VARIABLES.dbUser],
  ["POSTGRES_DB", PORTAINER_STACK_VARIABLES.dbName],
  ["POSTGRES_PASSWORD", PORTAINER_STACK_VARIABLES.dbPassword],
] as const;

/**
 * The stack variable that holds a service's secret, for every service but Postgres:
 * `OPSCREW_SVC_<SERVICE>_<SECRET>`, upper case with `_` for `-` (`OPSCREW_SVC_MYSQL_ROOT_PASSWORD`).
 * The `SVC_` keeps a service's names apart from OpsCrew's other variables, whatever the service is
 * called (a service named `tunnel` and {@link PORTAINER_STACK_VARIABLES}' tunnel token).
 */
export function portainerServiceVariable(service: string, secret: string): string {
  return `OPSCREW_SVC_${service}_${secret}`.toUpperCase().replaceAll("-", "_");
}

/**
 * The stack variables that hold the running services' secrets, in the plan's order: each with its
 * service and the catalog's name of the secret (Postgres's password is
 * {@link PORTAINER_STACK_VARIABLES}' `dbPassword`; its user and database are not secrets).
 */
export function portainerSecretVariables(
  plan: DeployPlan,
): { service: string; secret: string; variable: string }[] {
  return enabledServices(plan).flatMap((service) =>
    serviceSpec(service.kind).secrets.map((secret) => ({
      service: service.name,
      secret: secret.name,
      variable:
        service.kind === "postgres"
          ? PORTAINER_STACK_VARIABLES.dbPassword
          : portainerServiceVariable(service.name, secret.name),
    })),
  );
}

/** A service's environment in the stack, with its secrets as stack variables. */
function stackEnvironment(plan: DeployPlan) {
  return (service: PlanService, spec: ServiceSpec): Record<string, string> => {
    if (service.kind === "postgres") {
      return Object.fromEntries(DB_ENV.map(([name, variable]) => [name, `\${${variable}}`]));
    }
    const ref = (secret: string) => `\${${portainerServiceVariable(service.name, secret)}}`;
    return spec.environment(renderContext(plan, service, ref));
  };
}

/** The plan's services as the stack runs them. */
function stackServices(plan: DeployPlan): RenderedServices {
  return renderServices(plan, { kind: "portainer", environment: stackEnvironment(plan) });
}

/** Hosted options for the engines a Portainer target cannot run, named in the refusal. */
const HOSTED: Readonly<Partial<Record<SelfHostedServiceKind, string>>> = {
  opensearch: "Amazon OpenSearch Service or Aiven for OpenSearch",
  elasticsearch: "Elastic Cloud",
};

/**
 * Why a Portainer target cannot run `kind`, as one sentence (design says it, provision refuses
 * with it): it needs a kernel setting of the Docker host (the catalog leaves `portainer` out of
 * its `targets`), which OpsCrew never changes there; names a hosted option, or a server instead.
 * Undefined for a kind a stack runs.
 */
export function portainerHostSettingProblem(kind: SelfHostedServiceKind): string | undefined {
  const spec = serviceSpec(kind);
  if (spec.targets.includes("portainer")) return undefined;
  const settings = Object.entries(spec.hostSettings?.sysctl ?? {});
  const lines = listText(settings.map(([key, value]) => `${key} = ${value}`));
  const hosted = HOSTED[kind];
  return `${spec.title} needs the Docker host's kernel setting ${lines}, which OpsCrew cannot set on a Portainer target, so it does not run ${spec.title} in your Portainer: ${hosted === undefined ? "" : `use a hosted ${spec.title} such as ${hosted}, or `}deploy the app to a server OpsCrew sets up, where it makes the setting itself.`;
}

/**
 * Refuses a service a Portainer stack cannot run ({@link portainerHostSettingProblem}), saying
 * how to make its setting by hand: design keeps such engines external, so only a hand-edited plan
 * gets here.
 * @throws OpsCrewError `INVALID_INPUT` for the first such service.
 */
function checkStackServices(plan: DeployPlan): void {
  for (const service of enabledServices(plan)) {
    const problem = portainerHostSettingProblem(service.kind);
    if (problem === undefined) continue;
    const spec = serviceSpec(service.kind);
    const settings = Object.entries(spec.hostSettings?.sysctl ?? {});
    const commands = settings.map(([key, value]) => `sysctl -w ${key}=${value}`).join("; ");
    throw new OpsCrewError("INVALID_INPUT", problem, {
      hint: `To keep it next to your Portainer, make the setting by hand on its Docker host as root (\`${commands}\`, and the same ${settings.length === 1 ? "line" : "lines"} in a file in /etc/sysctl.d/ so a restart keeps ${settings.length === 1 ? "it" : "them"}), run ${spec.title} there yourself, give the app its address in app.env, and turn the service ${service.name} off in opscrew/plan.yaml (services → ${service.name} → enabled: false); then run the command again.`,
    });
  }
}

/**
 * The one-shot service `<service>-init` that runs a service's one-time setup steps (the catalog's
 * `init`, which a server's deploy runs with `docker compose exec`): the service's image, in its
 * network namespace (the steps reach it on localhost, as in the service's own container), with its
 * environment (secrets as the stack's variables) and its data volumes read-only (so Docker adds no
 * anonymous ones for the image's), each step only when its check fails. It runs whenever the
 * stack is deployed, after the service is healthy, and exits; the app waits for it.
 */
function initService(
  service: PlanService,
  spec: ServiceSpec,
  steps: readonly ServiceInitStep[],
  rendered: { environment?: Record<string, string>; volumes?: string[] },
): object {
  const words = (list: readonly string[]) => list.map(shellQuote).join(" ");
  const script = [
    "set -e",
    ...steps.map(
      ({ check, run }) => `if ! ${words(check)} > /dev/null 2>&1; then ${words(run)}; fi`,
    ),
  ].join("\n");
  return {
    image: IMAGES[spec.image].ref,
    restart: "no",
    network_mode: `service:${service.name}`,
    ...(rendered.environment === undefined ? {} : { environment: { ...rendered.environment } }),
    entrypoint: ["sh", "-c", composeLiteral(script)],
    volumes: (rendered.volumes ?? []).map((volume) => `${volume}:ro`),
    depends_on: { [service.name]: { condition: "service_healthy" } },
    ...memoryLimit(service.memoryMb),
    ...hardened(),
  };
}

/**
 * The services' one-time setup in the stack, since Portainer runs no deploy steps: every service
 * with setup steps (MongoDB's replica set) gets its {@link initService}. Adds them to `backing`,
 * and returns what the app's containers wait for besides the services.
 */
function stackSetup(
  plan: DeployPlan,
  backing: RenderedServices,
): Record<string, { condition: string }> {
  const ready: Record<string, { condition: string }> = {};
  for (const service of enabledServices(plan)) {
    const spec = serviceSpec(service.kind);
    const steps = spec.init?.(renderContext(plan, service)) ?? [];
    if (steps.length === 0) continue;
    const rendered = backing.services[service.name] as {
      environment?: Record<string, string>;
      volumes?: string[];
    };
    const name = `${service.name}-init`;
    backing.services[name] = initService(service, spec, steps, rendered);
    ready[name] = { condition: "service_completed_successfully" };
  }
  return ready;
}

/** Variable the tunnel connectors read their token from. */
const TUNNEL_TOKEN = "TUNNEL_TOKEN";

/** The updater's memory limit: its shell loop and one curl call at a time. */
const UPDATER_MEMORY_MB = 16;

/** The stamp's memory limit: one `printf`. */
const STAMP_MEMORY_MB = 16;

/** The named volume the stamp writes the version to, and where Caddy reads it. */
const VERSION_VOLUME = "version";
const CADDY_VERSION_DIR = "/srv/opscrew-version";

/**
 * The one-shot service `stamp`: the pinned curl image, with the image's version in its own
 * environment, writes it to {@link VERSION_VOLUME} and exits, once the new app container started.
 * Only the stamp and the app's containers change from one image to the next, so Portainer's
 * redeploy (Compose `up`, no forced recreate) leaves Caddy running and Caddy holds requests while
 * the app restarts. It runs as root, which owns the new volume, with no capabilities and no
 * network.
 */
function stampService(): object {
  return {
    image: IMAGES.curl.ref,
    restart: "no",
    user: "0:0",
    network_mode: "none",
    environment: { OPSCREW_APP_VERSION: PORTAINER_VERSION_PLACEHOLDER },
    entrypoint: [
      "/bin/sh",
      "-c",
      composeLiteral(`printf '%s\\n' "$OPSCREW_APP_VERSION" > /version/version`),
    ],
    volumes: [`${VERSION_VOLUME}:/version`],
    depends_on: { app: { condition: "service_started" } },
    read_only: true,
    ...memoryLimit(STAMP_MEMORY_MB),
    ...hardened({ noCapabilities: true }),
  };
}

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

/** The first 12 hex digits of the image's digest, which Caddy serves at {@link PORTAINER_VERSION_PATH}. */
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
 * The app's variables in its stack: the conventional ones of each service OpsCrew runs (the
 * catalog's, such as `DATABASE_URL` and `REDIS_URL`) and every variable of `app.env`, except
 * `PORT` (fixed) and the build-time variables of the frontend (they go to the image build, as on
 * other targets). Sorted by code point.
 */
function appEnvKeys(plan: DeployPlan): string[] {
  const names = new Set<string>();
  for (const service of enabledServices(plan)) {
    const variables = appVariables(renderContext(plan, service, () => ""));
    for (const name of Object.keys(variables)) names.add(name);
  }
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
   * The app's variables: the conventional ones of the services OpsCrew runs (`DATABASE_URL`,
   * `REDIS_URL`, …), and every variable of `app.env` except `PORT` and the frontend's build-time
   * variables. Their values are the app's production environment (`OPSCREW_APP_ENV` on other
   * targets); an optional variable left unset is sent as an empty string.
   */
  app: string[];
  /**
   * OpsCrew's own variables: from {@link PORTAINER_STACK_VARIABLES}, and each service's secrets
   * ({@link portainerServiceVariable}).
   */
  opscrew: string[];
}

/**
 * The stack Caddy's origin TLS: only in web mode `caddy`, where OpsCrew's Caddy is the origin
 * Cloudflare reaches (behind a tunnel there is no public origin, behind the user's proxy the
 * user's proxy is the origin).
 */
function stackOriginTls(plan: DeployPlan, ctx: Pick<RuntimeContext, "originTls">) {
  return portainerTarget(plan.target).web.mode === "caddy" ? ctx.originTls : undefined;
}

/**
 * Every variable the app stack interpolates, each list sorted: what its environment in Portainer
 * (`Env`, set through the API, values never in files) must hold. Portainer fills only the
 * `${VARS}` a stack references. The app's and OpsCrew's names never overlap. With `ctx.originTls`
 * in web mode `caddy`, OpsCrew's include {@link PORTAINER_STACK_VARIABLES}' `originTls`.
 * @throws OpsCrewError `INVALID_INPUT` for an app variable named `OPSCREW_*` or `COMPOSE_*`, or a
 * service that needs a setting of the Docker host (so provision stops before any change).
 */
export function portainerStackEnvKeys(
  plan: DeployPlan,
  ctx: Pick<RuntimeContext, "originTls"> = {},
): PortainerStackEnvKeys {
  const { web } = portainerTarget(plan.target);
  checkAppEnvNames(plan);
  checkStackServices(plan);
  const opscrew = new Set(portainerSecretVariables(plan).map((entry) => entry.variable));
  if (enabledServices(plan).some((service) => service.kind === "postgres")) {
    opscrew.add(PORTAINER_STACK_VARIABLES.dbUser);
    opscrew.add(PORTAINER_STACK_VARIABLES.dbName);
  }
  if (web.mode === "tunnel") opscrew.add(PORTAINER_STACK_VARIABLES.tunnelToken);
  if (stackOriginTls(plan, ctx) !== undefined) opscrew.add(PORTAINER_STACK_VARIABLES.originTls);
  return { app: appEnvKeys(plan), opscrew: [...opscrew].sort() };
}

/** Named volumes of the app stack, in the order the stack declares them: the stamp's is last. */
function volumeNames(services: RenderedServices, web: PortainerWeb): string[] {
  return [
    ...services.volumes,
    ...(web.mode === "caddy" ? ["caddy_data", "caddy_config"] : []),
    VERSION_VOLUME,
  ];
}

/**
 * The Docker volumes the app stack creates (`<stack>_<volume>`): each service's data
 * (`<service>_data`, for example `db_data`), a SQLite database's (`sqlite`), Caddy's certificates
 * in `caddy` mode, and last the stamp's {@link portainerVersionVolume}. Stack deletion keeps
 * them; they go only with data deletion.
 */
export function portainerStackVolumes(plan: DeployPlan): string[] {
  const { web } = portainerTarget(plan.target);
  return volumeNames(stackServices(plan), web).map(
    (volume) => `${portainerStackName(plan)}_${volume}`,
  );
}

/** The stamp's volume (`<stack>_version`): only the version the site serves, no data. */
export function portainerVersionVolume(plan: DeployPlan): string {
  return `${portainerStackName(plan)}_${VERSION_VOLUME}`;
}

/**
 * The stack Caddy's entrypoint with origin TLS (sh, after Compose turned `$$` into `$`): decodes
 * {@link PORTAINER_STACK_VARIABLES}' `originTls` into `dir`, its tmpfs (what comes before the
 * private key as `origin.pem`, the key as `origin.key`, the certificate after it as `pull.pem`),
 * drops the variable from Caddy's environment, then runs Caddy as its image does. The value goes
 * only through a pipe, never a command line.
 */
function originTlsEntrypoint(dir: string): string {
  const files = [
    'BEGIN { f = "origin.pem" }',
    '/-BEGIN [A-Z ]*PRIVATE KEY-/ { f = "origin.key" }',
    '/-BEGIN CERTIFICATE-/ && f == "origin.key" { f = "pull.pem" }',
    `{ print > ("${dir}/" f) }`,
  ].join(" ");
  const variable = PORTAINER_STACK_VARIABLES.originTls;
  return [
    `umask 077 && printf '%s' "$${variable}" | base64 -d | awk '${files}' && unset ${variable}`,
    "exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile",
  ].join("\n");
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
 * {@link PORTAINER_STACK_VARIABLES} and {@link portainerServiceVariable}); the release command runs
 * as the one-off service `release` the app, its workers and cron wait for; the services keep their
 * data in named volumes, and the app's image its SQLite database in `sqlite`; Caddy's configuration, the services' settings files and the crontab are
 * inline (`configs.<name>.content`, Compose 2.23 or newer), so no file sits next to the stack; the
 * web mode adds a cloudflared service (`tunnel`), publishes the chosen port (`proxy`) or ports
 * 80/443 (`caddy`); every service rotates its logs and runs with `no-new-privileges`. Portainer
 * runs no deploy steps, so the services' one-time setup is in the stack: Garage makes the app's
 * key and bucket itself, and MongoDB's replica set is initiated by a one-shot service the app
 * waits for (see {@link stackSetup}). With `ctx.originTls` in web mode `caddy`, Caddy serves the
 * same site as a server's edge, with the origin certificate and client certificate it writes from
 * {@link PORTAINER_STACK_VARIABLES}' `originTls` to a tmpfs before it starts. A redeploy
 * recreates only the containers of the app's image and the one-shot {@link stampService}, which
 * writes the version Caddy serves at {@link PORTAINER_VERSION_PATH}; Caddy stays and holds
 * requests while the app restarts.
 * @throws OpsCrewError `INVALID_INPUT` for an app variable named `OPSCREW_*` or `COMPOSE_*`, a
 * service OpsCrew cannot run as planned (in a stack: one that needs a setting of the Docker host),
 * or a cron route the image cannot call.
 */
export function renderPortainerStack(plan: DeployPlan, ctx: RuntimeContext): RenderedFile {
  const { web } = portainerTarget(plan.target);
  checkAppEnvNames(plan);
  checkStackServices(plan);
  const environment = () => ({
    PORT: String(plan.app.port),
    ...Object.fromEntries(appEnvKeys(plan).map((name) => [name, `\${${name}}`])),
  });
  const backing = stackServices(plan);
  // What the release command, the app, its workers and cron wait for: the healthy services and
  // their finished one-time setup.
  const ready = { ...backing.dependsOn, ...stackSetup(plan, backing) };

  const app: Record<string, unknown> = {
    image: PORTAINER_IMAGE_PLACEHOLDER,
    restart: "unless-stopped",
    environment: environment(),
    ...appVolumes(plan),
    ...memoryLimit(plan.app.memoryMb),
    ...hardened({ noCapabilities: true, internal: true }),
  };
  const services: Record<string, unknown> = { app };
  const release = plan.app.releaseCommand;
  const appDependsOn: Record<string, { condition: string }> = { ...ready };
  if (release !== undefined) {
    // A one-off container of the new image: Compose starts the app only after it succeeded.
    services.release = {
      image: PORTAINER_IMAGE_PLACEHOLDER,
      environment: environment(),
      ...appVolumes(plan),
      // `$$` keeps Compose from substituting variables: the shell in the container sees `$`.
      command: ["sh", "-c", composeLiteral(release)],
      ...memoryLimit(plan.app.memoryMb),
      ...(Object.keys(ready).length > 0 ? { depends_on: ready } : {}),
      ...hardened({ noCapabilities: true, internal: true }),
    };
    appDependsOn.release = { condition: "service_completed_successfully" };
  }
  if (Object.keys(appDependsOn).length > 0) app.depends_on = appDependsOn;
  Object.assign(
    services,
    renderProcesses(plan, {
      image: PORTAINER_IMAGE_PLACEHOLDER,
      environment: () => ({ environment: environment() }),
      dependsOn: appDependsOn,
      crontab: { configs: [STACK_CRONTAB] },
    }),
    backing.services,
  );

  const origin = stackOriginTls(plan, ctx);
  const tlsDir = originTlsDir(plan.app.name);
  const config = caddyfile({
    mode: web.mode === "caddy" ? "direct" : web.mode,
    hosts: siteHosts(plan),
    // Portainer restarts the app in place (no start-first), so Caddy reaches it directly (no
    // kamal-proxy) and holds requests while it restarts.
    upstream: `app:${plan.app.port}`,
    acmeEmail: ctx.acmeEmail,
    origin: origin === undefined ? undefined : { hostnames: origin.hostnames, dir: tlsDir },
    versionDir: CADDY_VERSION_DIR,
  }).join("\n");
  const ports = caddyPorts(web);
  const tlsVariable = PORTAINER_STACK_VARIABLES.originTls;
  services.stamp = stampService();
  // Nothing here changes with the image, so a redeploy leaves Caddy running.
  services.caddy = {
    image: IMAGES.caddy.ref,
    restart: "unless-stopped",
    ...(ports === undefined ? {} : { ports }),
    ...(origin === undefined ? {} : { environment: { [tlsVariable]: `\${${tlsVariable}}` } }),
    // The certificates live only in memory, written from the variable before Caddy starts.
    ...(origin === undefined
      ? {}
      : {
          entrypoint: ["/bin/sh", "-c", composeLiteral(originTlsEntrypoint(tlsDir))],
          tmpfs: [`${tlsDir}:mode=0700`],
        }),
    // A changed Caddyfile changes this label, so Compose recreates Caddy with the new configuration.
    labels: { "dev.opscrew.caddyfile-sha256": sha256Hex(config) },
    configs: [{ source: "caddyfile", target: "/etc/caddy/Caddyfile" }],
    volumes: [
      ...(web.mode === "caddy" ? ["caddy_data:/data", "caddy_config:/config"] : []),
      `${VERSION_VOLUME}:${CADDY_VERSION_DIR}:ro`,
    ],
    depends_on: ["app"],
    // As the server edge's Caddy (FR-1325, SC-1304).
    ...memoryLimit(CADDY_MEMORY_MB),
    ...hardened({ internal: true }),
  };
  if (web.mode === "tunnel") {
    // The connector reaches Caddy on the stack's network (http://caddy:80).
    services.cloudflared = cloudflaredService(
      {
        environment: { [TUNNEL_TOKEN]: `\${${PORTAINER_STACK_VARIABLES.tunnelToken}}` },
        depends_on: ["caddy"],
        ...memoryLimit(CONNECTOR_MEMORY_MB),
      },
      true,
    );
  }

  const volumes = volumeNames(backing, web);
  const document = {
    name: portainerStackName(plan),
    services,
    networks: { internal: {} },
    volumes: Object.fromEntries(volumes.map((v) => [v, {}])),
    configs: {
      caddyfile: { content: composeLiteral(config) },
      ...backing.configs,
      ...(hasCronJobs(plan)
        ? { [STACK_CRONTAB.source]: { content: composeLiteral(crontab(plan)) } }
        : {}),
    },
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
        image: IMAGES.curl.ref,
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
        image: IMAGES.curl.ref,
        restart: "unless-stopped",
        entrypoint: ["/bin/sh", "-c", composeLiteral(UPDATER_LOOP)],
        environment: {
          PORTAINER_WEBHOOK_URL: "${PORTAINER_WEBHOOK_URL}",
          PORTAINER_PINNED_KEY: "${PORTAINER_PINNED_KEY}",
        },
        extra_hosts: ["host.docker.internal:host-gateway"],
        init: true,
        read_only: true,
        ...memoryLimit(UPDATER_MEMORY_MB),
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
        ...memoryLimit(CONNECTOR_MEMORY_MB),
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
