// biome-ignore-all lint/suspicious/noTemplateCurlyInString: bash and GitHub Actions syntax, not JavaScript templates.
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { DeployPlan } from "@opscrew/plan-schema";
import { afterAll, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { testContext } from "../__fixtures__/plans";
import { ACTIONS, PACKAGE_MANAGERS, TOOLS } from "../pins";
import {
  cloudflarePlan,
  FROM_STAGING,
  HUGO_SITE,
  NUXT_SSR,
  PNPM_SITE,
  ssrPlan,
} from "../serverless/__fixtures__/plans";
import { jobYaml } from "./__fixtures__/plans";
import {
  CLOUDFLARE_DEPLOY_SECRETS,
  deploySecretNamesFor,
  renderCloudflareWorkersWorkflow,
  renderWorkflow,
} from "./index";

/** The workflow, rendered as for an environment promoted from staging (ignored when following). */
const render = (plan: DeployPlan) => renderCloudflareWorkersWorkflow(plan, FROM_STAGING);

type Step = {
  id?: string;
  name?: string;
  uses?: string;
  if?: string;
  run?: string;
  shell?: string;
  "working-directory"?: string;
  env?: Record<string, string>;
  with?: Record<string, string | boolean>;
};
type Job = {
  name: string;
  needs?: string;
  environment?: string;
  permissions: Record<string, string>;
  outputs?: Record<string, string>;
  steps: Step[];
};
type Workflow = {
  name: string;
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  concurrency: { group: string; "cancel-in-progress": boolean };
  jobs: { build?: Job; deploy: Job };
};

const doc = (content: string) => parse(content) as Workflow;
const staticFlow = render(cloudflarePlan());
const ssrFlow = render(
  ssrPlan({ site: NUXT_SSR, notFound: "none", env: ["API_KEY", "PUBLIC_SITE_URL"] }),
);
const promotedFlow = render(
  ssrPlan({ promotedFrom: "staging", notFound: "none", env: ["API_KEY"] }),
);
const staticDoc = doc(staticFlow.content);
const ssrDoc = doc(ssrFlow.content);
const promotedDoc = doc(promotedFlow.content);

function step(job: Job | undefined, key: string): Step {
  const found = job?.steps.find((s) => s.id === key || s.name === key);
  if (!found) throw new Error(`no step ${key}`);
  return found;
}

const temps: string[] = [];
afterAll(async () => {
  for (const dir of temps) await rm(dir, { recursive: true, force: true });
});
async function tree(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "opscrew-workers-"));
  temps.push(dir);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), content);
  }
  return dir;
}

// The bash runs below take a few seconds each, and far longer on a loaded machine (Git Bash
// starts slowly on Windows), so this file's tests get more than the default 5 seconds.
vi.setConfig({ testTimeout: 60_000 });

/** Bash with GNU find, sort and sha256sum, as on GitHub's machines (Git Bash on Windows). */
const bash = (() => {
  const probe = spawnSync("bash", ["-c", "find . -maxdepth 0 -printf ok && command -v sha256sum"], {
    encoding: "utf8",
  });
  return probe.status === 0 && probe.stdout.startsWith("ok");
})();

/** `path` with forward slashes, which bash takes on every platform. */
const slashed = (path: string) => path.replaceAll("\\", "/");

/** Runs `script` with bash in `cwd` with `env`; returns its exit code, output and the outputs it set. */
async function runScript(script: string, cwd: string, env: Record<string, string>) {
  const output = join(cwd, `github-output-${temps.length}`);
  await writeFile(output, "");
  const result = spawnSync("bash", ["-c", script], {
    cwd,
    env: {
      ...process.env,
      GITHUB_OUTPUT: slashed(output),
      GITHUB_STEP_SUMMARY: slashed(join(cwd, "summary")),
      ...env,
    },
    encoding: "utf8",
  });
  const outputs = await readFile(output, "utf8");
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, outputs };
}

describe("renderCloudflareWorkersWorkflow", () => {
  it("deploys on each push to the branch, one run at a time, never cancelling one", () => {
    expect(staticFlow).toMatchObject({
      path: ".github/workflows/opscrew-deploy.yml",
      kind: "workflow",
    });
    expect(staticDoc.name).toBe("OpsCrew deploy");
    expect(staticDoc.on).toEqual({
      push: {
        branches: ["main"],
        // A site at the repository root: every path but OpsCrew's own files and the other deploy
        // workflows, then the Wrangler config and the workflow itself.
        paths: [
          "**",
          "!opscrew/**",
          "!.github/workflows/opscrew-deploy*.yml",
          "opscrew/cloudflare/wrangler.jsonc",
          ".github/workflows/opscrew-deploy.yml",
        ],
      },
      workflow_dispatch: {},
    });
    expect(staticDoc.permissions).toEqual({ contents: "read" });
    expect(staticDoc.concurrency).toEqual({ group: "opscrew-deploy", "cancel-in-progress": false });
    const staging = doc(render(cloudflarePlan({ environment: "staging" })).content);
    expect(staging.name).toBe("OpsCrew deploy (staging)");
    expect(staging.concurrency.group).toBe("opscrew-deploy-example-app-staging");
  });

  it("builds the site with no image: Node.js, the lockfile's install and the build command, with the app's variables", () => {
    const build = staticDoc.jobs.build;
    expect(build?.permissions).toEqual({ contents: "read" });
    expect(build?.outputs).toEqual({ sha256: "${{ steps.manifest.outputs.sha256 }}" });
    expect(build?.steps.slice(0, 2)).toEqual([
      { uses: ACTIONS.checkout.split(" #")[0], with: { "persist-credentials": false } },
      { uses: ACTIONS.setupNode.split(" #")[0], with: { "node-version": "24" } },
    ]);
    expect(step(build, "Install the site's dependencies").run).toContain("npm ci");
    expect(staticFlow.content).not.toMatch(/docker|ghcr|packages: write/i);
    const ssrBuild = step(ssrDoc.jobs.build, "Build the site");
    expect(ssrBuild).toMatchObject({
      "working-directory": ".",
      env: {
        WORKERS_CI: "1",
        API_KEY: "${{ secrets.OPSCREW_ENV_API_KEY }}",
        PUBLIC_SITE_URL: "${{ secrets.OPSCREW_ENV_PUBLIC_SITE_URL }}",
      },
    });
    expect(ssrBuild.run).toBe("set -euo pipefail\npnpm run build\n");
  });

  it("installs pnpm and Yarn as the generated Dockerfiles do, Bun from its action, Hugo from its pinned tarball", () => {
    const pnpm = doc(render(cloudflarePlan({ site: PNPM_SITE })).content);
    const install = step(pnpm.jobs.build, "Install pnpm");
    expect(install.run).toContain(
      'spec="$(node -e \'const p=require("./package.json").packageManager',
    );
    expect(install.run).toContain('npm install -g --no-audit --no-fund "$spec"');
    expect(install.run).not.toContain("rm -f /usr/local/bin/yarn");
    expect(step(pnpm.jobs.build, "Install the site's dependencies").run).toContain(
      "pnpm install --frozen-lockfile",
    );
    const yarn = doc(
      render(
        cloudflarePlan({ site: { ...PNPM_SITE, packageManager: "yarn", command: "yarn build" } }),
      ).content,
    );
    expect(step(yarn.jobs.build, "Install Yarn").run).toContain("@yarnpkg/cli-dist@");
    const bun = doc(
      render(
        cloudflarePlan({
          buildContext: "apps/web",
          site: {
            ...PNPM_SITE,
            packageManager: "bun",
            nodeVersion: "22.12",
            command: "bun run build",
          },
        }),
      ).content,
    );
    // Bun at package.json's exact version, else OpsCrew's pin; never "latest".
    expect(bun.jobs.build?.steps.slice(1, 4)).toEqual([
      { uses: ACTIONS.setupNode.split(" #")[0], with: { "node-version": "22.12" } },
      {
        id: "bun",
        name: "Choose the Bun version",
        "working-directory": "apps/web",
        run: expect.stringContaining(`console.log("bun@"+v)`),
      },
      {
        uses: ACTIONS.setupBun.split(" #")[0],
        with: { "bun-version": "${{ steps.bun.outputs.version }}" },
      },
    ]);
    const chooseBun = step(bun.jobs.build, "bun").run ?? "";
    expect(chooseBun).toContain(`const v=m?m[1]:"${PACKAGE_MANAGERS.bun}"`);
    expect(chooseBun).toContain('echo "version=${spec#bun@}" >> "$GITHUB_OUTPUT"');
    expect(step(bun.jobs.build, "Install the site's dependencies")["working-directory"]).toBe(
      "apps/web",
    );
    const hugo = doc(render(cloudflarePlan({ site: HUGO_SITE })).content);
    const hugoInstall = step(hugo.jobs.build, `Install Hugo ${TOOLS.hugo.version}`).run ?? "";
    expect(hugoInstall).toContain(TOOLS.hugo.url);
    expect(hugoInstall).toContain(
      `echo "${TOOLS.hugo.sha256}  $RUNNER_TEMP/hugo.tar.gz" | sha256sum -c -`,
    );
    expect(step(hugo.jobs.build, "Build the site").run).toContain("hugo --minify");
    const none = doc(render(cloudflarePlan({ site: { tool: "none", outputDir: "site" } })).content);
    expect(none.jobs.build?.steps.map((s) => s.id ?? s.name ?? s.uses?.split("@")[0])).toEqual([
      "actions/checkout",
      "Check the site against Cloudflare's limits",
      "manifest",
      "Keep the built site for the deploy",
    ]);
  });

  it("checks the 100,000 files of Workers Paid when the design chose it", () => {
    const plan = cloudflarePlan();
    const monthly = { amount: 5, currency: "USD" } as const;
    const paid = doc(render({ ...plan, cost: { ...plan.cost, monthly } }).content);
    const limit = step(paid.jobs.build, "Check the site against Cloudflare's limits").run ?? "";
    expect(limit).toContain('if [[ "$files" -gt 100000 ]]; then');
    expect(limit).toContain("100,000 files a version may have on Cloudflare's Workers Paid plan");
    expect(limit).not.toContain("20000");
  });

  it("checks the 20,000 files of the free plan, records the SHA-256, and uploads the build with its hidden files", () => {
    const limit = step(ssrDoc.jobs.build, "Check the site against Cloudflare's limits").run ?? "";
    expect(limit).toContain("if [[ ! -f '.output/server/index.mjs' ]]; then");
    expect(limit).toContain(`files="$(find '.output/public' -type f -printf . | wc -c)"`);
    expect(limit).toContain('if [[ "$files" -gt 20000 ]]; then');
    expect(limit).toContain("20,000 files a version may have on Cloudflare's free plan");
    const manifest = step(ssrDoc.jobs.build, "manifest").run ?? "";
    expect(manifest).toContain(`cp -RL '.output/public'/. "$RUNNER_TEMP/opscrew-site/assets/"`);
    expect(manifest).toContain(
      'cd "$RUNNER_TEMP/opscrew-site"\nsha256="$(find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum | cut -d \' \' -f 1)"',
    );
    for (const workflow of [staticDoc, ssrDoc]) {
      expect(step(workflow.jobs.build, "Keep the built site for the deploy").with).toEqual({
        name: "opscrew-site",
        path: "${{ runner.temp }}/opscrew-site",
        "include-hidden-files": true,
        "if-no-files-found": "error",
      });
    }
  });

  it("bundles a server-rendered Worker with the site's packages in the build job, with no Cloudflare secret", () => {
    const build = ssrDoc.jobs.build;
    const names = build?.steps.map((s) => s.id ?? s.name ?? s.uses?.split("@")[0]);
    expect(names?.slice(-5)).toEqual([
      "Check the site against Cloudflare's limits",
      "Prepare Wrangler",
      "bundle",
      "manifest",
      "Keep the built site for the deploy",
    ]);
    expect(step(build, "bundle")).toEqual({
      id: "bundle",
      name: "Bundle the Worker with its packages",
      uses: ACTIONS.wranglerAction.split(" #")[0],
      with: {
        wranglerVersion: TOOLS.wrangler.version,
        workingDirectory: "${{ runner.temp }}/wrangler",
        command:
          "deploy --dry-run --outdir ${{ runner.temp }}/opscrew-site/worker --config ${{ github.workspace }}/opscrew/cloudflare/wrangler.jsonc",
      },
    });
    expect(step(build, "manifest").run).toContain(
      'if [[ ! -f "$RUNNER_TEMP/opscrew-site/worker/headers-entry.js" ]]; then',
    );
    expect(JSON.stringify(build)).not.toMatch(/secrets\.OPSCREW_CLOUDFLARE/);
    // A static site has no Worker to bundle.
    expect(staticDoc.jobs.build?.steps.some((s) => s.id === "bundle")).toBe(false);
  });

  it("uploads with Wrangler and the committed config, activates the new version and checks the answer", () => {
    const deploy = staticDoc.jobs.deploy;
    expect(deploy).toMatchObject({
      name: "Deploy to Cloudflare",
      needs: "build",
      environment: "production",
      permissions: { contents: "read" },
    });
    expect(deploy.steps.map((s) => s.id ?? s.name ?? s.uses?.split("@")[0])).toEqual([
      "actions/checkout",
      "Download the built site",
      "Check the build's SHA-256 and put the site in place",
      "Add OpsCrew's security headers to _headers",
      "Prepare Wrangler",
      "previous",
      "upload",
      "version",
      "activate",
      "check",
      "rollback",
      "Report the failed deploy",
    ]);
    const config = "${{ github.workspace }}/opscrew/cloudflare/wrangler.jsonc";
    const wrangler = {
      apiToken: "${{ secrets.OPSCREW_CLOUDFLARE_API_TOKEN }}",
      accountId: "${{ secrets.OPSCREW_CLOUDFLARE_ACCOUNT_ID }}",
      wranglerVersion: TOOLS.wrangler.version,
      workingDirectory: "${{ runner.temp }}/wrangler",
    };
    expect(step(deploy, "upload")).toMatchObject({
      uses: ACTIONS.wranglerAction.split(" #")[0],
      with: {
        ...wrangler,
        command: `versions upload --message "opscrew \${{ github.run_id }} \${{ needs.build.outputs.sha256 }}" --config ${config}`,
      },
    });
    expect(step(deploy, "version").env).toEqual({
      OUTPUT: "${{ steps.upload.outputs.command-output }}",
    });
    expect(step(deploy, "activate").env).toEqual({
      CLOUDFLARE_API_TOKEN: "${{ secrets.OPSCREW_CLOUDFLARE_API_TOKEN }}",
      CLOUDFLARE_ACCOUNT_ID: "${{ secrets.OPSCREW_CLOUDFLARE_ACCOUNT_ID }}",
      VERSION: "${{ steps.version.outputs.id }}",
    });
    // The token stays in env, never on Wrangler's command line.
    expect(step(deploy, "activate").run).not.toMatch(
      /secrets\.|apiToken|--api-token|CLOUDFLARE_API_TOKEN/,
    );
    // A promoted environment uploads in the same job, so it activates the same way.
    expect(promotedDoc.jobs.deploy.steps.map((s) => s.id).filter((id) => id !== undefined)).toEqual(
      ["previous", "upload", "version", "activate", "check", "rollback"],
    );
    expect(step(promotedDoc.jobs.deploy, "activate").run).toContain("code: 100146");
    expect(step(deploy, "check").env).toEqual({ URL: "https://docs.example.com/" });
    expect(step(deploy, "Prepare Wrangler").run).toContain(
      `printf '{"private": true}\\n' > "$RUNNER_TEMP/wrangler/package.json"`,
    );
  });

  it("activates the version that ran before again when the activation or the check fails, and fails the job", () => {
    const deploy = staticDoc.jobs.deploy;
    const previous = step(deploy, "previous").run ?? "";
    expect(previous).toContain('if ! answer="$(api deployments)"; then');
    expect(previous).toContain(
      "'[.result.deployments[0].versions[]? | select(.percentage == 100) | .version_id][0] // empty'",
    );
    expect(step(deploy, "rollback")).toMatchObject({
      if: "failure() && (steps.activate.outcome == 'failure' || steps.check.outcome == 'failure') && steps.previous.outputs.id != ''",
      with: {
        command:
          "versions deploy ${{ steps.previous.outputs.id }}@100 -y --config ${{ github.workspace }}/opscrew/cloudflare/wrangler.jsonc",
      },
    });
    const report = step(deploy, "Report the failed deploy");
    expect(report.if).toBe(
      "failure() && (steps.activate.outcome == 'failure' || steps.check.outcome == 'failure')",
    );
    expect(report.env).toEqual({
      PREVIOUS: "${{ steps.previous.outputs.id }}",
      ROLLBACK: "${{ steps.rollback.outcome }}",
    });
    expect(report.run?.trim().endsWith("exit 1")).toBe(true);
    // A certificate Cloudflare has not issued yet is a warning, not a failed version.
    const check = step(deploy, "check").run ?? "";
    expect(check).toContain('case "$code" in 35 | 51 | 60) ;; *) tls_only=0 ;; esac');
    expect(check).toContain(
      "::warning::Cloudflare has not issued the certificate for docs.example.com yet",
    );
  });

  it("gives a server-rendered version the app's variables in a file only the runner user reads, removed after the upload", () => {
    const deploy = ssrDoc.jobs.deploy;
    const prepare = step(deploy, "Prepare Wrangler");
    expect(prepare.env).toEqual({
      OPSCREW_ENV_API_KEY: "${{ secrets.OPSCREW_ENV_API_KEY }}",
      OPSCREW_ENV_PUBLIC_SITE_URL: "${{ secrets.OPSCREW_ENV_PUBLIC_SITE_URL }}",
    });
    expect(prepare.run).toContain(
      `(umask 077 && jq -n '{"API_KEY": env.OPSCREW_ENV_API_KEY, "PUBLIC_SITE_URL": env.OPSCREW_ENV_PUBLIC_SITE_URL}' > "$RUNNER_TEMP/opscrew-secrets.json")`,
    );
    // The build job's bundle as it is, which the SHA-256 covers.
    expect(step(deploy, "upload").with?.command).toBe(
      'versions upload ${{ runner.temp }}/opscrew-site/worker/headers-entry.js --no-bundle --message "opscrew ${{ github.run_id }} ${{ needs.build.outputs.sha256 }}" --secrets-file ${{ runner.temp }}/opscrew-secrets.json --config ${{ github.workspace }}/opscrew/cloudflare/wrangler.jsonc',
    );
    const names = deploy.steps.map((s) => s.id ?? s.name);
    const removal = step(deploy, "Remove the secrets file");
    expect(names.indexOf("Remove the secrets file")).toBe(names.indexOf("upload") + 1);
    expect(removal).toMatchObject({
      if: "always()",
      run: 'rm -f "$RUNNER_TEMP/opscrew-secrets.json"\n',
    });
    // A static site gets no secrets file.
    expect(staticFlow.content).not.toContain("opscrew-secrets.json");
    expect(step(staticDoc.jobs.deploy, "Prepare Wrangler").env).toBeUndefined();
  });

  it("deploys a promoted environment from the source's build, by its run and SHA-256, without building", () => {
    expect(promotedDoc.on).toEqual({
      workflow_dispatch: {
        inputs: {
          run: expect.objectContaining({ required: true, type: "string" }),
          sha256: expect.objectContaining({ required: true, type: "string" }),
        },
      },
    });
    expect(promotedDoc.jobs.build).toBeUndefined();
    const deploy = promotedDoc.jobs.deploy;
    expect(deploy.needs).toBeUndefined();
    expect(deploy.permissions).toEqual({ actions: "read", contents: "read" });
    // The run is checked before anything is downloaded.
    expect(deploy.steps.slice(1, 4).map((s) => s.name)).toEqual([
      "Check the run that built the site",
      "Download the built site",
      "Check the build's SHA-256 and put the site in place",
    ]);
    expect(step(deploy, "Check the run that built the site").env).toEqual({
      RUN: "${{ inputs.run }}",
      SHA256: "${{ inputs.sha256 }}",
      BUILD_BRANCH: "main",
      BUILD_WORKFLOW: ".github/workflows/opscrew-deploy-staging.yml",
      GH_TOKEN: "${{ github.token }}",
    });
    expect(step(deploy, "Download the built site").with).toEqual({
      name: "opscrew-site",
      path: "${{ runner.temp }}/opscrew-site",
      "run-id": "${{ inputs.run }}",
      "github-token": "${{ github.token }}",
    });
    expect(step(deploy, "Check the build's SHA-256 and put the site in place").env).toEqual({
      RUN: "${{ inputs.run }}",
      SHA256: "${{ inputs.sha256 }}",
    });
    // The source's bundle as it is, and the version names the build it came from, so it can be
    // promoted on.
    expect(step(deploy, "upload").with?.command).toContain(
      'versions upload ${{ runner.temp }}/opscrew-site/worker/headers-entry.js --no-bundle --message "opscrew ${{ inputs.run }} ${{ inputs.sha256 }}" --secrets-file',
    );
    expect(promotedFlow.content).toContain(
      "# `opscrew promote --to prod` starts this workflow with the run and SHA-256 of the build the",
    );
  });

  it("refuses to render a promoted environment without the workflow that builds its sites", () => {
    const plan = ssrPlan({ promotedFrom: "staging" });
    for (const ctx of [{}, { builderBranch: "main" }]) {
      expect(() => renderCloudflareWorkersWorkflow(plan, ctx)).toThrow(
        expect.objectContaining({ code: "INTERNAL" }),
      );
    }
    expect(() =>
      renderCloudflareWorkersWorkflow(plan, {
        builderWorkflowPath: ".github/workflows/opscrew-deploy-staging.yml",
      }),
    ).toThrow(expect.objectContaining({ code: "INTERNAL" }));
  });

  it("never puts a secret in a script or a command line", () => {
    for (const workflow of [staticDoc, ssrDoc, promotedDoc]) {
      for (const job of Object.values(workflow.jobs) as Job[]) {
        for (const s of job.steps) {
          const script = s.run ?? "";
          expect(script, s.name).not.toMatch(/\$\{\{\s*secrets\./);
          expect(String(s.with?.command ?? ""), s.name).not.toMatch(/\$\{\{\s*secrets\./);
          for (const line of script.split("\n")) {
            // The token only into the header file, never into the log or curl's command line.
            if (line.includes("$CLOUDFLARE_API_TOKEN")) {
              expect(line).toContain('> "$headers"');
            }
            if (line.includes("env.OPSCREW_ENV_")) expect(line).toContain("umask 077");
          }
          for (const [name, value] of Object.entries(s.with ?? {})) {
            if (/\$\{\{\s*secrets\./.test(String(value))) {
              expect(["apiToken", "accountId"]).toContain(name);
            }
          }
        }
      }
    }
    // The account id the render context may hold never reaches the workflow.
    const account = "fedcba9876543210fedcba9876543210";
    const flow = renderWorkflow(
      cloudflarePlan(),
      testContext({ cloudflare: { zoneId: "z", accountId: account } }),
    );
    expect(flow.content).not.toContain(account);
  });

  it("refuses a downloaded site whose SHA-256 is not the build's, and puts it where the config expects it", async () => {
    if (!bash) {
      console.warn("Skipped the bash run of the build and deploy scripts: no bash with GNU find.");
      return;
    }
    const build = step(ssrDoc.jobs.build, "manifest").run ?? "";
    // The build job's checkout after the build, and its runner's temporary folder after Wrangler's
    // bundle (`deploy --dry-run --outdir`).
    const repo = await tree({
      ".output/public/index.html": "<h1>Docs</h1>\n",
      ".output/public/.assetsignore": "_worker.js\n",
      ".output/server/index.mjs": "export default {};\n",
    });
    // A link in the site, which the artifact's upload sends as the file it names.
    spawnSync("bash", ["-c", "ln -s index.html .output/public/latest.html"], { cwd: repo });
    const builder = await tree({
      "opscrew-site/worker/headers-entry.js": "export default {};\n",
      "opscrew-site/worker/README.md": "Wrangler's bundle.\n",
    });
    const built = await runScript(build, repo, { RUNNER_TEMP: slashed(builder) });
    expect(built.status, built.stderr).toBe(0);
    const sha256 = /^sha256=([0-9a-f]{64})$/m.exec(built.outputs)?.[1];
    expect(sha256).toBeDefined();
    const copied = spawnSync(
      "bash",
      ["-c", "[[ -f opscrew-site/assets/latest.html && ! -L opscrew-site/assets/latest.html ]]"],
      { cwd: builder },
    );
    expect(copied.status, "the link is copied as a file").toBe(0);
    // The deploy job's runner: the artifact downloaded into its temporary folder, and a checkout
    // with an older copy of the static files.
    const deployer = await tree({});
    await cp(join(builder, "opscrew-site"), join(deployer, "opscrew-site"), { recursive: true });
    const workspace = await tree({ ".output/public/stale.html": "old\n" });
    const script =
      step(ssrDoc.jobs.deploy, "Check the build's SHA-256 and put the site in place").run ?? "";
    const env = { RUNNER_TEMP: slashed(deployer), GITHUB_WORKSPACE: slashed(workspace) };
    const placed = await runScript(script, deployer, { ...env, SHA256: sha256 ?? "" });
    expect(placed.status, placed.stderr).toBe(0);
    const listed = spawnSync("bash", ["-c", "find . -type f | LC_ALL=C sort"], {
      cwd: workspace,
      encoding: "utf8",
    }).stdout;
    expect(listed.trim().split("\n")).toEqual([
      "./.output/public/.assetsignore",
      "./.output/public/index.html",
      "./.output/public/latest.html",
    ]);
    const refused = await runScript(script, deployer, { ...env, SHA256: "0".repeat(64) });
    expect(refused.status).toBe(1);
    expect(refused.stdout).toContain("::error::The downloaded site has the SHA-256");
  });

  it("tries the activation again only while Cloudflare answers 100146, at most 24 times 5 s apart", async () => {
    if (!bash) {
      console.warn("Skipped the bash run of the activation script: no bash.");
      return;
    }
    const s = step(staticDoc.jobs.deploy, "activate");
    // The fakes answer from WRANGLER_ANSWERS (one exit code per attempt, 0 once it passes) and
    // record each call.
    const fakes = [
      "npx() {",
      '  printf \'%s|%s\\n\' "${PWD##*/}" "$*" >> "$CALLS"',
      '  local n; n="$(grep -c . "$CALLS")"',
      '  local code; code="$(cut -d , -f "$n" <<< "$WRANGLER_ANSWERS")"',
      '  case "${code:-100146}" in',
      "    0) echo 'Deployed example-app version' ;;",
      "    100146) echo '✘ [ERROR] The requested Worker version could not be found [code: 100146]'; return 1 ;;",
      '    *) echo "✘ [ERROR] Authentication error [code: $code]"; return 1 ;;',
      "  esac",
      "}",
      'sleep() { echo "slept $1" >> "$SLEPT"; }',
    ].join("\n");
    async function activate(answers: string) {
      const dir = await tree({ "wrangler/package.json": "{}" });
      const result = await runScript(`${fakes}\n${s.run ?? ""}`, dir, {
        RUNNER_TEMP: slashed(dir),
        GITHUB_WORKSPACE: "/work",
        VERSION: "1f6e2c3a-4b5d-4e6f-8a9b-0c1d2e3f4a5b",
        WRANGLER_ANSWERS: answers,
        CALLS: slashed(join(dir, "calls")),
        SLEPT: slashed(join(dir, "slept")),
      });
      const read = (name: string) =>
        readFile(join(dir, name), "utf8").then(
          (text) => text.split("\n").filter(Boolean),
          () => [],
        );
      return { ...result, calls: await read("calls"), slept: await read("slept") };
    }

    const passed = await activate("100146,100146,0");
    expect(passed.status, passed.stdout).toBe(0);
    expect(passed.calls).toHaveLength(3);
    expect(passed.calls[0]).toBe(
      `wrangler|--no-install wrangler versions deploy 1f6e2c3a-4b5d-4e6f-8a9b-0c1d2e3f4a5b@100 -y --config /work/opscrew/cloudflare/wrangler.jsonc`,
    );
    expect(passed.slept).toEqual(["slept 5", "slept 5"]);

    const other = await activate("100146,10000");
    expect(other.status).toBe(1);
    expect(other.calls).toHaveLength(2);
    expect(other.stdout).toContain(
      "::error::Wrangler could not activate the new version 1f6e2c3a-4b5d-4e6f-8a9b-0c1d2e3f4a5b; its output above says why.",
    );

    const never = await activate("");
    expect(never.status).toBe(1);
    expect(never.calls).toHaveLength(24);
    expect(never.slept).toHaveLength(23);
    expect(never.stdout).toContain(
      "::error::Cloudflare did not find the new version 1f6e2c3a-4b5d-4e6f-8a9b-0c1d2e3f4a5b within 2 minutes",
    );
  }, 60_000);

  it("reads the new version's id from Wrangler's output, and stops without one", async () => {
    if (!bash) {
      console.warn("Skipped the bash run of the version id script: no bash.");
      return;
    }
    const script = step(staticDoc.jobs.deploy, "version").run ?? "";
    const dir = await tree({});
    const id = "1f6e2c3a-4b5d-4e6f-8a9b-0c1d2e3f4a5b";
    const read = await runScript(script, dir, {
      OUTPUT: `Total Upload: 0.30 KiB / gzip: 0.22 KiB\nWorker Startup Time: 2 ms\nUploaded example-app (1.2 sec)\nWorker Version ID: ${id}\nVersion Preview URL: none\n`,
    });
    expect(read.status, read.stderr).toBe(0);
    expect(read.outputs).toBe(`id=${id}\n`);
    const none = await runScript(script, dir, { OUTPUT: "✘ [ERROR] Authentication error" });
    expect(none.status).toBe(1);
    expect(none.stdout).toContain("::error::Wrangler did not report the new version's id");
  });

  it("matches the snapshots", () => {
    expect(staticFlow.content).toMatchSnapshot("static, npm");
    expect(ssrFlow.content).toMatchSnapshot("ssr, pnpm, with secrets");
    expect(promotedFlow.content).toMatchSnapshot("promoted, ssr");
    for (const [name, site] of [
      ["pnpm", PNPM_SITE],
      ["Hugo", HUGO_SITE],
    ] as const) {
      const content = render(cloudflarePlan({ site })).content;
      expect(jobYaml(content, "build")).toMatchSnapshot(`build job, ${name}`);
    }
  });
});

describe.skipIf(!bash)("the promoted environment's check of the build's run (needs bash)", () => {
  // dev follows develop and builds the sites; staging is promoted from dev, prod from staging. The
  // version prod is promoted with names dev's run, which staging's deploy kept in its message.
  const fromDev = {
    builderBranch: "develop",
    builderWorkflowPath: ".github/workflows/opscrew-deploy-dev.yml",
  };
  const checkOf = (plan: DeployPlan) =>
    step(
      doc(renderCloudflareWorkersWorkflow(plan, fromDev).content).jobs.deploy,
      "Check the run that built the site",
    );
  const prod = checkOf(ssrPlan({ promotedFrom: "staging", env: ["API_KEY"] }));
  const staging = checkOf(cloudflarePlan({ environment: "staging", promotedFrom: "dev" }));
  // The fake answers only the call the step should make, and records it.
  const fakeGh = [
    "gh() {",
    "  printf '%s\\n' \"$*\" >> calls",
    '  [[ "$1 $2" == "api repos/Acme/Shop/actions/runs/4242" && -n "${RUN_RECORD:-}" ]] || { echo "HTTP 404" >&2; return 1; }',
    "  printf '%s\\n' \"$RUN_RECORD\"",
    "}",
  ].join("\n");
  const good = {
    RUN: "4242",
    SHA256: "a".repeat(64),
    RUN_RECORD: "push success Acme/Shop develop .github/workflows/opscrew-deploy-dev.yml",
  };
  async function check(s: Step, env: Partial<typeof good> = {}) {
    const dir = await tree({});
    const result = await runScript(`${fakeGh}\n${s.run ?? ""}`, dir, {
      GITHUB_REPOSITORY: "Acme/Shop",
      ...s.env,
      ...good,
      ...env,
    });
    const calls = await readFile(join(dir, "calls"), "utf8").catch(() => "");
    return { ...result, calls };
  }

  it("passes a successful run of the builder's workflow, started by a push to its branch, at each step of the chain", async () => {
    expect(prod.env).toMatchObject({
      BUILD_BRANCH: "develop",
      BUILD_WORKFLOW: ".github/workflows/opscrew-deploy-dev.yml",
    });
    for (const s of [prod, staging]) {
      const passed = await check(s);
      expect(passed.status, passed.stdout + passed.stderr).toBe(0);
      expect(passed.calls).toBe(
        'api repos/Acme/Shop/actions/runs/4242 --jq "\\(.event) \\(.conclusion) \\(.head_repository.full_name) \\(.head_branch) \\(.path)"\n',
      );
    }
    // A run's path can carry its ref, and GitHub's names are compared without case.
    for (const record of [
      "push success Acme/Shop develop .github/workflows/opscrew-deploy-dev.yml@refs/heads/develop",
      "push success acme/shop develop .github/workflows/opscrew-deploy-dev.yml",
    ]) {
      const passed = await check(prod, { RUN_RECORD: record });
      expect(passed.status, passed.stdout).toBe(0);
    }
  });

  it("refuses each other run with a plain message, before anything is downloaded", async () => {
    const refusals: [Partial<typeof good>, string][] = [
      [{ RUN: "4242; rm -rf /" }, "The run input must be a workflow run's id"],
      [{ SHA256: "latest" }, "The run input must be a workflow run's id"],
      [{ RUN_RECORD: "" }, "GitHub shows no run 4242 in this repository."],
      [
        {
          RUN_RECORD:
            "pull_request success Acme/Shop develop .github/workflows/opscrew-deploy-dev.yml",
        },
        "Run 4242 was started by a pull_request, not by a push.",
      ],
      [
        { RUN_RECORD: "push success evil/fork develop .github/workflows/opscrew-deploy-dev.yml" },
        "Run 4242 built the commits of evil/fork, not of this repository (Acme/Shop).",
      ],
      [
        { RUN_RECORD: "push success Acme/Shop main .github/workflows/opscrew-deploy-dev.yml" },
        "Run 4242 built the branch main.",
      ],
      [
        {
          RUN_RECORD: "push success Acme/Shop develop .github/workflows/opscrew-deploy-staging.yml",
        },
        "Run 4242 is of the workflow .github/workflows/opscrew-deploy-staging.yml.",
      ],
      [
        { RUN_RECORD: "push failure Acme/Shop develop .github/workflows/opscrew-deploy-dev.yml" },
        "Run 4242 did not succeed (its conclusion is failure).",
      ],
      [
        { RUN_RECORD: "push null Acme/Shop develop .github/workflows/opscrew-deploy-dev.yml" },
        "Run 4242 did not succeed (its conclusion is null).",
      ],
    ];
    for (const [env, message] of refusals) {
      const refused = await check(prod, env);
      expect(refused.status, message).toBe(1);
      expect(refused.stdout).toContain(`::error::${message}`);
    }
    expect((await check(prod, { RUN_RECORD: "push success Acme/Shop main x" })).stdout).toContain(
      "OpsCrew promotes only a site a push to develop built with .github/workflows/opscrew-deploy-dev.yml.",
    );
  });
});

describe("deploySecretNamesFor on Cloudflare's hosting", () => {
  it("lists the deploy token, the account id and the app's variables, which a promoted static site does not read", () => {
    const token = Object.values(CLOUDFLARE_DEPLOY_SECRETS);
    expect(token).toEqual(["OPSCREW_CLOUDFLARE_API_TOKEN", "OPSCREW_CLOUDFLARE_ACCOUNT_ID"]);
    const env = ["API_KEY", "PUBLIC_SITE_URL"];
    const values = ["OPSCREW_ENV_API_KEY", "OPSCREW_ENV_PUBLIC_SITE_URL"];
    expect(deploySecretNamesFor(cloudflarePlan({ env }))).toEqual([...token, ...values]);
    expect(deploySecretNamesFor(ssrPlan({ env }))).toEqual([...token, ...values]);
    expect(deploySecretNamesFor(ssrPlan({ env, promotedFrom: "staging" }))).toEqual([
      ...token,
      ...values,
    ]);
    expect(deploySecretNamesFor(cloudflarePlan({ env, promotedFrom: "staging" }))).toEqual(token);
  });

  it("names every secret the workflow reads, by the environment's own names", () => {
    const plan = ssrPlan({ env: ["API_KEY"], environment: "staging" });
    const content = render(plan).content;
    const read = [...new Set([...content.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]))];
    expect(read.sort()).toEqual([
      "OPSCREW_STAGING_CLOUDFLARE_ACCOUNT_ID",
      "OPSCREW_STAGING_CLOUDFLARE_API_TOKEN",
      "OPSCREW_STAGING_ENV_API_KEY",
    ]);
    expect(deploySecretNamesFor(plan)).toEqual([
      "OPSCREW_CLOUDFLARE_API_TOKEN",
      "OPSCREW_CLOUDFLARE_ACCOUNT_ID",
      "OPSCREW_ENV_API_KEY",
    ]);
  });
});

describe("renderWorkflow", () => {
  it("delegates a plan on Cloudflare's hosting to its own workflow", () => {
    const plan = ssrPlan({ env: ["API_KEY"] });
    expect(renderWorkflow(plan, testContext())).toEqual(render(plan));
  });
});
