import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { RepoPathSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { makeFacts, nextPostgresFacts, staticSpaFacts } from "./__fixtures__/catalog";
import { collectCodeChangeSignals, deriveCodeChanges, healthRouteFor } from "./code-changes";

async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "opscrew-design-"));
  for (const [file, content] of Object.entries(files)) {
    const abs = join(root, ...file.split("/"));
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  return root;
}

const finding = (ruleId: string, file: string | undefined, title = "Hard-coded secret") => ({
  ruleId,
  title,
  ...(file === undefined ? {} : { file }),
});

describe("deriveCodeChanges", () => {
  it("lists every change a fresh Next.js app needs, in a stable order with stable ids", () => {
    const facts = nextPostgresFacts();
    const scan = {
      findings: [
        finding("secrets/stripe-secret-key", "src/lib/stripe.ts", "Stripe secret key"),
        finding("supabase/service-role-in-client", "src/lib/supabase.ts", "Service role key"),
        finding("secrets/github-token", "src/lib/stripe.ts", "GitHub token"),
        finding("secrets/generic", ".env.production"),
        finding("secrets/generic", undefined),
        finding("config/dockerfile-root", "Dockerfile"),
        finding("secrets/generic", "/etc/passwd"),
      ],
    };
    const changes = deriveCodeChanges(facts, scan, {
      files: ["src/app/page.tsx", "src/db.ts"],
      hardcodedPortFiles: ["server.ts"],
    });
    expect(changes.map((c) => [c.id, c.kind, c.path])).toEqual([
      ["dockerfile", "dockerfile", "Dockerfile"],
      ["dockerignore", "dockerignore", ".dockerignore"],
      ["health-endpoint", "health-endpoint", "src/app/api/health/route.ts"],
      ["port-config-1", "port-config", "server.ts"],
      ["env-example", "env-example", ".env.example"],
      ["build-config", "build-config", "next.config.mjs"],
      ["secret-removal-1", "secret-removal", "src/lib/stripe.ts"],
      ["secret-removal-2", "secret-removal", "src/lib/supabase.ts"],
    ]);
    expect(changes.every((c) => c.status === "pending")).toBe(true);
    expect(changes.every((c) => RepoPathSchema.safeParse(c.path).success)).toBe(true);
    expect(changes.find((c) => c.id === "secret-removal-1")?.reason).toContain(
      "GitHub token; Stripe secret key",
    );
    expect(changes.find((c) => c.kind === "health-endpoint")?.reason).toContain("/api/health");
    expect(deriveCodeChanges(facts, scan, { files: ["src/app/page.tsx"] })).toEqual(
      deriveCodeChanges(facts, scan, { files: ["src/app/page.tsx"] }),
    );
  });

  it("turns gitleaks findings into secret-removal changes, except in .env files", () => {
    const scan = {
      findings: [
        finding("gitleaks/github-pat", "src/config.ts", "GitHub personal access token"),
        finding("gitleaks/generic-api-key", "apps/api/.env", "Generic API key"),
        finding("gitleaks/generic-api-key", "scripts/local.sh", "Generic API key"),
        finding("secrets/github-token", "src/config.ts", "GitHub token"),
      ],
    };
    const changes = deriveCodeChanges(staticSpaFacts(), scan).filter(
      (c) => c.kind === "secret-removal",
    );
    expect(changes.map((c) => [c.id, c.path])).toEqual([
      ["secret-removal-1", "scripts/local.sh"],
      ["secret-removal-2", "src/config.ts"],
    ]);
    expect(changes[1]?.reason).toContain("GitHub personal access token; GitHub token");
  });

  it("asks a Next.js app in a monorepo folder to trace files from the repository root", () => {
    const facts = nextPostgresFacts({
      frameworks: [{ name: "next", path: "apps/web" }],
      monorepo: true,
    });
    const missing = deriveCodeChanges(facts, undefined, { files: ["apps/web/app/page.tsx"] });
    const change = missing.find((c) => c.kind === "build-config");
    expect(change?.path).toBe("apps/web/next.config.mjs");
    expect(change?.reason).toContain('output: "standalone"');
    expect(change?.reason).toContain("outputFileTracingRoot");
    expect(change?.reason).toContain('"../../"');

    // Standalone is set but the tracing root is not: still a build-config change.
    const partly = deriveCodeChanges(facts, undefined, {
      nextConfig: { path: "apps/web/next.config.ts", standalone: true, tracingRoot: false },
    });
    expect(partly.find((c) => c.kind === "build-config")?.path).toBe("apps/web/next.config.ts");

    const done = deriveCodeChanges(facts, undefined, {
      nextConfig: { path: "apps/web/next.config.ts", standalone: true, tracingRoot: true },
    });
    expect(done.map((c) => c.kind)).not.toContain("build-config");

    // A root app does not need the tracing root.
    const root = deriveCodeChanges(nextPostgresFacts(), undefined, {
      nextConfig: { path: "next.config.ts", standalone: false },
    });
    expect(root.find((c) => c.kind === "build-config")?.reason).not.toContain(
      "outputFileTracingRoot",
    );
  });

  it("needs nothing for an app that is already container-ready", () => {
    const facts = nextPostgresFacts({
      docker: { dockerfile: "Dockerfile", dockerignore: ".dockerignore" },
      healthEndpoint: "/api/healthz",
    });
    const changes = deriveCodeChanges(
      facts,
      { findings: [] },
      {
        files: [".env.example", "next.config.ts"],
        nextConfig: { path: "next.config.ts", standalone: true },
        hardcodedPortFiles: [],
      },
    );
    expect(changes).toEqual([]);
  });

  it("uses the pages router path when the app has no app router", () => {
    const facts = nextPostgresFacts({ languages: ["javascript"] });
    expect(healthRouteFor(facts, { files: ["pages/index.js"] })).toEqual({
      path: "/api/health",
      file: "pages/api/health.js",
    });
    expect(healthRouteFor(facts, { files: ["app/layout.js", "pages/legacy.js"] })).toEqual({
      path: "/api/health",
      file: "app/api/health/route.js",
    });
    const monorepo = nextPostgresFacts({ frameworks: [{ name: "next", path: "apps/web" }] });
    expect(healthRouteFor(monorepo, { files: ["apps/web/src/pages/index.tsx"] })).toEqual({
      path: "/api/health",
      file: "apps/web/src/pages/api/health.ts",
    });
  });

  it("uses /health for servers and / for static sites", () => {
    const api = makeFacts({ frameworks: [{ name: "fastapi", path: "." }], languages: ["python"] });
    expect(healthRouteFor(api, { serverEntry: "app/main.py" })).toEqual({
      path: "/health",
      file: "app/main.py",
    });
    expect(healthRouteFor(api)).toEqual({ path: "/health", file: "." });
    expect(healthRouteFor(staticSpaFacts())).toEqual({ path: "/" });
    expect(healthRouteFor(makeFacts({ healthEndpoint: "/status" }))).toEqual({ path: "/status" });
  });

  it("static sites need no health endpoint, port change or Next.js build config", () => {
    const facts = staticSpaFacts();
    const changes = deriveCodeChanges(facts, undefined, { hardcodedPortFiles: ["vite.ts"] });
    expect(changes.map((c) => c.kind)).toEqual(["dockerfile", "dockerignore"]);
    const exported = nextPostgresFacts({ appKind: "static-spa" });
    expect(deriveCodeChanges(exported).map((c) => c.kind)).not.toContain("build-config");
  });

  it("falls back to facts to find an existing .env.example", () => {
    const facts = makeFacts({
      envVars: [
        {
          name: "API_URL",
          files: [".env.example", "src/x.ts"],
          clientExposed: false,
          secretLikely: false,
        },
      ],
    });
    expect(deriveCodeChanges(facts).map((c) => c.kind)).not.toContain("env-example");
    const without = makeFacts({
      envVars: [
        { name: "API_URL", files: ["src/x.ts"], clientExposed: false, secretLikely: false },
      ],
    });
    expect(deriveCodeChanges(without).map((c) => c.kind)).toContain("env-example");
  });
});

describe("collectCodeChangeSignals", () => {
  it("reads the Next.js config, literal ports and the server entry", async () => {
    const root = await project({
      "package.json": "{}",
      "next.config.mjs": 'export default { output: "standalone" };\n',
      "src/app/page.tsx": "export default function Page() { return null; }\n",
      "server.js": "const app = express();\napp.listen(3000, () => {});\n",
      "src/ok.ts": "server.listen(process.env.PORT || 3000);\n",
      "src/server.test.ts": "app.listen(4000);\n",
      "api/main.py": 'app = FastAPI()\nuvicorn.run(app, host="0.0.0.0", port=8000)\n',
    });
    const facts = nextPostgresFacts();
    const signals = await collectCodeChangeSignals(root, facts);
    expect(signals.nextConfig).toEqual({ path: "next.config.mjs", standalone: true });
    expect(signals.hardcodedPortFiles).toEqual(["api/main.py", "server.js"]);
    expect(signals.serverEntry).toBe("server.js");
    expect(signals.files).toContain("src/app/page.tsx");

    const changes = deriveCodeChanges(facts, undefined, signals);
    expect(changes.map((c) => c.kind)).not.toContain("build-config");
    expect(changes.find((c) => c.kind === "health-endpoint")?.path).toBe(
      "src/app/api/health/route.ts",
    );
  });

  it("looks only inside the chosen app's folder of a monorepo", async () => {
    const root = await project({
      "package.json": "{}",
      "apps/api/package.json": "{}",
      "apps/api/src/server.js": "const app = express();\napp.listen(4001);\n",
      "apps/worker/src/server.js": "const app = express();\napp.listen(5000);\n",
    });
    const facts = makeFacts({
      appDir: "apps/api",
      monorepo: true,
      frameworks: [{ name: "express", path: "apps/api" }],
    });
    const signals = await collectCodeChangeSignals(root, facts);
    expect(signals.hardcodedPortFiles).toEqual(["apps/api/src/server.js"]);
    expect(signals.serverEntry).toBe("apps/api/src/server.js");

    const changes = deriveCodeChanges(facts, undefined, signals);
    const paths = Object.fromEntries(changes.map((c) => [c.id, c.path]));
    expect(paths).toMatchObject({
      dockerfile: "apps/api/Dockerfile",
      dockerignore: ".dockerignore",
      "health-endpoint": "apps/api/src/server.js",
      "port-config-1": "apps/api/src/server.js",
    });
  });

  it("keeps a Dockerfile inside the app folder and asks for a .dockerignore at the root", () => {
    const facts = makeFacts({
      appDir: "apps/api",
      docker: { dockerfile: "apps/api/Dockerfile", dockerignore: "apps/api/.dockerignore" },
    });
    const kinds = deriveCodeChanges(facts).map((c) => [c.kind, c.path]);
    expect(kinds).not.toContainEqual(["dockerfile", expect.any(String)]);
    expect(kinds).toContainEqual(["dockerignore", ".dockerignore"]);

    // A Dockerfile elsewhere (for example the root) does not build this app.
    const elsewhere = makeFacts({ appDir: "apps/api", docker: { dockerfile: "Dockerfile" } });
    expect(deriveCodeChanges(elsewhere).find((c) => c.kind === "dockerfile")?.path).toBe(
      "apps/api/Dockerfile",
    );
  });

  it("asks a Django app without STATIC_ROOT to set it, so collectstatic works in the image", async () => {
    const facts = makeFacts({
      languages: ["python"],
      packageManager: "pip",
      frameworks: [{ name: "django", path: "." }],
    });
    const without = await project({
      "manage.py": "",
      "proj/settings.py": "SECRET_KEY = 'x'\nSTATIC_URL = 'static/'\n",
    });
    const missing = await collectCodeChangeSignals(without, facts);
    expect(missing.djangoSettings).toEqual({ path: "proj/settings.py", staticRoot: false });
    const change = deriveCodeChanges(facts, undefined, missing).find(
      (c) => c.kind === "build-config",
    );
    expect(change).toMatchObject({ path: "proj/settings.py" });
    expect(change?.reason).toContain("STATIC_ROOT");

    const withRoot = await project({
      "manage.py": "",
      "proj/settings/base.py": 'STATIC_ROOT = BASE_DIR / "staticfiles"\n',
      "proj/settings/production.py": "from .base import *\n",
    });
    const ok = await collectCodeChangeSignals(withRoot, facts);
    expect(ok.djangoSettings?.staticRoot).toBe(true);
    expect(deriveCodeChanges(facts, undefined, ok).map((c) => c.kind)).not.toContain(
      "build-config",
    );
  });

  it("checks outputFileTracingRoot for a Next.js app in a monorepo folder", async () => {
    const facts = nextPostgresFacts({ frameworks: [{ name: "next", path: "apps/web" }] });
    const without = await project({
      "apps/web/next.config.mjs": 'export default { output: "standalone" };\n',
    });
    expect((await collectCodeChangeSignals(without, facts)).nextConfig).toEqual({
      path: "apps/web/next.config.mjs",
      standalone: true,
      tracingRoot: false,
    });
    const traced = await project({
      "apps/web/next.config.js":
        'module.exports = { output: "standalone", outputFileTracingRoot: path.join(__dirname, "../../") };\n',
    });
    expect((await collectCodeChangeSignals(traced, facts)).nextConfig).toEqual({
      path: "apps/web/next.config.js",
      standalone: true,
      tracingRoot: true,
    });
  });

  it("flags a Next.js config without standalone output", async () => {
    const root = await project({ "next.config.ts": "export default { reactStrictMode: true };\n" });
    const signals = await collectCodeChangeSignals(root, nextPostgresFacts());
    expect(signals.nextConfig).toEqual({ path: "next.config.ts", standalone: false });
    expect(
      deriveCodeChanges(nextPostgresFacts(), undefined, signals).find(
        (c) => c.kind === "build-config",
      )?.path,
    ).toBe("next.config.ts");
  });
});
