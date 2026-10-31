// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are Compose syntax, not JavaScript templates.

import type { OpsCrewError } from "@opscrew/core";
import { APP_SERVER, type DeployPlan, isServerlessTarget } from "@opscrew/plan-schema";
import { stringify } from "yaml";
import {
  additionsPath,
  appDir,
  caddyAdditionsFile,
  EDGE_PROJECT,
  EDGE_UPSTREAM,
  edgeProxy,
  type LocalhostSite,
  renderEdgeCompose,
} from "../edge";
import { localhostSite } from "../edge/localhost";
import { type NginxSite, nginxAdditionsFile, nginxSite } from "../edge/nginx";
import { notOnServer, wrongTarget } from "../providers";
import { runtimeDir } from "../runtime-dir";
import { CONNECTOR_MEMORY_MB, CONNECTOR_METRICS, tunnelMode } from "../tunnel";
import type { RenderContext, RenderedFile } from "../types";
import { hasCronJobs, planFilePath } from "../workflow/shared";
import {
  appVolumes,
  crontab,
  extraServer,
  memoryLimit,
  renderProcesses,
  renderServices,
  SERVER_CRONTAB,
  STACK_CRONTAB,
} from "./components";
import { appHealthcheck } from "./healthcheck";
import { privateAddress } from "./network";

export {
  CRON_ROUTE_MEMORY_MB,
  cronMemoryMb,
  hostSettingsServices,
  publishedOnNetwork,
  SQLITE_VOLUME,
  sqliteVolumeOwner,
} from "./components";

import {
  caddySite,
  cloudflaredService,
  composeLiteral,
  hardened,
  originTlsDir,
  releaseNote,
} from "./services";

export { shellQuote } from "./services";

/** The app's Compose project on this computer: `opscrew-<app>`, apart from the user's own. */
export function localComposeProject(plan: Pick<DeployPlan, "app">): string {
  return `opscrew-${plan.app.name}`;
}

/**
 * What the app's site and its deploy need from provision besides the plan, in addition to the
 * {@link RenderContext}. Never a secret: the origin certificate's key reaches the server only as a
 * deploy secret or a Portainer stack variable.
 */
export interface RuntimeContext extends RenderContext {
  /**
   * The app's proxied hostnames that have a Cloudflare origin certificate: the server's proxy
   * serves it for them and requires the client certificate Cloudflare sends for the app. Absent
   * without origin TLS (DNS-only hostnames, a token without the certificate permissions); ignored
   * behind a Cloudflare Tunnel, where the server has no public origin, and in a stack behind the
   * user's own proxy.
   */
  originTls?: { hostnames: readonly string[] } | undefined;
  /**
   * The app has its own additions for the plan's proxy (`additionsPath`: the first app's
   * `opscrew/proxy/additions.caddy` or `additions.nginx`), which its site includes.
   */
  additions?: boolean | undefined;
  /**
   * The localhost target: the app's hostname on this computer, which its site serves with the leaf
   * certificate of OpsCrew's local CA. Required there; origin TLS, the ACME email and Cloudflare's
   * addresses do not apply.
   */
  localhost?: LocalhostSite | undefined;
}

/** A Portainer target's stack holds both files: reaching these renderers with one is a bug. */
function notForPortainer(): OpsCrewError {
  return wrongTarget(
    "An app in your existing Portainer has no server Compose file or Caddyfile: OpsCrew writes its Portainer stack (opscrew/runtime/compose.yaml) instead.",
  );
}

/** Hostnames Caddy serves; empty when the plan has no domain yet. */
export function siteHosts(plan: DeployPlan): string[] {
  const domain = plan.dns.domain;
  if (!domain) return [];
  return plan.dns.www ? [domain, `www.${domain}`] : [domain];
}

/**
 * `<runtimeDir>/compose.yaml`, the app's own Compose project on the server (`/srv/apps/<app>`,
 * project `<app>`): the app, its workers and cron, and the plan's services on the app's server
 * (see {@link renderServices}; those placed on an extra server are in its own file,
 * {@link renderServerCompose}), on the app's internal network. The app's web service also joins the
 * shared edge's network, where kamal-proxy switches between its copies; the edge's Caddy and
 * kamal-proxy are not in this file ({@link renderEdgeCompose}). The app has no container name and
 * no host port, so a second copy can start next to it. Every container of the app's image has the
 * memory limit its plan entry gives (`app.memoryMb` for the app and the release command; cron's
 * from `cronMemoryMb`),
 * and on SQLite the volume `sqlite` on the database's folder ({@link appVolumes}).
 * On this computer (the localhost target) the project is `opscrew-<app>`, apart from any Compose
 * project of the user's own, the services keep their data in its named volumes, their settings
 * files and the crontab are inline configs, and the app's images are pulled only when this computer
 * does not have them (`pull_policy: missing`): an image built here is never pulled, since no
 * registry has it, and the image GitHub Actions built is pulled by its digest the first time.
 * Throws for a Portainer target, whose stack `renderPortainerStack` renders.
 * @throws OpsCrewError `INVALID_INPUT` for a service OpsCrew cannot run as planned, or a SQLite
 * folder in an image whose app folder OpsCrew does not know.
 */
export function renderCompose(plan: DeployPlan): RenderedFile {
  if (plan.target.provider === "portainer") throw notForPortainer();
  if (isServerlessTarget(plan.target)) throw notOnServer(plan.target.provider, "Compose file");
  const local = plan.target.provider === "localhost";
  const pull = local ? { pull_policy: "missing" } : {};
  const header = [
    `# Generated by OpsCrew from ${planFilePath(plan)}; \`opscrew provision\` regenerates it.`,
    local
      ? "# The local deploy copies it to the app's folder on this computer."
      : `# The deploy workflow copies it to ${appDir(plan)} on the server.`,
    ...(plan.app.releaseCommand === undefined ? [] : [releaseNote(plan)]),
  ].join("\n");
  const image = "${APP_IMAGE:?APP_IMAGE is not set; deploy with the OpsCrew workflow}";
  const healthcheck = appHealthcheck(plan);
  const backing = renderServices(plan, { kind: "server" });
  const environment = () => ({
    env_file: ["app.env"],
    environment: { PORT: String(plan.app.port) },
  });
  const app: Record<string, unknown> = {
    image,
    ...pull,
    restart: "unless-stopped",
    ...environment(),
    ...appVolumes(plan),
    ...(healthcheck === undefined ? {} : { healthcheck }),
    // Docker waits this long after SIGTERM: the drain, plus time to finish shutting down.
    stop_grace_period: `${plan.deploy.drainSeconds + 5}s`,
    ...memoryLimit(plan.app.memoryMb),
    ...hardened({ noCapabilities: true }),
    // The edge's kamal-proxy reaches each copy there by its container name, `<app>-app-<n>`.
    networks: ["internal", EDGE_PROJECT],
    ...(Object.keys(backing.dependsOn).length > 0 ? { depends_on: backing.dependsOn } : {}),
  };
  const services: Record<string, unknown> = { app };
  const release = plan.app.releaseCommand;
  if (release !== undefined) {
    // A one-off container of the app's image, environment and network; only
    // `docker compose run release` starts it (the deploy does, before the app is replaced).
    services.release = {
      image,
      ...pull,
      profiles: ["release"],
      ...environment(),
      ...appVolumes(plan),
      command: ["sh", "-c", composeLiteral(release)],
      ...memoryLimit(plan.app.memoryMb),
      ...hardened({ noCapabilities: true, internal: true }),
    };
  }
  Object.assign(
    services,
    renderProcesses(plan, {
      image,
      pull,
      environment,
      dependsOn: backing.dependsOn,
      crontab: local ? { configs: [STACK_CRONTAB] } : { volumes: [SERVER_CRONTAB.mount] },
    }),
    backing.services,
  );

  const configs = {
    ...backing.configs,
    ...(local && hasCronJobs(plan)
      ? { [STACK_CRONTAB.source]: { content: composeLiteral(crontab(plan)) } }
      : {}),
  };
  const document = {
    name: local ? localComposeProject(plan) : plan.app.name,
    services,
    networks: { internal: {}, [EDGE_PROJECT]: { external: true } },
    ...(backing.volumes.length > 0
      ? { volumes: Object.fromEntries(backing.volumes.map((volume) => [volume, {}])) }
      : {}),
    ...(Object.keys(configs).length > 0 ? { configs } : {}),
  };
  return {
    path: `${runtimeDir(plan)}/compose.yaml`,
    content: `${header}\n${stringify(document, { lineWidth: 0 })}`,
    kind: "runtime",
  };
}

/**
 * `<runtimeDir>/servers/<name>/compose.yaml`, the app's Compose project (`<app>`) on its extra
 * server `name`: only the services placed there, and a moving service's old copy until its switch
 * ({@link renderServices}), each published on that
 * server's private address only, on the project's internal network, with the one-shot `sysctl`
 * container when an engine there needs a host kernel setting on a server OpsCrew created. No edge,
 * app, workers or cron: they stay on the app's server. The deploy copies it to `/srv/apps/<app>`
 * on that server, beside its services' env files and settings files (`services/<service>/`, which
 * {@link renderRuntimeFiles} renders).
 * @throws Error when the plan has no extra server `name`.
 * @throws OpsCrewError `INVALID_INPUT` for a service OpsCrew cannot run as planned.
 */
export function renderServerCompose(plan: DeployPlan, name: string): RenderedFile {
  // Refuses a name that isn't one of the plan's extra servers, such as `app`.
  extraServer(plan, name);
  const rendered = renderServices(plan, { kind: "server" }, name);
  const header = [
    `# Generated by OpsCrew from ${planFilePath(plan)}; \`opscrew provision\` regenerates it.`,
    `# The deploy workflow copies it to ${appDir(plan)} on the server ${name}: the app's services placed there,`,
    `# each published only on the server's private address ${privateAddress(plan, name)}.`,
  ].join("\n");
  const document = {
    name: plan.app.name,
    services: rendered.services,
    networks: { internal: {} },
    ...(rendered.volumes.length > 0
      ? { volumes: Object.fromEntries(rendered.volumes.map((volume) => [volume, {}])) }
      : {}),
  };
  return {
    path: `${runtimeDir(plan)}/servers/${name}/compose.yaml`,
    content: `${header}\n${stringify(document, { lineWidth: 0 })}`,
    kind: "runtime",
  };
}

/**
 * The server's runtime files besides `compose.yaml` and the app's site file, all in
 * {@link runtimeDir}: each service's settings files in `services/<name>/` (MySQL's `my.cnf`,
 * `rabbitmq.conf`, `nats.conf`, `garage.toml`), also of the services on extra servers, with an
 * enabled cron job `crontab`, and the shared edge's `edge/compose.yaml` ({@link renderEdgeCompose},
 * which trusts `ctx.cloudflareRanges` on Caddy). None holds a secret. On this computer only the
 * edge's: the others are inline in the app's Compose file. Throws for a Portainer target, whose
 * stack holds them inline.
 * @throws OpsCrewError `INVALID_INPUT` for a service OpsCrew cannot run as planned, or a cron
 * route the image cannot call.
 */
export function renderRuntimeFiles(
  plan: DeployPlan,
  ctx: Pick<RuntimeContext, "cloudflareRanges"> = {},
): RenderedFile[] {
  if (plan.target.provider === "portainer") throw notForPortainer();
  const path = `${runtimeDir(plan)}/${SERVER_CRONTAB.file}`;
  const servers = [APP_SERVER, ...(plan.servers ?? []).map((server) => server.name)];
  return [
    ...servers.flatMap((server) => renderServices(plan, { kind: "server" }, server).files),
    ...(hasCronJobs(plan) && plan.target.provider !== "localhost"
      ? [{ path, content: crontab(plan), kind: "runtime" as const }]
      : []),
    renderEdgeCompose(plan, ctx.cloudflareRanges),
  ];
}

/**
 * The hostnames the edge's proxy redirects to the domain over HTTPS: `www.<domain>` (kamal-proxy
 * gets only the domain).
 */
function redirectedHosts(plan: DeployPlan): string[] {
  return siteHosts(plan).slice(1);
}

/**
 * `ctx.cloudflareRanges` when Cloudflare's proxy serves the app's hostnames and reaches the server
 * directly (not through a tunnel): the ranges whose `CF-Connecting-IP` the app's site trusts.
 */
function realIpRanges(plan: DeployPlan, ctx: RuntimeContext): readonly string[] | undefined {
  const ranges = ctx.cloudflareRanges;
  if (!plan.dns.proxied || tunnelMode(plan) || ranges === undefined) return undefined;
  return ranges.length > 0 ? ranges : undefined;
}

/**
 * `<runtimeDir>/edge/sites/<app>.caddy`, the app's site on the shared edge's Caddy (the deploy
 * copies it to `/srv/edge/sites`): the app's hostnames with TLS, compression and security headers,
 * proxied to the edge's kamal-proxy, which routes them to the app's healthy copy and redirects
 * `www` to the domain. The hostnames of `ctx.originTls` are served with the app's Cloudflare
 * origin certificate from `/srv/edge/tls/<app>` and accept only Cloudflare's client certificate
 * for the app; the others get their certificates from Caddy's ACME. With `ctx.additions` the site
 * imports the user's additions (`/srv/edge/sites/<app>.additions`). In tunnel mode Cloudflare
 * terminates TLS and the connector reaches Caddy over plain HTTP. On this computer the site is
 * `ctx.localhost`'s hostname with the leaf certificate of OpsCrew's local CA, without ACME, origin
 * TLS or Cloudflare. Throws for a Portainer target, whose stack holds Caddy's configuration inline.
 */
export function renderCaddyfile(plan: DeployPlan, ctx: RuntimeContext): RenderedFile {
  if (plan.target.provider === "portainer") throw notForPortainer();
  const app = plan.app.name;
  const additions = ctx.additions
    ? { file: caddyAdditionsFile(app), source: additionsPath(plan, "caddy") }
    : undefined;
  const site: Parameters<typeof caddySite>[0] =
    plan.target.provider === "localhost"
      ? {
          mode: "direct",
          hosts: [localhostSite(ctx.localhost).hostname],
          upstream: EDGE_UPSTREAM,
          local: { dir: originTlsDir(app), httpsPort: plan.target.ports.https },
          additions,
        }
      : {
          mode: tunnelMode(plan) ? "tunnel" : "direct",
          hosts: siteHosts(plan),
          upstream: EDGE_UPSTREAM,
          acmeEmail: ctx.acmeEmail,
          origin:
            ctx.originTls === undefined
              ? undefined
              : { hostnames: ctx.originTls.hostnames, dir: originTlsDir(app) },
          additions,
          realIp: realIpRanges(plan, ctx) !== undefined,
          redirects: redirectedHosts(plan),
        };
  const lines = [
    `# Generated by OpsCrew from ${planFilePath(plan)}; \`opscrew provision\` regenerates it.`,
    site.local
      ? `# ${app}'s site on this computer's shared edge: the local deploy copies it to the edge's sites.`
      : `# ${app}'s site on the server's shared edge: the deploy copies it to /srv/edge/sites.`,
    ...caddySite(site),
  ];
  return {
    path: `${runtimeDir(plan)}/edge/sites/${plan.app.name}.caddy`,
    content: lines.join("\n"),
    kind: "runtime",
  };
}

/**
 * The hostnames certbot gets the app's certificate for on the nginx edge: those not served with
 * the origin certificate, served directly (not behind a tunnel). Empty for Caddy, which gets its
 * own, and on this computer, where they come from OpsCrew's local CA.
 */
export function certbotHosts(plan: DeployPlan, ctx: RuntimeContext): string[] {
  if (edgeProxy(plan) !== "nginx" || tunnelMode(plan) || plan.target.provider === "localhost") {
    return [];
  }
  return siteHosts(plan).filter((host) => !ctx.originTls?.hostnames.includes(host));
}

/**
 * The site file of the app on the nginx edge, `before` its first certbot certificate or not; on
 * this computer `ctx.localhost`'s hostname with the leaf certificate of OpsCrew's local CA.
 */
function nginxSiteFile(plan: DeployPlan, ctx: RuntimeContext, before: boolean): RenderedFile {
  const app = plan.app.name;
  const additions = ctx.additions
    ? { file: nginxAdditionsFile(app), source: additionsPath(plan, "nginx") }
    : undefined;
  const site: NginxSite =
    plan.target.provider === "localhost"
      ? {
          app,
          mode: "direct",
          hosts: [localhostSite(ctx.localhost).hostname],
          local: { httpsPort: plan.target.ports.https },
          maxBodyMb: plan.app.maxBodyMb,
          additions,
        }
      : {
          app,
          mode: tunnelMode(plan) ? "tunnel" : "direct",
          hosts: siteHosts(plan),
          origin: ctx.originTls?.hostnames,
          maxBodyMb: plan.app.maxBodyMb,
          additions,
          beforeCertificate: before,
          realIpFrom: realIpRanges(plan, ctx),
          redirects: redirectedHosts(plan),
        };
  const lines = [
    `# Generated by OpsCrew from ${planFilePath(plan)}; \`opscrew provision\` regenerates it.`,
    site.local
      ? `# ${app}'s site on this computer's shared edge (nginx): the local deploy copies it to the edge's sites.`
      : `# ${app}'s site on the server's shared edge (nginx): the deploy copies it to /srv/edge/sites/${app}.conf.`,
    ...nginxSite(site),
  ];
  return {
    path: `${runtimeDir(plan)}/edge/sites/${app}.${before ? "http.conf" : "conf"}`,
    content: lines.join("\n"),
    kind: "runtime",
  };
}

/**
 * The app's site files for the plan's proxy (the deploy copies them to `/srv/edge/sites`):
 * {@link renderCaddyfile}, or on nginx `sites/<app>.conf`, the same site as Caddy's with the
 * hostnames certbot serves ({@link certbotHosts}) on certbot's certificate, and, when there are
 * such hostnames, `sites/<app>.http.conf`, the site the deploy serves until certbot has the
 * first certificate. Throws for a Portainer target.
 */
export function renderEdgeSite(plan: DeployPlan, ctx: RuntimeContext): RenderedFile[] {
  if (edgeProxy(plan) === "caddy") return [renderCaddyfile(plan, ctx)];
  return [
    nginxSiteFile(plan, ctx, false),
    ...(certbotHosts(plan, ctx).length > 0 ? [nginxSiteFile(plan, ctx, true)] : []),
  ];
}

/**
 * `<runtimeDir>/cloudflared/compose.yaml`: the app's tunnel connector as a Compose project of its
 * own (`<app>-tunnel`), next to the connectors of other apps on the same server: each has its own
 * token and serves its metrics on a free loopback port of its own (`CONNECTOR_METRICS`). The token
 * comes from `tunnel.env` in the same directory on the server (`TUNNEL_TOKEN=<terraform output
 * tunnel_token>`, mode 0600), which this file never contains.
 */
export function renderTunnelConnectorCompose(plan: DeployPlan): RenderedFile {
  const document = {
    name: `${plan.app.name}-tunnel`,
    services: {
      cloudflared: cloudflaredService({
        env_file: ["tunnel.env"],
        network_mode: "host",
        command: ["tunnel", "--no-autoupdate", "--metrics", CONNECTOR_METRICS, "run"],
        ...memoryLimit(CONNECTOR_MEMORY_MB),
      }),
    },
  };
  const header = [
    `# Generated by OpsCrew from ${planFilePath(plan)}. This app's Cloudflare Tunnel connector: it runs on`,
    "# the host network so it reaches the shared edge (127.0.0.1:18080), SSH and Portainer on localhost,",
    "# and it opens no port. tunnel.env next to this file holds TUNNEL_TOKEN (root-only; never committed).",
  ].join("\n");
  return {
    path: `${runtimeDir(plan)}/cloudflared/compose.yaml`,
    content: `${header}\n${stringify(document, { lineWidth: 0 })}`,
    kind: "runtime",
  };
}
