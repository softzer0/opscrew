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
    const node = await tree({
      "package.json": JSON.stringify({
        name: "n",
        dependencies: {
          express: "^5",
          "bee-queue": "^1",
          agenda: "^5",
          "@temporalio/worker": "^1",
        },
      }),
    });
    const python = await tree({ "requirements.txt": "flask==3.1.0\ndramatiq\nhuey\narq\n" });
    const evidence = async (root: string, kind: string) =>
      (await detectProject(root)).services.find((s) => s.kind === kind)?.evidence.toSorted();
    // Every background-job library shows as a queue, so OpsCrew can say it is not deployed (FR-812).
    expect(await evidence(node, "queue")).toEqual([
      "dependency:@temporalio/worker",
      "dependency:agenda",
      "dependency:bee-queue",
    ]);
    expect(await evidence(node, "redis")).toEqual(["dependency:bee-queue"]);
    expect(await evidence(node, "mongodb")).toEqual(["dependency:agenda"]);
    expect(await evidence(python, "queue")).toEqual([
      "dependency:arq",
      "dependency:dramatiq",
      "dependency:huey",
    ]);
    expect(await evidence(python, "redis")).toEqual(["dependency:arq"]);
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

  it("records a default only when every read in the code has one", async () => {
    const root = await tree({
      "requirements.txt": "Django==5.1\n",
      "mysite/settings.py": [
        'SECRET_KEY = os.environ["DJANGO_SECRET_KEY"]',
        'DEBUG = os.environ.get("DJANGO_DEBUG") == "1"',
        'ALLOWED_HOSTS = os.environ.get("DJANGO_ALLOWED_HOSTS", "localhost").split(",")',
        'LEVEL = os.environ.get("LOG_LEVEL", "info")',
      ].join("\n"),
      "mysite/logs.py": 'LEVEL = os.environ["LOG_LEVEL"]\n',
      ".env.example": "DJANGO_DEBUG=\nSENTRY_DSN=\n",
    });
    const defaults = Object.fromEntries(
      (await detectProject(root)).envVars.map((v) => [v.name, v.hasDefault ?? false]),
    );
    expect(defaults).toEqual({
      DJANGO_ALLOWED_HOSTS: true,
      // Also listed in .env.example; the code's default still counts.
      DJANGO_DEBUG: true,
      DJANGO_SECRET_KEY: false,
      // Read with a default in one file and without one in another.
      LOG_LEVEL: false,
      // Only in .env.example: required.
      SENTRY_DSN: false,
    });
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

describe("production start command", () => {
  const nest = (scripts: Record<string, string>) =>
    tree({
      "package.json": JSON.stringify({
        name: "api",
        scripts,
        dependencies: { "@nestjs/core": "^11", "@nestjs/common": "^11" },
      }),
      "package-lock.json": "{}",
      "src/main.ts": "bootstrap();",
      "src/app.controller.ts":
        '@Controller()\nexport class AppController {\n  @Get("health")\n  health() {}\n}',
    });

  it("prefers start:prod and finds the decorator health route (NestJS)", async () => {
    const root = await nest({
      build: "nest build",
      start: "nest start",
      "start:prod": "node dist/main",
    });
    const facts = await detectProject(root);
    expect(facts.build.startCommand).toBe("npm run start:prod");
    expect(facts.healthEndpoint).toBe("/health");
  });

  it("runs the built entry point when start recompiles and there is no start:prod", async () => {
    const root = await nest({ build: "nest build", start: "nest start" });
    expect((await detectProject(root)).build.startCommand).toBe("node dist/main");
  });

  it("uses main when start runs a TypeScript runner or watcher", async () => {
    for (const start of [
      "ts-node src/index.ts",
      "tsx src/index.ts",
      "nodemon src/index.js",
      "ts-node-dev src/index.ts",
      "node --watch src/index.js",
    ]) {
      const root = await tree({
        "package.json": JSON.stringify({
          name: "svc",
          main: "dist/index.js",
          scripts: { build: "tsc", start },
          dependencies: { express: "^5" },
        }),
      });
      expect((await detectProject(root)).build.startCommand).toBe("node dist/index.js");
    }
  });

  it("keeps start when no built entry point can be inferred", async () => {
    const root = await tree({
      "package.json": JSON.stringify({
        name: "svc",
        main: "src/index.ts",
        scripts: { start: "tsx src/index.ts" },
        dependencies: { express: "^5" },
      }),
    });
    expect((await detectProject(root)).build.startCommand).toBe("npm start");
  });

  it("starts a SvelteKit app built with adapter-node and finds its +server health route", async () => {
    const root = await tree({
      "package.json": JSON.stringify({
        name: "kit",
        type: "module",
        scripts: { build: "vite build", dev: "vite dev" },
        devDependencies: {
          "@sveltejs/adapter-node": "6.0.0",
          "@sveltejs/kit": "3.0.1",
          svelte: "5.57.2",
          vite: "8.3.4",
        },
      }),
      "src/routes/+page.svelte": "<h1>Hi</h1>",
      "src/routes/health/+server.ts":
        "import { json } from '@sveltejs/kit';\nexport const GET = () => json({ status: 'ok' });",
    });
    const facts = await detectProject(root);
    expect(facts.appKind).toBe("ssr");
    expect(facts.port).toBe(3000);
    expect(facts.build.startCommand).toBe("node build");
    expect(facts.healthEndpoint).toBe("/health");
  });

  it("starts a standalone Astro server and finds its endpoint health route", async () => {
    const root = await tree({
      "package.json": JSON.stringify({
        name: "astro-ssr",
        type: "module",
        scripts: { build: "astro build", dev: "astro dev" },
        dependencies: { "@astrojs/node": "11.1.7", astro: "7.3.8" },
      }),
      "astro.config.mjs":
        "import node from '@astrojs/node';\nexport default defineConfig({ output: 'server', adapter: node({ mode: 'standalone' }) });",
      "src/pages/index.astro": "<h1>Hi</h1>",
      "src/pages/health.ts": "export const GET = () => Response.json({ status: 'ok' });",
    });
    const facts = await detectProject(root);
    expect(facts.appKind).toBe("ssr");
    expect(facts.build.startCommand).toBe("node ./dist/server/entry.mjs");
    expect(facts.healthEndpoint).toBe("/health");
  });

  it("does not start an Astro node adapter in middleware mode on its own", async () => {
    const root = await tree({
      "package.json": JSON.stringify({
        name: "astro-mw",
        dependencies: { "@astrojs/node": "11.1.7", astro: "7.3.8" },
      }),
      "astro.config.mjs": "export default defineConfig({ adapter: node({ mode: 'middleware' }) });",
    });
    expect((await detectProject(root)).build.startCommand).toBeUndefined();
  });

  it("detects React Router framework mode as SSR on port 3000 with its serve script", async () => {
    const root = await tree({
      "package.json": JSON.stringify({
        name: "rr",
        type: "module",
        scripts: {
          build: "react-router build",
          dev: "react-router dev",
          start: "react-router-serve ./build/server/index.js",
        },
        dependencies: {
          "@react-router/node": "8.4.0",
          "@react-router/serve": "8.4.0",
          react: "19.3.0",
          "react-dom": "19.3.0",
          "react-router": "8.4.0",
        },
        devDependencies: { "@react-router/dev": "8.4.0", vite: "8.3.4" },
      }),
      "app/routes.ts":
        'import { index, route } from "@react-router/dev/routes";\nexport default [index("routes/home.tsx"), route("health", "routes/health.ts")];',
      "app/routes/health.ts": "export function loader() { return Response.json({}); }",
    });
    const facts = await detectProject(root);
    expect(facts.appKind).toBe("ssr");
    expect(facts.port).toBe(3000);
    expect(facts.frameworks.map((f) => f.name)).toEqual(["react", "react-router", "vite"]);
    expect(facts.build.startCommand).toBe("npm start");
    expect(facts.healthEndpoint).toBe("/health");
  });

  it("treats react-router with @react-router/node as framework mode", async () => {
    const root = await tree({
      "package.json": JSON.stringify({
        name: "rr",
        dependencies: { "@react-router/node": "8", react: "19", "react-router": "8" },
      }),
    });
    expect((await detectProject(root)).appKind).toBe("ssr");
  });

  it("keeps a library-mode react-router SPA static", async () => {
    const root = await tree({
      "package.json": JSON.stringify({
        name: "spa",
        dependencies: { react: "19", "react-router": "8" },
        devDependencies: { vite: "8" },
      }),
    });
    expect((await detectProject(root)).appKind).toBe("static-spa");
  });

  it("keeps an ordinary start script", async () => {
    const root = await tree({
      "package.json": JSON.stringify({
        name: "svc",
        main: "dist/index.js",
        scripts: { start: "node server.js" },
        dependencies: { express: "^5" },
      }),
    });
    expect((await detectProject(root)).build.startCommand).toBe("npm start");
  });
});
