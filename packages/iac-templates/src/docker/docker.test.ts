import type { ProjectFacts } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { containerPort, detectStack, isClientExposedEnvName, renderDockerAssets } from "./index";

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
      // Older facts without `appDir`: the framework's folder locates the app.
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
    expect(copyCaddy).toBeGreaterThan(lines.indexOf("FROM caddy:2-alpine"));
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
      frameworks: [{ name: "next", path: "apps/my web/" }],
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
    const runtime = lines.indexOf("FROM node:22-alpine AS runtime");
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

  it("falls back to the framework path for every stack", () => {
    const { appDir: _ignored, ...withoutAppDir } = npmWorkspaceApi;
    const files = renderDockerAssets(withoutAppDir, { appPort: 4000, healthPath: "/" });
    expect(files[0]?.path).toBe("apps/api/Dockerfile");
    const python = renderDockerAssets(
      { ...pythonSubfolderApi, appDir: undefined },
      { appPort: 8000, healthPath: "/" },
    );
    expect(python[0]?.path).toBe("services/api/Dockerfile");
  });

  it("installs an npm workspace from the root and runs the app with --workspace", () => {
    const lines = dockerfileOf(npmWorkspaceApi).split("\n");
    expect(lines).toContain("COPY . .");
    expect(lines).toContain("RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi");
    expect(lines).toContain('CMD ["sh", "-c", "npm run start --workspace apps/api"]');
  });

  it("builds a pnpm workspace member with --filter ./<dir>", () => {
    const lines = dockerfileOf(pnpmWorkspaceSite, 8080).split("\n");
    expect(lines).toContain(
      "RUN corepack enable && if [ -f pnpm-lock.yaml ]; then pnpm install --frozen-lockfile; else pnpm install; fi",
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
