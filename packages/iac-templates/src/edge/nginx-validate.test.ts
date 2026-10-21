import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { generateP256, selfSignedClientCertificate } from "@opscrew/core";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testContext, testPlan } from "../__fixtures__/plans";
import { IMAGES } from "../pins";
import { renderEdgeSite } from "../runtime";
import { NGINX_CONF, NGINX_LOOP } from "./nginx";

/*
 * Runs the nginx edge's pinned nginx, as Compose runs it (the deploy user's uid, an init, the
 * reload loop), with the sites of two apps on one server: a proxied app with origin TLS and
 * additions, and a DNS-only app on certbot's certificate. The certificates are placeholders made at
 * test time, and kamal-proxy is absent, so the apps answer 502. A curl container on the same
 * network checks what visitors get. Pulls the images, so it runs only with OPSCREW_DOCKER_TESTS=1.
 */

function skipReason(): string | undefined {
  if (process.env.OPSCREW_DOCKER_TESTS !== "1") return "set OPSCREW_DOCKER_TESTS=1 to run it";
  const version = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], {
    encoding: "utf8",
  });
  return version.status === 0 ? undefined : "Docker is not available";
}

const reason = skipReason();
if (reason) console.warn(`[iac-templates] skipping the nginx edge (Docker): ${reason}`);

function nginx(name: string, domain: string, proxied: boolean): DeployPlan {
  const plan = testPlan({ domain });
  return DeployPlanSchema.parse({
    ...plan,
    app: { ...plan.app, name },
    target: { ...plan.target, edge: "nginx" },
    dns: { ...plan.dns, proxied },
  });
}

/** A self-signed P-256 certificate and its key, made now. */
function placeholder(commonName: string): { certificate: string; key: string } {
  const key = generateP256().privateKey;
  return { certificate: selfSignedClientCertificate({ key, commonName, days: 1 }), key };
}

describe.skipIf(reason !== undefined)("the nginx edge (OPSCREW_DOCKER_TESTS=1)", () => {
  const id = `opscrew-test-nginx-${process.pid}-${Date.now()}`;
  let work = "";

  /** Runs `script` in the pinned curl image on the test network, with the client certificate. */
  function curl(script: string) {
    const run = spawnSync(
      "docker",
      [
        "run",
        "--rm",
        "--network",
        id,
        "-v",
        `${join(work, "client")}:/client:ro`,
        "--entrypoint",
        "sh",
        IMAGES.curl.ref,
        "-c",
        script,
      ],
      { encoding: "utf8", timeout: 120_000 },
    );
    return { status: run.status, stdout: run.stdout.replaceAll("\r", ""), stderr: run.stderr };
  }

  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), "opscrew-nginx-edge-"));
    const ctx = testContext({ acmeEmail: "ops@example.com" });
    const shop = nginx("shop", "shop.example.com", true);
    const blog = nginx("blog", "blog.example.com", false);
    const origin = placeholder("shop.example.com");
    const certbot = placeholder("blog.example.com");
    const client = placeholder("opscrew-shop");
    const [shopSite] = renderEdgeSite(shop, {
      ...ctx,
      originTls: { hostnames: ["shop.example.com"] },
      additions: true,
    });
    const [blogSite] = renderEdgeSite(blog, ctx);
    const files: Record<string, string> = {
      "nginx.conf": NGINX_CONF,
      "sites/shop.conf": shopSite?.content ?? "",
      "sites/shop.additions":
        'add_header X-Robots-Tag "noindex" always;\nlocation /api/ {\n\tadd_header Cache-Control "no-store" always;\n\tproxy_pass http://kamal-proxy;\n}\n',
      "sites/blog.conf": blogSite?.content ?? "",
      "tls/shop/origin.pem": origin.certificate,
      "tls/shop/origin.key": origin.key,
      "tls/shop/pull.pem": client.certificate,
      "letsencrypt/live/blog/fullchain.pem": certbot.certificate,
      "letsencrypt/live/blog/privkey.pem": certbot.key,
      "client/client.pem": client.certificate,
      "client/client.key": client.key,
    };
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(work, path)), { recursive: true });
      writeFileSync(join(work, path), content);
    }
    expect(spawnSync("docker", ["network", "create", id], { encoding: "utf8" }).status).toBe(0);
    const started = spawnSync(
      "docker",
      [
        "run",
        "-d",
        "--name",
        id,
        "--network",
        id,
        "--network-alias",
        "nginx",
        "--user",
        "1000:1000",
        "--init",
        "-v",
        `${join(work, "nginx.conf")}:/etc/nginx/nginx.conf:ro`,
        "-v",
        `${join(work, "sites")}:/etc/nginx/sites:ro`,
        "-v",
        `${join(work, "tls")}:/etc/nginx/tls:ro`,
        "-v",
        `${join(work, "letsencrypt")}:/etc/letsencrypt:ro`,
        "--entrypoint",
        "sh",
        IMAGES.nginx.ref,
        "-c",
        NGINX_LOOP,
      ],
      { encoding: "utf8", timeout: 240_000 },
    );
    expect(started.status, started.stderr).toBe(0);
    // Ready once nginx answers.
    const ready = curl(
      "for i in $(seq 1 30); do if curl -s -o /dev/null http://nginx:8080/ -H 'Host: shop.example.com'; then exit 0; fi; sleep 1; done; exit 1",
    );
    expect(ready.status, spawnSync("docker", ["logs", id], { encoding: "utf8" }).stderr).toBe(0);
  }, 300_000);

  afterAll(() => {
    spawnSync("docker", ["rm", "-f", id]);
    spawnSync("docker", ["network", "rm", id]);
    if (work) rmSync(work, { recursive: true, force: true });
  });

  const https = (host: string, extra = "", path = "/") =>
    `curl -sSk -D - -o /dev/null --connect-to ${host}:443:nginx:8443 ${extra} https://${host}${path}`;

  it("refuses an unknown hostname on HTTP and in the TLS handshake", () => {
    const http = curl("curl -sS -o /dev/null -H 'Host: other.example.com' http://nginx:8080/");
    expect(http.status).toBe(52); // Empty reply: nginx closed the connection (444).
    expect(curl(https("other.example.com")).status).toBe(35);
  }, 120_000);

  it("redirects a known hostname to HTTPS with 308", () => {
    const run = curl(
      "curl -sS -D - -o /dev/null -H 'Host: blog.example.com' 'http://nginx:8080/a?b=1'",
    );
    expect(run.stdout).toMatch(/^HTTP\/1\.1 308 /);
    expect(run.stdout).toContain("\nLocation: https://blog.example.com/a?b=1\n");
  }, 120_000);

  it("sends HSTS, the baseline headers and Alt-Svc on nginx's own 502, and no version", () => {
    const run = curl(https("blog.example.com"));
    const response = run.stdout.toLowerCase();
    expect(response).toMatch(/^http\/2 502/);
    expect(response).toContain(
      "\nstrict-transport-security: max-age=31536000; includesubdomains\n",
    );
    expect(response).toContain("\nx-content-type-options: nosniff\n");
    expect(response).toContain("\nx-frame-options: sameorigin\n");
    expect(response).toContain("\nreferrer-policy: strict-origin-when-cross-origin\n");
    expect(response).toContain('\nalt-svc: h3=":443"; ma=2592000\n');
    expect(response).toContain("\nserver: nginx\n");
  }, 120_000);

  it("offers TLS 1.2 and 1.3 only", () => {
    expect(curl(https("blog.example.com", "--tlsv1.1 --tls-max 1.1")).status).toBe(35);
    expect(curl(https("blog.example.com", "--tlsv1.2 --tls-max 1.2")).status).toBe(0);
    expect(curl(https("blog.example.com", "--tlsv1.3")).status).toBe(0);
  }, 120_000);

  it("requires Cloudflare's client certificate for a proxied hostname, and serves its additions", () => {
    expect(curl(https("shop.example.com")).stdout).toMatch(/^HTTP\/2 400/);
    const run = curl(
      https("shop.example.com", "--cert /client/client.pem --key /client/client.key"),
    );
    expect(run.stdout.toLowerCase()).toMatch(/^http\/2 502/);
    expect(run.stdout.toLowerCase()).toContain("\nx-robots-tag: noindex\n");
  }, 120_000);

  it("keeps HSTS and the baseline headers in an addition's location with headers of its own", () => {
    const run = curl(
      https("shop.example.com", "--cert /client/client.pem --key /client/client.key", "/api/x"),
    );
    const response = run.stdout.toLowerCase();
    expect(response).toMatch(/^http\/2 502/);
    expect(response).toContain("\ncache-control: no-store\n");
    expect(response).toContain(
      "\nstrict-transport-security: max-age=31536000; includesubdomains\n",
    );
    expect(response).toContain("\nx-content-type-options: nosniff\n");
    expect(response).toContain("\nx-frame-options: sameorigin\n");
    expect(response).toContain("\nreferrer-policy: strict-origin-when-cross-origin\n");
    expect(response).toContain("\nx-robots-tag: noindex\n");
  }, 120_000);
});
