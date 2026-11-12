// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are Compose syntax, not JavaScript templates.
/**
 * The shared edge on every server (contracts/components.md "The edge on a server"): one Compose
 * project, `opscrew-edge` in `/srv/edge`, with the server's proxy (Caddy, or nginx with certbot)
 * and kamal-proxy in front of every OpsCrew app on the server. Each app is its own Compose project
 * in `/srv/apps/<app>`, its data in `/srv/data/<app>`. On the user's own computer (the localhost
 * target) the same edge listens on 127.0.0.1 with leaf certificates from OpsCrew's local CA.
 */
import { sha256Hex } from "@opscrew/core";
import { type DeployPlan, isHostingTarget, isServerlessTarget } from "@opscrew/plan-schema";
import { stringify } from "yaml";
import { IMAGES } from "../pins";
import { notOnServer, wrongTarget } from "../providers";
import { memoryLimit } from "../runtime/components";
import { CATCH_ALL_SITES, composeLiteral, hardened } from "../runtime/services";
import { artefactsFolder, runtimeDir } from "../runtime-dir";
import { CONNECTOR_MEMORY_MB, TUNNEL_ORIGIN_PORT, tunnelMode, webFilterMode } from "../tunnel";
import type { RenderedFile } from "../types";
import {
  ACME_WEBROOT,
  CERTBOT_LOOP,
  LETSENCRYPT,
  NGINX_CONF,
  NGINX_HEALTHCHECK,
  NGINX_LOOP,
  NGINX_PORTS,
  NGINX_UPSTREAM,
  RELOAD_DIR,
} from "./nginx";
import {
  OPENLITESPEED_CAPABILITIES,
  OPENLITESPEED_CATCH_ALL,
  OPENLITESPEED_CHECK,
  OPENLITESPEED_ERROR_PAGE,
  OPENLITESPEED_HEALTHCHECK,
  OPENLITESPEED_INPUT,
  OPENLITESPEED_LOOP,
  OPENLITESPEED_RELOAD,
  OPENLITESPEED_UPSTREAM,
  openlitespeedConf,
} from "./openlitespeed";

export {
  type LocalhostSite,
  localhostHostname,
  localhostTlsUpload,
} from "./localhost";
export {
  OPENLITESPEED_CHECK,
  OPENLITESPEED_COMMAND,
  OPENLITESPEED_INPUT,
  OPENLITESPEED_RELOAD,
  openlitespeedCachePurge,
} from "./openlitespeed";

/** The edge's Compose project, and the external network the edge and every app's web service join. */
export const EDGE_PROJECT = "opscrew-edge";

/**
 * Where the edge lives on the server: its `compose.yaml`, the apps' site files in `sites/` (with
 * each app's `sites/<app>.additions`) and the origin certificates in `tls/<app>/`.
 */
export const EDGE_DIR = "/srv/edge";

/** Where the apps' folders are on the server. */
export const APPS_DIR = "/srv/apps";

/** The app's folder on the server (its Compose project, env files and logs): `/srv/apps/<app>`. */
export function appDir(plan: DeployPlan): string {
  return `${APPS_DIR}/${plan.app.name}`;
}

/**
 * The edge's version stamp: the date OpsCrew last changed the edge (its pins or its files) as
 * YYYYMMDD, then that day's change number (01, 02 …), so a later edge always has a larger number.
 * A deploy replaces the server's edge only with a larger one, or with the other proxy. Change it
 * with every change of the edge's Compose file; a test fails until it is changed.
 */
export const EDGE_VERSION = 2026110401;

/** The key of {@link EDGE_VERSION} in the edge's Compose file (a Compose extension field). */
export const EDGE_VERSION_KEY = "x-opscrew-edge-version";

/** The key of the edge's proxy (`caddy`, `nginx` or `openlitespeed`) in its Compose file, after its version. */
export const EDGE_PROXY_KEY = "x-opscrew-edge-proxy";

/** Where Caddy sends every app's traffic: kamal-proxy, which routes by hostname to the app's copy. */
export const EDGE_UPSTREAM = "kamal-proxy:80";

/**
 * The port of Caddy's metrics site on every Caddy edge: on the edge's internal network only, never
 * published, scraped by Alloy on the edge's server with monitoring on.
 */
export const CADDY_METRICS_PORT = 9180;

/** The reverse proxy in front of the apps on a server (`target.edge`). */
export type EdgeProxy = "caddy" | "nginx" | "openlitespeed";

/** What a server's edge differs in, by proxy. */
export const EDGE_PROXIES: Record<
  EdgeProxy,
  {
    /** The proxy in prose. */
    label: string;
    /** The extension of the app's site file, `sites/<app>.<site>`. */
    site: string;
    /** Where a site sends the app's traffic, as its file names it (the additions' upstream). */
    upstream: string;
  }
> = {
  caddy: { label: "Caddy", site: "caddy", upstream: EDGE_UPSTREAM },
  nginx: { label: "nginx", site: "conf", upstream: NGINX_UPSTREAM },
  openlitespeed: { label: "OpenLiteSpeed", site: "vhconf", upstream: OPENLITESPEED_UPSTREAM },
};

/**
 * The plan's proxy: `target.edge` (a Portainer stack, which has no server edge, runs Caddy). A
 * server-less target and a hosting account have none: throws.
 */
export function edgeProxy(plan: DeployPlan): EdgeProxy {
  if (isServerlessTarget(plan.target)) {
    throw notOnServer(plan.target.provider, "reverse proxy of OpsCrew's");
  }
  if (isHostingTarget(plan.target)) {
    throw wrongTarget("OpsCrew's reverse proxy isn't available for a hosting account.");
  }
  return plan.target.provider === "portainer" ? "caddy" : plan.target.edge;
}

/**
 * The user's own additions for `proxy` (the plan's by default) in the repository, which every
 * environment of the app shares: `proxy/additions.caddy`, `.nginx` or `.openlitespeed` in the
 * app's folder ({@link artefactsFolder} of its prod), `opscrew/proxy/…` for the repository's first
 * app and `opscrew/apps/<key>/proxy/…` for a further app. On the server `sites/<app>.additions`.
 */
export function additionsPath(plan: DeployPlan, proxy: EdgeProxy = edgeProxy(plan)): string {
  return `${artefactsFolder(plan, "prod")}/proxy/additions.${proxy}`;
}

/** The proxies of {@link EDGE_PROXIES} other than `proxy`, in its order. */
export function otherProxies(proxy: EdgeProxy): EdgeProxy[] {
  return (Object.keys(EDGE_PROXIES) as EdgeProxy[]).filter((other) => other !== proxy);
}

/** The memory limits of the edge's containers, in MB. */
export const CADDY_MEMORY_MB = 64;
const KAMAL_PROXY_MEMORY_MB = 32;
const NGINX_MEMORY_MB = 64;
/** OpenLiteSpeed idles at 11 MB and buffers up to 60 MB of request bodies in memory (`inMemBufSize`). */
const OPENLITESPEED_MEMORY_MB = 128;
/** certbot used under 48 MB to obtain and renew certificates (certbot 5.8, 2026-10-21). */
const CERTBOT_MEMORY_MB = 64;

/**
 * The edge's memory that design counts on every server, in MB: Caddy, kamal-proxy and one
 * tunnelled app's connector, 128 MB (data-model.md "Sizing figures").
 */
export const EDGE_MEMORY_MB = CADDY_MEMORY_MB + KAMAL_PROXY_MEMORY_MB + CONNECTOR_MEMORY_MB;

/** The memory of each proxy's containers, in MB: the proxy, and certbot beside nginx and OpenLiteSpeed. */
const PROXY_MEMORY_MB: Record<EdgeProxy, number> = {
  caddy: CADDY_MEMORY_MB,
  nginx: NGINX_MEMORY_MB + CERTBOT_MEMORY_MB,
  openlitespeed: OPENLITESPEED_MEMORY_MB + CERTBOT_MEMORY_MB,
};

/**
 * The edge's memory design counts for `proxy`, in MB: {@link EDGE_MEMORY_MB} for Caddy, and the
 * same with nginx and certbot in Caddy's place for nginx (192 MB), or OpenLiteSpeed and certbot
 * (256 MB).
 */
export function edgeMemoryMb(proxy: EdgeProxy): number {
  return KAMAL_PROXY_MEMORY_MB + CONNECTOR_MEMORY_MB + PROXY_MEMORY_MB[proxy];
}

/** The folder of the apps' site files in the Caddy container (the server's `/srv/edge/sites`). */
const CADDY_SITES = "/etc/caddy/sites";

/** The app's additions in the Caddy container: `/etc/caddy/sites/<app>.additions`. */
export function caddyAdditionsFile(app: string): string {
  return `${CADDY_SITES}/${app}.additions`;
}

/**
 * The client certificate Cloudflare presents to the app's origin (public), committed with the
 * runtime files at `<runtimeDir>/edge/tls/pull.pem`; the deploy puts it in
 * `/srv/edge/tls/<app>/pull.pem`, the site's trust pool.
 */
export function originPullPem(plan: DeployPlan): string {
  return `${runtimeDir(plan)}/edge/tls/pull.pem`;
}

/**
 * Caddy's main configuration: with Cloudflare's `ranges`, global options that take the client's
 * address from `CF-Connecting-IP` on requests from them; on this computer (`local`), global
 * options without HTTP/3, whose UDP port the edge does not publish there; on every edge, Caddy's
 * figures per hostname (`observe_catchall_hosts` stays off: hosts nobody configured would be an
 * unbounded label). Then the apps' site files, the site on {@link CADDY_METRICS_PORT} that serves
 * only the figures, and {@link CATCH_ALL_SITES}. The figures are on with or without monitoring, so
 * every app on a server renders the same edge.
 */
function caddyfile(ranges: readonly string[], local: boolean): string {
  const comments: string[] = [];
  const options: string[] = [];
  const option = (comment: string, name: string, lines: readonly string[]) => {
    comments.push(comment);
    options.push(`\t${name} {`, ...lines.map((line) => `\t\t${line}`), "\t}");
  };
  if (ranges.length > 0) {
    option(
      "# Requests from Cloudflare's addresses carry the visitor's in CF-Connecting-IP.",
      "servers",
      [`trusted_proxies static ${ranges.join(" ")}`, "client_ip_headers CF-Connecting-IP"],
    );
  }
  if (local) {
    option("# No HTTP/3: the edge on this computer publishes no UDP port.", "servers", [
      "protocols h1 h2",
    ]);
  }
  option(
    "# Caddy's figures per hostname: the `metrics` handler below, on the edge's network only.",
    "metrics",
    ["per_host"],
  );
  return [
    "# OpsCrew's shared edge: each OpsCrew app on this server has its site in /srv/edge/sites/<app>.caddy.",
    ...comments,
    "{",
    ...options,
    "}",
    "",
    `import ${CADDY_SITES}/*.caddy`,
    "",
    "# Caddy's figures, which Alloy reads with monitoring on: on the edge's internal network only (this port is never published).",
    `http://:${CADDY_METRICS_PORT} {`,
    "\tmetrics",
    "}",
    "",
    ...CATCH_ALL_SITES,
  ].join("\n");
}

/**
 * The proxy's published ports, to its `http` and `https` ports in the container: on this computer
 * the target's HTTP and HTTPS ports on its loopback only, loopback in tunnel mode (the tunnel
 * connector reaches it there), IPv4 only behind OpsCrew's web filter (the filter covers IPv4
 * only), otherwise HTTP, HTTPS and HTTP/3.
 */
function edgePorts(plan: DeployPlan, http: number, https: number): string[] {
  if (plan.target.provider === "localhost") {
    const { ports } = plan.target;
    return [`127.0.0.1:${ports.http}:${http}`, `127.0.0.1:${ports.https}:${https}`];
  }
  if (tunnelMode(plan)) return [`127.0.0.1:${TUNNEL_ORIGIN_PORT}:${http}`];
  const host = webFilterMode(plan) ? "0.0.0.0:" : "";
  return [`${host}80:${http}`, `${host}443:${https}`, `${host}443:${https}/udp`];
}

/**
 * Caddy is healthy once its admin API answers (busybox `wget` in the pinned image), so the deploy's
 * `edge up -d --wait` waits for it before `caddy reload`, which would otherwise find it not yet
 * listening on a first start.
 */
const CADDY_HEALTHCHECK = {
  test: ["CMD", "wget", "-q", "-O", "/dev/null", "http://127.0.0.1:2019/config/"],
  interval: "30s",
  timeout: "5s",
  retries: 3,
  start_period: "30s",
  start_interval: "1s",
};

/**
 * Caddy, reading each app's site file from `/srv/edge/sites` and its origin certificate from
 * `/srv/edge/tls/<app>`, and trusting Cloudflare's `ranges` for the visitor's address (never on
 * this computer, which Cloudflare does not reach). It serves its figures on
 * {@link CADDY_METRICS_PORT}, which only the edge's network reaches: the port is not published.
 */
function caddyEdge(plan: DeployPlan, ranges: readonly string[]) {
  const local = plan.target.provider === "localhost";
  const main = caddyfile(local ? [] : ranges, local);
  return {
    services: {
      caddy: {
        image: IMAGES.caddy.ref,
        restart: "unless-stopped",
        ...memoryLimit(CADDY_MEMORY_MB),
        ports: edgePorts(plan, 80, 443),
        configs: [{ source: "caddyfile", target: "/etc/caddy/Caddyfile" }],
        volumes: [
          `./sites:${CADDY_SITES}:ro`,
          "./tls:/etc/caddy/tls:ro",
          "caddy_data:/data",
          "caddy_config:/config",
        ],
        healthcheck: CADDY_HEALTHCHECK,
        // A changed main configuration changes this label, so Compose recreates Caddy with it.
        labels: { "dev.opscrew.caddyfile-sha256": sha256Hex(main) },
        depends_on: ["kamal-proxy"],
        ...hardened(),
        networks: [EDGE_PROJECT],
      },
    },
    configs: { caddyfile: { content: composeLiteral(main) } },
    volumes: { caddy_data: {}, caddy_config: {} },
  };
}

/** nginx and certbot run as the deploy user, from the edge's `.env`, which the deploy writes. */
const DEPLOY_USER =
  "${OPSCREW_DEPLOY_UID:?the OpsCrew deploy writes it to /srv/edge/.env}:${OPSCREW_DEPLOY_GID:?the OpsCrew deploy writes it to /srv/edge/.env}";

/**
 * nginx (unprivileged, its ports 8080 and 8443) reading the apps' site files from
 * `/srv/edge/sites`, their origin certificates from `/srv/edge/tls/<app>` and certbot's from the
 * volume `letsencrypt`, and certbot renewing them through the webroot `acme-webroot`. certbot's
 * deploy hook leaves a flag on the volume `reload`, where nginx's loop sees it and reloads. Neither
 * has the Docker socket, nor any Linux capability. On this computer the apps' leaf certificates
 * come from OpsCrew's local CA, in `tls/<app>`, so there is no certbot and none of its volumes.
 */
function nginxEdge(plan: DeployPlan) {
  const certbot = certbotOn(plan);
  return {
    services: {
      nginx: {
        image: IMAGES.nginx.ref,
        restart: "unless-stopped",
        user: DEPLOY_USER,
        init: true,
        ...memoryLimit(NGINX_MEMORY_MB),
        ports: edgePorts(plan, NGINX_PORTS.http, NGINX_PORTS.https),
        configs: [{ source: "nginx-conf", target: "/etc/nginx/nginx.conf" }],
        entrypoint: ["sh", "-c", composeLiteral(NGINX_LOOP)],
        volumes: [
          "./sites:/etc/nginx/sites:ro",
          "./tls:/etc/nginx/tls:ro",
          ...(certbot ? CERTBOT_MOUNTS : []),
        ],
        healthcheck: NGINX_HEALTHCHECK,
        // A changed main configuration changes this label, so Compose recreates nginx with it.
        labels: { "dev.opscrew.nginx-conf-sha256": sha256Hex(NGINX_CONF) },
        depends_on: ["kamal-proxy"],
        ...hardened({ noCapabilities: true }),
        networks: [EDGE_PROJECT],
      },
      ...(certbot ? { certbot: certbotService() } : {}),
    },
    configs: { "nginx-conf": { content: composeLiteral(NGINX_CONF) } },
    volumes: certbot ? CERTBOT_VOLUMES : {},
  };
}

/** certbot beside the proxy: on a server, not on this computer, where OpsCrew's local CA signs. */
function certbotOn(plan: DeployPlan): boolean {
  return plan.target.provider !== "localhost";
}

/** certbot's volumes as the proxy mounts them: its certificates and webroot read-only. */
const CERTBOT_MOUNTS = [
  `letsencrypt:${LETSENCRYPT}:ro`,
  `acme-webroot:${ACME_WEBROOT}:ro`,
  `reload:${RELOAD_DIR}`,
];

const CERTBOT_VOLUMES = { letsencrypt: {}, "acme-webroot": {}, reload: {} };

/**
 * certbot as the deploy user, renewing the certificates through the webroot `acme-webroot`; its
 * deploy hook leaves a flag on the volume `reload`, where the proxy's loop sees it.
 */
function certbotService() {
  return {
    image: IMAGES.certbot.ref,
    restart: "unless-stopped",
    user: DEPLOY_USER,
    init: true,
    ...memoryLimit(CERTBOT_MEMORY_MB),
    entrypoint: ["sh", "-c", composeLiteral(CERTBOT_LOOP)],
    volumes: [`letsencrypt:${LETSENCRYPT}`, `acme-webroot:${ACME_WEBROOT}`, `reload:${RELOAD_DIR}`],
    ...hardened({ noCapabilities: true }),
    networks: [EDGE_PROJECT],
  };
}

/**
 * OpenLiteSpeed (ADR 0031) under Docker's init with OpsCrew's loop, on 80 and 443, reading its
 * configuration, the catch-all, the error page and the scripts of its check and checked graceful
 * restart from the Compose configs, the apps' site files from `/srv/edge/sites` and their origin
 * certificates from `/srv/edge/tls/<app>` (all read-only, in `/etc/opscrew`), with certbot as on
 * nginx, and trusting Cloudflare's `ranges` for the visitor's address. Its main process runs as
 * root with only the capabilities it uses: binding 80 and 443, reading the deploy user's keys,
 * starting its workers as `nobody` and signalling them. On this computer there is no certbot, no
 * HTTP/3 and no Cloudflare.
 */
function openlitespeedEdge(plan: DeployPlan, ranges: readonly string[]) {
  const certbot = certbotOn(plan);
  const local = plan.target.provider === "localhost";
  const conf = openlitespeedConf(local, local ? [] : ranges);
  const files = {
    "openlitespeed-conf": { target: OPENLITESPEED_INPUT.conf, content: conf },
    "openlitespeed-catchall": {
      target: OPENLITESPEED_INPUT.catchAll,
      content: OPENLITESPEED_CATCH_ALL,
    },
    "openlitespeed-error": {
      target: OPENLITESPEED_INPUT.errorPage,
      content: OPENLITESPEED_ERROR_PAGE,
    },
    "openlitespeed-check": { target: OPENLITESPEED_INPUT.check, content: OPENLITESPEED_CHECK },
    "openlitespeed-reload": { target: OPENLITESPEED_INPUT.reload, content: OPENLITESPEED_RELOAD },
  };
  return {
    services: {
      openlitespeed: {
        image: IMAGES.openlitespeed.ref,
        restart: "unless-stopped",
        init: true,
        ...memoryLimit(OPENLITESPEED_MEMORY_MB),
        ports: edgePorts(plan, 80, 443),
        configs: Object.entries(files).map(([source, { target }]) => ({ source, target })),
        entrypoint: ["sh", "-c", composeLiteral(OPENLITESPEED_LOOP)],
        volumes: [
          `./sites:${OPENLITESPEED_INPUT.sites}:ro`,
          `./tls:${OPENLITESPEED_INPUT.tls}:ro`,
          ...(certbot ? CERTBOT_MOUNTS : []),
        ],
        healthcheck: OPENLITESPEED_HEALTHCHECK,
        // A changed configuration, catch-all, error page or script changes this label, so Compose
        // recreates OpenLiteSpeed with it.
        labels: {
          "dev.opscrew.openlitespeed-conf-sha256": sha256Hex(
            Object.values(files)
              .map((file) => file.content)
              .join("\n"),
          ),
        },
        depends_on: ["kamal-proxy"],
        ...hardened({ noCapabilities: true }),
        cap_add: OPENLITESPEED_CAPABILITIES,
        networks: [EDGE_PROJECT],
      },
      ...(certbot ? { certbot: certbotService() } : {}),
    },
    configs: Object.fromEntries(
      Object.entries(files).map(([source, { content }]) => [
        source,
        { content: composeLiteral(content) },
      ]),
    ),
    volumes: certbot ? CERTBOT_VOLUMES : {},
  };
}

/**
 * The edge's header. Every app and environment on the machine shares the edge, and a deploy keeps
 * the newest copy by its version stamp, so the file is the same from every plan and names none.
 */
function header(plan: DeployPlan): string {
  const proxy = edgeProxy(plan);
  if (plan.target.provider === "localhost") {
    return [
      "# Generated by OpsCrew and shared by every OpsCrew app on this computer; any app's `opscrew provision` regenerates it.",
      "# OpsCrew's shared edge on this computer (Compose project opscrew-edge), in front of",
      `# every OpsCrew app there: ${EDGE_PROXIES[proxy].label} and kamal-proxy. It listens on 127.0.0.1 only.`,
    ].join("\n");
  }
  const front = {
    caddy: "Caddy and kamal-proxy",
    nginx: "nginx, certbot and kamal-proxy",
    openlitespeed: "OpenLiteSpeed, certbot and kamal-proxy",
  }[proxy];
  return [
    "# Generated by OpsCrew and shared by every OpsCrew app on this server; any app's `opscrew provision` regenerates it.",
    "# OpsCrew's shared edge on the server (/srv/edge, Compose project opscrew-edge), in front of",
    `# every OpsCrew app there: ${front}. Each app's deploy brings this file and puts it`,
    `# in /srv/edge only when its ${EDGE_VERSION_KEY} is larger than the server's, or when its`,
    `# ${EDGE_PROXY_KEY} differs (the switch, while the server holds one OpsCrew app).`,
  ].join("\n");
}

/**
 * `<runtimeDir>/edge/compose.yaml`: the plan's proxy (Caddy, or nginx or OpenLiteSpeed with certbot) and
 * kamal-proxy on the external network `opscrew-edge`, stamped with {@link EDGE_VERSION} and the
 * proxy ({@link EDGE_PROXY_KEY}). kamal-proxy keeps the apps' routes on a named volume, so they
 * survive a recreate; the proxy publishes the ports the server's access mode needs (the same for
 * every app on the server). Caddy and OpenLiteSpeed trust Cloudflare's `cloudflareRanges` for the
 * visitor's address (nginx does it in each app's site).
 */
export function renderEdgeCompose(
  plan: DeployPlan,
  cloudflareRanges: readonly string[] = [],
): RenderedFile {
  const proxy = edgeProxy(plan);
  const front =
    proxy === "caddy"
      ? caddyEdge(plan, cloudflareRanges)
      : proxy === "nginx"
        ? nginxEdge(plan)
        : openlitespeedEdge(plan, cloudflareRanges);
  const document = {
    name: EDGE_PROJECT,
    [EDGE_VERSION_KEY]: EDGE_VERSION,
    [EDGE_PROXY_KEY]: proxy,
    services: {
      "kamal-proxy": {
        image: IMAGES.kamalProxy.ref,
        restart: "unless-stopped",
        volumes: ["kamal-proxy-config:/home/kamal-proxy/.config/kamal-proxy"],
        ...memoryLimit(KAMAL_PROXY_MEMORY_MB),
        ...hardened({ noCapabilities: true }),
        networks: [EDGE_PROJECT],
      },
      ...front.services,
    },
    configs: front.configs,
    networks: { [EDGE_PROJECT]: { external: true } },
    volumes: { ...front.volumes, "kamal-proxy-config": {} },
  };
  return {
    path: `${runtimeDir(plan)}/edge/compose.yaml`,
    content: `${header(plan)}\n${stringify(document, { lineWidth: 0 })}`,
    kind: "runtime",
  };
}
