// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Compose, OpenLiteSpeed and shell syntax, not JavaScript templates.
import { sha256Hex } from "@opscrew/core";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { testContext, testPlan } from "../__fixtures__/plans";
import { IMAGES } from "../pins";
import { certbotHosts, type RuntimeContext, renderEdgeSite } from "../runtime";
import { composeLiteral } from "../runtime/services";
import { TUNNEL_ORIGIN_PORT } from "../tunnel";
import { localhostPlan } from "./__fixtures__/localhost";
import {
  EDGE_PROXIES,
  EDGE_PROXY_KEY,
  EDGE_VERSION,
  EDGE_VERSION_KEY,
  renderEdgeCompose,
} from "./index";
import { CERTBOT_LOOP } from "./nginx";
import {
  OPENLITESPEED_CAPABILITIES,
  OPENLITESPEED_CATCH_ALL,
  OPENLITESPEED_CHECK,
  OPENLITESPEED_COMMAND,
  OPENLITESPEED_ERROR_PAGE,
  OPENLITESPEED_HEALTHCHECK,
  OPENLITESPEED_LOOP,
  OPENLITESPEED_RELOAD,
  OPENLITESPEED_UPSTREAM,
  type OpenLiteSpeedSite,
  openlitespeedAdditionsFile,
  openlitespeedCachePurge,
  openlitespeedConf,
  openlitespeedSite,
} from "./openlitespeed";

/** `testPlan` named `name` on the OpenLiteSpeed edge. */
function ols(name: string, o: Parameters<typeof testPlan>[0] = {}): DeployPlan {
  const plan = testPlan(o);
  return DeployPlanSchema.parse({
    ...plan,
    app: { ...plan.app, name },
    target: { ...plan.target, edge: "openlitespeed" },
  });
}

const shop = ols("shop", { domain: "example.com", www: true });
const tunnelled = ols("shop", { provider: "own", access: "tunnel", domain: "shop.example.com" });
const filtered = ols("shop", { provider: "own", domain: "shop.example.com" });

type Service = Record<string, unknown> & { volumes?: string[]; ports?: string[] };
const edge = (plan: DeployPlan) =>
  parse(renderEdgeCompose(plan).content) as {
    services: Record<string, Service>;
    configs: Record<string, { content: string }>;
    volumes: Record<string, unknown>;
  } & Record<string, unknown>;

/** A proxied app with www, both hostnames on its Cloudflare origin certificate, with additions. */
const PROXIED: OpenLiteSpeedSite = {
  app: "shop",
  mode: "direct",
  hosts: ["example.com", "www.example.com"],
  origin: ["example.com", "www.example.com"],
  redirects: ["www.example.com"],
  additions: {
    file: openlitespeedAdditionsFile("shop"),
    source: "opscrew/proxy/additions.openlitespeed",
  },
};
/** A DNS-only app on certbot's certificate. */
const BLOG: OpenLiteSpeedSite = { app: "blog", mode: "direct", hosts: ["blog.example.com"] };

/** The app's files as text, by name. */
const files = (site: OpenLiteSpeedSite) =>
  Object.fromEntries(
    Object.entries(openlitespeedSite(site)).map(([name, lines]) => [name, lines.join("\n")]),
  );
const vhconf = (site: OpenLiteSpeedSite) => files(site)[`${site.app}.vhconf`] ?? "";

/** certbot's challenges, by a pattern: the webroot's folder appears at the first challenge. */
const ACME_CONTEXT = String.raw`context exp:^/(\.well-known/acme-challenge/[^/]+)$ {`;

/** The rules of a virtual host's rewrite block, one per line. */
function rules(content: string): string[] {
  const start = content.indexOf("  rules                   <<<END_rules\n");
  const end = content.indexOf("  END_rules", start);
  if (start < 0) return [];
  return content.slice(start, end).split("\n").slice(1, -1);
}

describe("the OpenLiteSpeed edge's Compose project", () => {
  const doc = edge(shop);
  const service = doc.services.openlitespeed as Service;

  it("runs OpenLiteSpeed, certbot and kamal-proxy, stamped with its version and proxy", () => {
    expect(Object.keys(doc.services)).toEqual(["kamal-proxy", "openlitespeed", "certbot"]);
    expect(Object.keys(doc).slice(0, 3)).toEqual(["name", EDGE_VERSION_KEY, EDGE_PROXY_KEY]);
    expect(doc[EDGE_VERSION_KEY]).toBe(EDGE_VERSION);
    // The deploy reads it with sed, so it is one plain line, as the version.
    expect(renderEdgeCompose(shop).content).toContain(`\n${EDGE_PROXY_KEY}: openlitespeed\n`);
    expect(renderEdgeCompose(shop).content).toContain(
      "# every OpsCrew app there: OpenLiteSpeed, certbot and kamal-proxy.",
    );
  });

  it("runs the pinned image under Docker's init with OpsCrew's loop, on 80 and 443", () => {
    expect(service.image).toBe(IMAGES.openlitespeed.ref);
    expect(IMAGES.openlitespeed.ref).toMatch(
      /^litespeedtech\/openlitespeed:1\.9\.4-lsphp84@sha256:84b5a648789f0c4ba1da9ffe3cb3ba79ae30a9c5c95f1e6a7f9302f8b273f2f8$/,
    );
    expect(service.init).toBe(true);
    expect(service.user).toBeUndefined();
    expect(service.entrypoint).toEqual(["sh", "-c", composeLiteral(OPENLITESPEED_LOOP)]);
    expect(service.ports).toEqual(["80:80", "443:443", "443:443/udp"]);
    expect(edge(filtered).services.openlitespeed?.ports).toEqual([
      "0.0.0.0:80:80",
      "0.0.0.0:443:443",
      "0.0.0.0:443:443/udp",
    ]);
    expect(edge(tunnelled).services.openlitespeed?.ports).toEqual([
      `127.0.0.1:${TUNNEL_ORIGIN_PORT}:80`,
    ]);
    expect(service.depends_on).toEqual(["kamal-proxy"]);
    expect(service).toMatchObject({ mem_limit: "128m", memswap_limit: "128m" });
    expect(service.healthcheck).toEqual(OPENLITESPEED_HEALTHCHECK);
  });

  it("mounts its configuration, catch-all, error page and scripts, the sites and the certificates read-only", () => {
    expect(service.configs).toEqual([
      { source: "openlitespeed-conf", target: "/etc/opscrew/httpd_config.conf" },
      { source: "openlitespeed-catchall", target: "/etc/opscrew/catchall.conf" },
      { source: "openlitespeed-error", target: "/etc/opscrew/error.html" },
      { source: "openlitespeed-check", target: "/etc/opscrew/check.sh" },
      { source: "openlitespeed-reload", target: "/etc/opscrew/reload.sh" },
    ]);
    expect(doc.configs).toEqual({
      "openlitespeed-conf": { content: composeLiteral(openlitespeedConf(false)) },
      "openlitespeed-catchall": { content: composeLiteral(OPENLITESPEED_CATCH_ALL) },
      "openlitespeed-error": { content: composeLiteral(OPENLITESPEED_ERROR_PAGE) },
      "openlitespeed-check": { content: composeLiteral(OPENLITESPEED_CHECK) },
      "openlitespeed-reload": { content: composeLiteral(OPENLITESPEED_RELOAD) },
    });
    // Every app's deploy runs the scripts of the edge the server has.
    expect(OPENLITESPEED_COMMAND).toEqual({
      check: "sh /etc/opscrew/check.sh",
      reload: "sh /etc/opscrew/reload.sh",
    });
    expect(service.labels).toEqual({
      "dev.opscrew.openlitespeed-conf-sha256": sha256Hex(
        [
          openlitespeedConf(false),
          OPENLITESPEED_CATCH_ALL,
          OPENLITESPEED_ERROR_PAGE,
          OPENLITESPEED_CHECK,
          OPENLITESPEED_RELOAD,
        ].join("\n"),
      ),
    });
    expect(service.volumes).toEqual([
      "./sites:/etc/opscrew/sites:ro",
      "./tls:/etc/opscrew/tls:ro",
      "letsencrypt:/etc/letsencrypt:ro",
      "acme-webroot:/var/www/acme:ro",
      "reload:/var/www/reload",
    ]);
    expect(Object.keys(doc.volumes)).toEqual([
      "letsencrypt",
      "acme-webroot",
      "reload",
      "kamal-proxy-config",
    ]);
  });

  it("runs certbot as nginx's edge does", () => {
    const certbot = doc.services.certbot as Service;
    const nginx = DeployPlanSchema.parse({ ...shop, target: { ...shop.target, edge: "nginx" } });
    expect(certbot).toEqual(edge(nginx).services.certbot);
    expect(certbot.entrypoint).toEqual(["sh", "-c", composeLiteral(CERTBOT_LOOP)]);
  });

  it("keeps OpenLiteSpeed's main process to the capabilities it uses, with no new privileges", () => {
    expect(renderEdgeCompose(shop).content).not.toContain("docker.sock");
    expect(service.cap_drop).toEqual(["ALL"]);
    expect(service.cap_add).toEqual([
      "CHOWN",
      "DAC_OVERRIDE",
      "FOWNER",
      "KILL",
      "NET_BIND_SERVICE",
      "SETGID",
      "SETUID",
    ]);
    expect(OPENLITESPEED_CAPABILITIES).not.toContain("NET_RAW");
    for (const s of Object.values(doc.services)) {
      expect(s.security_opt).toEqual(["no-new-privileges:true"]);
      expect(s.networks).toEqual(["opscrew-edge"]);
    }
  });

  it("trusts Cloudflare's ranges for the visitor's address, never on this computer", () => {
    const ranges = ["173.245.48.0/20", "2400:cb00::/32"];
    const conf = (plan: DeployPlan) =>
      (parse(renderEdgeCompose(plan, ranges).content) as ReturnType<typeof edge>).configs[
        "openlitespeed-conf"
      ]?.content;
    expect(conf(shop)).toBe(composeLiteral(openlitespeedConf(false, ranges)));
    expect(conf(localhostPlan({ edge: "openlitespeed" }))).toBe(
      composeLiteral(openlitespeedConf(true)),
    );
  });

  it("is the same file for every app on a server with the same access mode", () => {
    expect(renderEdgeCompose(ols("blog", { domain: "blog.example.com" }))).toEqual(
      renderEdgeCompose(shop),
    );
  });

  it("on this computer has no certbot and no HTTP/3, and listens on 127.0.0.1", () => {
    const local = edge(
      localhostPlan({ edge: "openlitespeed", ports: { https: 8443, http: 8080 } }),
    );
    expect(Object.keys(local.services)).toEqual(["kamal-proxy", "openlitespeed"]);
    expect(local.services.openlitespeed?.ports).toEqual([
      "127.0.0.1:8080:80",
      "127.0.0.1:8443:443",
    ]);
    expect(local.services.openlitespeed?.volumes).toEqual([
      "./sites:/etc/opscrew/sites:ro",
      "./tls:/etc/opscrew/tls:ro",
    ]);
    expect(local.volumes).toEqual({ "kamal-proxy-config": {} });
    expect(local.configs["openlitespeed-conf"]?.content).toBe(
      composeLiteral(openlitespeedConf(true)),
    );
    expect(openlitespeedConf(true)).toContain("\n  quicEnable              0\n");
    expect(openlitespeedConf(true)).not.toContain("quicShmDir");
  });
});

describe("OpenLiteSpeed's main configuration", () => {
  const conf = openlitespeedConf(false);

  it("names no version, has no admin console, logs errors to a file and keeps no access log", () => {
    expect(conf).toContain("\nshowVersionNumber         2\n");
    expect(conf).toContain("\ndisableWebAdmin           1\n");
    expect(conf).toContain(
      "\nerrorlog /usr/local/lsws/logs/error.log {\n  logLevel                NOTICE\n",
    );
    expect(conf).toContain("\naccessLog /dev/null {\n");
    expect(conf).not.toContain("7080");
    expect(conf).not.toContain("adminListener");
  });

  it("takes the visitor's address from CF-Connecting-IP only from Cloudflare's ranges", () => {
    expect(conf).not.toContain("useIpInProxyHeader");
    expect(conf).toContain("\naccessControl {\n  allow                   ALL\n}\n");
    const trusted = openlitespeedConf(false, ["173.245.48.0/20", "2400:cb00::/32"]);
    expect(trusted).toContain(
      "\n# Requests from Cloudflare's addresses (marked T below) carry the visitor's in CF-Connecting-IP.\nuseIpInProxyHeader        2\n",
    );
    expect(trusted).toContain(
      "\naccessControl {\n  allow                   ALL, 173.245.48.0/20T, 2400:cb00::/32T\n}\n",
    );
  });

  it("gives every request up to 300 seconds, and graceful restarts as long for open connections", () => {
    expect(conf).toContain("\n  connTimeout             300\n");
    expect(conf).toContain("\ngracefulRestartTimeout    300\n");
    expect(conf).toContain("\n  quicEnable              1\n");
  });

  it("keeps the page cache off, in its own folder", () => {
    expect(conf).toContain(
      [
        "module cache {",
        "  ls_enabled              1",
        "  enableCache             0",
        "  enablePrivateCache      0",
        "  storagePath             /usr/local/lsws/cachedata",
        "}",
      ].join("\n"),
    );
  });

  it("offers TLS 1.2 and 1.3 with Mozilla's intermediate ciphers behind a placeholder certificate", () => {
    expect(conf).toContain(
      [
        "listener HTTPS {",
        "  address                 *:443",
        "  secure                  1",
        "  keyFile                 /usr/local/lsws/conf/default.invalid.key",
        "  certFile                /usr/local/lsws/conf/default.invalid.pem",
        "  certChain               1",
        "  sslProtocol             24",
        "  enableECDHE             1",
        "  ciphers                 ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305",
      ].join("\n"),
    );
  });

  it("loads the apps' virtual hosts, and maps their hostnames, then every other one to the catch-all", () => {
    expect(conf).toContain("\ninclude /usr/local/lsws/conf/sites/*.vhost\n");
    expect(conf).toContain(
      "\nvirtualHost _catchall {\n  vhRoot                  /var/www/\n  configFile              /usr/local/lsws/conf/catchall.conf\n}\n",
    );
    for (const name of ["HTTP", "HTTPS"]) {
      const listener = conf.slice(conf.indexOf(`listener ${name} {`));
      expect(listener).toMatch(
        /\n {2}include \/usr\/local\/lsws\/conf\/sites\/\*\.map\n {2}map {21}_catchall \*\n\}/,
      );
    }
    expect(conf.match(/^listener /gm)).toHaveLength(2);
  });

  it("answers every hostname no app serves with 403 and OpsCrew's error page", () => {
    expect(OPENLITESPEED_CATCH_ALL).toContain(
      "errorPage 403 {\n  url                     /opscrew-error.html\n}",
    );
    expect(rules(OPENLITESPEED_CATCH_ALL)).toEqual([
      "RewriteRule ^/opscrew-error\\.html$ - [L]",
      "RewriteRule ^ - [F]",
    ]);
    expect(OPENLITESPEED_ERROR_PAGE).not.toMatch(/litespeed/i);
  });
});

describe("the app's site on OpenLiteSpeed", () => {
  it("is <app>.vhost, <app>.map and <app>.vhconf, one virtual host named after the app", () => {
    const site = files(PROXIED);
    expect(Object.keys(site)).toEqual(["shop.vhost", "shop.map", "shop.vhconf"]);
    expect(site["shop.vhost"]).toBe(
      "virtualHost shop {\n  vhRoot                  /var/www/\n  configFile              /usr/local/lsws/conf/sites/shop.vhconf\n}\n",
    );
    expect(site["shop.map"]).toBe("map shop example.com, www.example.com\n");
    expect(EDGE_PROXIES.openlitespeed).toEqual({
      label: "OpenLiteSpeed",
      site: "vhconf",
      upstream: OPENLITESPEED_UPSTREAM,
    });
  });

  it("sends the app's traffic and its WebSockets to kamal-proxy, with the headers on every answer", () => {
    const content = vhconf(BLOG);
    expect(content).toContain(
      "extprocessor kamal-proxy {\n  type                    proxy\n  address                 kamal-proxy:80\n",
    );
    expect(content).toContain(
      [
        "context / {",
        "  type                    proxy",
        "  handler                 kamal-proxy",
        "  addDefaultCharset       off",
        "  extraHeaders            <<<END_extraHeaders",
        'Header set Strict-Transport-Security "max-age=31536000; includeSubDomains"',
        'Header set X-Content-Type-Options "nosniff"',
        'Header set X-Frame-Options "SAMEORIGIN"',
        'Header set Referrer-Policy "strict-origin-when-cross-origin"',
        "RequestHeader unset X-Forwarded-For",
        "RequestHeader unset X-Forwarded-Host",
        "RequestHeader unset X-Forwarded-Proto",
        "  END_extraHeaders",
        "}",
      ].join("\n"),
    );
    expect(content).toContain("websocket / {\n  address                 kamal-proxy:80\n}");
    expect(content).toContain("\n  respBuffer              0\n");
  });

  it("shows OpsCrew's error page for the errors OpenLiteSpeed answers itself", () => {
    const content = vhconf(BLOG);
    for (const code of [400, 403, 404, 405, 408, 413, 500, 502, 503, 504]) {
      expect(content).toContain(
        `errorPage ${code} {\n  url                     /opscrew-error.html\n}`,
      );
    }
    expect(content).toContain(
      "context /opscrew-error.html {\n  location                /var/www/opscrew/opscrew-error.html\n",
    );
    expect(rules(content)[0]).toBe("RewriteRule ^/opscrew-error\\.html$ - [L]");
  });

  it("serves proxied hostnames with the origin certificate and requires Cloudflare's client certificate", () => {
    const content = vhconf(PROXIED);
    expect(content).toContain(
      [
        "vhssl {",
        "  certFile                /etc/opscrew/tls/shop/origin.pem",
        "  keyFile                 /etc/opscrew/tls/shop/origin.key",
        "  clientVerify            2",
        "  verifyDepth             1",
        "  CACertFile              /etc/opscrew/tls/shop/pull.pem",
        "  certChain               1",
        "  sslProtocol             24",
        "  enableECDHE             1",
      ].join("\n"),
    );
    expect(content).not.toContain("letsencrypt");
    expect(content).not.toContain("acme-challenge");
    expect(rules(content)).toEqual([
      "RewriteRule ^/opscrew-error\\.html$ - [L]",
      "RewriteCond %{HTTP_HOST} !^(example\\.com|www\\.example\\.com)(:[0-9]+)?$ [NC]",
      "RewriteRule ^ - [F]",
      "RewriteCond %{HTTPS} !on",
      "RewriteRule ^(.*)$ https://%{HTTP_HOST}$1 [R=308,L]",
      "RewriteCond %{HTTP_HOST} ^www\\.example\\.com(:[0-9]+)?$ [NC]",
      "RewriteRule ^(.*)$ https://example.com$1 [R=308,L]",
    ]);
  });

  it("serves DNS-only hostnames with certbot's certificate, with its challenges on HTTP", () => {
    const content = vhconf(BLOG);
    expect(content).toContain(
      "vhssl {\n  certFile                /etc/letsencrypt/live/blog/fullchain.pem\n  keyFile                 /etc/letsencrypt/live/blog/privkey.pem\n",
    );
    expect(content).toContain(`${ACME_CONTEXT}\n  location                /var/www/acme/$1\n`);
    expect(rules(content).slice(3)).toEqual([
      "RewriteCond %{HTTPS} !on",
      "RewriteCond %{REQUEST_URI} !^/\\.well-known/acme-challenge/",
      "RewriteRule ^(.*)$ https://%{HTTP_HOST}$1 [R=308,L]",
    ]);
  });

  it("serves both hostnames with the origin certificate when only one has it: one virtual host serves both", () => {
    const content = vhconf({ ...PROXIED, origin: ["example.com"] });
    expect(content).toContain("  clientVerify            2\n");
    expect(content).toContain("  certFile                /etc/opscrew/tls/shop/origin.pem\n");
    expect(content).toContain(ACME_CONTEXT);
    expect(files({ ...PROXIED, origin: ["example.com"] })["shop.map"]).toBe(
      "map shop example.com, www.example.com\n",
    );
  });

  it("serves certbot's hostnames over HTTP until their first certificate, refusing HTTPS", () => {
    const content = vhconf({ ...BLOG, beforeCertificate: true });
    expect(content).not.toContain("vhssl");
    expect(content).not.toContain("Strict-Transport-Security");
    expect(content).toContain(ACME_CONTEXT);
    expect(rules(content).slice(3)).toEqual(["RewriteCond %{HTTPS} on", "RewriteRule ^ - [F]"]);
    const www = vhconf({
      ...BLOG,
      hosts: ["blog.example.com", "www.blog.example.com"],
      redirects: ["www.blog.example.com"],
      beforeCertificate: true,
    });
    expect(rules(www).slice(-3)).toEqual([
      "RewriteCond %{HTTP_HOST} ^www\\.blog\\.example\\.com(:[0-9]+)?$ [NC]",
      "RewriteCond %{REQUEST_URI} !^/\\.well-known/acme-challenge/",
      "RewriteRule ^(.*)$ http://blog.example.com$1 [R=308,L]",
    ]);
  });

  it("refuses a hostname it does not serve, which OpenLiteSpeed maps with its www twin", () => {
    expect(rules(vhconf(BLOG)).slice(1, 3)).toEqual([
      "RewriteCond %{HTTP_HOST} !^(blog\\.example\\.com)(:[0-9]+)?$ [NC]",
      "RewriteRule ^ - [F]",
    ]);
  });

  it("serves plain HTTP behind a tunnel, with HSTS, redirecting visitors who used HTTP", () => {
    const content = vhconf({ app: "shop", mode: "tunnel", hosts: ["shop.example.com"] });
    expect(content).not.toContain("vhssl");
    expect(content).toContain(
      'Header set Strict-Transport-Security "max-age=31536000; includeSubDomains"',
    );
    expect(rules(content).slice(3)).toEqual([
      "RewriteCond %{HTTP:Cf-Visitor} :.http[^s]",
      "RewriteRule ^(.*)$ https://%{HTTP_HOST}$1 [R=308,L]",
    ]);
  });

  it("serves every hostname over plain HTTP before the plan has a domain, refusing HTTPS", () => {
    const site = files({ app: "shop", mode: "direct", hosts: [] });
    expect(site["shop.map"]).toBe("map shop *\n");
    expect(site["shop.vhconf"]).not.toContain("vhssl");
    expect(site["shop.vhconf"]).not.toContain("Strict-Transport-Security");
    expect(rules(site["shop.vhconf"] ?? "")).toEqual([
      "RewriteRule ^/opscrew-error\\.html$ - [L]",
      "RewriteCond %{HTTPS} on",
      "RewriteRule ^ - [F]",
    ]);
  });

  it("serves this computer's hostname with the local CA's leaf, redirecting to the HTTPS port, without HSTS", () => {
    const content = vhconf({
      app: "shop",
      mode: "direct",
      hosts: ["shop.localhost"],
      local: { httpsPort: 8443 },
    });
    expect(content).toContain(
      "vhssl {\n  certFile                /etc/opscrew/tls/shop/local.pem\n  keyFile                 /etc/opscrew/tls/shop/local.key\n",
    );
    expect(content).not.toContain("Strict-Transport-Security");
    expect(rules(content).slice(3)).toEqual([
      "RewriteCond %{HTTPS} !on",
      "RewriteRule ^(.*)$ https://shop.localhost:8443$1 [R=308,L]",
    ]);
  });

  it("keeps the app's page cache off, in a folder of its own", () => {
    expect(vhconf(BLOG)).toContain(
      [
        "module cache {",
        "  ls_enabled              1",
        "  param                   <<<END_param",
        "enableCache             0",
        "enablePrivateCache      0",
        "storagePath             /usr/local/lsws/cachedata/blog",
        "  END_param",
        "}",
      ].join("\n"),
    );
  });

  it("includes the user's additions at the end of the virtual host", () => {
    const content = vhconf(PROXIED);
    expect(
      content.endsWith(
        "# Your own additions (opscrew/proxy/additions.openlitespeed).\ninclude /usr/local/lsws/conf/sites/shop.additions\n",
      ),
    ).toBe(true);
    expect(vhconf(BLOG)).not.toContain("additions");
  });

  it("never holds a certificate or a key", () => {
    for (const site of [PROXIED, BLOG]) {
      expect(Object.values(files(site)).join("\n")).not.toContain("BEGIN");
    }
  });
});

describe("the app's site files on OpenLiteSpeed, as renderEdgeSite writes them", () => {
  const ctx = testContext({ acmeEmail: "ops@example.com" });
  /** A DNS-only app, whose certificate comes from certbot. */
  const blog = (() => {
    const plan = ols("blog", { domain: "blog.example.com" });
    return DeployPlanSchema.parse({ ...plan, dns: { ...plan.dns, proxied: false } });
  })();
  const named = (plan: DeployPlan, c: RuntimeContext) =>
    Object.fromEntries(
      renderEdgeSite(plan, c).map((file) => [file.path.split("/").pop() as string, file.content]),
    );

  it("are <app>.vhconf first, <app>.vhost and <app>.map, each saying where it comes from", () => {
    const origin = { ...ctx, originTls: { hostnames: ["example.com", "www.example.com"] } };
    const files = renderEdgeSite(shop, origin);
    expect(files.map((file) => [file.path, file.kind])).toEqual([
      ["opscrew/runtime/edge/sites/shop.vhconf", "runtime"],
      ["opscrew/runtime/edge/sites/shop.vhost", "runtime"],
      ["opscrew/runtime/edge/sites/shop.map", "runtime"],
    ]);
    const site = openlitespeedSite({
      app: "shop",
      mode: "direct",
      hosts: ["example.com", "www.example.com"],
      origin: ["example.com", "www.example.com"],
      redirects: ["www.example.com"],
      beforeCertificate: false,
    });
    for (const file of files) {
      const name = file.path.split("/").pop() as string;
      expect(file.content).toBe(
        [
          "# Generated by OpsCrew from opscrew/plan.yaml; `opscrew provision` regenerates it.",
          `# shop's site on the server's shared edge (OpenLiteSpeed): the deploy copies it to /srv/edge/sites/${name}.`,
          ...(site[name] ?? []),
        ].join("\n"),
      );
    }
  });

  it("include the user's additions from additions.openlitespeed", () => {
    const vhconf = named(shop, { ...ctx, additions: true })["shop.vhconf"] ?? "";
    expect(vhconf).toContain(
      "# Your own additions (opscrew/proxy/additions.openlitespeed).\ninclude /usr/local/lsws/conf/sites/shop.additions\n",
    );
  });

  it("serve certbot's hostnames over HTTP until their first certificate, in <app>.http.vhconf alone", () => {
    const files = named(blog, ctx);
    expect(Object.keys(files)).toEqual([
      "blog.vhconf",
      "blog.vhost",
      "blog.map",
      "blog.http.vhconf",
    ]);
    expect(certbotHosts(blog, ctx)).toEqual(["blog.example.com"]);
    expect(files["blog.vhconf"]).toContain("/etc/letsencrypt/live/blog/fullchain.pem");
    const before = files["blog.http.vhconf"] ?? "";
    expect(before).toContain(
      "# blog's site on the server's shared edge (OpenLiteSpeed): the deploy copies it to /srv/edge/sites/blog.vhconf.",
    );
    expect(before).not.toContain("vhssl");
    expect(before).toContain("RewriteCond %{HTTPS} on\nRewriteRule ^ - [F]");
  });

  it("get no certbot certificate behind a tunnel, for proxied hostnames on the origin certificate, or on this computer", () => {
    const tunnelCtx = { ...ctx, originTls: { hostnames: ["shop.example.com"] } };
    expect(Object.keys(named(tunnelled, tunnelCtx))).toEqual([
      "shop.vhconf",
      "shop.vhost",
      "shop.map",
    ]);
    expect(certbotHosts(tunnelled, tunnelCtx)).toEqual([]);
    expect(
      certbotHosts(shop, { ...ctx, originTls: { hostnames: ["example.com", "www.example.com"] } }),
    ).toEqual([]);
    const local = localhostPlan({ edge: "openlitespeed", ports: { https: 8443, http: 8080 } });
    const localCtx = { ...ctx, localhost: { hostname: "shop.localhost" } };
    const files = named(local, localCtx);
    expect(Object.keys(files)).toEqual(["shop.vhconf", "shop.vhost", "shop.map"]);
    expect(certbotHosts(local, localCtx)).toEqual([]);
    expect(files["shop.vhconf"]).toContain(
      "# shop's site on this computer's shared edge (OpenLiteSpeed): the local deploy copies it to the edge's sites.",
    );
    expect(files["shop.vhconf"]).toContain(
      "  certFile                /etc/opscrew/tls/shop/local.pem\n",
    );
    expect(files["shop.vhconf"]).toContain("https://shop.localhost:8443$1 [R=308,L]");
    expect(files["shop.map"]).toContain("map shop shop.localhost\n");
  });
});

describe("the check, the graceful restart and the cache purge", () => {
  it("checks a copy of the configuration and the sites, with OpenLiteSpeed's work folder made first", () => {
    for (const line of [
      "  mkdir -p /tmp/lshttpd /var/www/opscrew",
      "  cp /etc/opscrew/httpd_config.conf /usr/local/lsws/conf/httpd_config.conf",
      "  cp /etc/opscrew/catchall.conf /usr/local/lsws/conf/catchall.conf",
      "  cat /etc/opscrew/error.html > /var/www/opscrew/opscrew-error.html",
      "  cp -R /etc/opscrew/sites /usr/local/lsws/conf/sites",
    ]) {
      expect(OPENLITESPEED_CHECK).toContain(`\n${line}\n`);
    }
    expect(OPENLITESPEED_CHECK.endsWith("\nlocked check")).toBe(true);
  });

  it("holds one lock for every check and restart, so a deploy's and a renewal's never overlap", () => {
    expect(OPENLITESPEED_CHECK).toContain(
      '\nlocked() { mkdir -p /tmp/lshttpd; ( flock 9 && "$@" ) 9> /tmp/lshttpd/opscrew.lock; }\n',
    );
    for (const script of [OPENLITESPEED_CHECK, OPENLITESPEED_RELOAD, OPENLITESPEED_LOOP]) {
      const body = script.slice(script.indexOf("\nlocked() {"));
      expect(body.split("\n").slice(1).join("\n")).not.toMatch(/^\s*(check|restart|reload)\b/m);
    }
  });

  it("refuses a certificate or key the configuration names that is missing, and an error of openlitespeed -t", () => {
    expect(OPENLITESPEED_CHECK).toContain(
      `for f in $(awk '$1 == "certFile" || $1 == "keyFile" || $1 == "CACertFile" { print $2 }' /usr/local/lsws/conf/httpd_config.conf /usr/local/lsws/conf/sites/*.vhconf 2> /dev/null); do`,
    );
    expect(OPENLITESPEED_CHECK).toContain('  out="$(/usr/local/lsws/bin/openlitespeed -t 2>&1)"\n');
    expect(OPENLITESPEED_CHECK).toContain('  if [ "$status" -gt 1 ]; then\n');
  });

  it("restarts gracefully after the check only", () => {
    expect(OPENLITESPEED_RELOAD.endsWith("\nlocked reload")).toBe(true);
    expect(OPENLITESPEED_RELOAD).toContain("\nreload() { check && restart; }\n");
    expect(OPENLITESPEED_RELOAD).toContain('  kill -USR1 "$pid"\n');
  });

  it("starts only a configuration the check passes, restarts on certbot's flag, and stops on a signal", () => {
    expect(OPENLITESPEED_LOOP).toContain(
      "\nlocked check || exit 1\nrm -f /tmp/lshttpd/lshttpd.pid\n/usr/local/lsws/bin/openlitespeed\n",
    );
    expect(OPENLITESPEED_LOOP).toContain(
      "  if [ -e /var/www/reload/flag ]; then\n    rm -f /var/www/reload/flag\n    locked reload\n  fi\n",
    );
    expect(OPENLITESPEED_LOOP).toContain("\ntrap stop TERM INT QUIT\n");
    expect(OPENLITESPEED_LOOP.endsWith("done\nexit 1")).toBe(true);
    // The title is matched from its start: the loop's own command line names it too.
    expect(OPENLITESPEED_LOOP).toContain(
      "running() { pgrep -f '^openlitespeed \\(lshttpd - main\\)' > /dev/null; }",
    );
    expect(OPENLITESPEED_HEALTHCHECK.test).toEqual([
      "CMD-SHELL",
      "pgrep -f '^openlitespeed \\(lshttpd - main\\)' > /dev/null",
    ]);
  });

  it("purges only the app's cached answers", () => {
    expect(openlitespeedCachePurge("shop")).toBe(
      "if [ -d '/usr/local/lsws/cachedata/shop' ]; then find '/usr/local/lsws/cachedata/shop' -mindepth 1 -maxdepth 1 ! -name '.*' -exec rm -rf {} +; fi",
    );
  });
});

describe("snapshots", () => {
  it("the OpenLiteSpeed edge", () => {
    expect(renderEdgeCompose(shop).content).toMatchSnapshot();
  });

  it("the catch-all and the error page", () => {
    expect({
      catchAll: OPENLITESPEED_CATCH_ALL,
      errorPage: OPENLITESPEED_ERROR_PAGE,
    }).toMatchSnapshot();
  });

  it("a proxied app's site with origin TLS and its own additions", () => {
    expect(files(PROXIED)).toMatchSnapshot();
  });

  it("a DNS-only app's site, and before its first certificate", () => {
    expect({
      ...files(BLOG),
      "blog.http.vhconf": vhconf({ ...BLOG, beforeCertificate: true }),
    }).toMatchSnapshot();
  });
});
