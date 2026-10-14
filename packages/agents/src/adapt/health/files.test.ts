import { describe, expect, it } from "vitest";
import { appFacts, healthInput, syntaxError, written } from "./__fixtures__/repo";
import { healthRouteEdit } from "./index";

const lines = (...text: string[]) => `${text.join("\n")}\n`;
const DOC = "/** Health check for the OpsCrew deploy workflow: answers 200 while the app is up. */";
const PLAN_FIX =
  "(run `opscrew design` and set it, or edit app.healthPath in `opscrew/plan.yaml`), or every deploy fails its health check.";

const ssr = (framework: string, languages: ("typescript" | "javascript")[] = ["typescript"]) =>
  appFacts({ languages, frameworks: [framework], appKind: "ssr" });
const pkg = (deps: Record<string, string>) => JSON.stringify({ dependencies: deps });

/** Runs the registry and returns the edit (every written file must still parse). */
async function run(framework: string, files: Record<string, string>, healthPath = "/health") {
  const edit = await healthRouteEdit(healthInput("node-server", ssr(framework), files, healthPath));
  if (edit.action === "write") {
    for (const file of edit.files) expect(syntaxError(file.content), file.path).toBeUndefined();
  }
  return edit;
}

describe("Next.js (unchanged, through the registry)", () => {
  it("creates the app router route and names middleware, like before", async () => {
    const edit = await healthRouteEdit({
      ...healthInput(
        "nextjs",
        ssr("next"),
        {
          "app/page.tsx": "export default function Page() {}\n",
          "tsconfig.json": "{}",
          "middleware.ts": "",
        },
        "/api/health",
      ),
      path: "app/api/health/route.ts",
    });
    expect(edit).toMatchObject({
      action: "write",
      framework: "Next.js",
      path: "app/api/health/route.ts",
    });
    expect(written(edit, "app/api/health/route.ts")).toContain(
      'return NextResponse.json({ status: "ok" });',
    );
    expect(edit.action === "write" && edit.checks).toEqual([
      "Check that middleware.ts does not redirect or protect /api/health: the deploy health check calls it without a session.",
    ]);
  });
});

describe("Nuxt", () => {
  const app = (extra: Record<string, string> = {}) => ({
    "package.json": pkg({ nuxt: "^4.1.0" }),
    "nuxt.config.ts": lines(
      "export default defineNuxtConfig({",
      '  compatibilityDate: "2025-07-15",',
      "  devtools: { enabled: true },",
      "});",
    ),
    "tsconfig.json": "{}",
    "app/app.vue": "<template><NuxtPage /></template>\n",
    ...extra,
  });

  it("creates server/routes/health.ts with defineEventHandler", async () => {
    const edit = await run("nuxt", app());
    expect(edit).toMatchObject({
      action: "write",
      framework: "Nuxt",
      path: "server/routes/health.ts",
    });
    expect(written(edit, "server/routes/health.ts")).toBe(
      lines(DOC, 'export default defineEventHandler(() => ({ status: "ok" }));'),
    );
    expect(edit.action === "write" && edit.checks).toEqual([]);
  });

  it("names server middleware, a base URL, an existing route and a moved server folder", async () => {
    const guarded = await run("nuxt", app({ "server/middleware/auth.ts": "" }));
    expect(guarded.action === "write" && guarded.checks).toEqual([
      "Check that server/middleware/ does not redirect or protect /health: the deploy health check calls it without a session.",
    ]);
    const based = await run(
      "nuxt",
      app({
        "nuxt.config.ts": 'export default defineNuxtConfig({ app: { baseURL: "/shop/" } });\n',
      }),
    );
    expect(based.action === "write" && based.pathNote).toBe(
      `nuxt.config.ts sets baseURL "/shop/", so the health route answers at /shop/health, not /health: the plan's health check path must be /shop/health ${PLAN_FIX}`,
    );
    expect(await run("nuxt", app({ "server/routes/health.get.ts": "" }))).toEqual({
      action: "none",
      reason: "server/routes/health.get.ts already answers /health; OpsCrew left it as it is.",
    });
    const moved = await run(
      "nuxt",
      app({ "nuxt.config.ts": 'export default defineNuxtConfig({ srcDir: "src/" });\n' }),
    );
    expect(moved).toMatchObject({ action: "manual" });
  });
});

describe("SvelteKit", () => {
  const app = (extra: Record<string, string> = {}) => ({
    "package.json": pkg({ "@sveltejs/kit": "^2.20.0", "@sveltejs/adapter-node": "^5.2.0" }),
    "svelte.config.js": lines(
      "import adapter from '@sveltejs/adapter-node';",
      "",
      "/** @type {import('@sveltejs/kit').Config} */",
      "const config = {",
      "\tkit: {",
      "\t\tadapter: adapter()",
      "\t}",
      "};",
      "",
      "export default config;",
    ),
    "tsconfig.json": "{}",
    "src/routes/+page.svelte": "<h1>Hi</h1>\n",
    ...extra,
  });

  it("creates src/routes/health/+server.ts in the project's style", async () => {
    const edit = await run("sveltekit", app());
    expect(written(edit, "src/routes/health/+server.ts")).toBe(
      lines(
        "import { json } from '@sveltejs/kit';",
        "",
        DOC,
        "export function GET() {",
        "\treturn json({ status: 'ok' });",
        "}",
      ),
    );
  });

  it("finds a route in a group, a page on the path, hooks and a base path", async () => {
    expect(await run("sveltekit", app({ "src/routes/(api)/health/+server.ts": "" }))).toEqual({
      action: "none",
      reason:
        "src/routes/(api)/health/+server.ts already answers /health; OpsCrew left it as it is.",
    });
    expect(await run("sveltekit", app({ "src/routes/health/+page.svelte": "" }))).toEqual({
      action: "manual",
      reason:
        "src/routes/health/+page.svelte already uses /health for a page, so OpsCrew did not add an endpoint there.",
    });
    const hooked = await run("sveltekit", app({ "src/hooks.server.ts": "" }));
    expect(hooked.action === "write" && hooked.checks[0]).toContain(
      "Check that src/hooks.server.ts does not redirect or protect /health",
    );
    const based = await run(
      "sveltekit",
      app({ "svelte.config.js": "export default { kit: { paths: { base: '/app' } } };\n" }),
    );
    expect(based.action === "write" && based.pathNote).toContain(
      'svelte.config.js sets base "/app", so the health route answers at /app/health',
    );
  });
});

describe("Astro", () => {
  const config = lines(
    "// @ts-check",
    "import { defineConfig } from 'astro/config';",
    "",
    "import node from '@astrojs/node';",
    "",
    "export default defineConfig({",
    "  output: 'server',",
    "  adapter: node({",
    "    mode: 'standalone',",
    "  }),",
    "});",
  );
  const app = (extra: Record<string, string> = {}) => ({
    "package.json": pkg({ astro: "^5.13.0", "@astrojs/node": "^9.4.0" }),
    "astro.config.mjs": config,
    "tsconfig.json": "{}",
    "src/pages/index.astro": "<h1>Hi</h1>\n",
    ...extra,
  });

  it("creates an on-demand endpoint src/pages/health.ts", async () => {
    const edit = await run("astro", app());
    expect(written(edit, "src/pages/health.ts")).toBe(
      lines(
        "// Rendered on every request, never prerendered at build time.",
        "export const prerender = false;",
        "",
        DOC,
        "export function GET() {",
        "  const headers = { 'Content-Type': 'application/json' };",
        "  return new Response(JSON.stringify({ status: 'ok' }), { headers });",
        "}",
      ),
    );
  });

  it("adds nothing to a static site, and notes a base path", async () => {
    const static_ = await run("astro", app({ "astro.config.mjs": "export default {};\n" }));
    expect(static_).toMatchObject({ action: "manual" });
    expect(static_.action === "manual" && static_.reason).toContain("builds static files");
    const based = await run(
      "astro",
      app({
        "astro.config.mjs":
          "export default { output: 'server', adapter: node(), base: '/docs' };\n",
      }),
    );
    expect(based.action === "write" && based.pathNote).toContain(
      'astro.config.mjs sets base "/docs", so the health route answers at /docs/health',
    );
  });
});

describe("Remix", () => {
  const app = (deps: Record<string, string>, extra: Record<string, string> = {}) => ({
    "package.json": pkg(deps),
    "vite.config.ts": lines(
      'import { vitePlugin as remix } from "@remix-run/dev";',
      'import { defineConfig } from "vite";',
      "",
      "export default defineConfig({ plugins: [remix()] });",
    ),
    "tsconfig.json": "{}",
    "app/root.tsx": "export default function App() {}\n",
    ...extra,
  });

  it("creates a resource route app/routes/health.ts (flat routes)", async () => {
    const edit = await run("remix", app({ "@remix-run/node": "^2.16.0" }), "/api/health");
    expect(edit).toMatchObject({ action: "write", path: "app/routes/api.health.ts" });
    expect(written(edit, "app/routes/api.health.ts")).toBe(
      lines(
        DOC,
        "export function loader() {",
        '  const headers = { "Content-Type": "application/json" };',
        '  return new Response(JSON.stringify({ status: "ok" }), { headers });',
        "}",
      ),
    );
  });

  it("leaves a page on the path and nested Remix 1 paths alone", async () => {
    expect(
      await run("remix", app({ "@remix-run/node": "^2.16.0" }, { "app/routes/health.tsx": "" })),
    ).toMatchObject({ action: "manual" });
    expect(await run("remix", app({ "@remix-run/node": "^1.19.0" }), "/api/health")).toMatchObject({
      action: "manual",
    });
  });
});

describe("React Router", () => {
  const routes = lines(
    'import { type RouteConfig, index } from "@react-router/dev/routes";',
    "",
    "export default [",
    '  index("routes/home.tsx"),',
    "] satisfies RouteConfig;",
  );
  const app = (extra: Record<string, string> = {}) => ({
    "package.json": pkg({ "@react-router/node": "^7.9.0", "react-router": "^7.9.0" }),
    "react-router.config.ts": lines(
      'import type { Config } from "@react-router/dev/config";',
      "",
      "export default {",
      "  ssr: true,",
      "} satisfies Config;",
    ),
    "tsconfig.json": "{}",
    "app/root.tsx": "export default function App() {}\n",
    "app/routes.ts": routes,
    "app/routes/home.tsx": "export default function Home() {}\n",
    ...extra,
  });

  it("creates the resource route and registers it in app/routes.ts", async () => {
    const edit = await run("react-router", app());
    expect(edit).toMatchObject({ action: "write", path: "app/routes/health.ts" });
    expect(written(edit, "app/routes/health.ts")).toContain("export function loader() {");
    expect(written(edit, "app/routes.ts")).toBe(
      lines(
        'import { type RouteConfig, index, route } from "@react-router/dev/routes";',
        "",
        "export default [",
        '  index("routes/home.tsx"),',
        '  route("health", "routes/health.ts"),',
        "] satisfies RouteConfig;",
      ),
    );
    expect(edit.action === "write" && edit.note).toBe(
      'Created app/routes/health.ts by OpsCrew: answers GET /health with {"status":"ok"} for the deploy health check. Registered in app/routes.ts.',
    );
  });

  it("only adds the file with flatRoutes, and leaves a registered route alone", async () => {
    const flat = await run(
      "react-router",
      app({
        "app/routes.ts": lines(
          'import type { RouteConfig } from "@react-router/dev/routes";',
          'import { flatRoutes } from "@react-router/fs-routes";',
          "",
          "export default flatRoutes() satisfies RouteConfig;",
        ),
      }),
    );
    expect(flat.action === "write" && flat.files.map((f) => f.path)).toEqual([
      "app/routes/health.ts",
    ]);
    const registered = await run(
      "react-router",
      app({
        "app/routes.ts": routes.replace(
          '  index("routes/home.tsx"),',
          '  index("routes/home.tsx"),\n  route("health", "routes/health.ts"),',
        ),
        "app/routes/health.ts": "export function loader() {}\n",
      }),
    );
    expect(registered).toEqual({
      action: "none",
      reason: "app/routes.ts already answers /health; OpsCrew left it as it is.",
    });
  });

  it("adds nothing in SPA mode and notes a basename", async () => {
    const spa = await run(
      "react-router",
      app({ "react-router.config.ts": "export default { ssr: false };\n" }),
    );
    expect(spa.action === "manual" && spa.reason).toContain("ssr: false");
    const based = await run(
      "react-router",
      app({ "react-router.config.ts": 'export default { basename: "/app/" };\n' }),
    );
    expect(based.action === "write" && based.pathNote).toContain(
      'react-router.config.ts sets basename "/app/", so the health route answers at /app/health',
    );
  });
});

describe("SolidStart", () => {
  it("creates the API route src/routes/health.ts", async () => {
    const edit = await healthRouteEdit(
      healthInput("node-server", appFacts({ languages: ["typescript"], appKind: "ssr" }), {
        "package.json": pkg({ "@solidjs/start": "^1.1.0", "solid-js": "^1.9.0" }),
        "app.config.ts":
          'import { defineConfig } from "@solidjs/start/config";\n\nexport default defineConfig({});\n',
        "tsconfig.json": "{}",
        "src/app.tsx": "export default function App() {}\n",
      }),
    );
    expect(edit).toMatchObject({
      action: "write",
      framework: "SolidStart",
      path: "src/routes/health.ts",
    });
    const content = written(edit, "src/routes/health.ts");
    expect(content).toContain("export function GET() {");
    expect(syntaxError(content)).toBeUndefined();
  });
});
