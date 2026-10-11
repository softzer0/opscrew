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
      expect(files.map((f) => f.path)).toEqual(["Dockerfile", ".dockerignore", ".env.example"]);
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

  it("builds a Next.js app in a monorepo folder from the repository root", () => {
    const dockerfile =
      renderDockerAssets(nextMonorepoApp, { appPort: 4000, healthPath: "/api/health" })[0]
        ?.content ?? "";
    const lines = dockerfile.split("\n");
    // The whole workspace (root lockfile and workspace packages) is the build context.
    expect(lines).toContain("COPY . .");
    expect(dockerfile).toContain("pnpm install --frozen-lockfile");
    expect(lines).toContain("RUN pnpm --filter web run build && mkdir -p apps/web/public");
    expect(lines).toContain(
      "COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./",
    );
    expect(lines).toContain(
      "COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static",
    );
    expect(lines).toContain(
      "COPY --from=build --chown=node:node /app/apps/web/public ./apps/web/public",
    );
    expect(lines).toContain('CMD ["node", "apps/web/server.js"]');
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
      'COPY --from=build --chown=node:node ["/app/apps/my web/.next/standalone", "./"]',
    );
    expect(dockerfile).toContain('CMD ["node", "apps/my web/server.js"]');
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

  it("refuses stacks without a template", () => {
    expect(() =>
      renderDockerAssets(facts({ languages: ["go"] }), { appPort: 8080, healthPath: "/" }),
    ).toThrow(/no container template/);
  });

  it("never emits secret-shaped strings", () => {
    for (const sample of Object.values(ALL)) {
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
