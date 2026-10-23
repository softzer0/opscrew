import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectFacts } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { designProbe } from "../__fixtures__/plans";
import {
  IMAGES,
  PACKAGE_MANAGERS,
  type PinArch,
  PYPI_PACKAGES,
  TOOLS,
  toolDownloadUrl,
} from "../pins";
import {
  containerPort,
  detectStack,
  imageReleaseCommand,
  isClientExposedEnvName,
  releaseCommandInImage,
  renderDockerAssets,
} from "./index";

function facts(overrides: Partial<ProjectFacts>): ProjectFacts {
  return {
    name: "app",
    languages: ["typescript"],
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

const nextApp = facts({
  frameworks: [
    { name: "next", version: "16.4.0", path: "." },
    { name: "react", path: "." },
  ],
  appKind: "ssr",
  port: 3000,
  build: { buildCommand: "npm run build", startCommand: "npm run start" },
  envVars: [
    { name: "DATABASE_URL", files: ["lib/db.ts"], clientExposed: false, secretLikely: true },
    {
      name: "NEXT_PUBLIC_SITE_URL",
      files: ["app/page.tsx"],
      clientExposed: true,
      secretLikely: false,
    },
  ],
});
const viteApp = facts({
  frameworks: [
    { name: "react", path: "." },
    { name: "vite", path: "." },
  ],
  appKind: "static-spa",
  packageManager: "pnpm",
  build: { buildCommand: "pnpm run build", outputDir: "dist" },
  envVars: [
    {
      name: "VITE_SUPABASE_URL",
      files: ["src/client.ts"],
      clientExposed: true,
      secretLikely: false,
    },
  ],
});
const expressApp = facts({
  frameworks: [{ name: "express", path: "." }],
  appKind: "api",
  packageManager: "yarn",
  port: 4000,
  build: { startCommand: "node server.js" },
});
const fastapiApp = facts({
  languages: ["python"],
  packageManager: "pip",
  frameworks: [{ name: "fastapi", path: "." }],
  appKind: "api",
  port: 8000,
  build: { startCommand: "uvicorn app.main:api --reload" },
  runtimeVersions: { python: "3.12" },
});
const djangoApp = facts({
  languages: ["python"],
  packageManager: "poetry",
  frameworks: [{ name: "django", path: "." }],
  appKind: "fullstack",
  port: 8000,
  name: "shop-site",
});
const pythonApp = facts({ languages: ["python"], packageManager: "uv", appKind: "worker" });
/** The detect `monorepo-turbo` fixture: one Next.js app in `apps/web` of a pnpm workspace. */
const nextMonorepoApp = facts({
  name: "acme",
  packageManager: "pnpm",
  frameworks: [
    { name: "next", version: "^15.1.3", path: "apps/web" },
    { name: "react", version: "^19.0.0", path: "apps/web" },
  ],
  appKind: "ssr",
  port: 4000,
  build: {
    installCommand: "pnpm install --frozen-lockfile",
    buildCommand: "pnpm --filter web run build",
    startCommand: "pnpm --filter web start",
  },
  envVars: [
    {
      name: "NEXT_PUBLIC_SUPABASE_URL",
      files: ["apps/web/app/page.tsx"],
      clientExposed: true,
      secretLikely: false,
    },
  ],
  monorepo: true,
  appDir: "apps/web",
});

const ALL = { nextApp, viteApp, expressApp, fastapiApp, djangoApp, pythonApp, nextMonorepoApp };

/** An Express API in `apps/api` of an npm workspace, without detected commands. */
const npmWorkspaceApi = facts({
  name: "acme",
  packageManager: "npm",
  frameworks: [{ name: "express", path: "apps/api" }],
  appKind: "api",
  port: 4000,
  monorepo: true,
  appDir: "apps/api",
});
/** A Vite site in `apps/site` of a pnpm workspace, without detected commands. */
const pnpmWorkspaceSite = facts({
  name: "acme",
  packageManager: "pnpm",
  frameworks: [
    { name: "react", path: "apps/site" },
    { name: "vite", path: "apps/site" },
  ],
  appKind: "static-spa",
  envVars: [
    {
      name: "VITE_API_URL",
      files: ["apps/site/src/api.ts"],
      clientExposed: true,
      secretLikely: false,
    },
  ],
  monorepo: true,
  appDir: "apps/site",
});
/** A FastAPI service in `services/api`, with the start command detect writes for a subfolder. */
const pythonSubfolderApi = facts({
  name: "platform",
  languages: ["python"],
  packageManager: "pip",
  frameworks: [{ name: "fastapi", path: "services/api" }],
  appKind: "api",
  port: 8000,
  build: {
    installCommand: "cd services/api && pip install -r requirements.txt",
    startCommand: "cd services/api && uvicorn app.main:app --host 0.0.0.0 --port 8000",
  },
  appDir: "services/api",
});

const SUBFOLDER = { npmWorkspaceApi, pnpmWorkspaceSite, pythonSubfolderApi };

function dockerfileOf(sample: ProjectFacts, appPort = sample.port ?? 3000): string {
  return renderDockerAssets(sample, { appPort, healthPath: "/health" })[0]?.content ?? "";
}

function withReleaseOf(sample: ProjectFacts, releaseCommand: string) {
  return imageReleaseCommand({ ...sample, build: { ...sample.build, releaseCommand } });
}

describe("detectStack", () => {
  it("maps each sample to its recipe", () => {
    expect(detectStack(nextApp)).toBe("next-standalone");
    expect(detectStack(viteApp)).toBe("static-spa");
    expect(detectStack(expressApp)).toBe("node-server");
    expect(detectStack(fastapiApp)).toBe("python-fastapi");
    expect(detectStack(djangoApp)).toBe("python-django");
    expect(detectStack(pythonApp)).toBe("python-generic");
    expect(detectStack(facts({ languages: ["go"] }))).toBeUndefined();
  });

  it("runs the release command from the image's working folder", () => {
    const release = (sample: ProjectFacts, releaseCommand?: string) =>
      releaseCommandInImage({
        ...sample,
        build: releaseCommand ? { ...sample.build, releaseCommand } : sample.build,
      });
    expect(release(djangoApp)).toBeUndefined();
    expect(release(djangoApp, "python manage.py migrate --noinput")).toBe(
      "python manage.py migrate --noinput",
    );
    // A Python image holds only the app folder, so the folder prefix goes.
    expect(release(pythonSubfolderApi, "cd services/api && alembic upgrade head")).toBe(
      "alembic upgrade head",
    );
    expect(release(pythonSubfolderApi, "cd services/api/db && alembic upgrade head")).toBe(
      "cd db && alembic upgrade head",
    );
    expect(release(pythonSubfolderApi, "./migrate.sh")).toBe("./migrate.sh");
    // A Node.js image holds the whole repository, so the command runs as detected.
    expect(release(npmWorkspaceApi, "cd apps/api && npx prisma migrate deploy")).toBe(
      "cd apps/api && npx prisma migrate deploy",
    );
    // A static site has no app container to run it in.
    expect(release(viteApp, "echo never")).toBeUndefined();
  });

  it("leaves out what the Next.js standalone image cannot run, saying why", () => {
    const withRelease = (sample: ProjectFacts, releaseCommand: string) => ({
      ...sample,
      build: { ...sample.build, releaseCommand },
    });
    // The image keeps Prisma (FR-1204).
    expect(imageReleaseCommand(withRelease(nextApp, "npx prisma migrate deploy"))).toEqual({
      command: "npx prisma migrate deploy",
    });
    const monorepo = imageReleaseCommand(
      withRelease(nextMonorepoApp, "cd apps/web && node scripts/migrate.js"),
    );
    expect(monorepo.command).toBeUndefined();
    expect(monorepo.notRun).toContain("apps/web");
    expect(imageReleaseCommand(withRelease(nextApp, "node scripts/migrate.js"))).toEqual({
      command: "node scripts/migrate.js",
    });
    expect(imageReleaseCommand(nextApp)).toEqual({});
  });

  it("names the plan of the app whose release command it leaves out, a further app's its own", () => {
    const withRelease = (sample: ProjectFacts, releaseCommand: string) => ({
      ...sample,
      build: { ...sample.build, releaseCommand },
    });
    for (const facts of [
      withRelease(expressApp, "alembic upgrade head"),
      withRelease(nextApp, "npx keystone migrate deploy"),
      withRelease(nextMonorepoApp, "cd apps/web && node scripts/migrate.js"),
    ]) {
      expect(imageReleaseCommand(facts).notRun).toContain(
        "`app.releaseCommand` in opscrew/plan.yaml",
      );
      const further = imageReleaseCommand(facts, "docs").notRun;
      expect(further).toContain("`app.releaseCommand` in opscrew/apps/docs/plan.yaml");
      expect(further).not.toContain("opscrew/plan.yaml");
    }
  });

  it("knows which images keep which migration tools", () => {
    const withRelease = withReleaseOf;
    // The Node.js server image keeps the packages of the migration tool, and package scripts.
    for (const command of [
      "npx drizzle-kit migrate",
      "npx typeorm migration:run -d dist/data-source.js",
      "npx knex migrate:latest",
      "cd build && node ace migration:run --force",
      "npm run db:migrate",
    ]) {
      expect(withRelease(expressApp, command)).toEqual({ command });
    }
    // The Next.js standalone image gets the tool of the command or its package script, too ...
    for (const command of [
      "npx drizzle-kit migrate",
      "npx payload migrate",
      "npm run migrate",
      "cd apps/web && npx prisma migrate deploy",
    ]) {
      expect(withRelease(nextApp, command)).toEqual({ command });
    }
    // ... but not a tool OpsCrew does not install there, nor a script npm does not run (the
    // runtime has no corepack, Bun or workspace root).
    for (const [command, found] of [
      ["npx keystone migrate deploy", "KeystoneJS migrations"],
      ["node ace migration:run --force", "AdonisJS migrations"],
      ["pnpm run migrate", "a migration script in package.json"],
      ["yarn workspace web migrate", "a migration script in package.json"],
      ["bun run migrate", "a migration script in package.json"],
    ] as const) {
      const result = withRelease(nextApp, command);
      expect(result.command).toBeUndefined();
      expect(result.notRun).toContain(found);
      expect(result.notRun).toContain("Next.js standalone image");
      expect(result.notRun).toContain("app.releaseCommand");
    }
    // Python images run Python tools, from the app folder.
    expect(withRelease(pythonSubfolderApi, "cd services/api && aerich upgrade")).toEqual({
      command: "aerich upgrade",
    });
    expect(
      withRelease(
        fastapiApp,
        'pw_migrate migrate --database "$DATABASE_URL" --directory migrations',
      ),
    ).toEqual({ command: 'pw_migrate migrate --database "$DATABASE_URL" --directory migrations' });
    expect(withRelease(djangoApp, "FLASK_APP='app:create_app()' flask db upgrade")).toEqual({
      command: "FLASK_APP='app:create_app()' flask db upgrade",
    });
    // A Node.js tool cannot run in a Python image, nor a Python one in a Node.js image.
    const node = withRelease(fastapiApp, "npx prisma migrate deploy");
    expect(node.command).toBeUndefined();
    expect(node.notRun).toContain("Python image");
    expect(withRelease(expressApp, "alembic upgrade head").notRun).toContain("Node.js image");
  });

  it("leaves out the commands of stacks OpsCrew cannot build yet", () => {
    // A Rails app with a package.json is built as a Node.js server today.
    for (const command of [
      "bin/rails db:migrate",
      "php artisan migrate --force",
      'goose -dir db/migrations postgres "$DATABASE_URL" up',
      "diesel migration run",
      'bin/my_app eval "MyApp.Release.migrate"',
      "dotnet ef database update",
    ]) {
      const result = withReleaseOf(expressApp, command);
      expect(result.command).toBeUndefined();
      expect(result.notRun).toContain(`\`${command}\``);
    }
    // Without an image recipe there is nothing to plan.
    expect(
      imageReleaseCommand(
        facts({ languages: ["go"], build: { releaseCommand: "sqlx migrate run" } }),
      ),
    ).toEqual({});
  });

  it("tells a Django app whose migrations OpsCrew runs where the command lives", () => {
    const migrated = renderDockerAssets(
      { ...djangoApp, build: { releaseCommand: "python manage.py migrate --noinput" } },
      { appPort: 8000, healthPath: "/health" },
    )[0]?.content;
    expect(migrated).toContain("app.releaseCommand in opscrew/plan.yaml");
    expect(migrated).not.toContain("as part of your release process");
  });

  it("serves static sites on 8080", () => {
    expect(containerPort("static-spa", 3000)).toBe(8080);
    expect(containerPort("node-server", 4000)).toBe(4000);
  });
});

describe("renderDockerAssets", () => {
  for (const [name, sample] of Object.entries(ALL)) {
    it(`renders ${name}`, () => {
      const files = renderDockerAssets(sample, {
        appPort: sample.port ?? 3000,
        healthPath: "/health",
      });
      // An app in a monorepo folder has its Dockerfile there.
      const dockerfilePath = sample === nextMonorepoApp ? "apps/web/Dockerfile" : "Dockerfile";
      expect(files.map((f) => f.path)).toEqual([dockerfilePath, ".dockerignore", ".env.example"]);
      const dockerfile = files[0]?.content ?? "";
      expect(dockerfile).toMatchSnapshot();
      // Every image ends with a non-root user before it starts.
      const user = dockerfile.match(/^USER (\S+)$/gm)?.at(-1);
      expect(user).toBeDefined();
      expect(user).not.toBe("USER root");
      expect(dockerfile).not.toMatch(/:latest\b/);
      for (const file of files) expect(file.content.endsWith("\n")).toBe(true);
    });
  }

  it("passes client-exposed variables as build arguments only", () => {
    const dockerfile = renderDockerAssets(nextApp, { appPort: 3000, healthPath: "/api/health" })[0]
      ?.content;
    expect(dockerfile).toContain("ARG NEXT_PUBLIC_SITE_URL");
    expect(dockerfile).not.toContain("DATABASE_URL");
  });

  it("lists env names without values in .env.example", () => {
    const example =
      renderDockerAssets(nextApp, { appPort: 3000, healthPath: "/api/health" })[2]?.content ?? "";
    expect(example).toContain("DATABASE_URL=\n");
    expect(example).toContain("NEXT_PUBLIC_SITE_URL=\n");
    expect(example).toMatch(/Public: baked into the frontend/);
  });

  it("keeps secrets and local state out of the build context", () => {
    const ignore =
      renderDockerAssets(viteApp, { appPort: 8080, healthPath: "/" })[1]?.content ?? "";
    for (const entry of [
      ".env",
      ".env.*",
      "!.env.example",
      ".git",
      "opscrew",
      ".opscrew",
      "node_modules",
      // Nested app folders in monorepos.
      "**/.env",
      "**/.env.*",
      "!**/.env.example",
      "**/node_modules",
      "**/.next",
    ]) {
      expect(ignore.split("\n")).toContain(entry);
    }
    const lines = ignore.split("\n");
    expect(lines.indexOf("!**/.env.example")).toBeGreaterThan(lines.indexOf("**/.env.*"));
  });

  it("uses the detected package manager and uvicorn target", () => {
    const vite = renderDockerAssets(viteApp, { appPort: 8080, healthPath: "/" })[0]?.content ?? "";
    expect(vite).toContain("pnpm install --frozen-lockfile");
    const api =
      renderDockerAssets(fastapiApp, { appPort: 8000, healthPath: "/health" })[0]?.content ?? "";
    expect(api).toContain("uvicorn app.main:api --host 0.0.0.0");
    expect(api).toContain("FROM python:3.12-slim");
  });

  it("runs a copy of caddy without file capabilities so it starts under cap_drop ALL", () => {
    const lines = (
      renderDockerAssets(viteApp, { appPort: 8080, healthPath: "/" })[0]?.content ?? ""
    ).split("\n");
    // /usr/bin/caddy carries cap_net_bind_service, which the kernel refuses to exec under
    // `cap_drop: ALL` + `no-new-privileges`; a plain copy drops the security.capability xattr.
    const copyCaddy = lines.findIndex((line) =>
      line.includes("cp /usr/bin/caddy /usr/local/bin/caddy"),
    );
    const user = lines.lastIndexOf("USER 65534");
    expect(copyCaddy).toBeGreaterThan(lines.indexOf(`FROM ${IMAGES.caddy.ref}`));
    expect(copyCaddy).toBeLessThan(user);
    expect(lines.slice(user)).toContain(
      'CMD ["/usr/local/bin/caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]',
    );
  });

  it("builds a Next.js app in a monorepo folder from the repository root", () => {
    const dockerfile =
      renderDockerAssets(nextMonorepoApp, { appPort: 4000, healthPath: "/api/health" })[0]
        ?.content ?? "";
    const lines = dockerfile.split("\n");
    // The whole workspace (root lockfile and workspace packages) is the build context.
    expect(lines).toContain("COPY . .");
    expect(dockerfile).toContain("pnpm install --frozen-lockfile");
    expect(lines).toContain("RUN pnpm --filter web run build && mkdir -p apps/web/public");
    // The server traced from the repository root (outputFileTracingRoot) ...
    expect(lines).toContain("  && if [ -f apps/web/.next/standalone/apps/web/server.js ]; then \\");
    expect(lines).toContain("    cp -a apps/web/.next/standalone/. /out/ \\");
    expect(lines).toContain("    && cp -a apps/web/.next/static /out/apps/web/.next/static \\");
    expect(lines).toContain("    && cp -a apps/web/public /out/apps/web/public \\");
    expect(dockerfile).toContain(`exec node "%s"\\n' /app/apps/web/server.js`);
    // ... or traced from the app folder ...
    expect(lines).toContain("  elif [ -f apps/web/.next/standalone/server.js ]; then \\");
    expect(lines).toContain("    && cp -a apps/web/.next/static /out/.next/static \\");
    expect(dockerfile).toContain(`exec node "%s"\\n' /app/server.js`);
    // ... or `next start` in the app folder.
    expect(dockerfile).toContain(
      `NEXT_BIN="$(cd apps/web && node -p "require.resolve('next/dist/bin/next')")" && [ -n "$NEXT_BIN" ]`,
    );
    expect(dockerfile).toContain(`/app/apps/web "$NEXT_BIN" > /out/opscrew-start.sh`);
    expect(lines).toContain("COPY --from=build --chown=node:node /out ./");
    expect(lines).toContain('CMD ["sh", "/app/opscrew-start.sh"]');
    expect(dockerfile).not.toContain("/app/.next/standalone");
    expect(dockerfile).toContain("outputFileTracingRoot");
  });

  it("quotes monorepo app folders that need it", () => {
    const spaced = facts({
      ...nextMonorepoApp,
      frameworks: [{ name: "next", path: "apps/my web" }],
      appDir: "apps/my web",
    });
    const dockerfile =
      renderDockerAssets(spaced, { appPort: 4000, healthPath: "/" })[0]?.content ?? "";
    expect(dockerfile).toContain(
      "  && if [ -f 'apps/my web/.next/standalone/apps/my web/server.js' ]; then \\",
    );
    expect(dockerfile).toContain("    cp -a 'apps/my web/.next/standalone/.' /out/ \\");
    expect(dockerfile).toContain(`exec node "%s"\\n' '/app/apps/my web/server.js'`);
    expect(dockerfile).toContain(`NEXT_BIN="$(cd 'apps/my web' && node -p`);
    expect(dockerfile).toContain(`'/app/apps/my web' "$NEXT_BIN" > /out/opscrew-start.sh`);
  });

  it("builds Next.js with or without standalone output and runs one start script", () => {
    const dockerfile =
      renderDockerAssets(nextApp, { appPort: 3000, healthPath: "/api/health" })[0]?.content ?? "";
    const lines = dockerfile.split("\n");
    const runtime = lines.indexOf(`FROM ${IMAGES.nodeAlpine.ref} AS runtime`);
    expect(runtime).toBeGreaterThan(0);
    const runtimeLines = lines.slice(runtime);
    // The runtime stage copies one folder and runs one entry, as the non-root node user.
    expect(runtimeLines.filter((line) => line.startsWith("COPY"))).toEqual([
      "COPY --from=build --chown=node:node /out ./",
    ]);
    expect(runtimeLines).toContain("USER node");
    expect(runtimeLines).toContain(
      "ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0",
    );
    expect(runtimeLines.at(-2)).toBe('CMD ["sh", "/app/opscrew-start.sh"]');
    // The build stage picks the standalone server when it exists, else `next start`.
    expect(lines).toContain("  && if [ -f .next/standalone/server.js ]; then \\");
    expect(dockerfile).not.toContain("elif");
    expect(lines).toContain("  else \\");
    expect(lines).toContain("    rm -rf .next/cache && cp -a . /out/ \\");
    expect(dockerfile).toContain(
      `start --hostname "\${HOSTNAME:-0.0.0.0}" --port "\${PORT:-3000}"`,
    );
    expect(dockerfile).toMatch(/^# Builds with or without `output: "standalone"`/m);
  });

  it("binds Node servers to all interfaces (HOST and PORT)", () => {
    const lines = (
      renderDockerAssets(expressApp, { appPort: 4000, healthPath: "/health" })[0]?.content ?? ""
    ).split("\n");
    expect(lines).toContain("ENV NODE_ENV=production PORT=4000 HOST=0.0.0.0");
  });

  it("installs a pinned gunicorn for Django only when the dependencies lack it", () => {
    const lines = (
      renderDockerAssets(djangoApp, { appPort: 8000, healthPath: "/health" })[0]?.content ?? ""
    ).split("\n");
    expect(lines).not.toContain("RUN pip install gunicorn");
    const install =
      lines.find((line) => line.includes("gunicorn") && line.startsWith("RUN ")) ?? "";
    expect(install).toMatch(
      /^RUN python -c "import gunicorn" 2>\/dev\/null \|\| pip install gunicorn==\d+\.\d+\.\d+$/,
    );
    expect(lines.indexOf(install)).toBeGreaterThan(
      lines.findIndex((line) => line.includes("poetry install")),
    );
    expect(lines.indexOf(install)).toBeLessThan(lines.indexOf("USER app"));
  });

  it("collects Django static files at build time without real settings", () => {
    const dockerfile =
      renderDockerAssets(djangoApp, { appPort: 8000, healthPath: "/health" })[0]?.content ?? "";
    const lines = dockerfile.split("\n");
    const collect = lines.findIndex((line) => line.includes("collectstatic --noinput"));
    expect(collect).toBeGreaterThan(lines.indexOf("COPY --chown=app:app . ."));
    expect(collect).toBeLessThan(lines.indexOf("USER app"));
    expect(lines[collect]).toMatch(/\bSECRET_KEY=build-only-placeholder-not-secret\b/);
    expect(lines[collect]).toMatch(/python manage\.py collectstatic --noinput/);
  });

  it("skips collectstatic when the Django settings have no STATIC_ROOT", () => {
    const dockerfile =
      renderDockerAssets(djangoApp, { appPort: 8000, healthPath: "/health" })[0]?.content ?? "";
    const runs = dockerfile.split("\n").filter((line) => line.includes("collectstatic"));
    const run = runs.find((line) => line.startsWith("RUN ")) ?? "";
    expect(runs.filter((line) => line.startsWith("RUN "))).toHaveLength(1);
    expect(run).toContain(
      `static_root="$(python manage.py shell --verbosity 0 -c 'from django.conf import settings; print(settings.STATIC_ROOT or "")')"`,
    );
    expect(run).toContain(
      'if [ -n "$static_root" ]; then python manage.py collectstatic --noinput; else echo "collectstatic skipped: STATIC_ROOT is not set"; fi',
    );
    // The placeholder key is exported for both the check and collectstatic.
    expect(run).toMatch(/^RUN export SECRET_KEY=build-only-placeholder-not-secret /);
  });

  it("refuses stacks without a template", () => {
    expect(() =>
      renderDockerAssets(facts({ languages: ["go"] }), { appPort: 8080, healthPath: "/" }),
    ).toThrow(/no container template/);
  });

  it("renders only .dockerignore and .env.example when another builder builds the image", () => {
    const go = facts({
      languages: ["go"],
      envVars: [
        { name: "API_TOKEN", files: ["main.go"], clientExposed: false, secretLikely: true },
      ],
    });
    const files = renderDockerAssets(go, { appPort: 8080, healthPath: "/", dockerfile: false });
    expect(files.map((file) => file.path)).toEqual([".dockerignore", ".env.example"]);
    // The same .dockerignore as with OpsCrew's Dockerfile.
    const node = renderDockerAssets(nextApp, { appPort: 3000, healthPath: "/" });
    expect(files[0]?.content).toBe(node.find((file) => file.path === ".dockerignore")?.content);
    expect(files[1]?.content).toContain("# Secret: keep it out of git.\nAPI_TOKEN=\n");
  });

  it("never emits secret-shaped strings", () => {
    for (const sample of [...Object.values(ALL), ...Object.values(SUBFOLDER)]) {
      for (const file of renderDockerAssets(sample, { appPort: 3000, healthPath: "/health" })) {
        expect(file.content).not.toMatch(/(ghp_|sk-ant-|sk_live_|AKIA|eyJ)[A-Za-z0-9]{8}/);
      }
    }
  });

  it("recognises client-exposed prefixes", () => {
    expect(isClientExposedEnvName("VITE_X")).toBe(true);
    expect(isClientExposedEnvName("NEXT_PUBLIC_X")).toBe(true);
    expect(isClientExposedEnvName("DATABASE_URL")).toBe(false);
  });
});

describe("supercronic in the image of an app with cron jobs", () => {
  const add = (arch: PinArch) =>
    `ADD --checksum=sha256:${TOOLS.supercronic.sha256[arch]} --chmod=755 ${toolDownloadUrl("supercronic", arch)} /usr/local/bin/supercronic`;
  const withCron = (sample: ProjectFacts, arch: PinArch | undefined) =>
    renderDockerAssets(sample, {
      appPort: sample.port ?? 3000,
      healthPath: "/health",
      supercronic: arch,
    })[0]?.content ?? "";

  it("matches the snapshot of a Node.js server image with and without cron jobs", () => {
    expect(withCron(expressApp, "amd64")).toMatchSnapshot();
    expect(withCron(expressApp, undefined)).toMatchSnapshot();
  });

  it.each(Object.entries(ALL))(
    "adds the pinned binary to the runtime stage of %s, before its user",
    (_name, sample) => {
      const lines = withCron(sample, "amd64").split("\n");
      const at = lines.indexOf(add("amd64"));
      expect(at).toBeGreaterThan(lines.findLastIndex((line) => line.startsWith("FROM ")));
      expect(at).toBeLessThan(lines.findLastIndex((line) => line.startsWith("USER ")));
      expect(lines.filter((line) => line.startsWith("ADD "))).toEqual([add("amd64")]);
    },
  );

  it.each(Object.entries(ALL))(
    "adds it to %s before the app's files, so its layer stays cached across code changes",
    (_name, sample) => {
      const lines = withCron(sample, "amd64").split("\n");
      const at = lines.indexOf(add("amd64"));
      const stage = lines.slice(
        lines.findLastIndex((line) => line.startsWith("FROM ")),
        at,
      );
      expect(stage.filter((line) => !/^(FROM|ENV|WORKDIR|#) /.test(line))).toEqual([]);
    },
  );

  it("downloads the binary for the image's architecture", () => {
    const arm = withCron(expressApp, "arm64");
    expect(arm).toContain(add("arm64"));
    expect(arm).toContain("/supercronic-linux-arm64 ");
    expect(arm).not.toContain(TOOLS.supercronic.sha256.amd64);
  });

  it("leaves the image as it was without cron jobs", () => {
    for (const sample of Object.values(ALL)) {
      expect(withCron(sample, undefined)).toBe(dockerfileOf(sample));
      expect(dockerfileOf(sample)).not.toContain("supercronic");
    }
  });
});

describe("the SQLite folder in the image of an app on SQLite", () => {
  const withSqlite = (sample: ProjectFacts, sqliteFolder: string | undefined) =>
    renderDockerAssets(sample, {
      appPort: sample.port ?? 3000,
      healthPath: "/health",
      sqliteFolder,
    })[0]?.content ?? "";
  const { viteApp: _static, ...servers } = ALL;

  it("matches the snapshot of a Node.js server image", () => {
    expect(withSqlite(expressApp, "/app/storage")).toMatchSnapshot();
  });

  it.each(Object.entries(servers))(
    "makes it in %s after the app's user, then returns to /app",
    (_name, sample) => {
      const lines = withSqlite(sample, "/app/storage").split("\n");
      const user = lines.findLastIndex((line) => line.startsWith("USER "));
      expect(lines.slice(user + 1, user + 4)).toEqual([
        "# SQLite's folder (storage.sqlite in opscrew/plan.yaml), made as the app's user: Docker gives a new volume on it the folder's owner.",
        "WORKDIR /app/storage",
        "WORKDIR /app",
      ]);
    },
  );

  it("leaves the image as it was without SQLite, and a static site always", () => {
    for (const sample of Object.values(ALL)) {
      expect(withSqlite(sample, undefined)).toBe(dockerfileOf(sample));
    }
    expect(withSqlite(viteApp, "/app/storage")).toBe(dockerfileOf(viteApp));
  });
});

describe("renderDockerAssets for an app in a subfolder (facts.appDir)", () => {
  for (const [name, sample] of Object.entries(SUBFOLDER)) {
    it(`renders ${name} into its folder`, () => {
      const files = renderDockerAssets(sample, {
        appPort: sample.port ?? 3000,
        healthPath: "/health",
      });
      // The Dockerfile lives with the app; the build context (and its .dockerignore) is the root.
      expect(files.map((f) => f.path)).toEqual([
        `${sample.appDir}/Dockerfile`,
        ".dockerignore",
        ".env.example",
      ]);
      const dockerfile = files[0]?.content ?? "";
      expect(dockerfile).toMatchSnapshot();
      expect(dockerfile.match(/^USER (\S+)$/gm)?.at(-1)).not.toBe("USER root");
      expect(dockerfile.endsWith("\n")).toBe(true);
    });
  }

  it("leaves root apps byte-identical when appDir is `.`", () => {
    for (const sample of Object.values(ALL).filter((s) => s !== nextMonorepoApp)) {
      const before = renderDockerAssets(sample, { appPort: 3000, healthPath: "/health" });
      const after = renderDockerAssets(
        { ...sample, appDir: "." },
        { appPort: 3000, healthPath: "/health" },
      );
      expect(after).toEqual(before);
    }
  });

  it("prefers facts.appDir over framework paths", () => {
    const files = renderDockerAssets(
      { ...nextMonorepoApp, appDir: "." },
      { appPort: 4000, healthPath: "/" },
    );
    expect(files[0]?.path).toBe("Dockerfile");
    expect(files[0]?.content).toContain("  && if [ -f .next/standalone/server.js ]; then \\");
    expect(files[0]?.content).toContain(`exec node "%s"\\n' /app/server.js`);
  });

  it("installs an npm workspace from the root and runs the app with --workspace", () => {
    const lines = dockerfileOf(npmWorkspaceApi).split("\n");
    expect(lines).toContain("COPY . .");
    expect(lines).toContain("RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi");
    expect(lines).toContain('CMD ["sh", "-c", "npm run start --workspace apps/api"]');
  });

  it("builds a pnpm workspace member with --filter ./<dir>", () => {
    const lines = dockerfileOf(pnpmWorkspaceSite, 8080).split("\n");
    // The workspace is installed from the root, with no `cd`.
    expect(lines).toContainEqual(
      expect.stringMatching(
        /^RUN spec=.* && if \[ -f pnpm-lock\.yaml \]; then pnpm install --frozen-lockfile; else pnpm install; fi$/,
      ),
    );
    expect(lines).toContain("RUN pnpm --filter ./apps/site run build");
    expect(lines).toContain("COPY --from=build /app/apps/site/dist /srv");
    expect(lines).toContain("ARG VITE_API_URL");
  });

  it("keeps a detected root-relative output folder", () => {
    const lines = dockerfileOf(
      { ...pnpmWorkspaceSite, build: { outputDir: "apps/site/build" } },
      8080,
    ).split("\n");
    expect(lines).toContain("COPY --from=build /app/apps/site/build /srv");
  });

  it("runs a yarn workspace by its package name when facts know it", () => {
    const named = facts({
      ...npmWorkspaceApi,
      packageManager: "yarn",
      build: { startCommand: "yarn workspace @acme/api start" },
    });
    expect(dockerfileOf(named)).toContain('CMD ["sh", "-c", "yarn workspace @acme/api start"]');
    const nameFromBuild = facts({
      ...npmWorkspaceApi,
      packageManager: "yarn",
      build: { buildCommand: "yarn workspace @acme/api run build" },
    });
    expect(dockerfileOf(nameFromBuild)).toContain(
      'CMD ["sh", "-c", "yarn workspace @acme/api start"]',
    );
    const unnamed = facts({ ...npmWorkspaceApi, packageManager: "yarn" });
    expect(dockerfileOf(unnamed)).toContain('CMD ["sh", "-c", "cd apps/api && yarn start"]');
  });

  it("builds Next.js in a workspace with the workspace flag when no command was detected", () => {
    const lines = dockerfileOf({ ...nextMonorepoApp, appDir: "apps/web", build: {} }).split("\n");
    expect(lines).toContain("RUN pnpm --filter ./apps/web run build && mkdir -p apps/web/public");
  });

  it("installs and builds inside the folder when the repository is not a workspace", () => {
    const site = facts({
      ...pnpmWorkspaceSite,
      packageManager: "npm",
      monorepo: false,
      appDir: "frontend",
      frameworks: [{ name: "vite", path: "frontend" }],
      envVars: [],
    });
    const lines = dockerfileOf(site, 8080).split("\n");
    expect(lines).toContain(
      "RUN cd frontend && if [ -f package-lock.json ]; then npm ci; else npm install; fi",
    );
    expect(lines).toContain("RUN cd frontend && npm run build");
    expect(lines).toContain("COPY --from=build /app/frontend/dist /srv");

    const next = facts({
      ...nextApp,
      appDir: "web",
      frameworks: [{ name: "next", path: "web" }],
      build: { buildCommand: "cd web && npm run build" },
    });
    expect(dockerfileOf(next).split("\n")).toContain(
      "RUN (cd web && npm run build) && mkdir -p web/public",
    );
  });

  it("copies only the app folder for Python and starts it from there", () => {
    const dockerfile = dockerfileOf(pythonSubfolderApi);
    const lines = dockerfile.split("\n");
    expect(lines).toContain("COPY services/api/requirements*.txt ./");
    expect(lines).toContain("COPY --chown=app:app services/api .");
    expect(lines).not.toContain("COPY --chown=app:app . .");
    expect(dockerfile).not.toContain("cd services/api");
    expect(dockerfile).toContain("uvicorn app.main:app --host 0.0.0.0");

    const poetry = dockerfileOf({
      ...pythonSubfolderApi,
      packageManager: "poetry",
      frameworks: [{ name: "django", path: "services/api" }],
      build: {},
    });
    expect(poetry.split("\n")).toContain(
      "COPY services/api/pyproject.toml services/api/poetry.lock* ./",
    );
  });

  it("quotes app folders that need it", () => {
    const spaced = dockerfileOf({ ...pythonSubfolderApi, appDir: "services/my api", build: {} });
    expect(spaced).toContain('COPY ["services/my api/requirements*.txt", "./"]');
    expect(spaced).toContain('COPY --chown=app:app ["services/my api", "."]');
    const npm = dockerfileOf({ ...npmWorkspaceApi, appDir: "apps/my api" });
    expect(npm).toContain(`npm run start --workspace 'apps/my api'`);
  });
});

describe("pinned build tools (FR-1203)", () => {
  /** Every `RUN` line of the Dockerfile rendered for `sample`. */
  const runs = (sample: ProjectFacts) =>
    dockerfileOf(sample)
      .split("\n")
      .filter((line) => line.startsWith("RUN "));
  const pipenvApp = facts({ ...fastapiApp, packageManager: "pipenv" });

  it("installs Poetry, uv, Pipenv, uvicorn and gunicorn at the versions in pins.ts", () => {
    expect(runs(djangoApp)).toContain(
      `RUN pip install poetry==${PYPI_PACKAGES.poetry} && poetry config virtualenvs.create false && poetry install --only main --no-root`,
    );
    expect(runs(pythonApp)).toContain(
      `RUN pip install uv==${PYPI_PACKAGES.uv} && uv pip install --system -r pyproject.toml`,
    );
    expect(runs(pipenvApp)).toContain(
      `RUN pip install pipenv==${PYPI_PACKAGES.pipenv} && pipenv install --system --deploy`,
    );
    // The servers come only when the dependencies lack them, so the app's own pin stays.
    expect(runs(fastapiApp)).toContain(
      `RUN python -c "import uvicorn" 2>/dev/null || pip install uvicorn==${PYPI_PACKAGES.uvicorn}`,
    );
    expect(runs(djangoApp)).toContain(
      `RUN python -c "import gunicorn" 2>/dev/null || pip install gunicorn==${PYPI_PACKAGES.gunicorn}`,
    );
    for (const sample of [djangoApp, pythonApp, pipenvApp, fastapiApp, pythonSubfolderApi]) {
      for (const line of runs(sample)) {
        // Only the app's own requirements file is installed without a version (uv installs the
        // app's own dependencies).
        for (const [, what] of line.matchAll(/(?<!uv )pip install (\S+)/g)) {
          expect(what === "-r" || /^[a-z]+==\d/.test(what ?? ""), line).toBe(true);
        }
      }
    }
  });
});

/** The `monorepo-two-apps` example's API as detection reports it: a pnpm workspace member. */
const pnpmMemberApi = facts({
  name: "duo",
  languages: ["javascript"],
  packageManager: "pnpm",
  frameworks: [{ name: "express", path: "apps/api" }],
  appKind: "api",
  port: 4001,
  build: {
    installCommand: "pnpm install --frozen-lockfile",
    startCommand: "pnpm --filter api start",
  },
  monorepo: true,
  appDir: "apps/api",
});
/** A Yarn app at the root whose start command is its `start` script. */
const yarnApi = facts({ ...expressApp, build: { startCommand: "yarn start" } });

/** The Dockerfile on a Node 26 base (the plan's runtime, digest from a fake registry lookup). */
function onNode26(sample: ProjectFacts, releaseCommand?: string): string {
  return (
    renderDockerAssets(sample, {
      appPort: sample.port ?? 3000,
      healthPath: "/health",
      app: {
        build: {
          builder: "generated-dockerfile",
          chosen: "auto",
          reason: "OpsCrew's Dockerfile builds it.",
          runtime: { language: "node", version: "26" },
          probe: designProbe("generated-dockerfile", "node"),
        },
        releaseCommand,
      },
      resolveImageDigest: () => `sha256:${"ab".repeat(32)}`,
    })[0]?.content ?? ""
  );
}

/** The lines of the runtime stage. */
function runtimeStage(dockerfile: string): string[] {
  const lines = dockerfile.split("\n");
  return lines.slice(lines.findIndex((line) => / AS runtime$/.test(line)));
}

describe("pnpm and Yarn without corepack (T1219)", () => {
  const JS = { ...ALL, pnpmMemberApi, yarnApi, npmWorkspaceApi, pnpmWorkspaceSite };

  it.each([
    ["pnpmMemberApi", "Node 24", dockerfileOf(pnpmMemberApi)],
    ["pnpmMemberApi", "Node 26", onNode26(pnpmMemberApi)],
    ["yarnApi", "Node 26", onNode26(yarnApi)],
    [
      "pnpmMemberApi with a pnpm release command",
      "Node 26",
      onNode26(pnpmMemberApi, "pnpm --filter api run migrate"),
    ],
  ])("renders %s on %s", (_name, _base, dockerfile) => {
    expect(dockerfile).toMatchSnapshot();
  });

  it("never uses corepack, on Node 24 or Node 26", () => {
    for (const [name, sample] of Object.entries(JS)) {
      expect(dockerfileOf(sample), name).not.toContain("corepack");
      expect(onNode26(sample), name).not.toContain("corepack");
    }
  });

  it("starts a pnpm app's package script with npm, so the image has no pnpm", () => {
    const runtime = runtimeStage(dockerfileOf(pnpmMemberApi));
    expect(runtime).toContain('CMD ["sh", "-c", "cd apps/api && npm run start"]');
    expect(runtime.filter((line) => line.startsWith("RUN "))).toEqual([
      expect.stringMatching(/^RUN node -e '.*' apps\/api\/package\.json api apps\/api$/),
      expect.stringMatching(/^RUN if node -e '.*' apps\/api\/package\.json start; then spec=/),
    ]);
    // The forms detection and OpsCrew's own default write.
    const start = (sample: ProjectFacts, startCommand?: string) =>
      runtimeStage(dockerfileOf({ ...sample, build: { startCommand } })).at(-2);
    const root = facts({ ...pnpmMemberApi, monorepo: false, appDir: ".", frameworks: [] });
    const folder = facts({ ...root, appDir: "api" });
    expect(start(root, "pnpm start")).toBe('CMD ["sh", "-c", "npm run start"]');
    expect(start(root, "pnpm run start:prod")).toBe('CMD ["sh", "-c", "npm run start:prod"]');
    expect(start(folder, "cd api && pnpm run start:prod")).toBe(
      'CMD ["sh", "-c", "cd api && npm run start:prod"]',
    );
    expect(start(folder)).toBe('CMD ["sh", "-c", "cd api && npm run start"]');
    expect(start(pnpmMemberApi)).toBe('CMD ["sh", "-c", "cd apps/api && npm run start"]');
    expect(start(pnpmMemberApi, "pnpm --filter api run start:prod")).toBe(
      'CMD ["sh", "-c", "cd apps/api && npm run start:prod"]',
    );
    // A `./<dir>` filter needs no name check.
    const byPath = runtimeStage(dockerfileOf({ ...pnpmMemberApi, build: {} }));
    expect(byPath.filter((line) => line.startsWith("RUN "))).toEqual([
      expect.stringMatching(/^RUN if node -e /),
    ]);
    // Other filters (another folder, a selector) keep pnpm.
    for (const filter of ["./apps/web", "...api", "'{apps/api}'"]) {
      expect(start(pnpmMemberApi, `pnpm --filter ${filter} start`)).toBe(
        `CMD ["sh", "-c", ${JSON.stringify(`pnpm --filter ${filter} start`)}]`,
      );
    }
  });

  it("installs pnpm or Yarn in the runtime stage, as root, when a command the image runs calls it", () => {
    const installs = (dockerfile: string) => {
      const runtime = runtimeStage(dockerfile);
      const runs = runtime.filter((line) => line.startsWith("RUN "));
      for (const line of runs)
        expect(runtime.indexOf(line)).toBeLessThan(runtime.indexOf("USER node"));
      return runs;
    };
    const pnpmInstall = expect.stringMatching(
      /^RUN spec=.* && npm install -g .* && rm -rf \/root\/\.npm$/,
    );
    // The release command runs pnpm.
    const release = onNode26(pnpmMemberApi, "pnpm --filter api run migrate");
    expect(installs(release)).toEqual([expect.stringMatching(/^RUN node -e /), pnpmInstall]);
    expect(runtimeStage(release).at(-2)).toBe('CMD ["sh", "-c", "cd apps/api && npm run start"]');
    // A start command other than a package script keeps pnpm, and so does pnpx.
    const pnpx = dockerfileOf({ ...pnpmMemberApi, build: { startCommand: "pnpx serve dist" } });
    expect(installs(pnpx)).toEqual([pnpmInstall]);
    const flags = dockerfileOf({
      ...pnpmMemberApi,
      build: { startCommand: "pnpm start --port 4001" },
    });
    expect(installs(flags)).toEqual([pnpmInstall]);
    expect(runtimeStage(flags).at(-2)).toBe('CMD ["sh", "-c", "pnpm start --port 4001"]');
    // Yarn runs its start command (Plug'n'Play needs Yarn's loader), installed at build time.
    expect(installs(onNode26(yarnApi))).toEqual([
      expect.stringMatching(
        /^RUN rm -f \/usr\/local\/bin\/yarn \/usr\/local\/bin\/yarnpkg && spec=/,
      ),
    ]);
    expect(runtimeStage(onNode26(yarnApi)).at(-2)).toBe('CMD ["sh", "-c", "yarn start"]');
    // Neither when nothing calls it.
    for (const sample of [
      expressApp,
      { ...pnpmMemberApi, build: { startCommand: "node src/server.js" } },
    ]) {
      expect(installs(onNode26(sample))).toEqual([]);
    }
  });
});

describe.skipIf(!shWorks())("installing pnpm and Yarn in sh (T1219)", { timeout: 30_000 }, () => {
  /**
   * Runs `command` in a folder holding `files`, with `npm`, `pnpm`, `yarn` and `rm` replaced by
   * functions that print their arguments (the real `node` reads package.json).
   */
  async function run(command: string, files: Record<string, unknown>) {
    const dir = await mkdtemp(join(tmpdir(), "opscrew-pm-"));
    try {
      for (const [file, content] of Object.entries(files)) {
        await mkdir(join(dir, file, ".."), { recursive: true });
        await writeFile(join(dir, file), JSON.stringify(content));
      }
      const fakes = ["npm", "pnpm", "yarn", "rm"].map((name) => `${name}() { echo "${name} $*"; }`);
      const result = spawnSync("sh", ["-c", `${fakes.join("\n")}\n${command}`], {
        cwd: dir,
        encoding: "utf8",
      });
      return { status: result.status, stdout: result.stdout, stderr: result.stderr };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  /** The build stage's install line, without `RUN `. */
  const buildInstall = (sample: ProjectFacts) =>
    (
      dockerfileOf(sample)
        .split("\n")
        .find((line) => line.includes(" install -g ")) ?? ""
    ).replace(/^RUN /, "");
  const npmInstall = (spec: string) => `npm install -g --no-audit --no-fund ${spec}`;

  it("installs the version packageManager names, without its hash, else the pin", async () => {
    const pnpm = buildInstall(viteApp);
    const declared = await run(pnpm, {
      "package.json": { packageManager: "pnpm@9.15.0+sha512.abc123" },
    });
    expect(declared).toMatchObject({
      status: 0,
      stdout: `${npmInstall("pnpm@9.15.0")}\npnpm install\n`,
    });
    const none = await run(pnpm, { "package.json": { name: "app" } });
    expect(none.stdout).toBe(`${npmInstall(`pnpm@${PACKAGE_MANAGERS.pnpm}`)}\npnpm install\n`);
    // Another package manager's field leaves the pin.
    const other = await run(pnpm, { "package.json": { packageManager: "yarn@4.6.0" } });
    expect(other.stdout).toContain(npmInstall(`pnpm@${PACKAGE_MANAGERS.pnpm}`));
  });

  it("stops the build when packageManager names no exact version", async () => {
    for (const [pm, install] of [
      ["pnpm", buildInstall(viteApp)],
      ["yarn", buildInstall(expressApp)],
    ] as const) {
      for (const declared of ["^12", "latest", "https://example.com/pm.tgz", "npm:other@1.0.0"]) {
        const result = await run(install, {
          "package.json": { packageManager: `${pm}@${declared}` },
        });
        expect(result.status, declared).not.toBe(0);
        expect(result.stdout, declared).not.toContain("npm install");
        expect(result.stderr, declared).toContain(
          `package.json's packageManager must name an exact version, such as ${pm}@${PACKAGE_MANAGERS[pm]}`,
        );
      }
    }
    const prerelease = await run(buildInstall(viteApp), {
      "package.json": { packageManager: "pnpm@11.0.0-rc.1" },
    });
    expect(prerelease.stdout).toContain(npmInstall("pnpm@11.0.0-rc.1"));
  });

  it("installs Yarn 1 as yarn and later Yarn as @yarnpkg/cli-dist, unlinking the image's Yarn", async () => {
    const yarn = buildInstall(expressApp);
    const unlink = "rm -f /usr/local/bin/yarn /usr/local/bin/yarnpkg\n";
    expect(
      await run(yarn, { "package.json": { packageManager: "yarn@4.6.0+sha224.abc" } }),
    ).toMatchObject({
      status: 0,
      stdout: `${unlink}${npmInstall("@yarnpkg/cli-dist@4.6.0")}\nyarn install\n`,
    });
    expect((await run(yarn, { "package.json": { packageManager: "yarn@1.22.19" } })).stdout).toBe(
      `${unlink}${npmInstall("yarn@1.22.19")}\nyarn install\n`,
    );
    expect((await run(yarn, { "package.json": {} })).stdout).toBe(
      `${unlink}${npmInstall(`yarn@${PACKAGE_MANAGERS.yarn}`)}\nyarn install\n`,
    );
  });

  it("puts pnpm into the runtime image only when the start script calls it", async () => {
    const check = (
      runtimeStage(dockerfileOf(pnpmMemberApi)).find((line) => line.startsWith("RUN if ")) ?? ""
    ).replace(/^RUN /, "");
    const tree = (start: string, more: Record<string, string> = {}) => ({
      "package.json": { packageManager: "pnpm@9.15.0" },
      "apps/api/package.json": { scripts: { start, ...more } },
    });
    expect(await run(check, tree("node src/server.js"))).toMatchObject({ status: 0, stdout: "" });
    expect(await run(check, tree("pnpm run build && node dist/server.js"))).toMatchObject({
      status: 0,
      stdout: `${npmInstall("pnpm@9.15.0")}\nrm -rf /root/.npm\n`,
    });
    expect((await run(check, tree("node-pnpm-free.js"))).stdout).toBe("");
    // npm runs prestart and poststart too.
    const pre = tree("node dist/server.js", { prestart: "pnpm prisma migrate deploy" });
    expect((await run(check, pre)).stdout).toContain(npmInstall("pnpm@9.15.0"));
    const post = tree("node dist/server.js", { poststart: "pnpx cleanup" });
    expect((await run(check, post)).stdout).toContain(npmInstall("pnpm@9.15.0"));
  });

  it("stops the build when --filter names another package than the app", async () => {
    const check = (
      runtimeStage(dockerfileOf(pnpmMemberApi)).find((line) => line.startsWith("RUN node ")) ?? ""
    ).replace(/^RUN /, "");
    const tree = (name: string) => ({ "apps/api/package.json": { name } });
    expect(await run(check, tree("api"))).toMatchObject({ status: 0, stderr: "" });
    const other = await run(check, tree("@duo/api"));
    expect(other.status).toBe(1);
    expect(other.stderr).toContain(
      "The start command runs pnpm --filter api, but the app in apps/api is named @duo/api",
    );
  });
});

function shWorks(): boolean {
  try {
    return spawnSync("sh", ["-c", "echo ok"], { encoding: "utf8" }).stdout?.trim() === "ok";
  } catch {
    return false;
  }
}

describe.skipIf(!shWorks())("Yarn's production install in sh", { timeout: 30_000 }, () => {
  const install = (
    dockerfileOf(expressApp)
      .split("\n")
      .find((line) => line.includes("--production")) ?? ""
  ).replace(/^RUN /, "");

  /** Runs the install with a fake `yarn` of `version`; `focus`: `yarn workspaces focus` exists. */
  function run(version: string, focus: boolean) {
    const yarn = [
      "yarn() {",
      `  if [ "$1" = --version ]; then echo ${version}; return 0; fi`,
      `  if [ "$1 $2" = "workspaces focus" ] && [ ${focus ? 1 : 0} = 0 ]; then return 1; fi`,
      '  [ "$3" = --help ] || echo "yarn $*"',
      "}",
    ].join("\n");
    const result = spawnSync("sh", ["-c", `${yarn}\n${install}`], { encoding: "utf8" });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  it("installs Yarn 1's production dependencies, and focuses on Yarn 4 or with the plugin", () => {
    expect(run("1.22.22", false)).toMatchObject({
      status: 0,
      stdout: "yarn install --production\n",
    });
    expect(run("4.10.3", true)).toMatchObject({
      status: 0,
      stdout: "yarn workspaces focus --all --production\n",
    });
    expect(run("3.8.7", true).stdout).toBe("yarn workspaces focus --all --production\n");
  });

  it("stops with what to do on Yarn 2 or 3 without the workspace-tools plugin", () => {
    const result = run("3.8.7", false);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain('"yarn plugin import workspace-tools"');
    expect(result.stderr).toContain("Yarn 4");
  });
});
