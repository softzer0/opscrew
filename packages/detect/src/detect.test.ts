import { randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectFactsSchema } from "@opscrew/plan-schema";
import { afterEach, describe, expect, it } from "vitest";
import { detectProject, detectProjectDetails } from "./index";
import { makeTree, removeTree } from "./test-helpers";

const FIXTURES = fileURLToPath(new URL("../test/fixtures/", import.meta.url));
const FIXTURE_NAMES = [
  "base44",
  "bolt-vite",
  "django-postgres",
  "express-api",
  "fastapi-redis",
  "lovable-vite-supabase",
  "monorepo-turbo",
  "monorepo-two-apps",
  "nextjs-prisma-postgres",
  "nextjs-static-export",
  "python-requirements",
  "replit-express",
  "static-vite",
  "v0-next",
];

const roots: string[] = [];
async function tree(files: Record<string, string>): Promise<string> {
  const root = await makeTree(files, "project");
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeTree));
});

describe("fixture repositories", () => {
  it("has exactly the expected fixture set", async () => {
    const entries = await readdir(FIXTURES, { withFileTypes: true });
    expect(
      entries
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort(),
    ).toEqual(FIXTURE_NAMES);
  });

  it.each(FIXTURE_NAMES)("%s matches expected.json", async (name) => {
    const expected = JSON.parse(await readFile(join(FIXTURES, name, "expected.json"), "utf8"));
    const facts = await detectProject(join(FIXTURES, name));
    expect(ProjectFactsSchema.parse(facts)).toEqual(facts);
    expect(facts).toMatchObject(expected);
  });

  it("is deterministic", async () => {
    const root = join(FIXTURES, "nextjs-prisma-postgres");
    expect(await detectProject(root)).toEqual(await detectProject(root));
  });
});

describe("detectProject scenarios", () => {
  it("never puts a remote-URL token into the facts", async () => {
    const token = `tok${randomBytes(12).toString("hex")}`;
    const root = await tree({
      ".git/config": `[remote "origin"]\r\n\turl = https://x-access-token:${token}@github.com/acme/shop.git\r\n`,
      ".git/HEAD": "ref: refs/heads/main\n",
      "package.json": JSON.stringify({ name: "shop", dependencies: { express: "^4" } }),
    });
    const facts = await detectProject(root);
    expect(facts.git).toEqual({
      remoteUrl: "https://github.com/acme/shop.git",
      owner: "acme",
      repo: "shop",
      currentBranch: "main",
    });
    expect(JSON.stringify(facts)).not.toContain(token);
  });

  it("describes the root and lists candidates when a monorepo has several apps", async () => {
    const root = await tree({
      "package.json": JSON.stringify({ name: "mono", workspaces: ["apps/*"] }),
      "apps/api/package.json": JSON.stringify({
        name: "api",
        scripts: { start: "node index.js" },
        dependencies: { express: "^4" },
      }),
      "apps/web/package.json": JSON.stringify({
        name: "web",
        scripts: { start: "next start" },
        dependencies: { next: "^15", react: "^19" },
      }),
    });
    const result = await detectProjectDetails(root);
    expect(result.appDir).toBe(".");
    expect(result.appCandidates).toEqual(["apps/api", "apps/web"]);
    expect(result.facts).toMatchObject({
      name: "mono",
      monorepo: true,
      appKind: "unknown",
      frameworks: [
        { name: "express", path: "apps/api" },
        { name: "next", path: "apps/web" },
        { name: "react", path: "apps/web" },
      ],
    });
    expect(result.facts.port).toBeUndefined();
  });

  it("handles a repository with no manifests", async () => {
    const root = await tree({ "notes.txt": "hello" });
    const result = await detectProjectDetails(root);
    expect(result.facts).toEqual({
      name: basename(root),
      languages: [],
      packageManager: "none",
      frameworks: [],
      appKind: "unknown",
      platformExport: { platform: "none", evidence: [] },
      build: {},
      runtimeVersions: {},
      envVars: [],
      services: [],
      docker: {},
      monorepo: false,
      appDir: ".",
      git: {},
    });
    expect(result.truncated).toBe(false);
  });

  it("reports truncation when maxFiles is reached", async () => {
    const root = await tree({ "a.js": "", "b.js": "", "c.js": "" });
    expect((await detectProjectDetails(root, { maxFiles: 2 })).truncated).toBe(true);
  });

  it.each([
    [{ express: "^4", vite: "^5", react: "^18" }, "fullstack"],
    [{ bullmq: "^5" }, "worker"],
    [{ astro: "^5", "@astrojs/node": "^9" }, "ssr"],
    [{ astro: "^5" }, "static-spa"],
    [{ "react-scripts": "5.0.1", react: "^18" }, "static-spa"],
    [{ "@sveltejs/kit": "^2", svelte: "^5" }, "ssr"],
    [{ lodash: "^4" }, "unknown"],
  ])("maps %j to %s", async (dependencies, appKind) => {
    const root = await tree({ "package.json": JSON.stringify({ name: "x", dependencies }) });
    expect((await detectProject(root)).appKind).toBe(appKind);
  });

  it("adds queue + redis for BullMQ and uses build output dirs", async () => {
    const worker = await tree({
      "package.json": JSON.stringify({ name: "w", dependencies: { bullmq: "^5" } }),
    });
    expect((await detectProject(worker)).services).toEqual([
      { kind: "queue", evidence: ["dependency:bullmq"] },
      { kind: "redis", evidence: ["dependency:bullmq"] },
    ]);
    const cra = await tree({
      "package.json": JSON.stringify({
        name: "c",
        scripts: { build: "react-scripts build" },
        dependencies: { "react-scripts": "5.0.1", react: "^18" },
      }),
    });
    expect((await detectProject(cra)).build.outputDir).toBe("build");
  });

  it("treats Django REST framework without templates as an API", async () => {
    const root = await tree({
      "requirements.txt": "Django==5.1\ndjangorestframework==3.15\n",
      "manage.py": "",
      "proj/wsgi.py": "from django.core.wsgi import get_wsgi_application\n",
    });
    const facts = await detectProject(root);
    expect(facts.appKind).toBe("api");
    expect(facts.build.startCommand).toBe("gunicorn proj.wsgi:application --bind 0.0.0.0:8000");
  });

  it("uses the Angular output path", async () => {
    const root = await tree({
      "package.json": JSON.stringify({ name: "ng", dependencies: { "@angular/core": "^19" } }),
      "angular.json": JSON.stringify({
        projects: {
          shop: {
            architect: {
              build: {
                builder: "@angular/build:application",
                options: { outputPath: "dist/shop" },
              },
            },
          },
        },
      }),
    });
    expect((await detectProject(root)).build.outputDir).toBe("dist/shop/browser");
  });

  it("marks client-exposed secret names as secret-likely and reads CRLF .env.example", async () => {
    const root = await tree({
      "package.json": JSON.stringify({ name: "x", devDependencies: { vite: "^5" } }),
      ".env.example": "VITE_SUPABASE_SERVICE_ROLE_KEY=\r\nVITE_SUPABASE_URL=\r\n",
    });
    expect((await detectProject(root)).envVars).toEqual([
      {
        name: "VITE_SUPABASE_SERVICE_ROLE_KEY",
        files: [".env.example"],
        clientExposed: true,
        secretLikely: true,
      },
      {
        name: "VITE_SUPABASE_URL",
        files: [".env.example"],
        clientExposed: true,
        secretLikely: false,
      },
    ]);
  });

  it("breaks platform ties in the documented order", async () => {
    const root = await tree({
      ".bolt/prompt": "x",
      "package.json": JSON.stringify({ name: "x", devDependencies: { "lovable-tagger": "^1" } }),
    });
    expect((await detectProject(root)).platformExport).toEqual({
      platform: "lovable",
      evidence: ["devDependency:lovable-tagger"],
    });
  });

  it("does not read gitignored files", async () => {
    const root = await tree({
      ".gitignore": "generated/\n",
      "package.json": JSON.stringify({ name: "x", dependencies: { express: "^4" } }),
      "generated/client.js": "process.env.HIDDEN_VAR",
      "index.js": "process.env.SHOWN_VAR",
    });
    expect((await detectProject(root)).envVars.map((v) => v.name)).toEqual(["SHOWN_VAR"]);
  });

  it("finds an app in a subdirectory and runs its commands there", async () => {
    const root = await tree({
      "backend/requirements.txt": "fastapi\nuvicorn\n",
      "backend/main.py": "from fastapi import FastAPI\napp = FastAPI()\n",
    });
    const result = await detectProjectDetails(root);
    expect(result.appDir).toBe("backend");
    expect(result.facts.appDir).toBe("backend");
    expect(result.facts.build).toEqual({
      installCommand: "cd backend && pip install -r requirements.txt",
      startCommand: "cd backend && uvicorn main:app --host 0.0.0.0 --port 8000",
    });
    expect(result.facts.frameworks).toEqual([{ name: "fastapi", path: "backend" }]);
  });
});
