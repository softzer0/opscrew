import { mkdtemp, readFile } from "node:fs/promises";
import type { LookupFunction } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FetchLike } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { readArtifact, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import {
  fakeCertificate,
  type PortainerPlanOptions,
  portainerPlan,
} from "../provision/__fixtures__/portainer";
import { recordPortainerConnection } from "../shared";
import { createTestPhaseDeps, ScriptedRunner } from "../testing";
import { CLOUDFLARE_IPV4, CLOUDFLARE_IPV6, CLOUDFLARE_RANGES } from "./__fixtures__/plan";
import type { DnsResolver, TlsConnect } from "./net";
import { runVerify } from "./run";

const NOW = "2026-10-11T12:00:00.000Z";
/** Portainer's address: never printed or committed. */
const PORTAINER_HOST = "nas-portainer.home.arpa";
/** The user's home address, which a Caddy record points at: never printed. */
const HOME_IPV4 = "198.51.100.77";

const HEADERS = {
  "strict-transport-security": "max-age=31536000",
  "x-content-type-options": "nosniff",
  "x-frame-options": "SAMEORIGIN",
  "referrer-policy": "strict-origin-when-cross-origin",
};

/** The site at `base` (HTTP redirects to it), and GitHub's workflow runs. */
function fakeSite(base: string, o: { down?: boolean } = {}): FetchLike {
  return async (input) => {
    const url = String(input);
    const parsed = new URL(url);
    if (parsed.host === "api.github.com") {
      return Response.json({
        workflow_runs: [
          {
            id: 42,
            status: "completed",
            conclusion: "success",
            html_url: "https://github.com/acme/shop/actions/runs/42",
            head_sha: "abc123",
            created_at: "2026-10-11T11:00:00Z",
          },
        ],
      });
    }
    if (parsed.protocol === "http:" && `https://${parsed.host}` === base) {
      return new Response(null, {
        status: 308,
        headers: { location: `${base}${parsed.pathname}` },
      });
    }
    if (o.down === true) return new Response("bad gateway", { status: 502 });
    if (url === `${base}/`) return new Response("<!doctype html><p>shop</p>", { headers: HEADERS });
    if (url === `${base}/api/health`) return new Response("ok");
    return new Response("not found", { status: 404 });
  };
}

const resolver = (a: string[], aaaa: string[] = []): DnsResolver => ({
  resolve4: async () => a,
  resolve6: async () => aaaa,
});

const cert =
  (host: string): TlsConnect =>
  async () => ({
    subjectCommonName: host,
    subjectAltNames: [host],
    validFrom: "2026-09-20T00:00:00.000Z",
    validTo: "2026-12-19T00:00:00.000Z",
    issuer: "Let's Encrypt",
  });

async function setup(plan: PortainerPlanOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), "opscrew-verify-portainer-"));
  const deps = await createTestPhaseDeps({
    root,
    env: { OPSCREW_HOME: join(root, ".home-opscrew"), GITHUB_TOKEN: fakeSecret("github-token") },
    runner: new ScriptedRunner((command, args) =>
      command === "git" && args.includes("get-url")
        ? { exitCode: 0, stdout: "https://github.com/acme/shop.git\n", stderr: "" }
        : { exitCode: 1, stdout: "", stderr: "unexpected command" },
    ),
    clock: { now: () => new Date(NOW) },
  });
  await writeArtifact("plan", deps.paths.files.plan, portainerPlan({ deployed: true, ...plan }));
  await recordPortainerConnection(deps.paths, {
    url: `https://${PORTAINER_HOST}:9443`,
    certFingerprint: fakeCertificate().fingerprint,
    environmentId: 3,
    environmentName: "local",
  });
  return deps;
}

const statuses = (checks: { id: string; status: string }[]) =>
  checks.map((check) => [check.id, check.status]);

describe("opscrew verify for the user's Portainer", () => {
  it("tunnel: checks the site through its domain and writes a runbook that names no address", async () => {
    const deps = await setup();
    const result = await runVerify(deps, {
      resolver: resolver([CLOUDFLARE_IPV4], [CLOUDFLARE_IPV6]),
      fetch: fakeSite("https://shop.example.com"),
      tlsConnect: cert("shop.example.com"),
      tcpConnect: async () => {
        throw new Error("verify probes no host port of a Portainer target");
      },
      cloudflareRanges: CLOUDFLARE_RANGES,
    });
    expect(statuses(result.checks)).toEqual([
      ["dns-records", "pass"],
      ["site-reachable", "pass"],
      ["tls-certificate", "pass"],
      ["http-redirect", "pass"],
      ["health-endpoint", "pass"],
      ["security-headers", "pass"],
      ["env-file-not-served", "pass"],
      ["git-config-not-served", "pass"],
      ["origin-not-direct", "skip"],
      ["deploy-run", "pass"],
    ]);
    expect(result.passed).toBe(true);
    expect(result.checks.find((c) => c.id === "dns-records")?.message).toContain(
      "served through the Cloudflare Tunnel",
    );
    const runbook = await readFile(deps.paths.files.runbook, "utf8");
    expect(runbook).toContain("as the stack `opscrew-shop`");
    expect(runbook).toContain("OpsCrew does not change the host");
    expect(runbook).toContain("Backups, including the app's data volumes, are your responsibility");
    expect(runbook).toContain("`opscrew-shop_postgres_data`");
    expect(runbook).toContain("opscrew-shop-updater");
    expect(runbook).not.toContain(PORTAINER_HOST);
    const plan = await readArtifact("plan", deps.paths.files.plan);
    expect(plan.deployment.url).toBe("https://shop.example.com");
    expect(deps.reporter.text()).not.toContain(PORTAINER_HOST);
  });

  it("caddy: the DNS check never shows the host's address, and a failure points at Portainer's logs", async () => {
    const deps = await setup({ web: { mode: "caddy" } });
    const result = await runVerify(deps, {
      resolver: resolver([HOME_IPV4]),
      fetch: fakeSite("https://shop.example.com", { down: true }),
      tlsConnect: cert("shop.example.com"),
      tcpConnect: async () => false,
    });
    const dns = result.checks.find((c) => c.id === "dns-records");
    expect(dns?.status).toBe("pass");
    const site = result.checks.find((c) => c.id === "site-reachable");
    expect(site?.status).toBe("fail");
    expect(site?.remediation).toContain("Stacks → opscrew-shop");
    expect(result.checks.find((c) => c.id === "origin-not-direct")?.message).toContain(
      "OpsCrew does not change your Portainer host",
    );
    const everything = `${deps.reporter.text()}\n${JSON.stringify(result.checks)}\n${await readFile(deps.paths.files.runbook, "utf8")}`;
    expect(everything).not.toContain(HOME_IPV4);
    expect(everything).not.toContain(PORTAINER_HOST);
    expect(await readFile(deps.paths.files.runbook, "utf8")).toContain("ports 80 and 443");
  });

  it("proxy without a domain: needs the user's route, checks it, and never commits it", async () => {
    const deps = await setup({ web: { mode: "proxy", port: 8080 }, domain: null });
    const error = await runVerify(deps, { fetch: fakeSite("https://x.invalid") }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(OpsCrewError);
    expect((error as OpsCrewError).hint).toContain("opscrew verify --url");

    // The route on Portainer's own host name: checked, but the name is never shown.
    const route = `https://${PORTAINER_HOST}:8443`;
    const tlsPorts: number[] = [];
    const routeSite = fakeSite(route);
    const result = await runVerify(deps, {
      url: `${route}/`,
      resolver: resolver([]),
      // A route that answers: its name is never sent to a public resolver.
      fetch: async (input, init) => {
        if (String(input).includes("cloudflare-dns.com")) throw new Error("no public lookup");
        return routeSite(input, init);
      },
      tlsConnect: async (host, options) => {
        tlsPorts.push(options.port ?? 443);
        return cert(PORTAINER_HOST)(host, options);
      },
      tcpConnect: async () => false,
    });
    expect(statuses(result.checks).slice(0, 4)).toEqual([
      ["dns-records", "skip"],
      ["site-reachable", "pass"],
      ["tls-certificate", "pass"],
      ["http-redirect", "skip"],
    ]);
    expect(tlsPorts).toEqual([8443]);
    expect(result.passed).toBe(true);
    expect(deps.reporter.text()).not.toContain(PORTAINER_HOST);
    const plan = await readArtifact("plan", deps.paths.files.plan);
    expect(plan.deployment.url).toBeUndefined();
    expect(await readFile(deps.paths.files.runbook, "utf8")).toContain(
      "your reverse proxy's route to port 8080",
    );

    await expect(
      runVerify(deps, { url: "ftp://somewhere", fetch: fakeSite(route) }),
    ).rejects.toThrow(/http:\/\/ or https:\/\//);
  });

  it("proxy: the user's route is never shown, whether an IP address or a host name (T1019)", async () => {
    const ROUTE_IPV4 = "203.0.113.10";
    for (const route of [`http://${ROUTE_IPV4}:8080`, "https://apps.lab.example.net"]) {
      const deps = await setup({ web: { mode: "proxy", port: 8080 }, domain: null });
      const host = new URL(route).hostname;
      const result = await runVerify(deps, {
        url: route,
        resolver: resolver([]),
        fetch: async (input, init) => {
          if (String(input).includes("cloudflare-dns.com")) throw new Error("no public lookup");
          return fakeSite(route)(input, init);
        },
        tlsConnect: async (h, options) => cert(h)(h, options),
        tcpConnect: async () => false,
      });
      expect(result.passed).toBe(true);
      const runbook = await readFile(deps.paths.files.runbook, "utf8");
      const output = deps.reporter.text();
      const everything = `${output}\n${JSON.stringify(result.checks)}\n${runbook}`;
      expect(everything).not.toContain(host);
      expect(everything).not.toContain(route);
      // Where a message names the route, it reads as the user's route.
      expect(output).toContain("your route");
      expect(result.checks.find((c) => c.id === "site-reachable")?.message).toContain("your route");
      // Anything else that passes through the redactor (MCP results, audit entries) hides it too.
      expect(deps.redactor.redact(`at ${route}/ and ${host}`)).not.toContain(host);
    }
  });

  it("proxy with a domain and a route: checks the route, commits only the domain's URL", async () => {
    const deps = await setup({ web: { mode: "proxy", port: 8080 } });
    const route = "https://proxy.example.net";
    const site = fakeSite("https://shop.example.com");
    const routeSite = fakeSite(route);
    const result = await runVerify(deps, {
      url: route,
      resolver: resolver([HOME_IPV4]),
      fetch: (input, init) =>
        String(input).startsWith(route) ? routeSite(input, init) : site(input, init),
      tlsConnect: cert("shop.example.com"),
      tcpConnect: async () => false,
    });
    expect(result.passed).toBe(true);
    expect(result.url).toBe(route);
    // The user's proxy is set up for the domain: its checks pass as before.
    expect(statuses(result.checks).slice(0, 4)).toEqual([
      ["dns-records", "pass"],
      ["site-reachable", "pass"],
      ["tls-certificate", "pass"],
      ["http-redirect", "pass"],
    ]);
    const plan = await readArtifact("plan", deps.paths.files.plan);
    expect(plan.deployment.url).toBe("https://shop.example.com");
  });

  it("proxy with a domain the user has not set up yet: its checks warn, the route decides", async () => {
    const deps = await setup({ web: { mode: "proxy", port: 8080 } });
    const route = "https://proxy.example.net";
    const routeSite = fakeSite(route);
    const result = await runVerify(deps, {
      url: route,
      resolver: resolver([]),
      fetch: (input, init) => {
        if (String(input).startsWith("http://shop.example.com")) {
          throw new Error("getaddrinfo ENOTFOUND");
        }
        return routeSite(input, init);
      },
      tlsConnect: async (host, options) => {
        if (host === "shop.example.com") throw new Error("getaddrinfo ENOTFOUND");
        return cert(host)(host, options);
      },
      tcpConnect: async () => false,
    });
    expect(statuses(result.checks).slice(0, 4)).toEqual([
      ["dns-records", "warn"],
      ["site-reachable", "pass"],
      ["tls-certificate", "warn"],
      ["http-redirect", "warn"],
    ]);
    expect(result.passed).toBe(true);
    for (const id of ["dns-records", "tls-certificate", "http-redirect"]) {
      const check = result.checks.find((c) => c.id === id);
      expect(check?.message).toContain("are yours");
      expect(check?.remediation).toContain("create the record OpsCrew printed");
      expect(check?.remediation).toContain("route shop.example.com in your proxy");
    }
    expect(result.checks.find((c) => c.id === "dns-records")?.message).toContain(
      "has no A or AAAA record",
    );

    // A domain that answers without a redirect, with another name's certificate: still warnings.
    const answers = await runVerify(deps, {
      url: route,
      resolver: resolver([HOME_IPV4]),
      fetch: async (input, init) =>
        String(input).startsWith("http://shop.example.com")
          ? new Response("plain", { status: 200 })
          : routeSite(input, init),
      tlsConnect: cert("other.example.org"),
      tcpConnect: async () => false,
    });
    expect(statuses(answers.checks).slice(0, 4)).toEqual([
      ["dns-records", "pass"],
      ["site-reachable", "pass"],
      ["tls-certificate", "warn"],
      ["http-redirect", "warn"],
    ]);
    expect(answers.passed).toBe(true);
    expect(JSON.stringify(answers.checks)).not.toContain(HOME_IPV4);
  });

  it("caddy: a domain without a record still fails", async () => {
    const deps = await setup({ web: { mode: "caddy" } });
    const result = await runVerify(deps, {
      resolver: resolver([]),
      fetch: fakeSite("https://shop.example.com"),
      tlsConnect: async () => {
        throw new Error("getaddrinfo ENOTFOUND");
      },
      tcpConnect: async () => false,
    });
    expect(result.checks.find((c) => c.id === "dns-records")?.status).toBe("fail");
    expect(result.checks.find((c) => c.id === "tls-certificate")?.status).toBe("fail");
    expect(result.passed).toBe(false);
  });

  describe("a stale answer in this computer's DNS cache", () => {
    /** Node's fetch error for a host the system resolver does not know. */
    const notFound = (host: string) =>
      new TypeError("fetch failed", {
        cause: Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" }),
      });

    /** Cloudflare's public resolver (`found`: the record exists), and a site this computer cannot find. */
    function staleInternet(found: boolean) {
      const dohQueries: string[] = [];
      const site = fakeSite("https://shop.example.com");
      const fetch: FetchLike = async (input, init) => {
        const url = new URL(String(input));
        if (url.host === "cloudflare-dns.com") {
          const name = url.searchParams.get("name") ?? "";
          dohQueries.push(`${name} ${url.searchParams.get("type")}`);
          return found
            ? Response.json({
                Status: 0,
                Answer: [{ name: `${name}.`, type: 5, data: "abc.cfargotunnel.com." }],
              })
            : Response.json({ Status: 3 });
        }
        if (url.host === "api.github.com") return site(input, init);
        throw notFound(url.hostname);
      };
      return { fetch, dohQueries };
    }

    /** This computer's own lookup (`dns.lookup`), which still says there is no such name. */
    const systemLookup = ((host, _options, callback) =>
      process.nextTick(() =>
        callback(
          Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" }),
          "",
          0,
        ),
      )) as LookupFunction;

    const tlsNotFound: TlsConnect = async (host) => {
      throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    };

    it("a public record without an address: nothing to connect to, so the usual messages; one lookup", async () => {
      const deps = await setup();
      const internet = staleInternet(true);
      const result = await runVerify(deps, {
        resolver: resolver([]),
        fetch: internet.fetch,
        tlsConnect: tlsNotFound,
        tcpConnect: async () => false,
        cloudflareRanges: CLOUDFLARE_RANGES,
        fetchWithLookup: () => {
          throw new Error("no public address to connect to");
        },
        lookup: systemLookup,
      });
      expect(result.passed).toBe(false);
      const dns = result.checks.find((c) => c.id === "dns-records");
      expect(dns?.message).toBe("shop.example.com has no A or AAAA record.");
      expect(dns?.remediation).toContain("opscrew dns");
      for (const id of ["site-reachable", "tls-certificate", "health-endpoint"]) {
        expect(result.checks.find((c) => c.id === id)?.message, id).toContain("ENOTFOUND");
      }
      expect(JSON.stringify(result.checks)).not.toContain("older answer");
      // The host is looked up once (A and AAAA, each following its CNAME), however many checks fail.
      expect(new Set(internet.dohQueries.map((q) => q.split(" ")[0]))).toEqual(
        new Set(["shop.example.com", "abc.cfargotunnel.com"]),
      );
      expect(internet.dohQueries.length).toBeLessThanOrEqual(4);
    });

    /** Cloudflare's public resolver with `zone`'s addresses (NXDOMAIN elsewhere), GitHub, nothing else. */
    function publicInternet(zone: Record<string, { ipv4?: string[]; ipv6?: string[] }>) {
      const site = fakeSite("https://shop.example.com");
      const fetch: FetchLike = async (input, init) => {
        const url = new URL(String(input));
        if (url.host === "cloudflare-dns.com") {
          const name = url.searchParams.get("name") ?? "";
          const type = url.searchParams.get("type");
          const records = zone[name];
          if (records === undefined) return Response.json({ Status: 3 });
          const edge = `${name}.cdn.cloudflare.net.`;
          const addresses = (type === "A" ? records.ipv4 : records.ipv6) ?? [];
          return Response.json({
            Status: 0,
            Answer: [
              { name: `${name}.`, type: 5, data: edge },
              ...addresses.map((data) => ({ name: edge, type: type === "A" ? 1 : 28, data })),
            ],
          });
        }
        if (url.host === "api.github.com") return site(input, init);
        throw notFound(url.hostname);
      };
      return fetch;
    }

    /** What the lookup a connection is given answers for `host`. */
    const resolveWith = (lookup: LookupFunction, host: string) =>
      new Promise<string[]>((resolve, reject) =>
        lookup(host, { all: true }, (error, addresses) =>
          error
            ? reject(error)
            : resolve((addresses as { address: string }[]).map((a) => a.address)),
        ),
      );

    /**
     * A fetch that connects through the lookup it is given: `sites[base]` answers when the lookup
     * finds the host, so the site is reached only through the public answer.
     */
    function throughLookup(sites: Record<string, FetchLike>) {
      const requests: { url: string; addresses: string[] }[] = [];
      const fetchWithLookup = (lookup: LookupFunction): FetchLike => {
        return async (input, init) => {
          const url = new URL(String(input));
          const addresses = await resolveWith(lookup, url.hostname).catch((cause: unknown) => {
            throw new TypeError("fetch failed", { cause });
          });
          requests.push({ url: url.href, addresses });
          const site = sites[`https://${url.host}`];
          if (!site) throw new Error(`no site at ${url.host}`);
          return site(input, init);
        };
      };
      return { fetchWithLookup, requests };
    }

    it("tunnel: checks the site through the public answer, passes, and says how to clear the cache", async () => {
      const deps = await setup();
      const site = fakeSite("https://shop.example.com");
      const via = throughLookup({ "https://shop.example.com": site });
      const tlsLookups: string[][] = [];
      const result = await runVerify(deps, {
        resolver: resolver([]),
        fetch: publicInternet({
          "shop.example.com": { ipv4: [CLOUDFLARE_IPV4], ipv6: [CLOUDFLARE_IPV6] },
        }),
        fetchWithLookup: via.fetchWithLookup,
        lookup: systemLookup,
        tlsConnect: async (host, options) => {
          expect(host).toBe("shop.example.com");
          if (!options.lookup) throw notFound(host);
          tlsLookups.push(await resolveWith(options.lookup, host));
          return cert(host)(host, options);
        },
        tcpConnect: async () => false,
        cloudflareRanges: CLOUDFLARE_RANGES,
      });
      expect(statuses(result.checks)).toEqual([
        ["dns-records", "warn"],
        ["site-reachable", "pass"],
        ["tls-certificate", "pass"],
        ["http-redirect", "pass"],
        ["health-endpoint", "pass"],
        ["security-headers", "pass"],
        ["env-file-not-served", "pass"],
        ["git-config-not-served", "pass"],
        ["origin-not-direct", "skip"],
        ["deploy-run", "pass"],
      ]);
      expect(result.passed).toBe(true);
      const dns = result.checks.find((c) => c.id === "dns-records");
      expect(dns?.message).toContain("resolves to Cloudflare");
      expect(dns?.message).toContain("This computer's DNS still holds an older answer");
      expect(dns?.message).toContain("as visitors reach it");
      expect(dns?.remediation).toContain("ipconfig /flushdns");
      // Connections keep the host name (for SNI and the certificate); only the lookup changed.
      expect(via.requests.map((r) => new URL(r.url).hostname)).toEqual(
        Array(via.requests.length).fill("shop.example.com"),
      );
      expect(via.requests.length).toBeGreaterThanOrEqual(5);
      for (const request of via.requests) {
        expect(request.addresses).toEqual([CLOUDFLARE_IPV4, CLOUDFLARE_IPV6]);
      }
      expect(tlsLookups).toEqual([[CLOUDFLARE_IPV4, CLOUDFLARE_IPV6]]);
      // No address is printed.
      const everything = `${deps.reporter.text()}\n${JSON.stringify(result.checks)}`;
      expect(everything).not.toContain(CLOUDFLARE_IPV4);
      expect(everything).not.toContain(CLOUDFLARE_IPV6);
      const plan = await readArtifact("plan", deps.paths.files.plan);
      expect(plan.deployment.url).toBe("https://shop.example.com");
    });

    it("caddy: a connection error through the public answer never shows the host's address", async () => {
      const deps = await setup({ web: { mode: "caddy" } });
      const refused = (host: string) =>
        new TypeError("fetch failed", {
          cause: Object.assign(new Error(`connect ECONNREFUSED ${HOME_IPV4}:443 (${host})`), {
            code: "ECONNREFUSED",
          }),
        });
      const fetchWithLookup = (lookup: LookupFunction): FetchLike => {
        return async (input) => {
          const url = new URL(String(input));
          expect(await resolveWith(lookup, url.hostname)).toEqual([HOME_IPV4]);
          throw refused(url.hostname);
        };
      };
      const result = await runVerify(deps, {
        resolver: resolver([]),
        fetch: publicInternet({ "shop.example.com": { ipv4: [HOME_IPV4] } }),
        fetchWithLookup,
        lookup: systemLookup,
        tlsConnect: async (host, options) => {
          if (!options.lookup) throw notFound(host);
          throw Object.assign(new Error(`connect ECONNREFUSED ${HOME_IPV4}:443`), {
            code: "ECONNREFUSED",
          });
        },
        tcpConnect: async () => false,
      });
      expect(result.passed).toBe(false);
      const dns = result.checks.find((c) => c.id === "dns-records");
      expect(dns?.status).toBe("warn");
      expect(dns?.message).toContain("This computer's DNS still holds an older answer");
      const site = result.checks.find((c) => c.id === "site-reachable");
      expect(site?.status).toBe("fail");
      expect(site?.message).toContain("ECONNREFUSED");
      expect(site?.message).not.toContain("ENOTFOUND");
      const tls = result.checks.find((c) => c.id === "tls-certificate");
      expect(tls?.status).toBe("fail");
      const everything = `${deps.reporter.text()}\n${JSON.stringify(result.checks)}\n${await readFile(deps.paths.files.runbook, "utf8")}`;
      expect(everything).not.toContain(HOME_IPV4);
    });

    it("proxy without a domain: the user's route is reached through the public answer", async () => {
      const deps = await setup({ web: { mode: "proxy", port: 8080 }, domain: null });
      const route = "https://proxy.example.net";
      const via = throughLookup({ [route]: fakeSite(route) });
      const result = await runVerify(deps, {
        url: route,
        resolver: resolver([]),
        fetch: publicInternet({ "proxy.example.net": { ipv4: [HOME_IPV4] } }),
        fetchWithLookup: via.fetchWithLookup,
        lookup: systemLookup,
        tlsConnect: async (host, options) => {
          if (!options.lookup) throw notFound(host);
          expect(await resolveWith(options.lookup, host)).toEqual([HOME_IPV4]);
          return cert(host)(host, options);
        },
        tcpConnect: async () => false,
      });
      expect(statuses(result.checks).slice(0, 4)).toEqual([
        ["dns-records", "skip"],
        ["site-reachable", "pass"],
        ["tls-certificate", "pass"],
        ["http-redirect", "pass"],
      ]);
      expect(result.passed).toBe(true);
      const dns = result.checks.find((c) => c.id === "dns-records");
      expect(dns?.message).toContain("This computer's DNS still holds an older answer");
      expect(dns?.message).toContain("ipconfig /flushdns");
      expect(`${deps.reporter.text()}\n${JSON.stringify(result.checks)}`).not.toContain(HOME_IPV4);
    });

    it("this computer's own lookup still answers first (a hosts file): the site check adds no note", async () => {
      const deps = await setup();
      const site = fakeSite("https://shop.example.com");
      const via = throughLookup({ "https://shop.example.com": site });
      const hostsFile = ((_host, options, callback) =>
        process.nextTick(() =>
          options.all
            ? callback(null, [{ address: CLOUDFLARE_IPV4, family: 4 }])
            : callback(null, CLOUDFLARE_IPV4, 4),
        )) as LookupFunction;
      const result = await runVerify(deps, {
        resolver: resolver([]),
        fetch: publicInternet({ "shop.example.com": { ipv4: ["104.21.32.9"] } }),
        fetchWithLookup: via.fetchWithLookup,
        lookup: hostsFile,
        tlsConnect: cert("shop.example.com"),
        tcpConnect: async () => false,
        cloudflareRanges: CLOUDFLARE_RANGES,
      });
      expect(result.passed).toBe(true);
      expect(via.requests.every((r) => r.addresses[0] === CLOUDFLARE_IPV4)).toBe(true);
      expect(result.checks.find((c) => c.id === "site-reachable")?.message).not.toContain(
        "public resolver",
      );
    });

    it("without a public record: the usual messages, no cache note", async () => {
      const deps = await setup();
      const internet = staleInternet(false);
      const result = await runVerify(deps, {
        resolver: resolver([]),
        fetch: internet.fetch,
        tlsConnect: tlsNotFound,
        tcpConnect: async () => false,
        cloudflareRanges: CLOUDFLARE_RANGES,
      });
      expect(result.passed).toBe(false);
      const dns = result.checks.find((c) => c.id === "dns-records");
      expect(dns?.message).toBe("shop.example.com has no A or AAAA record.");
      expect(dns?.remediation).toContain("opscrew dns");
      expect(JSON.stringify(result.checks)).not.toContain("older answer");
    });

    it("proxy mode: the DNS warning keeps the cache advice", async () => {
      const deps = await setup({ web: { mode: "proxy", port: 8080 } });
      const route = "https://proxy.example.net";
      const routeSite = fakeSite(route);
      const internet = publicInternet({ "shop.example.com": { ipv4: [HOME_IPV4] } });
      const via = throughLookup({
        "https://shop.example.com": fakeSite("https://shop.example.com"),
      });
      const result = await runVerify(deps, {
        url: route,
        resolver: resolver([]),
        fetch: (input, init) =>
          String(input).startsWith(route) ? routeSite(input, init) : internet(input, init),
        fetchWithLookup: via.fetchWithLookup,
        lookup: systemLookup,
        tlsConnect: async (host, options) =>
          host === "shop.example.com" && !options.lookup
            ? tlsNotFound(host, options)
            : cert(host)(host, options),
        tcpConnect: async () => false,
      });
      const dns = result.checks.find((c) => c.id === "dns-records");
      expect(dns?.status).toBe("warn");
      expect(dns?.message).toContain("This computer's DNS still holds an older answer");
      expect(dns?.remediation).toContain("ipconfig /flushdns");
      expect(result.checks.find((c) => c.id === "site-reachable")?.status).toBe("pass");
      expect(result.passed).toBe(true);
    });
  });

  it("refuses a route outside web mode proxy, before checking anything", async () => {
    for (const web of [{ mode: "tunnel" as const }, { mode: "caddy" as const }]) {
      const deps = await setup({ web });
      const fetch: FetchLike = async () => {
        throw new Error("nothing is checked");
      };
      const error = await runVerify(deps, { url: "https://proxy.example.net", fetch }).catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(OpsCrewError);
      expect((error as OpsCrewError).code).toBe("INVALID_INPUT");
      expect((error as OpsCrewError).message).toContain("behind your own reverse proxy");
    }
  });
});
