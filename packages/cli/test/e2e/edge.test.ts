/**
 * Feature 014's Docker pass over the shared edge (quickstart.md "Local Docker pass" 1-3, and
 * certbot's failed renewal for `status`): `examples/hono-api` is designed by the real CLI for a
 * Hetzner server, then edited as a user would (the proxy, `shop.example.com` and its `www`,
 * DNS-only), and the edge OpsCrew renders for it (`deploymentFiles`, what provision writes) runs on
 * this computer with the deploy's own commands from the rendered workflow (`LocalEdge`). Pebble
 * stands in for Let's Encrypt, a local CA for Cloudflare's Origin CA, and a small Node.js app
 * (`standInScript`) for the app behind kamal-proxy. On each proxy:
 * - the site gets its first certificate from Pebble for exactly the app's hostnames, and serves
 *   the app (nginx: through certbot, with the site before the first certificate, and the renewal
 *   setting at the top of certbot's renewal file);
 * - a hostname no app serves is refused on HTTP and in the TLS handshake;
 * - the headers and the TLS versions visitors see are recorded, then compared across the proxies;
 * - a WebSocket reaches the app through the proxy and kamal-proxy ("Spike results" 5);
 * - a proxied app with origin TLS (a certificate from OpsCrew's own request, signed by the local
 *   CA) refuses a client without Cloudflare's client certificate, serves one with it, and presents
 *   a certificate for exactly its hostnames;
 * - a header addition is served; an unsafe one is refused by OpsCrew's rules; a broken one on the
 *   server is refused by the deploy's reload, and the proxy keeps serving what it served.
 * On nginx also: `certbot renew --force-renewal` under a request loop has no failed request and
 * nginx then serves the new certificate; a renewal that fails (Pebble unreachable) leaves the lines
 * `status` reads in certbot's log, and `status` (`tlsStatusReport`) shows certbot's reason.
 * Then the switch from Caddy to nginx on a server with one app, under a request loop: the HTTPS
 * interruption is measured and must stay under the minute the plan states for DNS-only hostnames,
 * and kamal-proxy keeps running.
 *
 * Covered elsewhere, so not repeated here: each proxy's checker on the rendered edge and broken
 * additions refused by the deploy job's check step (`iac-templates` `edge-check.test.ts`), nginx's
 * catch-all and headers on its own error pages (`nginx-validate.test.ts`), Caddy's validation of
 * every site form (`caddy-validate.test.ts`), the visitor's address behind Cloudflare
 * (`real-ip.test.ts`), the `vercel.json` routes (`vercel-routing.test.ts`), and every rule of the
 * additions (`secops` `rules.test.ts`).
 *
 * Gated like the Docker pass: OPSCREW_DOCKER_TESTS=1 with a running Docker daemon, git and a POSIX
 * shell (origin TLS also needs OpenSSL). Every container carries the label
 * `opscrew.test=docker-pass`; the network, the edges' Compose projects and their volumes are
 * removed afterwards.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import tls from "node:tls";
import { recordServerAddress, tlsStatusReport } from "@opscrew/agents";
import { createTestPhaseDeps } from "@opscrew/agents/testing";
import { generateP256, NodeCommandRunner, selfSignedClientCertificate } from "@opscrew/core";
import { EDGE_PROJECT, EDGE_PROXIES, type EdgeProxy, siteHosts } from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import { certbotFailureCommand, parseCertbotFailure, scanProxyAdditions } from "@opscrew/secops";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { GIT, type TempProject } from "../../src/ui/__fixtures__/harness";
import { docker, dockerSkipReason, LABEL, TEN_MINUTES, TWO_MINUTES } from "./docker-support";
import {
  designedPlan,
  dockerOk,
  freePort,
  type HttpsAnswer,
  httpGet,
  httpsGet,
  LocalCa,
  LocalEdge,
  OPENSSL,
  type Pebble,
  requestLoop,
  SH,
  shell,
  startPebble,
  startStandIn,
  tempDir,
  unique,
  until,
  WEBSOCKET_HELLO,
  websocketHello,
  withSite,
} from "./edge-support";

const SKIP =
  dockerSkipReason() ??
  (GIT === undefined ? "git is not installed" : undefined) ??
  (SH === undefined ? "no POSIX shell (sh) is installed" : undefined);
if (SKIP !== undefined) console.warn(`Skipping the edge's Docker pass: ${SKIP}.`);
const NO_OPENSSL = OPENSSL === undefined ? "OpenSSL is not installed" : undefined;
if (SKIP === undefined && NO_OPENSSL !== undefined) {
  console.warn(`Skipping origin TLS with a local CA in the edge's Docker pass: ${NO_OPENSSL}.`);
}

const SHOP = "shop.example.com";
const WWW = `www.${SHOP}`;
const BLOG = "blog.example.com";
/** The app's port in the plan (hono-api listens on 3000). */
const APP_PORT = 3000;
/** The headers both proxies must send alike on the app's answers (FR-1442). */
const SECURITY_HEADERS = [
  "strict-transport-security",
  "x-content-type-options",
  "x-frame-options",
  "referrer-policy",
  "alt-svc",
] as const;

/** What a visitor sees from one proxy, for the comparison. */
interface Seen {
  headers: Record<string, string | undefined>;
  tls: Record<string, boolean>;
  unknownHttp: string;
  unknownTls: string;
  redirect: { status: number; location: string | undefined };
}

/** The issuer's common name of a served certificate. */
function issuer(answer: HttpsAnswer): string {
  const cn = answer.certificate.issuer?.CN;
  return Array.isArray(cn) ? cn.join(",") : (cn ?? "");
}

/** The DNS names a served certificate covers, sorted. */
function names(certificate: tls.PeerCertificate): string[] {
  return (certificate.subjectaltname ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith("DNS:"))
    .map((entry) => entry.slice(4))
    .sort();
}

/** Whether a TLS handshake for `host` on 127.0.0.1:`port` with only `version` succeeds. */
function handshake(port: number, host: string, version: tls.SecureVersion): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = tls.connect({
      host: "127.0.0.1",
      port,
      servername: host,
      rejectUnauthorized: false,
      minVersion: version,
      maxVersion: version,
      ...(version === "TLSv1" || version === "TLSv1.1" ? { ciphers: "DEFAULT:@SECLEVEL=0" } : {}),
    });
    socket.setTimeout(10_000, () => socket.destroy(new Error("timed out")));
    socket.once("secureConnect", () => {
      socket.end();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

/** How a request for a hostname no app serves ended: the error, or the status. */
async function refusal(request: () => Promise<{ status: number }>): Promise<string> {
  try {
    return `answered ${(await request()).status}`;
  } catch (error) {
    return `refused (${(error as NodeJS.ErrnoException).code ?? (error as Error).message})`;
  }
}

describe.skipIf(SKIP !== undefined)("the shared edge on Docker, with Pebble (014)", () => {
  let work = "";
  let network = "";
  let pebble: Pebble;
  let project: TempProject | undefined;
  let base: DeployPlan;
  const containers = new Set<string>();
  const edges = new Set<LocalEdge>();
  const seen: Partial<Record<EdgeProxy, Seen>> = {};

  beforeAll(async () => {
    work = await tempDir("opscrew-edge-pass-");
    network = unique("edge-net");
    await dockerOk(["network", "create", "--label", LABEL, network], "creating the network");
    pebble = await startPebble(network, work);
    containers.add(pebble.container);
    const designed = await designedPlan("hono-api", {
      domain: SHOP,
      dnsProvider: "cloudflare",
    });
    project = designed.project;
    base = designed.plan;
    expect(base.app.port).toBe(APP_PORT);
  }, TEN_MINUTES);

  afterAll(async () => {
    for (const edge of edges) await edge.remove();
    for (const container of containers) await docker(["rm", "-f", "-v", container]);
    if (network !== "") await docker(["network", "rm", network]);
    await project?.cleanup();
  }, TEN_MINUTES);

  /** A new edge on the test network, publishing on two free loopback ports. */
  async function newEdge(name: string): Promise<LocalEdge> {
    const dir = path.join(work, name);
    await mkdir(dir, { recursive: true });
    const edge = new LocalEdge(
      dir,
      network,
      { http: await freePort(), https: await freePort() },
      pebble,
    );
    edges.add(edge);
    return edge;
  }

  /** A stand-in app container answering `body`, routed on `edge` for `plan`. */
  async function standIn(edge: LocalEdge, plan: DeployPlan, body: string): Promise<void> {
    const container = unique(`app-${plan.app.name}`);
    await startStandIn(network, container, APP_PORT, body);
    containers.add(container);
    await edge.route(plan, `${container}:${APP_PORT}`);
  }

  describe.each(["caddy", "nginx"] as const)("on %s", (proxy) => {
    let edge: LocalEdge;
    let shop: DeployPlan;
    /** The keys this file made for origin TLS, which nothing OpsCrew prints may contain. */
    const keys: string[] = [];

    beforeAll(async () => {
      edge = await newEdge(proxy);
      shop = withSite(base, { edge: proxy, domain: SHOP, www: true, proxied: false });
      await edge.deploy({ plan: shop });
      await standIn(edge, shop, "shop ok");
    }, TEN_MINUTES);

    afterAll(async () => {
      await edge?.remove();
      edges.delete(edge);
    }, TWO_MINUTES);

    const get = (host: string, o: Parameters<typeof httpsGet>[2] = {}) =>
      httpsGet(edge.ports.https, host, o);

    it(
      "gets the first certificate from Pebble for exactly the app's hostnames and serves the app",
      async () => {
        const answer = await until(
          `${proxy}'s first certificate from Pebble`,
          async () => {
            const got = await get(SHOP);
            return issuer(got).startsWith("Pebble") ? got : undefined;
          },
          120_000,
        );
        expect(answer.status).toBe(200);
        expect(answer.body).toBe("shop ok");
        const www = await until(`${proxy}'s certificate for ${WWW}`, async () => {
          const got = await get(WWW);
          return issuer(got).startsWith("Pebble") ? got : undefined;
        });
        // certbot gets one certificate for both hostnames, Caddy one for each.
        if (proxy === "nginx") {
          expect(names(answer.certificate)).toEqual([SHOP, WWW].sort());
          expect(www.certificate.serialNumber).toBe(answer.certificate.serialNumber);
        } else {
          expect(names(answer.certificate)).toEqual([SHOP]);
          expect(names(www.certificate)).toEqual([WWW]);
        }
        // kamal-proxy sends www to the domain. Its redirect names http://, whatever the visitor
        // used (kamal-proxy v0.10.2, also with --forward-headers): reported to the lead.
        expect(www.status).toBe(301);
        expect(www.headers.location).toMatch(
          new RegExp(`^https?://${SHOP.replaceAll(".", "\\.")}/$`),
        );
        if (proxy === "nginx") {
          const renewal = await edge.compose(
            [
              "run",
              "--rm",
              "--no-deps",
              "-T",
              "--entrypoint",
              "cat",
              "certbot",
              `/etc/letsencrypt/renewal/${shop.app.name}.conf`,
            ],
            "reading certbot's renewal file",
          );
          expect(renewal.split("\n")[0]).toBe("renew_before_expiry = 45 days");
        }
      },
      TEN_MINUTES,
    );

    it(
      "refuses a hostname no app serves on HTTP and in the TLS handshake, and redirects HTTP",
      async () => {
        const unknownHttp = await refusal(() => httpGet(edge.ports.http, "other.example.com"));
        const unknownTls = await refusal(() => get("other.example.com"));
        expect(unknownHttp).toMatch(/^refused/);
        expect(unknownTls).toMatch(/^refused/);
        const redirect = await httpGet(edge.ports.http, SHOP, "/a?b=1");
        expect(redirect.status).toBe(308);
        expect(redirect.headers.location).toBe(`https://${SHOP}/a?b=1`);
        seen[proxy] = {
          headers: {},
          tls: {},
          unknownHttp: unknownHttp.replace(/\(.*\)/, ""),
          unknownTls: unknownTls.replace(/\(.*\)/, ""),
          redirect: { status: redirect.status, location: redirect.headers.location },
        };
      },
      TWO_MINUTES,
    );

    it(
      "sends the security headers without a version and offers TLS 1.2 and 1.3 only",
      async () => {
        const answer = await get(SHOP);
        const headers = Object.fromEntries(
          SECURITY_HEADERS.map((name) => [name, answer.headers[name] as string | undefined]),
        );
        expect(headers["strict-transport-security"]).toBe("max-age=31536000; includeSubDomains");
        expect(headers["x-content-type-options"]).toBe("nosniff");
        expect(headers["x-frame-options"]).toBe("SAMEORIGIN");
        expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
        expect(String(answer.headers.server ?? "")).not.toMatch(/\d/);
        const versions = Object.fromEntries(
          await Promise.all(
            (["TLSv1", "TLSv1.1", "TLSv1.2", "TLSv1.3"] as const).map(
              async (version) =>
                [version, await handshake(edge.ports.https, SHOP, version)] as const,
            ),
          ),
        );
        expect(versions).toEqual({
          TLSv1: false,
          "TLSv1.1": false,
          "TLSv1.2": true,
          "TLSv1.3": true,
        });
        const entry = seen[proxy];
        if (entry !== undefined) {
          entry.headers = headers;
          entry.tls = versions;
        }
      },
      TWO_MINUTES,
    );

    it(
      "passes a WebSocket through to the app, by kamal-proxy",
      async () => {
        expect(await websocketHello(edge.ports.https, SHOP)).toBe(WEBSOCKET_HELLO);
      },
      TWO_MINUTES,
    );

    it.skipIf(NO_OPENSSL !== undefined)(
      "serves origin TLS from the local CA only to a client with Cloudflare's client certificate",
      async () => {
        const blog = withSite(base, {
          edge: proxy,
          name: "blog",
          domain: BLOG,
          www: false,
          proxied: true,
        });
        const ca = await LocalCa.create(path.join(work, `ca-${proxy}`));
        const origin = await ca.originCertificate(siteHosts(blog));
        const clientKey = generateP256().privateKey;
        const pull = selfSignedClientCertificate({
          key: clientKey,
          commonName: "opscrew-blog",
          days: 5475,
        });
        keys.push(origin.key, clientKey);
        await edge.deploy({ plan: blog, origin: { ...origin, pull } });
        await standIn(edge, blog, "blog ok");

        const withCertificate = await until("the origin TLS site", async () => {
          const got = await get(BLOG, { cert: pull, key: clientKey });
          return got.status === 200 ? got : undefined;
        });
        expect(withCertificate.body).toBe("blog ok");
        expect(names(withCertificate.certificate)).toEqual([BLOG]);
        expect(issuer(withCertificate)).toBe("Local Origin CA");
        // Without the client certificate: Caddy ends the handshake, nginx answers 400.
        const without = await refusal(() => get(BLOG));
        expect(without).toMatch(proxy === "caddy" ? /^refused/ : /^answered 400$/);
        // The DNS-only app next to it keeps its own certificate.
        expect(issuer(await get(SHOP))).toMatch(/^Pebble/);
      },
      TEN_MINUTES,
    );

    it(
      "serves a header addition; refuses an unsafe one by its rules and keeps serving through a broken one",
      async () => {
        const { upstream } = EDGE_PROXIES[proxy];
        const header =
          proxy === "caddy"
            ? 'header X-Opscrew-Addition "served"\n'
            : 'add_header X-Opscrew-Addition "served" always;\n';
        const unsafe =
          proxy === "caddy" ? "reverse_proxy other.example.com:80\n" : "autoindex on;\n";
        const broken = proxy === "caddy" ? "header {\n" : "add_header X-Broken;\n";
        const context = { proxy, hostnames: siteHosts(shop), upstream };
        expect(scanProxyAdditions(header, context)).toEqual([]);
        expect(scanProxyAdditions(unsafe, context).length).toBeGreaterThan(0);
        // A broken file passes the rules: the proxy's checker refuses it before the server.
        expect(scanProxyAdditions(broken, context)).toEqual([]);

        await edge.deploy({ plan: shop, additions: header });
        const served = await until("the header addition", async () => {
          const got = await get(SHOP);
          return got.headers["x-opscrew-addition"] === "served" ? got : undefined;
        });
        expect(served.headers["strict-transport-security"]).toBe(
          "max-age=31536000; includeSubDomains",
        );

        const file = path.join(edge.dir, "sites", `${shop.app.name}.additions`);
        await writeFile(file, broken);
        const reload = await edge.reload(shop);
        expect(reload.exitCode, "the reload with broken additions").not.toBe(0);
        const after = await get(SHOP);
        expect(after.status).toBe(200);
        expect(after.headers["x-opscrew-addition"]).toBe("served");
        // As the deploy puts the previous additions back.
        await writeFile(file, header);
      },
      TEN_MINUTES,
    );

    it.runIf(proxy === "nginx")(
      "renews with certbot renew --force-renewal under a request loop, with no failed request",
      async () => {
        const before = (await get(SHOP)).certificate.serialNumber;
        const loop = requestLoop(
          () => get(SHOP),
          (answer) => answer.status === 200,
        );
        const renew = renewCommand(await readFile(edge.project.file, "utf8"));
        await edge.compose(
          ["exec", "-T", "certbot", "sh", "-c", `${renew} --force-renewal`],
          "certbot renew --force-renewal",
          TEN_MINUTES,
        );
        // certbot's deploy hook leaves the flag; nginx's loop reloads within 5 seconds.
        const renewed = await until(
          "nginx serving the renewed certificate",
          async () => {
            const serial = (await get(SHOP)).certificate.serialNumber;
            return serial !== before ? serial : undefined;
          },
          60_000,
        );
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        const result = await loop.stop();
        expect(renewed).not.toBe(before);
        expect(result.failures, `${result.requests} requests`).toEqual([]);
        expect(result.requests).toBeGreaterThan(10);
      },
      TEN_MINUTES,
    );

    it.runIf(proxy === "nginx")(
      "logs a failed renewal in the lines status reads, and status shows certbot's reason",
      async () => {
        const renew = renewCommand(await readFile(edge.project.file, "utf8"));
        // Pebble unreachable: certbot cannot renew. The renewal runs in the certbot container
        // with its output in the container's log, as the loop's `certbot renew` runs there.
        await dockerOk(["network", "disconnect", network, pebble.container], "hiding Pebble");
        try {
          const failed = await edge.compose(
            [
              "exec",
              "-T",
              "certbot",
              "sh",
              "-c",
              `${renew} --force-renewal > /proc/1/fd/1 2>&1; echo "exit $?"`,
            ],
            "a renewal while Pebble is unreachable",
            TEN_MINUTES,
          );
          expect(failed.trim()).not.toBe("exit 0");
        } finally {
          await dockerOk(
            ["network", "connect", "--alias", "pebble", network, pebble.container],
            "bringing Pebble back",
          );
        }
        const app = shop.app.name;
        // certbot's own lines, as `certbotFailureCommand` greps them from the log.
        const logs = await docker([
          "logs",
          "--tail",
          "500",
          (await edge.containerId("certbot")) ?? "",
        ]);
        const lines = `${logs.stdout}\n${logs.stderr}`.split(/\r?\n/);
        expect(lines).toContain(`Processing /etc/letsencrypt/renewal/${app}.conf`);
        const failure = lines.find((line) =>
          line.startsWith(`Failed to renew certificate ${app} with error: `),
        );
        expect(failure, lines.slice(-30).join("\n")).toBeDefined();
        expect(failure).not.toContain("CERTIFICATE_VERIFY_FAILED");

        // The command `status` runs on the server, here against this edge's project.
        const command = certbotFailureCommand(EDGE_PROJECT, app).replaceAll(
          `com.docker.compose.project=${EDGE_PROJECT}`,
          `com.docker.compose.project=${edge.project.name}`,
        );
        const read = await shell(command);
        expect(read.exitCode, read.stderr).toBe(0);
        const reason = parseCertbotFailure(read.stdout, app);
        expect(reason).toBeDefined();
        expect(failure).toContain((reason ?? "").replace(/…$/, ""));

        // `status`: the served certificate read from the edge, 20 days before it expires.
        const served = await get(SHOP);
        const validTo = new Date(served.certificate.valid_to);
        const plan: DeployPlan = {
          ...shop,
          deployment: { ...shop.deployment, lastDeployAt: "2026-10-20T12:00:00.000Z" },
        };
        const deps = await createTestPhaseDeps({
          root: path.join(work, "status"),
          clock: { now: () => new Date(validTo.getTime() - 20 * 86_400_000) },
          runner: new NodeCommandRunner(),
        });
        await recordServerAddress(deps.paths, { ipv4: "203.0.113.10" });
        await mkdir(path.dirname(deps.paths.files.deployKey), { recursive: true });
        await writeFile(deps.paths.files.deployKey, "placeholder for the deploy key file\n");
        const { lines: status } = await tlsStatusReport(deps, plan, {
          tlsConnect: async (host) => {
            const got = await get(host);
            return {
              subjectAltNames: names(got.certificate),
              validFrom: new Date(got.certificate.valid_from).toISOString(),
              validTo: new Date(got.certificate.valid_to).toISOString(),
              issuer: issuer(got),
            };
          },
          services: {
            remote: (host) => ({
              host,
              run: (script) =>
                shell(
                  script.replaceAll(
                    `com.docker.compose.project=${EDGE_PROJECT}`,
                    `com.docker.compose.project=${edge.project.name}`,
                  ),
                ),
            }),
          },
        });
        const text = status.join("\n");
        expect(text).toContain("Proxy: nginx");
        expect(text).toContain(`certbot's last renewal said: ${reason?.replace(/\.$/, "")}`);
        for (const key of keys) expect(text).not.toContain(key.split("\n")[1]);
      },
      TEN_MINUTES,
    );
  });

  it("shows visitors the same headers, TLS versions and refusals on both proxies", () => {
    expect(seen.caddy, "the Caddy pass ran").toBeDefined();
    expect(seen.nginx, "the nginx pass ran").toBeDefined();
    expect(seen.nginx).toEqual(seen.caddy);
  });

  it(
    "switches a server with one app from Caddy to nginx within the interruption the plan states",
    async () => {
      const edge = await newEdge("switch");
      const caddy = withSite(base, { edge: "caddy", domain: SHOP, www: false, proxied: false });
      await edge.deploy({ plan: caddy });
      await standIn(edge, caddy, "switch ok");
      await until(
        "Caddy's certificate",
        async () => {
          const got = await httpsGet(edge.ports.https, SHOP);
          return got.status === 200 && issuer(got).startsWith("Pebble") ? got : undefined;
        },
        120_000,
      );
      const kamal = await edge.containerId("kamal-proxy");
      const loop = requestLoop(
        () => httpsGet(edge.ports.https, SHOP),
        (answer) => answer.status === 200 && answer.body === "switch ok",
      );
      const began = Date.now();
      await edge.deploy({ plan: withSite(caddy, { edge: "nginx" }) });
      await until("nginx serving HTTPS", async () => {
        const got = await httpsGet(edge.ports.https, SHOP);
        return got.status === 200 && got.headers.server === "nginx" ? got : undefined;
      });
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      const result = await loop.stop();
      console.info(
        `The switch from Caddy to nginx took ${Math.round((Date.now() - began) / 1000)} s; HTTPS was interrupted for ${(result.longestOutageMs / 1000).toFixed(1)} s (${result.failures.length} of ${result.requests} requests failed).`,
      );
      // The plan states under a minute for hostnames not proxied by Cloudflare.
      expect(result.longestOutageMs).toBeLessThan(60_000);
      expect(await edge.containerId("caddy")).toBeUndefined();
      expect(await edge.containerId("kamal-proxy")).toBe(kamal);
      const compose = parse(await readFile(edge.project.file, "utf8")) as Record<string, unknown>;
      expect(compose["x-opscrew-edge-proxy"]).toBe("nginx");
    },
    TEN_MINUTES,
  );
});

/**
 * The loop's `certbot renew` command from the certbot service in the edge's Compose file, with
 * `--no-verify-ssl` for Pebble's own certificate (certbot keeps the server in the renewal file, but
 * not that flag).
 */
function renewCommand(composeFile: string): string {
  const doc = parse(composeFile) as { services: { certbot?: { entrypoint?: string[] } } };
  const loop = doc.services.certbot?.entrypoint?.at(-1) ?? "";
  const line = loop
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith("certbot renew "));
  if (line === undefined) throw new Error("The edge's certbot service runs no `certbot renew`.");
  return `${line} --no-verify-ssl`;
}
