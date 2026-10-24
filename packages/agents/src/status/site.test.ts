import { FAKE_ZONE_ID, FakeZone } from "@opscrew/connector-cloudflare/testing";
import type { FetchLike } from "@opscrew/contracts";
import { fakeSecret } from "@opscrew/core/testing";
import { type DeployPlan, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
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
    const { lines } = await componentStatusReport(deps, sitePlan({ www: true, deployed: true }), {
      services: { cloudflare: fakeCloudflare(), sharedCloudflare: fakeSharedCloudflare(zone) },
    });

    const runs = "https://github.com/example-org/example-app/actions/runs";
    expect(lines).toEqual([
      "Cloudflare hosting, the Worker example-app (read from Cloudflare now):",
      `  Running: version v-new, deployed 2026-10-23 10:01 UTC, built by ${runs}/102`,
      `  Before it: version v-old, deployed 2026-10-22 10:01 UTC, built by ${runs}/101`,
      "  Roll back to it: opscrew promote --to prod --version v-old",
      "  Custom domains: docs.example.com (set up), www.docs.example.com (missing)",
      "  A missing custom domain does not answer: run `opscrew provision` to set it up again (it shows the plan first).",
    ]);
    // Read only, and nothing about a server.
    expect(zone.writes()).toEqual([]);
    expect(lines.join("\n")).not.toMatch(/server|container/i);
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
  /** GitHub's Pages API, and the successful runs of the Pages workflow (latest started last). */
  function github(pages: Omit<FakePagesOptions, "log">) {
    const fake = fakeGithubPages(pages);
    const fetch: FetchLike = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/actions/workflows/opscrew-deploy.yml/runs")) {
        return Response.json({
          workflow_runs: [
            {
              id: 201,
              run_attempt: 1,
              run_started_at: "2026-10-22T09:00:00Z",
              head_sha: "1".repeat(40),
            },
            {
              id: 202,
              run_attempt: 1,
              run_started_at: "2026-10-23T09:00:00Z",
              head_sha: "2".repeat(40),
            },
          ],
        });
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
    const { lines } = await componentStatusReport(deps, pagesTestPlan());

    const runs = "https://github.com/example-org/example-app/actions/runs";
    expect(lines).toEqual([
      "GitHub Pages, example-org/example-app (read from GitHub now):",
      "  Site: published by OpsCrew's workflow, at https://docs.example.com",
      "  Certificate: issued by GitHub",
      "  HTTPS: enforced",
      `  Last Pages run: ${runs}/202, started 2026-10-23 09:00 UTC, commit 2222222`,
      `  The one before: ${runs}/201, started 2026-10-22 09:00 UTC, commit 1111111`,
      "  Roll back to it: opscrew promote --to prod --version 201",
    ]);
    expect(pages.log.every((line) => line.startsWith("pages GET"))).toBe(true);
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
