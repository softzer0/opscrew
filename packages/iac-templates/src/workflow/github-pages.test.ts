// biome-ignore-all lint/suspicious/noTemplateCurlyInString: GitHub Actions syntax, not JavaScript templates.
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { testContext } from "../__fixtures__/plans";
import { ACTIONS } from "../pins";
import {
  cloudflarePlan,
  FROM_STAGING,
  HUGO_SITE,
  NUXT_SSR,
  PNPM_SITE,
  pagesPlan,
  ssrPlan,
} from "../serverless/__fixtures__/plans";
import { jobYaml } from "./__fixtures__/plans";
import {
  deploySecretNamesFor,
  renderCloudflareWorkersWorkflow,
  renderGithubPagesWorkflow,
  renderWorkflow,
} from "./index";

type Step = {
  id?: string;
  name?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, string | boolean>;
};
type Job = {
  needs?: string;
  environment?: string;
  permissions: Record<string, string>;
  steps: Step[];
};
type Workflow = {
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  concurrency: { group: string; "cancel-in-progress": boolean };
  jobs: { build: Job; deploy: Job };
};

const flow = renderGithubPagesWorkflow(pagesPlan({ env: ["PUBLIC_API_URL"] }));
const hugoFlow = renderGithubPagesWorkflow(pagesPlan({ site: HUGO_SITE }));
const workflow = parse(flow.content) as Workflow;
const label = (s: Step) => s.id ?? s.name ?? s.uses?.split("@")[0];

function step(job: Job, name: string): Step {
  const found = job.steps.find((s) => s.name === name);
  if (!found) throw new Error(`no step ${name}`);
  return found;
}

describe("renderGithubPagesWorkflow", () => {
  it("publishes on each push to the branch, one run at a time", () => {
    expect(flow).toMatchObject({ path: ".github/workflows/opscrew-deploy.yml", kind: "workflow" });
    expect(workflow.on).toEqual({ push: { branches: ["main"] }, workflow_dispatch: {} });
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.concurrency).toEqual({ group: "opscrew-deploy", "cancel-in-progress": false });
  });

  it("builds the site, checks GitHub Pages' 1 GB and hands it over with its hidden files", () => {
    const { build } = workflow.jobs;
    expect(build.permissions).toEqual({ contents: "read", pages: "read" });
    expect(build.steps.map(label)).toEqual([
      "actions/checkout",
      "actions/setup-node",
      "Install the site's dependencies",
      "Build the site",
      "Check the site against GitHub Pages' limit",
      "actions/configure-pages",
      "Keep the built site for GitHub Pages",
    ]);
    expect(step(build, "Build the site").env).toEqual({
      PUBLIC_API_URL: "${{ secrets.OPSCREW_ENV_PUBLIC_API_URL }}",
    });
    const limit = step(build, "Check the site against GitHub Pages' limit").run ?? "";
    expect(limit).toContain(`bytes="$(du -sb 'dist' | cut -f 1)"`);
    expect(limit).toContain('if [[ "$bytes" -gt 1073741824 ]]; then');
    expect(limit).toContain("over the 1 GB GitHub Pages publishes");
    expect(build.steps.find((s) => s.uses?.startsWith("actions/configure-pages@"))?.uses).toBe(
      ACTIONS.configurePages.split(" #")[0],
    );
    expect(step(build, "Keep the built site for GitHub Pages")).toEqual({
      name: "Keep the built site for GitHub Pages",
      uses: ACTIONS.uploadPagesArtifact.split(" #")[0],
      with: { path: "dist", "include-hidden-files": true },
    });
    // GitHub Pages builds nothing for Cloudflare.
    expect(flow.content).not.toMatch(/WORKERS_CI|wrangler|opscrew-site/);
  });

  it("publishes from the github-pages environment, the only job with pages: write and id-token: write", () => {
    const { deploy } = workflow.jobs;
    expect(deploy).toMatchObject({
      needs: "build",
      environment: "github-pages",
      permissions: { "id-token": "write", pages: "write" },
    });
    expect(deploy.steps.map(label)).toEqual(["Publish the site", "Check that the site answers"]);
    expect(step(deploy, "Publish the site").uses).toBe(ACTIONS.deployPages.split(" #")[0]);
    const check = step(deploy, "Check that the site answers");
    expect(check.env).toEqual({ URL: "https://docs.example.com/" });
    // A certificate GitHub has not issued yet is a warning, not a failure.
    expect(check.run).toContain('case "$code" in 35 | 51 | 60) ;; *) tls_only=0 ;; esac');
    expect(check.run).toContain(
      "::warning::GitHub has not issued the certificate for docs.example.com yet",
    );
    expect(check.run).toContain("run \\`opscrew provision\\` to enforce HTTPS.");
  });

  it("never puts a secret in a script", () => {
    for (const job of Object.values(workflow.jobs)) {
      for (const s of job.steps) expect(s.run ?? "", s.name).not.toMatch(/\$\{\{\s*secrets\./);
    }
  });

  it("refuses a promoted environment: each environment builds its own site", () => {
    expect(() => renderGithubPagesWorkflow(pagesPlan({ promotedFrom: "staging" }))).toThrow(
      expect.objectContaining({
        code: "INVALID_INPUT",
        message: expect.stringContaining("GitHub Pages publishes from a build"),
      }),
    );
    expect(() => renderGithubPagesWorkflow(cloudflarePlan())).toThrow(
      expect.objectContaining({ code: "PHASE_PRECONDITION" }),
    );
  });

  it("is what renderWorkflow renders, and reads only the app's variables", () => {
    const plan = pagesPlan({ env: ["PUBLIC_API_URL"] });
    expect(renderWorkflow(plan, testContext())).toEqual(flow);
    expect(deploySecretNamesFor(plan)).toEqual(["OPSCREW_ENV_PUBLIC_API_URL"]);
    expect(deploySecretNamesFor(pagesPlan())).toEqual([]);
  });

  it("matches the snapshots", () => {
    expect(flow.content).toMatchSnapshot("npm");
    expect(hugoFlow.content).toMatchSnapshot("Hugo");
    const pnpm = renderGithubPagesWorkflow(pagesPlan({ site: PNPM_SITE })).content;
    expect(jobYaml(pnpm, "build")).toMatchSnapshot("build job, pnpm");
  });
});

/** actionlint, when this machine has it. */
const actionlint = spawnSync("actionlint", ["-version"], { encoding: "utf8" }).status === 0;

describe.skipIf(!actionlint)("actionlint on the server-less workflows (when installed)", () => {
  it("finds nothing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "opscrew-actionlint-"));
    try {
      await mkdir(join(dir, ".github", "workflows"), { recursive: true });
      const flows = {
        "static.yml": renderCloudflareWorkersWorkflow(cloudflarePlan(), {}),
        "ssr.yml": renderCloudflareWorkersWorkflow(
          ssrPlan({ site: NUXT_SSR, env: ["API_KEY"], buildContext: "apps/web" }),
          {},
        ),
        "bun.yml": renderCloudflareWorkersWorkflow(
          cloudflarePlan({ site: { ...NUXT_SSR, packageManager: "bun" }, render: "ssr" }),
          {},
        ),
        "promoted.yml": renderCloudflareWorkersWorkflow(
          ssrPlan({ promotedFrom: "staging", env: ["API_KEY"] }),
          FROM_STAGING,
        ),
        "pages.yml": flow,
        "hugo.yml": hugoFlow,
      };
      const paths: string[] = [];
      for (const [name, file] of Object.entries(flows)) {
        paths.push(join(".github", "workflows", name));
        await writeFile(join(dir, ".github", "workflows", name), file.content);
      }
      const result = spawnSync("actionlint", ["-no-color", ...paths], {
        cwd: dir,
        encoding: "utf8",
      });
      expect(result.stdout + result.stderr).toBe("");
      expect(result.status).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

if (!actionlint) {
  console.warn("Skipped actionlint on the server-less workflows: actionlint is not on PATH.");
}
