// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are JavaScript and shell run in containers, not this file's templates.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { generateP256, selfSignedClientCertificate } from "@opscrew/core";
import { DeployPlanSchema } from "@opscrew/plan-schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IMAGES } from "../pins";
import { switchApp } from "../workflow/switch";
import { localhostPlan } from "./__fixtures__/localhost";
import {
  OPENLITESPEED_CAPABILITIES,
  OPENLITESPEED_CATCH_ALL,
  OPENLITESPEED_CHECK,
  OPENLITESPEED_ERROR_PAGE,
  OPENLITESPEED_INPUT,
  OPENLITESPEED_LOOP,
  OPENLITESPEED_RELOAD,
  openlitespeedAdditionsFile,
  openlitespeedCachePurge,
  openlitespeedConf,
  openlitespeedSite,
} from "./openlitespeed";

/*
 * Runs the OpenLiteSpeed edge's pinned image as Compose runs it (Docker's init, OpsCrew's loop,
 * only the capabilities it keeps, the read-only mounts), with the sites of two apps on one server:
 * a proxied app with origin TLS, and a DNS-only app on certbot's certificate with additions. The
 * certificates are placeholders made at test time; Cloudflare's client certificate is OpsCrew's
 * own as it makes it for an OpenLiteSpeed edge (`selfSignedClientCertificate` with keyCertSign,
 * which OpenLiteSpeed's BoringSSL needs to trust it). The check and the graceful restart are the
 * edge's own scripts, mounted where its Compose configs put them. Cloudflare's ranges are a part of the test network's, where one curl container stands
 * in for Cloudflare. A small Node server stands in for kamal-proxy: it answers with the request it
 * got, and greets a WebSocket. A curl container on the same network checks what visitors get. Pulls
 * the images, so it runs only with OPSCREW_DOCKER_TESTS=1.
 */

function skipReason(): string | undefined {
  if (process.env.OPSCREW_DOCKER_TESTS !== "1") return "set OPSCREW_DOCKER_TESTS=1 to run it";
  const version = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], {
    encoding: "utf8",
  });
  return version.status === 0 ? undefined : "Docker is not available";
}

const reason = skipReason();
if (reason) console.warn(`[iac-templates] skipping the OpenLiteSpeed edge (Docker): ${reason}`);

/** A self-signed P-256 certificate and its key, made now. */
function placeholder(commonName: string): { certificate: string; key: string } {
  const key = generateP256().privateKey;
  return { certificate: selfSignedClientCertificate({ key, commonName, days: 1 }), key };
}

/** kamal-proxy's stand-in: the request as JSON, and a WebSocket that is greeted once. */
const APP = [
  'import { createHash } from "node:crypto";',
  'import { createServer } from "node:http";',
  "const server = createServer((req, res) => {",
  '  const cache = req.url === "/cached" ? { "X-LiteSpeed-Cache-Control": "public,max-age=60" } : {};',
  '  res.writeHead(200, { "Content-Type": "application/json", ...cache });',
  "  res.end(JSON.stringify({ url: req.url, headers: req.headers, at: process.hrtime.bigint().toString() }));",
  "});",
  'server.on("upgrade", (req, socket) => {',
  '  const key = `${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`;',
  '  const accept = createHash("sha1").update(key).digest("base64");',
  "  socket.write(`HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: ${accept}\\r\\n\\r\\n`);",
  '  const text = Buffer.from("hello from the app");',
  "  socket.write(Buffer.concat([Buffer.from([0x81, text.length]), text]));",
  "});",
  "server.listen(80);",
  "",
].join("\n");

/** The DNS-only app, with the user's additions. */
const BLOG = {
  app: "blog",
  mode: "direct",
  hosts: ["blog.example.com"],
  additions: {
    file: openlitespeedAdditionsFile("blog"),
    source: "opscrew/proxy/additions.openlitespeed",
  },
} as const;

/** A WebSocket client: prints the first message, or fails. */
const WS_CLIENT = [
  "const ws = new WebSocket(process.argv[1]);",
  "setTimeout(() => { console.log('timeout'); process.exit(2); }, 15000);",
  "ws.onmessage = (e) => { console.log(String(e.data)); process.exit(0); };",
  "ws.onerror = () => { console.log('error'); process.exit(1); };",
].join("\n");

describe.skipIf(reason !== undefined)("the OpenLiteSpeed edge (OPSCREW_DOCKER_TESTS=1)", () => {
  const id = `opscrew-test-openlitespeed-${process.pid}-${Date.now()}`;
  let work = "";
  /** The address of the container that stands in for Cloudflare, in its trusted range. */
  let cloudflare = "";

  /** Runs `args` with Docker, as the test's network sees it. */
  const docker = (args: string[], timeout = 120_000) => {
    const run = spawnSync("docker", args, { encoding: "utf8", timeout });
    return { status: run.status, stdout: run.stdout.replaceAll("\r", ""), stderr: run.stderr };
  };

  /**
   * Runs `script` in the pinned curl image on the test network, with the client certificate; from
   * `ip` when given.
   */
  const curl = (script: string, ip?: string) =>
    docker([
      "run",
      "--rm",
      "--network",
      id,
      ...(ip === undefined ? [] : ["--ip", ip]),
      "-v",
      `${join(work, "client")}:/client:ro`,
      "--entrypoint",
      "sh",
      IMAGES.curl.ref,
      "-c",
      script,
    ]);

  /** A request to `host` over HTTPS, its headers on stdout and its body in /tmp/body. */
  const https = (host: string, extra = "", path = "/") =>
    `curl -sSk -D - -o /tmp/body --connect-to ${host}:443:openlitespeed:443 ${extra} https://${host}${path}`;

  /** The same over HTTP. */
  const http = (host: string, path = "/") =>
    `curl -sS -D - -o /tmp/body --connect-to ${host}:80:openlitespeed:80 http://${host}${path}`;

  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), "opscrew-openlitespeed-edge-"));
    expect(docker(["network", "create", id]).status).toBe(0);
    // Cloudflare's ranges: the last quarter of the network's first 256 addresses, which Docker gives
    // none of the test's other containers (it counts up from the start).
    const subnet = docker([
      "network",
      "inspect",
      id,
      "--format",
      "{{(index .IPAM.Config 0).Subnet}}",
    ]).stdout.trim();
    const base = subnet.slice(0, subnet.lastIndexOf("."));
    cloudflare = `${base}.200`;
    const origin = placeholder("shop.example.com");
    const certbot = placeholder("blog.example.com");
    // The client certificate Cloudflare presents for the shop, as OpsCrew makes it; its trust pool.
    const clientKey = generateP256().privateKey;
    const client = {
      key: clientKey,
      certificate: selfSignedClientCertificate({
        key: clientKey,
        commonName: "opscrew-shop",
        days: 1,
        keyCertSign: true,
      }),
    };
    const sites = {
      ...openlitespeedSite({
        app: "shop",
        mode: "direct",
        hosts: ["shop.example.com"],
        origin: ["shop.example.com"],
      }),
      ...openlitespeedSite(BLOG),
    };
    const files: Record<string, string> = {
      "etc/httpd_config.conf": openlitespeedConf(false, [`${base}.192/26`, "2400:cb00::/32"]),
      "etc/catchall.conf": OPENLITESPEED_CATCH_ALL,
      "etc/error.html": OPENLITESPEED_ERROR_PAGE,
      "etc/check.sh": OPENLITESPEED_CHECK,
      "etc/reload.sh": OPENLITESPEED_RELOAD,
      ...Object.fromEntries(
        Object.entries(sites).map(([name, lines]) => [`sites/${name}`, lines.join("\n")]),
      ),
      "sites/blog.additions":
        'context /api/ {\n  type                    proxy\n  handler                 kamal-proxy\n  extraHeaders            <<<END_extraHeaders\nHeader set Cache-Control "no-store"\n  END_extraHeaders\n}\n',
      "tls/shop/origin.pem": origin.certificate,
      "tls/shop/origin.key": origin.key,
      "tls/shop/pull.pem": client.certificate,
      "client/client.pem": client.certificate,
      "client/client.key": client.key,
      "letsencrypt/live/blog/fullchain.pem": certbot.certificate,
      "letsencrypt/live/blog/privkey.pem": certbot.key,
      "app/app.mjs": APP,
    };
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(work, path)), { recursive: true });
      writeFileSync(join(work, path), content);
    }
    const app = docker([
      "run",
      "-d",
      "--name",
      `${id}-app`,
      "--network",
      id,
      "--network-alias",
      "kamal-proxy",
      "-v",
      `${join(work, "app")}:/app:ro`,
      IMAGES.nodeAlpine.ref,
      "node",
      "/app/app.mjs",
    ]);
    expect(app.status, app.stderr).toBe(0);
    const mount = (from: string, to: string) => ["-v", `${join(work, from)}:${to}:ro`];
    const started = docker(
      [
        "run",
        "-d",
        "--name",
        id,
        "--network",
        id,
        ...["openlitespeed", "shop.example.com", "blog.example.com"].flatMap((alias) => [
          "--network-alias",
          alias,
        ]),
        "--init",
        "--security-opt",
        "no-new-privileges:true",
        "--cap-drop",
        "ALL",
        ...OPENLITESPEED_CAPABILITIES.flatMap((capability) => ["--cap-add", capability]),
        ...mount("etc/httpd_config.conf", OPENLITESPEED_INPUT.conf),
        ...mount("etc/catchall.conf", OPENLITESPEED_INPUT.catchAll),
        ...mount("etc/error.html", OPENLITESPEED_INPUT.errorPage),
        ...mount("etc/check.sh", OPENLITESPEED_INPUT.check),
        ...mount("etc/reload.sh", OPENLITESPEED_INPUT.reload),
        ...mount("sites", OPENLITESPEED_INPUT.sites),
        ...mount("tls", OPENLITESPEED_INPUT.tls),
        ...mount("letsencrypt", "/etc/letsencrypt"),
        "--entrypoint",
        "sh",
        IMAGES.openlitespeed.ref,
        "-c",
        OPENLITESPEED_LOOP,
      ],
      600_000,
    );
    expect(started.status, started.stderr).toBe(0);
    // Ready once OpenLiteSpeed answers.
    const ready = curl(
      "for i in $(seq 1 60); do if curl -s -m 5 -o /dev/null http://openlitespeed/ -H 'Host: blog.example.com'; then exit 0; fi; sleep 1; done; exit 1",
    );
    expect(ready.status, docker(["logs", id]).stderr).toBe(0);
  }, 900_000);

  afterAll(() => {
    docker(["rm", "-f", id, `${id}-app`]);
    docker(["network", "rm", id]);
    if (work) rmSync(work, { recursive: true, force: true });
  }, 180_000);

  it("refuses an unknown hostname with 403 and OpsCrew's page, on HTTP and HTTPS, and a www twin too", () => {
    for (const request of [
      http("other.example.com"),
      https("other.example.com"),
      http("www.blog.example.com"),
    ]) {
      const run = curl(`${request} && cat /tmp/body`);
      expect(run.stdout, request).toMatch(/^HTTP\/[12](\.1)? 403/);
      expect(run.stdout).toContain(OPENLITESPEED_ERROR_PAGE);
      expect(run.stdout.toLowerCase()).not.toContain("litespeed");
    }
  }, 180_000);

  it("redirects a known hostname to HTTPS with 308", () => {
    for (const host of ["blog.example.com", "shop.example.com"]) {
      const run = curl(http(host, "/a?b=1"));
      expect(run.stdout).toMatch(/^HTTP\/1\.1 308 /);
      expect(run.stdout.toLowerCase()).toContain(`\nlocation: https://${host}/a?b=1\n`);
    }
  }, 180_000);

  it("sends HSTS and the baseline headers, no Server header, and the app its own forwarded headers", () => {
    const spoofed = [
      "-H 'X-Forwarded-For: 203.0.113.9'",
      "-H 'X-Forwarded-Host: evil.example'",
      "-H 'X-Forwarded-Proto: http'",
    ].join(" ");
    const run = curl(`${https("blog.example.com", spoofed)} && cat /tmp/body`);
    const response = run.stdout.toLowerCase();
    expect(response).toMatch(/^http\/2 200/);
    expect(response).toContain(
      "\nstrict-transport-security: max-age=31536000; includesubdomains\n",
    );
    expect(response).toContain("\nx-content-type-options: nosniff\n");
    expect(response).toContain("\nx-frame-options: sameorigin\n");
    expect(response).toContain("\nreferrer-policy: strict-origin-when-cross-origin\n");
    expect(response).not.toMatch(/\nserver:/);
    const sent = JSON.parse(run.stdout.slice(run.stdout.indexOf("{"))) as {
      headers: Record<string, string>;
    };
    expect(sent.headers["x-forwarded-for"]).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    expect(sent.headers["x-forwarded-host"]).toBe("blog.example.com");
    expect(sent.headers["x-forwarded-proto"]).toBe("https");
    expect(sent.headers.host).toBe("blog.example.com");
    // OpenLiteSpeed drops the client's X-Forwarded-For by blanking its name: its value still reaches
    // the app, but only under a name of `x`s, which no app reads. The other two are gone.
    const carrying = Object.entries(sent.headers)
      .filter(([, value]) => /203\.0\.113\.9|evil\.example/.test(value))
      .map(([name]) => name);
    expect(carrying).toEqual(["xxxxxxxxxxxxxxx"]);
  }, 180_000);

  it("offers TLS 1.2 and 1.3 only", () => {
    expect(curl(https("blog.example.com", "--tlsv1.1 --tls-max 1.1")).status).toBe(35);
    expect(curl(https("blog.example.com", "--tlsv1.2 --tls-max 1.2")).status).toBe(0);
    expect(curl(https("blog.example.com", "--tlsv1.3")).status).toBe(0);
  }, 180_000);

  it("requires Cloudflare's client certificate for a proxied hostname, OpsCrew's own accepted", () => {
    expect(curl(https("shop.example.com")).status).not.toBe(0);
    const run = curl(
      https("shop.example.com", "--cert /client/client.pem --key /client/client.key"),
    );
    expect(run.stdout.toLowerCase()).toMatch(/^http\/2 200/);
  }, 180_000);

  it("takes the visitor's address from CF-Connecting-IP only on requests from Cloudflare's ranges", () => {
    /** The X-Forwarded-For the app got for a request from `ip` with Cloudflare's headers. */
    const forwarded = (ip?: string) => {
      const headers = "-H 'CF-Connecting-IP: 203.0.113.5' -H 'X-Forwarded-For: 198.51.100.7'";
      const run = curl(`${https("blog.example.com", headers)} > /dev/null && cat /tmp/body`, ip);
      const sent = JSON.parse(run.stdout) as { headers: Record<string, string> };
      return sent.headers["x-forwarded-for"];
    };
    expect(forwarded(cloudflare)).toBe("203.0.113.5");
    const other = forwarded();
    expect(other).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    expect(other).not.toBe("203.0.113.5");
    expect(other).not.toBe("198.51.100.7");
  }, 180_000);

  it("shows `secure`'s checks from the server a refusal without the client certificate, and a 403 for an unknown name", () => {
    /** `openssl s_client` from the edge's own container, as `secure` runs it on the server. */
    const handshake = (host: string) =>
      docker([
        "exec",
        id,
        "sh",
        "-c",
        `printf 'GET / HTTP/1.1\\r\\nHost: %s\\r\\nConnection: close\\r\\n\\r\\n' '${host}' | timeout 15 openssl s_client -connect 127.0.0.1:443 -servername '${host}' -tls1_3 -ign_eof 2>&1`,
      ]).stdout;
    const proxied = handshake("shop.example.com");
    expect(proxied).toMatch(/^CONNECTED\(/m);
    expect(proxied).toMatch(/alert certificate required|SSL alert number 116/);
    expect(proxied).not.toMatch(/^HTTP\/\d/m);
    const unknown = handshake("unknown.opscrew.invalid");
    expect(unknown).toMatch(/^HTTP\/1\.1 403 /m);
    expect(unknown).toMatch(/subject=CN ?= ?default\.invalid/);
  }, 180_000);

  it("serves the user's additions with the site's headers", () => {
    const run = curl(https("blog.example.com", "", "/api/x"));
    expect(run.stdout.toLowerCase()).toMatch(/^http\/2 200/);
    expect(run.stdout.toLowerCase()).toContain("\ncache-control: no-store\n");
    expect(run.stdout.toLowerCase()).toContain(
      "\nstrict-transport-security: max-age=31536000; includesubdomains\n",
    );
  }, 180_000);

  it("carries a WebSocket to the app", () => {
    const run = docker([
      "run",
      "--rm",
      "--network",
      id,
      "-e",
      "NODE_TLS_REJECT_UNAUTHORIZED=0",
      "-e",
      "NODE_NO_WARNINGS=1",
      IMAGES.nodeAlpine.ref,
      "node",
      "-e",
      WS_CLIENT,
      "wss://blog.example.com/socket",
    ]);
    expect(run.stdout.trim(), run.stderr).toBe("hello from the app");
  }, 180_000);

  it("refuses a missing certificate and an error before a restart, which keeps the running one", () => {
    const reload = () => docker(["exec", id, "sh", "-c", OPENLITESPEED_RELOAD]);
    const key = join(work, "letsencrypt/live/blog/privkey.pem");
    renameSync(key, `${key}.away`);
    const missing = reload();
    renameSync(`${key}.away`, key);
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain(
      "these certificate files are missing or empty: /etc/letsencrypt/live/blog/privkey.pem",
    );
    const vhconf = join(work, "sites/blog.vhconf");
    const good = openlitespeedSite(BLOG);
    writeFileSync(
      vhconf,
      (good["blog.vhconf"] ?? [])
        .join("\n")
        .replace("handler                 kamal-proxy", "handler                 nowhere"),
    );
    const broken = reload();
    writeFileSync(vhconf, (good["blog.vhconf"] ?? []).join("\n"));
    expect(broken.status).toBe(2);
    expect(broken.stderr).toContain("Can not find handler");
    expect(curl(https("blog.example.com")).stdout).toMatch(/^HTTP\/2 200/);
    expect(reload().status).toBe(0);
  }, 180_000);

  it("keeps only what the app asks it to, and forgets it on a purge", () => {
    const cache = () =>
      curl(
        `${https("blog.example.com", "", "/cached")} | tr -d '\\r' | grep -i '^x-litespeed-cache:'`,
      )
        .stdout.trim()
        .toLowerCase();
    cache();
    expect(cache()).toBe("x-litespeed-cache: hit");
    expect(curl(`${https("blog.example.com", "", "/other")}`).stdout.toLowerCase()).not.toContain(
      "x-litespeed-cache:",
    );
    expect(docker(["exec", id, "sh", "-c", openlitespeedCachePurge("blog")]).status).toBe(0);
    expect(cache()).toBe("x-litespeed-cache: miss");
  }, 180_000);

  it("after a switch, empties the app's cache and restarts gracefully under the edge's lock, and only says so on a refusal", () => {
    // The lines that end a switch on this computer's edge (its lock only where flock exists), with
    // `edge exec -T openlitespeed` reaching this container.
    const local = localhostPlan({ edge: "openlitespeed" });
    const plan = DeployPlanSchema.parse({ ...local, app: { ...local.app, name: "blog" } });
    const script = [
      "set -eu",
      `EDGE_DIR=${work.replaceAll("\\", "/")}`,
      `edge() { shift 3; docker exec -i ${id} "$@"; }`,
      ...switchApp(plan, "", []).slice(-6),
      "echo finished",
    ].join("\n");
    const after = () =>
      spawnSync("bash", ["-c", script], {
        encoding: "utf8",
        env: { ...process.env, MSYS_NO_PATHCONV: "1" },
        timeout: 120_000,
      });
    const cache = () =>
      curl(
        `${https("blog.example.com", "", "/cached")} | tr -d '\\r' | grep -i '^x-litespeed-cache:'`,
      )
        .stdout.trim()
        .toLowerCase();
    const pid = () => docker(["exec", id, "cat", "/tmp/lshttpd/lshttpd.pid"]).stdout.trim();
    cache();
    expect(cache()).toBe("x-litespeed-cache: hit");
    const before = pid();
    const done = after();
    expect(done.status, done.stderr).toBe(0);
    expect(done.stdout).toContain("finished");
    expect(done.stdout).not.toContain("::error::");
    expect(cache()).toBe("x-litespeed-cache: miss");
    // A graceful restart: a new main process, whose pid file is empty for a moment.
    const restarted = docker(
      [
        "exec",
        id,
        "sh",
        "-c",
        `for i in $(seq 1 20); do p="$(cat /tmp/lshttpd/lshttpd.pid 2> /dev/null)"; if [ -n "$p" ] && [ "$p" != ${before} ]; then exit 0; fi; sleep 1; done; exit 1`,
      ],
      60_000,
    );
    expect(restarted.status).toBe(0);
    // A configuration the check refuses: the error says so, the script goes on, the site serves.
    const vhconf = join(work, "sites/blog.vhconf");
    const good = (openlitespeedSite(BLOG)["blog.vhconf"] ?? []).join("\n");
    writeFileSync(
      vhconf,
      good.replace("handler                 kamal-proxy", "handler                 nowhere"),
    );
    const refused = after();
    writeFileSync(vhconf, good);
    expect(refused.status, refused.stderr).toBe(0);
    expect(refused.stdout).toContain(
      "::error::The new version of blog serves, but OpenLiteSpeed did not empty the app's page cache or did not restart after the switch, so it keeps its running configuration.",
    );
    expect(refused.stdout).toContain("finished");
    expect(curl(https("blog.example.com")).stdout).toMatch(/^HTTP\/2 200/);
    expect(docker(["exec", id, "sh", OPENLITESPEED_INPUT.reload]).status).toBe(0);
  }, 300_000);
});
