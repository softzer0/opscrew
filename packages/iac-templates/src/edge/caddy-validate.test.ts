import { spawnSync } from "node:child_process";
import { generateP256, selfSignedClientCertificate } from "@opscrew/core";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { testContext, testPlan } from "../__fixtures__/plans";
import { IMAGES } from "../pins";
import { type RuntimeContext, renderCaddyfile } from "../runtime";
import { renderEdgeCompose } from "./index";

/*
 * Checks the shared edge's Caddy configuration with `caddy validate` in the pinned Caddy image: the
 * main Caddyfile with its catch-all, an app's site with origin TLS and additions next to a DNS-only
 * app's, a tunnelled app's and an app without a domain. The certificates are placeholders made at
 * test time. Also runs Caddy once to check the headers of its own error responses. Pulls the
 * images, so it runs only with OPSCREW_DOCKER_TESTS=1.
 */

function skipReason(): string | undefined {
  if (process.env.OPSCREW_DOCKER_TESTS !== "1") return "set OPSCREW_DOCKER_TESTS=1 to run it";
  const version = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], {
    encoding: "utf8",
  });
  return version.status === 0 ? undefined : "Docker is not available";
}

const reason = skipReason();
if (reason) console.warn(`[iac-templates] skipping caddy validate (edge): ${reason}`);

function named(name: string, o: Parameters<typeof testPlan>[0] = {}): DeployPlan {
  const plan = testPlan(o);
  return DeployPlanSchema.parse({ ...plan, app: { ...plan.app, name } });
}

/** A placeholder certificate and its key (a self-signed P-256 certificate, made now). */
function placeholder(commonName: string): { certificate: string; key: string } {
  const key = generateP256().privateKey;
  return { certificate: selfSignedClientCertificate({ key, commonName, days: 1 }), key };
}

/**
 * Writes `files` (path in the container → content) and runs `caddy validate` on the main
 * Caddyfile, all from a script on the container's stdin.
 */
function validate(files: Record<string, string>) {
  const script = [
    "set -e",
    ...Object.entries(files).flatMap(([path, content]) => [
      `mkdir -p "$(dirname ${path})"`,
      `cat > ${path} <<'OPSCREW_EOF'`,
      content.replace(/\n$/, ""),
      "OPSCREW_EOF",
    ]),
    "caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile",
  ].join("\n");
  const run = spawnSync("docker", ["run", "--rm", "-i", IMAGES.caddy.ref, "sh", "-s"], {
    input: script,
    encoding: "utf8",
    timeout: 240_000,
  });
  return { status: run.status, output: `${run.stdout}${run.stderr}` };
}

/** The main Caddyfile of `plan`'s edge, as Compose hands it to Caddy. */
const mainCaddyfile = (plan: DeployPlan) =>
  (parse(renderEdgeCompose(plan).content).configs.caddyfile.content as string).replaceAll(
    "$$",
    "$",
  );

describe.skipIf(reason !== undefined)("caddy validate (OPSCREW_DOCKER_TESTS=1)", () => {
  const ctx = testContext({ acmeEmail: "ops@example.com" });

  it("accepts the edge with a proxied app's origin TLS and additions next to a DNS-only app", () => {
    const shop = named("shop", { domain: "example.com", www: true });
    const blog = named("blog", { domain: "blog.example.com" });
    const proxied: RuntimeContext = {
      ...ctx,
      originTls: { hostnames: ["example.com", "www.example.com"] },
      additions: true,
    };
    const origin = placeholder("example.com");
    const run = validate({
      "/etc/caddy/Caddyfile": mainCaddyfile(shop),
      "/etc/caddy/sites/shop.caddy": renderCaddyfile(shop, proxied).content,
      "/etc/caddy/sites/shop.additions": 'header X-Robots-Tag "noindex"\nredir /old /new 308\n',
      "/etc/caddy/sites/blog.caddy": renderCaddyfile(blog, ctx).content,
      "/etc/caddy/tls/shop/origin.pem": origin.certificate,
      "/etc/caddy/tls/shop/origin.key": origin.key,
      "/etc/caddy/tls/shop/pull.pem": placeholder("opscrew-shop").certificate,
    });
    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain("Valid configuration");
  }, 300_000);

  /**
   * Runs Caddy with `files` and, from a curl container in its network namespace, `script` once
   * Caddy answers the request `ready` (curl's arguments).
   */
  function probeCaddy(files: Record<string, string>, ready: string, script: string) {
    const setup = [
      ...Object.entries(files).flatMap(([path, content]) => [
        `mkdir -p "$(dirname ${path})"`,
        `cat > ${path} <<'OPSCREW_EOF'`,
        content.replace(/\n$/, ""),
        "OPSCREW_EOF",
      ]),
      "exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile",
    ];
    const name = `opscrew-test-caddy-${process.pid}-${Date.now()}`;
    const started = spawnSync(
      "docker",
      [
        "run",
        "-d",
        "--name",
        name,
        "--label",
        "opscrew-test=caddy",
        IMAGES.caddy.ref,
        "sh",
        "-c",
        setup.join("\n"),
      ],
      { encoding: "utf8", timeout: 240_000 },
    );
    expect(started.status, started.stderr).toBe(0);
    try {
      const wait = `for i in $(seq 1 30); do if curl -sS -o /dev/null ${ready} 2> /dev/null; then break; fi; sleep 1; done`;
      const probe = spawnSync(
        "docker",
        [
          "run",
          "--rm",
          "--label",
          "opscrew-test=caddy",
          "--network",
          `container:${name}`,
          "--entrypoint",
          "sh",
          IMAGES.curl.ref,
          "-c",
          `${wait}; ${script}`,
        ],
        { encoding: "utf8", timeout: 240_000 },
      );
      return {
        status: probe.status,
        stdout: probe.stdout.replaceAll("\r", ""),
        stderr: probe.stderr,
      };
    } finally {
      spawnSync("docker", ["rm", "-f", name], { encoding: "utf8" });
    }
  }

  // A tunnelled app's site (plain HTTP) whose kamal-proxy does not exist.
  it("sends the baseline headers, and no Server, on the 502 Caddy writes while the app is down", () => {
    const plan = named("shop", { provider: "own", access: "tunnel", domain: "shop.example.com" });
    const ask = '-H "Host: shop.example.com" http://127.0.0.1/';
    const probe = probeCaddy(
      {
        "/etc/caddy/Caddyfile": mainCaddyfile(plan),
        "/etc/caddy/sites/shop.caddy": renderCaddyfile(plan, ctx).content,
      },
      ask,
      `curl -sS -D - -o /dev/null ${ask}`,
    );
    expect(probe.status, probe.stderr).toBe(0);
    const response = probe.stdout.toLowerCase();
    expect(response).toMatch(/^http\/1\.1 502 /);
    expect(response).toContain(
      "\nstrict-transport-security: max-age=31536000; includesubdomains\n",
    );
    expect(response).toContain("\nx-content-type-options: nosniff\n");
    expect(response).toContain("\nreferrer-policy: strict-origin-when-cross-origin\n");
    expect(response).not.toMatch(/\nserver:/);
  }, 300_000);

  // Cloudflare forwards a visitor's plain HTTP to the origin's port 80 (found live: a 520).
  it("redirects HTTP to HTTPS for hostnames with origin TLS, and still refuses an unknown one", () => {
    const shop = named("shop", { domain: "example.com", www: true });
    const origin = placeholder("example.com");
    const ask = (host: string, path: string) =>
      `curl -sS -D - -o /dev/null -H 'Host: ${host}' 'http://127.0.0.1${path}'`;
    const probe = probeCaddy(
      {
        "/etc/caddy/Caddyfile": mainCaddyfile(shop),
        "/etc/caddy/sites/shop.caddy": renderCaddyfile(shop, {
          ...ctx,
          originTls: { hostnames: ["example.com", "www.example.com"] },
        }).content,
        "/etc/caddy/tls/shop/origin.pem": origin.certificate,
        "/etc/caddy/tls/shop/origin.key": origin.key,
        "/etc/caddy/tls/shop/pull.pem": placeholder("opscrew-shop").certificate,
      },
      "-H 'Host: example.com' http://127.0.0.1/",
      [
        ask("example.com", "/a?b=1"),
        ask("www.example.com", "/c"),
        `${ask("other.example.com", "/")}; echo "unknown: $?"`,
      ].join("; "),
    );
    expect(probe.stdout).toMatch(/^HTTP\/1\.1 308 /);
    expect(probe.stdout).toContain("\nLocation: https://example.com/a?b=1\n");
    expect(probe.stdout).toContain("\nLocation: https://www.example.com/c\n");
    expect(probe.stdout).toContain("unknown: 52"); // Empty reply: Caddy aborted the request.
  }, 300_000);

  it("accepts the edge with a tunnelled app, and with an app without a domain", () => {
    const tunnelled = named("shop", {
      provider: "own",
      access: "tunnel",
      domain: "shop.example.com",
    });
    const bare = named("shop");
    for (const plan of [tunnelled, bare]) {
      const run = validate({
        "/etc/caddy/Caddyfile": mainCaddyfile(plan),
        "/etc/caddy/sites/shop.caddy": renderCaddyfile(plan, ctx).content,
      });
      expect(run.status, run.output).toBe(0);
    }
  }, 300_000);
});
