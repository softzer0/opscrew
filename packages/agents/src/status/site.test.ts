import { FAKE_ZONE_ID, FakeZone } from "@opscrew/connector-cloudflare/testing";
import type { FetchLike } from "@opscrew/contracts";
import { fakeSecret } from "@opscrew/core/testing";
import { DEPLOY_PAUSED_VARIABLE } from "@opscrew/iac-templates";
import { type DeployPlan, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { FakePromoteGitHub } from "../promote/__fixtures__/world";
import {
  createTestPhaseDeps,
  fakeCloudflare,
  fakeSharedCloudflare,
  ScriptedRunner,
} from "../testing";
import { type FakePagesOptions, fakeGithubPages, pagesTestPlan } from "../testing/pages";
import { sitePlan } from "../testing/serverless";
import { componentStatusReport } from "./run";

const SHA_NEW = "a".repeat(64);
const SHA_OLD = "b".repeat(64);

/** Deps for a project whose `origin` is `example-org/example-app` on GitHub, with `plan`. */
async function setup(plan: DeployPlan, fetch?: FetchLike) {
  const runner = new ScriptedRunner((command, args) =>
    command === "git" && args.includes("get-url")
      ? { exitCode: 0, stdout: "https://github.com/example-org/example-app.git\n", stderr: "" }
      : { exitCode: 1, stdout: "", stderr: "unexpected command" },
  );
  const deps = await createTestPhaseDeps({ runner, ...(fetch ? { fetch } : {}) });
  deps.env.GITHUB_TOKEN = fakeSecret("github-token", "status-site");
  deps.env.CLOUDFLARE_API_TOKEN = fakeSecret("cloudflare-token", "status-site");
  await writeArtifact("plan", deps.paths.files.plan, plan);
  return deps;
}

/** A Worker with two deployed versions, both from OpsCrew's deploy workflow. */
function zoneWithWorker(): FakeZone {
  const zone = new FakeZone();
  zone.workers.set("example-app", {
    versions: [
      { id: "v-new", created_on: "2026-10-23T10:00:00Z", message: `opscrew 102 ${SHA_NEW}` },
      { id: "v-old", created_on: "2026-10-22T10:00:00Z", message: `opscrew 101 ${SHA_OLD}` },
    ],
    deployments: [
      {
        id: "d-2",
        created_on: "2026-10-23T10:01:00Z",
        source: "wrangler",
        strategy: "percentage",
        versions: [{ version_id: "v-new", percentage: 100 }],
      },
      {
        id: "d-1",
        created_on: "2026-10-22T10:01:00Z",
        source: "wrangler",
        strategy: "percentage",
        versions: [{ version_id: "v-old", percentage: 100 }],
      },
    ],
  });
  zone.workerDomains.push({
    id: "domain-1",
    hostname: "docs.example.com",
    service: "example-app",
    zone_id: FAKE_ZONE_ID,
    zone_name: "example.com",
  });
  return zone;
}

describe("opscrew status on Cloudflare's hosting", () => {
  it("shows the version running and the one before, their runs, the custom domains and the rollback", async () => {
    const zone = zoneWithWorker();
    const deps = await setup(sitePlan({ www: true, deployed: true }));
    const { lines, deploys } = await componentStatusReport(
      deps,
      sitePlan({ www: true, deployed: true }),
      {
        services: {
          cloudflare: fakeCloudflare(),
          sharedCloudflare: fakeSharedCloudflare(zone),
          deploys: new FakePromoteGitHub(),
        },
      },
    );

    const runs = "https://github.com/example-org/example-app/actions/runs";
    expect(lines).toEqual([
      "Cloudflare hosting, the Worker example-app (read from Cloudflare now):",
      `  Running: version v-new, deployed 2026-10-23 10:01 UTC, built by ${runs}/102`,
      `  Before it: version v-old, deployed 2026-10-22 10:01 UTC, built by ${runs}/101`,
      "  Roll back to it: opscrew rollback --to v-old",
      "  Custom domains: docs.example.com (set up), www.docs.example.com (missing)",
      "  A missing custom domain does not answer: run `opscrew provision` to set it up again (it shows the plan first).",
      "",
      "Resources (read now):",
      "  Not available: request figures (Cloudflare serves the site's files without running any code, so it counts no requests)",
      "",
      "Deploys (read from GitHub now):",
      "  Deploys: on (each push to main deploys)",
    ]);
    expect(deploys).toEqual({
      running: { version: "v-new", builtAt: "2026-10-23T10:00:00Z" },
      previous: { version: "v-old", builtAt: "2026-10-22T10:00:00Z" },
    });
    // Read only, and nothing about a server.
    expect(zone.writes()).toEqual([]);
    expect(lines.join("\n")).not.toMatch(/server|container/i);
  });

  it("after a rollback names the version uploaded before the one running, never the one it went back from (D4)", async () => {
    const zone = zoneWithWorker();
    const worker = zone.workers.get("example-app");
    if (worker === undefined) throw new Error("no Worker");
    worker.versions.push({
      id: "v-first",
      created_on: "2026-10-21T10:00:00Z",
      message: `opscrew 100 ${"c".repeat(64)}`,
    });
    // `opscrew rollback` went back from v-new to v-old.
    worker.deployments.unshift({
      id: "d-3",
      created_on: "2026-10-24T10:01:00Z",
      source: "api",
      strategy: "percentage",
      versions: [{ version_id: "v-old", percentage: 100 }],
    });
    const deps = await setup(sitePlan({ deployed: true }));
    const { lines } = await componentStatusReport(deps, sitePlan({ deployed: true }), {
      services: {
        cloudflare: fakeCloudflare(),
        sharedCloudflare: fakeSharedCloudflare(zone),
        deploys: new FakePromoteGitHub(),
      },
    });
    expect(lines[1]).toContain("Running: version v-old");
    expect(lines[2]).toContain("Before it: version v-new");
    expect(lines[3]).toBe(
      "  Roll back: opscrew rollback --to v-first (the newest version uploaded before the one running)",
    );
    expect(lines.join("\n")).not.toContain("--to v-new");
  });

  it("says when nothing is deployed yet, and when the Worker is gone", async () => {
    const zone = new FakeZone();
    zone.workers.set("example-app", { versions: [], deployments: [] });
    const deps = await setup(sitePlan({ deployed: true }));
    const services = { cloudflare: fakeCloudflare(), sharedCloudflare: fakeSharedCloudflare(zone) };
    const fresh = await componentStatusReport(deps, sitePlan({ deployed: true }), { services });
    expect(fresh.lines[1]).toContain("Running: nothing deployed yet");

    zone.workers.clear();
    const gone = await componentStatusReport(deps, sitePlan({ deployed: true }), { services });
    expect(gone.lines[1]).toContain("The Worker is not in the Cloudflare account");
    expect(gone.lines[1]).toContain("`opscrew provision`");
  });
});

describe("opscrew status on GitHub Pages", () => {
  /** The successful runs of the Pages workflow, latest started last. */
  const RUNS = [
    { id: 201, run_attempt: 1, run_started_at: "2026-10-22T09:00:00Z", head_sha: "1".repeat(40) },
    { id: 202, run_attempt: 1, run_started_at: "2026-10-23T09:00:00Z", head_sha: "2".repeat(40) },
  ];

  /** GitHub's Pages API, and `runs`, the successful runs of the Pages workflow. */
  function github(pages: Omit<FakePagesOptions, "log">, runs = RUNS) {
    const fake = fakeGithubPages(pages);
    const fetch: FetchLike = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/actions/workflows/opscrew-deploy.yml/runs")) {
        return Response.json({ workflow_runs: runs });
      }
      return fake.fetch(input, init);
    };
    return { ...fake, fetch };
  }

  it("shows the site, its certificate, HTTPS, the last run and the one before", async () => {
    const pages = github({
      site: { buildType: "workflow", cname: "docs.example.com", httpsEnforced: true },
      health: "issued",
    });
    const deps = await setup(pagesTestPlan(), pages.fetch);
    // A rollback re-ran run 202 and paused prod's deploys.
    const registry = new FakePromoteGitHub();
    registry.variables.set(
      DEPLOY_PAUSED_VARIABLE,
      JSON.stringify({
        "example-app/prod": {
          reason: "rollback",
          since: "2026-10-24T08:00:00.000Z",
          image: "202",
          commit: "2".repeat(40),
        },
      }),
    );
    const { lines, deploys } = await componentStatusReport(deps, pagesTestPlan(), {
      services: { deploys: registry },
    });

    const runs = "https://github.com/example-org/example-app/actions/runs";
    expect(lines).toEqual([
      "GitHub Pages, example-org/example-app (read from GitHub now):",
      "  Site: published by OpsCrew's workflow, at https://docs.example.com",
      "  Certificate: issued by GitHub",
      "  HTTPS: enforced",
      `  Running: ${runs}/202, started 2026-10-23 09:00 UTC, commit 2222222`,
      `  Before it: ${runs}/201, started 2026-10-22 09:00 UTC, commit 1111111`,
      "  Roll back to it: opscrew rollback --to 201",
      "",
      "Resources (read now):",
      "  Not available: resource figures (GitHub Pages serves the site's files without running any code, so there are none)",
      "",
      "Deploys (read from GitHub now):",
      `  Paused since 2026-10-24 08:00 UTC: \`opscrew rollback\` pinned it to 2222222 (202). Run \`opscrew rollback --resume\` when the fix is pushed (add --deploy to deploy main's latest commit now).`,
    ]);
    expect(deploys).toEqual({
      running: { version: "202", commit: "2".repeat(40), builtAt: "2026-10-23T09:00:00Z" },
      previous: { version: "201", commit: "1".repeat(40), builtAt: "2026-10-22T09:00:00Z" },
      paused: expect.objectContaining({ reason: "rollback", commit: "2".repeat(40) }),
    });
    expect(pages.log.every((line) => line.startsWith("pages GET"))).toBe(true);
  });

  it("after a rollback names the run created before the one serving, never the one it went back from (D4)", async () => {
    // `opscrew rollback` re-ran run 201: it keeps its id and is now the latest started.
    const pages = github(
      {
        site: { buildType: "workflow", cname: "docs.example.com", httpsEnforced: true },
        health: "issued",
      },
      [
        {
          id: 200,
          run_attempt: 1,
          run_started_at: "2026-10-21T09:00:00Z",
          head_sha: "0".repeat(40),
        },
        ...RUNS.slice(1),
        {
          id: 201,
          run_attempt: 2,
          run_started_at: "2026-10-24T09:00:00Z",
          head_sha: "1".repeat(40),
        },
      ],
    );
    const deps = await setup(pagesTestPlan(), pages.fetch);
    const { lines } = await componentStatusReport(deps, pagesTestPlan());
    expect(lines[4]).toContain("/actions/runs/201,");
    expect(lines[5]).toContain(
      "Before it: https://github.com/example-org/example-app/actions/runs/202,",
    );
    expect(lines[6]).toBe(
      "  Roll back: opscrew rollback --to 200 (the newest run created before the one running)",
    );
    expect(lines.join("\n")).not.toContain("--to 202");
  });

  it("while a rollback pauses deploys, shows the pinned run running, never a push's run whose deploy was skipped", async () => {
    // 202 (B) was bad; the rollback re-ran 201 (A) and pinned it; 203 (C) was pushed while paused.
    const pages = github(
      {
        site: { buildType: "workflow", cname: "docs.example.com", httpsEnforced: true },
        health: "issued",
      },
      [
        {
          id: 200,
          run_attempt: 1,
          run_started_at: "2026-10-21T09:00:00Z",
          head_sha: "0".repeat(40),
        },
        ...RUNS.slice(1),
        {
          id: 201,
          run_attempt: 2,
          run_started_at: "2026-10-24T09:00:00Z",
          head_sha: "1".repeat(40),
        },
        {
          id: 203,
          run_attempt: 1,
          run_started_at: "2026-10-25T09:00:00Z",
          head_sha: "3".repeat(40),
        },
      ],
    );
    const deps = await setup(pagesTestPlan(), pages.fetch);
    const registry = new FakePromoteGitHub();
    registry.variables.set(
      DEPLOY_PAUSED_VARIABLE,
      JSON.stringify({
        "example-app/prod": {
          reason: "rollback",
          since: "2026-10-24T08:59:00.000Z",
          image: "201",
          commit: "1".repeat(40),
          from: "2".repeat(40),
        },
      }),
    );
    const { lines, deploys } = await componentStatusReport(deps, pagesTestPlan(), {
      services: { deploys: registry },
    });
    expect(lines[4]).toContain(
      "Running: https://github.com/example-org/example-app/actions/runs/201,",
    );
    expect(lines[5]).toContain(
      "Before it: https://github.com/example-org/example-app/actions/runs/202,",
    );
    expect(lines[6]).toBe(
      "  Roll back: opscrew rollback --to 200 (the newest run created before the one running)",
    );
    expect(deploys).toMatchObject({ running: { version: "201" }, previous: { version: "202" } });
  });

  it("says the certificate is pending and when to look again", async () => {
    const pages = github({
      site: { buildType: "workflow", cname: "docs.example.com", httpsEnforced: false },
      health: "dns-ok",
    });
    const deps = await setup(pagesTestPlan(), pages.fetch);
    const { lines } = await componentStatusReport(deps, pagesTestPlan());

    expect(lines[2]).toContain("Certificate: pending");
    expect(lines[2]).toContain("in an hour");
    expect(lines[3]).toContain("HTTPS: not enforced yet");
    expect(lines[3]).toContain("`opscrew provision`");
  });
});
