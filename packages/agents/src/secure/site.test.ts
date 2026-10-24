import { readFile } from "node:fs/promises";
import { FAKE_ZONE_ID, FakeZone } from "@opscrew/connector-cloudflare/testing";
import type { FetchLike } from "@opscrew/contracts";
import { type DeployPlan, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { writeCloudflareRecord } from "../provision/shared-cloudflare";
import { createTestPhaseDeps, fakeSharedCloudflare, ScriptedRunner } from "../testing";
import { pagesTestPlan } from "../testing/pages";
import { sitePlan } from "../testing/serverless";
import { WORKER_PATH } from "../verify/serverless";
import { runSecure } from "./run";

const HEADERS = {
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "x-content-type-options": "nosniff",
  "x-frame-options": "SAMEORIGIN",
  "referrer-policy": "strict-origin-when-cross-origin",
};

/** The site: OpsCrew's headers on static files, and `worker` for the Worker's own answers. */
function site(worker: Record<string, string> = HEADERS) {
  const calls: string[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    calls.push(`${init?.method ?? "GET"} ${url.href}`);
    return url.pathname === WORKER_PATH
      ? new Response("not found", { status: 404, headers: worker })
      : new Response("<p>docs</p>", { headers: HEADERS });
  };
  return { fetch, calls };
}

async function secure(plan: DeployPlan, fetch: FetchLike, cloudflare?: FakeZone) {
  const runner = new ScriptedRunner(() => ({ exitCode: 1, stdout: "", stderr: "not here" }));
  const deps = await createTestPhaseDeps({ runner, fetch });
  await writeArtifact("plan", deps.paths.files.plan, plan);
  if (cloudflare !== undefined) {
    await writeCloudflareRecord(deps.paths, {
      zoneId: FAKE_ZONE_ID,
      hostnames: { "opscrew-www-redirect": ["www.docs.example.com"] },
      createdEntrypoints: [],
    });
  }
  const result = await runSecure(deps, {
    scanners: [],
    offline: true,
    ...(cloudflare !== undefined ? { cloudflare: fakeSharedCloudflare(cloudflare) } : {}),
  });
  return { deps, runner, result };
}

describe("opscrew secure on Cloudflare's hosting", () => {
  it("checks OpsCrew's headers on the site and the Worker, and no server", async () => {
    const internet = site({});
    const { result, runner, deps } = await secure(
      sitePlan({ render: "ssr", deployed: true }),
      internet.fetch,
    );

    expect(result.hostChecks.map((c) => [c.id, c.status])).toEqual([
      ["security-headers", "pass"],
      ["security-headers-worker", "fail"],
    ]);
    expect(result.probes).toEqual([]);
    expect(result.passed).toBe(false);
    expect(result.problems[0]).toMatchObject({ area: "The site", status: "fail" });
    expect(internet.calls.every((call) => call.startsWith("GET https://docs.example.com/"))).toBe(
      true,
    );
    // No SSH, no probe: nothing ran.
    expect(runner.calls).toEqual([]);
    const report = await readFile(deps.paths.files.securityReport, "utf8");
    expect(report).toContain("| The site on Cloudflare |");
    expect(report).toContain("## The site on Cloudflare");
    expect(report).toContain("OpsCrew runs no server for this site: Cloudflare serves it");
    expect(report).toContain("Skipped: OpsCrew probes no port");
    expect(report).not.toContain("Server hardening");
  });

  it("reads the www redirect's phase for the zone's minimum TLS when the record lists www", async () => {
    const zone = new FakeZone();
    const { result } = await secure(sitePlan({ www: true, deployed: true }), site().fetch, zone);

    expect(result.settings.find((c) => c.id === "min-tls")).toMatchObject({ status: "pass" });
    expect(zone.calls.some((c) => c.path.includes("http_request_dynamic_redirect"))).toBe(true);
    expect(zone.writes()).toEqual([]);
  });

  it("audits only the TLS with --deep: there is no server or SSH", async () => {
    const { result } = await secure(sitePlan({ deployed: true }), site().fetch);
    expect(result.hostChecks.map((c) => c.status)).toEqual(["pass"]);

    const deep = await (async () => {
      const runner = new ScriptedRunner(() => ({ exitCode: 1, stdout: "", stderr: "no docker" }));
      const deps = await createTestPhaseDeps({ runner, fetch: site().fetch });
      await writeArtifact("plan", deps.paths.files.plan, sitePlan({ deployed: true }));
      return runSecure(deps, { scanners: [], offline: true, deep: true });
    })();
    const [lynis, sshAudit] = deep.deep ?? [];
    expect(lynis?.results[0]?.message).toContain("The site has no server of its own");
    expect(sshAudit?.results[0]?.message).toContain("The site has no server of its own");
  });
});

describe("opscrew secure on GitHub Pages", () => {
  it("reports that GitHub Pages cannot set security headers, what it means, and that Cloudflare can", async () => {
    const internet = site();
    const { result, deps } = await secure(pagesTestPlan(), internet.fetch);

    expect(result.hostChecks).toHaveLength(1);
    const [headers] = result.hostChecks;
    expect(headers).toMatchObject({ id: "security-headers", status: "warn" });
    expect(headers?.message).toContain("GitHub Pages cannot set security headers");
    expect(headers?.message).toContain("another site can show its pages in a frame");
    expect(headers?.remediation).toContain("Cloudflare's hosting can");
    expect(result.passed).toBe(true);
    // Nothing is fetched: the finding holds for every GitHub Pages site.
    expect(internet.calls).toEqual([]);
    const report = await readFile(deps.paths.files.securityReport, "utf8");
    expect(report).toContain("## The site on GitHub Pages");
    expect(report).toContain("GitHub Pages serves it");
  });
});
