// biome-ignore-all lint/suspicious/noTemplateCurlyInString: bash and GitHub Actions syntax, not JavaScript templates.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { generateP256, selfSignedClientCertificate } from "@opscrew/core";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { testContext, testPlan } from "../__fixtures__/plans";
import { EDGE_PROXIES, edgeProxy } from "../edge";
import { type RuntimeContext, renderEdgeSite, renderRuntimeFiles } from "../runtime";
import { renderWorkflow } from "./index";

type Step = { id?: string; name?: string; run?: string; env?: Record<string, string> };

const ctx: RuntimeContext = testContext({ acmeEmail: "ops@example.com" });

/**
 * `testPlan` on `edge` for `shop.example.com`, or `example.com` and `www.example.com` with `www`,
 * its hostnames proxied by Cloudflare unless `dnsOnly`.
 */
function planFor(edge: "caddy" | "nginx", o: { dnsOnly?: boolean; www?: boolean } = {}) {
  const plan = testPlan({
    domain: o.www ? "example.com" : "shop.example.com",
    www: o.www ?? false,
  });
  return DeployPlanSchema.parse({
    ...plan,
    target: { ...plan.target, edge },
    dns: { ...plan.dns, proxied: o.dnsOnly !== true },
  });
}

const steps = (plan: DeployPlan, c: RuntimeContext): Step[] =>
  parse(renderWorkflow(plan, c).content).jobs.deploy.steps;
const check = (plan: DeployPlan, c: RuntimeContext) =>
  steps(plan, c).find((s) => s.name?.startsWith("Validate the edge's configuration")) as Step;

const origin: RuntimeContext = {
  ...ctx,
  originTls: { hostnames: ["shop.example.com"] },
  additions: true,
};

describe("the deploy job's check of the edge with the proxy's own checker", () => {
  it("runs before anything reaches the server, right after the checkout", () => {
    for (const plan of [planFor("caddy"), planFor("nginx")]) {
      const names = steps(plan, origin).map((s) => s.name ?? s.id);
      const at = names.indexOf(check(plan, origin).name);
      expect(at).toBe(1);
      expect(at).toBeLessThan(names.indexOf("Configure SSH with the pinned host key"));
      expect(at).toBeLessThan(names.indexOf("Upload runtime files and environment"));
    }
  });

  it("validates Caddy's whole edge with caddy validate in the pinned image, through the edge's Compose file", () => {
    const run = check(planFor("caddy"), origin).run ?? "";
    expect(check(planFor("caddy"), origin).name).toBe(
      "Validate the edge's configuration with Caddy",
    );
    expect(run).toContain(
      'cp opscrew/runtime/edge/compose.yaml "$RUNNER_TEMP/opscrew-edge"/compose.yaml\n',
    );
    expect(run).toContain(
      'cp opscrew/runtime/edge/sites/shop.caddy "$RUNNER_TEMP/opscrew-edge"/sites/shop.caddy\n',
    );
    expect(run).toContain(
      'cp opscrew/proxy/additions.caddy "$RUNNER_TEMP/opscrew-edge"/sites/shop.additions\n',
    );
    expect(run).toContain(
      'if ! docker compose -p opscrew-edge-check -f "$RUNNER_TEMP/opscrew-edge"/compose.yaml run --rm --no-deps -T caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile < /dev/null; then\n',
    );
  });

  it("tests nginx's whole edge with nginx -t, also the site before certbot's first certificate", () => {
    const plan = planFor("nginx", { dnsOnly: true });
    const step = check(plan, { ...ctx, additions: true });
    expect(step.name).toBe("Validate the edge's configuration with nginx");
    const run = step.run ?? "";
    const nginxT =
      'if ! docker compose -p opscrew-edge-check -f "$RUNNER_TEMP/opscrew-edge"/compose.yaml run --rm --no-deps -T -v "$RUNNER_TEMP/opscrew-edge"/letsencrypt:/etc/letsencrypt:ro --entrypoint nginx nginx -t < /dev/null; then\n';
    expect(run.split(nginxT)).toHaveLength(3);
    const at = (text: string) => run.indexOf(text);
    expect(
      at('cp opscrew/runtime/edge/sites/shop.conf "$RUNNER_TEMP/opscrew-edge"/sites/shop.conf'),
    ).toBeLessThan(
      at(
        'cp opscrew/runtime/edge/sites/shop.http.conf "$RUNNER_TEMP/opscrew-edge"/sites/shop.conf',
      ),
    );
    expect(run).toContain(
      'cp opscrew/proxy/additions.nginx "$RUNNER_TEMP/opscrew-edge"/sites/shop.additions\n',
    );
    // nginx runs as the deploy user on the server, here as the runner's.
    expect(run).toContain('export OPSCREW_DEPLOY_UID="$(id -u)" OPSCREW_DEPLOY_GID="$(id -g)"\n');
    // Proxied hostnames only: one site, and no certbot certificate.
    const proxied = check(planFor("nginx"), origin).run ?? "";
    expect(proxied.split(nginxT)).toHaveLength(2);
    expect(proxied).not.toContain("letsencrypt/live");
  });

  it("puts placeholder certificates, made on the runner, where the server has the real ones", () => {
    const run = check(planFor("nginx", { www: true }), {
      ...ctx,
      originTls: { hostnames: ["example.com"] },
    }).run;
    expect(run).toContain(
      'openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 1 -subj /CN=opscrew-placeholder -keyout "$RUNNER_TEMP/opscrew-edge"/tls/shop/origin.key -out "$RUNNER_TEMP/opscrew-edge"/tls/shop/origin.pem 2> /dev/null\n',
    );
    expect(run).toContain(
      'cp opscrew/runtime/edge/tls/pull.pem "$RUNNER_TEMP/opscrew-edge"/tls/shop/pull.pem\n',
    );
    expect(run).toContain(
      '-keyout "$RUNNER_TEMP/opscrew-edge"/letsencrypt/live/shop/privkey.pem -out "$RUNNER_TEMP/opscrew-edge"/letsencrypt/live/shop/fullchain.pem 2> /dev/null\n',
    );
  });

  it("ends the job with the checker's output and a plain message when it refuses the edge", () => {
    const run = check(planFor("nginx"), origin).run ?? "";
    expect(run).toContain(
      "  echo '::error::nginx refused this app'\\''s edge configuration (opscrew/runtime/edge/sites/shop.conf with your additions in opscrew/proxy/additions.nginx) for the reason above. Nothing was sent to the server, which keeps serving the previous version: fix the cause (opscrew provision renders the site again), then push again.'\n  exit 1\n",
    );
    expect(check(planFor("caddy"), ctx).run).toContain(
      "::error::Caddy refused this app'\\''s edge configuration (opscrew/runtime/edge/sites/shop.caddy) for the reason above.",
    );
  });

  it("never sees a secret", () => {
    for (const plan of [planFor("caddy"), planFor("nginx")]) {
      const step = check(plan, origin);
      expect(step.env).toBeUndefined();
      expect(step.run).not.toContain("${{");
      expect(step.run).not.toContain("OPSCREW_ORIGIN_TLS");
    }
  });

  it("matches the snapshot", () => {
    expect({
      caddy: check(planFor("caddy"), origin).run,
      nginx: check(planFor("nginx", { www: true }), {
        ...ctx,
        originTls: { hostnames: ["example.com"] },
        additions: true,
      }).run,
      tunnel: check(
        DeployPlanSchema.parse({
          ...testPlan({ provider: "own", access: "tunnel", domain: "shop.example.com" }),
          target: {
            provider: "own",
            mode: "vps-compose",
            arch: "amd64",
            access: "tunnel",
            edge: "nginx",
          },
        }),
        origin,
      ).run,
    }).toMatchSnapshot();
  });
});

/*
 * Runs the rendered step with bash against the local Docker, in a copy of the repository's
 * opscrew/ folder: the pinned image's checker accepts the edge, and refuses it with broken
 * additions before anything else would happen. Pulls the images, so it runs only with
 * OPSCREW_DOCKER_TESTS=1.
 */
function skipReason(): string | undefined {
  if (process.env.OPSCREW_DOCKER_TESTS !== "1") return "set OPSCREW_DOCKER_TESTS=1 to run it";
  const version = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], {
    encoding: "utf8",
  });
  if (version.status !== 0) return "Docker is not available";
  const tools = spawnSync("bash", ["-c", "command -v openssl"], { encoding: "utf8" });
  return tools.status === 0 ? undefined : "bash with openssl is not available";
}

const reason = skipReason();
if (reason) console.warn(`[iac-templates] skipping the edge check step against Docker: ${reason}`);

describe.skipIf(reason !== undefined)(
  "the edge check step against Docker (OPSCREW_DOCKER_TESTS=1)",
  () => {
    let network = false;
    let work = "";
    beforeAll(() => {
      network = spawnSync("docker", ["network", "inspect", "opscrew-edge"]).status === 0;
      work = mkdtempSync(join(tmpdir(), "opscrew-edge-check-"));
    });
    afterAll(() => {
      const volumes = spawnSync(
        "docker",
        ["volume", "ls", "-q", "--filter", "label=com.docker.compose.project=opscrew-edge-check"],
        { encoding: "utf8" },
      ).stdout.split("\n");
      for (const volume of volumes.filter(Boolean)) spawnSync("docker", ["volume", "rm", volume]);
      if (!network) spawnSync("docker", ["network", "rm", "opscrew-edge"]);
      rmSync(work, { recursive: true, force: true });
    });

    /** Writes `plan`'s runtime files, pull.pem and `additions` into a repository, then runs the step. */
    function runStep(plan: DeployPlan, c: RuntimeContext, additions: string) {
      const repo = mkdtempSync(join(work, "repo-"));
      const pull = selfSignedClientCertificate({
        key: generateP256().privateKey,
        commonName: "opscrew-shop",
        days: 1,
      });
      const files = {
        ...Object.fromEntries(
          [...renderRuntimeFiles(plan), ...renderEdgeSite(plan, c)].map((f) => [f.path, f.content]),
        ),
        "opscrew/runtime/edge/tls/pull.pem": pull,
        [EDGE_PROXIES[edgeProxy(plan)].additions]: additions,
      };
      for (const [path, content] of Object.entries(files)) {
        mkdirSync(dirname(join(repo, path)), { recursive: true });
        writeFileSync(join(repo, path), content);
      }
      const runner = mkdtempSync(join(work, "runner-"));
      const result = spawnSync("bash", ["-c", check(plan, c).run ?? ""], {
        cwd: repo,
        env: { ...process.env, RUNNER_TEMP: runner.replaceAll("\\", "/"), MSYS_NO_PATHCONV: "1" },
        encoding: "utf8",
        timeout: 280_000,
      });
      return { status: result.status, output: `${result.stdout}${result.stderr}` };
    }

    const both: RuntimeContext = {
      ...ctx,
      originTls: { hostnames: ["shop.example.com"] },
      additions: true,
    };

    it("accepts nginx's edge with origin TLS, certbot's hostname and the additions", () => {
      const run = runStep(
        planFor("nginx", { www: true }),
        { ...both, originTls: { hostnames: ["example.com"] } },
        'add_header X-Robots-Tag "noindex" always;\nlocation /api/ {\n\tlimit_req zone=opscrew_shop burst=20 nodelay;\n\tproxy_pass http://kamal-proxy;\n}\n',
      );
      expect(run.status, run.output).toBe(0);
      expect(run.output).toContain(
        "nginx: configuration file /etc/nginx/nginx.conf test is successful",
      );
    }, 300_000);

    it("refuses nginx's edge with broken additions, with nginx's own message", () => {
      const run = runStep(planFor("nginx"), both, "add_header X-Robots-Tag;\n");
      expect(run.status).toBe(1);
      expect(run.output).toContain('invalid number of arguments in "add_header" directive');
      expect(run.output).toContain("::error::nginx refused this app's edge configuration");
    }, 300_000);

    it("accepts Caddy's edge with origin TLS and the additions, and refuses broken ones", () => {
      const good = runStep(planFor("caddy"), both, 'header X-Robots-Tag "noindex"\n');
      expect(good.status, good.output).toBe(0);
      expect(good.output).toContain("Valid configuration");
      const bad = runStep(planFor("caddy"), both, "header {\n");
      expect(bad.status).toBe(1);
      expect(bad.output).toContain("::error::Caddy refused this app's edge configuration");
    }, 300_000);
  },
);
