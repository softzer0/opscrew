import { fakeCloudflare, fakeSharedCloudflare } from "@opscrew/agents/testing";
import { FAKE_ZONE_ID, FakeZone } from "@opscrew/connector-cloudflare/testing";
import type { CommandOptions, CommandResult, CommandRunner, FetchLike } from "@opscrew/contracts";
import { ProjectStateStore, resolveProjectPaths } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import { projectContext, run, type TempProject, tempProject } from "../ui/__fixtures__/harness";
import { writeSitePlan } from "../ui/__fixtures__/site";

let project: TempProject | undefined;
afterEach(async () => {
  await project?.cleanup();
  project = undefined;
});

/** git answers the GitHub remote; nothing else runs. */
class RemoteOnlyRunner implements CommandRunner {
  async run(command: string, args: readonly string[], _options?: CommandOptions) {
    if (/git(\.exe)?$/i.test(command) && args.includes("get-url")) {
      return {
        exitCode: 0,
        stdout: "https://github.com/example-org/example-app.git\n",
        stderr: "",
      };
    }
    return { exitCode: 127, stdout: "", stderr: "not found" } satisfies CommandResult;
  }
}

/** The Worker `example-app` with two versions deployed, the newer one running. */
function zoneWithWorker(): FakeZone {
  const zone = new FakeZone();
  const deployment = (id: string, version: string, at: string) => ({
    id,
    created_on: at,
    source: "wrangler",
    strategy: "percentage" as const,
    versions: [{ version_id: version, percentage: 100 }],
  });
  zone.workers.set("example-app", {
    versions: [
      { id: "v-new", created_on: "2026-10-23T10:00:00Z", message: `opscrew 102 ${"a".repeat(64)}` },
      { id: "v-old", created_on: "2026-10-22T10:00:00Z", message: `opscrew 101 ${"b".repeat(64)}` },
    ],
    deployments: [
      deployment("d-2", "v-new", "2026-10-23T10:01:00Z"),
      deployment("d-1", "v-old", "2026-10-22T10:01:00Z"),
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

describe("opscrew status for a site on Cloudflare's hosting", () => {
  it("prints the running version and the rollback command, and nothing about images", async () => {
    project = await tempProject();
    project.env.CLOUDFLARE_API_TOKEN = fakeSecret("cloudflare-token", "cli-status-site");
    await writeSitePlan(project, "cloudflare-workers");
    const paths = resolveProjectPaths(project.root, { env: project.env });
    await new ProjectStateStore(paths.files.state).markPhase("provision", "ok");
    const ctx = projectContext(project, {
      services: {
        provision: {
          cloudflare: fakeCloudflare(),
          sharedCloudflare: fakeSharedCloudflare(zoneWithWorker()),
        },
      },
    });
    expect(await run(ctx, "status"), ctx.errors).toBe(0);
    expect(ctx.output).toContain("Running: version v-new");
    expect(ctx.output).toContain("Roll back to it: opscrew promote --to prod --version v-old");
    expect(ctx.output).not.toContain("Image signing");
    expect(ctx.output).not.toContain("Image builder");
  });

  it("--ip says a site has no server address", async () => {
    project = await tempProject();
    await writeSitePlan(project, "cloudflare-workers");
    const ctx = projectContext(project);
    expect(await run(ctx, "status", "--ip")).not.toBe(0);
    expect(ctx.errors).toContain("A site on Cloudflare's hosting has no server");
  });
});

describe("opscrew status for a site on GitHub Pages", () => {
  it("prints the site, its last runs and the rollback command", async () => {
    project = await tempProject();
    project.env.GITHUB_TOKEN = fakeSecret("github-pat", "cli-status-pages");
    await writeSitePlan(project, "github-pages");
    const paths = resolveProjectPaths(project.root, { env: project.env });
    await new ProjectStateStore(paths.files.state).markPhase("provision", "ok");
    const run_ = (id: number, day: string) => ({
      id,
      run_attempt: 1,
      run_started_at: `2026-10-${day}T09:00:00Z`,
      head_sha: String(id % 10).repeat(40),
    });
    const fetch: FetchLike = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/repos/example-org/example-app/pages") {
        return Response.json({
          status: "built",
          cname: null,
          build_type: "workflow",
          https_enforced: false,
        });
      }
      if (url.pathname.endsWith("/actions/workflows/opscrew-deploy.yml/runs")) {
        return Response.json({ workflow_runs: [run_(201, "22"), run_(202, "23")] });
      }
      return new Response("not found", { status: 404 });
    };
    const ctx = projectContext(project, { services: { runner: new RemoteOnlyRunner(), fetch } });
    expect(await run(ctx, "status"), ctx.errors).toBe(0);
    expect(ctx.output).toContain("GitHub Pages, example-org/example-app (read from GitHub now):");
    expect(ctx.output).toContain("Roll back to it: opscrew promote --to prod --version 201");
    expect(ctx.output).not.toContain("Image signing");
  });
});
