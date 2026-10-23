// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Compose and nginx syntax, not JavaScript templates.
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { CF_RANGES, testContext, testPlan } from "../__fixtures__/plans";
import { withServices } from "../catalog/__fixtures__/plans";
import {
  certbotHosts,
  type RuntimeContext,
  renderCompose,
  renderEdgeSite,
  renderRuntimeFiles,
} from "../runtime";
import { NIGHTLY, withProcesses } from "../workflow/__fixtures__/plans";
import { localhostPlan, onThisComputer } from "./__fixtures__/localhost";
import { localhostHostname, localhostTlsUpload, renderEdgeCompose } from "./index";

/** What the local flow renders an app's files with: its hostname, and what a server's would have. */
function localCtx(hostname: string, o: Partial<RuntimeContext> = {}): RuntimeContext {
  return { ...testContext({ acmeEmail: "ops@example.com" }), ...o, localhost: { hostname } };
}

type Service = Record<string, unknown> & { volumes?: string[]; ports?: string[] };
type ComposeFile = {
  name: string;
  services: Record<string, Service>;
  configs?: Record<string, { content: string }>;
  networks: Record<string, unknown>;
  volumes?: Record<string, unknown>;
};
const edge = (plan: DeployPlan) => parse(renderEdgeCompose(plan).content) as ComposeFile;
const site = (plan: DeployPlan, ctx: RuntimeContext) =>
  renderEdgeSite(plan, ctx).map((file) => file.content);

const shop = localhostPlan();
const shopOnNginx = localhostPlan({ edge: "nginx" });

describe("localhostHostname", () => {
  it("is <app>.localhost for the app's only localhost environment, <env>.<app>.localhost beside another", () => {
    const staging = localhostPlan({ environment: "staging" });
    expect(staging.app.name).toBe("shop-staging");
    expect(localhostHostname(shop, false)).toBe("shop.localhost");
    expect(localhostHostname(staging, false)).toBe("shop.localhost");
    expect(localhostHostname(shop, true)).toBe("prod.shop.localhost");
    expect(localhostHostname(staging, true)).toBe("staging.shop.localhost");
  });
});

describe("localhostTlsUpload", () => {
  it("is where the deploy leaves the leaf certificate and key in the edge's TLS folder", () => {
    expect(localhostTlsUpload("shop-staging")).toEqual({
      certificate: "tls/shop-staging/local.pem.new",
      key: "tls/shop-staging/local.key.new",
    });
  });
});

describe("the app's Compose project on this computer", () => {
  const doc = parse(renderCompose(shop).content) as ComposeFile;

  it("is opscrew-<app>, so it never meets a Compose project of the user's own", () => {
    expect(doc.name).toBe("opscrew-shop");
    expect(renderCompose(shop).content).toContain(
      "\n# The local deploy copies it to the app's folder on this computer.\n",
    );
  });

  it("keeps the services' data in named volumes, opscrew-<app>_<service>_<folder>", () => {
    expect(doc.services.db?.volumes).toEqual(["db_data:/var/lib/postgresql/data"]);
    expect(doc.volumes).toEqual({ db_data: {} });
    const many = parse(
      renderCompose(onThisComputer(withServices([{ kind: "mongodb" }, { kind: "kafka" }]))).content,
    ) as ComposeFile;
    expect(many.services.mongodb?.volumes).toEqual([
      "mongodb_db:/data/db",
      "mongodb_configdb:/data/configdb",
    ]);
    expect(Object.keys(many.volumes ?? {})).toEqual([
      "mongodb_db",
      "mongodb_configdb",
      "kafka_data",
      "kafka_secrets",
      "kafka_config",
    ]);
    expect(renderCompose(shop).content).not.toContain("/srv/");
  });

  it("publishes no port: only the edge does, on 127.0.0.1", () => {
    for (const service of Object.values(doc.services)) expect(service.ports).toBeUndefined();
    expect(doc.services.app?.networks).toEqual(["internal", "opscrew-edge"]);
  });

  it("leaves a server's project as it was", () => {
    const server = parse(renderCompose(testPlan()).content) as ComposeFile;
    expect(server.name).toBe("shop");
    expect(server.services.db?.volumes).toEqual(["/srv/data/shop/db:/var/lib/postgresql/data"]);
  });

  it("holds the services' settings files and the crontab inline: no file is mounted from here", () => {
    const services = withServices([{ kind: "mysql" }, { kind: "nats" }]);
    const local = withProcesses(onThisComputer(services), { cron: [NIGHTLY] });
    const server = withProcesses(services, { cron: [NIGHTLY] });
    const doc = parse(renderCompose(local).content) as ComposeFile;
    const files = new Map(renderRuntimeFiles(server).map((file) => [file.path, file.content]));
    // The same settings as a server's files, as Compose configs (`$$` keeps Compose's hands off).
    const config = (file: string) => ({
      content: files.get(`opscrew/runtime/${file}`)?.replaceAll("$", () => "$$"),
    });
    expect(doc.configs).toEqual({
      "mysql-my.cnf": config("services/mysql/my.cnf"),
      "nats-nats.conf": config("services/nats/nats.conf"),
      crontab: config("crontab"),
    });
    expect(doc.configs?.["nats-nats.conf"]?.content).toContain("$$");
    expect(doc.services.mysql?.configs).toEqual([
      { source: "mysql-my.cnf", target: "/etc/mysql/conf.d/opscrew.cnf" },
    ]);
    expect(doc.services.cron?.configs).toEqual([
      { source: "crontab", target: "/etc/opscrew/crontab" },
    ]);
    for (const service of Object.values(doc.services)) {
      for (const volume of service.volumes ?? []) expect(volume).not.toMatch(/^\.\//);
    }
    // Only the edge's file is brought next to compose.yaml.
    expect(renderRuntimeFiles(local).map((file) => file.path)).toEqual([
      "opscrew/runtime/edge/compose.yaml",
    ]);
  });

  it("pulls the app's images only when this computer does not have them, in both image modes", () => {
    const built = DeployPlanSchema.parse({
      ...withProcesses(shop, {
        workers: [{ name: "worker", command: "node worker.js" }],
        cron: [NIGHTLY],
      }),
      app: { ...shop.app, releaseCommand: "npm run migrate" },
      target: { ...shop.target, image: "local-build" },
    });
    const doc = parse(renderCompose(built).content) as ComposeFile;
    const registry = parse(renderCompose(shop).content) as ComposeFile;
    for (const [mode, file] of [
      ["local-build", doc],
      ["registry", registry],
    ] as const) {
      for (const name of ["app", "release", "worker", "cron"]) {
        if (file.services[name] === undefined) continue;
        expect(file.services[name]?.pull_policy, `${mode}: ${name}`).toBe("missing");
      }
      expect(file.services.db?.pull_policy, `${mode}: db`).toBeUndefined();
    }
  });
});

describe("the edge on this computer", () => {
  it("publishes Caddy's HTTP and HTTPS on 127.0.0.1 only, at the target's ports", () => {
    expect(edge(shop).services.caddy?.ports).toEqual(["127.0.0.1:80:80", "127.0.0.1:443:443"]);
    const high = localhostPlan({ ports: { https: 8443, http: 8080 } });
    expect(edge(high).services.caddy?.ports).toEqual(["127.0.0.1:8080:80", "127.0.0.1:8443:443"]);
  });

  it("publishes nginx's on 127.0.0.1 only, and runs no certbot", () => {
    const doc = edge(shopOnNginx);
    expect(Object.keys(doc.services)).toEqual(["kamal-proxy", "nginx"]);
    expect(doc.services.nginx?.ports).toEqual(["127.0.0.1:80:8080", "127.0.0.1:443:8443"]);
    expect(doc.services.nginx?.volumes).toEqual([
      "./sites:/etc/nginx/sites:ro",
      "./tls:/etc/nginx/tls:ro",
    ]);
    expect(doc.volumes).toEqual({ "kamal-proxy-config": {} });
    expect(renderEdgeCompose(shopOnNginx).content).not.toMatch(/certbot|letsencrypt|acme/i);
  });

  it("keeps the catch-all that refuses every other hostname, on both proxies", () => {
    const caddyfile = edge(shop).configs?.caddyfile?.content ?? "";
    expect(caddyfile).toContain("\nhttp:// {\n\tabort\n}\nhttps:// {\n\tabort\n}\n");
    const conf = edge(shopOnNginx).configs?.["nginx-conf"]?.content ?? "";
    expect(conf).toContain("\t\tlisten 8443 ssl default_server;\n");
    expect(conf).toContain("\t\tssl_reject_handshake on;\n");
  });

  it("serves Caddy without HTTP/3, whose UDP port it does not publish, and nothing for ACME", () => {
    const caddyfile = edge(shop).configs?.caddyfile?.content ?? "";
    expect(caddyfile).toContain(
      "\n# No HTTP/3: the edge on this computer publishes no UDP port.\n{\n\tservers {\n\t\tprotocols h1 h2\n\t}\n}\n\nimport /etc/caddy/sites/*.caddy\n",
    );
    // The only global options.
    expect(caddyfile.match(/^\{$/gm)).toHaveLength(1);
    expect(caddyfile).not.toMatch(/acme|email/);
  });

  it("trusts no Cloudflare address, which never reaches this computer, on both proxies", () => {
    for (const plan of [shop, shopOnNginx]) {
      expect(renderEdgeCompose(plan, CF_RANGES)).toEqual(renderEdgeCompose(plan));
    }
    expect(renderEdgeCompose(shop, CF_RANGES).content).not.toContain("trusted_proxies");
  });

  it("is one file for every app on the computer, and names this computer in its header", () => {
    const blog = DeployPlanSchema.parse({ ...shop, app: { ...shop.app, name: "blog" } });
    expect(renderEdgeCompose(blog)).toEqual(renderEdgeCompose(shop));
    expect(renderEdgeCompose(shop).content).toContain(
      "# OpsCrew's shared edge on this computer (Compose project opscrew-edge), in front of\n# every OpsCrew app there: Caddy and kamal-proxy.",
    );
    expect(renderEdgeCompose(shopOnNginx).content).toContain(
      "# every OpsCrew app there: nginx and kamal-proxy.",
    );
  });

  it("is brought with the app's runtime files", () => {
    const files = renderRuntimeFiles(shop).map((file) => file.path);
    expect(files).toEqual(["opscrew/runtime/edge/compose.yaml"]);
  });
});

describe("the app's site on this computer", () => {
  const ctx = localCtx("shop.localhost");

  it("serves Caddy's site with the leaf certificate, and redirects HTTP to HTTPS itself", () => {
    const [content = ""] = site(shop, ctx);
    expect(content).toContain(
      "\nhttp://shop.localhost {\n\tredir https://{host}{uri} 308\n}\n\nshop.localhost {\n\ttls /etc/caddy/tls/shop/local.pem /etc/caddy/tls/shop/local.key\n\tencode zstd gzip\n",
    );
    expect(content).toContain("\treverse_proxy kamal-proxy:80\n");
    // No ACME: the site's email is not used, and there is no other hostname.
    expect(content).not.toContain("ops@example.com");
    expect(content.match(/^\S[^\n]* \{$/gm)).toEqual([
      "http://shop.localhost {",
      "shop.localhost {",
    ]);
  });

  it("serves nginx's site with the same leaf certificate, without certbot", () => {
    const files = renderEdgeSite(shopOnNginx, ctx);
    expect(files.map((file) => file.path)).toEqual(["opscrew/runtime/edge/sites/shop.conf"]);
    const content = files[0]?.content ?? "";
    expect(content).toContain(
      "server {\n\tlisten 8080;\n\tserver_name shop.localhost;\n\tlocation / {\n\t\treturn 308 https://$host$request_uri;\n\t}\n}\n",
    );
    expect(content).toContain(
      "server {\n\tlisten 8443 ssl;\n\tserver_name shop.localhost;\n\tssl_certificate /etc/nginx/tls/shop/local.pem;\n\tssl_certificate_key /etc/nginx/tls/shop/local.key;\n",
    );
    expect(content).toContain("\t\tproxy_pass http://kamal-proxy;\n");
    expect(content).not.toMatch(/acme|letsencrypt|ssl_verify_client/);
    expect(certbotHosts(shopOnNginx, ctx)).toEqual([]);
  });

  it("sends the baseline headers without HSTS, and offers no HTTP/3, on both proxies", () => {
    const [caddy = ""] = site(shop, ctx);
    const [nginx = ""] = site(shopOnNginx, ctx);
    const baseline = [
      ["X-Content-Type-Options", "nosniff"],
      ["X-Frame-Options", "SAMEORIGIN"],
      ["Referrer-Policy", "strict-origin-when-cross-origin"],
    ];
    expect(caddy).toContain(
      ["\theader {", ...baseline.map(([n, v]) => `\t\t${n} "${v}"`), "\t\t-Server", "\t}"].join(
        "\n",
      ),
    );
    for (const [name, value] of baseline) {
      expect(nginx).toContain(`\tadd_header ${name} "${value}" always;\n`);
    }
    for (const content of [caddy, nginx]) {
      expect(content).not.toMatch(/Strict-Transport-Security|Alt-Svc|quic/);
    }
    // A server's sites keep them.
    const server = testPlan({ domain: "example.com" });
    const onNginx = DeployPlanSchema.parse({
      ...server,
      target: { ...server.target, edge: "nginx" },
    });
    expect(site(server, testContext())[0]).toContain("Strict-Transport-Security");
    expect(site(onNginx, testContext())[0]).toMatch(
      /listen 8443 quic;[\s\S]*Strict-Transport-Security[\s\S]*Alt-Svc/,
    );
  });

  it("redirects to the HTTPS port when it is not 443", () => {
    const high = { ports: { https: 8443, http: 8080 } } as const;
    expect(site(localhostPlan(high), ctx)[0]).toContain("\tredir https://{host}:8443{uri} 308\n");
    expect(site(localhostPlan({ ...high, edge: "nginx" }), ctx)[0]).toContain(
      "\t\treturn 308 https://$host:8443$request_uri;\n",
    );
  });

  it("has no origin TLS and no Cloudflare addresses, whatever the context holds", () => {
    const server = localCtx("shop.localhost", {
      originTls: { hostnames: ["shop.localhost"] },
      cloudflareRanges: CF_RANGES,
    });
    for (const plan of [shop, shopOnNginx]) {
      expect(site(plan, server)).toEqual(site(plan, ctx));
      expect(site(plan, server).join("\n")).not.toMatch(
        /origin\.(pem|key)|pull\.pem|client_auth|ssl_verify_client|real_ip|client_ip/,
      );
    }
  });

  it("includes the user's additions, as on a server", () => {
    const withAdditions = localCtx("shop.localhost", { additions: true });
    expect(site(shop, withAdditions)[0]).toContain("\timport /etc/caddy/sites/shop.additions\n");
    expect(site(shopOnNginx, withAdditions)[0]).toContain(
      "\tinclude /etc/nginx/sites/shop.additions;\n",
    );
  });

  it("needs the app's hostname on this computer", () => {
    expect(() => renderEdgeSite(shop, testContext())).toThrow(/localhostHostname/);
  });
});

describe("snapshots", () => {
  /** The files one app brings to this computer: its Compose file, the edge and its site. */
  const files = (plan: DeployPlan, ctx: RuntimeContext) =>
    Object.fromEntries(
      [renderCompose(plan), ...renderRuntimeFiles(plan), ...renderEdgeSite(plan, ctx)].map(
        (file) => [file.path, file.content],
      ),
    );

  for (const proxy of ["caddy", "nginx"] as const) {
    it(`one app on ${proxy}`, () => {
      expect(files(localhostPlan({ edge: proxy }), localCtx("shop.localhost"))).toMatchSnapshot();
    });

    it(`two localhost environments of the app on one ${proxy} edge`, () => {
      const prod = localhostPlan({ edge: proxy });
      const staging = localhostPlan({ edge: proxy, environment: "staging" });
      const [first, second] = [prod, staging].map((plan) =>
        files(plan, localCtx(localhostHostname(plan, true))),
      );
      // Each environment's files are in its own runtime folder; the edge's are the same.
      const [dir, stagingDir] = ["opscrew/runtime", "opscrew/environments/staging/runtime"];
      const edgeFile = "edge/compose.yaml";
      expect(first?.[`${dir}/${edgeFile}`]).toBe(second?.[`${stagingDir}/${edgeFile}`]);
      const ext = proxy === "caddy" ? "caddy" : "conf";
      expect({
        edge: first?.[`${dir}/${edgeFile}`],
        sites: {
          [`shop.${ext}`]: first?.[`${dir}/edge/sites/shop.${ext}`],
          [`shop-staging.${ext}`]: second?.[`${stagingDir}/edge/sites/shop-staging.${ext}`],
        },
      }).toMatchSnapshot();
    });
  }
});
