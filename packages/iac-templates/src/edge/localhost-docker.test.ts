import { spawnSync } from "node:child_process";
import { createPrivateKey } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { generateP256, localCaCertificate, signedLeafCertificate } from "@opscrew/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { testContext } from "../__fixtures__/plans";
import { IMAGES } from "../pins";
import { renderEdgeSite } from "../runtime";
import { localhostPlan } from "./__fixtures__/localhost";
import { EDGE_PROXIES, type EdgeProxy, localhostHostname, renderEdgeCompose } from "./index";
import { NGINX_LOOP, NGINX_PORTS } from "./nginx";

/*
 * Runs the localhost edge's proxy as its Compose file has it (the main configuration, then the
 * sites of two localhost environments with their leaf certificates from a local CA made now),
 * published on 127.0.0.1 only, and connects to 127.0.0.1 with the hostname as SNI and Host header,
 * as OpsCrew's own checks do. kamal-proxy is absent, so the app answers 502. Pulls the images, so
 * it runs only with OPSCREW_DOCKER_TESTS=1.
 */

function skipReason(): string | undefined {
  if (process.env.OPSCREW_DOCKER_TESTS !== "1") return "set OPSCREW_DOCKER_TESTS=1 to run it";
  const version = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], {
    encoding: "utf8",
  });
  return version.status === 0 ? undefined : "Docker is not available";
}

const reason = skipReason();
if (reason) console.warn(`[iac-templates] skipping the localhost edge (Docker): ${reason}`);

/** What a request through 127.0.0.1 got: the status and the headers. */
interface Answer {
  status: number;
  headers: http.IncomingHttpHeaders;
}

/** GET `https://<host><path>` through 127.0.0.1:`port`, trusting only `ca`. */
function httpsGet(port: number, host: string, ca: string, path = "/"): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const request = https.request(
      { host: "127.0.0.1", port, servername: host, path, headers: { host }, ca, agent: false },
      (response) => {
        response.resume();
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, headers: response.headers }),
        );
      },
    );
    request.setTimeout(10_000, () => request.destroy(new Error("timed out")));
    request.on("error", reject);
    request.end();
  });
}

/** GET `http://<host><path>` through 127.0.0.1:`port`. */
function httpGet(port: number, host: string, path = "/"): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: "127.0.0.1", port, path, headers: { host }, agent: false },
      (response) => {
        response.resume();
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, headers: response.headers }),
        );
      },
    );
    request.setTimeout(10_000, () => request.destroy(new Error("timed out")));
    request.on("error", reject);
    request.end();
  });
}

/** The host port Docker published the container's `port` on (`127.0.0.1:<port>`). */
function published(container: string, port: number): number {
  const out = spawnSync("docker", ["port", container, `${port}/tcp`], { encoding: "utf8" });
  return Number(out.stdout.trim().split(":").at(-1));
}

describe.skipIf(reason !== undefined).each(["caddy", "nginx"] as const)(
  "the localhost edge on %s (OPSCREW_DOCKER_TESTS=1)",
  (proxy: EdgeProxy) => {
    const id = `opscrew-test-localhost-${proxy}-${process.pid}-${Date.now()}`;
    const now = new Date();
    const caKey = createPrivateKey(generateP256().privateKey);
    const ca = localCaCertificate(caKey, { commonName: "OpsCrew local CA (test)", days: 1, now });
    const options = { edge: proxy, ports: { https: 8443, http: 8080 } } as const;
    const prod = localhostPlan(options);
    const staging = localhostPlan({ ...options, environment: "staging" });
    let work = "";
    const ports = { http: 0, https: 0 };

    beforeAll(() => {
      work = mkdtempSync(join(tmpdir(), "opscrew-localhost-edge-"));
      const files: Record<string, string> = {};
      for (const plan of [prod, staging]) {
        const hostname = localhostHostname(plan, true);
        const [site] = renderEdgeSite(plan, { ...testContext(), localhost: { hostname } });
        const key = generateP256().privateKey;
        const app = plan.app.name;
        files[`sites/${app}.${EDGE_PROXIES[proxy].site}`] = site?.content ?? "";
        files[`tls/${app}/local.pem`] = signedLeafCertificate({
          caKey,
          caCertificate: ca,
          key: createPrivateKey(key),
          hostnames: [hostname],
          days: 1,
          now,
        });
        files[`tls/${app}/local.key`] = key;
      }
      const configs: Record<string, { content: string }> = parse(
        renderEdgeCompose(prod).content,
      ).configs;
      const main = configs[proxy === "caddy" ? "caddyfile" : "nginx-conf"]?.content ?? "";
      files.main = main.replaceAll("$$", "$");
      for (const [path, content] of Object.entries(files)) {
        mkdirSync(dirname(join(work, path)), { recursive: true });
        writeFileSync(join(work, path), content);
      }
      expect(spawnSync("docker", ["network", "create", id], { encoding: "utf8" }).status).toBe(0);
      const inner = proxy === "caddy" ? { http: 80, https: 443 } : NGINX_PORTS;
      const dir = proxy === "caddy" ? "/etc/caddy" : "/etc/nginx";
      const run =
        proxy === "caddy"
          ? [
              "-v",
              `${join(work, "main")}:/etc/caddy/Caddyfile:ro`,
              IMAGES.caddy.ref,
              "caddy",
              "run",
              "--config",
              "/etc/caddy/Caddyfile",
              "--adapter",
              "caddyfile",
            ]
          : [
              "--user",
              "1000:1000",
              "--init",
              "-v",
              `${join(work, "main")}:/etc/nginx/nginx.conf:ro`,
              "--entrypoint",
              "sh",
              IMAGES.nginx.ref,
              "-c",
              NGINX_LOOP,
            ];
      const started = spawnSync(
        "docker",
        [
          "run",
          "-d",
          "--name",
          id,
          "--network",
          id,
          "-p",
          `127.0.0.1::${inner.http}`,
          "-p",
          `127.0.0.1::${inner.https}`,
          "-v",
          `${join(work, "sites")}:${dir}/sites:ro`,
          "-v",
          `${join(work, "tls")}:${dir}/tls:ro`,
          ...run,
        ],
        { encoding: "utf8", timeout: 240_000 },
      );
      expect(started.status, started.stderr).toBe(0);
      ports.http = published(id, inner.http);
      ports.https = published(id, inner.https);
    }, 300_000);

    afterAll(() => {
      spawnSync("docker", ["rm", "-f", id]);
      spawnSync("docker", ["network", "rm", id]);
      if (work) rmSync(work, { recursive: true, force: true });
    });

    /** The first answer to `request` within 30 seconds, while the proxy starts. */
    async function ready<T>(request: () => Promise<T>): Promise<T> {
      for (let attempt = 0; ; attempt++) {
        try {
          return await request();
        } catch (error) {
          if (attempt >= 30) throw error;
          await new Promise((resolve) => setTimeout(resolve, 1_000));
        }
      }
    }

    it("serves each environment at its hostname with its leaf certificate from the local CA", async () => {
      for (const host of ["prod.shop.localhost", "staging.shop.localhost"]) {
        const answer = await ready(() => httpsGet(ports.https, host, ca));
        expect(answer.status).toBe(502);
        // The baseline headers, without HSTS, and no HTTP/3 offered.
        expect(answer.headers["x-content-type-options"]).toBe("nosniff");
        expect(answer.headers["strict-transport-security"]).toBeUndefined();
        expect(answer.headers["alt-svc"]).toBeUndefined();
      }
    }, 60_000);

    it("refuses a hostname it has no site for in the TLS handshake", async () => {
      await ready(() => httpsGet(ports.https, "prod.shop.localhost", ca));
      await expect(httpsGet(ports.https, "other.localhost", ca)).rejects.toThrow();
    }, 60_000);

    it("redirects HTTP to HTTPS on the target's HTTPS port", async () => {
      const answer = await ready(() => httpGet(ports.http, "staging.shop.localhost", "/a?b=1"));
      expect(answer.status).toBe(308);
      expect(answer.headers.location).toBe("https://staging.shop.localhost:8443/a?b=1");
    }, 60_000);

    it.skipIf(proxy !== "caddy")(
      "obtains no certificate: Caddy uses the leaf certificates",
      async () => {
        await ready(() => httpsGet(ports.https, "prod.shop.localhost", ca));
        const logs = spawnSync("docker", ["logs", id], { encoding: "utf8" });
        const text = `${logs.stdout}${logs.stderr}`;
        expect(
          text.match(
            /skipping automatic certificate management because one or more matching certificates are already loaded/g,
          ),
        ).toHaveLength(2);
        expect(text).not.toMatch(/obtain|acme/i);
      },
      60_000,
    );
  },
);
