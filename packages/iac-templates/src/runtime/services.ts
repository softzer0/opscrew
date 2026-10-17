// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are Compose syntax, not JavaScript templates.
import { CLOUDFLARED_IMAGE, CLOUDFLARED_METRICS } from "../tunnel";

export const POSTGRES_IMAGE = "postgres:17-alpine";
export const VALKEY_IMAGE = "valkey/valkey:8-alpine";
export const CADDY_IMAGE = "caddy:2-alpine";

/** The header line of a Compose file with a `release` service. */
export const RELEASE_NOTE =
  "# `release` runs app.releaseCommand from opscrew/plan.yaml before each new version starts.";

/** `$` doubled, so Compose leaves it for the container (Compose interpolates `configs.content` too). */
export function composeLiteral(text: string): string {
  return text.replaceAll("$", () => "$$");
}

/**
 * Log rotation for one of OpsCrew's Compose services: the values of the Docker daemon settings on
 * servers OpsCrew creates (json-file, 10m, 3 files), set per service so that on a server the user
 * already runs containers on, Docker's daemon settings (and those containers) stay as they are.
 * A fresh object each time, so the YAML has no anchors.
 */
export function serviceLogging(): {
  driver: "json-file";
  options: { "max-size": string; "max-file": string };
} {
  return { driver: "json-file", options: { "max-size": "10m", "max-file": "3" } };
}

/**
 * One array for every service: the server's compose file has always listed it once and aliased
 * it (`&a1`/`*a1`) in its other services. The Portainer stacks are written without aliases.
 */
const NO_NEW_PRIVILEGES = ["no-new-privileges:true"];

/**
 * What every OpsCrew service ends with: `no-new-privileges` and rotated logs, then, as asked, no
 * Linux capabilities and the `internal` network.
 */
export function hardened(o: { noCapabilities?: boolean; internal?: boolean } = {}): object {
  return {
    security_opt: NO_NEW_PRIVILEGES,
    logging: serviceLogging(),
    ...(o.noCapabilities ? { cap_drop: ["ALL"] } : {}),
    ...(o.internal ? { networks: ["internal"] } : {}),
  };
}

/** The Postgres service: `credentials` (`env_file` or `environment`) and its data in `data`. */
export function dbService(credentials: object, data: string): object {
  return {
    image: POSTGRES_IMAGE,
    restart: "unless-stopped",
    ...credentials,
    volumes: [`${data}:/var/lib/postgresql/data`],
    healthcheck: {
      test: ["CMD-SHELL", "pg_isready -U $${POSTGRES_USER} -d $${POSTGRES_DB}"],
      interval: "10s",
      timeout: "5s",
      retries: 6,
    },
    ...hardened({ internal: true }),
  };
}

/** The Valkey service (the app's Redis), its data in `data`. */
export function cacheService(data: string): object {
  return {
    image: VALKEY_IMAGE,
    restart: "unless-stopped",
    command: ["valkey-server", "--appendonly", "yes"],
    volumes: [`${data}:/data`],
    ...hardened({ internal: true }),
  };
}

/**
 * A Cloudflare Tunnel connector with `fields` (its token and how it reaches the origin). Metrics,
 * diagnostics and pprof listen on loopback only: on the host network the image default would
 * listen on every interface.
 */
export function cloudflaredService(fields: object, internal = false): object {
  return {
    image: CLOUDFLARED_IMAGE,
    restart: "unless-stopped",
    command: ["tunnel", "--no-autoupdate", "--metrics", CLOUDFLARED_METRICS, "run"],
    ...fields,
    read_only: true,
    ...hardened({ noCapabilities: true, internal }),
  };
}

/** How visitors reach Caddy, for {@link caddyfile}. */
export interface CaddySite {
  /**
   * `tunnel`: plain HTTP behind a Cloudflare Tunnel (Cloudflare terminates TLS); `proxy`: plain
   * HTTP behind the user's own reverse proxy; `direct`: Caddy gets certificates for `hosts`.
   */
  mode: "tunnel" | "proxy" | "direct";
  hosts: readonly string[];
  /** The app's port on the Compose network. */
  port: number;
  acmeEmail?: string | undefined;
  /** Extra response header lines, before `-Server`. */
  headers?: readonly string[];
}

/**
 * Caddy's configuration: compression, security headers and a proxy to the app. Behind a tunnel the
 * sites are `http://` (no certificates) and still send HSTS; visitors who used plain HTTP are
 * redirected to HTTPS by the `Cf-Visitor` request header Cloudflare adds to proxied requests
 * (`{"scheme":"http"}` or `{"scheme":"https"}`, see
 * https://developers.cloudflare.com/fundamentals/reference/http-headers/), which can be trusted
 * because only Cloudflare reaches Caddy there. Behind the user's proxy Caddy serves `:80` and keeps
 * the `X-Forwarded-*` headers of a proxy on a private address.
 */
export function caddyfile(site: CaddySite): string[] {
  const { mode, hosts } = site;
  const lines: string[] = [];
  if (mode === "tunnel") {
    lines.push(
      "# Served through a Cloudflare Tunnel: Cloudflare terminates TLS, Caddy serves plain HTTP.",
    );
  } else if (mode === "proxy") {
    lines.push(
      "# Behind your own reverse proxy: it terminates TLS and forwards to Caddy over plain HTTP.",
      "{",
      "\tservers {",
      "\t\ttrusted_proxies static private_ranges",
      "\t}",
      "}",
      "",
    );
  } else if (site.acmeEmail && hosts.length > 0) {
    lines.push("{", `\temail ${site.acmeEmail}`, "}", "");
  }
  const sites = mode === "tunnel" ? hosts.map((host) => `http://${host}`) : hosts;
  lines.push(`${mode === "proxy" || sites.length === 0 ? ":80" : sites.join(", ")} {`);
  if (mode === "tunnel") {
    // Caddy orders `redir` before `reverse_proxy`, so plain-HTTP visitors are redirected first.
    lines.push(
      '\t@http_visitor header Cf-Visitor `*"http"*`',
      "\tredir @http_visitor https://{host}{uri} 308",
    );
  }
  lines.push("\tencode zstd gzip", `\treverse_proxy app:${site.port}`, "\theader {");
  if (hosts.length > 0) {
    lines.push('\t\tStrict-Transport-Security "max-age=31536000; includeSubDomains"');
  }
  lines.push(
    '\t\tX-Content-Type-Options "nosniff"',
    '\t\tX-Frame-Options "SAMEORIGIN"',
    '\t\tReferrer-Policy "strict-origin-when-cross-origin"',
    ...(site.headers ?? []),
    "\t\t-Server",
    "\t}",
    "}",
    "",
  );
  return lines;
}
