import type { AppBuild, ProjectFacts } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { appRoot } from "./app-root";
import { renderDockerAssets } from "./docker";

const plan = (
  builder?: AppBuild["builder"],
  extra: {
    dockerfile?: string;
    buildContext?: string;
    language?: "node" | "python";
    workdir?: string;
  } = {},
) => ({
  app: {
    dockerfile: extra.dockerfile ?? "Dockerfile",
    buildContext: extra.buildContext ?? ".",
    ...(builder === undefined
      ? {}
      : {
          build: {
            builder,
            chosen: "auto" as const,
            reason: "test",
            runtime: { language: extra.language ?? "node", version: "24" },
            probe: "node" as const,
            ...(extra.workdir === undefined ? {} : { workdir: extra.workdir }),
          },
        }),
  },
});

const facts = (overrides: Partial<ProjectFacts>): ProjectFacts => ({
  name: "app",
  languages: ["typescript"],
  packageManager: "npm",
  frameworks: [],
  appKind: "api",
  platformExport: { platform: "none", evidence: [] },
  build: { startCommand: "node server.js" },
  runtimeVersions: {},
  envVars: [],
  services: [],
  docker: {},
  monorepo: false,
  appDir: ".",
  git: {},
  ...overrides,
});

describe("appRoot", () => {
  it("is the app's folder in the image for each builder", () => {
    expect(appRoot(plan("buildpacks"))).toBe("/workspace");
    expect(appRoot(plan("railpack"))).toBe("/app");
    expect(appRoot(plan("generated-dockerfile"))).toBe("/app");
    expect(appRoot(plan("own-dockerfile", { workdir: "/srv/app" }))).toBe("/srv/app");
    // An own Dockerfile without a known WORKDIR, or a plan without a builder: unknown.
    expect(appRoot(plan("own-dockerfile"))).toBeUndefined();
    expect(appRoot(plan())).toBeUndefined();
  });

  it("is the app's subfolder in a generated Node.js image, which holds the whole repository", () => {
    const sub = { dockerfile: "apps/web/Dockerfile" };
    expect(appRoot(plan("generated-dockerfile", sub))).toBe("/app/apps/web");
    // A Python image holds only the app's folder, at /app.
    expect(appRoot(plan("generated-dockerfile", { ...sub, language: "python" }))).toBe("/app");
    // Railpack and Buildpacks build the app's folder, or the whole repository for a JavaScript
    // workspace member.
    expect(appRoot(plan("railpack", { ...sub, buildContext: "apps/web" }))).toBe("/app");
    expect(appRoot(plan("railpack", sub))).toBe("/app/apps/web");
    expect(appRoot(plan("buildpacks", sub))).toBe("/workspace/apps/web");
    const [dockerfile] = renderDockerAssets(
      facts({ appDir: "apps/web", frameworks: [{ name: "express", path: "apps/web" }] }),
      { appPort: 3000, healthPath: "/health" },
    );
    expect(dockerfile?.path).toBe("apps/web/Dockerfile");
    const runtime = dockerfile?.content.split(/^FROM /m).at(-1) ?? "";
    expect(runtime).toContain("WORKDIR /app\n");
    expect(runtime).toContain("COPY --from=build --chown=node:node /app ./");
  });

  it("is the WORKDIR of the runtime stage of OpsCrew's generated Dockerfiles", () => {
    const root = appRoot(plan("generated-dockerfile"));
    for (const app of [
      facts({ frameworks: [{ name: "express", path: "." }] }),
      facts({
        languages: ["python"],
        packageManager: "pip",
        frameworks: [{ name: "django", path: "." }],
      }),
    ]) {
      const [dockerfile] = renderDockerAssets(app, { appPort: 3000, healthPath: "/health" });
      const stages = dockerfile?.content.split(/^FROM /m) ?? [];
      expect(stages.at(-1)).toContain(`WORKDIR ${root}\n`);
    }
  });
});
