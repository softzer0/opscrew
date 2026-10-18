import type { AppBuild, DeployPlan, ProjectFacts } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { testPlan } from "../__fixtures__/plans";
import { renderDependabot } from "./index";

function facts(overrides: Partial<ProjectFacts>): ProjectFacts {
  return {
    name: "app",
    languages: ["javascript"],
    packageManager: "npm",
    frameworks: [],
    appKind: "api",
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

function plan(
  builder: AppBuild["builder"],
  language: AppBuild["runtime"]["language"],
  app: Partial<DeployPlan["app"]> = {},
): DeployPlan {
  const base = testPlan();
  const version = { node: "24", python: "3.14", go: "1.26", ruby: "3.4", php: "8.4" }[
    language as string
  ];
  return {
    ...base,
    app: {
      ...base.app,
      ...app,
      build: {
        builder,
        chosen: "auto",
        reason: "test",
        runtime: { language, version: version ?? "1" },
      },
    },
  };
}

/** One sample per kind of example in `examples/`. */
const EXAMPLES: Record<string, [ProjectFacts, DeployPlan]> = {
  "nextjs-postgres (npm)": [
    facts({ frameworks: [{ name: "next", path: "." }] }),
    plan("generated-dockerfile", "node"),
  ],
  "static-vite (pnpm)": [
    facts({ packageManager: "pnpm", appKind: "static-spa" }),
    plan("generated-dockerfile", "node"),
  ],
  "monorepo-two-apps (pnpm workspace member)": [
    facts({ packageManager: "pnpm", monorepo: true, appDir: "apps/web" }),
    plan("generated-dockerfile", "node", { dockerfile: "apps/web/Dockerfile" }),
  ],
  "fastapi-redis (pip)": [
    facts({ languages: ["python"], packageManager: "pip" }),
    plan("generated-dockerfile", "python"),
  ],
  "fastapi-sqlmodel (uv)": [
    facts({ languages: ["python"], packageManager: "uv" }),
    plan("generated-dockerfile", "python"),
  ],
  "go-api (Buildpacks)": [
    facts({ languages: ["go"], packageManager: "none" }),
    plan("buildpacks", "go"),
  ],
  "rails-api (Buildpacks, with yarn)": [
    facts({ languages: ["javascript", "ruby"], packageManager: "yarn" }),
    plan("buildpacks", "ruby"),
  ],
  "laravel-app (Railpack)": [
    facts({ languages: ["php"], packageManager: "npm" }),
    plan("railpack", "php"),
  ],
  "spring-boot-api (Buildpacks)": [
    facts({ languages: ["java"], packageManager: "none" }),
    plan("buildpacks", "java"),
  ],
  "dotnet-api (Buildpacks)": [
    facts({ languages: ["other"], packageManager: "none" }),
    plan("buildpacks", "dotnet"),
  ],
  "rust-api (own Dockerfile)": [
    facts({ languages: ["rust"], packageManager: "none" }),
    plan("own-dockerfile", "rust"),
  ],
};

interface Update {
  "package-ecosystem": string;
  directory?: string;
  directories?: string[];
  schedule: { interval: string };
  groups: Record<string, { patterns: string[]; "update-types": string[] }>;
  ignore?: { "dependency-name": string; "update-types": string[] }[];
}

function updates(sample: ProjectFacts, deployPlan: DeployPlan): Update[] {
  const file = renderDependabot(sample, deployPlan);
  expect(file.path).toBe(".github/dependabot.yml");
  const config = parse(file.content) as { version: number; updates: Update[] };
  expect(config.version).toBe(2);
  return config.updates;
}

const entries = (list: Update[]) =>
  list.map((u) => `${u["package-ecosystem"]} ${u.directory ?? u.directories?.join(",")}`);

describe("renderDependabot", () => {
  for (const [name, [sample, deployPlan]] of Object.entries(EXAMPLES)) {
    it(`renders ${name}`, () => {
      const file = renderDependabot(sample, deployPlan);
      expect(file.content).toMatchSnapshot();
      expect(file.content.endsWith("\n")).toBe(true);
      for (const update of updates(sample, deployPlan)) {
        // Weekly, minor and patch updates grouped per ecosystem.
        expect(update.schedule).toEqual({ interval: "weekly" });
        expect(Object.values(update.groups)).toEqual([
          { patterns: ["*"], "update-types": ["minor", "patch"] },
        ]);
      }
    });
  }

  it("lists the app's ecosystem, its Dockerfile, the runtime folder and the actions", () => {
    const [sample, deployPlan] = EXAMPLES["monorepo-two-apps (pnpm workspace member)"] as [
      ProjectFacts,
      DeployPlan,
    ];
    // A workspace member's dependencies are in the root lockfile.
    expect(entries(updates(sample, deployPlan))).toEqual([
      "npm /",
      "docker /apps/web",
      "docker-compose /opscrew/runtime,/opscrew/runtime/*",
      "github-actions /",
    ]);
    // An app in a folder that is not a workspace has its manifest there.
    const folder = facts({ languages: ["python"], packageManager: "poetry", appDir: "api" });
    expect(entries(updates(folder, plan("generated-dockerfile", "python")))[0]).toBe("pip /api");
  });

  it("covers each language the builders take", () => {
    const ecosystems = (name: string) => {
      const [sample, deployPlan] = EXAMPLES[name] as [ProjectFacts, DeployPlan];
      return updates(sample, deployPlan).map((u) => u["package-ecosystem"]);
    };
    expect(ecosystems("go-api (Buildpacks)")).toEqual([
      "gomod",
      "docker-compose",
      "github-actions",
    ]);
    expect(ecosystems("rails-api (Buildpacks, with yarn)")).toEqual([
      "npm",
      "bundler",
      "docker-compose",
      "github-actions",
    ]);
    expect(ecosystems("laravel-app (Railpack)")[1]).toBe("composer");
    expect(ecosystems("dotnet-api (Buildpacks)")[0]).toBe("nuget");
    expect(ecosystems("rust-api (own Dockerfile)").slice(0, 2)).toEqual(["cargo", "docker"]);
    expect(ecosystems("fastapi-sqlmodel (uv)")[0]).toBe("uv");
  });

  it("adds the Dockerfile only when the builder uses one", () => {
    const [sample] = EXAMPLES["nextjs-postgres (npm)"] as [ProjectFacts, DeployPlan];
    const has = (deployPlan: DeployPlan) =>
      updates(sample, deployPlan).some((u) => u["package-ecosystem"] === "docker");
    expect(has(plan("generated-dockerfile", "node"))).toBe(true);
    expect(has(plan("own-dockerfile", "node"))).toBe(true);
    expect(has(plan("buildpacks", "node"))).toBe(false);
    expect(has(plan("railpack", "node"))).toBe(false);
    // A plan from before the builder choice builds with the Dockerfile.
    expect(has(testPlan())).toBe(true);
  });

  it("proposes no major updates of the runtime base images", () => {
    const [sample, deployPlan] = EXAMPLES["nextjs-postgres (npm)"] as [ProjectFacts, DeployPlan];
    const list = updates(sample, deployPlan);
    for (const ecosystem of ["docker", "docker-compose"]) {
      const update = list.find((u) => u["package-ecosystem"] === ecosystem);
      const ignored = update?.ignore?.map((rule) => rule["dependency-name"]);
      expect(ignored, ecosystem).toEqual(expect.arrayContaining(["node", "python", "postgres"]));
      for (const rule of update?.ignore ?? []) {
        expect(rule["update-types"]).toEqual(["version-update:semver-major"]);
      }
    }
    expect(list.find((u) => u["package-ecosystem"] === "npm")?.ignore).toBeUndefined();
  });
});
