import { describe, expect, it } from "vitest";
import { nextHealthRoute } from "./health-route";

/** `exists` over a fixed set of repo-relative files; folders exist when a file is inside them. */
function tree(...files: string[]) {
  return async (path: string) => files.some((file) => file === path || file.startsWith(`${path}/`));
}

/** `folders` over the same files: the sub-folders of a folder. */
function folders(...files: string[]) {
  return async (path: string) => {
    const names = new Set<string>();
    for (const file of files) {
      if (!file.startsWith(`${path}/`)) continue;
      const rest = file.slice(path.length + 1).split("/");
      if (rest.length > 1) names.add(rest[0] as string);
    }
    return [...names];
  };
}

const APP_ROUTE = "app/api/health/route.ts";

describe("nextHealthRoute", () => {
  it("creates the app router route in TypeScript when the app has tsconfig.json", async () => {
    const edit = await nextHealthRoute({
      path: APP_ROUTE,
      healthPath: "/api/health",
      exists: tree("app/page.tsx", "tsconfig.json"),
    });
    expect(edit).toMatchObject({ action: "write", path: APP_ROUTE });
    if (edit.action !== "write") return;
    // NextResponse.json type-checks before TypeScript 5.2; `dynamic` breaks cacheComponents.
    expect(edit.content).toContain('import { NextResponse } from "next/server";');
    expect(edit.content).toContain('return NextResponse.json({ status: "ok" });');
    expect(edit.content).not.toMatch(/[^t]Response\.json/);
    expect(edit.content).not.toContain("dynamic");
    expect(edit.content).toContain("export function GET()");
    expect(edit.note).toContain(`Created ${APP_ROUTE} by OpsCrew`);
    expect(edit.middleware).toBeUndefined();
  });

  it("uses JavaScript when the app has no tsconfig.json, and names that file", async () => {
    const edit = await nextHealthRoute({
      path: APP_ROUTE,
      healthPath: "/api/health",
      exists: tree("app/page.jsx", "jsconfig.json"),
    });
    expect(edit).toMatchObject({ action: "write", path: "app/api/health/route.js" });
    if (edit.action !== "write") return;
    expect(edit.note).toContain("Created app/api/health/route.js by OpsCrew");
    expect(edit.content).toContain('return NextResponse.json({ status: "ok" });');
    expect(edit.content).not.toContain("dynamic");
  });

  it("counts a route inside route groups as existing, also under src/", async () => {
    for (const existing of [
      "app/(api)/api/health/route.ts",
      "app/api/(checks)/health/route.js",
      "src/app/(site)/(api)/api/health/route.tsx",
      "app/api/health/(x)/route.ts",
    ]) {
      const files = ["app/page.tsx", "tsconfig.json", existing];
      const edit = await nextHealthRoute({
        path: APP_ROUTE,
        healthPath: "/api/health",
        exists: tree(...files),
        folders: folders(...files),
      });
      expect(edit, existing).toEqual({
        action: "none",
        reason: `${existing} already answers /api/health; OpsCrew left it as it is.`,
      });
    }
    // Another path in a group, node_modules and an intercepting route do not count.
    const others = [
      "app/page.tsx",
      "tsconfig.json",
      "app/(api)/api/healthz/route.ts",
      "app/node_modules/api/health/route.ts",
      "app/(.)api/health/route.ts",
    ];
    const elsewhere = await nextHealthRoute({
      path: APP_ROUTE,
      healthPath: "/api/health",
      exists: tree(...others),
      folders: folders(...others),
    });
    expect(elsewhere).toMatchObject({ action: "write", path: APP_ROUTE });
  });

  it("creates the pages router route, in src/ and in a monorepo folder", async () => {
    const pages = await nextHealthRoute({
      path: "pages/api/health.ts",
      healthPath: "/api/health",
      exists: tree("pages/index.tsx", "tsconfig.json"),
    });
    expect(pages).toMatchObject({ action: "write", path: "pages/api/health.ts" });
    if (pages.action === "write") {
      expect(pages.content).toContain(
        'import type { NextApiRequest, NextApiResponse } from "next";',
      );
      expect(pages.content).toContain('res.status(200).json({ status: "ok" });');
    }
    const js = await nextHealthRoute({
      path: "pages/api/health.js",
      healthPath: "/api/health",
      exists: tree("pages/index.js"),
    });
    expect(js).toMatchObject({ action: "write", path: "pages/api/health.js" });
    if (js.action === "write") expect(js.content).not.toContain("NextApiRequest");

    const src = await nextHealthRoute({
      path: "apps/web/src/app/api/health/route.ts",
      healthPath: "/api/health",
      exists: tree("apps/web/src/app/page.tsx", "apps/web/tsconfig.json"),
    });
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
      const edit = await nextHealthRoute({
        path: APP_ROUTE,
        healthPath: "/api/health",
        exists: tree("app/page.tsx", "tsconfig.json", existing),
      });
      expect(edit, existing).toEqual({
        action: "none",
        reason: `${existing} already answers /api/health; OpsCrew left it as it is.`,
      });
    }
  });

  it("leaves the route to the agent or the user when the router is not clear", async () => {
    const noRouter = await nextHealthRoute({
      path: APP_ROUTE,
      healthPath: "/api/health",
      exists: tree("tsconfig.json", "components/button.tsx"),
    });
    expect(noRouter).toMatchObject({ action: "manual" });
    if (noRouter.action === "manual") expect(noRouter.reason).toContain("no app/ folder");

    const ignoredSrc = await nextHealthRoute({
      path: "src/app/api/health/route.ts",
      healthPath: "/api/health",
      exists: tree("src/app/page.tsx", "pages/index.tsx", "tsconfig.json"),
    });
    expect(ignoredSrc).toMatchObject({ action: "manual" });
    if (ignoredSrc.action === "manual") expect(ignoredSrc.reason).toContain("ignores src/");

    const otherPath = await nextHealthRoute({
      path: APP_ROUTE,
      healthPath: "/healthz",
      exists: tree("app/page.tsx"),
    });
    expect(otherPath).toMatchObject({ action: "manual" });

    const odd = await nextHealthRoute({
      path: "app/health/route.ts",
      healthPath: "/api/health",
      exists: tree("app/page.tsx"),
    });
    expect(odd).toMatchObject({ action: "manual" });
  });

  it("names middleware (or proxy) that might protect the path", async () => {
    const edit = await nextHealthRoute({
      path: APP_ROUTE,
      healthPath: "/api/health",
      exists: tree("app/page.tsx", "tsconfig.json", "middleware.ts"),
    });
    expect(edit).toMatchObject({ action: "write", middleware: "middleware.ts" });
    const proxy = await nextHealthRoute({
      path: "src/app/api/health/route.ts",
      healthPath: "/api/health",
      exists: tree("src/app/page.tsx", "tsconfig.json", "src/proxy.ts"),
    });
    expect(proxy).toMatchObject({ action: "write", middleware: "src/proxy.ts" });
  });
});
