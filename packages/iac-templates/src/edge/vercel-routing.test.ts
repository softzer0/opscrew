import { spawnSync } from "node:child_process";
import { generateP256, selfSignedClientCertificate } from "@opscrew/core";
import { type DeployPlan, type PlatformRouting, PlatformRoutingSchema } from "@opscrew/plan-schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { testContext, testPlan } from "../__fixtures__/plans";
import { IMAGES } from "../pins";
import { renderEdgeSite } from "../runtime";
import { EDGE_PROXIES, type EdgeProxy, renderEdgeCompose } from "./index";
import { NGINX_CONF } from "./nginx";
import { translateVercelRouting } from "./vercel-routing";

/*
 * The routing detect reads from its `vercel-routing` fixtures (T1417a). The agents package also
 * translates the fixture files themselves, through detect and design, and scans every output with
 * `scanProxyAdditions`. With OPSCREW_DOCKER_TESTS=1 each output is checked by the proxy's own
 * checker inside the full edge configuration, and the SPA's rewrite is run in front of an app.
 */

const HASH = "0".repeat(64);
const CONDITION = "it has a `has` or `missing` condition, which OpsCrew does not translate yet";

const routing = (o: Partial<PlatformRouting>): PlatformRouting =>
  PlatformRoutingSchema.parse({
    source: "vercel.json",
    sha256: HASH,
    redirects: [],
    rewrites: [],
    headers: [],
    unsupported: [],
    ...o,
  });

/** `vite-spa.json`. */
const VITE_SPA = routing({
  rewrites: [{ index: 0, source: "/(.*)", destination: "/index.html" }],
});

/** `static-site.json`. */
const STATIC_SITE = routing({
  redirects: [
    { index: 0, source: "/old-blog/:slug", destination: "/blog/:slug", statusCode: 308 },
    { index: 1, source: "/beta", destination: "/", statusCode: 307 },
    { index: 2, source: "^/articles/(\\d{4})/(.+)$", destination: "/posts/$1/$2", statusCode: 301 },
    {
      index: 4,
      source: "/docs/:path*",
      destination: "https://docs.example.com/:path*",
      statusCode: 302,
    },
    { index: 5, source: "/pricing", destination: "/plans", statusCode: 308 },
  ],
  headers: [
    {
      index: 0,
      source: "/assets/(.*)",
      headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
    },
    {
      index: 2,
      source: "/:path((?!api/).*)",
      headers: [{ key: "X-Frame-Options", value: "DENY" }],
    },
  ],
  cleanUrls: true,
  trailingSlash: false,
  unsupported: [
    { property: "redirects", index: 3, reason: CONDITION },
    { property: "headers", index: 1, reason: CONDITION },
  ],
});

/** `routes.json`. */
const ROUTES = routing({
  unsupported: [
    {
      property: "routes",
      reason:
        "`routes` uses Vercel's PCRE form, which OpsCrew does not translate yet; write these rules as `redirects`, `rewrites` and `headers` instead",
    },
  ],
});

/** `malformed.json`, with three of its ten unsupported entries. */
const MALFORMED = routing({
  redirects: [{ index: 6, source: "/ok", destination: "/fine", statusCode: 303 }],
  unsupported: [
    { property: "redirects", index: 0, reason: "it is not an object" },
    { property: "rewrites", reason: "it must be a list of rules" },
    { property: "cleanUrls", reason: "it must be true or false" },
  ],
});

const FIXTURES = { VITE_SPA, STATIC_SITE, ROUTES, MALFORMED };

/** A redirect's or rewrite's pattern as nginx gets it: no `/.well-known/`, no CR or LF. */
const redirectGuard = (regex: string) => `^(?!/\\.well-known/)(?!.*[\\r\\n])(?:${regex.slice(1)})`;

/** The regular expressions of an additions file, in order. */
function guardedRegexes(text: string, proxy: EdgeProxy): string[] {
  const pattern =
    proxy === "caddy" ? /path_regexp \S+ "([^"]+)"/g : /(?:\$uri ~|location ~|rewrite) "([^"]+)"/g;
  return [...text.matchAll(pattern)].map((m) => m[1] ?? "");
}

const translate = (r: PlatformRouting, proxy: EdgeProxy) =>
  translateVercelRouting(r, {
    proxy,
    hostnames: ["shop.example.com"],
    upstream: EDGE_PROXIES[proxy].upstream,
  });

describe.each(["caddy", "nginx"] as const)("translateVercelRouting on %s", (proxy) => {
  it("turns a Vite SPA's catch-all rewrite into a fallback after the app's 404", () => {
    const { text, skipped } = translate(VITE_SPA, proxy);
    expect(skipped).toEqual([]);
    expect(text).toMatchSnapshot();
  });

  it("translates a static site's headers, redirects, cleanUrls and trailingSlash in Vercel's order", () => {
    const { text, skipped } = translate(STATIC_SITE, proxy);
    expect(text).toMatchSnapshot();
    expect(skipped).toContainEqual({ rule: "redirects[3]", reason: CONDITION });
    expect(skipped).toContainEqual({ rule: "headers[1]", reason: CONDITION });
    expect(skipped).toContainEqual({
      rule: "headers[2]",
      reason:
        proxy === "nginx"
          ? "OpsCrew's edge already sends `X-Frame-Options` on every response"
          : "its pattern uses a lookahead, a lookbehind or a backreference, which Caddy's regular expressions do not have",
    });
    // Headers, then redirects (cleanUrls and trailingSlash first), then rewrites (cleanUrls).
    // On nginx the assets' header shares paths with cleanUrls' rewrite, so it is left out.
    const at = (rule: string) => text.indexOf(`# ${rule}:`);
    const order = [
      ...(proxy === "caddy" ? ["headers[0]"] : []),
      "cleanUrls",
      "trailingSlash",
      "redirects[0]",
      "redirects[5]",
    ];
    expect(at(order[0] ?? "")).toBe(0);
    expect(order.map(at)).toEqual(order.map(at).sort((a, b) => a - b));
    expect(text.lastIndexOf("# cleanUrls:")).toBeGreaterThan(at("redirects[5]"));
    // cleanUrls sends index files to their folder first.
    expect(text.indexOf("index\\.html$")).toBeLessThan(text.indexOf("(.+)\\.html$"));
    if (proxy === "nginx") {
      expect(skipped).toContainEqual({
        rule: "headers[0]",
        reason:
          "this rule's paths can also match cleanUrls's, and nginx would drop its headers on rewritten responses",
      });
    }
  });

  it("sends /index.html to / and /dir/index.html to /dir/ with cleanUrls", () => {
    const { text } = translate(routing({ cleanUrls: true }), proxy);
    const index = guardedRegexes(text, proxy)[0] ?? "";
    expect(index).toContain("index\\.html$");
    const re = new RegExp(index);
    expect("/index.html".replace(re, "/$1")).toBe("/");
    expect("/dir/index.html".replace(re, "/$1")).toBe("/dir/");
  });

  it("refuses a Caddy placeholder in a source, and keeps nginx from it", () => {
    const { skipped } = translate(
      routing({
        redirects: [{ index: 0, source: "^/a{$SECRET}", destination: "/b", statusCode: 308 }],
      }),
      proxy,
    );
    expect(skipped.map((s) => s.rule)).toEqual(proxy === "caddy" ? ["redirects[0]"] : []);
    if (proxy === "caddy") {
      expect(skipped[0]?.reason).toBe(
        "its `source` has a `{$…}`, `{env.…}` or `{file.…}` placeholder, which would read the server's environment or files",
      );
    }
  });

  it("never appends parameters to a redirect, and to a rewrite only when it uses none", () => {
    const { text } = translate(
      routing({
        redirects: [{ index: 0, source: "/old/:slug", destination: "/new", statusCode: 308 }],
        rewrites: [{ index: 0, source: "/a/:x/:y", destination: "/b/:x" }],
      }),
      proxy,
    );
    expect(text).not.toContain("slug=");
    expect(text).not.toContain("y=");
  });

  it("lists everything detect could not read, and translates the rest", () => {
    expect(translate(ROUTES, proxy)).toEqual({
      text: "",
      skipped: [{ rule: "routes", reason: ROUTES.unsupported[0]?.reason }],
    });
    const malformed = translate(MALFORMED, proxy);
    expect(malformed.text).toContain("# redirects[6]: /ok to /fine (303)");
    expect(malformed.skipped.map((s) => s.rule)).toEqual(["redirects[0]", "rewrites", "cleanUrls"]);
  });

  it("sends traffic only to exactly the app's upstream, with no variable after it", () => {
    const upstream = EDGE_PROXIES[proxy].upstream;
    for (const r of Object.values(FIXTURES)) {
      const { text } = translate(r, proxy);
      const targets = [...text.matchAll(/(?:reverse_proxy|proxy_pass) (\S+)/g)].map((m) => m[1]);
      for (const target of targets) {
        expect(target).toBe(proxy === "nginx" ? `http://${upstream};` : upstream);
      }
    }
  });

  it("skips a rewrite to another site, and appends unused parameters to the query string", () => {
    const { text, skipped } = translate(
      routing({
        rewrites: [
          { index: 0, source: "/api/:path*", destination: "https://api.example.com/:path*" },
          { index: 1, source: "/blog/:slug", destination: "/blog.html" },
        ],
      }),
      proxy,
    );
    expect(skipped).toEqual([
      {
        rule: "rewrites[0]",
        reason: "it rewrites to another site, and the edge sends traffic only to this app",
      },
    ]);
    expect(text).toContain(
      proxy === "nginx"
        ? '"/blog.html?slug=$1" break;'
        : "rewrite * /blog.html?slug={re.rewrite0.1}",
    );
  });

  it("anchors path patterns, keeps their case, and takes the `/` before a `?`, `+` or `*` parameter along", () => {
    const { text } = translate(
      routing({
        redirects: [
          { index: 0, source: "/Docs/:page?", destination: "/docs/:page", statusCode: 301 },
          { index: 1, source: "/files/:rest+", destination: "/f/:rest", statusCode: 302 },
          { index: 2, source: "/:all*", destination: "/x/:all", statusCode: 307 },
          { index: 3, source: "/v1.0/(.*)", destination: "/v1/$1", statusCode: 308 },
        ],
      }),
      proxy,
    );
    const as = (regex: string) => `"${proxy === "nginx" ? redirectGuard(regex) : regex}"`;
    expect(text).toContain(as("^/Docs(?:/([^/]+))?$"));
    expect(text).toContain(as("^/files/((?:[^/]+)(?:/(?:[^/]+))*)$"));
    expect(text).toContain(as("^/(?:((?:[^/]+)(?:/(?:[^/]+))*))?$"));
    expect(text).toContain(as("^/v1\\.0/(.*)$"));
  });

  it("skips header values, destinations and patterns the proxy cannot take as they are", () => {
    const { text, skipped } = translate(
      routing({
        redirects: [
          { index: 0, source: "/a/:x", destination: "/b/$2", statusCode: 308 },
          { index: 1, source: "/c/{:x}?", destination: "/d", statusCode: 308 },
          { index: 2, source: "/e", destination: "/f/{env.SECRET}$x", statusCode: 308 },
          { index: 7, source: "/g", destination: "g", statusCode: 308 },
        ],
        headers: [
          { index: 0, source: "/h", headers: [{ key: "X-A", value: 'a"b' }] },
          { index: 1, source: "/i", headers: [{ key: "Bad Name", value: "v" }] },
        ],
      }),
      proxy,
    );
    expect(skipped.map((s) => s.rule)).toEqual([
      "headers[0]",
      "headers[1]",
      "redirects[0]",
      "redirects[1]",
      "redirects[2]",
      "redirects[7]",
    ]);
    expect(text).toBe("");
  });
});

describe("translateVercelRouting, by proxy", () => {
  it("leaves out patterns Caddy's RE2 cannot express, which nginx's PCRE can", () => {
    const lookahead = routing({
      redirects: [{ index: 0, source: "/:p((?!uk/).*)", destination: "/uk/:p", statusCode: 307 }],
    });
    expect(translate(lookahead, "caddy").skipped).toEqual([
      {
        rule: "redirects[0]",
        reason:
          "its pattern uses a lookahead, a lookbehind or a backreference, which Caddy's regular expressions do not have",
      },
    ]);
    expect(translate(lookahead, "nginx").text).toContain(`"${redirectGuard("^/((?!uk/).*)$")}"`);
  });

  it("on nginx, no pattern matches a path with a CR or LF, which a capture would put in a header", () => {
    const { text } = translate(
      routing({
        redirects: [{ index: 0, source: "/old/:slug", destination: "/new/:slug", statusCode: 308 }],
        rewrites: [{ index: 0, source: "/(.*)", destination: "/index.html" }],
        headers: [{ index: 0, source: "/h/(.*)", headers: [{ key: "X-H", value: "h" }] }],
      }),
      "nginx",
    );
    const regexes = guardedRegexes(text, "nginx").map((r) => new RegExp(r));
    expect(regexes.length).toBeGreaterThanOrEqual(3);
    for (const re of regexes) {
      expect(re.test("/old/a\r\nSet-Cookie: pwn=1")).toBe(false);
      expect(re.test("/h/a\rb")).toBe(false);
    }
    expect(regexes.some((re) => re.test("/old/a"))).toBe(true);
  });

  it("keeps /.well-known/ out of every alternative of a regular-expression source", () => {
    for (const proxy of ["caddy", "nginx"] as const) {
      const { text } = translate(
        routing({
          redirects: [{ index: 0, source: "^/a|/b|.*", destination: "/c", statusCode: 308 }],
        }),
        proxy,
      );
      if (proxy === "caddy") {
        expect(text).toContain("\tnot path /.well-known/*");
        continue;
      }
      const [re] = guardedRegexes(text, "nginx");
      expect(new RegExp(re ?? "").test("/.well-known/acme-challenge/x")).toBe(false);
      expect(new RegExp(re ?? "").test("/b")).toBe(true);
    }
  });

  it("on nginx, leaves out a header rule whose paths a rewrite can also take", () => {
    const { text, skipped } = translate(
      routing({
        rewrites: [{ index: 0, source: "/app/x", destination: "/index.html" }],
        headers: [
          { index: 0, source: "/app/:path*", headers: [{ key: "X-App", value: "1" }] },
          { index: 1, source: "/other/(.*)", headers: [{ key: "X-Other", value: "2" }] },
        ],
      }),
      "nginx",
    );
    expect(skipped).toEqual([
      {
        rule: "headers[0]",
        reason:
          "this rule's paths can also match rewrites[0]'s, and nginx would drop its headers on rewritten responses",
      },
    ]);
    expect(text).toContain("X-Other");
  });

  it("on nginx, sends only the rewrites' paths to the app's 404 fallback", () => {
    const { text } = translate(
      routing({ rewrites: [{ index: 0, source: "/app/:path*", destination: "/app/index.html" }] }),
      "nginx",
    );
    const top = text.split("\n").filter((line) => !line.startsWith("\t"));
    expect(top.some((line) => /proxy_intercept_errors|error_page/.test(line))).toBe(false);
    expect(text).toContain(
      [
        `location ~ "${redirectGuard("^(?:/app(?:/((?:[^/]+)(?:/(?:[^/]+))*))?$)")}" {`,
        "\tproxy_intercept_errors on;",
        "\terror_page 404 = @vercel_rewrites;",
        "\tproxy_pass http://kamal-proxy;",
        "}",
      ].join("\n"),
    );
  });

  it("on nginx, counts a character a quantifier makes optional out of a pattern's start", () => {
    const { skipped } = translate(
      routing({
        headers: [
          { index: 0, source: "/y", headers: [{ key: "X-Y", value: "1" }] },
          { index: 1, source: "^/x?y$", headers: [{ key: "X-X", value: "2" }] },
        ],
      }),
      "nginx",
    );
    expect(/^\/x?y$/.test("/y")).toBe(true);
    expect(skipped.map((s) => s.rule)).toEqual(["headers[1]"]);
  });

  it("on nginx, puts headers for every path at server level, and leaves out a rule whose paths can match an earlier one's", () => {
    const { text, skipped } = translate(
      routing({
        headers: [
          { index: 0, source: "/:path*", headers: [{ key: "X-Robots-Tag", value: "noindex" }] },
          { index: 1, source: "/assets/(.*)", headers: [{ key: "Cache-Control", value: "a" }] },
          { index: 2, source: "/fonts/(.*)", headers: [{ key: "Cache-Control", value: "b" }] },
          { index: 3, source: "/assets/img/(.*)", headers: [{ key: "X-Img", value: "c" }] },
        ],
      }),
      "nginx",
    );
    expect(text.split("\n").slice(0, 3)).toEqual([
      "# headers[0]: /:path*, on every path",
      "proxy_hide_header X-Robots-Tag;",
      'add_header X-Robots-Tag "noindex" always;',
    ]);
    expect(text).toContain(
      [
        'location ~ "^(?!/\\.well-known/acme-challenge/)(?!.*[\\r\\n])(?:/fonts/(.*)$)" {',
        "\tproxy_hide_header X-Robots-Tag;",
        "\tproxy_hide_header Cache-Control;",
        '\tadd_header Cache-Control "b" always;',
        "\tproxy_pass http://kamal-proxy;",
        "}",
      ].join("\n"),
    );
    expect(skipped).toEqual([
      {
        rule: "headers[3]",
        reason:
          "nginx sends the headers of one `location` per request, and this rule's paths can also match headers[1]'s; merge the two rules by hand",
      },
    ]);
  });

  it("on nginx, never repeats OpsCrew's baseline headers and never sets a request header", () => {
    for (const r of Object.values(FIXTURES)) {
      const { text } = translate(r, "nginx");
      expect(text).not.toMatch(/Strict-Transport-Security|X-Content-Type-Options|Referrer-Policy/);
      expect(text).not.toContain("proxy_set_header");
    }
  });
});

function skipReason(): string | undefined {
  if (process.env.OPSCREW_DOCKER_TESTS !== "1") return "set OPSCREW_DOCKER_TESTS=1 to run it";
  const version = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], {
    encoding: "utf8",
  });
  return version.status === 0 ? undefined : "Docker is not available";
}

const reason = skipReason();
if (reason) console.warn(`[iac-templates] skipping vercel.json routing in Docker: ${reason}`);

const LABEL = "dev.opscrew.test=vercel-routing";

/** `shop` on the plan's server edge with `proxy`, at shop.example.com. */
function shop(proxy: EdgeProxy, o: Parameters<typeof testPlan>[0] = {}): DeployPlan {
  const plan = testPlan({ domain: "shop.example.com", ...o });
  return { ...plan, target: { ...plan.target, edge: proxy } } as DeployPlan;
}

/** The edge's files for `plan` with `additions`: path in the proxy's container to content. */
function edgeFiles(plan: DeployPlan, proxy: EdgeProxy, additions: string): Record<string, string> {
  const ctx = { ...testContext({ acmeEmail: "ops@example.com" }), additions: true };
  const [site] = renderEdgeSite(plan, ctx);
  if (proxy === "nginx") {
    const key = generateP256().privateKey;
    const certificate = selfSignedClientCertificate({ key, commonName: "shop", days: 1 });
    return {
      "/etc/nginx/nginx.conf": NGINX_CONF,
      "/etc/nginx/sites/shop.conf": site?.content ?? "",
      "/etc/nginx/sites/shop.additions": additions,
      "/etc/letsencrypt/live/shop/fullchain.pem": certificate,
      "/etc/letsencrypt/live/shop/privkey.pem": key,
    };
  }
  const main = parse(renderEdgeCompose(plan).content).configs.caddyfile.content as string;
  return {
    "/etc/caddy/Caddyfile": main.replaceAll("$$", "$"),
    "/etc/caddy/sites/shop.caddy": site?.content ?? "",
    "/etc/caddy/sites/shop.additions": additions,
  };
}

/** A script that writes `files`, then runs `then`. */
function script(files: Record<string, string>, then: string): string {
  return [
    "set -e",
    ...Object.entries(files).flatMap(([path, content]) => [
      `mkdir -p "$(dirname ${path})"`,
      `cat > ${path} <<'OPSCREW_EOF'`,
      content.replace(/\n$/, ""),
      "OPSCREW_EOF",
    ]),
    then,
  ].join("\n");
}

const IMAGE = { caddy: IMAGES.caddy.ref, nginx: IMAGES.nginx.ref };
const CHECK = {
  caddy: "caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile",
  nginx: "nginx -t",
};
const RUN = {
  caddy: "exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile",
  nginx: "exec nginx -g 'daemon off;'",
};

describe.skipIf(reason !== undefined)(
  "vercel.json routing in Docker (OPSCREW_DOCKER_TESTS=1)",
  () => {
    it.each(["caddy", "nginx"] as const)(
      "%s's own checker accepts every fixture's additions in the full edge",
      (proxy) => {
        for (const [name, r] of Object.entries(FIXTURES)) {
          const files = edgeFiles(shop(proxy), proxy, translate(r, proxy).text);
          const run = spawnSync(
            "docker",
            [
              "run",
              "--rm",
              "-i",
              "--label",
              LABEL,
              "--user",
              "0",
              "--entrypoint",
              "sh",
              IMAGE[proxy],
              "-s",
            ],
            { input: script(files, CHECK[proxy]), encoding: "utf8", timeout: 240_000 },
          );
          expect(run.status, `${name}: ${run.stdout}${run.stderr}`).toBe(0);
        }
      },
      600_000,
    );

    describe.each(["caddy", "nginx"] as const)("a Vite SPA behind %s", (proxy) => {
      const id = `opscrew-test-vercel-${proxy}-${process.pid}-${Date.now()}`;
      // The SPA's rewrite after one with a parameter, a redirect with captures and a header.
      const spa = routing({
        rewrites: [
          { index: 0, source: "/p/:name", destination: "/assets/:name.js" },
          { ...VITE_SPA.rewrites[0], index: 1 } as PlatformRouting["rewrites"][number],
        ],
        redirects: [
          ...STATIC_SITE.redirects.filter((r) => r.index === 2),
          { index: 9, source: "/old/:slug", destination: "/new/:slug", statusCode: 308 },
        ],
        // On nginx this header shares paths with the catch-all rewrite, so it is left out.
        headers: STATIC_SITE.headers.filter((h) => h.index === 0),
      });

      /** Runs `command` in the pinned curl image on the test network. */
      function curl(command: string) {
        const run = spawnSync(
          "docker",
          [
            "run",
            "--rm",
            "--label",
            LABEL,
            "--network",
            id,
            "--entrypoint",
            "sh",
            IMAGES.curl.ref,
            "-c",
            command,
          ],
          { encoding: "utf8", timeout: 120_000 },
        );
        return { status: run.status, stdout: run.stdout.replaceAll("\r", ""), stderr: run.stderr };
      }

      const port = proxy === "nginx" ? 8080 : 80;
      const get = (path: string, flags = "") =>
        curl(`curl -sS ${flags} -H 'Host: shop.example.com' http://edge:${port}${path}`);

      beforeAll(() => {
        expect(spawnSync("docker", ["network", "create", "--label", LABEL, id]).status).toBe(0);
        // The app: /index.html and /assets/app.js, and 404 for anything else, with a log of
        // every request it gets.
        const app = script(
          {
            "/srv/index.html": "the index",
            "/srv/assets/app.js": "the script",
            "/etc/caddy/App": [
              ":80 {",
              "\tlog",
              "\troot * /srv",
              "\t@missing not file",
              "\trespond @missing 404",
              "\tfile_server",
              "}",
            ].join("\n"),
          },
          "exec caddy run --config /etc/caddy/App --adapter caddyfile",
        );
        const plan = shop(proxy, { provider: "own", access: "tunnel" });
        const edge = script(edgeFiles(plan, proxy, translate(spa, proxy).text), RUN[proxy]);
        const start = (name: string, alias: string, image: string, command: string) =>
          spawnSync(
            "docker",
            [
              "run",
              "-d",
              "--rm",
              "--label",
              LABEL,
              "--name",
              name,
              "--network",
              id,
              "--network-alias",
              alias,
              "--user",
              "0",
              "--entrypoint",
              "sh",
              image,
              "-c",
              command,
            ],
            { encoding: "utf8", timeout: 240_000 },
          );
        const started = [
          start(`${id}-app`, "kamal-proxy", IMAGES.caddy.ref, app),
          start(`${id}-edge`, "edge", IMAGE[proxy], edge),
        ];
        for (const run of started) expect(run.status, run.stderr).toBe(0);
        const ready = curl(
          `for i in $(seq 1 30); do if curl -sf -o /dev/null -H 'Host: shop.example.com' http://edge:${port}/index.html; then exit 0; fi; sleep 1; done; exit 1`,
        );
        const logs = spawnSync("docker", ["logs", `${id}-edge`], { encoding: "utf8" });
        expect(ready.status, `${logs.stdout}${logs.stderr}`).toBe(0);
      }, 300_000);

      afterAll(() => {
        spawnSync("docker", ["rm", "-f", `${id}-app`, `${id}-edge`]);
        spawnSync("docker", ["network", "rm", id]);
      });

      it("serves an existing asset as it is, with its header, and /index.html for an unknown path", () => {
        const asset = get("/assets/app.js", "-D -");
        expect(asset.stdout).toMatch(/^HTTP\/1\.1 200 /);
        expect(asset.stdout).toContain("\nthe script");
        if (proxy === "caddy") {
          expect(asset.stdout.toLowerCase()).toContain(
            "\ncache-control: public, max-age=31536000, immutable\n",
          );
        }
        const unknown = get("/unknown/route", "-D -");
        expect(unknown.stdout).toMatch(/^HTTP\/1\.1 200 /);
        expect(unknown.stdout).toContain("\nthe index");
        // OpsCrew's own headers stay, once.
        expect(unknown.stdout.toLowerCase().match(/\nx-content-type-options: /g)).toHaveLength(1);
      }, 120_000);

      it("rewrites with the source's parameters, and sends the app's 404 when the rewrite has none", () => {
        expect(get("/p/app").stdout.trim()).toBe("the script");
        const missing = get("/p/nothing", "-o /dev/null -w '%{http_code}'");
        expect(missing.stdout).toBe("404");
      }, 120_000);

      it("redirects with the source's captures", () => {
        const run = get("/articles/2024/hello", "-o /dev/null -D -");
        expect(run.stdout).toMatch(/^HTTP\/1\.1 301 /);
        expect(run.stdout).toMatch(
          /\nLocation: (?:http:\/\/shop\.example\.com)?\/posts\/2024\/hello\n/i,
        );
      }, 120_000);

      it("puts no header from a path with an encoded CR LF into a response", () => {
        const run = get("/old/a%0d%0aSet-Cookie:%20pwn=1", "-o /dev/null -D -");
        expect(run.stdout).toMatch(/^HTTP\/1\.1 \d{3} /);
        expect(run.stdout.toLowerCase()).not.toContain("pwn");
        expect(get("/old/a", "-o /dev/null -D -").stdout).toMatch(/\nLocation: \S*\/new\/a\n/i);
      }, 120_000);

      it("sends a request to a path no rewrite takes to the app once, even when it answers 404", () => {
        const path = `/.well-known/opscrew-once-${Date.now()}`;
        const run = get(path, "-X POST -d x=1 -o /dev/null -w '%{http_code}'");
        expect(run.stdout).toBe("404");
        const logs = spawnSync("docker", ["logs", `${id}-app`], { encoding: "utf8" });
        const hits = `${logs.stdout}${logs.stderr}`.split("\n").filter((l) => l.includes(path));
        expect(hits).toHaveLength(1);
      }, 120_000);
    });
  },
);
