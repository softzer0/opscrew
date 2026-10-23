import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FetchLike } from "@opscrew/contracts";
import { fakeSecret, materializeFixture } from "@opscrew/core/testing";
import { detectProject } from "@opscrew/detect";
import { RUNTIME_DEFAULTS } from "@opscrew/iac-templates";
import {
  type ProjectFacts,
  type Requirements,
  readArtifact,
  readOptionalArtifact,
  writeArtifact,
} from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { createTestPhaseDeps, makeRequirements, type TestPhaseDeps } from "../testing";
import { testPlan } from "../verify/__fixtures__/plan";
import { previewDesignOptions, runDesign } from "./run";

const EXAMPLES = fileURLToPath(new URL("../../../../examples/", import.meta.url));
const GITHUB = fakeSecret("github-token", "design-pages");
const DOMAIN = "docs.example.com";

/** A Hugo site with its own 404 page (a fixture written into the project). */
const HUGO_SITE = {
  "hugo.toml": 'baseURL = "https://docs.example.com/"\ntitle = "Example"\n',
  "content/_index.md": "# Example\n",
  "layouts/404.html": "<h1>Not found</h1>\n",
};

interface ProjectOptions {
  /** A folder of examples/ copied into the project. */
  example?: string;
  /** More files (repo-relative path → content). */
  files?: Record<string, string>;
  requirements?: Partial<Requirements>;
  env?: Record<string, string>;
  fetch?: FetchLike;
  /** The repository on GitHub, as analyze reads it from the remote. */
  git?: ProjectFacts["git"];
  /** Facts set over the analysed ones. */
  facts?: Partial<ProjectFacts>;
}

/** A project analysed as `opscrew analyze` writes it, with the interview's answers. */
async function project(o: ProjectOptions = {}): Promise<TestPhaseDeps> {
  const root = await mkdtemp(join(tmpdir(), "opscrew-test-"));
  const deps = await createTestPhaseDeps({
    root,
    env: { OPSCREW_HOME: join(root, ".home-opscrew"), ...o.env },
    ...(o.fetch === undefined ? {} : { fetch: o.fetch }),
  });
  if (o.example !== undefined) await materializeFixture(join(EXAMPLES, o.example), root);
  for (const [path, content] of Object.entries(o.files ?? {})) {
    const target = join(root, ...path.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  const detected = await detectProject(root);
  const facts = { ...detected, ...o.facts, ...(o.git === undefined ? {} : { git: o.git }) };
  await writeArtifact("architecture", deps.paths.files.architecture, {
    schemaVersion: 1,
    generatedAt: "2026-10-23T10:00:00.000Z",
    generator: { tool: "opscrew", version: "0.0.0-test" },
    facts,
    summary: "A site.",
    risks: [],
    aiEnriched: false,
  });
  await writeArtifact(
    "requirements",
    deps.paths.files.requirements,
    makeRequirements({
      provider: "cloudflare-workers",
      domain: DOMAIN,
      dnsProvider: "cloudflare",
      ...o.requirements,
    }),
  );
  return deps;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** GitHub's API for `acme/site`: public, or private on the owner's `plan`. */
function github(repository: { private: boolean; plan?: string }): {
  fetch: FetchLike;
  calls: string[];
} {
  const calls: string[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    if (new Headers(init?.headers).get("authorization") !== `Bearer ${GITHUB}`) {
      return json({ message: "Bad credentials" }, 401);
    }
    if (url.pathname === "/repos/acme/site") {
      return json({
        default_branch: "main",
        private: repository.private,
        permissions: { push: true },
        owner: { login: "acme", type: "User" },
      });
    }
    if (url.pathname === "/user") {
      return json({
        login: "acme",
        ...(repository.plan === undefined ? {} : { plan: { name: repository.plan } }),
      });
    }
    return json({ message: `Not Found ${url.pathname}` }, 404);
  };
  return { fetch, calls };
}

/** Everything design said, and the plan file's text, for leak checks. */
async function outputs(deps: TestPhaseDeps): Promise<string> {
  const plan = await readFile(deps.paths.files.plan, "utf8").catch(() => "");
  return `${deps.reporter.text()}\n${plan}`;
}

describe("design on Cloudflare's hosting", () => {
  it("plans static-vite as a free static site with the single-page app fallback and its limits", async () => {
    const deps = await project({ example: "static-vite" });
    const result = await runDesign(deps);
    expect(result.plan.target).toEqual({
      provider: "cloudflare-workers",
      mode: "workers-assets",
      worker: "static-vite-demo",
      render: "static",
      notFound: "single-page-application",
      workersDev: false,
      previewUrls: false,
      site: {
        tool: "node",
        packageManager: "npm",
        nodeVersion: RUNTIME_DEFAULTS.node,
        command: "npm run build",
        outputDir: "dist",
      },
    });
    expect(result.plan.app.name).toBe("static-vite-demo");
    expect(result.plan.app.build).toBeUndefined();
    expect(result.plan.app.buildContext).toBe(".");
    expect(result.plan.dns).toMatchObject({
      provider: "cloudflare",
      domain: DOMAIN,
      proxied: true,
    });
    expect(result.plan.supplyChain.sign).toBe(false);
    // No image: no Dockerfile, .dockerignore or health route to add.
    expect(result.plan.codeChanges).toEqual([]);
    expect(result.chosen).toMatchObject({
      id: "cloudflare-workers",
      title: "Cloudflare (no server)",
      recommended: true,
      fitsBudget: true,
      cost: {
        monthly: { amount: 0, currency: "USD" },
        breakdown: [{ item: "Cloudflare Workers Free", monthly: { amount: 0, currency: "USD" } }],
        source: "static",
        asOf: "2026-10-23T00:00:00.000Z",
      },
    });
    expect(result.chosen.summary).toContain(
      "https://developers.cloudflare.com/workers/platform/pricing/",
    );
    expect(result.chosen.tradeoffs).toEqual(
      expect.arrayContaining([
        expect.stringContaining("20,000 files on Workers Free, each at most 25 MiB"),
        expect.stringContaining("no database, cache, queue, worker or cron job"),
        expect.stringContaining("Preview URLs and the workers.dev address stay off"),
      ]),
    );
    const said = deps.reporter.text();
    expect(said).toContain(
      "Wrote opscrew/plan.yaml: Cloudflare (no server), $0.00/month, 0 code changes to make.",
    );
    expect(said).toContain("Deploys: each push to the deploy branch builds the site");
    expect(said).not.toContain("Image builder");
    expect(await readArtifact("plan", deps.paths.files.plan)).toEqual(result.plan);
  });

  it("plans astro-ssr without its Cloudflare adapter: server rendering, with adapt adding the adapter", async () => {
    const deps = await project({ example: "astro-ssr" });
    const result = await runDesign(deps);
    expect(result.plan.target).toMatchObject({
      provider: "cloudflare-workers",
      worker: "astro-ssr",
      render: "ssr",
      notFound: "none",
      site: {
        tool: "node",
        command: "npm run build",
        outputDir: "dist/client",
        entry: "dist/server/entry.mjs",
      },
    });
    expect(
      result.plan.target.provider === "cloudflare-workers" && result.plan.target.site,
    ).not.toHaveProperty("compatibilityFlags");
    expect(result.plan.codeChanges).toEqual([
      expect.objectContaining({
        id: "cloudflare-adapter",
        kind: "build-config",
        path: "astro.config.mjs",
        status: "pending",
      }),
    ]);
    expect(result.chosen.cost.monthly).toEqual({ amount: 0, currency: "USD" });
    expect(result.chosen.summary).toContain(
      "Workers Free covers it at no cost: 100,000 requests a day to the Worker (past them it answers with an error until the next day) and 10 ms of CPU per request.",
    );
    expect(result.chosen.tradeoffs).toEqual(
      expect.arrayContaining([
        "`opscrew adapt` adds Astro's Cloudflare adapter (@astrojs/cloudflare) in a pull request.",
        expect.stringContaining("secrets reach its Worker from your repository's GitHub secrets"),
      ]),
    );
    // The paid plan and its price only when the expected traffic needs it.
    expect(JSON.stringify(result.chosen)).not.toContain("Workers Paid");
  });

  it("plans a server-rendered Next.js app through OpenNext, with its hanging options turned off", async () => {
    const deps = await project({
      files: {
        "package.json": JSON.stringify({
          name: "shop",
          scripts: { build: "next build" },
          dependencies: { next: "16.4.2", react: "19.0.0", "@opennextjs/cloudflare": "1.20.13" },
        }),
        "next.config.ts": "export default { cacheComponents: true };\n",
      },
    });
    const result = await runDesign(deps);
    expect(result.plan.target).toMatchObject({
      render: "ssr",
      notFound: "none",
      site: {
        command: "npx opennextjs-cloudflare build --skipWranglerConfigCheck",
        outputDir: ".open-next/assets",
        entry: ".open-next/worker.js",
        compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
      },
    });
    expect(result.plan.codeChanges).toEqual([
      {
        id: "next-workers-options",
        kind: "build-config",
        path: "next.config.ts",
        reason:
          "Turn off cacheComponents in the Next.js config: with it on, every server-rendered request hangs on Cloudflare's Workers.",
        status: "pending",
      },
    ]);
    expect(result.chosen.tradeoffs).toContain(
      "Next.js's cacheComponents makes every server-rendered request hang on Workers, so `opscrew adapt` turns it off.",
    );
  });

  // Each part that needs a server, named in one sentence, with nothing written.
  const misfits: [string, Partial<ProjectFacts>, Partial<Requirements>, string][] = [
    [
      "WebSockets",
      { services: [{ kind: "websocket", evidence: ["dependency:socket.io"] }] },
      {},
      "the app needs a server process that keeps running for WebSockets held open (socket.io), and Cloudflare hosting runs none",
    ],
    [
      "background workers",
      {
        workers: [
          {
            name: "bullmq",
            command: "node worker.js",
            source: "library",
            single: false,
            evidence: ["dependency:bullmq"],
          },
        ],
      },
      {},
      "the app needs a server process that keeps running for background workers (bullmq), and Cloudflare hosting runs none",
    ],
    [
      "a queue",
      { services: [{ kind: "queue", evidence: ["dependency:@temporalio/worker"] }] },
      {},
      "the app needs a server process that keeps running for background work through a queue (@temporalio/worker), and Cloudflare hosting runs none",
    ],
    [
      "cron jobs",
      { cronJobs: [{ schedule: "0 * * * *", route: "/api/cron", source: "vercel.json" }] },
      {},
      "the app's cron jobs (vercel.json) run on a server, and Cloudflare hosting has no server",
    ],
    [
      "SQLite",
      { sqlite: { paths: ["data/app.db"], dir: "data" } },
      {},
      "the app keeps its data in SQLite, whose file needs a server's disk, and Cloudflare hosting has no server",
    ],
    [
      "OpsCrew's bucket",
      {
        objectStorage: { client: "@aws-sdk/client-s3", presignedUploads: false, variables: [] },
      },
      { keepExternalServices: { s3: false } },
      "the bucket OpsCrew would create for the app's files gives its keys to the app on a server, and Cloudflare hosting has no server",
    ],
  ];
  it.each(misfits)(
    "refuses an app with %s, naming it",
    async (_part, facts, requirements, reason) => {
      const deps = await project({ example: "static-vite", facts, requirements });
      await expect(runDesign(deps)).rejects.toMatchObject({
        code: "PHASE_PRECONDITION",
        message: `Cloudflare hosting is not offered for this app: ${reason}. Nothing was written.`,
      });
      expect(await readOptionalArtifact("plan", deps.paths.files.plan)).toBeUndefined();
    },
  );

  it("tells a deployed server's app to destroy it first, never to retarget it here", async () => {
    const deps = await project({ example: "static-vite" });
    await writeArtifact("plan", deps.paths.files.plan, testPlan());
    const before = await readFile(deps.paths.files.plan, "utf8");
    const refused = await runDesign(deps).catch((error: unknown) => error);
    expect(refused).toMatchObject({
      code: "PHASE_PRECONDITION",
      message:
        "Your app is deployed on Hetzner Cloud, but opscrew/requirements.yaml now asks for Cloudflare hosting. opscrew/plan.yaml was not changed.",
      hint: expect.stringContaining(
        "OpsCrew cannot move an app to or from Cloudflare hosting. Run `opscrew destroy`",
      ),
    });
    expect((refused as { hint: string }).hint).not.toContain("retarget");
    expect(await readFile(deps.paths.files.plan, "utf8")).toBe(before);
  });

  it("plans astro-ssr with its adapter at Workers Paid's minimum above 100,000 users a month", async () => {
    const deps = await project({
      example: "astro-ssr",
      files: {
        "package.json": JSON.stringify({
          name: "astro-ssr",
          type: "module",
          scripts: { build: "astro build" },
          dependencies: { "@astrojs/cloudflare": "14.4.2", astro: "7.4.0" },
        }),
      },
      requirements: {
        expectedMonthlyUsers: ">100k",
        budgetMonthly: { amount: 3, currency: "EUR" },
      },
    });
    const result = await runDesign(deps);
    expect(result.plan.codeChanges.map((change) => change.id)).not.toContain("cloudflare-adapter");
    expect(result.chosen).toMatchObject({
      fitsBudget: false,
      cost: { monthly: { amount: 5, currency: "USD" }, source: "static" },
    });
    expect(result.chosen.cost.breakdown[0]?.item).toContain("Cloudflare Workers Paid, per account");
    expect(result.chosen.summary).toContain(
      "above Workers Free's 100,000 requests a day, so it needs Workers Paid: at least $5.00 a month per account, which includes 10 million requests (then $0.30 per million)",
    );
    expect(result.warnings).toContain(
      "Cloudflare (no server) costs $5.00/month (about €4.55) for your expected traffic, over your budget of €3.00/month. Raise the budget with `opscrew interview`, or choose a server target there.",
    );
  });

  it("plans a Hugo site that serves its own 404 page", async () => {
    const deps = await project({ files: HUGO_SITE });
    const result = await runDesign(deps);
    expect(result.plan.target).toMatchObject({
      provider: "cloudflare-workers",
      render: "static",
      notFound: "404-page",
      site: { tool: "hugo", command: "hugo --minify", outputDir: "public" },
    });
    const site = result.plan.target.provider === "cloudflare-workers" && result.plan.target.site;
    expect(site).not.toHaveProperty("packageManager");
    expect(site).not.toHaveProperty("nodeVersion");
  });

  it("refuses an app with Postgres in one sentence, and writes nothing", async () => {
    const deps = await project({
      files: {
        "package.json": JSON.stringify({
          name: "shop",
          scripts: { build: "next build" },
          dependencies: { next: "16.4.2", react: "19.0.0", pg: "^8.13.0" },
        }),
      },
    });
    await expect(runDesign(deps)).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      message:
        "Cloudflare hosting is not offered for this app: the app uses PostgreSQL, which OpsCrew runs on a server, and Cloudflare hosting has none. Nothing was written.",
      hint: "Keep a hosted PostgreSQL the app reaches by URL (answer keepExternalServices.postgres: true in `opscrew interview`), or choose a server target there.",
    });
    expect(await readOptionalArtifact("plan", deps.paths.files.plan)).toBeUndefined();
  });

  it("refuses a server-rendered framework without a Cloudflare adapter OpsCrew sets up", async () => {
    const deps = await project({
      files: {
        "package.json": JSON.stringify({
          name: "shop",
          scripts: { build: "remix vite:build" },
          dependencies: {
            "@remix-run/node": "2.17.0",
            "@remix-run/react": "2.17.0",
            react: "19.0.0",
          },
        }),
      },
    });
    await expect(runDesign(deps)).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      message:
        "Cloudflare hosting is not offered for this app: Remix has no Cloudflare adapter OpsCrew sets up (it sets up those of Astro, Next.js (through OpenNext), Nuxt and SvelteKit). Nothing was written.",
    });
  });

  it("offers `opscrew domain connect` for a domain whose DNS is elsewhere", async () => {
    const deps = await project({ example: "static-vite", requirements: { dnsProvider: "other" } });
    await expect(runDesign(deps)).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      message:
        "Cloudflare hosting is not offered for this app: Cloudflare hosting needs the DNS of docs.example.com on Cloudflare, and it is managed elsewhere. Nothing was written.",
      hint: expect.stringContaining("`opscrew domain connect example.com`"),
    });
  });

  it("warns about a secret whose name has a public prefix", async () => {
    const deps = await project({
      example: "static-vite",
      files: { ".env.example": "VITE_STRIPE_SECRET_KEY=\n" },
    });
    const result = await runDesign(deps);
    expect(result.warnings).toContain(
      "VITE_STRIPE_SECRET_KEY looks like a secret, but a variable with a public prefix (such as VITE_, PUBLIC_, NEXT_PUBLIC_ or NUXT_PUBLIC_) is built into the published files, where anyone can read its value. Keep secrets out of such variables, and rotate any value that was published.",
    );
  });

  it("names a Worker after its environment's app", async () => {
    const prod = await project({ example: "static-vite" });
    await runDesign(prod);
    const staging = await createTestPhaseDeps({
      root: prod.paths.root,
      env: prod.env,
      environment: "staging",
    });
    await mkdir(dirname(staging.paths.files.requirements), { recursive: true });
    await writeFile(staging.paths.files.requirements, "domain: staging-docs.example.com\n");
    const result = await runDesign(staging);
    expect(result.plan.app.name).toBe("static-vite-demo-staging");
    expect(result.plan.target).toMatchObject({ worker: "static-vite-demo-staging" });
  });
});

describe("design on GitHub Pages", () => {
  const PAGES = { provider: "github-pages" } as const;

  it("plans a Hugo site in a public repository: free, DNS-only, with GitHub's limits and terms", async () => {
    const api = github({ private: false });
    const deps = await project({
      files: HUGO_SITE,
      requirements: PAGES,
      env: { GITHUB_TOKEN: GITHUB },
      fetch: api.fetch,
      git: { owner: "acme", repo: "site" },
    });
    const result = await runDesign(deps);
    expect(result.plan.target).toEqual({
      provider: "github-pages",
      mode: "pages-workflow",
      site: { tool: "hugo", command: "hugo --minify", outputDir: "public" },
    });
    expect(result.plan.dns).toMatchObject({
      provider: "cloudflare",
      domain: DOMAIN,
      proxied: false,
    });
    expect(result.plan.security.wafCustomRules).toBe(false);
    expect(result.chosen).toMatchObject({
      id: "github-pages",
      title: "GitHub Pages (no server)",
      cost: {
        monthly: { amount: 0, currency: "USD" },
        breakdown: [{ item: "GitHub Pages (free)" }],
      },
    });
    expect(result.chosen.summary).toContain(
      "https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits",
    );
    expect(result.chosen.tradeoffs).toEqual(
      expect.arrayContaining([
        "A site of at most 1 GB, and a soft limit of 100 GB of traffic a month.",
        expect.stringContaining("No custom response headers"),
        "Static files only: no server-side rendering and no runtime secrets.",
        "GitHub's terms do not allow GitHub Pages for running a business, e-commerce or a commercial SaaS.",
      ]),
    );
    expect(api.calls).toEqual(["/repos/acme/site"]);
    // The GitHub token reaches no output, plan or audit entry.
    expect(await outputs(deps)).not.toContain(GITHUB);
    expect(JSON.stringify(deps.audit)).not.toContain(GITHUB);
  });

  it("refuses a private repository on GitHub's free plan, and writes nothing", async () => {
    const deps = await project({
      files: HUGO_SITE,
      requirements: PAGES,
      env: { GITHUB_TOKEN: GITHUB },
      fetch: github({ private: true, plan: "free" }).fetch,
      git: { owner: "acme", repo: "site" },
    });
    await expect(runDesign(deps)).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      message:
        "GitHub Pages is not offered for this app: the repository is private, and its owner's GitHub plan has GitHub Pages for public repositories only. Nothing was written.",
      hint: "Make the repository public, or move to GitHub Pro, Team or Enterprise (the site is public even then); or choose Cloudflare hosting with `opscrew interview`.",
    });
    expect(await readOptionalArtifact("plan", deps.paths.files.plan)).toBeUndefined();
    expect(await outputs(deps)).not.toContain(GITHUB);
  });

  it("offers GitHub Pages with the caveat when OpsCrew cannot tell the repository's plan", async () => {
    const deps = await project({
      example: "static-vite",
      requirements: PAGES,
      git: { owner: "acme", repo: "site" },
    });
    const { options } = await previewDesignOptions(deps);
    expect(options[0]?.tradeoffs).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "OpsCrew cannot tell whether GitHub allows Pages for this repository (no GitHub token is set)",
        ),
        "GitHub Pages has no fallback for a single-page app: a path that is no file gets the site's 404.html, with status 404.",
      ]),
    );
  });

  it("refuses a server-rendered app", async () => {
    const deps = await project({ example: "astro-ssr", requirements: PAGES });
    await expect(runDesign(deps)).rejects.toMatchObject({
      message:
        "GitHub Pages is not offered for this app: GitHub Pages serves static files only, and Astro renders the app's pages on the server. Nothing was written.",
    });
  });

  it("refuses a site with no build whose files are at the repository root", async () => {
    const deps = await project({
      files: { "index.html": "<h1>Example</h1>\n" },
      requirements: PAGES,
    });
    await expect(runDesign(deps)).rejects.toMatchObject({
      message:
        "GitHub Pages is not offered for this app: the site's files are at the repository root, so GitHub Pages would publish the whole repository (opscrew/, .github/ and everything else) with them. Nothing was written.",
    });
  });

  it("says a site there gets no runtime secrets, and that what its build is given is published", async () => {
    const deps = await project({
      example: "static-vite",
      files: { ".env.example": "VITE_MAPS_SECRET=\n" },
      requirements: PAGES,
    });
    const result = await runDesign(deps);
    expect(result.warnings).toContain(
      "GitHub Pages gives the site no runtime secrets: the app reads 1 secret (VITE_MAPS_SECRET), and anything its build is given ends up in the published files, where anyone can read it.",
    );
  });
});
