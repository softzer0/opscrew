// biome-ignore-all lint/suspicious/noTemplateCurlyInString: GitHub Actions syntax, not JavaScript templates.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import {
  type DeployPlan,
  DeployPlanSchema,
  otherAppDirs,
  writeArtifact,
} from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { CF_RANGES, testCloudflareAccount, testContext } from "../__fixtures__/plans";
import { additionsPath } from "../edge";
import { localhostPlan } from "../edge/__fixtures__/localhost";
import { portainerTestPlan } from "../portainer-target/__fixtures__/plans";
import { renderDeployment } from "../render";
import { type RuntimeContext, renderCompose, renderEdgeSite, renderRuntimeFiles } from "../runtime";
import {
  cloudflarePlan,
  FROM_STAGING,
  HUGO_SITE,
  NUXT_SSR,
  pagesPlan,
  ssrPlan,
} from "../serverless/__fixtures__/plans";
import type { RenderContext, RenderedFile } from "../types";
import {
  inEnvironment,
  NIGHTLY,
  ofApp,
  serverPlan,
  withBuild,
  withProcesses,
} from "./__fixtures__/plans";
import { renderWorkflow } from "./index";

type Step = {
  name?: string;
  uses?: string;
  run?: string;
  "working-directory"?: string;
  with?: Record<string, unknown>;
};
type Workflow = {
  on: { push?: { branches: string[]; paths: string[] }; workflow_dispatch?: unknown };
  jobs: Record<string, { steps: Step[] }>;
};

/**
 * One of GitHub's filter patterns as a regular expression: `**` matches any characters, `*` any
 * but `/`, `?` and `+` make the character before them optional or repeated, `[…]` is a set.
 */
function patternRegExp(pattern: string): RegExp {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i] as string;
    if (char === "*" && pattern[i + 1] === "*") {
      source += ".*";
      i++;
    } else if (char === "*") {
      source += "[^/]*";
    } else if ("?+[]".includes(char)) {
      source += char;
    } else {
      source += char.replace(/[.^${}()|\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

/**
 * Whether GitHub's `paths` filter `patterns` includes `file`: the last pattern that matches it
 * decides, a `!` pattern leaving it out.
 */
function included(patterns: readonly string[], file: string): boolean {
  let result = false;
  for (const pattern of patterns) {
    const negated = pattern.startsWith("!");
    if (patternRegExp(negated ? pattern.slice(1) : pattern).test(file)) result = !negated;
  }
  return result;
}

const doc = (flow: RenderedFile) => parse(flow.content) as Workflow;

/** The workflow's push filter; fails the test without one. */
function filterOf(flow: RenderedFile): string[] {
  const paths = doc(flow).on.push?.paths;
  if (paths === undefined) throw new Error(`${flow.path} has no push filter`);
  return paths;
}

/** Whether a push that changes exactly `files` starts the workflow (one included file does). */
const runs = (flow: RenderedFile, files: readonly string[]) =>
  files.some((file) => included(filterOf(flow), file));

/** Files that stand for the source code in the repository folder `dir`. */
const sources = (dir: string) =>
  ["package.json", "src/main.ts"].map((file) => (dir === "." ? file : `${dir}/${file}`));

/** The values of the build job's steps that name a source folder, and the Dockerfile. */
function sourceReads(flow: Workflow): string[] {
  const steps = Object.values(flow.jobs).flatMap((job) => job.steps);
  const reads: string[] = [];
  for (const step of steps) {
    const dir = step["working-directory"];
    if (dir !== undefined) reads.push(...sources(dir));
    // The seal's context is the checkout only for its provenance: it copies nothing from it.
    const file = String(step.with?.file ?? "");
    if (typeof step.with?.context === "string" && !file.endsWith("/seal/Dockerfile")) {
      reads.push(...sources(step.with.context));
    }
    if (file !== "" && !file.startsWith("${{")) reads.push(file);
    for (const match of (step.run ?? "").matchAll(/(?:--path|railpack prepare|find) "([^"$]+)"/g)) {
      reads.push(...sources(match[1] as string));
    }
  }
  return reads;
}

/**
 * The repository paths the rendered `flow` reads, from the workflow and the files of the
 * repository (`files`, OpsCrew's and the user's): the workflow itself; the source folders its
 * steps build in ({@link sourceReads}); every file of the repository a step names, or that lies in
 * a folder a step names (the uploaded runtime files, the Wrangler config); and the module the
 * Wrangler config names as the Worker's `main`.
 */
function readsOf(flow: RenderedFile, files: readonly RenderedFile[]): string[] {
  const workflow = doc(flow);
  const texts = Object.values(workflow.jobs)
    .flatMap((job) => job.steps)
    .flatMap((step) => [step.run ?? "", ...Object.values(step.with ?? {}).map(String)]);
  // Repository paths with a folder: the source folders and the root's files are sourceReads'.
  const tokens = new Set(
    texts
      .flatMap((text) => text.replaceAll("${{ github.workspace }}/", "").split(/[\s"']+/))
      .map((token) => token.replace(/\/$/, ""))
      .filter((token) => token.includes("/") && !token.startsWith("$")),
  );
  const named = files
    .filter(
      (file) =>
        file.path !== flow.path &&
        [...tokens].some((token) => file.path === token || file.path.startsWith(`${token}/`)),
    )
    .map((file) => file.path);
  const wrangler = files.find((file) => file.path.endsWith("/wrangler.jsonc"));
  const config =
    wrangler === undefined
      ? {}
      : (JSON.parse(
          wrangler.content
            .split("\n")
            .filter((line) => !line.startsWith("//"))
            .join("\n"),
        ) as { main?: string });
  const main =
    wrangler === undefined || config.main === undefined
      ? []
      : [posix.join(posix.dirname(wrangler.path), config.main)];
  return [flow.path, ...sourceReads(workflow), ...named, ...main];
}

/**
 * The deployment `opscrew provision` renders for `plan` (on this computer, the local stack's files
 * and the local runner's workflow), and its workflow.
 */
function deployment(
  plan: DeployPlan,
  o: Pick<RenderContext, "otherAppDirs"> & { additions?: boolean } = {},
): { flow: RenderedFile; files: RenderedFile[] } {
  const ctx: RuntimeContext = {
    ...testContext({ cloudflare: testCloudflareAccount(), ...FROM_STAGING }),
    cloudflareRanges: CF_RANGES,
    localhost: { hostname: "shop.localhost" },
    ...(o.additions === true ? { additions: true } : {}),
    ...(o.otherAppDirs === undefined ? {} : { otherAppDirs: o.otherAppDirs }),
  };
  const files =
    plan.target.provider === "localhost"
      ? [
          renderCompose(plan),
          ...renderRuntimeFiles(plan, ctx),
          ...renderEdgeSite(plan, ctx),
          renderWorkflow(plan, ctx),
        ]
      : renderDeployment(plan, ctx);
  const flow = files.find((file) => file.path === plan.cicd.workflowPath);
  if (flow === undefined) throw new Error(`no workflow at ${plan.cicd.workflowPath}`);
  // The user's own additions for the plan's proxy, when the app has them.
  const own =
    o.additions === true
      ? [{ path: additionsPath(plan), content: "", kind: "runtime" as const }]
      : [];
  return { flow, files: [...files, ...own] };
}

/** `plan` with the app's folder `dir` and the shared folders `shared`. */
function inFolder(plan: DeployPlan, dir: string, shared?: readonly string[]): DeployPlan {
  return DeployPlanSchema.parse({
    ...plan,
    app: {
      ...plan.app,
      buildContext: dir,
      ...(shared === undefined ? {} : { sharedPaths: shared }),
    },
  });
}

/** A server app with a cron job, built with Buildpacks. */
const busyServer = withProcesses(withBuild(serverPlan(), "buildpacks"), { cron: [NIGHTLY] });

/** Every target, its app at the repository root and in a folder. */
const PLANS: Record<string, DeployPlan> = {
  "a server app at the root (OpsCrew's Dockerfile)": serverPlan(),
  "a server app in a folder (Buildpacks, cron)": inFolder(busyServer, "services/api", ["libs/db"]),
  "a server app in a folder (Railpack, staging)": inEnvironment(
    inFolder(withBuild(serverPlan(), "railpack", { language: "rust" }), "services/api"),
    { name: "staging", secrets: "environment" },
  ),
  "a server app with its Dockerfile outside its folder": DeployPlanSchema.parse({
    ...inFolder(serverPlan(), "services/api"),
    app: { ...inFolder(serverPlan(), "services/api").app, dockerfile: "docker/api.Dockerfile" },
  }),
  "an app on this computer": inEnvironment(localhostPlan(), { runner: "local" }),
  "an app in a Portainer": portainerTestPlan(),
  "an app in a Portainer, in a folder": inFolder(portainerTestPlan(), "apps/web"),
  "a static site on Cloudflare at the root": cloudflarePlan(),
  "a static site on Cloudflare in a folder": cloudflarePlan({ buildContext: "sites/landing" }),
  "a server-rendered site on Cloudflare in a folder": ssrPlan({
    buildContext: "sites/shop",
    site: NUXT_SSR,
  }),
  "a site on GitHub Pages at the root": pagesPlan(),
  "a site on GitHub Pages in a folder": inFolder(pagesPlan(), "sites/docs", ["packages/ui"]),
};

describe("a deploy workflow's push filter", () => {
  it.each(Object.entries(PLANS))("covers every path the run reads: %s", (_name, plan) => {
    for (const additions of plan.target.provider === "hetzner" ? [false, true] : [false]) {
      const { flow, files } = deployment(plan, { additions });
      const filter = filterOf(flow);
      const reads = readsOf(flow, files);
      expect(reads).toContain(flow.path);
      for (const path of reads) expect(included(filter, path), path).toBe(true);
      for (const shared of plan.app.sharedPaths ?? []) {
        expect(included(filter, `${shared}/src/index.ts`), shared).toBe(true);
      }
      expect(doc(flow).on.workflow_dispatch).toBeDefined();
    }
  });

  it("covers the uploaded crontab, the additions and the Dockerfile outside the app's folder", () => {
    const server = deployment(PLANS["a server app in a folder (Buildpacks, cron)"] as DeployPlan, {
      additions: true,
    });
    const reads = readsOf(server.flow, server.files);
    expect(reads).toEqual(
      expect.arrayContaining([
        "opscrew/runtime/compose.yaml",
        "opscrew/runtime/crontab",
        "opscrew/runtime/edge/compose.yaml",
        "opscrew/proxy/additions.caddy",
        "services/api/package.json",
      ]),
    );
    const outside = deployment(
      PLANS["a server app with its Dockerfile outside its folder"] as DeployPlan,
    );
    expect(readsOf(outside.flow, outside.files)).toContain("docker/api.Dockerfile");
    expect(included(filterOf(outside.flow), "docker/api.Dockerfile")).toBe(true);
  });

  it("covers the Wrangler config and the server-rendered site's headers wrapper", () => {
    const ssr = deployment(PLANS["a server-rendered site on Cloudflare in a folder"] as DeployPlan);
    expect(readsOf(ssr.flow, ssr.files)).toEqual(
      expect.arrayContaining([
        "opscrew/cloudflare/wrangler.jsonc",
        "opscrew/cloudflare/headers-entry.js",
      ]),
    );
  });

  it("covers the repository root's files but Markdown for a Node.js site in a folder", () => {
    const root = [
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      ".npmrc",
      "tsconfig.base.json",
      "turbo.json",
    ];
    // Markdown at the root, and anything in a folder no app uses.
    const elsewhere = ["README.md", "CHANGELOG.md", "docs/setup.md", "scripts/release.sh"];
    for (const plan of [
      PLANS["a server-rendered site on Cloudflare in a folder"] as DeployPlan,
      PLANS["a site on GitHub Pages in a folder"] as DeployPlan,
    ]) {
      const flow = deployment(plan).flow;
      for (const file of root) expect(included(filterOf(flow), file), file).toBe(true);
      for (const file of elsewhere) expect(included(filterOf(flow), file), file).toBe(false);
      // A Markdown file in the site's own folder is the site's.
      expect(included(filterOf(flow), `${plan.app.buildContext}/README.md`)).toBe(true);
    }
    // A build that reads only its folder: Hugo's, and an image built from the folder.
    for (const plan of [
      cloudflarePlan({ buildContext: "sites/blog", site: HUGO_SITE }),
      PLANS["a server app in a folder (Buildpacks, cron)"] as DeployPlan,
    ]) {
      const flow = deployment(plan).flow;
      for (const file of ["tsconfig.base.json", "package.json"]) {
        expect(included(filterOf(flow), file), file).toBe(false);
      }
    }
  });

  it("takes a file in app.sharedPaths as well as a folder, and the repository root as every path", () => {
    const site = cloudflarePlan({ site: HUGO_SITE });
    const shared = deployment(
      inFolder(site, "sites/blog", ["config/hugo.toml", "./themes/", "brand"]),
    ).flow;
    for (const file of ["config/hugo.toml", "themes/ananke/layouts/x.html", "brand/logo.svg"]) {
      expect(included(filterOf(shared), file), file).toBe(true);
    }
    for (const file of ["config/other.toml", "brandkit/logo.svg", "src/main.ts"]) {
      expect(included(filterOf(shared), file), file).toBe(false);
    }
    const everything = deployment(inFolder(site, "sites/blog", ["."])).flow;
    expect(filterOf(everything)).toContain("**");
    for (const file of ["src/main.ts", "README.md", "opscrew/infra/prod/main.tf"]) {
      expect(included(filterOf(everything), file), file).toBe(true);
    }
  });

  it("leaves a promoted environment's dispatch as it is, with no push trigger", () => {
    const promote = { from: "promote", source: "staging" } as const;
    for (const plan of [
      inEnvironment(serverPlan(), { deploySource: promote, secrets: "environment" }),
      cloudflarePlan({ promotedFrom: "staging" }),
    ]) {
      const on = doc(deployment(plan).flow).on;
      expect(on.push).toBeUndefined();
      expect(Object.keys(on)).toEqual(["workflow_dispatch"]);
    }
  });
});

describe("two apps in one repository", () => {
  /** Changes that deploy no app: lock files, reports, the apps' other OpsCrew files. */
  const OPSCREW_ONLY = [
    "opscrew/infra/prod/.terraform.lock.hcl",
    "opscrew/infra/docs/.terraform.lock.hcl",
    "opscrew/SECURITY_SCAN.md",
    "opscrew/apps/docs/ARCHITECTURE.md",
    "opscrew/plan.yaml",
  ];

  describe("both in folders, sharing a workspace package", () => {
    const shared = ["packages/ui"];
    const landing = deployment(
      inFolder(cloudflarePlan({ site: NUXT_SSR, render: "ssr" }), "sites/landing", shared),
      { otherAppDirs: ["sites/docs"] },
    );
    const docs = deployment(ofApp(inFolder(pagesPlan(), "sites/docs", shared), "docs"), {
      otherAppDirs: ["sites/landing"],
    });

    it("covers what each run reads", () => {
      for (const app of [landing, docs]) {
        for (const path of readsOf(app.flow, app.files)) {
          expect(included(filterOf(app.flow), path), `${app.flow.path}: ${path}`).toBe(true);
        }
      }
    });

    it("deploys neither for a change to OpsCrew's files that no run reads", () => {
      for (const app of [landing, docs]) expect(runs(app.flow, OPSCREW_ONLY)).toBe(false);
    });

    it("deploys only the app whose folder or workflow changed", () => {
      expect(runs(landing.flow, ["sites/docs/src/pages/index.astro"])).toBe(false);
      expect(runs(docs.flow, ["sites/docs/src/pages/index.astro"])).toBe(true);
      expect(runs(landing.flow, [docs.flow.path])).toBe(false);
      expect(runs(docs.flow, [landing.flow.path])).toBe(false);
      expect(runs(landing.flow, [landing.flow.path])).toBe(true);
    });

    it("deploys both for a change to the workspace package they share", () => {
      for (const app of [landing, docs]) {
        expect(runs(app.flow, ["packages/ui/src/button.ts"])).toBe(true);
      }
    });
  });

  describe("the first at the repository root, the other in a folder", () => {
    const root = deployment(inFolder(serverPlan(), ".", ["sites/docs/brand"]), {
      otherAppDirs: ["sites/docs"],
    });
    const docs = deployment(ofApp(cloudflarePlan({ buildContext: "sites/docs" }), "docs"), {
      otherAppDirs: ["."],
    });

    it("covers what each run reads", () => {
      for (const app of [root, docs]) {
        for (const path of readsOf(app.flow, app.files)) {
          expect(included(filterOf(app.flow), path), `${app.flow.path}: ${path}`).toBe(true);
        }
      }
    });

    it("deploys neither for a change to OpsCrew's files that no run reads", () => {
      for (const app of [root, docs]) expect(runs(app.flow, OPSCREW_ONLY)).toBe(false);
    });

    it("leaves the other app's folder and workflow out of the root app's", () => {
      expect(filterOf(root.flow)).toEqual([
        "**",
        "!opscrew/**",
        "!.github/workflows/opscrew-deploy*.yml",
        "!sites/docs/**",
        "sites/docs/brand",
        "sites/docs/brand/**",
        "Dockerfile",
        "opscrew/runtime/compose.yaml",
        "opscrew/runtime/edge/**",
        ".github/workflows/opscrew-deploy.yml",
      ]);
      expect(runs(root.flow, ["sites/docs/src/index.md", docs.flow.path])).toBe(false);
      expect(runs(docs.flow, ["sites/docs/src/index.md"])).toBe(true);
      expect(runs(root.flow, ["src/server.ts"])).toBe(true);
      expect(runs(docs.flow, ["src/server.ts", root.flow.path])).toBe(false);
    });

    it("deploys the root app too for its shared folder inside the other app's", () => {
      expect(runs(root.flow, ["sites/docs/brand/logo.svg"])).toBe(true);
      expect(runs(docs.flow, ["sites/docs/brand/logo.svg"])).toBe(true);
    });

    it("never leaves out a folder the root app shares in whole, or another app at the root", () => {
      const whole = deployment(inFolder(serverPlan(), ".", ["sites"]), {
        otherAppDirs: ["sites/docs", "."],
      });
      expect(filterOf(whole.flow)).not.toContain("!sites/docs/**");
      expect(filterOf(whole.flow)).not.toContain("!./**");
      expect(runs(whole.flow, ["sites/docs/src/index.md"])).toBe(true);
    });
  });
});

describe("nested apps built from the repository root", () => {
  /**
   * The first app at the root, `web` in `site` and `admin` in `site/admin`, both built from the
   * root with their Dockerfiles: each app's deployment with the other folders the repository's
   * records give it (`otherAppDirs`).
   */
  async function nested() {
    const root = await mkdtemp(join(tmpdir(), "opscrew-nested-"));
    try {
      for (const [key, dir] of [
        ["web", "site"],
        ["admin", "site/admin"],
      ] as const) {
        await writeArtifact("app", join(root, "opscrew", "apps", key, "app.yaml"), {
          schemaVersion: 1,
          dir,
        });
      }
      const app = async (key: string, dir: string) => {
        const base = ofApp(serverPlan(), key);
        const plan = DeployPlanSchema.parse({
          ...base,
          app: { ...base.app, dockerfile: `${dir}/Dockerfile` },
        });
        return deployment(plan, { otherAppDirs: await otherAppDirs({ root, app: key }) });
      };
      return { web: await app("web", "site"), admin: await app("admin", "site/admin") };
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  it("deploys an app for a change to its own source inside another app's folder", async () => {
    const { web, admin } = await nested();
    expect(runs(admin.flow, ["site/admin/src/x.ts"])).toBe(true);
    expect(runs(web.flow, ["site/admin/src/x.ts"])).toBe(false);
    expect(runs(web.flow, ["site/src/x.ts"])).toBe(true);
    for (const app of [web, admin]) {
      for (const path of readsOf(app.flow, app.files)) {
        expect(included(filterOf(app.flow), path), `${app.flow.path}: ${path}`).toBe(true);
      }
    }
  });
});

describe("GitHub's path matching in these tests", () => {
  it("follows GitHub's rules: * stays in a folder, ** crosses folders, the last match decides", () => {
    expect(included(["docs/*"], "docs/a.md")).toBe(true);
    expect(included(["docs/*"], "docs/a/b.md")).toBe(false);
    expect(included(["docs/**"], "docs/a/b.md")).toBe(true);
    expect(included(["**"], ".npmrc")).toBe(true);
    expect(included(["**", "!docs/**"], "docs/a.md")).toBe(false);
    expect(included(["**", "!docs/**", "docs/keep/**"], "docs/keep/a.md")).toBe(true);
    expect(included(["!docs/**", "**"], "docs/a.md")).toBe(true);
    expect(
      included(
        [".github/workflows/opscrew-deploy*.yml"],
        ".github/workflows/opscrew-deploy-docs.yml",
      ),
    ).toBe(true);
    expect(included(["**.js?"], "a/b.j")).toBe(true);
  });
});
