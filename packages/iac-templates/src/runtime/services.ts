// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are Compose syntax, not JavaScript templates.
import { IMAGES } from "../pins";
import { CLOUDFLARED_METRICS } from "../tunnel";

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

/**
 * A Cloudflare Tunnel connector with `fields` (its token and how it reaches the origin). Metrics,
 * diagnostics and pprof listen on loopback only: on the host network the image default would
 * listen on every interface.
 */
export function cloudflaredService(fields: object, internal = false): object {
  return {
    image: IMAGES.cloudflared.ref,
    restart: "unless-stopped",
    command: ["tunnel", "--no-autoupdate", "--metrics", CLOUDFLARED_METRICS, "run"],
    ...fields,
    read_only: true,
    ...hardened({ noCapabilities: true, internal }),
  };
}

const TUNNEL_NOTE =
  "# Served through a Cloudflare Tunnel: Cloudflare terminates TLS, Caddy serves plain HTTP.";

/** How visitors reach Caddy, for {@link caddyfile}. */
export interface CaddySite {
  /**
   * `tunnel`: plain HTTP behind a Cloudflare Tunnel (Cloudflare terminates TLS); `proxy`: plain
   * HTTP behind the user's own reverse proxy; `direct`: Caddy gets certificates for `hosts`.
   */
  mode: "tunnel" | "proxy" | "direct";
  hosts: readonly string[];
  /** What Caddy proxies to: the shared edge's kamal-proxy on a server, `app:<port>` in a stack. */
  upstream: string;
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
  const lines: string[] = [];
  if (site.mode === "tunnel") {
    lines.push(TUNNEL_NOTE);
  } else if (site.mode === "proxy") {
    lines.push(
      "# Behind your own reverse proxy: it terminates TLS and forwards to Caddy over plain HTTP.",
      "{",
      "\tservers {",
      "\t\ttrusted_proxies static private_ranges",
      "\t}",
      "}",
      "",
    );
  } else if (site.acmeEmail && site.hosts.length > 0) {
    lines.push("{", `\temail ${site.acmeEmail}`, "}", "");
  }
  return [...lines, ...siteBlock(site, [])];
}

/**
 * One app's site file for the shared edge's Caddy on a server, served as {@link caddyfile} serves
 * it but without global options, which an imported file cannot have: the certificates' contact
 * email is the site's `tls` line.
 */
export function caddySite(site: CaddySite & { mode: "tunnel" | "direct" }): string[] {
  const tls =
    site.mode === "direct" && site.acmeEmail && site.hosts.length > 0
      ? [`\ttls ${site.acmeEmail}`]
      : [];
  return [...(site.mode === "tunnel" ? [TUNNEL_NOTE] : []), ...siteBlock(site, tls)];
}

/** The site block: its addresses, then `first`, the redirect, compression, the proxy and headers. */
function siteBlock(site: CaddySite, first: readonly string[]): string[] {
  const { mode, hosts } = site;
  const sites = mode === "tunnel" ? hosts.map((host) => `http://${host}`) : hosts;
  const lines = [
    `${mode === "proxy" || sites.length === 0 ? ":80" : sites.join(", ")} {`,
    ...first,
  ];
  if (mode === "tunnel") {
    // Caddy orders `redir` before `reverse_proxy`, so plain-HTTP visitors are redirected first.
    lines.push(
      '\t@http_visitor header Cf-Visitor `*"http"*`',
      "\tredir @http_visitor https://{host}{uri} 308",
    );
  }
  lines.push("\tencode zstd gzip", `\treverse_proxy ${site.upstream}`, "\theader {");
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
