// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Compose and nginx syntax, not JavaScript templates.
import { sha256Hex } from "@opscrew/core";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { testCloudflare, testContext, testPlan } from "../__fixtures__/plans";
import { renderDeployment } from "../render";
import { type RuntimeContext, renderCaddyfile, renderEdgeSite } from "../runtime";
import { composeLiteral } from "../runtime/services";
import { TUNNEL_ORIGIN_PORT } from "../tunnel";
import {
  EDGE_PROXIES,
  EDGE_PROXY_KEY,
  EDGE_VERSION,
  EDGE_VERSION_KEY,
  renderEdgeCompose,
} from "./index";
import {
  CERTBOT_LOOP,
  certbotCertonly,
  certbotRenewBefore,
  NGINX_CONF,
  NGINX_LOOP,
  NGINX_UPSTREAM,
  RENEW_BEFORE_EXPIRY_DAYS,
} from "./nginx";

const ctx = testContext({ acmeEmail: "ops@example.com" });

/** `testPlan` named `name` on the nginx edge. */
function nginx(name: string, o: Parameters<typeof testPlan>[0] = {}): DeployPlan {
  const plan = testPlan(o);
  return DeployPlanSchema.parse({
    ...plan,
    app: { ...plan.app, name },
    target: { ...plan.target, edge: "nginx" },
  });
}

/** A proxied app with www, its two hostnames on the Cloudflare origin certificate. */
const shop = nginx("shop", { domain: "example.com", www: true });
const proxied: RuntimeContext = {
  ...ctx,
  originTls: { hostnames: ["example.com", "www.example.com"] },
  additions: true,
};
/** A DNS-only app, whose certificate comes from certbot. */
const blog = (() => {
  const plan = nginx("blog", { domain: "blog.example.com" });
  return DeployPlanSchema.parse({ ...plan, dns: { ...plan.dns, proxied: false } });
})();
const tunnelled = nginx("shop", { provider: "own", access: "tunnel", domain: "shop.example.com" });
const filtered = nginx("shop", { provider: "own", domain: "shop.example.com" });

type Service = Record<string, unknown> & { volumes?: string[]; ports?: string[] };
const edge = (plan: DeployPlan) =>
  parse(renderEdgeCompose(plan).content) as {
    services: Record<string, Service>;
    configs: Record<string, { content: string }>;
    volumes: Record<string, unknown>;
  } & Record<string, unknown>;

/** The site files of `plan` by name (`shop.conf`, `shop.http.conf`). */
const sites = (plan: DeployPlan, c: RuntimeContext) =>
  Object.fromEntries(
    renderEdgeSite(plan, c).map((file) => [file.path.split("/").pop() as string, file.content]),
  );

/** The `server` blocks of a site file. */
/** An HTTPS server that serves the app (not www's redirect to the domain). */
function serving(block: string): boolean {
  return block.includes("listen 8443 ssl;") && !/\treturn 308 https:\/\/[a-z]/.test(block);
}

const servers = (content: string) =>
  content
    .split(/\n(?=server \{\n)/)
    .filter((block) => block.startsWith("server {"))
    .map((block) => block.slice(0, block.indexOf("\n}\n") + 2));

/** The nginx edge's main configuration, as Compose hands it to nginx. */
const mainConf = (plan: DeployPlan) =>
  (edge(plan).configs["nginx-conf"]?.content ?? "").replaceAll("$$", "$");

describe("the nginx edge's Compose project", () => {
  const doc = edge(shop);

  it("runs nginx, certbot and kamal-proxy, stamped with its version and proxy", () => {
    expect(Object.keys(doc.services)).toEqual(["kamal-proxy", "nginx", "certbot"]);
    expect(Object.keys(doc).slice(0, 3)).toEqual(["name", EDGE_VERSION_KEY, EDGE_PROXY_KEY]);
    expect(doc[EDGE_PROXY_KEY]).toBe("nginx");
    expect(doc[EDGE_VERSION_KEY]).toBe(EDGE_VERSION);
    // The deploy reads it with sed, so it is one plain line, as the version.
    expect(renderEdgeCompose(shop).content).toContain(`\n${EDGE_PROXY_KEY}: nginx\n`);
    expect(edge(testPlan({ domain: "example.com" }))[EDGE_PROXY_KEY]).toBe("caddy");
  });

  it("runs nginx-unprivileged as the deploy user with an init, on 8080 and 8443", () => {
    const service = doc.services.nginx as Service;
    expect(service.image).toMatch(/^nginxinc\/nginx-unprivileged:1\.30\.\d+-alpine@sha256:/);
    expect(service.user).toBe(
      "${OPSCREW_DEPLOY_UID:?the OpsCrew deploy writes it to /srv/edge/.env}:${OPSCREW_DEPLOY_GID:?the OpsCrew deploy writes it to /srv/edge/.env}",
    );
    expect(service.init).toBe(true);
    expect(service.ports).toEqual(["80:8080", "443:8443", "443:8443/udp"]);
    expect(edge(filtered).services.nginx?.ports).toEqual([
      "0.0.0.0:80:8080",
      "0.0.0.0:443:8443",
      "0.0.0.0:443:8443/udp",
    ]);
    expect(edge(tunnelled).services.nginx?.ports).toEqual([`127.0.0.1:${TUNNEL_ORIGIN_PORT}:8080`]);
    expect(service.configs).toEqual([{ source: "nginx-conf", target: "/etc/nginx/nginx.conf" }]);
    expect(service.labels).toEqual({
      "dev.opscrew.nginx-conf-sha256": sha256Hex(NGINX_CONF),
    });
    expect(service.depends_on).toEqual(["kamal-proxy"]);
    expect(service).toMatchObject({ mem_limit: "64m", memswap_limit: "64m" });
  });

  it("runs certbot as the deploy user too, renewing through the webroot", () => {
    const service = doc.services.certbot as Service;
    expect(service.image).toMatch(/^certbot\/certbot:v\d+\.\d+\.\d+@sha256:/);
    expect(service.user).toBe(doc.services.nginx?.user);
    expect(service.init).toBe(true);
    expect(service.ports).toBeUndefined();
    expect(service.entrypoint).toEqual(["sh", "-c", composeLiteral(CERTBOT_LOOP)]);
  });

  it("keeps certbot's state, the webroot and the reload flag on the volumes letsencrypt, acme-webroot and reload", () => {
    expect(Object.keys(doc.volumes)).toEqual([
      "letsencrypt",
      "acme-webroot",
      "reload",
      "kamal-proxy-config",
    ]);
    expect(doc.services.nginx?.volumes).toEqual([
      "./sites:/etc/nginx/sites:ro",
      "./tls:/etc/nginx/tls:ro",
      "letsencrypt:/etc/letsencrypt:ro",
      "acme-webroot:/var/www/acme:ro",
      "reload:/var/www/reload",
    ]);
    expect(doc.services.certbot?.volumes).toEqual([
      "letsencrypt:/etc/letsencrypt",
      "acme-webroot:/var/www/acme",
      "reload:/var/www/reload",
    ]);
  });

  it("gives no container the Docker socket, any capability or new privileges", () => {
    expect(renderEdgeCompose(shop).content).not.toContain("docker.sock");
    for (const service of Object.values(doc.services)) {
      expect(service.cap_drop).toEqual(["ALL"]);
      expect(service.security_opt).toEqual(["no-new-privileges:true"]);
      expect(service.networks).toEqual(["opscrew-edge"]);
    }
  });

  it("reloads nginx after nginx -t when certbot's deploy hook leaves the flag, and is healthy once nginx runs", () => {
    const service = doc.services.nginx as Service;
    expect(service.entrypoint).toEqual(["sh", "-c", composeLiteral(NGINX_LOOP)]);
    expect(NGINX_LOOP).toContain(
      "  if [ -e /var/www/reload/flag ]; then\n    rm -f /var/www/reload/flag\n    if nginx -t -q; then nginx -s reload; fi\n  fi\n",
    );
    // A stop quits nginx gracefully; an exited nginx ends the container, which Docker restarts.
    expect(NGINX_LOOP).toContain(`trap 'kill -QUIT "$pid"; wait "$pid"; exit 0' TERM INT QUIT`);
    expect(NGINX_LOOP.endsWith("done\nexit 1")).toBe(true);
    // The pid file appears once nginx handles signals, so the deploy's reload never races it.
    expect(NGINX_LOOP.startsWith("rm -f /tmp/nginx.pid\n")).toBe(true);
    expect(service.healthcheck).toMatchObject({ test: ["CMD-SHELL", "test -s /tmp/nginx.pid"] });
  });

  it("is the same file for every app on a server with the same access mode", () => {
    expect(renderEdgeCompose(blog)).toEqual(renderEdgeCompose(shop));
  });
});

describe("nginx's main configuration", () => {
  const conf = mainConf(shop);

  it("offers TLS 1.2 and 1.3 with Mozilla's intermediate profile, version 6.0", () => {
    expect(conf).toContain(
      [
        "\tssl_protocols TLSv1.2 TLSv1.3;",
        "\tssl_ecdh_curve X25519MLKEM768:X25519:prime256v1:secp384r1;",
        "\tssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305;",
        "\tssl_prefer_server_ciphers off;",
        "\tssl_session_timeout 1d;",
        "\tssl_session_cache shared:opscrew_tls:10m;",
        "\tssl_session_tickets off;",
      ].join("\n"),
    );
    expect(conf).not.toMatch(/TLSv1(\.1)?[ ;]/);
  });

  it("shows no version, keeps no access log, and serves HTTP/2", () => {
    expect(conf).toContain("\n\tserver_tokens off;\n");
    expect(conf).toContain("\n\taccess_log off;\n");
    expect(conf).toContain("\n\thttp2 on;\n");
  });

  it("keeps the site's headers in blocks of the user's additions that add their own", () => {
    expect(conf).toContain("\n\tadd_header_inherit merge;\n");
  });

  it("refuses every hostname no app serves on 80 and 443, also over HTTP/3, before the apps' sites", () => {
    expect(conf).toContain(
      [
        "\tserver {",
        "\t\tlisten 8080 default_server;",
        "\t\tlisten 8443 ssl default_server;",
        "\t\tlisten 8443 quic reuseport default_server;",
        "\t\tssl_reject_handshake on;",
        "\t\treturn 444;",
        "\t}",
        "",
        "\tinclude /etc/nginx/sites/*.conf;",
      ].join("\n"),
    );
    expect(conf.match(/default_server/g)).toHaveLength(3);
    expect(conf.match(/reuseport/g)).toHaveLength(1);
  });

  it("finds kamal-proxy again in Docker's DNS, as one upstream never set aside", () => {
    expect(NGINX_UPSTREAM).toBe("kamal-proxy");
    expect(EDGE_PROXIES.nginx.upstream).toBe(NGINX_UPSTREAM);
    expect(conf).toContain(
      "\tresolver 127.0.0.11 valid=10s ipv6=off;\n\tupstream kamal-proxy {\n\t\tzone kamal-proxy 64k;\n\t\tserver kamal-proxy:80 resolve max_fails=0;\n\t}\n",
    );
    expect(conf).toContain("\tmap $http_upgrade $connection_upgrade {");
  });
});

describe("the app's site on nginx", () => {
  const ORIGIN_TLS = [
    "\tssl_certificate /etc/nginx/tls/shop/origin.pem;",
    "\tssl_certificate_key /etc/nginx/tls/shop/origin.key;",
    "\tssl_verify_client on;",
    "\tssl_client_certificate /etc/nginx/tls/shop/pull.pem;",
  ].join("\n");
  const HEADERS = [
    '\tadd_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;',
    '\tadd_header X-Content-Type-Options "nosniff" always;',
    '\tadd_header X-Frame-Options "SAMEORIGIN" always;',
    '\tadd_header Referrer-Policy "strict-origin-when-cross-origin" always;',
  ].join("\n");
  const PROXY = [
    "\tclient_max_body_size 100m;",
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
    "\t\tproxy_pass http://kamal-proxy;",
    "\t}",
  ].join("\n");

  it("is sites/<app>.conf with the app's request zone", () => {
    const [site] = renderEdgeSite(shop, proxied);
    expect(site?.path).toBe("opscrew/runtime/edge/sites/shop.conf");
    expect(site?.kind).toBe("runtime");
    expect(site?.content).toContain(
      "\nlimit_req_zone $binary_remote_addr zone=opscrew_shop:1m rate=10r/s;\n",
    );
    expect(sites(blog, ctx)["blog.conf"]).toContain("zone=opscrew_blog:1m");
  });

  it("serves proxied hostnames with the origin certificate and requires Cloudflare's client certificate", () => {
    const content = sites(shop, proxied)["shop.conf"] ?? "";
    expect(servers(content)).toHaveLength(3);
    expect(content).toContain(
      `server {\n\tlisten 8443 ssl;\n\tlisten 8443 quic;\n\tserver_name example.com;\n${ORIGIN_TLS}\n${HEADERS}\n`,
    );
    // www keeps the certificate and the client-certificate requirement, and only redirects.
    expect(content).toContain(
      `server {\n\tlisten 8443 ssl;\n\tlisten 8443 quic;\n\tserver_name www.example.com;\n${ORIGIN_TLS}\n\treturn 308 https://example.com$request_uri;\n}\n`,
    );
    expect(content).not.toContain("letsencrypt");
    expect(content).not.toContain("acme-challenge");
    // No certbot hostnames, so no site for before their certificate.
    expect(Object.keys(sites(shop, proxied))).toEqual(["shop.conf"]);
  });

  it("redirects www on certbot's certificate when only the domain has the origin certificate, also before the first one", () => {
    const files = sites(shop, { ...ctx, originTls: { hostnames: ["example.com"] } });
    for (const content of [files["shop.conf"] ?? "", files["shop.http.conf"] ?? ""]) {
      expect(content).not.toMatch(/server_name ;/);
    }
    expect(files["shop.conf"]).toContain(
      "\tserver_name www.example.com;\n\tssl_certificate /etc/letsencrypt/live/shop/fullchain.pem;\n\tssl_certificate_key /etc/letsencrypt/live/shop/privkey.pem;\n\treturn 308 https://example.com$request_uri;\n}\n",
    );
    expect(files["shop.http.conf"]).toContain(
      "\tserver_name www.example.com;\n\tlocation /.well-known/acme-challenge/ {\n\t\troot /var/www/acme;\n\t}\n\tlocation / {\n\t\treturn 308 http://example.com$request_uri;\n\t}\n}\n",
    );
  });

  it("serves DNS-only hostnames with certbot's certificate for the app, with its challenges on HTTP", () => {
    const content = sites(blog, ctx)["blog.conf"] ?? "";
    expect(content).toContain(
      [
        "server {",
        "\tlisten 8080;",
        "\tserver_name blog.example.com;",
        "\tlocation /.well-known/acme-challenge/ {",
        "\t\troot /var/www/acme;",
        "\t}",
        "\tlocation / {",
        "\t\treturn 308 https://$host$request_uri;",
        "\t}",
        "}",
      ].join("\n"),
    );
    expect(content).toContain(
      "\tserver_name blog.example.com;\n\tssl_certificate /etc/letsencrypt/live/blog/fullchain.pem;\n\tssl_certificate_key /etc/letsencrypt/live/blog/privkey.pem;\n",
    );
    expect(content).not.toContain("ssl_verify_client");
  });

  it("splits an app whose origin certificate covers only some hostnames", () => {
    const content =
      sites(shop, { ...ctx, originTls: { hostnames: ["example.com"] } })["shop.conf"] ?? "";
    expect(content).toContain(`\tserver_name example.com;\n${ORIGIN_TLS}\n`);
    expect(content).toContain(
      "\tserver_name www.example.com;\n\tssl_certificate /etc/letsencrypt/live/shop/fullchain.pem;\n",
    );
  });

  it("redirects HTTP to HTTPS for each known hostname", () => {
    for (const content of [sites(shop, proxied)["shop.conf"], sites(blog, ctx)["blog.conf"]]) {
      const http = servers(content ?? "").filter((block) => block.includes("listen 8080;"));
      expect(http.length).toBeGreaterThan(0);
      for (const block of http) {
        expect(block).toContain("\tlocation / {\n\t\treturn 308 https://$host$request_uri;\n\t}\n");
        expect(block).not.toContain("default_server");
      }
    }
  });

  it("repeats HSTS, the baseline headers and HTTP/3's Alt-Svc in every HTTPS server, with WebSockets, long requests and the plan's body limit", () => {
    const big = DeployPlanSchema.parse({ ...blog, app: { ...blog.app, maxBodyMb: 512 } });
    for (const content of [
      sites(shop, proxied)["shop.conf"],
      sites(shop, { ...ctx, originTls: { hostnames: ["example.com"] } })["shop.conf"],
      sites(blog, ctx)["blog.conf"],
    ]) {
      const tls = servers(content ?? "").filter(serving);
      expect(tls.length).toBeGreaterThan(0);
      for (const block of tls) {
        expect(block).toContain(
          `${HEADERS}\n\tadd_header Alt-Svc 'h3=":443"; ma=2592000' always;\n${PROXY}\n`,
        );
      }
    }
    expect(sites(big, ctx)["blog.conf"]).toContain("\tclient_max_body_size 512m;\n");
  });

  it("includes the user's additions inside each server that serves the app, after its own lines", () => {
    const INCLUDE =
      "\t}\n\t# Your own additions (opscrew/proxy/additions.nginx).\n\tinclude /etc/nginx/sites/shop.additions;\n}\n";
    const content = sites(shop, proxied)["shop.conf"] ?? "";
    expect(content.split(INCLUDE)).toHaveLength(2);
    const tls = servers(content).find((block) => block.includes("listen 8443 ssl;"));
    expect(`${tls}\n`.endsWith(INCLUDE)).toBe(true);
    expect(sites(shop, { ...proxied, additions: false })["shop.conf"]).not.toContain(
      "include /etc/nginx/sites",
    );
    expect(EDGE_PROXIES.nginx.additions).toBe("opscrew/proxy/additions.nginx");
  });

  it("serves certbot's hostnames over HTTP until their first certificate, in sites/<app>.http.conf", () => {
    const files = renderEdgeSite(blog, { ...ctx, additions: true });
    expect(files.map((file) => file.path)).toEqual([
      "opscrew/runtime/edge/sites/blog.conf",
      "opscrew/runtime/edge/sites/blog.http.conf",
    ]);
    const before = files[1]?.content ?? "";
    const [server] = servers(before);
    expect(servers(before)).toHaveLength(1);
    expect(server).toContain(
      "\tlisten 8080;\n\tserver_name blog.example.com;\n\tlocation /.well-known/acme-challenge/ {\n\t\troot /var/www/acme;\n\t}\n",
    );
    // The app, its headers (no HSTS over HTTP) and the user's additions; no redirect, no HTTPS.
    expect(server).toContain('\tadd_header X-Content-Type-Options "nosniff" always;\n');
    expect(server).toContain("\t\tproxy_pass http://kamal-proxy;\n");
    expect(server).toContain("\tinclude /etc/nginx/sites/blog.additions;\n");
    expect(before).not.toContain("Strict-Transport-Security");
    expect(before).not.toContain("return 308");
    expect(before).not.toContain("8443");
    expect(before).toContain("zone=opscrew_blog:1m");
  });

  it("keeps the proxied hostnames on HTTPS in the site before certbot's first certificate", () => {
    const before =
      sites(shop, { ...ctx, originTls: { hostnames: ["example.com"] } })["shop.http.conf"] ?? "";
    expect(before).toContain(`\tserver_name example.com;\n${ORIGIN_TLS}\n`);
    expect(before).toContain(
      "\tlisten 8080;\n\tserver_name www.example.com;\n\tlocation /.well-known",
    );
    expect(before).not.toContain("letsencrypt");
  });

  it("serves plain HTTP behind a tunnel, with HSTS, redirecting visitors who used HTTP", () => {
    const content = sites(tunnelled, proxied)["shop.conf"] ?? "";
    expect(Object.keys(sites(tunnelled, proxied))).toEqual(["shop.conf"]);
    expect(content).toContain(
      "server {\n\tlisten 8080;\n\tserver_name shop.example.com;\n\tif ($http_cf_visitor ~ '\"http\"') {\n\t\treturn 308 https://$host$request_uri;\n\t}\n",
    );
    expect(content).toContain(HEADERS);
    // No certificate: Cloudflare terminates TLS (FR-1409).
    expect(content).not.toMatch(/ssl_|8443|letsencrypt|Alt-Svc/);
  });

  it("serves every hostname over plain HTTP before the plan has a domain", () => {
    const content = sites(nginx("shop"), ctx)["shop.conf"] ?? "";
    expect(content).toContain("server {\n\tlisten 8080;\n\tserver_name ~.;\n");
    expect(content).not.toMatch(/ssl_|8443|Strict-Transport-Security/);
    expect(content).toContain(PROXY);
  });

  it("serves the same site behind OpsCrew's web filter as on OpsCrew's own servers", () => {
    expect(renderEdgeSite(filtered, ctx)).toEqual(
      renderEdgeSite(nginx("shop", { domain: "shop.example.com" }), ctx),
    );
  });

  it("never holds a certificate or a key", () => {
    for (const content of [
      ...Object.values(sites(shop, proxied)),
      ...Object.values(sites(blog, ctx)),
      renderEdgeCompose(shop).content,
    ]) {
      expect(content).not.toMatch(/-----BEGIN|PRIVATE KEY/);
    }
  });

  it("is what provision renders for the plan's proxy", () => {
    const paths = (plan: DeployPlan, c: RuntimeContext) =>
      renderDeployment(plan, c)
        .map((file) => file.path)
        .filter((path) => path.startsWith("opscrew/runtime/edge/"));
    expect(paths(blog, { ...ctx, cloudflare: testCloudflare() })).toEqual([
      "opscrew/runtime/edge/compose.yaml",
      "opscrew/runtime/edge/sites/blog.conf",
      "opscrew/runtime/edge/sites/blog.http.conf",
    ]);
    const caddy = testPlan({ domain: "example.com" });
    expect(renderEdgeSite(caddy, ctx)).toEqual([renderCaddyfile(caddy, ctx)]);
  });
});

describe("the visitor's address behind Cloudflare's proxy, on nginx", () => {
  const ranges = ["173.245.48.0/20", "2400:cb00::/32"];
  const REAL_IP =
    "\tset_real_ip_from 173.245.48.0/20;\n\tset_real_ip_from 2400:cb00::/32;\n\treal_ip_header CF-Connecting-IP;\n";

  it("takes it from CF-Connecting-IP on requests from Cloudflare, in every server that serves a proxied app", () => {
    const content = sites(shop, { ...proxied, cloudflareRanges: ranges })["shop.conf"] ?? "";
    const tls = servers(content).filter(serving);
    expect(tls.length).toBeGreaterThan(0);
    for (const block of tls) expect(block).toContain(REAL_IP);
    // Before its first certificate, a proxied app without the origin certificate is served on HTTP.
    const before = sites(shop, { ...ctx, cloudflareRanges: ranges })["shop.http.conf"] ?? "";
    expect(servers(before).find((block) => block.includes("proxy_pass"))).toContain(REAL_IP);
    // Redirects use no address.
    for (const block of servers(content).filter((b) => b.includes("return 308"))) {
      expect(block).not.toContain("set_real_ip_from");
    }
  });

  it("renders as before without the ranges, for an app Cloudflare does not proxy, and behind a tunnel", () => {
    expect(JSON.stringify(sites(shop, proxied))).not.toContain("real_ip");
    expect(sites(blog, { ...ctx, cloudflareRanges: ranges })).toEqual(sites(blog, ctx));
    expect(sites(tunnelled, { ...ctx, cloudflareRanges: ranges })).toEqual(sites(tunnelled, ctx));
    expect(sites(shop, { ...proxied, cloudflareRanges: [] })).toEqual(sites(shop, proxied));
    // nginx's main configuration has nothing of it: each app's site has its own.
    expect(renderEdgeCompose(shop, ranges)).toEqual(renderEdgeCompose(shop));
  });
});

describe("certbot", () => {
  it("gets the app's certificate through the webroot, as the deploy user, with the reload flag as its deploy hook", () => {
    expect(
      certbotCertonly("blog", ["blog.example.com", "www.blog.example.com"], "ops@example.com"),
    ).toBe(
      "certonly --config-dir /etc/letsencrypt --work-dir /tmp/certbot/work --logs-dir /tmp/certbot/logs --non-interactive --agree-tos --email 'ops@example.com' --keep-until-expiring --webroot --webroot-path /var/www/acme --cert-name blog --domains blog.example.com,www.blog.example.com --deploy-hook 'touch /var/www/reload/flag'",
    );
    expect(certbotCertonly("blog", ["blog.example.com"], undefined)).toContain(
      " --agree-tos --register-unsafely-without-email --keep-until-expiring ",
    );
  });

  it("renews every 12 hours with a random delay of up to an hour, waiting first so it never meets the deploy's certbot", () => {
    expect(CERTBOT_LOOP).toBe(
      [
        "trap 'exit 0' TERM INT",
        "while :; do",
        "  sleep $((43200 + RANDOM % 3600)) &",
        "  wait $!",
        "  certbot renew --config-dir /etc/letsencrypt --work-dir /tmp/certbot/work --logs-dir /tmp/certbot/logs --no-random-sleep-on-renew",
        "done",
      ].join("\n"),
    );
  });

  it("renews 45 days before expiry, written once at the top of the app's renewal file", () => {
    expect(RENEW_BEFORE_EXPIRY_DAYS).toBe(45);
    expect(certbotRenewBefore("blog")).toBe(
      `f=/etc/letsencrypt/renewal/blog.conf; if ! grep -q '^renew_before_expiry' "$f"; then { echo 'renew_before_expiry = 45 days'; cat "$f"; } > "$f.new" && mv "$f.new" "$f"; fi`,
    );
  });
});

describe("snapshots", () => {
  it("the nginx edge", () => {
    expect(renderEdgeCompose(shop).content).toMatchSnapshot();
  });

  it("a proxied app's site with origin TLS and its own additions", () => {
    expect(sites(shop, proxied)).toMatchSnapshot();
  });

  it("a DNS-only app's site, and before its first certificate", () => {
    expect(sites(blog, ctx)).toMatchSnapshot();
  });

  it("two apps: two site files, one edge", () => {
    expect(renderEdgeCompose(blog)).toEqual(renderEdgeCompose(shop));
    expect({ ...sites(shop, proxied), ...sites(blog, ctx) }).toMatchSnapshot();
  });
});
