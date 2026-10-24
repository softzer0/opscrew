import { afterEach, describe, expect, it } from "vitest";
import { detectProject, detectProjectDetails, detectSite } from "./index";
import { makeTree, removeTree } from "./test-helpers";

const roots: string[] = [];
async function tree(files: Record<string, string>): Promise<string> {
  const root = await makeTree(files, "site");
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeTree));
});

/** The site detection of the repository `files`, from its facts as analyze writes them. */
async function siteOf(files: Record<string, string>) {
  const root = await tree(files);
  return detectSite(root, await detectProject(root));
}

function pkg(
  dependencies: Record<string, string>,
  scripts: Record<string, string> = { build: "vite build" },
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({ name: "example-app", scripts, dependencies, ...extra });
}

const VITE_SPA = {
  "package.json": pkg({ react: "^19.0.0", vite: "^8.0.0" }),
  "index.html": "<div id=root></div>",
  "src/main.jsx": "console.log(1);",
};

describe("detectSite: static sites built with Node.js", () => {
  it("describes a Vite single-page app: npm, its build script and dist", async () => {
    expect(await siteOf(VITE_SPA)).toEqual({
      dir: ".",
      tool: "node",
      packageManager: "npm",
      command: "npm run build",
      render: "static",
      framework: "vite",
      outputDir: "dist",
      spa: true,
      serverNeeds: [],
    });
  });

  it("reads the package manager from its lockfile and the site's own files from public/", async () => {
    const site = await siteOf({
      ...VITE_SPA,
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
      "public/_headers": "/*\n  X-Example: 1\n",
      "public/_redirects": "/old /new 301\n",
      "public/404.html": "<h1>Not found</h1>",
    });
    expect(site).toMatchObject({
      packageManager: "pnpm",
      command: "pnpm run build",
      headers: "public/_headers",
      redirects: "public/_redirects",
      notFoundPage: "public/404.html",
    });
  });

  it("builds a workspace member in its own folder", async () => {
    const site = await siteOf({
      "package.json": JSON.stringify({ name: "root", private: true, workspaces: ["apps/*"] }),
      "pnpm-workspace.yaml": "packages:\n  - apps/*\n",
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
      "apps/web/package.json": pkg({ react: "^19.0.0", vite: "^8.0.0" }),
      "apps/web/vite.config.ts": 'export default { build: { outDir: "build/site" } };',
    });
    expect(site).toMatchObject({
      dir: "apps/web",
      tool: "node",
      command: "pnpm run build",
      outputDir: "build/site",
    });
  });

  it("publishes Astro's static output, a static Next.js export and Nuxt's generated site", async () => {
    const astro = await siteOf({
      "package.json": pkg({ astro: "7.3.8" }, { build: "astro build" }),
      "src/pages/index.astro": "<h1>Hi</h1>",
      "src/pages/404.astro": "<h1>Not found</h1>",
    });
    expect(astro).toMatchObject({
      render: "static",
      framework: "astro",
      outputDir: "dist",
      spa: false,
      notFoundPage: "src/pages/404.astro",
    });
    const next = await siteOf({
      "package.json": pkg({ next: "16.4.2", react: "19.0.0" }, { build: "next build" }),
      "next.config.mjs": 'export default { output: "export" };',
    });
    expect(next).toMatchObject({ render: "static", framework: "next", outputDir: "out" });
    const nuxt = await siteOf({
      "package.json": pkg({ nuxt: "4.6.1" }, { build: "nuxt generate" }),
      "nuxt.config.ts": "export default defineNuxtConfig({})",
    });
    expect(nuxt).toMatchObject({
      render: "static",
      framework: "nuxt",
      outputDir: ".output/public",
    });
    expect(nuxt?.adapter).toBeUndefined();
  });

  it("publishes SvelteKit's static adapter output", async () => {
    const site = await siteOf({
      "package.json": pkg(
        { "@sveltejs/kit": "3.0.1", "@sveltejs/adapter-static": "4.0.0", svelte: "5.0.0" },
        { build: "vite build" },
      ),
    });
    expect(site).toMatchObject({ render: "static", framework: "sveltekit", outputDir: "build" });
  });

  it("has no build command without a build script", async () => {
    const site = await siteOf({
      "package.json": pkg({ react: "^19.0.0", vite: "^8.0.0" }, { dev: "vite" }),
    });
    expect(site).toMatchObject({ tool: "node", render: "static" });
    expect(site?.command).toBeUndefined();
  });
});

describe("detectSite: server-rendered apps and their Cloudflare adapters", () => {
  it("names Astro's Cloudflare adapter, missing while the app uses another", async () => {
    const site = await siteOf({
      "package.json": pkg(
        { astro: "7.3.8", "@astrojs/node": "11.1.7" },
        { build: "astro build" },
        { engines: { node: ">=22.12.0" } },
      ),
      "astro.config.mjs":
        "import node from '@astrojs/node';\nexport default { output: 'server', adapter: node() };",
    });
    expect(site).toEqual({
      dir: ".",
      tool: "node",
      packageManager: "npm",
      command: "npm run build",
      render: "ssr",
      framework: "astro",
      config: "astro.config.mjs",
      outputDir: "dist/client",
      adapter: {
        framework: "astro",
        name: "@astrojs/cloudflare",
        installed: false,
        entry: "dist/server/entry.mjs",
        compatibilityFlags: [],
      },
      spa: false,
      serverNeeds: [],
    });
  });

  it("knows the adapter an app already has", async () => {
    const site = await siteOf({
      "package.json": pkg(
        { astro: "7.4.0", "@astrojs/cloudflare": "14.4.2" },
        { build: "astro build" },
      ),
      "astro.config.mjs": "export default { output: 'server' };",
    });
    expect(site?.adapter).toMatchObject({ name: "@astrojs/cloudflare", installed: true });
  });

  it("knows Nitro's cloudflare_module preset for Nuxt, with its compatibility flag", async () => {
    const files = {
      "package.json": pkg({ nuxt: "4.6.1" }, { build: "nuxt build" }),
      "nuxt.config.ts":
        "export default defineNuxtConfig({ nitro: { preset: 'cloudflare_module' } })",
    };
    expect(await siteOf(files)).toMatchObject({
      render: "ssr",
      config: "nuxt.config.ts",
      outputDir: ".output/public",
      adapter: {
        framework: "nuxt",
        name: "cloudflare_module",
        installed: true,
        entry: ".output/server/index.mjs",
        compatibilityFlags: ["nodejs_compat"],
      },
    });
    const without = await siteOf({ ...files, "nuxt.config.ts": "export default {}" });
    expect(without?.adapter).toMatchObject({ installed: false });
  });

  it("puts SvelteKit's Worker inside its output folder", async () => {
    const site = await siteOf({
      "package.json": pkg(
        { "@sveltejs/kit": "3.0.1", "@sveltejs/adapter-cloudflare": "8.0.1", svelte: "5.0.0" },
        { build: "vite build" },
      ),
      _headers: "/*\n  X-Example: 1\n",
    });
    expect(site).toMatchObject({
      render: "ssr",
      outputDir: ".svelte-kit/cloudflare",
      adapter: {
        framework: "sveltekit",
        installed: true,
        entry: ".svelte-kit/cloudflare/_worker.js",
        compatibilityFlags: [],
      },
      headers: "_headers",
    });
  });

  it("builds Next.js through OpenNext and reports the options that hang it on Workers", async () => {
    const site = await siteOf({
      "package.json": pkg(
        { next: "16.4.2", react: "19.0.0", "@opennextjs/cloudflare": "1.20.13" },
        { build: "next build" },
      ),
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
      "next.config.ts":
        "const config = { cacheComponents: true, experimental: { partialPrefetching: true } };\nexport default config;",
    });
    expect(site).toMatchObject({
      packageManager: "pnpm",
      command: "pnpm exec opennextjs-cloudflare build --skipWranglerConfigCheck",
      render: "ssr",
      config: "next.config.ts",
      outputDir: ".open-next/assets",
      adapter: {
        framework: "next",
        name: "@opennextjs/cloudflare",
        installed: true,
        entry: ".open-next/worker.js",
        compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
      },
      nextOptions: ["cacheComponents", "partialPrefetching"],
    });
    const off = await siteOf({
      "package.json": pkg({ next: "16.4.2", react: "19.0.0" }, { build: "next build" }),
      "next.config.ts": "export default { cacheComponents: false };",
    });
    expect(off?.nextOptions).toBeUndefined();
    expect(off?.adapter).toMatchObject({ installed: false });
  });

  it("has no adapter for a framework outside the four", async () => {
    const site = await siteOf({
      "package.json": pkg(
        { "@react-router/dev": "7.0.0", "@react-router/node": "7.0.0", react: "19.0.0" },
        { build: "react-router build" },
      ),
    });
    expect(site).toMatchObject({ render: "ssr", framework: "react-router" });
    expect(site?.adapter).toBeUndefined();
    expect(site?.outputDir).toBeUndefined();
  });
});

describe("detectSite: Hugo and sites with no build", () => {
  it("describes a Hugo site with its 404 layout and its own files in static/", async () => {
    expect(
      await siteOf({
        "hugo.toml": 'baseURL = "https://example.com/"\ntitle = "Example"\n',
        "content/_index.md": "# Hello\n",
        "layouts/404.html": "<h1>Not found</h1>",
        "static/_headers": "/*\n  X-Example: 1\n",
      }),
    ).toEqual({
      dir: ".",
      tool: "hugo",
      command: "hugo --minify",
      render: "static",
      framework: "hugo",
      outputDir: "public",
      spa: false,
      headers: "static/_headers",
      notFoundPage: "layouts/404.html",
      serverNeeds: [],
    });
  });

  it("follows Hugo's publishDir, and a config.toml only next to content/", async () => {
    const site = await siteOf({
      "config.toml": 'title = "Example"\npublishDir = "build/site"\n',
      "content/about.md": "# About\n",
    });
    expect(site).toMatchObject({ tool: "hugo", outputDir: "build/site" });
    expect(await siteOf({ "config.toml": 'title = "Example"\n' })).toBeUndefined();
  });

  it("publishes the folder that holds index.html, built by nothing", async () => {
    expect(
      await siteOf({
        "README.md": "# Example\n",
        "docs/index.html": "<h1>Example</h1>",
        "docs/404.html": "<h1>Not found</h1>",
        "docs/_redirects": "/old /new 301\n",
      }),
    ).toEqual({
      dir: ".",
      tool: "none",
      render: "static",
      outputDir: "docs",
      spa: false,
      redirects: "docs/_redirects",
      notFoundPage: "docs/404.html",
      serverNeeds: [],
    });
  });

  it("never names the repository root as the folder to publish", async () => {
    const site = await siteOf({
      "index.html": "<h1>Example</h1>",
      "public/index.html": "<h1>Another</h1>",
    });
    expect(site).toMatchObject({ dir: ".", tool: "none", render: "static" });
    expect(site?.outputDir).toBeUndefined();
  });
});

describe("a site without a manifest is an app folder", () => {
  /** The two-apps live pass: examples/static-vite in sites/landing, examples/hugo-site in sites/docs. */
  const TWO_SITES = {
    "README.md": "# Two sites\n",
    ...Object.fromEntries(
      Object.entries(VITE_SPA).map(([path, text]) => [`sites/landing/${path}`, text]),
    ),
    "sites/docs/hugo.toml": 'baseURL = "https://example.com/"\ntitle = "Docs"\n',
    "sites/docs/content/_index.md": "# Docs\n",
    "sites/docs/layouts/404.html": "<h1>Not found</h1>",
    "sites/docs/layouts/home.html": "<h1>{{ .Title }}</h1>",
  };

  it("offers a Hugo folder beside a Node.js app as a candidate, and --dir gives Hugo's facts", async () => {
    const root = await tree(TWO_SITES);
    expect((await detectProjectDetails(root)).appCandidates).toEqual([
      "sites/docs",
      "sites/landing",
    ]);
    const docs = await detectProjectDetails(root, { appDir: "sites/docs" });
    expect(docs.appDir).toBe("sites/docs");
    expect(await detectSite(root, docs.facts)).toEqual({
      dir: "sites/docs",
      tool: "hugo",
      command: "hugo --minify",
      render: "static",
      framework: "hugo",
      outputDir: "public",
      spa: false,
      notFoundPage: "sites/docs/layouts/404.html",
      serverNeeds: [],
    });
    const landing = await detectProjectDetails(root, { appDir: "sites/landing" });
    expect(await detectSite(root, landing.facts)).toMatchObject({
      dir: "sites/landing",
      tool: "node",
      framework: "vite",
    });
  });

  it("keeps a Hugo folder, Markdown or index.html inside a Node.js app part of that app", async () => {
    const root = await tree({
      ...Object.fromEntries(Object.entries(VITE_SPA).map(([path, text]) => [`web/${path}`, text])),
      "web/docs/hugo.toml": 'title = "Docs"\n',
      "web/docs/content/_index.md": "# Docs\n",
      "web/notes/index.html": "<h1>Notes</h1>",
      "guide/intro.md": "# Intro\n",
    });
    const details = await detectProjectDetails(root);
    expect(details.appCandidates).toEqual([]);
    expect(details.appDir).toBe("web");
    await expect(detectProjectDetails(root, { appDir: "web/docs" })).rejects.toThrow(
      /not an app directory/,
    );
  });
});

describe("detectSite: apps that are no site", () => {
  it("finds no site in an API or an empty repository", async () => {
    expect(
      await siteOf({
        "package.json": pkg({ express: "^5.0.0" }, { start: "node index.js" }),
        "index.js": "require('express')().listen(3000);",
      }),
    ).toBeUndefined();
    expect(await siteOf({ "README.md": "# Nothing\n" })).toBeUndefined();
  });

  it("names what needs a server process that keeps running", async () => {
    const site = await siteOf({
      "package.json": pkg(
        { next: "16.4.2", react: "19.0.0", "socket.io": "^4.8.0", "node-cron": "^4.0.0" },
        { build: "next build" },
      ),
    });
    expect(site?.serverNeeds).toEqual([
      "WebSockets held open (socket.io)",
      "a scheduler in the app's process (node-cron)",
    ]);
  });
});
