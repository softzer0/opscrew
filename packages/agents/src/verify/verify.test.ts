import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { FetchLike } from "@opscrew/contracts";
import { fakeSecret } from "@opscrew/core/testing";
import { type DeployPlan, readArtifact, writeArtifact } from "@opscrew/plan-schema";
import type { TcpConnect } from "@opscrew/secops";
import { describe, expect, it } from "vitest";
import { writeCloudflareRecord } from "../provision/shared-cloudflare";
import { recordServerAddress, serverAddressesFile } from "../shared";
import {
  CLOUDFLARE_IPV4,
  CLOUDFLARE_IPV6,
  CLOUDFLARE_RANGES,
  createTestPhaseDeps,
  ScriptedRunner,
  type TestPhaseDeps,
} from "../testing";
import {
  SERVER,
  SERVER_IPV4,
  SERVER_IPV6,
  type TestPlanOptions,
  testPlan,
} from "./__fixtures__/plan";
import { certificateCoversHost } from "./checks";
import type { DnsResolver, TlsCertificateInfo, TlsConnect } from "./net";
import { runVerify } from "./run";

const NOW = "2026-10-11T12:00:00.000Z";
const RUN_URL = "https://github.com/acme/shop/actions/runs/42";

interface SiteOptions {
  /** Path → response factory overrides. */
  routes?: Record<string, () => Response>;
  headers?: Record<string, string>;
  runs?: { status: string; conclusion: string | null; createdAt?: string }[];
  base?: string;
}

/** Fake internet: the site, its redirect, and GitHub's workflow runs API. */
function fakeSite(o: SiteOptions = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const base = o.base ?? "https://shop.example.com";
  const headers = o.headers ?? {
    "strict-transport-security": "max-age=31536000; includeSubDomains",
    "x-content-type-options": "nosniff",
    "x-frame-options": "SAMEORIGIN",
    "referrer-policy": "strict-origin-when-cross-origin",
  };
  const fetch: FetchLike = async (input, init) => {
    const url = String(input);
    calls.push({ url, ...(init ? { init } : {}) });
    const parsed = new URL(url);
    if (parsed.host === "api.github.com") {
      expect(parsed.pathname).toBe("/repos/acme/shop/actions/workflows/opscrew-deploy.yml/runs");
      expect(parsed.searchParams.get("branch")).toBe("main");
      const runs = o.runs ?? [{ status: "completed", conclusion: "success" }];
      return Response.json({
        workflow_runs: runs.map((run, i) => ({
          id: 42 - i,
          status: run.status,
          conclusion: run.conclusion,
          html_url: RUN_URL,
          head_sha: "abc123",
          created_at: run.createdAt ?? "2026-10-11T11:00:00Z",
        })),
      });
    }
    const route = o.routes?.[`${parsed.protocol}//${parsed.host}${parsed.pathname}`];
    if (route) return route();
    if (url.startsWith("http://shop.example.com")) {
      return new Response(null, {
        status: 308,
        headers: { location: `https://shop.example.com${parsed.pathname}` },
      });
    }
    if (url === `${base}/`) return new Response("<!doctype html><p>shop</p>", { headers });
    if (url === `${base}/api/health`) return new Response("ok");
    return new Response("not found", { status: 404 });
  };
  return { fetch, calls };
}

function resolver(
  a: string[] = [CLOUDFLARE_IPV4],
  aaaa: string[] = [CLOUDFLARE_IPV6],
): DnsResolver {
  return { resolve4: async () => a, resolve6: async () => aaaa };
}

function cert(o: Partial<TlsCertificateInfo> = {}): TlsConnect {
  return async () => ({
    subjectCommonName: "shop.example.com",
    subjectAltNames: ["shop.example.com"],
    validFrom: "2026-09-20T00:00:00.000Z",
    validTo: "2026-12-19T00:00:00.000Z",
    issuer: "Let's Encrypt",
    ...o,
  });
}

const closed: TcpConnect = async () => false;

async function setup(
  plan: TestPlanOptions = {},
  options: { token?: boolean; remote?: string; now?: () => Date } = {},
): Promise<TestPhaseDeps & { token: string }> {
  const token = fakeSecret("github-token");
  const root = await mkdtemp(join(tmpdir(), "opscrew-verify-"));
  const deps = await createTestPhaseDeps({
    root,
    env: {
      OPSCREW_HOME: join(root, ".home-opscrew"),
      ...(options.token === false ? {} : { GITHUB_TOKEN: token }),
    },
    runner: new ScriptedRunner((command, args) =>
      command === "git" && args.includes("get-url")
        ? {
            exitCode: 0,
            stdout: `${options.remote ?? "https://github.com/acme/shop.git"}\n`,
            stderr: "",
          }
        : { exitCode: 1, stdout: "", stderr: "unexpected command" },
    ),
    clock: { now: options.now ?? (() => new Date(NOW)) },
  });
  await writeArtifact("plan", deps.paths.files.plan, testPlan(plan));
  // What `opscrew provision` left in the local state.
  if (plan.ip !== false) await recordServerAddress(deps.paths, SERVER);
  return Object.assign(deps, { token });
}

function byId(checks: { id: string }[], id: string) {
  const check = checks.find((c) => c.id === id);
  if (!check) throw new Error(`no check ${id}`);
  return check as (typeof checks)[number] & { status: string; message: string; severity: string };
}

describe("runVerify", () => {
  it("passes every check for a healthy deployment and writes the runbook (US4 scenario 3)", async () => {
    const deps = await setup();
    const site = fakeSite();
    const result = await runVerify(deps, {
      resolver: resolver(),
      fetch: site.fetch,
      tlsConnect: cert(),
      tcpConnect: closed,
      cloudflareRanges: CLOUDFLARE_RANGES,
    });

    expect(result.checks.map((c) => [c.id, c.status])).toEqual([
      ["dns-records", "pass"],
      ["site-reachable", "pass"],
      ["tls-certificate", "pass"],
      ["http-redirect", "pass"],
      ["health-endpoint", "pass"],
      ["security-headers", "pass"],
      ["env-file-not-served", "pass"],
      ["git-config-not-served", "pass"],
      ["origin-not-direct", "pass"],
      ["deploy-run", "pass"],
    ]);
    expect(result.passed).toBe(true);
    expect(result.url).toBe("https://shop.example.com");
    expect(byId(result.checks, "tls-certificate").message).toContain("issued by Let's Encrypt");

    const runbook = await readFile(deps.paths.files.runbook, "utf8");
    expect(result.runbookPath).toBe("opscrew/RUNBOOK.md");
    expect(runbook).toContain("https://shop.example.com");
    // Behind Cloudflare's proxy the committed runbook and plan never name the server's address.
    for (const committed of [runbook, await readFile(deps.paths.files.plan, "utf8")]) {
      expect(committed).not.toContain(SERVER_IPV4);
      expect(committed).not.toContain(SERVER_IPV6);
    }
    expect(runbook).toContain("deploy@$(opscrew status --ip)");
    expect(runbook).toContain(deps.paths.projectId);
    expect(runbook).toContain("## Roll back");
    expect(runbook).toContain("ghcr.io/acme/shop");

    const plan = await readArtifact("plan", deps.paths.files.plan);
    expect(plan.deployment.url).toBe("https://shop.example.com");
    expect(plan.deployment.firstDeployAt).toBe("2026-10-11T11:00:00.000Z");
    expect(plan.updatedAt).toBe(NOW);

    const state = await deps.state.read();
    expect(state.phases.verify?.status).toBe("ok");
    // The redirect and file probes do not follow redirects.
    const redirect = site.calls.find((c) => c.url === "http://shop.example.com/");
    expect(redirect?.init?.redirect).toBe("manual");
    // The GitHub token never shows up in output.
    expect(deps.reporter.text()).not.toContain(deps.token);
  });

  it("a second verify after another deploy leaves plan.yaml byte-identical", async () => {
    let now = Date.parse(NOW);
    const deps = await setup({}, { now: () => new Date(now) });
    const verify = (createdAt: string) =>
      runVerify(deps, {
        resolver: resolver(),
        fetch: fakeSite({ runs: [{ status: "completed", conclusion: "success", createdAt }] })
          .fetch,
        tlsConnect: cert(),
        tcpConnect: closed,
        cloudflareRanges: CLOUDFLARE_RANGES,
      });
    expect((await verify("2026-10-11T11:00:00Z")).passed).toBe(true);
    const first = await readFile(deps.paths.files.plan, "utf8");

    // A day later, after another deploy.
    now += 86_400_000;
    const second = await verify("2026-10-12T11:00:00Z");

    expect(second.passed).toBe(true);
    expect(await readFile(deps.paths.files.plan, "utf8")).toBe(first);
    // The first deploy's time stays: it says the app was deployed, not when it last was.
    expect(second.plan.deployment.firstDeployAt).toBe("2026-10-11T11:00:00.000Z");
    expect(second.plan.updatedAt).toBe(NOW);
  });

  it("fails the TLS check with the expiry date of an expired certificate (US4 scenario 4)", async () => {
    const deps = await setup();
    const before = await readFile(deps.paths.files.plan, "utf8");
    const result = await runVerify(deps, {
      resolver: resolver(),
      fetch: fakeSite().fetch,
      tlsConnect: cert({
        validTo: "2026-10-01T00:00:00.000Z",
        validFrom: "2026-07-03T00:00:00.000Z",
      }),
      tcpConnect: closed,
      cloudflareRanges: CLOUDFLARE_RANGES,
    });
    const tls = byId(result.checks, "tls-certificate");
    expect(tls.status).toBe("fail");
    expect(tls.severity).toBe("critical");
    expect(tls.message).toContain("expired on 2026-10-01");
    expect(result.passed).toBe(false);
    // The plan is not touched when a check fails, but the runbook is still written.
    expect(await readFile(deps.paths.files.plan, "utf8")).toBe(before);
    expect(await readFile(deps.paths.files.runbook, "utf8")).toContain("# Runbook: shop");
    expect((await deps.state.read()).phases.verify?.status).toBe("failed");
    expect(
      deps.reporter.lines.some((l) => l.level === "error" && l.message.includes("expired")),
    ).toBe(true);
  });

  it("fails the TLS check with the names on a mismatched certificate (US4 scenario 4)", async () => {
    const deps = await setup();
    const result = await runVerify(deps, {
      resolver: resolver(),
      fetch: fakeSite().fetch,
      tlsConnect: cert({
        subjectCommonName: "other.example.net",
        subjectAltNames: ["other.example.net", "*.other.example.net"],
      }),
      tcpConnect: closed,
      cloudflareRanges: CLOUDFLARE_RANGES,
    });
    const tls = byId(result.checks, "tls-certificate");
    expect(tls.status).toBe("fail");
    expect(tls.message).toContain("other.example.net, *.other.example.net");
    expect(tls.message).toContain("not shop.example.com");
  });

  it("fails a certificate that expires within 14 days", async () => {
    const deps = await setup();
    const result = await runVerify(deps, {
      resolver: resolver(),
      fetch: fakeSite().fetch,
      tlsConnect: cert({ validTo: "2026-10-20T00:00:00.000Z" }),
      tcpConnect: closed,
      cloudflareRanges: CLOUDFLARE_RANGES,
    });
    const tls = byId(result.checks, "tls-certificate");
    expect(tls.status).toBe("fail");
    expect(tls.message).toContain("2026-10-20 (8 days left)");
  });

  it("warns below 30 days on a DNS-only certificate, with certbot's reason from the server (FR-1445)", async () => {
    const deps = await setup({ proxied: false });
    await writeArtifact("plan", deps.paths.files.plan, {
      ...testPlan({ proxied: false }),
      target: { ...testPlan().target, edge: "nginx" } as DeployPlan["target"],
    });
    await mkdir(dirname(deps.paths.files.deployKey), { recursive: true });
    await writeFile(deps.paths.files.deployKey, "placeholder for the deploy key file\n");
    const commands: string[] = [];
    const result = await runVerify(deps, {
      resolver: { resolve4: async () => [SERVER_IPV4], resolve6: async () => [SERVER_IPV6] },
      fetch: fakeSite().fetch,
      tlsConnect: cert({ validTo: "2026-11-01T00:00:00.000Z" }),
      tcpConnect: async () => true,
      remote: (host) => ({
        host,
        async run(command) {
          commands.push(command);
          return {
            exitCode: 0,
            stdout: "Failed to renew certificate shop with error: Some challenges have failed.\n",
            stderr: "",
          };
        },
      }),
    });
    const tls = byId(result.checks, "tls-certificate") as { remediation?: string } & ReturnType<
      typeof byId
    >;
    expect(tls.status).toBe("warn");
    expect(tls.message).toContain("2026-11-01 (20 days left) and has not been renewed");
    expect(tls.remediation).toContain(
      "certbot's last renewal said: Some challenges have failed. Check that the hostname's DNS record points to the server",
    );
    expect(commands).toHaveLength(1);
  });

  it("warns about a damaged Cloudflare record with how to fix it, and goes on", async () => {
    const deps = await setup();
    await mkdir(dirname(deps.paths.files.cloudflareRecord), { recursive: true });
    await writeFile(deps.paths.files.cloudflareRecord, '{"zoneId":"nope"}');
    const result = await runVerify(deps, {
      resolver: resolver(),
      fetch: fakeSite().fetch,
      tlsConnect: cert(),
      tcpConnect: closed,
      cloudflareRanges: CLOUDFLARE_RANGES,
    });
    const check = byId(result.checks, "origin-tls-certificates") as ReturnType<typeof byId> & {
      remediation?: string;
    };
    expect(check.status).toBe("warn");
    expect(check.message).toContain("is damaged");
    expect(check.remediation).toContain("Copy .opscrew/cloudflare.json back");
    expect(result.passed).toBe(true);
  });

  it("warns when the record's origin or client certificate has fewer than 30 days left (FR-1406)", async () => {
    const deps = await setup();
    const tls = (expiresAt: string) => ({
      origin: {
        id: "o1",
        hostnames: ["shop.example.com"],
        expiresAt,
        sha256: "a".repeat(64),
        superseded: [],
      },
      client: {
        id: "c1",
        expiresAt: "2041-10-16T00:00:00.000Z",
        sha256: "b".repeat(64),
        enabled: ["shop.example.com"],
        retiring: [],
      },
    });
    const record = {
      zoneId: "0123456789abcdef0123456789abcdef",
      hostnames: {},
      createdEntrypoints: [],
    };
    const run = () =>
      runVerify(deps, {
        resolver: resolver(),
        fetch: fakeSite().fetch,
        tlsConnect: cert(),
        tcpConnect: closed,
        cloudflareRanges: CLOUDFLARE_RANGES,
      });
    await writeCloudflareRecord(deps.paths, { ...record, tls: tls("2041-10-16T00:00:00.000Z") });
    expect(byId((await run()).checks, "origin-tls-certificates")).toMatchObject({
      status: "pass",
      message:
        "Valid: the origin certificate until 2041-10-16 and the client certificate until 2041-10-16.",
    });
    await writeCloudflareRecord(deps.paths, { ...record, tls: tls("2026-11-01T00:00:00.000Z") });
    const result = await run();
    expect(byId(result.checks, "origin-tls-certificates")).toMatchObject({
      status: "warn",
      message:
        "The app's Cloudflare origin certificate for shop.example.com expires on 2026-11-01. Run `opscrew provision`: it replaces the certificate, and the deploy brings the server the new one.",
    });
    expect(result.passed).toBe(true);
  });

  it("warns instead of failing when there is no domain (IP only)", async () => {
    const deps = await setup({ domain: undefined });
    const base = `http://${SERVER_IPV4}`;
    const result = await runVerify(deps, {
      resolver: {
        resolve4: async () => {
          throw new Error("DNS must not be queried without a domain");
        },
        resolve6: async () => [],
      },
      fetch: fakeSite({
        base,
        headers: {
          "x-content-type-options": "nosniff",
          "x-frame-options": "SAMEORIGIN",
          "referrer-policy": "no-referrer",
        },
      }).fetch,
      tlsConnect: async () => {
        throw new Error("TLS must not be used without a domain");
      },
      tcpConnect: closed,
    });
    expect(result.checks.map((c) => [c.id, c.status])).toEqual([
      ["dns-records", "warn"],
      ["site-reachable", "pass"],
      ["tls-certificate", "warn"],
      ["http-redirect", "skip"],
      ["health-endpoint", "pass"],
      ["security-headers", "pass"],
      ["env-file-not-served", "pass"],
      ["git-config-not-served", "pass"],
      ["origin-not-direct", "skip"],
      ["deploy-run", "pass"],
    ]);
    expect(result.passed).toBe(true);
    expect(result.url).toBe(base);
    expect(byId(result.checks, "dns-records").message).toContain("plain HTTP");
    // The URL on the server's IP is not committed; the runbook shows the address (the app is
    // served on it).
    const plan = await readArtifact("plan", deps.paths.files.plan);
    expect(plan.deployment.url).toBeUndefined();
    expect(await readFile(deps.paths.files.plan, "utf8")).not.toContain(SERVER_IPV4);
    expect(await readFile(deps.paths.files.runbook, "utf8")).toContain(`deploy@${SERVER_IPV4}`);
    expect(deps.reporter.lines.filter((l) => l.level === "warn")).toHaveLength(2);
  });

  it("fails DNS that bypasses Cloudflare's proxy", async () => {
    const deps = await setup();
    const result = await runVerify(deps, {
      resolver: resolver([SERVER_IPV4], []),
      fetch: fakeSite().fetch,
      tlsConnect: cert(),
      tcpConnect: closed,
      cloudflareRanges: CLOUDFLARE_RANGES,
    });
    const dns = byId(result.checks, "dns-records");
    expect(dns.status).toBe("fail");
    expect(dns.message).toContain("resolves to the server itself");
  });

  it("fails proxied DNS that names the server's IPv6 address written another way", async () => {
    const deps = await setup();
    const result = await runVerify(deps, {
      resolver: resolver([CLOUDFLARE_IPV4], ["2001:DB8:0:0::10"]),
      fetch: fakeSite().fetch,
      tlsConnect: cert(),
      tcpConnect: closed,
      cloudflareRanges: CLOUDFLARE_RANGES,
    });
    const dns = byId(result.checks, "dns-records");
    expect(dns.status).toBe("fail");
    expect(dns.message).toContain("resolves to the server itself");
  });

  it("fails proxied DNS that points outside Cloudflare", async () => {
    const deps = await setup();
    const result = await runVerify(deps, {
      resolver: resolver(["198.51.100.7"], []),
      fetch: fakeSite().fetch,
      tlsConnect: cert(),
      tcpConnect: closed,
      cloudflareRanges: CLOUDFLARE_RANGES,
    });
    expect(byId(result.checks, "dns-records").message).toContain("not a Cloudflare address");
  });

  it("reads Cloudflare's ranges from the public API when proxied", async () => {
    const deps = await setup();
    const site = fakeSite({
      routes: {
        "https://api.cloudflare.com/client/v4/ips": () =>
          Response.json({
            success: true,
            errors: [],
            messages: [],
            result: { ipv4_cidrs: CLOUDFLARE_RANGES.ipv4, ipv6_cidrs: CLOUDFLARE_RANGES.ipv6 },
          }),
      },
    });
    const result = await runVerify(deps, {
      resolver: resolver(),
      fetch: site.fetch,
      tlsConnect: cert(),
      tcpConnect: closed,
    });
    expect(site.calls.some((c) => c.url.includes("api.cloudflare.com"))).toBe(true);
    expect(byId(result.checks, "dns-records").status).toBe("pass");
  });

  it("checks DNS-only records against the server addresses, including www", async () => {
    const deps = await setup({ proxied: false, www: true });
    const result = await runVerify(deps, {
      resolver: {
        resolve4: async (host) => (host.startsWith("www.") ? ["198.51.100.7"] : [SERVER_IPV4]),
        resolve6: async () => ["2001:0db8:0:0:0:0:0:10"],
      },
      fetch: fakeSite().fetch,
      tlsConnect: cert(),
      tcpConnect: async () => true,
    });
    expect(byId(result.checks, "dns-records").status).toBe("pass");
    const www = byId(result.checks, "dns-records-www");
    expect(www.status).toBe("fail");
    expect(www.message).toContain(`the server is ${SERVER_IPV4} / ${SERVER_IPV6}`);
    expect(byId(result.checks, "origin-not-direct").status).toBe("skip");
    // DNS-only records publish the address anyway, so the runbook may show it.
    const runbook = await readFile(deps.paths.files.runbook, "utf8");
    expect(runbook).toContain(`| IPv4 / IPv6 | ${SERVER_IPV4} / ${SERVER_IPV6} |`);
    expect(runbook).toContain(`deploy@${SERVER_IPV4}`);
  });

  it("fails when .env is served, but accepts an app fallback page", async () => {
    const deps = await setup();
    const result = await runVerify(deps, {
      resolver: resolver(),
      fetch: fakeSite({
        routes: {
          "https://shop.example.com/.env": () =>
            new Response("DATABASE_URL=postgres://x\nAPI_KEY=y\n"),
          "https://shop.example.com/.git/config": () =>
            new Response("<!doctype html><div id=root>"),
        },
      }).fetch,
      tlsConnect: cert(),
      tcpConnect: closed,
      cloudflareRanges: CLOUDFLARE_RANGES,
    });
    const env = byId(result.checks, "env-file-not-served");
    expect(env.status).toBe("fail");
    expect(env.severity).toBe("critical");
    expect(byId(result.checks, "git-config-not-served").status).toBe("pass");
    // The file content is never echoed.
    expect(deps.reporter.text()).not.toContain("postgres://x");
    expect(JSON.stringify(result.checks)).not.toContain("postgres://x");
  });

  it("fails when the origin answers directly although only Cloudflare may reach it", async () => {
    const deps = await setup();
    const result = await runVerify(deps, {
      resolver: resolver(),
      fetch: fakeSite().fetch,
      tlsConnect: cert(),
      tcpConnect: async (host, port) => host === SERVER_IPV4 && port === 443,
      cloudflareRanges: CLOUDFLARE_RANGES,
    });
    const origin = byId(result.checks, "origin-not-direct");
    expect(origin.status).toBe("fail");
    expect(origin.message).toContain(SERVER_IPV4);
    expect((origin as { remediation?: string }).remediation).toContain("Hetzner Cloud firewall");
  });

  it("names the DigitalOcean firewall and console in its hints for a DigitalOcean plan", async () => {
    const deps = await setup({ provider: "digitalocean" });
    const result = await runVerify(deps, {
      resolver: resolver(),
      fetch: fakeSite({
        routes: {
          "https://shop.example.com/": () => {
            throw new Error("connection refused");
          },
        },
      }).fetch,
      tlsConnect: cert(),
      tcpConnect: async (host, port) => host === SERVER_IPV4 && port === 443,
      cloudflareRanges: CLOUDFLARE_RANGES,
    });
    const hints = (id: string) => (byId(result.checks, id) as { remediation?: string }).remediation;
    expect(hints("origin-not-direct")).toContain("DigitalOcean firewall");
    expect(hints("site-reachable")).toContain("Droplet is running");
    expect(hints("site-reachable")).toContain("https://cloud.digitalocean.com/");
    expect(JSON.stringify(result.checks)).not.toContain("Hetzner");
  });

  it("reports missing security headers, a broken redirect and a failing health endpoint", async () => {
    const deps = await setup();
    const result = await runVerify(deps, {
      resolver: resolver(),
      fetch: fakeSite({
        headers: { "x-content-type-options": "nosniff" },
        routes: {
          "http://shop.example.com/": () => new Response("plain"),
          "https://shop.example.com/api/health": () => new Response("down", { status: 503 }),
        },
      }).fetch,
      tlsConnect: cert(),
      tcpConnect: closed,
      cloudflareRanges: CLOUDFLARE_RANGES,
    });
    expect(byId(result.checks, "security-headers").message).toBe(
      "Missing or weak headers: strict-transport-security, x-frame-options, referrer-policy.",
    );
    expect(byId(result.checks, "http-redirect").message).toContain("HTTP 200");
    expect(byId(result.checks, "health-endpoint").message).toContain("HTTP 503");
  });

  it("asks no public resolver about a missing record outside the user's Portainer", async () => {
    const deps = await setup();
    const site = fakeSite();
    const result = await runVerify(deps, {
      resolver: resolver([], []),
      fetch: async (input, init) => {
        if (String(input).includes("cloudflare-dns.com")) throw new Error("no public lookup here");
        if (String(input).includes("api.github.com")) return site.fetch(input, init);
        throw new TypeError("fetch failed", {
          cause: Object.assign(new Error("getaddrinfo ENOTFOUND shop.example.com"), {
            code: "ENOTFOUND",
          }),
        });
      },
      fetchWithLookup: () => {
        throw new Error("no public answer outside the user's Portainer");
      },
      tlsConnect: async (_host, options) => {
        if (options.lookup) throw new Error("no public answer outside the user's Portainer");
        return cert()(_host, options);
      },
      tcpConnect: closed,
      cloudflareRanges: CLOUDFLARE_RANGES,
    });
    expect(byId(result.checks, "dns-records").message).toBe(
      "shop.example.com has no A or AAAA record.",
    );
    expect(JSON.stringify(result.checks)).not.toContain("older answer");
  });

  it("fails when the site cannot be reached", async () => {
    const deps = await setup();
    const result = await runVerify(deps, {
      resolver: resolver(),
      fetch: async (input) => {
        if (String(input).includes("api.github.com")) return Response.json({ workflow_runs: [] });
        throw new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED") });
      },
      tlsConnect: cert(),
      tcpConnect: closed,
      cloudflareRanges: CLOUDFLARE_RANGES,
    });
    const site = byId(result.checks, "site-reachable");
    expect(site.status).toBe("fail");
    expect(site.message).toContain("ECONNREFUSED");
    expect(byId(result.checks, "security-headers").status).toBe("skip");
    expect(byId(result.checks, "deploy-run").message).toContain("has not run on main yet");
  });

  it("fails on a failed deploy run and warns while one is running", async () => {
    const failed = await setup();
    const a = await runVerify(failed, {
      resolver: resolver(),
      fetch: fakeSite({ runs: [{ status: "completed", conclusion: "failure" }] }).fetch,
      tlsConnect: cert(),
      tcpConnect: closed,
      cloudflareRanges: CLOUDFLARE_RANGES,
    });
    expect(byId(a.checks, "deploy-run").status).toBe("fail");
    expect(byId(a.checks, "deploy-run").message).toContain(RUN_URL);

    const running = await setup();
    const b = await runVerify(running, {
      resolver: resolver(),
      fetch: fakeSite({ runs: [{ status: "in_progress", conclusion: null }] }).fetch,
      tlsConnect: cert(),
      tcpConnect: closed,
      cloudflareRanges: CLOUDFLARE_RANGES,
    });
    expect(byId(b.checks, "deploy-run").status).toBe("warn");
    expect(byId(b.checks, "deploy-run").message).toContain("still in progress");
    // Passed with a warning: the URL is recorded but there is no new deploy time.
    expect(b.passed).toBe(true);
    const plan: DeployPlan = await readArtifact("plan", running.paths.files.plan);
    expect(plan.deployment.url).toBe("https://shop.example.com");
    expect(plan.deployment.firstDeployAt).toBeUndefined();
  });

  it("warns about the deploy run without a GitHub token", async () => {
    const deps = await setup({}, { token: false });
    const result = await runVerify(deps, {
      resolver: resolver(),
      fetch: fakeSite().fetch,
      tlsConnect: cert(),
      tcpConnect: closed,
      cloudflareRanges: CLOUDFLARE_RANGES,
    });
    const run = byId(result.checks, "deploy-run");
    expect(run.status).toBe("warn");
    expect(run.message).toContain("GITHUB_TOKEN");
  });

  it("on a fresh clone, DNS checks say where to run verify instead of failing (no local record)", async () => {
    const deps = await setup({ proxied: false, www: true });
    await rm(serverAddressesFile(deps.paths));
    const result = await runVerify(deps, {
      resolver: resolver([SERVER_IPV4], [SERVER_IPV6]),
      fetch: fakeSite().fetch,
      tlsConnect: cert(),
      tcpConnect: closed,
    });
    for (const id of ["dns-records", "dns-records-www"]) {
      const check = byId(result.checks, id) as {
        status: string;
        message: string;
        remediation?: string;
      };
      expect(check.status).toBe("warn");
      expect(check.message).toContain(
        "OpsCrew does not know the server's address on this computer",
      );
      expect(check.remediation).toBe(
        "Run `opscrew verify` on the computer that provisioned the server (its `.opscrew/` folder holds the address).",
      );
      expect(`${check.message} ${check.remediation}`).not.toContain("opscrew dns");
    }
    expect(result.passed).toBe(true);
  });

  it("on a fresh clone without a domain, says where to run verify, never `opscrew provision`", async () => {
    const deps = await setup({ domain: undefined });
    await rm(serverAddressesFile(deps.paths));
    const error = await runVerify(deps, { fetch: fakeSite().fetch }).then(
      () => undefined,
      (e: unknown) => e as { code: string; message: string; hint: string },
    );
    expect(error).toMatchObject({ code: "PHASE_PRECONDITION" });
    expect(error?.message).toContain("OpsCrew does not know the server's address on this computer");
    expect(error?.hint).toBe(
      "Run `opscrew verify` on the computer that provisioned the server (its `.opscrew/` folder holds the address).",
    );
    expect(error?.hint).not.toContain("opscrew provision");
  });

  it("refuses to run before the server exists", async () => {
    const deps = await setup({ domain: undefined, ip: false });
    await expect(runVerify(deps, { fetch: fakeSite().fetch })).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
    });
    expect((await deps.state.read()).phases.verify?.status).toBe("failed");
  });
});

describe("certificateCoversHost", () => {
  it("matches exact names and single-label wildcards", () => {
    expect(certificateCoversHost("shop.example.com", ["SHOP.example.com."])).toBe(true);
    expect(certificateCoversHost("shop.example.com", ["*.example.com"])).toBe(true);
    expect(certificateCoversHost("a.shop.example.com", ["*.example.com"])).toBe(false);
    expect(certificateCoversHost("example.com", ["*.example.com"])).toBe(false);
    expect(certificateCoversHost("shop.example.com", ["example.com"])).toBe(false);
  });
});
