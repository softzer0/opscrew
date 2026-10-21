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

  // Runs Caddy with a tunnelled app's site (plain HTTP) whose kamal-proxy does not exist, and asks
  // it from a curl container in Caddy's network namespace.
  it("sends the baseline headers, and no Server, on the 502 Caddy writes while the app is down", () => {
    const plan = named("shop", { provider: "own", access: "tunnel", domain: "shop.example.com" });
    const files = {
      "/etc/caddy/Caddyfile": mainCaddyfile(plan),
      "/etc/caddy/sites/shop.caddy": renderCaddyfile(plan, ctx).content,
    };
    const script = [
      "mkdir -p /etc/caddy/sites",
      ...Object.entries(files).flatMap(([path, content]) => [
        `cat > ${path} <<'OPSCREW_EOF'`,
        content.replace(/\n$/, ""),
        "OPSCREW_EOF",
      ]),
      "exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile",
    ];
    const name = `opscrew-test-caddy-${process.pid}-${Date.now()}`;
    const started = spawnSync(
      "docker",
      ["run", "-d", "--name", name, IMAGES.caddy.ref, "sh", "-c", script.join("\n")],
      { encoding: "utf8", timeout: 240_000 },
    );
    expect(started.status, started.stderr).toBe(0);
    try {
      const ask = 'curl -sS -o /dev/null -H "Host: shop.example.com" http://127.0.0.1/';
      const probe = spawnSync(
        "docker",
        [
          "run",
          "--rm",
          "--network",
          `container:${name}`,
          "--entrypoint",
          "sh",
          IMAGES.curl.ref,
          "-c",
          `for i in $(seq 1 30); do if ${ask} 2> /dev/null; then break; fi; sleep 1; done; ${ask.replace("-o /dev/null", "-D - -o /dev/null")}`,
        ],
        { encoding: "utf8", timeout: 240_000 },
      );
      expect(probe.status, probe.stderr).toBe(0);
      const response = probe.stdout.replaceAll("\r", "").toLowerCase();
      expect(response).toMatch(/^http\/1\.1 502 /);
      expect(response).toContain(
        "\nstrict-transport-security: max-age=31536000; includesubdomains\n",
      );
      expect(response).toContain("\nx-content-type-options: nosniff\n");
      expect(response).toContain("\nreferrer-policy: strict-origin-when-cross-origin\n");
      expect(response).not.toMatch(/\nserver:/);
    } finally {
      spawnSync("docker", ["rm", "-f", name], { encoding: "utf8" });
    }
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
