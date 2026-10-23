// biome-ignore-all lint/suspicious/noTemplateCurlyInString: bash and GitHub Actions syntax, not JavaScript templates.
import type { DeployPlan, ProjectFacts } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { CF_RANGES, testCloudflare, testContext, testPlan } from "./__fixtures__/plans";
import { renderDockerAssets } from "./docker";
import { additionsPath, renderEdgeCompose } from "./edge";
import { localhostPlan } from "./edge/__fixtures__/localhost";
import { pagesVerificationRootDir, renderInfra, storageRootDir } from "./infra";
import { portainerDeployBranch } from "./portainer-target";
import { renderRunbook } from "./runbook";
import { type RuntimeContext, renderCompose, renderEdgeSite } from "./runtime";
import { runtimeDir } from "./runtime-dir";
import { renderWranglerConfig } from "./serverless";
import { cloudflarePlan, FROM_STAGING, pagesPlan } from "./serverless/__fixtures__/plans";
import { cloudflareDir } from "./serverless/site";
import {
  deploySecretName,
  githubEnvironment,
  renderCloudflareWorkersWorkflow,
  renderGithubPagesWorkflow,
  renderWorkflow,
} from "./workflow";
import {
  inEnvironment,
  jobYaml,
  NIGHTLY,
  ofApp,
  serverPlan,
  withPlan,
  withProcesses,
} from "./workflow/__fixtures__/plans";
import { planFilePath, promoteCommand, provisionCommand } from "./workflow/shared";

type Step = { id?: string; name?: string; run?: string; env?: Record<string, string> };
type Workflow = {
  name: string;
  concurrency: { group: string };
  jobs: Record<string, { environment?: string; steps: Step[] }>;
};

const workflow = (content: string) => parse(content) as Workflow;

/** Every secret a workflow reads, `GITHUB_TOKEN` aside. */
const secretsRead = (content: string) =>
  [...new Set([...content.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((match) => match[1]))]
    .filter((name) => name !== "GITHUB_TOKEN")
    .sort();

/** The step of `job` named or with the id `name`. */
function stepOf(flow: Workflow, job: string, name: string): Step {
  const found = flow.jobs[job]?.steps.find((step) => step.name === name || step.id === name);
  if (found === undefined) throw new Error(`no step ${name} in ${job}`);
  return found;
}

const first = serverPlan();
const firstStaging = inEnvironment(first, { name: "staging", secrets: "environment" });
const docs = ofApp(first, "docs");
const docsStaging = ofApp(firstStaging, "docs");

describe('the names of a further app (data-model.md "Apps in a repository")', () => {
  /** Every per-repository name the renderers write for `plan`. */
  const names = (plan: DeployPlan) => ({
    workflow: plan.cicd.workflowPath,
    infra: plan.infra.dir,
    runtime: runtimeDir(plan),
    plan: planFilePath(plan),
    additions: additionsPath(plan),
    storage: storageRootDir(plan),
    verification: pagesVerificationRootDir(plan),
    portainer: portainerDeployBranch(plan),
    secret: deploySecretName(plan, "OPSCREW_HOST"),
    githubEnvironment: githubEnvironment(plan),
  });

  it("keeps the first app's names as they were", () => {
    expect(names(first)).toEqual({
      workflow: ".github/workflows/opscrew-deploy.yml",
      infra: "opscrew/infra/prod",
      runtime: "opscrew/runtime",
      plan: "opscrew/plan.yaml",
      additions: "opscrew/proxy/additions.caddy",
      storage: "opscrew/infra/storage",
      verification: "opscrew/infra/github-pages-verification",
      portainer: "opscrew-deploy",
      secret: "OPSCREW_HOST",
      githubEnvironment: "production",
    });
    expect(names(firstStaging)).toMatchObject({
      workflow: ".github/workflows/opscrew-deploy-staging.yml",
      runtime: "opscrew/environments/staging/runtime",
      plan: "opscrew/environments/staging/plan.yaml",
      additions: "opscrew/proxy/additions.caddy",
      storage: "opscrew/infra/storage-staging",
      portainer: "opscrew-deploy-staging",
      secret: "OPSCREW_STAGING_HOST",
      githubEnvironment: "staging",
    });
  });

  it("gives a further app and its environments names of their own, from its key", () => {
    expect(names(docs)).toEqual({
      workflow: ".github/workflows/opscrew-deploy-docs.yml",
      infra: "opscrew/infra/docs",
      runtime: "opscrew/apps/docs/runtime",
      plan: "opscrew/apps/docs/plan.yaml",
      additions: "opscrew/apps/docs/proxy/additions.caddy",
      storage: "opscrew/infra/storage-docs",
      verification: "opscrew/infra/github-pages-verification-docs",
      portainer: "opscrew-deploy-docs",
      secret: "OPSCREW_DOCS_HOST",
      githubEnvironment: "docs-production",
    });
    expect(names(docsStaging)).toEqual({
      workflow: ".github/workflows/opscrew-deploy-docs-staging.yml",
      infra: "opscrew/infra/docs-staging",
      runtime: "opscrew/apps/docs/environments/staging/runtime",
      plan: "opscrew/apps/docs/environments/staging/plan.yaml",
      // Every environment of the app shares its additions.
      additions: "opscrew/apps/docs/proxy/additions.caddy",
      storage: "opscrew/infra/storage-docs-staging",
      verification: "opscrew/infra/github-pages-verification-docs",
      portainer: "opscrew-deploy-docs-staging",
      secret: "OPSCREW_DOCS_STAGING_HOST",
      githubEnvironment: "docs-staging",
    });
    // Another environment's plan of the app, as a promoted environment's runbook names its source.
    expect(planFilePath(docsStaging, "prod")).toBe("opscrew/apps/docs/plan.yaml");
    expect(planFilePath(docs, "staging")).toBe("opscrew/apps/docs/environments/staging/plan.yaml");
    expect(additionsPath(docs, "nginx")).toBe("opscrew/apps/docs/proxy/additions.nginx");
  });

  it("keeps a further app's prefixed secrets apart from the first app's environment of its name", () => {
    const prefixed = ofApp(inEnvironment(first, { name: "staging", secrets: "prefixed" }), "docs");
    expect(githubEnvironment(prefixed)).toBeUndefined();
    expect(deploySecretName(prefixed, "OPSCREW_APP_ENV")).toBe("OPSCREW_DOCS_STAGING_APP_ENV");
    expect(deploySecretName(docs, "OPSCREW_APP_ENV")).toBe("OPSCREW_DOCS_APP_ENV");
    expect(deploySecretName(firstStaging, "OPSCREW_APP_ENV")).toBe("OPSCREW_STAGING_APP_ENV");
  });
});

describe("a further app's static site on Cloudflare", () => {
  const site = ofApp(cloudflarePlan({ env: ["PUBLIC_API_URL"] }), "docs");
  const file = renderCloudflareWorkersWorkflow(site, FROM_STAGING);
  const flow = workflow(file.content);

  it("has its own workflow, name, concurrency group and plan", () => {
    expect(file.path).toBe(".github/workflows/opscrew-deploy-docs.yml");
    expect(flow.name).toBe("OpsCrew deploy docs");
    expect(flow.concurrency.group).toBe("opscrew-deploy-docs");
    expect(file.content.split("\n")[0]).toBe(
      "# Generated by OpsCrew from opscrew/apps/docs/plan.yaml; `opscrew provision` regenerates it.",
    );
    expect(renderWorkflow(site, testContext())).toEqual(file);
    expect(file.content).toMatchSnapshot();
  });

  it("reads only the app's own secrets, in its own GitHub environment", () => {
    expect(secretsRead(file.content)).toEqual([
      "OPSCREW_DOCS_CLOUDFLARE_ACCOUNT_ID",
      "OPSCREW_DOCS_CLOUDFLARE_API_TOKEN",
      "OPSCREW_DOCS_ENV_PUBLIC_API_URL",
    ]);
    expect(flow.jobs.deploy?.environment).toBe("docs-production");
  });

  it("deploys with the app's own Wrangler config", () => {
    expect(cloudflareDir(site)).toBe("opscrew/apps/docs/cloudflare");
    const config = renderWranglerConfig(site);
    expect(config.path).toBe("opscrew/apps/docs/cloudflare/wrangler.jsonc");
    expect(config.content).toContain("// Generated by OpsCrew from opscrew/apps/docs/plan.yaml;");
    expect(file.content).toContain(
      "--config ${{ github.workspace }}/opscrew/apps/docs/cloudflare/wrangler.jsonc",
    );
    expect(file.content).not.toMatch(/\/opscrew\/cloudflare\//);
  });

  it("names its environments after the app", () => {
    const staging = ofApp(cloudflarePlan({ environment: "staging" }), "docs");
    const content = renderCloudflareWorkersWorkflow(staging, FROM_STAGING);
    expect(content.path).toBe(".github/workflows/opscrew-deploy-docs-staging.yml");
    expect(workflow(content.content).name).toBe("OpsCrew deploy docs (staging)");
    expect(workflow(content.content).concurrency.group).toBe("opscrew-deploy-docs-staging");
    for (const name of secretsRead(content.content)) expect(name).toMatch(/^OPSCREW_DOCS_STAGING_/);
    expect(renderWranglerConfig(staging).path).toBe(
      "opscrew/apps/docs/environments/staging/cloudflare/wrangler.jsonc",
    );
  });
});

describe("a further app's server workflow", () => {
  const ctx: RuntimeContext = { ...testContext(), additions: true, builderBranch: "main" };
  const file = renderWorkflow(docs, ctx);
  const flow = workflow(file.content);

  it("has its own workflow, name, concurrency group and plan", () => {
    expect(file.path).toBe(".github/workflows/opscrew-deploy-docs.yml");
    expect(flow.name).toBe("OpsCrew deploy docs");
    expect(flow.concurrency.group).toBe("opscrew-deploy-docs");
    expect(file.content.split("\n")[0]).toBe(
      "# Generated by OpsCrew from opscrew/apps/docs/plan.yaml; `opscrew provision` regenerates it.",
    );
    expect(file.content).toMatchSnapshot();
  });

  it("pushes the app's own image, ghcr.io/<owner>/<repo>/<key>", () => {
    expect(stepOf(flow, "build", "image").run).toBe(
      [
        "set -euo pipefail",
        'repo="${GITHUB_REPOSITORY,,}"',
        'echo "name=ghcr.io/${repo}/docs" >> "$GITHUB_OUTPUT"',
        'echo "image=ghcr.io/${repo}/docs:${GITHUB_SHA}" >> "$GITHUB_OUTPUT"',
        "",
      ].join("\n"),
    );
    // On a runner machine, whose bash may lack bash 4's ${…,,}, the same name.
    const machine = { name: "build-box", arch: "amd64" } as const;
    const runner = ofApp(
      inEnvironment(first, { name: "qa", runner: "host", runnerHost: machine, build: "runner" }),
      "docs",
    );
    const step = stepOf(workflow(renderWorkflow(runner, ctx).content), "build", "image").run;
    expect(step).toContain("tr '[:upper:]' '[:lower:]'");
    expect(step).toContain('echo "name=ghcr.io/${repo}/docs" >> "$GITHUB_OUTPUT"');
    expect(step).toContain(
      'echo "image=ghcr.io/${repo}/docs:${GITHUB_SHA}-qa" >> "$GITHUB_OUTPUT"',
    );
  });

  it("reads only the app's own secrets, in its own GitHub environment", () => {
    const read = secretsRead(file.content);
    expect(read.length).toBeGreaterThan(0);
    for (const name of read) expect(name).toMatch(/^OPSCREW_DOCS_/);
    expect(flow.jobs.deploy?.environment).toBe("docs-production");
  });

  it("uploads and checks the app's own runtime files and additions", () => {
    const upload = stepOf(flow, "deploy", "Upload runtime files and environment").run ?? "";
    expect(upload).toContain(
      " opscrew/apps/docs/runtime/compose.yaml opscrew/apps/docs/runtime/edge opscrew/apps/docs/proxy/additions.caddy ",
    );
    expect(file.content).toContain(
      'cp opscrew/apps/docs/proxy/additions.caddy "$RUNNER_TEMP/opscrew-edge"/sites/docs.additions',
    );
    expect(file.content).not.toMatch(/opscrew\/(?:runtime|proxy|environments)\//);
    const site = renderEdgeSite(docs, ctx).find((f) => f.path.endsWith("/docs.caddy"));
    expect(site?.path).toBe("opscrew/apps/docs/runtime/edge/sites/docs.caddy");
    expect(site?.content).toContain(
      "\t# Your own additions (opscrew/apps/docs/proxy/additions.caddy).\n\timport /etc/caddy/sites/docs.additions\n",
    );
  });

  it("keeps the old images of the app's own package only, by the app's workflows", () => {
    const prune =
      stepOf(flow, "prune", "Keep the newest 10 images and delete older ones").run ?? "";
    expect(prune).toContain(
      [
        '  const [owner, repo] = process.env.GITHUB_REPOSITORY.toLowerCase().split("/");',
        "  // The app's own package: ghcr.io/<owner>/<repo>/docs.",
        '  const name = repo + "/docs";',
      ].join("\n"),
    );
    expect(prune).toContain(
      '"/repos/" + owner + "/" + repo + "/actions/workflows?per_page=100&page="',
    );
    expect(prune).toContain("/^OpsCrew deploy docs(?: \\(([a-z][a-z0-9-]*)\\))?$/.exec(w.name)");
  });

  it("checks a promoted environment's digest in the app's own package", () => {
    const promoted = ofApp(
      inEnvironment(first, { name: "staging", deploySource: { from: "promote", source: "dev" } }),
      "docs",
    );
    const verify = jobYaml(renderWorkflow(promoted, ctx).content, "verify");
    expect(verify).toContain('name="ghcr.io/${GITHUB_REPOSITORY,,}/docs"');
    expect(verify).not.toContain('name="ghcr.io/${GITHUB_REPOSITORY,,}"');
  });
});

describe("a further app's runbook", () => {
  const text = renderRunbook(docs, { ...testContext(), projectId: "shop-0123456789ab" });

  it("is the app's own, and names the app's folders, plan and image", () => {
    expect(text.path).toBe("opscrew/apps/docs/RUNBOOK.md");
    expect(text.content).toContain("from `opscrew/apps/docs/plan.yaml`.");
    expect(text.content).toContain(
      "| Image | `ghcr.io/acme/shop/docs` (GitHub Container Registry) |",
    );
    expect(text.content).toContain("`opscrew/infra/docs/` is plain Terraform/OpenTofu");
    expect(text.content).toContain("kept in `.opscrew/apps/docs/tfstate/`");
    expect(text.content).toContain("~/.opscrew/projects/shop-0123456789ab/apps/docs");
    expect(text.content).toContain("GitHub Container Registry (`ghcr.io/acme/shop/docs`)");
    expect(text.content).toContain('"OpsCrew deploy docs"');
  });
});

describe("the commands a further app's files name", () => {
  it("add --app <key> as they add --env, and stay as they were for the first app", () => {
    expect(provisionCommand(first)).toBe("opscrew provision");
    expect(provisionCommand(firstStaging)).toBe("opscrew provision --env staging");
    expect(provisionCommand(docs)).toBe("opscrew provision --app docs");
    expect(provisionCommand(docsStaging)).toBe("opscrew provision --app docs --env staging");
    expect(promoteCommand(firstStaging)).toBe("opscrew promote --to staging");
    expect(promoteCommand(docsStaging)).toBe("opscrew promote --app docs --to staging");
  });

  it("name the app in the workflows' messages", () => {
    const origin = { ...testContext(), originTls: { hostnames: ["shop.example.com"] } };
    expect(renderWorkflow(docsStaging, origin).content).toContain(
      "Run \\`opscrew provision --app docs --env staging\\` again to set it",
    );
    const site = ofApp(cloudflarePlan({ env: ["PUBLIC_API_URL"] }), "docs");
    expect(renderCloudflareWorkersWorkflow(site, FROM_STAGING).content).toContain(
      "Activate it with \\`opscrew promote --app docs --to prod --version $PREVIOUS\\`.",
    );
    const local = ofApp(
      inEnvironment(localhostPlan(), { name: "staging", runner: "local" }),
      "docs",
    );
    const localCtx = { ...testContext(), localhost: { hostname: "docs-staging.localhost" } };
    expect(renderWorkflow(local, localCtx).content).toContain(
      "Start it with \\`opscrew runner start --app docs --env staging\\`",
    );
    // The local runner's leaf check names the environment, prod's too.
    const leaf = (plan: DeployPlan) =>
      renderWorkflow(plan, { ...testContext(), localhost: { hostname: "shop.localhost" } }).content;
    const prod = inEnvironment(localhostPlan(), { runner: "local" });
    expect(leaf(prod)).toContain("Run `opscrew provision --env prod`, which issues it");
    expect(leaf(ofApp(prod, "docs"))).toContain(
      "Run `opscrew provision --app docs --env prod`, which issues it",
    );
  });

  it("tell a further app's failed deploy and its image retention to run its own commands", () => {
    const own = renderWorkflow(docs, testContext()).content;
    expect(own).toContain(
      "run opscrew design --app docs, opscrew adapt --app docs and opscrew provision --app docs.",
    );
    expect(own).toContain('run "opscrew provision --app docs" to write the deploy workflow again');
    const firsts = renderWorkflow(first, testContext()).content;
    expect(firsts).toContain("run opscrew design, opscrew adapt and opscrew provision.");
    expect(firsts).toContain('run "opscrew provision" to write the deploy workflow again');
  });

  it("tell a further app's Cloudflare deploy to provision and verify the app itself", () => {
    const site = ofApp(cloudflarePlan({ env: ["PUBLIC_API_URL"] }), "docs");
    const content = renderCloudflareWorkersWorkflow(site, FROM_STAGING).content;
    expect(content).toContain("(\\`opscrew provision --app docs\\` creates it)");
    expect(content).toContain("\\`opscrew verify --app docs\\` checks the site once it is there.");
  });

  it("tell a further app's GitHub Pages deploy to design and verify the app itself", () => {
    const content = renderGithubPagesWorkflow(ofApp(pagesPlan(), "docs")).content;
    expect(content).toContain("host it on Cloudflare (\\`opscrew design --app docs\\`)");
    expect(content).toContain("\\`opscrew verify --app docs\\` says when it is there.");
    const first = renderGithubPagesWorkflow(pagesPlan()).content;
    expect(first).toContain("host it on Cloudflare (\\`opscrew design\\`)");
    expect(first).toContain("\\`opscrew verify\\` says when it is there.");
  });

  it("name the further app's own folder in the runbook's What remains", () => {
    const remains = (plan: DeployPlan) =>
      renderRunbook(plan, testContext())
        .content.split("\n")
        .filter((line) => line.includes("the files in this repository"))
        .join("\n");
    expect(remains(docs)).toContain("(`opscrew/apps/docs/` and");
    expect(remains(docsStaging)).toContain("(`opscrew/apps/docs/` and");
    expect(remains(first)).toContain("(`opscrew/` and");
    const own = ofApp(testPlan({ provider: "own", domain: "docs.example.com" }), "docs");
    expect(remains(own)).toContain(
      "(`opscrew/apps/docs/` and `.github/workflows/opscrew-deploy-docs.yml`)",
    );
  });

  it("name the app in the runbook's commands", () => {
    const environments = ["prod", "staging"];
    const ctx = { ...testContext(), environments };
    expect(renderRunbook(docsStaging, ctx).content).toContain(
      "Run `opscrew verify --app docs --env staging` to refresh it.",
    );
    expect(renderRunbook(docs, ctx).content).toContain(
      "Run `opscrew verify --app docs --env prod` to refresh it.",
    );
    expect(renderRunbook(docs, testContext()).content).toContain(
      "Run `opscrew verify --app docs` to refresh it.",
    );
    expect(renderRunbook(first, ctx).content).not.toContain("--app ");
  });
});

describe("the plan an environment's and a further app's files name", () => {
  const ctx: RuntimeContext = {
    ...testContext(),
    cloudflare: testCloudflare(),
    cloudflareRanges: CF_RANGES,
  };
  const cases = [
    [firstStaging, "opscrew/environments/staging/plan.yaml"],
    [docs, "opscrew/apps/docs/plan.yaml"],
    [docsStaging, "opscrew/apps/docs/environments/staging/plan.yaml"],
  ] as const;

  for (const [plan, file] of cases) {
    it(`is ${file} in the headers and messages of its files`, () => {
      const roots = renderInfra(plan, ctx).filter(
        (f) => f.path.startsWith(`${plan.infra.dir}/`) && f.path.endsWith(".tf"),
      );
      expect(roots.length).toBeGreaterThan(0);
      for (const root of roots) {
        expect(root.content.split("\n")[0], root.path).toBe(
          `# Generated by OpsCrew from ${file}. You own this code, but \`opscrew provision\``,
        );
      }
      const cron = withProcesses(plan, { cron: [NIGHTLY] });
      expect(renderCompose(cron).content.split("\n")[0]).toBe(
        `# Generated by OpsCrew from ${file}; \`opscrew provision\` regenerates it.`,
      );
      const workflow = renderWorkflow(plan, ctx).content;
      expect(workflow).toContain(`(app.port in ${file}, passed to the app as PORT)`);
      expect(workflow).toContain(`// OpsCrew image retention (${file}, cicd.imageRetention)`);
      expect(workflow).not.toContain("opscrew/plan.yaml");
      // The messages that point at the runbook name the environment's own.
      const runbook = file.replace(/plan\.yaml$/, "RUNBOOK.md");
      const released = withPlan(withProcesses(plan, { cron: [NIGHTLY] }), {
        releaseCommand: "npm run migrate",
      });
      const messages = renderWorkflow(released, ctx).content;
      expect(messages.split(`${runbook} has the SSH command`).length - 1).toBe(2);
      expect(messages).not.toContain("opscrew/RUNBOOK.md");
      expect(renderRunbook(plan, ctx).path).toBe(runbook);
    });
  }

  it("keeps the shared edge's file the same for every app and environment, naming none", () => {
    const edge = renderEdgeCompose(first).content;
    for (const [plan] of cases) expect(renderEdgeCompose(plan).content).toBe(edge);
    expect(edge.split("\n")[0]).toBe(
      "# Generated by OpsCrew and shared by every OpsCrew app on this server; any app's `opscrew provision` regenerates it.",
    );
  });

  it("names the app's prod plan in its Dockerfile, which all its environments build", () => {
    const api: ProjectFacts = {
      name: "api",
      languages: ["python"],
      packageManager: "pip",
      frameworks: [{ name: "fastapi", path: "." }],
      appKind: "api",
      platformExport: { platform: "none", evidence: [] },
      build: {},
      runtimeVersions: {},
      envVars: [],
      services: [],
      docker: {},
      monorepo: false,
      appDir: ".",
      git: {},
    };
    const dockerfile = (plan: DeployPlan) =>
      renderDockerAssets(api, {
        appPort: 8000,
        healthPath: "/health",
        app: plan.app,
        supercronic: "amd64",
        sqliteFolder: "/app/data",
      }).find((f) => f.path === "Dockerfile")?.content ?? "";
    expect(dockerfile(docsStaging)).toBe(dockerfile(docs));
    expect(dockerfile(docs)).toContain(
      "# supercronic runs the cron jobs in opscrew/apps/docs/plan.yaml (the cron service).",
    );
    expect(dockerfile(docs)).toContain(
      "# SQLite's folder (storage.sqlite in opscrew/apps/docs/plan.yaml), made as the app's user",
    );
    expect(dockerfile(firstStaging)).toBe(dockerfile(first));
    expect(dockerfile(first)).toContain("# supercronic runs the cron jobs in opscrew/plan.yaml");
  });
});

describe("the deploy tags", () => {
  const tagStep = (plan: DeployPlan) => {
    const tagged = withPlan(plan, { deployTags: { enabled: true } });
    return stepOf(
      workflow(renderWorkflow(tagged, testContext()).content),
      "tag",
      "Tag the deployed commit",
    ).run;
  };

  it("are deploy-<key>-<UTC timestamp> for a further app, and as they were for the first app", () => {
    expect(tagStep(first)).toContain('tag="deploy-$(date -u +%Y%m%d-%H%M%S)"');
    expect(tagStep(docs)).toContain('tag="deploy-docs-$(date -u +%Y%m%d-%H%M%S)"');
    expect(tagStep(docsStaging)).toContain('tag="deploy-docs-$(date -u +%Y%m%d-%H%M%S)"');
  });
});
