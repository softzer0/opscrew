import { afterEach, describe, expect, it } from "vitest";
import { detectProject, detectProjectDetails } from "./index";
import { makeTree, removeTree } from "./test-helpers";

const roots: string[] = [];
async function tree(files: Record<string, string>): Promise<string> {
  const root = await makeTree(files, "workspace");
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeTree));
});

const json = (value: unknown) => JSON.stringify(value);

/**
 * A pnpm workspace with two sites and shared packages: the landing site uses `@acme/ui`
 * (`workspace:*`), which uses `@acme/tokens` (`workspace:^`); the docs site uses only the build
 * config package `@acme/config` (a development dependency). `@acme/unused` is used by no one.
 */
const PNPM_WORKSPACE = {
  "package.json": json({ name: "acme", private: true, packageManager: "pnpm@10.18.0" }),
  "pnpm-workspace.yaml": "packages:\n  - sites/*\n  - packages/*\n",
  "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
  "sites/landing/package.json": json({
    name: "landing",
    scripts: { build: "vite build" },
    dependencies: { "@acme/ui": "workspace:*", react: "^19.2.0" },
    devDependencies: { vite: "^7.1.0" },
  }),
  "sites/landing/index.html": "<!doctype html><title>Landing</title>",
  "sites/docs/package.json": json({
    name: "docs",
    scripts: { build: "astro build" },
    dependencies: { astro: "^5.14.0" },
    devDependencies: { "@acme/config": "workspace:*" },
  }),
  "packages/ui/package.json": json({
    name: "@acme/ui",
    dependencies: { "@acme/tokens": "workspace:^", react: "^19.2.0" },
  }),
  "packages/tokens/package.json": json({ name: "@acme/tokens" }),
  "packages/config/package.json": json({ name: "@acme/config" }),
  "packages/unused/package.json": json({ name: "@acme/unused" }),
};

describe("the workspace packages an app's build uses", () => {
  it("records a pnpm workspace member's local packages, transitively and sorted", async () => {
    const root = await tree(PNPM_WORKSPACE);
    const landing = await detectProject(root, { appDir: "sites/landing" });
    expect(landing.workspacePackages).toEqual(["packages/tokens", "packages/ui"]);
    // Development dependencies are installed and used by the build too.
    const docs = await detectProject(root, { appDir: "sites/docs" });
    expect(docs.workspacePackages).toEqual(["packages/config"]);
  });

  it("records the packages an npm or Yarn workspace member names by their name alone", async () => {
    const root = await tree({
      "package.json": json({ name: "acme", workspaces: ["apps/*", "libs/*"] }),
      "package-lock.json": "{}",
      "apps/web/package.json": json({
        name: "web",
        scripts: { build: "vite build" },
        dependencies: { "@acme/shared": "^1.0.0", vite: "^7.1.0" },
      }),
      "apps/web/index.html": "<!doctype html><title>Web</title>",
      "libs/shared/package.json": json({
        name: "@acme/shared",
        version: "1.0.0",
        dependencies: { "@acme/core": "*" },
      }),
      "libs/core/package.json": json({ name: "@acme/core", version: "1.0.0" }),
    });
    const facts = await detectProject(root, { appDir: "apps/web" });
    expect(facts.workspacePackages).toEqual(["libs/core", "libs/shared"]);
  });

  it("records the packages a dependency names through a workspace: or npm: alias", async () => {
    const root = await tree({
      ...PNPM_WORKSPACE,
      "sites/landing/package.json": json({
        name: "landing",
        scripts: { build: "vite build" },
        dependencies: { ui: "workspace:@acme/ui@*", vite: "^7.1.0" },
        devDependencies: { cfg: "npm:@acme/config@^1.0.0" },
      }),
    });
    const landing = await detectProject(root, { appDir: "sites/landing" });
    expect(landing.workspacePackages).toEqual([
      "packages/config",
      "packages/tokens",
      "packages/ui",
    ]);
  });

  it("records none for an app without workspace packages, outside a workspace or in another ecosystem", async () => {
    const root = await tree(PNPM_WORKSPACE);
    // The root of the workspace uses none of its packages.
    const { facts } = await detectProjectDetails(root, { appDir: "." });
    expect(facts.workspacePackages).toBeUndefined();
    const single = await tree({
      "package.json": json({
        name: "shop",
        scripts: { build: "vite build" },
        dependencies: { "@acme/ui": "^1.0.0", vite: "^7.1.0" },
      }),
      "vendor/ui/package.json": json({ name: "@acme/ui" }),
      "index.html": "<!doctype html><title>Shop</title>",
    });
    expect((await detectProject(single)).workspacePackages).toBeUndefined();
    const python = await tree({
      "pyproject.toml": '[project]\nname = "api"\ndependencies = ["fastapi"]\n',
      "main.py": "from fastapi import FastAPI\napp = FastAPI()\n",
    });
    expect((await detectProject(python)).workspacePackages).toBeUndefined();
  });
});
