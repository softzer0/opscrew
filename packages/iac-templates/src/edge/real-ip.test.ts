import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { generateP256, selfSignedClientCertificate } from "@opscrew/core";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { testContext, testPlan } from "../__fixtures__/plans";
import { IMAGES } from "../pins";
import { type RuntimeContext, renderEdgeSite } from "../runtime";
import { renderEdgeCompose } from "./index";
import { NGINX_LOOP } from "./nginx";

/*
 * The visitor's address behind Cloudflare's proxy, on both proxies: each runs the edge's main
 * configuration and a proxied app's site (origin TLS, placeholder certificates made now) with
 * "Cloudflare's ranges" set to the upper half of a test network. In place of kamal-proxy, an echo
 * answers with the X-Forwarded-For it got. A client in that half sends `CF-Connecting-IP`, and one
 * outside it sends the same header. Pulls the images, so it runs only with OPSCREW_DOCKER_TESTS=1.
 */

function skipReason(): string | undefined {
  if (process.env.OPSCREW_DOCKER_TESTS !== "1") return "set OPSCREW_DOCKER_TESTS=1 to run it";
  const version = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], {
    encoding: "utf8",
  });
  return version.status === 0 ? undefined : "Docker is not available";
}

const reason = skipReason();
if (reason) console.warn(`[iac-templates] skipping the visitor's address (Docker): ${reason}`);

const SUBNET = "172.31.250.0/24";
const CLOUDFLARE = "172.31.250.200";
const OTHER = "172.31.250.20";
const VISITOR = "198.51.100.7";

function on(edge: "caddy" | "nginx"): DeployPlan {
  const plan = testPlan({ domain: "shop.example.com" });
  return DeployPlanSchema.parse({ ...plan, target: { ...plan.target, edge } });
}

function placeholder(commonName: string): { certificate: string; key: string } {
  const key = generateP256().privateKey;
  return { certificate: selfSignedClientCertificate({ key, commonName, days: 1 }), key };
}

describe.skipIf(reason !== undefined)("the visitor's address (OPSCREW_DOCKER_TESTS=1)", () => {
  const id = `opscrew-test-real-ip-${process.pid}-${Date.now()}`;
  const ctx: RuntimeContext = {
    ...testContext({ acmeEmail: "ops@example.com" }),
    originTls: { hostnames: ["shop.example.com"] },
    cloudflareRanges: ["172.31.250.128/25"],
  };
  let work = "";

  const docker = (args: string[]) => {
    const run = spawnSync("docker", args, { encoding: "utf8", timeout: 240_000 });
    expect(run.status, run.stderr).toBe(0);
  };
  const write = (files: Record<string, string>) => {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(work, path)), { recursive: true });
      writeFileSync(join(work, path), content);
    }
  };
  /** What the echo got as X-Forwarded-For, for a request to `edge` from `ip`. */
  const forwardedFor = (edge: string, port: number, ip: string) => {
    const run = spawnSync(
      "docker",
      [
        "run",
        "--rm",
        "--network",
        id,
        "--ip",
        ip,
        "-v",
        `${join(work, "client")}:/client:ro`,
        "--entrypoint",
        "sh",
        IMAGES.curl.ref,
        "-c",
        `for i in $(seq 1 30); do if out=$(curl -fsSk --cert /client/client.pem --key /client/client.key -H 'CF-Connecting-IP: ${VISITOR}' --connect-to shop.example.com:443:${edge}:${port} https://shop.example.com/); then echo "$out"; exit 0; fi; sleep 1; done; exit 1`,
      ],
      { encoding: "utf8", timeout: 120_000 },
    );
    expect(run.status, run.stderr).toBe(0);
    return run.stdout.trim();
  };

  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), "opscrew-real-ip-"));
    const origin = placeholder("shop.example.com");
    const client = placeholder("opscrew-shop");
    write({
      "tls/shop/origin.pem": origin.certificate,
      "tls/shop/origin.key": origin.key,
      "tls/shop/pull.pem": client.certificate,
      "client/client.pem": client.certificate,
      "client/client.key": client.key,
      "echo/Caddyfile": ':80 {\n\trespond "{header.X-Forwarded-For}"\n}\n',
    });
    docker(["network", "create", "--subnet", SUBNET, id]);
    docker([
      "run",
      "-d",
      "--name",
      `${id}-echo`,
      "--network",
      id,
      "--network-alias",
      "kamal-proxy",
      "-v",
      `${join(work, "echo", "Caddyfile")}:/etc/caddy/Caddyfile:ro`,
      IMAGES.caddy.ref,
    ]);
  }, 300_000);

  afterAll(() => {
    for (const name of ["echo", "nginx", "caddy"])
      spawnSync("docker", ["rm", "-f", `${id}-${name}`]);
    spawnSync("docker", ["network", "rm", id]);
    if (work) rmSync(work, { recursive: true, force: true });
  });

  it("is CF-Connecting-IP's on nginx for a request from Cloudflare, and ignored from anywhere else", () => {
    const plan = on("nginx");
    const conf = parse(renderEdgeCompose(plan, ctx.cloudflareRanges).content).configs["nginx-conf"]
      .content as string;
    const [site] = renderEdgeSite(plan, ctx);
    write({
      "nginx/nginx.conf": conf.replaceAll("$$", "$"),
      "nginx/sites/shop.conf": site?.content ?? "",
    });
    docker([
      "run",
      "-d",
      "--name",
      `${id}-nginx`,
      "--network",
      id,
      "--user",
      "1000:1000",
      "--init",
      "-v",
      `${join(work, "nginx", "nginx.conf")}:/etc/nginx/nginx.conf:ro`,
      "-v",
      `${join(work, "nginx", "sites")}:/etc/nginx/sites:ro`,
      "-v",
      `${join(work, "tls")}:/etc/nginx/tls:ro`,
      "--entrypoint",
      "sh",
      IMAGES.nginx.ref,
      "-c",
      NGINX_LOOP,
    ]);
    expect(forwardedFor(`${id}-nginx`, 8443, CLOUDFLARE)).toBe(VISITOR);
    expect(forwardedFor(`${id}-nginx`, 8443, OTHER)).toBe(OTHER);
  }, 300_000);

  it("is CF-Connecting-IP's on Caddy for a request from Cloudflare, and ignored from anywhere else", () => {
    const plan = on("caddy");
    const caddyfile = parse(renderEdgeCompose(plan, ctx.cloudflareRanges).content).configs.caddyfile
      .content as string;
    const [site] = renderEdgeSite(plan, ctx);
    write({
      "caddy/Caddyfile": caddyfile.replaceAll("$$", "$"),
      "caddy/sites/shop.caddy": site?.content ?? "",
    });
    docker([
      "run",
      "-d",
      "--name",
      `${id}-caddy`,
      "--network",
      id,
      "-v",
      `${join(work, "caddy", "Caddyfile")}:/etc/caddy/Caddyfile:ro`,
      "-v",
      `${join(work, "caddy", "sites")}:/etc/caddy/sites:ro`,
      "-v",
      `${join(work, "tls")}:/etc/caddy/tls:ro`,
      IMAGES.caddy.ref,
    ]);
    expect(forwardedFor(`${id}-caddy`, 443, CLOUDFLARE)).toBe(VISITOR);
    expect(forwardedFor(`${id}-caddy`, 443, OTHER)).toBe(OTHER);
  }, 300_000);
});
