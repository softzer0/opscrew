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

/** A single-quoted POSIX shell word (embedded quotes become `'\''`). */
export function shellQuote(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

/** A string literal in single quotes, read the same by JavaScript, Python, Ruby and PHP. */
export function scriptLiteral(text: string): string {
  return `'${text.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
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

/**
 * Where Caddy reads the app's Cloudflare origin certificate (`origin.pem`), its key (`origin.key`)
 * and the client certificate Cloudflare presents for the app (`pull.pem`): the server's
 * `/srv/edge/tls/<app>`, or the stack Caddy's tmpfs.
 */
export function originTlsDir(app: string): string {
  return `/etc/caddy/tls/${app}`;
}

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
  /**
   * A Portainer stack, where the app restarts in place: the folder whose file `version` Caddy
   * serves at {@link PORTAINER_VERSION_PATH} (the version of the image the stack runs, which its
   * deploy workflow waits for). Caddy also holds each request up to 30 seconds, trying the
   * upstream every 250 ms, so visitors wait while the app restarts instead of getting an error.
   */
  versionDir?: string | undefined;
  /**
   * `direct` mode only: the `hostnames` among `hosts` served with the app's Cloudflare origin
   * certificate from `dir` ({@link originTlsDir}), which accept only TLS connections that present
   * the client certificate Cloudflare sends for the app.
   */
  origin?: { hostnames: readonly string[]; dir: string } | undefined;
  /** A file the site imports inside its block: the user's own additions. */
  additions?: string | undefined;
  /**
   * Cloudflare's proxy serves the site and the edge trusts Cloudflare's addresses: the app gets the
   * visitor's address (Caddy's `{client_ip}`, from `CF-Connecting-IP`) as `X-Forwarded-For`.
   */
  realIp?: boolean | undefined;
}

/**
 * Where the Portainer stack's Caddy serves the version of the image the stack runs (from
 * {@link CaddySite}'s `versionDir`): the deploy workflow knows the new version runs when the site
 * answers with it.
 */
export const PORTAINER_VERSION_PATH = "/.well-known/opscrew-version";

/** Strict-Transport-Security, one year with subdomains, on both proxies (FR-1442). */
export const HSTS = "max-age=31536000; includeSubDomains";

/** The security headers both proxies send on every response, besides HSTS (FR-1442). */
export const BASELINE_HEADERS: readonly (readonly [name: string, value: string])[] = [
  ["X-Content-Type-Options", "nosniff"],
  ["X-Frame-Options", "SAMEORIGIN"],
  ["Referrer-Policy", "strict-origin-when-cross-origin"],
];

/**
 * `hosts` split into those the origin certificate covers (`origin`) and the others, which get a
 * certificate from a public authority: Caddy's ACME, or certbot on nginx.
 */
export function splitByOrigin(
  hosts: readonly string[],
  origin: readonly string[] | undefined,
): { origin: string[]; others: string[] } {
  const covered = hosts.filter((host) => origin?.includes(host));
  return { origin: covered, others: hosts.filter((host) => !covered.includes(host)) };
}

/**
 * The `tls` directive for the hostnames with the origin certificate: Caddy serves the certificate
 * from `dir` (so it obtains none for them) and refuses a client without the app's client
 * certificate.
 */
function originTlsLines(dir: string): string[] {
  return [
    `\ttls ${dir}/origin.pem ${dir}/origin.key {`,
    "\t\tclient_auth {",
    "\t\t\tmode require_and_verify",
    `\t\t\ttrust_pool file ${dir}/pull.pem`,
    "\t\t}",
    "\t}",
  ];
}

/**
 * The sites that refuse every hostname no app serves, after the apps' sites: requests on HTTP and
 * HTTPS are aborted, and a TLS connection for a name no site has a certificate for already fails
 * its handshake. They come after the apps' sites because Caddy runs the first of two sites without
 * a hostname, and an app without a domain yet is served on `:80` for every hostname.
 */
export const CATCH_ALL_SITES: readonly string[] = [
  "# Requests for any other hostname are refused.",
  "http:// {",
  "\tabort",
  "}",
  "https:// {",
  "\tabort",
  "}",
  "",
];

/**
 * Caddy's configuration: compression, security headers and a proxy to the app. Behind a tunnel the
 * sites are `http://` (no certificates) and still send HSTS; visitors who used plain HTTP are
 * redirected to HTTPS by the `Cf-Visitor` request header Cloudflare adds to proxied requests
 * (`{"scheme":"http"}` or `{"scheme":"https"}`, see
 * https://developers.cloudflare.com/fundamentals/reference/http-headers/), which can be trusted
 * because only Cloudflare reaches Caddy there. Behind the user's proxy Caddy serves `:80` and keeps
 * the `X-Forwarded-*` headers of a proxy on a private address. In `direct` mode the configuration
 * ends with {@link CATCH_ALL_SITES}.
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
  return [
    ...lines,
    ...siteBlocks(site, []),
    // Caddy is the origin visitors reach directly: it refuses every other hostname (FR-1404).
    ...(site.mode === "direct" ? CATCH_ALL_SITES : []),
  ];
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
  return [...(site.mode === "tunnel" ? [TUNNEL_NOTE] : []), ...siteBlocks(site, tls)];
}

/**
 * The site's blocks: in `direct` mode the hostnames with the origin certificate get a block of
 * their own ({@link originTlsLines}) and any others a second one with `tls`; otherwise one block
 * with `tls` for every hostname.
 */
function siteBlocks(site: CaddySite, tls: readonly string[]): string[] {
  const origin = site.mode === "direct" ? site.origin : undefined;
  const hosts = splitByOrigin(site.hosts, origin?.hostnames);
  if (origin === undefined || hosts.origin.length === 0) return siteBlock(site, site.hosts, tls);
  return [
    ...siteBlock(site, hosts.origin, originTlsLines(origin.dir)),
    ...(hosts.others.length === 0 ? [] : siteBlock(site, hosts.others, tls)),
  ];
}

/**
 * A site block for `hosts`: its addresses, then `first`, the redirect, the version file,
 * compression, the proxy, the headers and the user's additions.
 */
function siteBlock(site: CaddySite, hosts: readonly string[], first: readonly string[]): string[] {
  const { mode } = site;
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
  const header = [
    "\theader {",
    ...(hosts.length > 0 ? [`\t\tStrict-Transport-Security "${HSTS}"`] : []),
    ...BASELINE_HEADERS.map(([name, value]) => `\t\t${name} "${value}"`),
    "\t\t-Server",
    "\t}",
  ];
  const proxy = [
    ...(site.realIp ? ["\t\theader_up X-Forwarded-For {client_ip}"] : []),
    ...(site.versionDir === undefined
      ? []
      : ["\t\tlb_try_duration 30s", "\t\tlb_try_interval 250ms"]),
  ];
  lines.push(
    ...(site.versionDir === undefined
      ? []
      : [
          `\thandle ${PORTAINER_VERSION_PATH} {`,
          `\t\troot * ${site.versionDir}`,
          "\t\trewrite * /version",
          "\t\tfile_server",
          "\t}",
        ]),
    "\tencode zstd gzip",
    ...(proxy.length === 0
      ? [`\treverse_proxy ${site.upstream}`]
      : [`\treverse_proxy ${site.upstream} {`, ...proxy, "\t}"]),
    ...header,
    // The same headers on the responses Caddy writes itself, such as a 502 while the app is down.
    "\thandle_errors {",
    ...header.map((line) => `\t${line}`),
    '\t\trespond "{err.status_code} {err.status_text}" {err.status_code}',
    "\t}",
    ...(site.additions === undefined
      ? []
      : ["\t# Your own additions (opscrew/proxy/additions.caddy).", `\timport ${site.additions}`]),
    "}",
    "",
  );
  return lines;
}
