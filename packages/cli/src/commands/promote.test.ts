import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DriftReport, PromoteGitHubApi } from "@opscrew/agents";
import { fakeSharedCloudflare } from "@opscrew/agents/testing";
import { FAKE_ACCOUNT_ID, FakeZone } from "@opscrew/connector-cloudflare/testing";
import type { CommandOptions, CommandResult, CommandRunner } from "@opscrew/contracts";
import { renderCloudflareWorkersWorkflow, SITE_ARTIFACT } from "@opscrew/iac-templates";
import { DeployPlanSchema, writeArtifact } from "@opscrew/plan-schema";
import { afterEach, describe, expect, it } from "vitest";
import { inEnvironment, planFile } from "../ui/__fixtures__/environments";
import { projectContext, run, type TempProject, tempProject } from "../ui/__fixtures__/harness";
import { sitePlan, writeSitePlan } from "../ui/__fixtures__/site";

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

async function pagesProject(): Promise<TempProject> {
  project = await tempProject();
  await writeSitePlan(project, "github-pages");
  return project;
}

const RUN_URL = "https://github.com/example-org/example-app/actions/runs/201";

/** GitHub with two successful Pages runs, 202 live and 201 before it, which a re-run publishes again. */
function pagesGitHub(): PromoteGitHubApi & { reruns: number[] } {
  const reruns: number[] = [];
  const unused = async () => {
    throw new Error("not used by a GitHub Pages rollback");
  };
  return {
    reruns,
    getRepo: async () => ({ defaultBranch: "main", private: false, canPush: true }),
    getEnvironment: async () => undefined,
    pagesRuns: async () => [
      { runId: 202, attempt: 1, startedAt: "2026-10-23T09:00:00Z", headSha: "2".repeat(40) },
      { runId: 201, attempt: 1, startedAt: "2026-10-22T09:00:00Z", headSha: "1".repeat(40) },
    ],
    rerunWorkflowRun: async (_owner, _repo, runId) => {
      reruns.push(runId);
    },
    getWorkflowRun: async () => ({
      id: 201,
      status: "in_progress",
      conclusion: null,
      htmlUrl: RUN_URL,
      headSha: "1".repeat(40),
      createdAt: "2026-10-22T09:00:00Z",
      attempt: 2,
    }),
    waitForWorkflowRun: async () => ({
      id: 201,
      status: "completed",
      conclusion: "success",
      htmlUrl: RUN_URL,
    }),
    fileSha: unused,
    taggedDigest: unused,
    imageFacts: unused,
    workflowRun: unused,
    dispatchWorkflow: unused,
    runArtifacts: unused,
  };
}

describe("opscrew promote --version on a site", () => {
  it("rolls GitHub Pages back by re-running the run --version names, and prints it", async () => {
    const p = await pagesProject();
    const github = pagesGitHub();
    const ctx = projectContext(p, {
      interactive: true,
      services: {
        runner: new RemoteOnlyRunner(),
        promote: { github, sleep: async () => {} },
        approvalHandler: {
          request: async () => ({
            approved: true,
            approver: "test",
            decidedAt: "2026-10-24T12:00:00.000Z",
          }),
        },
      },
    });
    expect(await run(ctx, "promote", "--to", "prod", "--version", "201"), ctx.errors).toBe(0);
    expect(github.reruns).toEqual([201]);
    expect(ctx.output).toContain(`Deployed version 201 to prod: ${RUN_URL}`);
    expect(ctx.output).toContain("run `opscrew verify --env prod` to check the live site.");
    expect(ctx.output).not.toContain("sha256:");
  });

  it("passes --version through, so a value that is no run id is refused before any change", async () => {
    const p = await pagesProject();
    const github = pagesGitHub();
    const ctx = projectContext(p, {
      services: { runner: new RemoteOnlyRunner(), promote: { github } },
    });
    expect(await run(ctx, "promote", "--to", "prod", "--version", "latest")).not.toBe(0);
    expect(ctx.errors).toContain(`"latest" is not a workflow run's id.`);
    expect(github.reruns).toEqual([]);
  });
});

describe("opscrew promote --version --allow-old-secrets on Cloudflare's hosting", () => {
  /** Prod's Worker runs v-2; v-1 predates a change of STRIPE_SECRET_KEY. */
  async function rollbackProject() {
    project = await tempProject();
    const plan = sitePlan("cloudflare-workers");
    await writeSitePlan(project, "cloudflare-workers");
    const tfvars = path.join(project.root, plan.infra.dir, "terraform.tfvars.json");
    await mkdir(path.dirname(tfvars), { recursive: true });
    await writeFile(tfvars, JSON.stringify({ cloudflare_account_id: FAKE_ACCOUNT_ID }));
    const zone = new FakeZone();
    zone.workers.set("example-app", {
      versions: [
        { id: "v-2", created_on: "2026-10-24T10:00:00Z" },
        { id: "v-1", created_on: "2026-10-23T10:00:00Z", secretsChanged: ["STRIPE_SECRET_KEY"] },
      ],
      deployments: [
        {
          id: "d-2",
          created_on: "2026-10-24T10:01:00Z",
          source: "wrangler",
          strategy: "percentage" as const,
          versions: [{ version_id: "v-2", percentage: 100 }],
        },
      ],
    });
    const details: string[] = [];
    const ctx = projectContext(project, {
      interactive: true,
      services: {
        runner: new RemoteOnlyRunner(),
        promote: { sharedCloudflare: fakeSharedCloudflare(zone) },
        approvalHandler: {
          request: async (request) => {
            details.push(request.details ?? "");
            return { approved: true, approver: "test", decidedAt: "2026-10-24T12:00:00.000Z" };
          },
        },
      },
    });
    return { zone, ctx, details };
  }

  it("refuses the rollback by default, naming the secret, and goes ahead with --allow-old-secrets", async () => {
    const refused = await rollbackProject();
    expect(await run(refused.ctx, "promote", "--to", "prod", "--version", "v-1")).toBe(1);
    expect(refused.ctx.errors).toContain(
      "predates a change to the secret STRIPE_SECRET_KEY: activated again, it would run with its old value",
    );
    expect(refused.ctx.errors).toContain(
      "opscrew promote --to prod --version v-1 --allow-old-secrets STRIPE_SECRET_KEY",
    );
    expect(refused.ctx.errors).not.toContain("mistyped");

    const allowed = await rollbackProject();
    const args = ["--to", "prod", "--version", "v-1", "--allow-old-secrets", "STRIPE_SECRET_KEY"];
    expect(await run(allowed.ctx, "promote", ...args), allowed.ctx.errors).toBe(0);
    expect(allowed.details.join("\n")).toContain(
      "Old secrets (--allow-old-secrets): STRIPE_SECRET_KEY. If Cloudflare reports them changed",
    );
    expect(allowed.zone.writes().at(-1)?.path).toContain("/deployments?force=true");
    expect(allowed.ctx.output).toContain("Deployed version v-1 to prod");
  });

  it("refuses an --allow-old-secrets that names no secret", async () => {
    const { ctx, zone } = await rollbackProject();
    const args = ["--to", "prod", "--version", "v-1", "--allow-old-secrets", " , "];
    expect(await run(ctx, "promote", ...args)).toBe(2);
    expect(ctx.errors).toContain("--allow-old-secrets names no secret.");
    expect(zone.writes()).toEqual([]);
  });
});

describe("opscrew promote on Cloudflare's hosting", () => {
  it("deploys the build staging runs to prod and prints it by its run and SHA-256", async () => {
    project = await tempProject();
    const site = sitePlan("cloudflare-workers");
    const staging = inEnvironment(site, "staging");
    const stagingPlan = DeployPlanSchema.parse({
      ...staging,
      target: { ...staging.target, worker: "example-app-staging" },
    });
    const prod = DeployPlanSchema.parse({
      ...site,
      environment: { deploySource: { from: "promote", source: "staging" } },
    });
    await writeArtifact("plan", planFile(project.root, "prod"), prod);
    await writeArtifact("plan", planFile(project.root, "staging"), stagingPlan);
    const tfvars = path.join(project.root, stagingPlan.infra.dir, "terraform.tfvars.json");
    await mkdir(path.dirname(tfvars), { recursive: true });
    await writeFile(tfvars, JSON.stringify({ cloudflare_account_id: FAKE_ACCOUNT_ID }));

    const sha256 = "c".repeat(64);
    const zone = new FakeZone();
    zone.workers.set("example-app-staging", {
      versions: [
        { id: "v-7", created_on: "2026-10-23T10:00:00Z", message: `opscrew 501 ${sha256}` },
      ],
      deployments: [
        {
          id: "d-7",
          created_on: "2026-10-23T10:01:00Z",
          source: "wrangler",
          strategy: "percentage" as const,
          versions: [{ version_id: "v-7", percentage: 100 }],
        },
      ],
    });
    const workflow = renderCloudflareWorkersWorkflow(prod, {
      builderBranch: stagingPlan.cicd.branch,
      builderWorkflowPath: stagingPlan.cicd.workflowPath,
    }).content.replace(/\r\n/g, "\n");
    const bytes = Buffer.from(workflow, "utf8");
    const blob = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    const runUrl = "https://github.com/example-org/example-app/actions/runs/900";
    const unused = async () => {
      throw new Error("not used by a promotion on Cloudflare's hosting");
    };
    const github: PromoteGitHubApi = {
      getRepo: async () => ({ defaultBranch: "main", private: false, canPush: true }),
      fileSha: async () => blob,
      getEnvironment: async () => undefined,
      runArtifacts: async () => [{ name: SITE_ARTIFACT, expired: false }],
      dispatchWorkflow: async () => ({ runId: 900, url: runUrl }),
      waitForWorkflowRun: async () => ({
        id: 900,
        status: "completed",
        conclusion: "success",
        htmlUrl: runUrl,
      }),
      taggedDigest: unused,
      imageFacts: unused,
      workflowRun: unused,
      getWorkflowRun: unused,
      pagesRuns: unused,
      rerunWorkflowRun: unused,
    };
    const drift = async (): Promise<DriftReport> => ({
      drift: [],
      pending: [],
      files: { changed: [], created: [] },
      foreignDnsRecords: [],
      clean: true,
      checkedAt: "2026-10-24T12:00:00.000Z",
      provider: "cloudflare-workers",
    });
    const ctx = projectContext(project, {
      interactive: true,
      services: {
        runner: new RemoteOnlyRunner(),
        promote: { github, drift, sharedCloudflare: fakeSharedCloudflare(zone) },
        approvalHandler: {
          request: async () => ({
            approved: true,
            approver: "test",
            decidedAt: "2026-10-24T12:00:00.000Z",
          }),
        },
      },
    });
    expect(await run(ctx, "promote", "--to", "prod"), ctx.errors).toBe(0);
    expect(ctx.output).toContain(
      `Deployed the build of run 501 (SHA-256 ${sha256}) to prod: ${runUrl}`,
    );
    expect(ctx.output).not.toContain("sha256:");
  });
});
