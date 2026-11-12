// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are OpenLiteSpeed and shell syntax, not JavaScript templates.
/**
 * The OpenLiteSpeed edge (`target.edge: openlitespeed`, ADR 0031, 027 research R12): its main
 * configuration, the catch-all virtual host, the apps' site files, and the container's loop with
 * the check, the graceful restart and the cache purge. OpenLiteSpeed's main process runs as root
 * in its container (it binds 80 and 443 and reads the certificates), its workers as `nobody`.
 *
 * OpenLiteSpeed writes copies next to every configuration file it loads, so the check copies the
 * read-only files the edge mounts in `/etc/opscrew` into its own folder first, and OpenLiteSpeed
 * loads those copies.
 */
import { BASELINE_HEADERS, HSTS, shellQuote, splitByOrigin } from "../runtime/services";
import { httpsPortSuffix, LOCALHOST_TLS } from "./localhost";
import { ACME_WEBROOT, certbotLive, MOZILLA_CIPHERS, RELOAD_DIR } from "./nginx";

/** OpenLiteSpeed's folder in its image. */
const LSWS = "/usr/local/lsws";

/** OpenLiteSpeed's configuration folder: the copies it loads. */
const CONF = `${LSWS}/conf`;

/** The copies of the apps' site files (`/srv/edge/sites`) OpenLiteSpeed loads. */
const SITES = `${CONF}/sites`;

/**
 * Every virtual host's root: it holds the folder of OpsCrew's error page and certbot's webroot
 * ({@link ACME_WEBROOT}), and a virtual host serves no file outside it.
 */
const VH_ROOT = "/var/www";

/** The folder of the error page, every virtual host's document root. */
const SERVED = `${VH_ROOT}/opscrew`;

/** The error page's address in every virtual host. */
const ERROR_PAGE = "/opscrew-error.html";

/** OpenLiteSpeed's work folder: without it, `openlitespeed -t` passes without checking anything. */
const WORK = "/tmp/lshttpd";

const PID_FILE = `${WORK}/lshttpd.pid`;

/** The lock the check and the restart hold, so the loop's and a deploy's never overlap. */
const LOCK = `${WORK}/opscrew.lock`;

const BIN = `${LSWS}/bin/openlitespeed`;

/** The HTTPS listener's placeholder certificate and key, for names no app serves; made once. */
const PLACEHOLDER = {
  certificate: `${CONF}/default.invalid.pem`,
  key: `${CONF}/default.invalid.key`,
};

/** The catch-all virtual host; no app has its name (an app's name has no `_`). */
const CATCH_ALL = "_catchall";

/** The error log: OpenLiteSpeed's own output stops reaching Docker after its first restart. */
const ERROR_LOG = `${LSWS}/logs/error.log`;

/**
 * Where the edge mounts, read-only, OpenLiteSpeed's configuration, the catch-all, the error page and
 * the scripts of the check and the checked graceful restart (Compose configs), the apps' site files
 * (`/srv/edge/sites`) and their certificates (`/srv/edge/tls`).
 */
export const OPENLITESPEED_INPUT = {
  conf: "/etc/opscrew/httpd_config.conf",
  catchAll: "/etc/opscrew/catchall.conf",
  errorPage: "/etc/opscrew/error.html",
  check: "/etc/opscrew/check.sh",
  reload: "/etc/opscrew/reload.sh",
  sites: "/etc/opscrew/sites",
  tls: "/etc/opscrew/tls",
} as const;

/**
 * The check and the checked graceful restart as commands in the running container (or a one-off
 * one): the edge's own scripts ({@link OPENLITESPEED_CHECK}, {@link OPENLITESPEED_RELOAD}), so
 * every app's deploy on a server runs those of the edge it has.
 */
export const OPENLITESPEED_COMMAND = {
  check: `sh ${OPENLITESPEED_INPUT.check}`,
  reload: `sh ${OPENLITESPEED_INPUT.reload}`,
} as const;

/**
 * The Linux capabilities OpenLiteSpeed's main process keeps (Docker's others are dropped): binding
 * 80 and 443, reading the deploy user's keys, preparing its folders, starting its workers as
 * `nobody` and signalling them.
 */
export const OPENLITESPEED_CAPABILITIES = [
  "CHOWN",
  "DAC_OVERRIDE",
  "FOWNER",
  "KILL",
  "NET_BIND_SERVICE",
  "SETGID",
  "SETUID",
];

/**
 * The name of the kamal-proxy external app in every virtual host: a site, and the user's
 * additions, send the app's traffic to `handler kamal-proxy`.
 */
export const OPENLITESPEED_UPSTREAM = "kamal-proxy";

/** The app's additions as OpenLiteSpeed loads them: `conf/sites/<app>.additions`. */
export function openlitespeedAdditionsFile(app: string): string {
  return `${SITES}/${app}.additions`;
}

/** The folder of the app's page cache, which a deploy and a rollback empty (ADR 0031 D4). */
function cacheDir(app: string): string {
  return `${LSWS}/cachedata/${app}`;
}

/** A line of a block: `key`, padded, then `value`. */
function set(key: string, value: string | number): string {
  return `  ${key.padEnd(24)}${value}`;
}

/** A block with `lines` under `head {`, then an empty line. */
function block(head: string, lines: readonly string[]): string[] {
  return [`${head} {`, ...lines, "}", ""];
}

/** A list of `Header` or rewrite lines inside a block (`<<<END_<key>`). */
function heredoc(key: string, lines: readonly string[]): string[] {
  return [set(key, `<<<END_${key}`), ...lines, `  END_${key}`];
}

/**
 * TLS 1.2 and 1.3 only (`sslProtocol 24`) with Mozilla's intermediate ciphers, as nginx's. A
 * listener's lines reach only its own certificate, so every `vhssl` repeats them.
 */
const TLS_LINES = [
  set("certChain", 1),
  set("sslProtocol", 24),
  set("enableECDHE", 1),
  set("ciphers", MOZILLA_CIPHERS),
];

/** A listener on `port`: the apps' hostnames, then every other name to the catch-all. */
function listener(name: string, port: number, tls: readonly string[]): string[] {
  return block(`listener ${name}`, [
    set("address", `*:${port}`),
    set("secure", tls.length > 0 ? 1 : 0),
    ...tls,
    `  include ${SITES}/*.map`,
    set("map", `${CATCH_ALL} *`),
  ]);
}

/**
 * OpenLiteSpeed's main configuration: no version anywhere, no admin console, the error log in a
 * file, no access log (as Caddy), the page cache off, the longest request any app gets (300 s),
 * graceful restarts that keep open connections up to 300 s, the apps' virtual hosts (each app's
 * `sites/<app>.vhost`), the catch-all, and the listeners on 80 and 443 (TLS 1.2 and 1.3, with a
 * placeholder certificate for names no app serves), each mapping the apps' hostnames (each app's
 * `sites/<app>.map`) and every other name to the catch-all, which answers 403. HTTP/3 except on
 * this computer (`local`), where the edge publishes no UDP port. With Cloudflare's `ranges`,
 * requests from them carry the visitor's address in `CF-Connecting-IP`, which OpenLiteSpeed then
 * uses as the client's (`useIpInProxyHeader 2`, those ranges marked trusted with `T`), as Caddy
 * and nginx do; from any other address the header is ignored.
 */
export function openlitespeedConf(local: boolean, ranges: readonly string[] = []): string {
  const trusted = ranges.length > 0;
  return [
    "# OpsCrew's shared edge: each OpsCrew app on this server has its virtual host in /srv/edge/sites/<app>.vhost,",
    "# its hostnames in <app>.map and its configuration in <app>.vhconf.",
    "serverName                opscrew",
    "user                      nobody",
    "group                     nogroup",
    "autoRestart               1",
    "inMemBufSize              60M",
    `swappingDir               ${WORK}/swap`,
    "gracefulRestartTimeout    300",
    "mime                      conf/mime.properties",
    "showVersionNumber         2",
    "disableWebAdmin           1",
    ...(trusted
      ? [
          "# Requests from Cloudflare's addresses (marked T below) carry the visitor's in CF-Connecting-IP.",
          "useIpInProxyHeader        2",
        ]
      : []),
    "",
    ...block(`errorlog ${ERROR_LOG}`, [
      set("logLevel", "NOTICE"),
      set("debugLevel", 0),
      set("rollingSize", "10M"),
      set("keepDays", 7),
    ]),
    ...block("accessLog /dev/null", [set("rollingSize", 0)]),
    ...block("tuning", [
      set("connTimeout", 300),
      set("maxReqBodySize", "2047M"),
      ...(local
        ? [set("quicEnable", 0)]
        : [set("quicEnable", 1), set("quicShmDir", "/dev/shm/ols")]),
    ]),
    ...block("accessControl", [
      set("allow", ["ALL", ...ranges.map((range) => `${range}T`)].join(", ")),
    ]),
    "# Off: an app's answer is kept only when it asks for it (X-LiteSpeed-Cache-Control).",
    ...block("module cache", [
      set("ls_enabled", 1),
      set("enableCache", 0),
      set("enablePrivateCache", 0),
      set("storagePath", `${LSWS}/cachedata`),
    ]),
    `include ${SITES}/*.vhost`,
    "",
    "# Every hostname no app serves.",
    ...block(`virtualHost ${CATCH_ALL}`, [
      set("vhRoot", `${VH_ROOT}/`),
      set("configFile", `${CONF}/catchall.conf`),
    ]),
    ...listener("HTTP", 80, []),
    ...listener("HTTPS", 443, [
      set("keyFile", PLACEHOLDER.key),
      set("certFile", PLACEHOLDER.certificate),
      ...TLS_LINES,
    ]),
  ].join("\n");
}

/** OpsCrew's error page, which OpenLiteSpeed shows instead of its own: those can name LiteSpeed. */
export const OPENLITESPEED_ERROR_PAGE = [
  "<!DOCTYPE html>",
  '<html lang="en">',
  '<meta charset="utf-8">',
  "<title>Unavailable</title>",
  "<p>This page is not available.</p>",
  "</html>",
  "",
].join("\n");

/** A virtual host's error pages: the errors OpenLiteSpeed answers itself show OpsCrew's page. */
const ERROR_PAGES = [
  ...[400, 403, 404, 405, 408, 413, 500, 502, 503, 504].flatMap((code) =>
    block(`errorPage ${code}`, [set("url", ERROR_PAGE)]),
  ),
  ...block(`context ${ERROR_PAGE}`, [
    set("location", `${SERVED}${ERROR_PAGE}`),
    set("allowBrowse", 1),
  ]),
];

/**
 * The rewrite block of `rules`, none without rules. The error page is never rewritten: a refusal
 * shows it, and OpenLiteSpeed fetches it through these rules.
 */
function rewrite(rules: readonly string[]): string[] {
  if (rules.length === 0) return [];
  return block("rewrite", [
    set("enable", 1),
    set("autoLoadHtaccess", 0),
    ...heredoc("rules", [`RewriteRule ^${literal(ERROR_PAGE)}$ - [L]`, ...rules]),
  ]);
}

/** The catch-all virtual host's configuration: every request gets a 403 with the error page. */
export const OPENLITESPEED_CATCH_ALL = [
  "# Every hostname no OpsCrew app on this server serves: refused with 403.",
  set("docRoot", `${SERVED}/`).trim(),
  "",
  ...ERROR_PAGES,
  ...rewrite(["RewriteRule ^ - [F]"]),
].join("\n");

/** One app's site on the OpenLiteSpeed edge, for {@link openlitespeedSite}. */
export interface OpenLiteSpeedSite {
  app: string;
  /** `tunnel`: plain HTTP behind a Cloudflare Tunnel; `direct`: OpenLiteSpeed serves HTTPS itself. */
  mode: "tunnel" | "direct";
  hosts: readonly string[];
  /** `direct` mode: the hostnames among `hosts` served with the app's Cloudflare origin certificate. */
  origin?: readonly string[] | undefined;
  /**
   * The user's additions, included at the end of the app's virtual host: the `file` included, from
   * `source` in the repository (`additionsPath`).
   */
  additions?: { file: string; source: string } | undefined;
  /**
   * The site before certbot's first certificate: its hostnames are served over HTTP, with the
   * webroot, and refused over HTTPS.
   */
  beforeCertificate?: boolean;
  /**
   * The hostnames among `hosts` that only redirect to `https://<the first other host>` with the
   * path and query (308): `www.<domain>`.
   */
  redirects?: readonly string[] | undefined;
  /**
   * `direct` mode on this computer (the localhost target): the hostname is served with the leaf
   * certificate of OpsCrew's local CA from the app's TLS folder, and HTTP redirects to HTTPS on
   * `httpsPort`.
   */
  local?: { httpsPort: number } | undefined;
}

/** How the app's virtual host serves its hostnames. */
interface Serving {
  /** The `vhssl` certificate lines; none for plain HTTP. */
  tls: readonly string[];
  /** HSTS on every answer. */
  hsts: boolean;
  /** HTTP redirects to HTTPS: to the request's hostname, or to `host` on `port`. */
  https?: { host?: string; port?: number } | undefined;
  /** certbot's HTTP-01 challenges, from its webroot over HTTP. */
  acme: boolean;
  /** Requests over HTTPS get a 403: plain HTTP only. */
  httpOnly: boolean;
  /** Visitors who used HTTP are redirected by Cloudflare's `Cf-Visitor` header (behind a tunnel). */
  cfVisitor: boolean;
}

/** Where the app's origin certificates and its local leaf are: `/etc/opscrew/tls/<app>`. */
function tlsDir(app: string): string {
  return `${OPENLITESPEED_INPUT.tls}/${app}`;
}

/** How the app's virtual host serves `site.hosts`, as {@link openlitespeedSite} describes. */
function serving(site: OpenLiteSpeedSite): Serving {
  const none = { tls: [], hsts: false, acme: false, httpOnly: false, cfVisitor: false };
  if (site.mode === "tunnel") return { ...none, hsts: true, cfVisitor: true };
  if (site.hosts.length === 0) return { ...none, httpOnly: true };
  const dir = tlsDir(site.app);
  if (site.local !== undefined) {
    return {
      ...none,
      tls: [
        set("certFile", `${dir}/${LOCALHOST_TLS.certificate}`),
        set("keyFile", `${dir}/${LOCALHOST_TLS.key}`),
      ],
      https: { host: site.hosts[0], port: site.local.httpsPort },
    };
  }
  const { origin, others } = splitByOrigin(site.hosts, site.origin);
  if (origin.length > 0) {
    return {
      ...none,
      tls: [
        set("certFile", `${dir}/origin.pem`),
        set("keyFile", `${dir}/origin.key`),
        set("clientVerify", 2),
        set("verifyDepth", 1),
        set("CACertFile", `${dir}/pull.pem`),
      ],
      hsts: true,
      https: {},
      acme: others.length > 0,
    };
  }
  if (site.beforeCertificate) return { ...none, acme: true, httpOnly: true };
  const live = certbotLive(site.app);
  return {
    ...none,
    tls: [set("certFile", `${live}/fullchain.pem`), set("keyFile", `${live}/privkey.pem`)],
    hsts: true,
    https: {},
    acme: true,
  };
}

/** `text` as a regular expression that matches only itself. */
function literal(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The rewrite rules of the app's virtual host, before anything reaches the app: a hostname it does
 * not serve (OpenLiteSpeed maps `www.<name>` with `<name>` and the other way round) gets a 403,
 * as does HTTPS when it serves plain HTTP only; then the redirects to HTTPS, and `www` to the
 * domain. certbot's challenges are never redirected.
 */
function rewriteRules(site: OpenLiteSpeedSite, how: Serving): string[] {
  const acme = how.acme ? ["RewriteCond %{REQUEST_URI} !^/\\.well-known/acme-challenge/"] : [];
  const rules: string[] = [];
  if (site.hosts.length > 0) {
    const names = site.hosts.map(literal).join("|");
    rules.push(`RewriteCond %{HTTP_HOST} !^(${names})(:[0-9]+)?$ [NC]`, "RewriteRule ^ - [F]");
  }
  if (how.httpOnly) rules.push("RewriteCond %{HTTPS} on", "RewriteRule ^ - [F]");
  if (how.cfVisitor) {
    rules.push(
      "RewriteCond %{HTTP:Cf-Visitor} :.http[^s]",
      "RewriteRule ^(.*)$ https://%{HTTP_HOST}$1 [R=308,L]",
    );
  }
  if (how.https !== undefined) {
    const host = how.https.host ?? "%{HTTP_HOST}";
    rules.push(
      "RewriteCond %{HTTPS} !on",
      ...acme,
      `RewriteRule ^(.*)$ https://${host}${httpsPortSuffix(how.https.port ?? 443)}$1 [R=308,L]`,
    );
  }
  const redirects = site.redirects ?? [];
  const to = site.hosts.find((host) => !redirects.includes(host));
  if (to !== undefined) {
    const scheme = how.httpOnly ? "http" : "https";
    for (const host of redirects.filter((h) => site.hosts.includes(h))) {
      rules.push(
        `RewriteCond %{HTTP_HOST} ^${literal(host)}(:[0-9]+)?$ [NC]`,
        ...acme,
        `RewriteRule ^(.*)$ ${scheme}://${to}$1 [R=308,L]`,
      );
    }
  }
  return rules;
}

/**
 * The files of an app's site on the OpenLiteSpeed edge, by their names in `/srv/edge/sites`:
 * `<app>.vhost` declares its virtual host, `<app>.map` maps its hostnames to it on both listeners,
 * and `<app>.vhconf` configures it: OpsCrew's error page instead of OpenLiteSpeed's, the app's
 * traffic and its WebSockets to kamal-proxy, the security headers on every answer (HSTS where it
 * serves HTTPS), the client's own `X-Forwarded-For`, `X-Forwarded-Host` and `X-Forwarded-Proto`
 * dropped (OpenLiteSpeed appends to them otherwise, and sends its own), the page cache in the app's
 * own folder and off, then the user's additions. OpenLiteSpeed drops the client's `X-Forwarded-For`
 * by blanking its name, so that value still reaches the app under a name of `x`s, which no app
 * reads; the other two are gone.
 *
 * How it serves its hostnames:
 * - `direct` with hostnames: certbot's certificate (`--cert-name <app>`), with its challenges on
 *   HTTP; with the origin certificate from `/srv/edge/tls/<app>` when `origin` has any of them,
 *   accepting only the client certificate Cloudflare presents for the app (OpenLiteSpeed serves
 *   one certificate per virtual host, and `<name>` and `www.<name>` from one virtual host, so a
 *   hostname without the origin certificate is served with it too). HTTP redirects to HTTPS;
 * - `direct` before certbot's first certificate (`beforeCertificate`): plain HTTP with the
 *   challenges, HTTPS refused;
 * - `direct` without hostnames (no domain yet): plain HTTP for every hostname, HTTPS refused;
 * - `direct` on this computer (`local`): the leaf certificate of OpsCrew's local CA from
 *   `tls/<app>`, HTTP redirected to HTTPS;
 * - `tunnel`: plain HTTP for its hostnames, with HSTS, and visitors who used HTTP redirected by
 *   Cloudflare's `Cf-Visitor` header, as Caddy does.
 *
 * `redirects` (`www`) go to the domain with 308.
 */
export function openlitespeedSite(site: OpenLiteSpeedSite): Record<string, string[]> {
  const { app } = site;
  const how = serving(site);
  const headers = [
    ...(how.hsts ? [`Header set Strict-Transport-Security "${HSTS}"`] : []),
    ...BASELINE_HEADERS.map(([name, value]) => `Header set ${name} "${value}"`),
    "RequestHeader unset X-Forwarded-For",
    "RequestHeader unset X-Forwarded-Host",
    "RequestHeader unset X-Forwarded-Proto",
  ];
  const vhconf = [
    set("docRoot", `${SERVED}/`).trim(),
    set("enableGzip", 0).trim(),
    "",
    ...ERROR_PAGES,
    "# kamal-proxy, whose address OpenLiteSpeed looks up when it loads its configuration.",
    ...block(`extprocessor ${OPENLITESPEED_UPSTREAM}`, [
      set("type", "proxy"),
      set("address", "kamal-proxy:80"),
      set("maxConns", 1000),
      set("pcKeepAliveTimeout", 60),
      set("initTimeout", 60),
      set("retryTimeout", 0),
      set("respBuffer", 0),
    ]),
    ...block("context /", [
      set("type", "proxy"),
      set("handler", OPENLITESPEED_UPSTREAM),
      set("addDefaultCharset", "off"),
      ...heredoc("extraHeaders", headers),
    ]),
    ...(how.acme
      ? [
          "# certbot's HTTP-01 challenges, from its webroot. A pattern, since OpenLiteSpeed refuses a",
          "# folder that does not exist yet, and certbot makes it at its first challenge.",
          ...block("context exp:^/(\\.well-known/acme-challenge/[^/]+)$", [
            set("location", `${ACME_WEBROOT}/$1`),
            set("allowBrowse", 1),
          ]),
        ]
      : []),
    "# WebSockets: an Upgrade request reaches the app as one.",
    ...block("websocket /", [set("address", "kamal-proxy:80")]),
    ...rewrite(rewriteRules(site, how)),
    ...(how.tls.length > 0 ? block("vhssl", [...how.tls, ...TLS_LINES]) : []),
    "# Off: an answer is kept only when the app asks for it (X-LiteSpeed-Cache-Control).",
    ...block("module cache", [
      set("ls_enabled", 1),
      ...heredoc("param", [
        "enableCache             0",
        "enablePrivateCache      0",
        `storagePath             ${cacheDir(app)}`,
      ]),
    ]),
    ...(site.additions === undefined
      ? []
      : [`# Your own additions (${site.additions.source}).`, `include ${site.additions.file}`, ""]),
  ];
  return {
    [`${app}.vhost`]: block(`virtualHost ${app}`, [
      set("vhRoot", `${VH_ROOT}/`),
      set("configFile", `${SITES}/${app}.vhconf`),
    ]),
    [`${app}.map`]: [`map ${app} ${site.hosts.length > 0 ? site.hosts.join(", ") : "*"}`, ""],
    [`${app}.vhconf`]: vhconf,
  };
}

/**
 * Whether OpenLiteSpeed runs: its main process by its title, `openlitespeed (lshttpd - main)`,
 * anchored, so that it never finds a shell whose script names it.
 */
const RUNNING = "pgrep -f '^openlitespeed \\(lshttpd - main\\)' > /dev/null";

/**
 * The shell functions of the check and the graceful restart (ADR 0031 D2). `check` copies the
 * configuration and the sites from `/etc/opscrew` into OpenLiteSpeed's folder, makes its work
 * folder (without it the check passes unchecked), the placeholder certificate and the error page,
 * checks that every certificate and key the configuration names is there and not empty
 * (`openlitespeed -t` misses a listener's, which then serves plain HTTP), then runs
 * `openlitespeed -t`, which exits 2 on an error and 1 on warnings (a proxy always has some), and
 * refuses with the errors. `restart` sends the running main process SIGUSR1: a new one loads the
 * configuration and the old one ends once its connections have, at most 300 seconds later. Its pid
 * file is empty for a moment while it does. `locked` runs one of them, or `reload` (both), holding
 * {@link LOCK}: the check rewrites the files OpenLiteSpeed loads, so the loop's restart after a
 * renewal and a deploy's never load each other's half-copied sites.
 */
const FUNCTIONS = [
  `running() { ${RUNNING}; }`,
  "check() {",
  `  mkdir -p ${WORK} ${SERVED}`,
  `  cp ${OPENLITESPEED_INPUT.conf} ${CONF}/httpd_config.conf`,
  `  cp ${OPENLITESPEED_INPUT.catchAll} ${CONF}/catchall.conf`,
  `  cat ${OPENLITESPEED_INPUT.errorPage} > ${SERVED}${ERROR_PAGE}`,
  `  rm -rf ${SITES}`,
  `  cp -R ${OPENLITESPEED_INPUT.sites} ${SITES}`,
  `  if [ ! -s ${PLACEHOLDER.key} ]; then`,
  `    openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 3650 -subj /CN=default.invalid -keyout ${PLACEHOLDER.key} -out ${PLACEHOLDER.certificate} 2> /dev/null`,
  "  fi",
  "  missing=''",
  `  for f in $(awk '$1 == "certFile" || $1 == "keyFile" || $1 == "CACertFile" { print $2 }' ${CONF}/httpd_config.conf ${SITES}/*.vhconf 2> /dev/null); do`,
  '    if [ ! -s "$f" ]; then missing="$missing $f"; fi',
  "  done",
  '  if [ -n "$missing" ]; then',
  '    echo "OpenLiteSpeed refused the configuration: these certificate files are missing or empty:$missing" >&2',
  "    return 2",
  "  fi",
  `  out="$(${BIN} -t 2>&1)"`,
  "  status=$?",
  '  if [ "$status" -gt 1 ]; then',
  "    echo 'OpenLiteSpeed refused the configuration:' >&2",
  "    printf '%s\\n' \"$out\" | grep -F '[ERROR]' >&2",
  '    return "$status"',
  "  fi",
  "}",
  "restart() {",
  `  pid="$(cat ${PID_FILE} 2> /dev/null)"`,
  `  if [ -z "$pid" ]; then sleep 1; pid="$(cat ${PID_FILE} 2> /dev/null)"; fi`,
  '  kill -USR1 "$pid"',
  "}",
  "reload() { check && restart; }",
  `locked() { mkdir -p ${WORK}; ( flock 9 && "$@" ) 9> ${LOCK}; }`,
];

/**
 * The check (a shell script, the edge's `check.sh`): the configuration and the sites as `/etc/opscrew` has them, every named
 * certificate and key there, and nothing `openlitespeed -t` calls an error. A refusal prints the
 * reason and exits non-zero; the running configuration stays.
 */
export const OPENLITESPEED_CHECK = [...FUNCTIONS, "locked check"].join("\n");

/**
 * The checked graceful restart (a shell script, the edge's `reload.sh`, run in the running
 * container): {@link OPENLITESPEED_CHECK}, then the restart, which keeps open connections up to
 * 300 seconds. A refusal leaves the running configuration in place, as nginx's does.
 */
export const OPENLITESPEED_RELOAD = [...FUNCTIONS, "locked reload"].join("\n");

/**
 * The OpenLiteSpeed container's command (`sh -c`, under Docker's init): the check, then
 * OpenLiteSpeed, which runs in the background and starts a new main process at each graceful
 * restart, so the loop watches it by its title. Every 5 seconds, when certbot's deploy hook left
 * the reload flag, a checked graceful restart. A stop signal stops OpenLiteSpeed; when it is gone,
 * the container exits, and Docker starts it again. A configuration the check refuses stops the
 * container before OpenLiteSpeed starts.
 */
export const OPENLITESPEED_LOOP = [
  ...FUNCTIONS,
  "locked check || exit 1",
  `rm -f ${PID_FILE}`,
  BIN,
  "for i in $(seq 1 30); do if running; then break; fi; sleep 1; done",
  `stop() { kill -TERM "$(cat ${PID_FILE})"; while running; do sleep 1; done; exit 0; }`,
  "trap stop TERM INT QUIT",
  "while running; do",
  "  sleep 5 &",
  "  wait $!",
  `  if [ -e ${RELOAD_DIR}/flag ]; then`,
  `    rm -f ${RELOAD_DIR}/flag`,
  "    locked reload",
  "  fi",
  "done",
  "exit 1",
].join("\n");

/** The OpenLiteSpeed container is healthy while its main process runs. */
export const OPENLITESPEED_HEALTHCHECK = {
  test: ["CMD-SHELL", RUNNING],
  interval: "30s",
  timeout: "5s",
  start_period: "30s",
  start_interval: "1s",
};

/**
 * The purge of the app's page cache (`sh -c`, in the running container), on a deploy and a
 * rollback: the kept answers are removed, which takes effect at once (ADR 0031 D4); the cache's
 * own `.cacheman` files stay.
 */
export function openlitespeedCachePurge(app: string): string {
  const dir = shellQuote(cacheDir(app));
  return `if [ -d ${dir} ]; then find ${dir} -mindepth 1 -maxdepth 1 ! -name '.*' -exec rm -rf {} +; fi`;
}
