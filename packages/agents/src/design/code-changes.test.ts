import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { RepoPathSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { makeFacts, nextPostgresFacts, staticSpaFacts } from "./__fixtures__/catalog";
import { collectCodeChangeSignals, deriveCodeChanges, healthRouteFor } from "./index";

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
