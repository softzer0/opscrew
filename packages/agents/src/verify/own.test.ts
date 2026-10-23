import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FetchLike } from "@opscrew/contracts";
import { renderRunbook, tunnelMode } from "@opscrew/iac-templates";
import { type DeployPlan, writeArtifact } from "@opscrew/plan-schema";
import type { TcpConnect } from "@opscrew/secops";
import { describe, expect, it } from "vitest";
import { recordOwnServer, recordServerAddress } from "../shared";
import {
  CLOUDFLARE_IPV4,
  CLOUDFLARE_IPV6,
  CLOUDFLARE_RANGES,
  createTestPhaseDeps,
  LAN_IPV4,
  OWN_IPV4,
  ownPlan,
  ScriptedRunner,
} from "../testing";
import type { DnsResolver, TlsConnect } from "./net";
import { runVerify } from "./run";

const NOW = "2026-10-14T12:00:00.000Z";

const HEADERS = {
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "x-content-type-options": "nosniff",
  "x-frame-options": "SAMEORIGIN",
  "referrer-policy": "strict-origin-when-cross-origin",
};

/** The site behind Cloudflare, and GitHub's runs API; any request to an IP address fails the test. */
function fakeSite(o: { down?: boolean } = {}) {
  const urls: string[] = [];
  const fetch: FetchLike = async (input) => {
    const url = String(input);
    urls.push(url);
    const parsed = new URL(url);
    if (/^[\d.]+$/.test(parsed.hostname)) throw new Error(`direct request to ${url}`);
    if (parsed.host === "api.github.com") {
      // The repository (its default branch) and its workflow runs, in one answer.
      return Response.json({
        default_branch: "main",
        private: true,
        workflow_runs: [
          {
            id: 42,
            status: "completed",
            conclusion: "success",
            html_url: "https://github.com/acme/shop/actions/runs/42",
            head_sha: "abc123",
            created_at: "2026-10-14T11:00:00Z",
          },
        ],
      });
    }
    if (o.down) throw new Error("connect ECONNREFUSED");
    if (url.startsWith("http://shop.example.com")) {
      return new Response(null, {
        status: 308,
        headers: { location: `https://shop.example.com${parsed.pathname}` },
      });
    }
    if (url === "https://shop.example.com/") {
      return new Response("<!doctype html><p>shop</p>", { headers: HEADERS });
    }
    if (url === "https://shop.example.com/api/health") return new Response("ok");
    return new Response("not found", { status: 404 });
  };
  return { fetch, urls };
}

const resolver: DnsResolver = {
  resolve4: async () => [CLOUDFLARE_IPV4],
  resolve6: async () => [CLOUDFLARE_IPV6],
};

const cert: TlsConnect = async (host) => {
  if (/^[\d.]+$/.test(host)) throw new Error(`direct TLS to ${host}`);
  return {
    subjectCommonName: "shop.example.com",
    subjectAltNames: ["shop.example.com"],
    validFrom: "2026-09-20T00:00:00.000Z",
    validTo: "2026-12-19T00:00:00.000Z",
    issuer: "Let's Encrypt",
  };
};

/** Any TCP probe is a direct IP check, which tunnel mode never makes. */
const noProbes: TcpConnect = async (host, port) => {
  throw new Error(`direct probe of ${host}:${port}`);
};

async function setup(plan: DeployPlan, own: { host: string; port: number; sshPort?: number }) {
  const root = await mkdtemp(join(tmpdir(), "opscrew-verify-own-"));
  const deps = await createTestPhaseDeps({
    root,
    env: { OPSCREW_HOME: join(root, ".home-opscrew"), GITHUB_TOKEN: "test-token-not-secret" },
    runner: new ScriptedRunner((command, args) =>
      command === "git" && args.includes("get-url")
        ? { exitCode: 0, stdout: "https://github.com/acme/shop.git\n", stderr: "" }
        : { exitCode: 1, stdout: "", stderr: "unexpected command" },
    ),
    clock: { now: () => new Date(NOW) },
  });
  await writeArtifact("plan", deps.paths.files.plan, {
    ...plan,
    dns: { ...plan.dns, zone: "example.com" },
    deployment: { lastApplyAt: "2026-10-14T11:30:00.000Z" },
  } as DeployPlan);
  await recordOwnServer(deps.paths, {
    host: own.host,
    port: own.port,
    user: "root",
    agent: true,
    reachable: plan.target.provider === "own" && plan.target.access === "public",
  });
  // What the last provision committed, never the address: tunnel mode writes sshd's port on the
  // server (the tunnel's SSH route); public mode writes no `ssh_port`.
  const infra = join(root, "opscrew", "infra", "prod");
  await mkdir(infra, { recursive: true });
  await writeFile(
    join(infra, "terraform.tfvars.json"),
    JSON.stringify(tunnelMode(plan) ? { ssh_port: own.sshPort ?? own.port } : {}),
  );
  return deps;
}

const byId = <T extends { id: string }>(checks: T[], id: string): T => {
  const found = checks.find((check) => check.id === id);
  if (found === undefined) throw new Error(`no check ${id}`);
  return found;
};

describe("runVerify on a server the user owns", () => {
  it("tunnel mode checks the domain only: no direct IP checks, no address in the runbook", async () => {
    const deps = await setup(ownPlan({ access: "tunnel" }), {
      host: LAN_IPV4,
      port: 22,
      sshPort: 2222,
    });
    // Even an old address in the local state is never used in tunnel mode.
    await recordServerAddress(deps.paths, { ipv4: "198.51.100.7" });
    const site = fakeSite();
    const result = await runVerify(deps, {
      resolver,
      fetch: site.fetch,
      tlsConnect: cert,
      tcpConnect: noProbes,
      cloudflareRanges: CLOUDFLARE_RANGES,
    });

    expect(result.passed).toBe(true);
    expect(result.url).toBe("https://shop.example.com");
    expect(byId(result.checks, "dns-records")).toMatchObject({ status: "pass" });
    expect(byId(result.checks, "dns-records").message).toContain("Cloudflare Tunnel");
    const origin = byId(result.checks, "origin-not-direct");
    expect(origin.status).toBe("skip");
    expect(origin.message).toContain("Cloudflare Tunnel");
    expect(
      site.urls.every((url) => url.includes("shop.example.com") || url.includes("github")),
    ).toBe(true);
    const everything = `${JSON.stringify(result.checks)}\n${deps.reporter.text()}`;
    expect(everything).not.toContain(LAN_IPV4);
    expect(everything).not.toContain("198.51.100.7");

    const runbook = await readFile(deps.paths.files.runbook, "utf8");
    expect(runbook).not.toContain(LAN_IPV4);
    expect(runbook).not.toContain("198.51.100.7");
    expect(runbook).toContain("-p 2222");
    expect(runbook).toContain("Backups are your responsibility");
  });

  it("public mode keeps the login port in the runbook when a router forwards it to sshd", async () => {
    // A router forwards 2222 to sshd's 22: provision used the login port, so the runbook must too.
    const deps = await setup(ownPlan(), { host: OWN_IPV4, port: 2222, sshPort: 22 });
    await runVerify(deps, {
      resolver,
      fetch: fakeSite().fetch,
      tlsConnect: cert,
      tcpConnect: async () => false,
      cloudflareRanges: CLOUDFLARE_RANGES,
    });
    const runbook = await readFile(deps.paths.files.runbook, "utf8");
    expect(runbook).toContain("-p 2222");
    expect(runbook).not.toContain(OWN_IPV4);
  });

  it("tunnel mode keeps sshd's own port from the committed configuration, not the login port", async () => {
    const deps = await setup(ownPlan({ access: "tunnel" }), {
      host: LAN_IPV4,
      port: 2200,
      sshPort: 2222,
    });
    await runVerify(deps, {
      resolver,
      fetch: fakeSite().fetch,
      tlsConnect: cert,
      tcpConnect: noProbes,
      cloudflareRanges: CLOUDFLARE_RANGES,
    });
    const runbook = await readFile(deps.paths.files.runbook, "utf8");
    expect(runbook).toContain("-p 2222");
    expect(runbook).not.toContain("-p 2200");
  });

  it("public mode on the same port renders the runbook byte-identically to a render without a port", async () => {
    const deps = await setup(ownPlan(), { host: OWN_IPV4, port: 22 });
    const result = await runVerify(deps, {
      resolver,
      fetch: fakeSite().fetch,
      tlsConnect: cert,
      tcpConnect: async () => false,
      cloudflareRanges: CLOUDFLARE_RANGES,
    });
    const expected = renderRunbook(result.plan, {
      opscrewVersion: deps.version,
      github: { owner: "acme", repo: "shop" },
      deploySshPublicKey: "",
      projectId: deps.paths.projectId,
    });
    expect(await readFile(deps.paths.files.runbook, "utf8")).toBe(expected.content);
    expect(expected.content).not.toContain("-p 22");
  });

  it("tunnel mode expects Cloudflare's addresses even when the plan's records are not proxied", async () => {
    const plan = ownPlan({ access: "tunnel" });
    const deps = await setup(
      { ...plan, dns: { ...plan.dns, proxied: false } },
      {
        host: LAN_IPV4,
        port: 22,
      },
    );
    const result = await runVerify(deps, {
      resolver: { resolve4: async () => ["192.0.2.55"], resolve6: async () => [] },
      fetch: fakeSite().fetch,
      tlsConnect: cert,
      tcpConnect: noProbes,
      cloudflareRanges: CLOUDFLARE_RANGES,
    });
    const dns = byId(result.checks, "dns-records");
    expect(dns.status).toBe("fail");
    expect(dns.message).toContain("not a Cloudflare address");
  });

  it("public mode behind Cloudflare's proxy: the origin check probes port 443 and names no address", async () => {
    const deps = await setup(ownPlan(), { host: OWN_IPV4, port: 22 });
    await recordServerAddress(deps.paths, { ipv4: OWN_IPV4 });
    const probed: string[] = [];
    const closed: TcpConnect = async (host, port) => {
      probed.push(`${host}:${port}`);
      return false;
    };
    const result = await runVerify(deps, {
      resolver,
      fetch: fakeSite().fetch,
      tlsConnect: cert,
      tcpConnect: closed,
      cloudflareRanges: CLOUDFLARE_RANGES,
    });
    expect(result.passed).toBe(true);
    expect(probed).toEqual([`${OWN_IPV4}:443`]);
    const origin = byId(result.checks, "origin-not-direct");
    expect(origin.status).toBe("pass");
    expect(origin.message).toBe(
      "Port 443 on your server is closed to direct visitors; only Cloudflare reaches it.",
    );
    expect(JSON.stringify(origin)).not.toContain(OWN_IPV4);
    // Behind Cloudflare's proxy the runbook never shows the address.
    expect(await readFile(deps.paths.files.runbook, "utf8")).not.toContain(OWN_IPV4);

    // Port 443 answers directly: a failure with the next step, still without the address.
    const open = await runVerify(deps, {
      resolver,
      fetch: fakeSite().fetch,
      tlsConnect: cert,
      tcpConnect: async () => true,
      cloudflareRanges: CLOUDFLARE_RANGES,
    });
    expect(open.passed).toBe(false);
    const direct = byId(open.checks, "origin-not-direct");
    expect(direct.status).toBe("fail");
    expect(direct.message).toContain("visitors can reach it around Cloudflare's protection");
    expect(direct.remediation).toContain("web filter (in Docker's DOCKER-USER chain)");
    expect(direct.remediation).toContain("`opscrew provision`");
    expect(JSON.stringify(direct)).not.toContain(OWN_IPV4);
  });

  it("behind the web filter, port 443 must not answer on the server's IPv6 address either", async () => {
    const OWN_IPV6 = "2001:db8::10";
    const deps = await setup(ownPlan(), { host: OWN_IPV4, port: 22 });
    await recordServerAddress(deps.paths, { ipv4: OWN_IPV4, ipv6: OWN_IPV6 });
    const run = (tcpConnect: TcpConnect, ipv6Route: boolean) =>
      runVerify(deps, {
        resolver,
        fetch: fakeSite().fetch,
        tlsConnect: cert,
        tcpConnect,
        ipv6Route: async () => ipv6Route,
        cloudflareRanges: CLOUDFLARE_RANGES,
      });
    const probed: string[] = [];
    const closed = await run(async (host, port) => {
      probed.push(`${host}:${port}`);
      return false;
    }, true);
    expect(probed).toEqual([`${OWN_IPV4}:443`, `${OWN_IPV6}:443`]);
    expect(byId(closed.checks, "origin-not-direct")).toMatchObject({
      status: "pass",
      message:
        "Port 443 on your server is closed to direct visitors (IPv4 and IPv6); only Cloudflare reaches it.",
    });

    // docker-proxy answering on IPv6 (around DOCKER-USER) is a failure, without the address.
    const open6 = await run(async (host) => host === OWN_IPV6, true);
    const direct = byId(open6.checks, "origin-not-direct");
    expect(direct.status).toBe("fail");
    expect(direct.message).toContain("Port 443 on your server's IPv6 address answers directly");
    expect(JSON.stringify(direct)).not.toMatch(/2001:db8|203\.0\.113/);

    // No IPv6 route from this computer: IPv4 only, and the result says so.
    const probedNoRoute: string[] = [];
    const noRoute = await run(async (host, port) => {
      probedNoRoute.push(`${host}:${port}`);
      return false;
    }, false);
    expect(probedNoRoute).toEqual([`${OWN_IPV4}:443`]);
    expect(byId(noRoute.checks, "origin-not-direct").message).toMatch(
      /could not try its IPv6 address: this computer has no IPv6 route/,
    );
  });

  it("public mode without Cloudflare's proxy: the origin check is skipped, no probe", async () => {
    const plan = ownPlan();
    const deps = await setup(
      {
        ...plan,
        dns: { ...plan.dns, proxied: false },
        security: { ...plan.security, httpAllowedFrom: "any" },
      },
      { host: OWN_IPV4, port: 22 },
    );
    await recordServerAddress(deps.paths, { ipv4: OWN_IPV4 });
    const result = await runVerify(deps, {
      resolver: { resolve4: async () => [OWN_IPV4], resolve6: async () => [] },
      fetch: fakeSite().fetch,
      tlsConnect: cert,
      tcpConnect: noProbes,
    });
    expect(byId(result.checks, "origin-not-direct")).toMatchObject({
      status: "skip",
      message: "Skipped: the site is not behind Cloudflare's proxy.",
    });
  });

  it("never writes the address into the runbook, also without Cloudflare's proxy or without a domain", async () => {
    const host = "server.example.net";
    // DNS only (not proxied): the address may be public, but it is still never committed.
    const plan = ownPlan();
    const dnsOnly = await setup(
      { ...plan, dns: { ...plan.dns, proxied: false } },
      { host, port: 22 },
    );
    await recordServerAddress(dnsOnly.paths, { ipv4: OWN_IPV4 });
    await runVerify(dnsOnly, {
      resolver: { resolve4: async () => [OWN_IPV4], resolve6: async () => [] },
      fetch: fakeSite().fetch,
      tlsConnect: cert,
      tcpConnect: noProbes,
    });
    // No domain: the app is checked on the address, which still stays out of the runbook.
    const noDomain = await setup(ownPlan({ domain: null }), { host, port: 22 });
    await recordServerAddress(noDomain.paths, { ipv4: OWN_IPV4 });
    await runVerify(noDomain, {
      resolver,
      fetch: async () => new Response("ok"),
      tlsConnect: cert,
      tcpConnect: noProbes,
    });
    for (const deps of [dnsOnly, noDomain]) {
      const runbook = await readFile(deps.paths.files.runbook, "utf8");
      expect(runbook).not.toContain(OWN_IPV4);
      expect(runbook).not.toContain(host);
      expect(runbook).toContain("deploy@<server>");
    }
  });

  it("never names the server's addresses or login host name in the terminal, in any mode", async () => {
    const OWN_IPV6 = "2001:db8::10";
    const LOGIN = "home-server.example.net";
    const plan = ownPlan();
    const dnsOnly: DeployPlan = {
      ...plan,
      dns: { ...plan.dns, proxied: false },
      security: { ...plan.security, httpAllowedFrom: "any" },
    };
    const cases: { plan: DeployPlan; records: string[][]; status: string; says: string }[] = [
      // DNS only: the records point at the server, at it and somewhere else, or nowhere known.
      {
        plan: dnsOnly,
        records: [[OWN_IPV4], [OWN_IPV6]],
        status: "pass",
        says: "resolves to your server's address",
      },
      {
        plan: dnsOnly,
        records: [[OWN_IPV4, "198.51.100.9"], []],
        status: "fail",
        says: "not only to your server's address",
      },
      // Behind Cloudflare's proxy and the web filter, a record that bypasses the proxy.
      { plan, records: [[OWN_IPV4], []], status: "fail", says: "resolves to your server itself" },
      // Tunnel mode: a record pointing at the server instead of Cloudflare.
      {
        plan: ownPlan({ access: "tunnel" }),
        records: [[OWN_IPV4], []],
        status: "fail",
        says: "not a Cloudflare address",
      },
    ];
    for (const item of cases) {
      const deps = await setup(item.plan, { host: LOGIN, port: 22 });
      await recordServerAddress(deps.paths, { ipv4: OWN_IPV4, ipv6: OWN_IPV6 });
      const [v4 = [], v6 = []] = item.records;
      const result = await runVerify(deps, {
        resolver: { resolve4: async () => v4, resolve6: async () => v6 },
        fetch: fakeSite().fetch,
        tlsConnect: cert,
        tcpConnect: async () => true,
        ipv6Route: async () => true,
        cloudflareRanges: CLOUDFLARE_RANGES,
      });
      const dns = byId(result.checks, "dns-records");
      expect(dns.status).toBe(item.status);
      expect(dns.message).toContain(item.says);
      const terminal = deps.reporter.text();
      for (const name of [OWN_IPV4, OWN_IPV6, LOGIN]) expect(terminal).not.toContain(name);
    }

    // A fresh clone (no address on this computer): the records are not printed either.
    const clone = await setup(dnsOnly, { host: LOGIN, port: 22 });
    const unknown = await runVerify(clone, {
      resolver: { resolve4: async () => [OWN_IPV4], resolve6: async () => [] },
      fetch: fakeSite().fetch,
      tlsConnect: cert,
      tcpConnect: noProbes,
    });
    expect(byId(unknown.checks, "dns-records").status).toBe("warn");
    expect(clone.reporter.text()).not.toContain(OWN_IPV4);
  });

  it("names your server, not a provider console, when the site cannot be reached", async () => {
    const deps = await setup(ownPlan({ access: "tunnel" }), { host: LAN_IPV4, port: 22 });
    const result = await runVerify(deps, {
      resolver,
      fetch: fakeSite({ down: true }).fetch,
      tlsConnect: cert,
      tcpConnect: noProbes,
      cloudflareRanges: CLOUDFLARE_RANGES,
    });
    const site = byId(result.checks, "site-reachable");
    expect(site.status).toBe("fail");
    expect(site.remediation).toContain("your server");
    expect(site.remediation).toContain("Tunnel connector");
    expect(site.remediation).not.toContain("console");
  });
});
