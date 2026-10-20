// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Compose and shell syntax in expected contents, not JavaScript templates.
import { type AppBuild, type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { testContext, testPlan, testServices } from "../__fixtures__/plans";
import { renderEdgeCompose } from "../edge";
import { IMAGES } from "../pins";
import { renderCaddyfile, renderCompose, renderTunnelConnectorCompose } from "./index";

/** `testPlan` (Hetzner, `shop` on port 3000) with the given fields. */
function plan(
  o: {
    build?: {
      builder: AppBuild["builder"];
      language: AppBuild["runtime"]["language"];
      probe: NonNullable<AppBuild["probe"]>;
    };
    healthPath?: string;
    drainSeconds?: number;
    domain?: string;
    www?: boolean;
    port?: number;
    postgres?: boolean;
    redis?: boolean;
    release?: string;
  } = {},
): DeployPlan {
  const base = testPlan({
    ...(o.domain === undefined ? {} : { domain: o.domain }),
    ...(o.www === undefined ? {} : { www: o.www }),
    ...(o.postgres === undefined ? {} : { postgres: o.postgres }),
  });
  return DeployPlanSchema.parse({
    ...base,
    app: {
      ...base.app,
      ...(o.port === undefined ? {} : { port: o.port }),
      ...(o.healthPath === undefined ? {} : { healthPath: o.healthPath }),
      ...(o.release === undefined ? {} : { releaseCommand: o.release }),
      ...(o.build === undefined
        ? {}
        : {
            build: {
              builder: o.build.builder,
              chosen: "auto",
              reason: "test",
              runtime: {
                language: o.build.language,
                ...(o.build.language === "other" ? {} : { version: "1" }),
              },
              probe: o.build.probe,
            },
          }),
    },
    deploy: o.drainSeconds === undefined ? {} : { drainSeconds: o.drainSeconds },
    services: [...base.services, ...testServices({ redis: o.redis ?? false })],
  });
}

function app(p: DeployPlan): Record<string, unknown> & { healthcheck?: { test: string[] } } {
  return parse(renderCompose(p).content).services.app;
}

const ctx = testContext({ acmeEmail: "ops@example.com" });

describe("renderCompose", () => {
  it("runs the app, Postgres and Valkey with no published port; Caddy and kamal-proxy are the edge's", () => {
    const file = renderCompose(plan({ redis: true }));
    expect(file.path).toBe("opscrew/runtime/compose.yaml");
    const doc = parse(file.content);
    expect(doc.name).toBe("shop");
    expect(Object.keys(doc.services)).toEqual(["app", "db", "cache"]);
    for (const name of ["app", "db", "cache"]) {
      expect(doc.services[name].ports).toBeUndefined();
    }
    expect(file.content).not.toMatch(/caddy|kamal-proxy|Caddyfile/);
    // Only the web service joins the shared edge's network, where kamal-proxy reaches it.
    expect(doc.services.app.networks).toEqual(["internal", "opscrew-edge"]);
    expect(doc.services.db.networks).toEqual(["internal"]);
    expect(doc.networks).toEqual({ internal: {}, "opscrew-edge": { external: true } });
    expect(doc.volumes).toBeUndefined();
    expect(file.content).toContain(
      "# The deploy workflow copies it to /srv/apps/shop on the server.",
    );
    expect(doc.services.app.image).toMatch(/^\$\{APP_IMAGE:\?/);
    expect(doc.services.app.cap_drop).toEqual(["ALL"]);
    // Every catalog service has a health check, Valkey's too.
    expect(doc.services.app.depends_on).toEqual({
      db: { condition: "service_healthy" },
      cache: { condition: "service_healthy" },
    });
    expect(doc.services.db.healthcheck.test[1]).toContain("$${POSTGRES_USER}");
    expect(file.content).toMatchSnapshot();
  });

  it("omits the database and cache when the plan does not self-host them", () => {
    const doc = parse(renderCompose(plan({ postgres: false })).content);
    expect(Object.keys(doc.services)).toEqual(["app"]);
    expect(doc.services.app.depends_on).toBeUndefined();
  });

  it("rotates every service's logs itself and keeps no-new-privileges (Docker's daemon settings stay as they are)", () => {
    const doc = parse(renderCompose(plan({ redis: true, release: "migrate" })).content);
    expect(Object.keys(doc.services)).toEqual(["app", "release", "db", "cache"]);
    for (const service of Object.values<Record<string, unknown>>(doc.services)) {
      expect(service.logging).toEqual({
        driver: "json-file",
        options: { "max-size": "10m", "max-file": "3" },
      });
      expect(service.security_opt).toEqual(["no-new-privileges:true"]);
    }
  });

  it("adds no release service without a release command", () => {
    expect(renderCompose(plan()).content).not.toContain("release");
  });

  it("runs the release command as a one-off service of the app image, environment and network", () => {
    const command = "python manage.py migrate --noinput && echo $HOME ${X}";
    const file = renderCompose(plan({ redis: true, release: command }));
    const doc = parse(file.content);
    expect(Object.keys(doc.services)).toEqual(["app", "release", "db", "cache"]);
    const { app, release } = doc.services;
    expect(release.image).toBe(app.image);
    expect(release.env_file).toEqual(app.env_file);
    expect(release.environment).toEqual(app.environment);
    // Only the web service joins the shared edge.
    expect(release.networks).toEqual(["internal"]);
    expect(release.cap_drop).toEqual(["ALL"]);
    expect(release.security_opt).toEqual(app.security_opt);
    // Only `docker compose run` starts it, never `docker compose up`, and it never restarts.
    expect(release.profiles).toEqual(["release"]);
    expect(release.restart).toBeUndefined();
    expect(release.ports).toBeUndefined();
    expect(release.depends_on).toBeUndefined();
    // `$` is escaped so Compose passes the command to the shell unchanged.
    expect(release.command).toEqual([
      "sh",
      "-c",
      "python manage.py migrate --noinput && echo $$HOME $${X}",
    ]);
    expect(file.content).toContain("app.releaseCommand");
    expect(file.content).toMatchSnapshot();
  });
});

describe("renderCaddyfile (the app's site on the shared edge)", () => {
  it("serves the domain (and www) with HSTS and the ACME email", () => {
    const file = renderCaddyfile(plan({ domain: "example.com", www: true }), ctx);
    expect(file.path).toBe("opscrew/runtime/edge/sites/shop.caddy");
    const content = file.content;
    expect(content).toContain("example.com, www.example.com {");
    expect(content).toContain("\ttls ops@example.com\n");
    expect(content).toContain("reverse_proxy kamal-proxy:80");
    expect(content).toContain("Strict-Transport-Security");
    expect(content).toMatchSnapshot();
  });

  it("serves plain HTTP on the IP without HSTS before a domain exists", () => {
    const content = renderCaddyfile(plan({ port: 8080 }), ctx).content;
    expect(content).toContain(":80 {");
    expect(content).toContain("reverse_proxy kamal-proxy:80");
    expect(content).not.toContain("Strict-Transport-Security");
    expect(content).not.toContain("tls ");
  });
});

const NODE_PROBE =
  "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health',{signal:AbortSignal.timeout(2000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))";
/** `$` doubled for Compose. */
const BASH_PROBE =
  "exec 3<>/dev/tcp/127.0.0.1/3000 && printf 'GET %s HTTP/1.0\\r\\nHost: 127.0.0.1\\r\\n\\r\\n' '/api/health' >&3 && read -r _ code _ <&3 && [ \"$${code%$$'\\r'}\" = 200 ]";
const PYTHON_PROBE =
  "import os,urllib.request as u;u.urlopen('http://127.0.0.1:'+os.environ['PORT']+'/api/health',timeout=2)";

describe("the app's healthcheck", () => {
  it("probes with the plan's app.build.probe, and adds none without app.build", () => {
    const expected = {
      test: ["CMD", "node", "-e", NODE_PROBE],
      interval: "5s",
      timeout: "3s",
      retries: 3,
      start_period: "30s",
      start_interval: "1s",
    };
    expect(
      app(plan({ build: { builder: "generated-dockerfile", language: "node", probe: "node" } }))
        .healthcheck,
    ).toEqual(expected);
    // Design records the probe; without app.build there is none to guess.
    expect(app(plan()).healthcheck).toBeUndefined();
    expect(
      app(plan({ build: { builder: "railpack", language: "node", probe: "none" } })).healthcheck,
    ).toBeUndefined();
  });

  it("probes a static site's Caddy image with wget, never with node", () => {
    const site = app(
      plan({ build: { builder: "generated-dockerfile", language: "node", probe: "wget" } }),
    );
    expect(site.healthcheck?.test).toEqual([
      "CMD",
      "wget",
      "-q",
      "-O",
      "/dev/null",
      "http://127.0.0.1:3000/api/health",
    ]);
  });

  it("runs python -c for a Python image", () => {
    const { healthcheck } = app(
      plan({ build: { builder: "generated-dockerfile", language: "python", probe: "python" } }),
    );
    expect(healthcheck?.test).toEqual(["CMD", "python", "-c", PYTHON_PROBE]);
  });

  it("runs the probe through the Buildpacks launcher, with `--` so the exit code counts", () => {
    const node = app(plan({ build: { builder: "buildpacks", language: "node", probe: "node" } }));
    expect(node.healthcheck?.test).toEqual([
      "CMD",
      "/cnb/lifecycle/launcher",
      "--",
      "node",
      "-e",
      NODE_PROBE,
    ]);
    const ruby = app(plan({ build: { builder: "buildpacks", language: "ruby", probe: "ruby" } }));
    expect(ruby.healthcheck?.test).toEqual([
      "CMD",
      "/cnb/lifecycle/launcher",
      "--",
      // RUBYOPT cleared: `-rbundler/setup` would refuse the default gems -rnet/http loads.
      "env",
      "RUBYOPT=",
      "ruby",
      "-rnet/http",
      "-e",
      "exit Net::HTTP.get_response(URI('http://127.0.0.1:'+ENV['PORT']+'/api/health')).is_a?(Net::HTTPSuccess)",
    ]);
    const go = app(plan({ build: { builder: "buildpacks", language: "go", probe: "bash" } }));
    expect(go.healthcheck?.test).toEqual([
      "CMD",
      "/cnb/lifecycle/launcher",
      "--",
      "bash",
      "-c",
      BASH_PROBE,
    ]);
  });

  it("runs the probe as it is for other builders", () => {
    const php = app(plan({ build: { builder: "railpack", language: "php", probe: "php" } }));
    expect(php.healthcheck?.test).toEqual([
      "CMD",
      "php",
      "-r",
      "exit(@file_get_contents('http://127.0.0.1:'.getenv('PORT').'/api/health')===false?1:0);",
    ]);
    const go = app(plan({ build: { builder: "railpack", language: "go", probe: "bash" } }));
    expect(go.healthcheck?.test).toEqual(["CMD", "bash", "-c", BASH_PROBE]);
    const own = app(plan({ build: { builder: "own-dockerfile", language: "go", probe: "bash" } }));
    expect(own.healthcheck?.test).toEqual(["CMD", "bash", "-c", BASH_PROBE]);
  });

  it("quotes the health path for the probe and for Compose", () => {
    // The quote and backslash are escaped for the language, `$` is doubled for Compose.
    const node = { builder: "generated-dockerfile", language: "node", probe: "node" } as const;
    const test = app(plan({ healthPath: "/it's\\$up", build: node })).healthcheck?.test;
    expect(test?.[3]).toContain("+'/it\\'s\\\\$$up',");
    const go = { builder: "railpack", language: "go", probe: "bash" } as const;
    const bash = app(plan({ healthPath: "/it's", build: go })).healthcheck?.test;
    expect(bash?.[3]).toContain(" '/it'\\''s' >&3");
  });

  it("gives the old copy the drain time plus 5 seconds to stop", () => {
    expect(app(plan()).stop_grace_period).toBe("35s");
    expect(app(plan({ drainSeconds: 60 })).stop_grace_period).toBe("65s");
  });

  it("keeps the app free of a container name and host ports, so a second copy can start", () => {
    const service = app(plan());
    expect(service.container_name).toBeUndefined();
    expect(service.ports).toBeUndefined();
    expect(service.restart).toBe("unless-stopped");
  });

  it("adds neither to the one-off release service", () => {
    const { release } = parse(renderCompose(plan({ release: "migrate" })).content).services;
    expect(release.healthcheck).toBeUndefined();
    expect(release.stop_grace_period).toBeUndefined();
  });
});

describe("the switch between app copies", () => {
  it("is the edge's kamal-proxy, which Caddy proxies to, directly and through a tunnel", () => {
    const direct = renderCaddyfile(testPlan({ domain: "shop.example.com" }), testContext()).content;
    const tunnel = renderCaddyfile(
      testPlan({ provider: "own", access: "tunnel", domain: "shop.example.com" }),
      testContext(),
    ).content;
    for (const content of [direct, tunnel]) {
      expect(content).toContain("\treverse_proxy kamal-proxy:80\n");
      expect(content).not.toContain("app:3000");
    }
  });
});

describe("image pins", () => {
  const pinned = new Set<string>(Object.values(IMAGES).map((image) => image.ref));

  it("takes every service image of the server's Compose files from pins.ts, by digest", () => {
    const p = plan({ redis: true, release: "migrate" });
    const doc = parse(renderCompose(p).content);
    const edge = parse(renderEdgeCompose(p).content);
    const images = [...Object.entries(doc.services), ...Object.entries(edge.services)]
      .filter(([name]) => name !== "app" && name !== "release")
      .map(([, service]) => (service as { image: string }).image);
    expect(images).toEqual([
      IMAGES.postgres.ref,
      IMAGES.valkey.ref,
      IMAGES.kamalProxy.ref,
      IMAGES.caddy.ref,
    ]);
    const connector = parse(renderTunnelConnectorCompose(testPlan()).content);
    expect(connector.services.cloudflared.image).toBe(IMAGES.cloudflared.ref);
    for (const image of [...images, connector.services.cloudflared.image]) {
      expect(pinned.has(image)).toBe(true);
      expect(image).toMatch(/@sha256:[0-9a-f]{64}$/);
    }
  });
});
