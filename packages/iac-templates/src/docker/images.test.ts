import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppBuild, ProjectFacts } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { designProbe } from "../__fixtures__/plans";
import { IMAGES } from "../pins";
import { type DockerAssetOptions, renderDockerAssets } from "./index";

function facts(overrides: Partial<ProjectFacts>): ProjectFacts {
  return {
    name: "app",
    languages: ["javascript"],
    packageManager: "npm",
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
    ...overrides,
  };
}

/** The `express-api` example as detection reports it. */
const expressApi = facts({
  name: "express-api-demo",
  frameworks: [{ name: "express", version: "5.3.0", path: "." }],
  appKind: "api",
  port: 3000,
  build: { startCommand: "npm run start" },
  services: [{ kind: "postgres", evidence: ["package.json: pg"] }],
});
const tsApi = facts({
  languages: ["typescript"],
  frameworks: [{ name: "express", path: "." }],
  appKind: "api",
  build: { buildCommand: "npm run build", startCommand: "node dist/index.js" },
});
const nextApp = facts({
  languages: ["typescript"],
  frameworks: [{ name: "next", path: "." }],
  appKind: "ssr",
  build: { buildCommand: "npm run build" },
  envVars: [
    {
      name: "NEXT_PUBLIC_MAPS_KEY",
      files: ["app/map.tsx"],
      clientExposed: true,
      secretLikely: true,
    },
    {
      name: "NEXT_PUBLIC_SITE_URL",
      files: ["app/page.tsx"],
      clientExposed: true,
      secretLikely: false,
    },
  ],
});
const viteSite = facts({
  frameworks: [{ name: "vite", path: "." }],
  appKind: "static-spa",
  packageManager: "pnpm",
  build: { buildCommand: "pnpm run build", outputDir: "dist" },
});
const fastapi = facts({
  languages: ["python"],
  packageManager: "pip",
  frameworks: [{ name: "fastapi", path: "." }],
  appKind: "api",
  port: 8000,
});

const DIGEST = `sha256:${"ab".repeat(32)}`;

function build(language: AppBuild["runtime"]["language"], version: string): AppBuild {
  return {
    builder: "generated-dockerfile",
    chosen: "auto",
    reason: "OpsCrew's Dockerfile builds it.",
    runtime: { language, version },
    probe: designProbe("generated-dockerfile", language),
  };
}

function dockerfile(sample: ProjectFacts, options: Partial<DockerAssetOptions> = {}): string {
  return (
    renderDockerAssets(sample, { appPort: 3000, healthPath: "/health", ...options })[0]?.content ??
    ""
  );
}

function fromLines(content: string): string[] {
  return content.split("\n").filter((line) => line.startsWith("FROM "));
}

/** The lines of the stage that starts at `FROM … AS <name>` (to the next FROM). */
function stage(content: string, name: string): string[] {
  const lines = content.split("\n");
  const start = lines.findIndex((line) => line.startsWith("FROM ") && line.endsWith(` AS ${name}`));
  expect(start, name).toBeGreaterThanOrEqual(0);
  const end = lines.findIndex((line, i) => i > start && line.startsWith("FROM "));
  return lines.slice(start, end === -1 ? undefined : end);
}

describe("base images", () => {
  it("uses OpsCrew's pinned Node LTS image when the app declares no version", () => {
    for (const sample of [expressApi, tsApi, nextApp]) {
      const content = dockerfile(sample);
      expect(fromLines(content)).toEqual([
        `FROM ${IMAGES.nodeAlpine.ref} AS build`,
        `FROM ${IMAGES.nodeAlpine.ref} AS runtime`,
      ]);
      expect(content).not.toContain("pinned by tag only");
    }
  });

  it("uses the plan's Node major, pinned by the digest the registry lookup finds", () => {
    const asked: string[] = [];
    const content = dockerfile(expressApi, {
      app: { build: build("node", "20") },
      resolveImageDigest: (ref) => {
        asked.push(ref);
        return DIGEST;
      },
    });
    expect(asked).toEqual(["node:20-alpine"]);
    expect(fromLines(content)).toEqual([
      `FROM node:20-alpine@${DIGEST} AS build`,
      `FROM node:20-alpine@${DIGEST} AS runtime`,
    ]);
    expect(content).not.toContain("pinned by tag only");
  });

  it("falls back to the tag, and says so, when the digest cannot be looked up", () => {
    for (const resolveImageDigest of [undefined, () => undefined]) {
      const content = dockerfile(expressApi, {
        app: { build: build("node", "22") },
        ...(resolveImageDigest ? { resolveImageDigest } : {}),
      });
      expect(fromLines(content)).toEqual([
        "FROM node:22-alpine AS build",
        "FROM node:22-alpine AS runtime",
      ]);
      const note = content.split("\n").findIndex((line) => line.includes("pinned by tag only"));
      expect(note).toBeGreaterThan(0);
      expect(note).toBeLessThan(content.split("\n").findIndex((line) => line.startsWith("FROM")));
      expect(content).toContain(
        "# node:22-alpine is pinned by tag only: OpsCrew could not look up its digest.",
      );
    }
  });

  it("refuses a lookup result that is not a digest", () => {
    expect(() =>
      dockerfile(expressApi, {
        app: { build: build("node", "20") },
        resolveImageDigest: () => "latest",
      }),
    ).toThrow(/not a sha256 digest/);
  });

  it("uses the declared version when the plan has no build yet", () => {
    for (const [declared, tag] of [
      ["^22.11.0", "node:22-alpine"],
      ["20.x", "node:20-alpine"],
      ["v24.1.0", IMAGES.nodeAlpine.ref],
      [">=18", IMAGES.nodeAlpine.ref],
    ] as const) {
      const sample = { ...expressApi, runtimeVersions: { node: declared } };
      expect(fromLines(dockerfile(sample))[0], declared).toBe(`FROM ${tag} AS build`);
      // A plan without `app.build` is the same as no plan.
      expect(fromLines(dockerfile(sample, { app: {} }))[0], declared).toBe(`FROM ${tag} AS build`);
    }
    // The plan's version wins over the declared one.
    const planned = dockerfile(
      { ...expressApi, runtimeVersions: { node: "18" } },
      { app: { build: build("node", "24") } },
    );
    expect(fromLines(planned)[0]).toBe(`FROM ${IMAGES.nodeAlpine.ref} AS build`);
  });

  it("uses the declared Python version, else the default, pinned", () => {
    expect(fromLines(dockerfile(fastapi))).toEqual([`FROM ${IMAGES.python.ref}`]);
    const declared = dockerfile({ ...fastapi, runtimeVersions: { python: "3.12.4" } });
    expect(fromLines(declared)).toEqual(["FROM python:3.12-slim"]);
    expect(declared).toContain("# python:3.12-slim is pinned by tag only");
    const planned = dockerfile(fastapi, {
      app: { build: build("python", "3.13") },
      resolveImageDigest: () => DIGEST,
    });
    expect(fromLines(planned)).toEqual([`FROM python:3.13-slim@${DIGEST}`]);
  });

  it("pins the static site's Node build and Caddy runtime images", () => {
    expect(fromLines(dockerfile(viteSite))).toEqual([
      `FROM ${IMAGES.nodeAlpine.ref} AS build`,
      `FROM ${IMAGES.caddy.ref}`,
    ]);
  });
});

describe("production dependencies only", () => {
  it("leaves the development dependencies of express-api out of the runtime stage", () => {
    const content = dockerfile(expressApi);
    const buildStage = stage(content, "build");
    const runtime = stage(content, "runtime");
    // The build stage installs everything, then prunes to production dependencies...
    const install = buildStage.indexOf(
      "RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi",
    );
    const prune = buildStage.indexOf("RUN npm prune --omit=dev");
    expect(install).toBeGreaterThan(0);
    expect(prune).toBeGreaterThan(install);
    expect(buildStage.at(-2)).toBe("RUN npm prune --omit=dev");
    // ... and the runtime stage copies that tree and installs nothing itself.
    expect(runtime).toContain("COPY --from=build --chown=node:node /app ./");
    for (const line of runtime) {
      expect(line).not.toMatch(/\b(?:npm (?:ci|install)|pnpm install|yarn install)\b/);
    }
  });

  it("prunes after the build, so the build still has its development tools", () => {
    const buildStage = stage(dockerfile(tsApi), "build");
    expect(buildStage.indexOf("RUN npm run build")).toBeLessThan(
      buildStage.indexOf("RUN npm prune --omit=dev"),
    );
  });

  it("uses each package manager's production install", () => {
    const pnpm = stage(dockerfile({ ...expressApi, packageManager: "pnpm" }), "build");
    expect(pnpm).toContain(
      "RUN find . -name node_modules -type d -prune -exec rm -rf {} + && if [ -f pnpm-lock.yaml ]; then pnpm install --prod --frozen-lockfile; else pnpm install --prod; fi",
    );
    const yarn = stage(dockerfile({ ...expressApi, packageManager: "yarn" }), "build");
    const yarnInstall = yarn.find((line) => line.includes("--production")) ?? "";
    expect(yarnInstall).toMatch(
      /^RUN if \[ "\$\(yarn --version \| cut -d\. -f1\)" = 1 \]; then if \[ -f yarn\.lock \]; then yarn install --production --frozen-lockfile; else yarn install --production; fi; elif yarn workspaces focus --help > \/dev\/null 2>&1; then yarn workspaces focus --all --production; else echo '[^']+' >&2; exit 1; fi$/,
    );
    // An app in a folder that is not a workspace prunes in that folder.
    const folder = stage(dockerfile({ ...expressApi, appDir: "api" }), "build");
    expect(folder).toContain("RUN cd api && npm prune --omit=dev");
  });

  it("keeps the release command's tool, moving it to the production dependencies", () => {
    const withRelease = (command: string, options: Partial<DockerAssetOptions> = {}) =>
      stage(
        dockerfile({ ...tsApi, build: { ...tsApi.build, releaseCommand: command } }, options),
        "build",
      ).at(-2) ?? "";
    const helper = "RUN node /tmp/opscrew-release-tools.cjs move .";
    expect(withRelease("npx prisma migrate deploy")).toBe(
      `${helper} - prisma && npm prune --omit=dev`,
    );
    expect(withRelease("npx drizzle-kit migrate")).toContain(`${helper} - drizzle-kit &&`);
    expect(withRelease("npx typeorm-ts-node-commonjs migration:run -d src/db.ts")).toContain(
      `${helper} - typeorm ts-node &&`,
    );
    expect(withRelease("cd api && npx knex migrate:latest")).toContain(`${helper} - knex &&`);
    // A package script: the build stage reads it and keeps the tool it runs.
    expect(withRelease("npm run db:migrate")).toBe(
      `${helper} 'db:migrate' && npm prune --omit=dev`,
    );
    expect(withRelease("yarn run migrate")).toContain(`${helper} migrate &&`);
    expect(withRelease("pnpm migrate")).toContain(`${helper} migrate &&`);
    // A command that runs no known tool prunes as usual.
    expect(withRelease("node scripts/migrate.js")).toBe("RUN npm prune --omit=dev");
    // The plan's release command wins over the detected one.
    expect(
      withRelease("npx knex migrate:latest", {
        app: { releaseCommand: "npx prisma migrate deploy" },
      }),
    ).toContain(`${helper} - prisma &&`);
    expect(withRelease("npx knex migrate:latest", { app: {} })).toBe("RUN npm prune --omit=dev");
  });

  it("moves the tool in the root and the app's package.json of a workspace", () => {
    const member = facts({
      ...tsApi,
      monorepo: true,
      appDir: "apps/api",
      packageManager: "pnpm",
      build: { releaseCommand: "cd apps/api && npx prisma migrate deploy" },
    });
    expect(stage(dockerfile(member), "build").at(-2)).toBe(
      "RUN node /tmp/opscrew-release-tools.cjs move apps/api - prisma && find . -name node_modules -type d -prune -exec rm -rf {} + && pnpm install --prod --no-frozen-lockfile",
    );
  });
});

describe("the release tools helper", () => {
  const content = dockerfile({
    ...tsApi,
    build: { ...tsApi.build, releaseCommand: "npx prisma migrate deploy" },
  });
  const lines = content.split("\n");
  const start = lines.indexOf("COPY <<'EOF' /tmp/opscrew-release-tools.cjs");
  const helper = lines.slice(start + 1, lines.indexOf("EOF", start)).join("\n");

  /** Runs the helper in a fresh repository with the given files; returns stdout or the error. */
  async function run(files: Record<string, unknown>, args: string[]) {
    const root = await mkdtemp(join(tmpdir(), "t1204-helper-"));
    try {
      for (const [path, json] of Object.entries(files)) {
        await mkdir(join(root, path, ".."), { recursive: true });
        await writeFile(join(root, path), JSON.stringify(json));
      }
      await writeFile(join(root, "helper.cjs"), helper);
      let output: string;
      try {
        output = execFileSync(process.execPath, ["helper.cjs", ...args], {
          cwd: root,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        output = `failed: ${String((error as { stderr?: string }).stderr)}`;
      }
      const read = async (path: string) => JSON.parse(await readFile(join(root, path), "utf8"));
      const manifests = Object.fromEntries(
        await Promise.all(
          Object.keys(files)
            .filter((path) => !path.includes("node_modules"))
            .map(async (path) => [path, await read(path)]),
        ),
      );
      return { output, manifests };
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  it("is written into the build stage only", () => {
    expect(start).toBeGreaterThan(0);
    expect(start).toBeLessThan(lines.findIndex((line) => line.endsWith(" AS runtime")));
    expect(helper).toContain("const BINS = {");
  });

  it("moves the named packages, and only devDependencies, in the app's and the root package.json", async () => {
    const { manifests } = await run(
      {
        "package.json": { devDependencies: { prisma: "6.19.0", turbo: "2.5.0" } },
        "apps/api/package.json": {
          dependencies: { express: "5.3.0" },
          devDependencies: { prisma: "^6.19.0", typescript: "5.9.3" },
        },
      },
      ["move", "apps/api", "-", "prisma"],
    );
    expect(manifests).toEqual({
      "package.json": { dependencies: { prisma: "6.19.0" }, devDependencies: { turbo: "2.5.0" } },
      // TypeScript stays with the tool, for a TypeScript config or migrations.
      "apps/api/package.json": {
        dependencies: { express: "5.3.0", prisma: "^6.19.0", typescript: "5.9.3" },
        devDependencies: {},
      },
    });
  });

  it("keeps ts-node, tsx and typescript with a tool, only when the app has them", async () => {
    const { manifests } = await run(
      {
        "package.json": {
          devDependencies: { knex: "3.1.0", "ts-node": "10.9.2", tsx: "4.20.0", vitest: "4.0.0" },
        },
      },
      ["move", ".", "-", "knex"],
    );
    expect(manifests["package.json"]).toEqual({
      dependencies: { knex: "3.1.0", "ts-node": "10.9.2", tsx: "4.20.0" },
      devDependencies: { vitest: "4.0.0" },
    });
    // Without a tool nothing moves.
    const none = await run(
      {
        "package.json": {
          scripts: { migrate: "node migrate.js" },
          devDependencies: { tsx: "4.20.0" },
        },
      },
      ["move", ".", "migrate"],
    );
    expect(none.manifests["package.json"].devDependencies).toEqual({ tsx: "4.20.0" });
  });

  it("fails the build when the tool is not in package.json", async () => {
    const missing = await run({ "package.json": { devDependencies: {} } }, [
      "move",
      ".",
      "-",
      "knex",
    ]);
    expect(missing.output).toMatch(/^failed: .*needs knex, which package\.json does not list/s);
  });

  it("finds the tools a package script runs", async () => {
    const { manifests } = await run(
      {
        "package.json": {
          scripts: { "db:migrate": "DEBUG=1 drizzle-kit migrate && npx prisma db seed; node x.js" },
          devDependencies: { "drizzle-kit": "0.31.0", prisma: "6.19.0", vitest: "4.0.0" },
        },
      },
      ["move", ".", "db:migrate"],
    );
    expect(manifests["package.json"]).toEqual({
      scripts: { "db:migrate": "DEBUG=1 drizzle-kit migrate && npx prisma db seed; node x.js" },
      dependencies: { "drizzle-kit": "0.31.0", prisma: "6.19.0" },
      devDependencies: { vitest: "4.0.0" },
    });
    const missing = await run({ "package.json": { scripts: {} } }, ["move", ".", "migrate"]);
    expect(missing.output).toMatch(/^failed: .*has a script migrate/s);
  });

  it("prints the installed version of each tool, from the app folder or the root", async () => {
    const files = {
      "package.json": { scripts: { migrate: "prisma migrate deploy" } },
      "apps/web/package.json": { name: "web" },
      "apps/web/node_modules/prisma/package.json": { version: "6.19.0" },
      "node_modules/drizzle-kit/package.json": { version: "0.31.4" },
    };
    expect((await run(files, ["versions", "apps/web", "-", "prisma", "drizzle-kit"])).output).toBe(
      "prisma@6.19.0 drizzle-kit@0.31.4\n",
    );
    expect((await run(files, ["versions", "apps/web", "migrate"])).output).toBe("prisma@6.19.0\n");
    // Installed TypeScript runners come along; absent ones are skipped.
    const withTypeScript = {
      ...files,
      "node_modules/typescript/package.json": { version: "5.9.3" },
      "apps/web/node_modules/tsx/package.json": { version: "4.20.0" },
    };
    expect((await run(withTypeScript, ["versions", "apps/web", "-", "prisma"])).output).toBe(
      "prisma@6.19.0 tsx@4.20.0 typescript@5.9.3\n",
    );
    expect((await run(files, ["versions", ".", "-", "knex"])).output).toMatch(
      /^failed: .*needs knex, which is not installed/s,
    );
  });
});

describe("Next.js with a release command", () => {
  /** The `nextjs-postgres` example with Prisma migrations. */
  const nextPrisma = facts({
    ...nextApp,
    name: "nextjs-postgres",
    envVars: [],
    build: { buildCommand: "npm run build", releaseCommand: "npx prisma migrate deploy" },
    services: [{ kind: "postgres", evidence: ["package.json: @prisma/client"] }],
  });

  it("keeps the migration tool and the app's files in the standalone image", () => {
    const content = dockerfile(nextPrisma);
    expect(content).toMatchSnapshot();
    const buildStage = stage(content, "build");
    expect(buildStage).toContain(
      'RUN tools="$(node /tmp/opscrew-release-tools.cjs versions . - prisma)" \\',
    );
    // Installed on its own, with its install scripts (Prisma's engines); the standalone files are
    // copied over it and the result replaces /out/node_modules.
    expect(content).toContain("npm install --no-audit --no-fund $tools \\");
    expect(content).not.toContain("--ignore-scripts");
    expect(buildStage).toContain(
      "    && cp -a /out/node_modules/. node_modules/ && rm -rf /out/node_modules \\",
    );
    expect(buildStage).toContain("    && mv node_modules /out/node_modules; fi \\");
    expect(content).not.toContain("cp -an node_modules");
    // A tool missing from the image fails the build: npx never downloads one at deploy.
    expect(buildStage).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a shell parameter expansion.
      '  && for tool in $tools; do name="${tool%@*}"; [ -f "/out/node_modules/$name/package.json" ] \\',
    );
    expect(buildStage).toContain(
      '    || { echo "The image lacks $name, which the release command runs." >&2; exit 1; }; done \\',
    );
    expect(buildStage).toContain(
      "  && find . -mindepth 1 -maxdepth 1 ! -name node_modules ! -name .next -exec cp -an {} /out/ \\;",
    );
    // The runtime stage still copies only /out.
    expect(stage(content, "runtime").filter((line) => line.startsWith("COPY"))).toEqual([
      "COPY --from=build --chown=node:node /out ./",
    ]);
  });

  it("copies the app folder of a monorepo app where its release command changes into", () => {
    const member = facts({
      ...nextPrisma,
      monorepo: true,
      appDir: "apps/web",
      packageManager: "pnpm",
      build: { releaseCommand: "cd apps/web && npm run db:migrate" },
    });
    const buildStage = stage(dockerfile(member), "build");
    expect(buildStage).toContain(
      `RUN tools="$(node /tmp/opscrew-release-tools.cjs versions apps/web 'db:migrate')" \\`,
    );
    expect(buildStage).toContain("  && mkdir -p /out/apps/web && cd /app/apps/web \\");
  });

  it("adds nothing without a release command that runs a tool", () => {
    // The runtime stage has npm only: no corepack, Bun or workspace root for other scripts.
    for (const releaseCommand of [
      undefined,
      "node scripts/migrate.js",
      "pnpm run migrate",
      "yarn migrate",
      "bun run migrate",
    ]) {
      const content = dockerfile({
        ...nextPrisma,
        build: { buildCommand: "npm run build", ...(releaseCommand ? { releaseCommand } : {}) },
      });
      expect(content).not.toContain("opscrew-release-tools");
    }
  });
});

describe("build values", () => {
  it("mounts secret build values as BuildKit secrets and keeps the others as ARG", () => {
    const content = dockerfile(nextApp);
    const lines = content.split("\n");
    expect(lines).toContain("ARG NEXT_PUBLIC_SITE_URL");
    expect(content).not.toContain("ARG NEXT_PUBLIC_MAPS_KEY");
    expect(content).not.toContain("ENV NEXT_PUBLIC_MAPS_KEY");
    expect(lines).toContain(
      "RUN --mount=type=secret,id=NEXT_PUBLIC_MAPS_KEY,env=NEXT_PUBLIC_MAPS_KEY npm run build && mkdir -p public",
    );
  });

  it("mounts secrets on the build command of every Node template", () => {
    const secret = {
      name: "VITE_TILES_TOKEN",
      files: ["src/map.ts"],
      clientExposed: true,
      secretLikely: true,
    };
    const site = dockerfile({ ...viteSite, envVars: [secret] }).split("\n");
    expect(site).toContain(
      "RUN --mount=type=secret,id=VITE_TILES_TOKEN,env=VITE_TILES_TOKEN pnpm run build",
    );
    const server = dockerfile({ ...tsApi, envVars: [secret] }).split("\n");
    expect(server).toContain(
      "RUN --mount=type=secret,id=VITE_TILES_TOKEN,env=VITE_TILES_TOKEN npm run build",
    );
  });
});
