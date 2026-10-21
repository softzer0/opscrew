// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are Compose syntax, not JavaScript templates.
/**
 * The shared edge on every server (contracts/components.md "The edge on a server"): one Compose
 * project, `opscrew-edge` in `/srv/edge`, with the server's proxy (Caddy, or nginx with certbot)
 * and kamal-proxy in front of every OpsCrew app on the server. Each app is its own Compose project
 * in `/srv/apps/<app>`, its data in `/srv/data/<app>`.
 */
import { sha256Hex } from "@opscrew/core";
import type { DeployPlan } from "@opscrew/plan-schema";
import { stringify } from "yaml";
import { IMAGES } from "../pins";
import { memoryLimit } from "../runtime/components";
import { CATCH_ALL_SITES, composeLiteral, hardened } from "../runtime/services";
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

/** The edge's Compose project, and the external network the edge and every app's web service join. */
export const EDGE_PROJECT = "opscrew-edge";

/**
 * Where the edge lives on the server: its `compose.yaml`, the apps' site files in `sites/` (with
 * each app's `sites/<app>.additions`) and the origin certificates in `tls/<app>/`.
 */
export const EDGE_DIR = "/srv/edge";

/** The app's folder on the server (its Compose project, env files and logs): `/srv/apps/<app>`. */
export function appDir(plan: DeployPlan): string {
  return `/srv/apps/${plan.app.name}`;
}

/**
 * The edge's version stamp: the date OpsCrew last changed the edge (its pins or its files) as
 * YYYYMMDD, then that day's change number (01, 02 …), so a later edge always has a larger number.
 * A deploy replaces the server's edge only with a larger one, or with the other proxy. Change it
 * with every change of the edge's Compose file; a test fails until it is changed.
 */
export const EDGE_VERSION = 2026102103;

/** The key of {@link EDGE_VERSION} in the edge's Compose file (a Compose extension field). */
export const EDGE_VERSION_KEY = "x-opscrew-edge-version";

/** The key of the edge's proxy (`caddy` or `nginx`) in its Compose file, after its version. */
export const EDGE_PROXY_KEY = "x-opscrew-edge-proxy";

/** Where Caddy sends every app's traffic: kamal-proxy, which routes by hostname to the app's copy. */
export const EDGE_UPSTREAM = "kamal-proxy:80";

/** The reverse proxy in front of the apps on a server (`target.edge`). */
export type EdgeProxy = "caddy" | "nginx";

/** What a server's edge differs in, by proxy. */
export const EDGE_PROXIES: Record<
  EdgeProxy,
  {
    /** The proxy in prose. */
    label: string;
    /** The extension of the app's site file, `sites/<app>.<site>`. */
    site: string;
    /** The user's own additions in the repository; on the server `sites/<app>.additions`. */
    additions: string;
    /** Where a site sends the app's traffic, as its file names it (the additions' upstream). */
    upstream: string;
  }
> = {
  caddy: {
    label: "Caddy",
    site: "caddy",
    additions: "opscrew/proxy/additions.caddy",
    upstream: EDGE_UPSTREAM,
  },
  nginx: {
    label: "nginx",
    site: "conf",
    additions: "opscrew/proxy/additions.nginx",
    upstream: NGINX_UPSTREAM,
  },
};

/** The plan's proxy: `target.edge` (a Portainer stack, which has no server edge, runs Caddy). */
export function edgeProxy(plan: DeployPlan): EdgeProxy {
  return plan.target.provider === "portainer" ? "caddy" : plan.target.edge;
}

/** The other proxy of {@link EDGE_PROXIES}. */
export function otherProxy(proxy: EdgeProxy): EdgeProxy {
  return proxy === "caddy" ? "nginx" : "caddy";
}

/** The memory limits of the edge's containers, in MB. */
export const CADDY_MEMORY_MB = 64;
const KAMAL_PROXY_MEMORY_MB = 32;
const NGINX_MEMORY_MB = 64;
/** certbot used under 48 MB to obtain and renew certificates (certbot 5.8, 2026-10-21). */
const CERTBOT_MEMORY_MB = 64;

/**
 * The edge's memory that design counts on every server, in MB: Caddy, kamal-proxy and one
 * tunnelled app's connector, 128 MB (data-model.md "Sizing figures").
 */
export const EDGE_MEMORY_MB = CADDY_MEMORY_MB + KAMAL_PROXY_MEMORY_MB + CONNECTOR_MEMORY_MB;

/**
 * The edge's memory design counts for `proxy`, in MB: {@link EDGE_MEMORY_MB} for Caddy, and for
 * nginx the same with nginx and certbot in Caddy's place (192 MB).
 */
export function edgeMemoryMb(proxy: EdgeProxy): number {
  return (
    KAMAL_PROXY_MEMORY_MB +
    CONNECTOR_MEMORY_MB +
    (proxy === "nginx" ? NGINX_MEMORY_MB + CERTBOT_MEMORY_MB : CADDY_MEMORY_MB)
  );
}

/** The folder of the apps' site files in the Caddy container (the server's `/srv/edge/sites`). */
const CADDY_SITES = "/etc/caddy/sites";

/** The app's additions in the Caddy container: `/etc/caddy/sites/<app>.additions`. */
export function caddyAdditionsFile(app: string): string {
  return `${CADDY_SITES}/${app}.additions`;
}

/**
 * The client certificate Cloudflare presents to the app's origin (public), committed with the
 * runtime files; the deploy puts it in `/srv/edge/tls/<app>/pull.pem`, the site's trust pool.
 */
export const ORIGIN_PULL_PEM = "opscrew/runtime/edge/tls/pull.pem";

/**
 * Caddy's main configuration: with Cloudflare's `ranges`, global options that take the client's
 * address from `CF-Connecting-IP` on requests from them; then the apps' site files, then
 * {@link CATCH_ALL_SITES}.
 */
function caddyfile(ranges: readonly string[]): string {
  return [
    "# OpsCrew's shared edge: each OpsCrew app on this server has its site in /srv/edge/sites/<app>.caddy.",
    ...(ranges.length === 0
      ? []
      : [
          "# Requests from Cloudflare's addresses carry the visitor's in CF-Connecting-IP.",
          "{",
          "\tservers {",
          `\t\ttrusted_proxies static ${ranges.join(" ")}`,
          "\t\tclient_ip_headers CF-Connecting-IP",
          "\t}",
          "}",
          "",
        ]),
    `import ${CADDY_SITES}/*.caddy`,
    "",
    ...CATCH_ALL_SITES,
  ].join("\n");
}

/**
 * The proxy's published ports, to its `http` and `https` ports in the container: loopback in
 * tunnel mode (the tunnel connector reaches it there), IPv4 only behind OpsCrew's web filter (the
 * filter covers IPv4 only), otherwise HTTP, HTTPS and HTTP/3.
 */
function edgePorts(plan: DeployPlan, http: number, https: number): string[] {
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
 * `/srv/edge/tls/<app>`, and trusting Cloudflare's `ranges` for the visitor's address.
 */
function caddyEdge(plan: DeployPlan, ranges: readonly string[]) {
  const main = caddyfile(ranges);
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

/** Both nginx and certbot run as the deploy user, from the edge's `.env`, which the deploy writes. */
const DEPLOY_USER =
  "${OPSCREW_DEPLOY_UID:?the OpsCrew deploy writes it to /srv/edge/.env}:${OPSCREW_DEPLOY_GID:?the OpsCrew deploy writes it to /srv/edge/.env}";

/**
 * nginx (unprivileged, its ports 8080 and 8443) reading the apps' site files from
 * `/srv/edge/sites`, their origin certificates from `/srv/edge/tls/<app>` and certbot's from the
 * volume `letsencrypt`, and certbot renewing them through the webroot `acme-webroot`. certbot's
 * deploy hook leaves a flag on the volume `reload`, where nginx's loop sees it and reloads. Neither
 * has the Docker socket, nor any Linux capability.
 */
function nginxEdge(plan: DeployPlan) {
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
          `letsencrypt:${LETSENCRYPT}:ro`,
          `acme-webroot:${ACME_WEBROOT}:ro`,
          `reload:${RELOAD_DIR}`,
        ],
        healthcheck: NGINX_HEALTHCHECK,
        // A changed main configuration changes this label, so Compose recreates nginx with it.
        labels: { "dev.opscrew.nginx-conf-sha256": sha256Hex(NGINX_CONF) },
        depends_on: ["kamal-proxy"],
        ...hardened({ noCapabilities: true }),
        networks: [EDGE_PROJECT],
      },
      certbot: {
        image: IMAGES.certbot.ref,
        restart: "unless-stopped",
        user: DEPLOY_USER,
        init: true,
        ...memoryLimit(CERTBOT_MEMORY_MB),
        entrypoint: ["sh", "-c", composeLiteral(CERTBOT_LOOP)],
        volumes: [
          `letsencrypt:${LETSENCRYPT}`,
          `acme-webroot:${ACME_WEBROOT}`,
          `reload:${RELOAD_DIR}`,
        ],
        ...hardened({ noCapabilities: true }),
        networks: [EDGE_PROJECT],
      },
    },
    configs: { "nginx-conf": { content: composeLiteral(NGINX_CONF) } },
    volumes: { letsencrypt: {}, "acme-webroot": {}, reload: {} },
  };
}

function header(proxy: EdgeProxy): string {
  const front = proxy === "nginx" ? "nginx, certbot and kamal-proxy" : "Caddy and kamal-proxy";
  return [
    "# Generated by OpsCrew from opscrew/plan.yaml; `opscrew provision` regenerates it.",
    "# OpsCrew's shared edge on the server (/srv/edge, Compose project opscrew-edge), in front of",
    `# every OpsCrew app there: ${front}. Each app's deploy brings this file and puts it`,
    `# in /srv/edge only when its ${EDGE_VERSION_KEY} is larger than the server's, or when its`,
    `# ${EDGE_PROXY_KEY} differs (the switch, while the server holds one OpsCrew app).`,
  ].join("\n");
}

/**
 * `opscrew/runtime/edge/compose.yaml`: the plan's proxy (Caddy, or nginx with certbot) and
 * kamal-proxy on the external network `opscrew-edge`, stamped with {@link EDGE_VERSION} and the
 * proxy ({@link EDGE_PROXY_KEY}). kamal-proxy keeps the apps' routes on a named volume, so they
 * survive a recreate; the proxy publishes the ports the server's access mode needs (the same for
 * every app on the server). Caddy trusts Cloudflare's `cloudflareRanges` for the visitor's address
 * (nginx does it in each app's site).
 */
export function renderEdgeCompose(
  plan: DeployPlan,
  cloudflareRanges: readonly string[] = [],
): RenderedFile {
  const proxy = edgeProxy(plan);
  const front = proxy === "nginx" ? nginxEdge(plan) : caddyEdge(plan, cloudflareRanges);
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
    path: "opscrew/runtime/edge/compose.yaml",
    content: `${header(proxy)}\n${stringify(document, { lineWidth: 0 })}`,
    kind: "runtime",
  };
}
