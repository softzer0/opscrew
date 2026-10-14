import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FetchLike } from "@opscrew/contracts";
import { type DeployPlan, writeArtifact } from "@opscrew/plan-schema";
import type { TcpConnect } from "@opscrew/secops";
import { describe, expect, it } from "vitest";
import { LAN_IPV4, OWN_IPV4, ownPlan } from "../provision/__fixtures__/own";
import { recordOwnServer, recordServerAddress } from "../shared";
import { createTestPhaseDeps, ScriptedRunner } from "../testing";
import { CLOUDFLARE_IPV4, CLOUDFLARE_IPV6, CLOUDFLARE_RANGES } from "./__fixtures__/plan";
import { type DnsResolver, runVerify, type TlsConnect } from "./index";

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
      return Response.json({
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
  // What the last provision committed: sshd's port on the server, never the address.
  const infra = join(root, "opscrew", "infra", "prod");
  await mkdir(infra, { recursive: true });
  await writeFile(
    join(infra, "terraform.tfvars.json"),
    JSON.stringify({ ssh_port: own.sshPort ?? own.port }),
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

  it("public mode: DNS is compared with the server; the origin check says ufw lets everyone in", async () => {
    const deps = await setup(ownPlan(), { host: OWN_IPV4, port: 22 });
    await recordServerAddress(deps.paths, { ipv4: OWN_IPV4 });
    const result = await runVerify(deps, {
      resolver,
      fetch: fakeSite().fetch,
      tlsConnect: cert,
      tcpConnect: noProbes,
      cloudflareRanges: CLOUDFLARE_RANGES,
    });
    expect(result.passed).toBe(true);
    const origin = byId(result.checks, "origin-not-direct");
    expect(origin.status).toBe("skip");
    expect(origin.message).toContain("ufw");
    // Behind Cloudflare's proxy the runbook never shows the address.
    expect(await readFile(deps.paths.files.runbook, "utf8")).not.toContain(OWN_IPV4);
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
