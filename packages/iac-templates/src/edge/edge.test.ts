import { sha256Hex } from "@opscrew/core";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { testContext, testPlan } from "../__fixtures__/plans";
import { MODULE_FILES } from "../generated/modules";
import { IMAGES } from "../pins";
import {
  type RuntimeContext,
  renderCaddyfile,
  renderCompose,
  renderRuntimeFiles,
} from "../runtime";
import { CONNECTOR_MEMORY_MB, TUNNEL_ORIGIN_PORT } from "../tunnel";
import type { RenderedFile } from "../types";
import {
  EDGE_MEMORY_MB,
  EDGE_UPSTREAM,
  EDGE_VERSION,
  EDGE_VERSION_KEY,
  edgeMemoryMb,
  renderEdgeCompose,
} from "./index";

const ctx = testContext({ acmeEmail: "ops@example.com" });

/** `testPlan` named `name` (default `shop`). */
function named(name: string, o: Parameters<typeof testPlan>[0] = {}): DeployPlan {
  const plan = testPlan(o);
  return DeployPlanSchema.parse({ ...plan, app: { ...plan.app, name } });
}

const shop = named("shop", { domain: "example.com", www: true });
const blog = named("blog", { domain: "blog.example.com" });
const tunnelled = named("shop", { provider: "own", access: "tunnel", domain: "shop.example.com" });
/** An own server served directly behind Cloudflare's proxy, with OpsCrew's web filter. */
const filtered = named("shop", { provider: "own", domain: "shop.example.com" });

/** The edge's Compose file as the deploy uploads it (with the app's runtime files). */
function edgeFile(plan: DeployPlan): RenderedFile {
  const file = renderRuntimeFiles(plan).find((f) => f.path.startsWith("opscrew/runtime/edge/"));
  if (file === undefined) throw new Error("no edge file");
  return file;
}

type Service = Record<string, unknown> & { networks?: string[]; ports?: string[] };
const edge = (plan: DeployPlan) =>
  parse(renderEdgeCompose(plan).content) as {
    name: string;
    services: Record<string, Service>;
    configs: { caddyfile: { content: string } };
    networks: Record<string, unknown>;
    volumes: Record<string, unknown>;
  } & Record<string, unknown>;

describe("the edge's Compose project", () => {
  const doc = edge(shop);

  it("is rendered with the app's runtime files, into opscrew/runtime/edge", () => {
    expect(edgeFile(shop)).toEqual(renderEdgeCompose(shop));
    expect(edgeFile(shop).path).toBe("opscrew/runtime/edge/compose.yaml");
    expect(edgeFile(shop).kind).toBe("runtime");
  });

  it("runs pinned Caddy and kamal-proxy as opscrew-edge, both on the external network opscrew-edge", () => {
    expect(doc.name).toBe("opscrew-edge");
    expect(Object.keys(doc.services)).toEqual(["kamal-proxy", "caddy"]);
    expect(doc.services["kamal-proxy"]?.image).toBe(IMAGES.kamalProxy.ref);
    expect(doc.services.caddy?.image).toBe(IMAGES.caddy.ref);
    for (const service of Object.values(doc.services)) {
      expect(service.networks).toEqual(["opscrew-edge"]);
      expect(service.restart).toBe("unless-stopped");
      expect(service.security_opt).toEqual(["no-new-privileges:true"]);
      expect(service.logging).toEqual({
        driver: "json-file",
        options: { "max-size": "10m", "max-file": "3" },
      });
    }
    expect(doc.networks).toEqual({ "opscrew-edge": { external: true } });
  });

  it("limits the memory of Caddy (64 MB) and kamal-proxy (32 MB), without swap", () => {
    expect(doc.services.caddy).toMatchObject({ mem_limit: "64m", memswap_limit: "64m" });
    expect(doc.services["kamal-proxy"]).toMatchObject({ mem_limit: "32m", memswap_limit: "32m" });
  });

  it("keeps kamal-proxy's routes on a named volume, so they survive a recreate", () => {
    const proxy = doc.services["kamal-proxy"] as Service;
    expect(proxy.volumes).toEqual(["kamal-proxy-config:/home/kamal-proxy/.config/kamal-proxy"]);
    expect(proxy.ports).toBeUndefined();
    expect(proxy.cap_drop).toEqual(["ALL"]);
    expect(Object.keys(doc.volumes)).toEqual(["caddy_data", "caddy_config", "kamal-proxy-config"]);
  });

  it("has Caddy import every app's site file from /srv/edge/sites and proxy to kamal-proxy", () => {
    const caddy = doc.services.caddy as Service;
    expect(caddy.volumes).toEqual([
      "./sites:/etc/caddy/sites:ro",
      // The apps' origin certificates, /srv/edge/tls/<app>/.
      "./tls:/etc/caddy/tls:ro",
      "caddy_data:/data",
      "caddy_config:/config",
    ]);
    expect(caddy.configs).toEqual([{ source: "caddyfile", target: "/etc/caddy/Caddyfile" }]);
    expect(doc.configs.caddyfile.content).toContain("\nimport /etc/caddy/sites/*.caddy\n");
    // No global options. In particular no `auto_https ignore_loaded_certs`: with it Caddy would
    // also ask Let's Encrypt for the hostnames an origin certificate serves, and without it Caddy
    // skips only the names a loaded certificate covers, so every other hostname keeps its ACME
    // certificate (checked with the pinned Caddy, 2.11.7).
    expect(doc.configs.caddyfile.content).not.toMatch(/^\{/m);
    expect(doc.configs.caddyfile.content).not.toContain("auto_https");
    expect(caddy.labels).toEqual({
      "dev.opscrew.caddyfile-sha256": sha256Hex(doc.configs.caddyfile.content),
    });
    expect(caddy.depends_on).toEqual(["kamal-proxy"]);
    expect(EDGE_UPSTREAM).toBe("kamal-proxy:80");
  });

  it("refuses every hostname no app serves, on HTTP and HTTPS, after the apps' sites", () => {
    const content = doc.configs.caddyfile.content;
    // An unknown Host on port 80 or 443 is aborted (curl: empty reply); an unknown name in TLS
    // already fails the handshake, since no site has a certificate for it. With the origin
    // certificate's client authentication Caddy also answers 421 to a Host other than the name
    // the connection was made for. Checked against the pinned Caddy (2.11.7).
    expect(content).toContain(
      "\nimport /etc/caddy/sites/*.caddy\n\n# Requests for any other hostname are refused.\nhttp:// {\n\tabort\n}\nhttps:// {\n\tabort\n}\n",
    );
    // After the sites: Caddy runs the first of two sites without a hostname, and an app without a
    // domain yet is served on `:80` for every hostname.
    expect(content.indexOf("import ")).toBeLessThan(content.indexOf("http:// {"));
  });

  it("publishes Caddy's ports for the server's access mode", () => {
    expect(edge(shop).services.caddy?.ports).toEqual(["80:80", "443:443", "443:443/udp"]);
    // Behind OpsCrew's web filter (an own server behind Cloudflare's proxy): IPv4 only.
    expect(edge(filtered).services.caddy?.ports).toEqual([
      "0.0.0.0:80:80",
      "0.0.0.0:443:443",
      "0.0.0.0:443:443/udp",
    ]);
    // Tunnel mode: only the connector on the server's loopback reaches it.
    expect(edge(tunnelled).services.caddy?.ports).toEqual([`127.0.0.1:${TUNNEL_ORIGIN_PORT}:80`]);
  });

  it("carries its version stamp, OpsCrew's edge date and change number, right after its name", () => {
    expect(Object.keys(doc).slice(0, 2)).toEqual(["name", EDGE_VERSION_KEY]);
    expect(doc[EDGE_VERSION_KEY]).toBe(EDGE_VERSION);
    expect(String(EDGE_VERSION)).toMatch(/^20\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\d{2}$/);
    // The deploy reads it with sed, so it is one plain line.
    expect(renderEdgeCompose(shop).content).toContain(`\n${EDGE_VERSION_KEY}: ${EDGE_VERSION}\n`);
  });

  it("is the same file for every app on a server with the same access mode", () => {
    expect(renderEdgeCompose(blog)).toEqual(renderEdgeCompose(shop));
    expect(
      renderEdgeCompose(
        named("blog", { provider: "own", access: "tunnel", domain: "blog.example.com" }),
      ),
    ).toEqual(renderEdgeCompose(tunnelled));
  });

  it("changes only with a new version stamp", () => {
    // The edge's files in every access mode, without the stamp. When this hash changes, raise
    // EDGE_VERSION in src/edge/index.ts (today's date and change number) and put the new hash
    // here, so servers take the new edge: a deploy replaces the server's edge only with a newer one.
    // Both proxies' edges count.
    const nginx = (plan: DeployPlan) =>
      DeployPlanSchema.parse({ ...plan, target: { ...plan.target, edge: "nginx" } });
    const files = [shop, filtered, tunnelled, ...[shop, filtered, tunnelled].map(nginx)].map(
      (plan) =>
        renderEdgeCompose(plan).content.replace(`${EDGE_VERSION_KEY}: ${EDGE_VERSION}\n`, ""),
    );
    expect({ version: EDGE_VERSION, sha256: sha256Hex(files.join("\n")) }).toEqual({
      version: 2026102103,
      sha256: "425321a8f2f13b205d300a851b09b29f87f25325db43bdbddd423aa958ba0449",
    });
  });
});

describe("edgeMemoryMb", () => {
  it("adds up the edge's memory limits by proxy, with one tunnel connector", () => {
    for (const proxy of ["caddy", "nginx"] as const) {
      const plan = testPlan();
      const edge = DeployPlanSchema.parse({ ...plan, target: { ...plan.target, edge: proxy } });
      const services = parse(renderEdgeCompose(edge).content).services as Record<
        string,
        { mem_limit: string }
      >;
      const limits = Object.values(services).reduce(
        (sum, s) => sum + Number.parseInt(s.mem_limit, 10),
        0,
      );
      expect(edgeMemoryMb(proxy)).toBe(limits + CONNECTOR_MEMORY_MB);
    }
    expect(edgeMemoryMb("caddy")).toBe(EDGE_MEMORY_MB);
    expect(edgeMemoryMb("nginx")).toBe(192);
  });
});

describe("the app's site file", () => {
  it("routes the domain to kamal-proxy with TLS and the ACME email, and redirects www to it over HTTPS", () => {
    const site = renderCaddyfile(shop, ctx);
    expect(site.path).toBe("opscrew/runtime/edge/sites/shop.caddy");
    expect(site.kind).toBe("runtime");
    expect(site.content).toContain("\nexample.com {\n\ttls ops@example.com\n");
    expect(site.content).toContain(
      "\nwww.example.com {\n\ttls ops@example.com\n\tredir https://example.com{uri} 308\n}\n",
    );
    expect(site.content).toContain("\treverse_proxy kamal-proxy:80\n");
    expect(site.content).toContain("Strict-Transport-Security");
    // An imported file cannot have global options, so the email is the site's.
    expect(site.content).not.toContain("email ops@example.com");
    expect(site.content).not.toMatch(/^\{/m);
  });

  it("serves plain HTTP on any address before the plan has a domain", () => {
    const content = renderCaddyfile(named("shop"), ctx).content;
    expect(content).toContain("\n:80 {\n\tencode zstd gzip\n");
    expect(content).not.toContain("tls ");
    expect(content).not.toContain("Strict-Transport-Security");
  });

  it("serves plain HTTP behind a tunnel, redirecting visitors who used HTTP", () => {
    const content = renderCaddyfile(tunnelled, ctx).content;
    expect(content).toContain("\nhttp://shop.example.com {\n");
    expect(content).toContain('\t@http_visitor header Cf-Visitor `*"http"*`\n');
    expect(content).toContain("\tredir @http_visitor https://{host}{uri} 308\n");
    expect(content).not.toContain("tls ");
    expect(content).toContain("Strict-Transport-Security");
  });

  it("serves the same site behind OpsCrew's web filter as on OpsCrew's own servers", () => {
    expect(renderCaddyfile(filtered, ctx)).toEqual(
      renderCaddyfile(named("shop", { domain: "shop.example.com" }), ctx),
    );
  });

  it("sets HSTS and the baseline headers and removes Server in every site with a hostname", () => {
    const sites = [
      renderCaddyfile(shop, ctx),
      renderCaddyfile(shop, { ...ctx, originTls: { hostnames: ["example.com"] } }),
      renderCaddyfile(shop, {
        ...ctx,
        originTls: { hostnames: ["example.com", "www.example.com"] },
      }),
      renderCaddyfile(tunnelled, ctx),
    ].map((file) => file.content);
    const header = [
      "\theader {",
      '\t\tStrict-Transport-Security "max-age=31536000; includeSubDomains"',
      '\t\tX-Content-Type-Options "nosniff"',
      '\t\tX-Frame-Options "SAMEORIGIN"',
      '\t\tReferrer-Policy "strict-origin-when-cross-origin"',
      "\t\t-Server",
      "\t}",
    ];
    for (const content of sites) {
      // Every block that serves the app; www's only redirects.
      const blocks = content
        .split(/\n(?=\S+.* \{\n)/)
        .filter(
          (block) => block.includes(" {\n") && !/\tredir https:\/\/\S+\{uri\} 308\n/.test(block),
        );
      expect(blocks.length).toBeGreaterThan(0);
      for (const block of blocks) {
        expect(block).toContain(header.join("\n"));
        // The same headers on the responses Caddy writes itself (a 502 while the app is down).
        expect(block).toContain(
          [
            "\thandle_errors {",
            ...header.map((line) => `\t${line}`),
            '\t\trespond "{err.status_code} {err.status_text}" {err.status_code}',
            "\t}",
          ].join("\n"),
        );
      }
    }
  });
});

describe("the visitor's address behind Cloudflare's proxy, on Caddy", () => {
  const ranges = ["173.245.48.0/20", "2400:cb00::/32"];

  it("trusts CF-Connecting-IP from Cloudflare's ranges in the edge's global options", () => {
    const doc = parse(renderEdgeCompose(shop, ranges).content) as ReturnType<typeof edge>;
    const content = doc.configs.caddyfile.content;
    expect(content).toContain(
      "\n# Requests from Cloudflare's addresses carry the visitor's in CF-Connecting-IP.\n{\n\tservers {\n\t\ttrusted_proxies static 173.245.48.0/20 2400:cb00::/32\n\t\tclient_ip_headers CF-Connecting-IP\n\t}\n}\n\nimport /etc/caddy/sites/*.caddy\n",
    );
    expect(doc.services.caddy?.labels).toEqual({
      "dev.opscrew.caddyfile-sha256": sha256Hex(content),
    });
    // The same for every app on the server, proxied or not.
    expect(renderEdgeCompose(blog, ranges)).toEqual(renderEdgeCompose(shop, ranges));
  });

  it("sends a proxied app the visitor's address as X-Forwarded-For", () => {
    const site = (plan: DeployPlan, c: RuntimeContext) => renderCaddyfile(plan, c).content;
    const withRanges = { ...ctx, cloudflareRanges: ranges };
    const content = site(shop, withRanges);
    expect(content).toContain(
      "\treverse_proxy kamal-proxy:80 {\n\t\theader_up X-Forwarded-For {client_ip}\n\t}\n",
    );
    expect(content).not.toMatch(/\treverse_proxy kamal-proxy:80\n/);
    // An app Cloudflare does not proxy, or behind a tunnel, keeps today's site.
    const dnsOnly = DeployPlanSchema.parse({ ...blog, dns: { ...blog.dns, proxied: false } });
    expect(site(dnsOnly, withRanges)).toBe(site(dnsOnly, ctx));
    expect(site(tunnelled, withRanges)).toBe(site(tunnelled, ctx));
  });

  it("renders as before without the ranges", () => {
    expect(renderEdgeCompose(shop, [])).toEqual(renderEdgeCompose(shop));
    expect(renderCaddyfile(shop, { ...ctx, cloudflareRanges: [] })).toEqual(
      renderCaddyfile(shop, ctx),
    );
  });
});

describe("the app's site with origin TLS", () => {
  const ORIGIN_TLS = [
    "\ttls /etc/caddy/tls/shop/origin.pem /etc/caddy/tls/shop/origin.key {",
    "\t\tclient_auth {",
    "\t\t\tmode require_and_verify",
    "\t\t\ttrust_pool file /etc/caddy/tls/shop/pull.pem",
    "\t\t}",
    "\t}",
  ].join("\n");
  const proxied: RuntimeContext = {
    ...ctx,
    originTls: { hostnames: ["example.com", "www.example.com"] },
  };

  it("serves the origin certificate for exactly the proxied hostnames and requires Cloudflare's client certificate", () => {
    const content = renderCaddyfile(shop, proxied).content;
    expect(content).toContain(`\nexample.com {\n${ORIGIN_TLS}\n\tencode zstd gzip\n`);
    // www keeps the certificate and the client-certificate requirement, and only redirects.
    expect(content).toContain(
      `\nwww.example.com {\n${ORIGIN_TLS}\n\tredir https://example.com{uri} 308\n}\n`,
    );
    // Caddy asks no certificate authority for them: the site names its own certificate.
    expect(content).not.toContain("tls ops@example.com");
    expect(content.match(/ \{\n\ttls /g)).toHaveLength(2);
  });

  it("keeps Caddy's ACME for an app hostname the origin certificate does not cover", () => {
    const content = renderCaddyfile(shop, {
      ...ctx,
      originTls: { hostnames: ["example.com"] },
    }).content;
    expect(content).toContain(`\nexample.com {\n${ORIGIN_TLS}\n`);
    expect(content).toContain("\nwww.example.com {\n\ttls ops@example.com\n");
  });

  it("gets Caddy's ACME for DNS-only hostnames, as before", () => {
    const content = renderCaddyfile(shop, ctx).content;
    expect(content).toContain("\nexample.com {\n\ttls ops@example.com\n");
    expect(content).toContain("\nwww.example.com {\n\ttls ops@example.com\n");
    expect(content).not.toContain("/etc/caddy/tls/");
  });

  it("gives a hostname behind a Cloudflare Tunnel none of it (FR-1409)", () => {
    const tunnel: RuntimeContext = { ...ctx, originTls: { hostnames: ["shop.example.com"] } };
    expect(renderCaddyfile(tunnelled, tunnel)).toEqual(renderCaddyfile(tunnelled, ctx));
    expect(renderCaddyfile(tunnelled, tunnel).content).not.toContain("tls");
  });

  it("imports the user's additions inside every block of the app's site", () => {
    const content = (o: RuntimeContext) => renderCaddyfile(shop, o).content;
    const IMPORT =
      "\t# Your own additions (opscrew/proxy/additions.caddy).\n\timport /etc/caddy/sites/shop.additions\n}\n";
    expect(content({ ...proxied, additions: true })).toContain(
      `\t\trespond "{err.status_code} {err.status_text}" {err.status_code}\n\t}\n${IMPORT}`,
    );
    const split = content({ ...ctx, originTls: { hostnames: ["example.com"] }, additions: true });
    // www's block only redirects, so it imports nothing.
    expect(split.split(IMPORT)).toHaveLength(2);
    expect(renderCaddyfile(tunnelled, { ...ctx, additions: true }).content).toContain(IMPORT);
    // Without additions the site imports nothing (the edge imports only `*.caddy` files).
    expect(content(proxied)).not.toContain("import");
    expect(content(proxied)).toBe(content({ ...proxied, additions: false }));
  });

  it("never holds a certificate or a key", () => {
    for (const file of [renderCaddyfile(shop, proxied), renderEdgeCompose(shop)]) {
      expect(file.content).not.toMatch(/-----BEGIN|PRIVATE KEY/);
    }
  });
});

describe("snapshots", () => {
  /** The files one app brings to its server: its Compose file, the edge and its site. */
  const files = (plan: DeployPlan) =>
    Object.fromEntries(
      [renderCompose(plan), edgeFile(plan), renderCaddyfile(plan, ctx)].map((file) => [
        file.path,
        file.content,
      ]),
    );

  it("one app", () => {
    expect(files(shop)).toMatchSnapshot();
  });

  it("two apps: two site files, one edge", () => {
    const [first, second] = [files(shop), files(blog)];
    expect(first["opscrew/runtime/edge/compose.yaml"]).toBe(
      second["opscrew/runtime/edge/compose.yaml"],
    );
    expect(Object.keys(second)).toEqual([
      "opscrew/runtime/compose.yaml",
      "opscrew/runtime/edge/compose.yaml",
      "opscrew/runtime/edge/sites/blog.caddy",
    ]);
    expect({
      edge: first["opscrew/runtime/edge/compose.yaml"],
      sites: {
        "shop.caddy": first["opscrew/runtime/edge/sites/shop.caddy"],
        "blog.caddy": second["opscrew/runtime/edge/sites/blog.caddy"],
      },
    }).toMatchSnapshot();
  });

  it("a tunnelled app", () => {
    expect(files(tunnelled)).toMatchSnapshot();
  });

  it("a proxied app's site with origin TLS and its own additions", () => {
    const site = renderCaddyfile(shop, {
      ...ctx,
      originTls: { hostnames: ["example.com", "www.example.com"] },
      additions: true,
    });
    expect(site.content).toMatchSnapshot();
  });

  it("a DNS-only app's site", () => {
    const plan = DeployPlanSchema.parse({ ...blog, dns: { ...blog.dns, proxied: false } });
    expect(renderCaddyfile(plan, ctx).content).toMatchSnapshot();
  });
});

describe("OpsCrew's cloud servers", () => {
  const template = MODULE_FILES["hetzner-vps/cloud-init.yaml.tftpl"] ?? "";

  it("create the edge's, the apps' and the data folders for deploy at first boot, as on own servers", () => {
    for (const module of ["hetzner-vps", "digitalocean-droplet"]) {
      expect(MODULE_FILES[`${module}/cloud-init.yaml.tftpl`]).toBe(template);
    }
    const runcmd = (parse(template.replaceAll("$${", "${")) as { runcmd: string[][] }).runcmd;
    expect(runcmd).toContainEqual([
      "install",
      "-d",
      "-m",
      "0750",
      "-o",
      "deploy",
      "-g",
      "deploy",
      "/srv/edge",
      "/srv/apps",
      "/srv/data",
      "/srv/runners",
    ]);
    // Docker and the deploy user come first; the old single-app folder is gone.
    const at = (command: string) => runcmd.findIndex((c) => c.join(" ") === command);
    expect(at("usermod -aG docker deploy")).toBeLessThan(
      at("install -d -m 0750 -o deploy -g deploy /srv/edge /srv/apps /srv/data /srv/runners"),
    );
    expect(template).not.toMatch(/\/srv\/app\b/);
  });
});
