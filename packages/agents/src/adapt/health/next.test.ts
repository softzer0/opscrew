import { describe, expect, it } from "vitest";
import { appFacts, memoryRepo, written } from "./__fixtures__/repo";
import { healthRouteEdit } from "./index";

const APP_ROUTE = "app/api/health/route.ts";

/** The Next.js health route for the plan's `path` over `files` (empty files unless given). */
function nextRoute(
  path: string,
  files: readonly string[] | Record<string, string>,
  healthPath = "/api/health",
) {
  const contents = Array.isArray(files)
    ? Object.fromEntries(files.map((file) => [file, ""]))
    : (files as Record<string, string>);
  return healthRouteEdit({
    facts: appFacts({ languages: ["typescript"], frameworks: ["next"], appKind: "ssr" }),
    stack: "nextjs",
    path,
    healthPath,
    repo: memoryRepo(contents),
  });
}

describe("the Next.js health route", () => {
  it("creates the app router route in TypeScript when the app has tsconfig.json", async () => {
    const edit = await nextRoute(APP_ROUTE, ["app/page.tsx", "tsconfig.json"]);
    expect(edit).toMatchObject({ action: "write", path: APP_ROUTE, checks: [] });
    const content = written(edit, APP_ROUTE);
    // NextResponse.json type-checks before TypeScript 5.2; `dynamic` breaks cacheComponents.
    expect(content).toBe(
      'import { NextResponse } from "next/server";\n\n/** Health check for the OpsCrew deploy workflow: answers 200 while the app is up. */\nexport function GET() {\n  return NextResponse.json({ status: "ok" });\n}\n',
    );
    expect(edit.action === "write" && edit.note).toBe(
      `Created ${APP_ROUTE} by OpsCrew: answers GET /api/health with {"status":"ok"} for the deploy health check.`,
    );
  });

  it("uses JavaScript when the app has no tsconfig.json, and names that file", async () => {
    const edit = await nextRoute(APP_ROUTE, ["app/page.jsx", "jsconfig.json"]);
    expect(edit).toMatchObject({ action: "write", path: "app/api/health/route.js" });
    expect(edit.action === "write" && edit.note).toContain(
      "Created app/api/health/route.js by OpsCrew",
    );
    const content = written(edit, "app/api/health/route.js");
    expect(content).toContain('return NextResponse.json({ status: "ok" });');
    expect(content).not.toContain("dynamic");
  });

  it("counts a route inside route groups as existing, also under src/", async () => {
    for (const existing of [
      "app/(api)/api/health/route.ts",
      "app/api/(checks)/health/route.js",
      "src/app/(site)/(api)/api/health/route.tsx",
      "app/api/health/(x)/route.ts",
    ]) {
      const edit = await nextRoute(APP_ROUTE, ["app/page.tsx", "tsconfig.json", existing]);
      expect(edit, existing).toEqual({
        action: "none",
        reason: `${existing} already answers /api/health; OpsCrew left it as it is.`,
      });
    }
    // Another path in a group, node_modules and an intercepting route do not count.
    const elsewhere = await nextRoute(APP_ROUTE, [
      "app/page.tsx",
      "tsconfig.json",
      "app/(api)/api/healthz/route.ts",
      "app/node_modules/api/health/route.ts",
      "app/(.)api/health/route.ts",
    ]);
    expect(elsewhere).toMatchObject({ action: "write", path: APP_ROUTE });
  });

  it("creates the pages router route, in src/ and in a monorepo folder", async () => {
    const pages = await nextRoute("pages/api/health.ts", ["pages/index.tsx", "tsconfig.json"]);
    expect(pages).toMatchObject({ action: "write", path: "pages/api/health.ts" });
    expect(written(pages, "pages/api/health.ts")).toBe(
      'import type { NextApiRequest, NextApiResponse } from "next";\n\n/** Health check for the OpsCrew deploy workflow: answers 200 while the app is up. */\nexport default function handler(_req: NextApiRequest, res: NextApiResponse) {\n  res.status(200).json({ status: "ok" });\n}\n',
    );
    const js = await nextRoute("pages/api/health.js", ["pages/index.js"]);
    expect(written(js, "pages/api/health.js")).toBe(
      '/** Health check for the OpsCrew deploy workflow: answers 200 while the app is up. */\nexport default function handler(_req, res) {\n  res.status(200).json({ status: "ok" });\n}\n',
    );

    const src = await nextRoute("apps/web/src/app/api/health/route.ts", [
      "apps/web/src/app/page.tsx",
      "apps/web/tsconfig.json",
    ]);
    expect(src).toMatchObject({ action: "write", path: "apps/web/src/app/api/health/route.ts" });
  });

  it("never replaces a route that already answers the path, in either router", async () => {
    for (const existing of [
      "app/api/health/route.js",
      "app/api/health/route.ts",
      "pages/api/health.js",
      "pages/api/health/index.ts",
      "src/pages/api/health.ts",
    ]) {
      const edit = await nextRoute(APP_ROUTE, ["app/page.tsx", "tsconfig.json", existing]);
      expect(edit, existing).toEqual({
        action: "none",
        reason: `${existing} already answers /api/health; OpsCrew left it as it is.`,
      });
    }
  });

  it("leaves the route to the agent or the user when the router is not clear", async () => {
    const noRouter = await nextRoute(APP_ROUTE, ["tsconfig.json", "components/button.tsx"]);
    expect(noRouter).toEqual({
      action: "manual",
      reason: "the app has no app/ folder, so OpsCrew cannot tell which Next.js router it uses.",
    });

    const ignoredSrc = await nextRoute("src/app/api/health/route.ts", [
      "src/app/page.tsx",
      "pages/index.tsx",
      "tsconfig.json",
    ]);
    expect(ignoredSrc).toEqual({
      action: "manual",
      reason:
        "the app has an app/ or pages/ folder next to src/, so Next.js ignores src/app/ and OpsCrew cannot tell where the route belongs.",
    });

    const otherPath = await nextRoute(APP_ROUTE, ["app/page.tsx"], "/healthz");
    expect(otherPath).toEqual({
      action: "manual",
      reason: "the plan checks /healthz, and OpsCrew only creates /api/health itself.",
    });
    const trailing = await nextRoute(APP_ROUTE, ["app/page.tsx"], "/api/health/");
    expect(trailing).toEqual({
      action: "manual",
      reason: "the plan checks /api/health/, and OpsCrew only creates /api/health itself.",
    });

    const odd = await nextRoute("app/health/route.ts", ["app/page.tsx"]);
    expect(odd).toEqual({
      action: "manual",
      reason:
        "OpsCrew only creates the route as app/api/health/route.ts or pages/api/health.ts, not app/health/route.ts.",
    });
  });

  it("names middleware (or proxy) that might protect the path", async () => {
    const edit = await nextRoute(APP_ROUTE, ["app/page.tsx", "tsconfig.json", "middleware.ts"]);
    expect(edit.action === "write" && edit.checks).toEqual([
      "Check that middleware.ts does not redirect or protect /api/health: the deploy health check calls it without a session.",
    ]);
    const proxy = await nextRoute("src/app/api/health/route.ts", [
      "src/app/page.tsx",
      "tsconfig.json",
      "src/proxy.ts",
    ]);
    expect(proxy.action === "write" && proxy.checks).toEqual([
      "Check that src/proxy.ts does not redirect or protect /api/health: the deploy health check calls it without a session.",
    ]);
  });
});

describe("the Next.js health route with a basePath", () => {
  it("moves the plan's health path under a literal basePath", async () => {
    const edit = await nextRoute("apps/web/app/api/health/route.ts", {
      "apps/web/app/page.tsx": "",
      "apps/web/tsconfig.json": "{}",
      "apps/web/next.config.ts":
        'import type { NextConfig } from "next";\n\nconst nextConfig: NextConfig = {\n  basePath: "/docs/",\n};\n\nexport default nextConfig;\n',
    });
    expect(edit).toMatchObject({
      action: "write",
      path: "apps/web/app/api/health/route.ts",
      healthPath: "/docs/api/health",
      pathNote:
        'apps/web/next.config.ts sets basePath "/docs/", so the health route answers at /docs/api/health; OpsCrew set app.healthPath in `opscrew/plan.yaml` to /docs/api/health to match.',
    });
  });

  it("names a basePath it cannot read, for an existing route too", async () => {
    const edit = await nextRoute(APP_ROUTE, {
      "app/api/health/route.ts": "",
      "next.config.mjs": "export default { basePath: process.env.BASE_PATH };\n",
    });
    expect(edit).toEqual({
      action: "none",
      reason: "app/api/health/route.ts already answers /api/health; OpsCrew left it as it is.",
      pathNote:
        "next.config.mjs mentions basePath in a way OpsCrew cannot read: if it sets one, the health route answers at <basePath>/api/health and the plan's health check path must be that (run `opscrew design` and set it, or edit app.healthPath in `opscrew/plan.yaml`), or every deploy fails its health check.",
    });
  });

  it("adds no note without a basePath", async () => {
    for (const config of [
      "export default {};\n",
      'export default { basePath: "" };\n',
      "// basePath: '/old'\nexport default { experimental: { basePath: 1 } };\n",
    ]) {
      const edit = await nextRoute(APP_ROUTE, { "app/page.tsx": "", "next.config.mjs": config });
      expect(edit).toMatchObject({ action: "write" });
      expect(edit.action === "write" && edit.pathNote).toBeUndefined();
      expect(edit.action === "write" && edit.healthPath).toBeUndefined();
    }
  });
});
