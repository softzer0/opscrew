import { mkdtemp, readFile } from "node:fs/promises";
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
import { type DnsResolver, runVerify, type TlsConnect } from "./index";

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
    const result = await runVerify(deps, {
      url: `${route}/`,
      resolver: resolver([]),
      fetch: fakeSite(route),
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
    const plan = await readArtifact("plan", deps.paths.files.plan);
    expect(plan.deployment.url).toBe("https://shop.example.com");
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
