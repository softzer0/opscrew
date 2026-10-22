// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are nginx and shell syntax, not JavaScript templates.
/**
 * The nginx edge (`target.edge: nginx`, research.md R5): nginx-unprivileged's main configuration,
 * the apps' site files, and the loops of the nginx and certbot containers. Both run as the deploy
 * user, so nginx reads the origin key the deploy writes (0600) and certbot's files.
 */
import { BASELINE_HEADERS, HSTS, shellQuote, splitByOrigin } from "../runtime/services";
import { httpsPortSuffix, LOCALHOST_TLS } from "./localhost";

/**
 * The upstream group of the edge's kamal-proxy in nginx's configuration: a site, and the user's
 * additions, send the app's traffic to `proxy_pass http://kamal-proxy`.
 */
export const NGINX_UPSTREAM = "kamal-proxy";

/** Where nginx listens in its container: nginx-unprivileged binds no port below 1024. */
export const NGINX_PORTS = { http: 8080, https: 8443 } as const;

/** The folder of the apps' site files in the nginx container (the server's `/srv/edge/sites`). */
const NGINX_SITES = "/etc/nginx/sites";

/** certbot's state (the volume `letsencrypt`); nginx mounts it read-only. */
export const LETSENCRYPT = "/etc/letsencrypt";

/** The HTTP-01 webroot (the volume `acme-webroot`), which certbot writes and nginx serves. */
export const ACME_WEBROOT = "/var/www/acme";

/** The folder of the reload flag (the volume `reload`), which certbot's deploy hook touches. */
export const RELOAD_DIR = "/var/www/reload";

const RELOAD_FLAG = `${RELOAD_DIR}/flag`;

/** nginx's pid file: it exists once the master runs and handles signals. */
const NGINX_PID = "/tmp/nginx.pid";

/**
 * certbot renews a certificate this many days before it expires (certbot's default is a third of
 * its lifetime, 30 days for today's 90-day certificates), so a renewal that keeps failing is
 * reported by `verify`, `status` and `secure`, which warn below 30 days, for two weeks first.
 */
export const RENEW_BEFORE_EXPIRY_DAYS = 45;

/**
 * Where nginx reads the app's origin certificate, its key and `pull.pem` (`/srv/edge/tls/<app>`),
 * or on this computer its leaf certificate and key.
 */
function nginxTlsDir(app: string): string {
  return `/etc/nginx/tls/${app}`;
}

/** The app's additions in the nginx container: `/etc/nginx/sites/<app>.additions`. */
export function nginxAdditionsFile(app: string): string {
  return `${NGINX_SITES}/${app}.additions`;
}

/** The request zone of the app's site, which the user's additions can use with `limit_req`. */
function nginxRequestZone(app: string): string {
  return `opscrew_${app}`;
}

/** Mozilla's intermediate configuration, version 6.0 ("Spike results" 6). */
const MOZILLA_INTERMEDIATE = [
  "\tssl_protocols TLSv1.2 TLSv1.3;",
  "\tssl_ecdh_curve X25519MLKEM768:X25519:prime256v1:secp384r1;",
  "\tssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305;",
  "\tssl_prefer_server_ciphers off;",
  "\tssl_session_timeout 1d;",
  "\tssl_session_cache shared:opscrew_tls:10m;",
  "\tssl_session_tickets off;",
];

/**
 * nginx's main configuration: no version in `Server`, no access log (as Caddy), HTTP/2, TLS 1.2
 * and 1.3 with Mozilla's intermediate profile, kamal-proxy as an upstream nginx looks up again
 * while it runs (a recreated kamal-proxy can get another address), a `default_server` that refuses
 * every hostname no app serves on 80 and 443, then the apps' site files.
 */
export const NGINX_CONF = [
  "# OpsCrew's shared edge: each OpsCrew app on this server has its site in /srv/edge/sites/<app>.conf.",
  "worker_processes auto;",
  `pid ${NGINX_PID};`,
  "error_log stderr notice;",
  "",
  "events {",
  "\tworker_connections 1024;",
  "}",
  "",
  "http {",
  "\tinclude /etc/nginx/mime.types;",
  "\tdefault_type application/octet-stream;",
  "\taccess_log off;",
  "\tserver_tokens off;",
  "\thttp2 on;",
  "\t# A block with headers of its own (the user's additions) keeps the site's: HSTS and the rest.",
  "\tadd_header_inherit merge;",
  "\t# nginx runs as the deploy user, who can write only /tmp in the container.",
  "\tclient_body_temp_path /tmp/client_temp;",
  "\tproxy_temp_path /tmp/proxy_temp;",
  "\tfastcgi_temp_path /tmp/fastcgi_temp;",
  "\tuwsgi_temp_path /tmp/uwsgi_temp;",
  "\tscgi_temp_path /tmp/scgi_temp;",
  "",
  "\t# Mozilla's intermediate configuration (version 6.0).",
  ...MOZILLA_INTERMEDIATE,
  "",
  "\t# WebSockets: an Upgrade request reaches the app as one.",
  "\tmap $http_upgrade $connection_upgrade {",
  "\t\tdefault upgrade;",
  '\t\t"" close;',
  "\t}",
  "",
  "\t# kamal-proxy, looked up again in Docker's DNS every 10 seconds, and never set aside after a",
  "\t# failed request: it is the only upstream.",
  "\tresolver 127.0.0.11 valid=10s ipv6=off;",
  `\tupstream ${NGINX_UPSTREAM} {`,
  `\t\tzone ${NGINX_UPSTREAM} 64k;`,
  "\t\tserver kamal-proxy:80 resolve max_fails=0;",
  "\t}",
  "",
  "\t# Requests for any other hostname are refused: the connection is closed, and a TLS handshake",
  "\t# for a name no site serves fails.",
  "\tserver {",
  `\t\tlisten ${NGINX_PORTS.http} default_server;`,
  `\t\tlisten ${NGINX_PORTS.https} ssl default_server;`,
  `\t\tlisten ${NGINX_PORTS.https} quic reuseport default_server;`,
  "\t\tssl_reject_handshake on;",
  "\t\treturn 444;",
  "\t}",
  "",
  `\tinclude ${NGINX_SITES}/*.conf;`,
  "}",
  "",
].join("\n");

/**
 * The nginx container's command (`sh -c`): nginx in the background, and every 5 seconds, when
 * certbot's deploy hook left the reload flag, `nginx -t` then a reload, which keeps the
 * connections and, with a configuration nginx refuses, the running one. A stop signal quits nginx
 * gracefully; when nginx exits, so does the container, and Docker starts it again.
 */
export const NGINX_LOOP = [
  `rm -f ${NGINX_PID}`,
  "nginx -g 'daemon off;' &",
  "pid=$!",
  `trap 'kill -QUIT "$pid"; wait "$pid"; exit 0' TERM INT QUIT`,
  'while kill -0 "$pid" 2> /dev/null; do',
  "  sleep 5 &",
  "  wait $!",
  `  if [ -e ${RELOAD_FLAG} ]; then`,
  `    rm -f ${RELOAD_FLAG}`,
  "    if nginx -t -q; then nginx -s reload; fi",
  "  fi",
  "done",
  "exit 1",
].join("\n");

/** The nginx container is healthy once its master runs (the loop removes an old pid file first). */
export const NGINX_HEALTHCHECK = {
  test: ["CMD-SHELL", `test -s ${NGINX_PID}`],
  interval: "30s",
  timeout: "5s",
  start_period: "30s",
  start_interval: "1s",
};

/** certbot's folders: its state on the volume, and its work and logs in the container. */
const CERTBOT_DIRS = `--config-dir ${LETSENCRYPT} --work-dir /tmp/certbot/work --logs-dir /tmp/certbot/logs`;

/**
 * The certbot container's command (`sh -c`): `certbot renew` every 12 hours plus a random delay of
 * up to an hour, the first after that wait: at start the deploy's own `certonly` renews what is due,
 * and the two would collide on certbot's lock. Each certificate's renewal file holds its webroot
 * and the deploy hook that touches the reload flag ({@link certbotCertonly}).
 */
export const CERTBOT_LOOP = [
  "trap 'exit 0' TERM INT",
  "while :; do",
  "  sleep $((43200 + RANDOM % 3600)) &",
  "  wait $!",
  `  certbot renew ${CERTBOT_DIRS} --no-random-sleep-on-renew`,
  "done",
].join("\n");

/** What certbot prints when another certbot holds its lock (certbot's `LockError`). */
export const CERTBOT_LOCKED = "Another instance of Certbot is already running";

/**
 * certbot's arguments (shell words) for the app's certificate, `--cert-name <app>` through the
 * webroot, which the deploy runs every time: certbot does nothing while the certificate is valid
 * for `hosts`, and gets a new one when they changed. Its deploy hook, which `certbot renew` keeps,
 * touches the reload flag.
 */
export function certbotCertonly(
  app: string,
  hosts: readonly string[],
  email: string | undefined,
): string {
  return [
    `certonly ${CERTBOT_DIRS} --non-interactive --agree-tos`,
    email ? `--email ${shellQuote(email)}` : "--register-unsafely-without-email",
    `--keep-until-expiring --webroot --webroot-path ${ACME_WEBROOT}`,
    `--cert-name ${app} --domains ${hosts.join(",")}`,
    `--deploy-hook ${shellQuote(`touch ${RELOAD_FLAG}`)}`,
  ].join(" ");
}

/**
 * The script (`sh -c`) that writes `renew_before_expiry` at the top of the app's renewal file, once:
 * certbot has no flag for it ("Spike results" 13), and keeps the line when it rewrites the file.
 */
export function certbotRenewBefore(app: string): string {
  const file = `${LETSENCRYPT}/renewal/${app}.conf`;
  return [
    `f=${file}`,
    `if ! grep -q '^renew_before_expiry' "$f"; then { echo 'renew_before_expiry = ${RENEW_BEFORE_EXPIRY_DAYS} days'; cat "$f"; } > "$f.new" && mv "$f.new" "$f"; fi`,
  ].join("; ");
}

/** The folder of the app's certbot certificate (`fullchain.pem`, `privkey.pem`), once it has one. */
export function certbotLive(app: string): string {
  return `${LETSENCRYPT}/live/${app}`;
}

/** One app's site on the nginx edge, for {@link nginxSite}. */
export interface NginxSite {
  app: string;
  /** `tunnel`: plain HTTP behind a Cloudflare Tunnel; `direct`: nginx serves HTTPS itself. */
  mode: "tunnel" | "direct";
  hosts: readonly string[];
  /** `direct` mode: the hostnames among `hosts` served with the app's Cloudflare origin certificate. */
  origin?: readonly string[] | undefined;
  /** `client_max_body_size`, in MB (`app.maxBodyMb`). */
  maxBodyMb: number;
  /** The user's additions, included in every server that serves the app. */
  additions?: string | undefined;
  /**
   * The site before certbot's first certificate: the hostnames certbot serves are served over HTTP,
   * with the webroot, and the HTTPS server for them is left out.
   */
  beforeCertificate?: boolean;
  /** Cloudflare's IP ranges, for an app its proxy serves: the visitor's address comes from them. */
  realIpFrom?: readonly string[] | undefined;
  /**
   * The hostnames among `hosts` that only redirect to `https://<the first other host>` with the
   * path and query (308): `www.<domain>`. They keep their certificate, and with origin TLS the
   * client-certificate requirement.
   */
  redirects?: readonly string[] | undefined;
  /**
   * `direct` mode on this computer (the localhost target): every hostname is served with the leaf
   * certificate of OpsCrew's local CA from the app's TLS folder, and HTTP redirects to HTTPS on
   * `httpsPort`.
   */
  local?: { httpsPort: number } | undefined;
}

/** `hosts` split into those the site serves and those that redirect, and where they redirect. */
function byRedirect(site: NginxSite, hosts: readonly string[]) {
  const redirects = site.redirects ?? [];
  return {
    served: hosts.filter((host) => !redirects.includes(host)),
    moved: hosts.filter((host) => redirects.includes(host)),
    to: site.hosts.find((host) => !redirects.includes(host)),
  };
}

/**
 * The directives of a server that serves the app: the security headers (HSTS only with `hsts`,
 * HTTP/3's `Alt-Svc` only with `h3`), on every response nginx sends (`always`, as Caddy's
 * `handle_errors`); the body limit; the request to kamal-proxy with the hostname, the
 * `X-Forwarded-*` headers (the client's own `X-Forwarded-For` is replaced, as Caddy does),
 * WebSockets and 300 seconds per request, streamed both ways; then the user's additions, whose
 * blocks keep these headers (`add_header_inherit merge` in {@link NGINX_CONF}). With `realIpFrom`,
 * the client's address is the one Cloudflare's `CF-Connecting-IP` names on requests from those
 * ranges, so `$remote_addr`, `X-Forwarded-For` and the request zone use the visitor's.
 */
function serve(site: NginxSite, o: { hsts: boolean; h3: boolean }): string[] {
  const header = (name: string, value: string) => `\tadd_header ${name} "${value}" always;`;
  const realIp = site.realIpFrom ?? [];
  return [
    ...realIp.map((range) => `\tset_real_ip_from ${range};`),
    ...(realIp.length > 0 ? ["\treal_ip_header CF-Connecting-IP;"] : []),
    ...(o.hsts ? [header("Strict-Transport-Security", HSTS)] : []),
    ...BASELINE_HEADERS.map(([name, value]) => header(name, value)),
    ...(o.h3 ? [`\tadd_header Alt-Svc 'h3=":443"; ma=2592000' always;`] : []),
    `\tclient_max_body_size ${site.maxBodyMb}m;`,
    "\tproxy_http_version 1.1;",
    "\tproxy_set_header Host $host;",
    "\tproxy_set_header Upgrade $http_upgrade;",
    "\tproxy_set_header Connection $connection_upgrade;",
    "\tproxy_set_header X-Forwarded-For $remote_addr;",
    "\tproxy_set_header X-Forwarded-Proto $scheme;",
    "\tproxy_set_header X-Forwarded-Host $host;",
    "\tproxy_read_timeout 300s;",
    "\tproxy_send_timeout 300s;",
    "\tproxy_buffering off;",
    "\tproxy_request_buffering off;",
    "\tlocation / {",
    `\t\tproxy_pass http://${NGINX_UPSTREAM};`,
    "\t}",
    ...(site.additions === undefined
      ? []
      : [
          "\t# Your own additions (opscrew/proxy/additions.nginx).",
          `\tinclude ${site.additions};`,
        ]),
  ];
}

/** certbot's HTTP-01 challenges, from the webroot. */
const ACME_LOCATION = [
  "\tlocation /.well-known/acme-challenge/ {",
  `\t\troot ${ACME_WEBROOT};`,
  "\t}",
];

/**
 * The HTTP server of the hostnames among `hosts` that redirect: `before`, then a 308 to
 * `<scheme>://<domain>` with the path and query.
 */
function redirectedOverHttp(
  site: NginxSite,
  hosts: readonly string[],
  scheme: "http" | "https",
  before: readonly string[],
): string[] {
  const { moved, to } = byRedirect(site, hosts);
  if (moved.length === 0 || to === undefined) return [];
  return httpServer(moved.join(" "), [
    ...before,
    "\tlocation / {",
    `\t\treturn 308 ${scheme}://${to}$request_uri;`,
    "\t}",
  ]);
}

/** A `server` block on the HTTP port for `names`, with `body`. */
function httpServer(names: string, body: readonly string[]): string[] {
  return ["server {", `\tlisten ${NGINX_PORTS.http};`, `\tserver_name ${names};`, ...body, "}", ""];
}

/**
 * The HTTP server of `hosts` served over HTTPS (on `httpsPort`): certbot's challenges (with
 * `acme`), then a redirect.
 */
function redirectServer(hosts: readonly string[], acme: boolean, httpsPort = 443): string[] {
  return httpServer(hosts.join(" "), [
    ...(acme ? ACME_LOCATION : []),
    "\tlocation / {",
    `\t\treturn 308 https://$host${httpsPortSuffix(httpsPort)}$request_uri;`,
    "\t}",
  ]);
}

/**
 * The HTTPS server of `hosts` with the certificate lines `tls`, over TCP and QUIC (HTTP/3), with
 * HSTS. On this computer (`local`) over TCP only, since the edge publishes no UDP port there, and
 * without HSTS, which would hold the hostname to HTTPS in the browser on every port for a year.
 */
function tlsServer(site: NginxSite, hosts: readonly string[], tls: readonly string[]): string[] {
  const { served, moved, to } = byRedirect(site, hosts);
  const local = site.local !== undefined;
  const server = (names: readonly string[], body: readonly string[]) => [
    "server {",
    `\tlisten ${NGINX_PORTS.https} ssl;`,
    ...(local ? [] : [`\tlisten ${NGINX_PORTS.https} quic;`]),
    `\tserver_name ${names.join(" ")};`,
    ...tls,
    ...body,
    "}",
    "",
  ];
  return [
    ...(served.length > 0 ? server(served, serve(site, { hsts: !local, h3: !local })) : []),
    ...(moved.length > 0 && to !== undefined
      ? server(moved, [`\treturn 308 https://${to}$request_uri;`])
      : []),
  ];
}

/**
 * The servers of an app's site file on the nginx edge, after its request zone:
 * - `direct` with hostnames: those of `origin` get the origin certificate from
 *   `/srv/edge/tls/<app>` and accept only the client certificate Cloudflare presents for the app;
 *   the others get certbot's certificate, `--cert-name <app>`. Each group has an HTTP server that
 *   redirects to HTTPS, with certbot's challenges for the second;
 * - `direct` without hostnames (no domain yet): plain HTTP for every hostname;
 * - `direct` on this computer (`local`): the leaf certificate of OpsCrew's local CA from
 *   `tls/<app>` for every hostname, with an HTTP server that redirects to HTTPS;
 * - `tunnel`: plain HTTP for its hostnames, with HSTS, and visitors who used HTTP redirected by
 *   Cloudflare's `Cf-Visitor` header, as Caddy does.
 */
export function nginxSite(site: NginxSite): string[] {
  const zone = `limit_req_zone $binary_remote_addr zone=${nginxRequestZone(site.app)}:1m rate=10r/s;`;
  const lines = [
    `# Your additions can limit requests with \`limit_req zone=${nginxRequestZone(site.app)};\`.`,
    zone,
    "",
  ];
  if (site.mode === "tunnel") {
    return [
      ...lines,
      "# Served through a Cloudflare Tunnel: Cloudflare terminates TLS, nginx serves plain HTTP.",
      ...httpServer(byRedirect(site, site.hosts).served.join(" "), [
        "\tif ($http_cf_visitor ~ '\"http\"') {",
        "\t\treturn 308 https://$host$request_uri;",
        "\t}",
        ...serve(site, { hsts: true, h3: false }),
      ]),
      ...redirectedOverHttp(site, site.hosts, "https", []),
    ];
  }
  if (site.hosts.length === 0) {
    return [
      ...lines,
      "# No domain yet: every hostname is served over plain HTTP.",
      ...httpServer("~.", serve(site, { hsts: false, h3: false })),
    ];
  }
  const dir = nginxTlsDir(site.app);
  if (site.local !== undefined) {
    return [
      ...lines,
      ...redirectServer(site.hosts, false, site.local.httpsPort),
      ...tlsServer(site, site.hosts, [
        `\tssl_certificate ${dir}/${LOCALHOST_TLS.certificate};`,
        `\tssl_certificate_key ${dir}/${LOCALHOST_TLS.key};`,
      ]),
    ];
  }
  const { origin, others: certbot } = splitByOrigin(site.hosts, site.origin);
  const live = certbotLive(site.app);
  if (origin.length > 0) {
    lines.push(
      ...redirectServer(origin, false),
      ...tlsServer(site, origin, [
        `\tssl_certificate ${dir}/origin.pem;`,
        `\tssl_certificate_key ${dir}/origin.key;`,
        "\tssl_verify_client on;",
        `\tssl_client_certificate ${dir}/pull.pem;`,
      ]),
    );
  }
  if (certbot.length === 0) return lines;
  if (site.beforeCertificate) {
    const { served } = byRedirect(site, certbot);
    return [
      ...lines,
      "# HTTP only until certbot has the first certificate; the deploy then installs the HTTPS site.",
      ...(served.length === 0
        ? []
        : httpServer(served.join(" "), [
            ...ACME_LOCATION,
            ...serve(site, { hsts: false, h3: false }),
          ])),
      ...redirectedOverHttp(site, certbot, "http", ACME_LOCATION),
    ];
  }
  return [
    ...lines,
    ...redirectServer(certbot, true),
    ...tlsServer(site, certbot, [
      `\tssl_certificate ${live}/fullchain.pem;`,
      `\tssl_certificate_key ${live}/privkey.pem;`,
    ]),
  ];
}
