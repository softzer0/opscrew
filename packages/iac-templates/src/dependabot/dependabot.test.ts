import type { AppBuild, DeployPlan, ProjectFacts } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { designProbe, testPlan } from "../__fixtures__/plans";
import { SERVICE_SPECS } from "../catalog";
import { portainerTestPlan } from "../portainer-target/__fixtures__/plans";
import { portainerStackTemplatePath } from "../portainer-target/stack";
import { cloudflarePlan, pagesPlan, ssrPlan } from "../serverless/__fixtures__/plans";
import { inEnvironment, ofApp } from "../workflow/__fixtures__/plans";
import { NO_MAJOR_UPDATES, renderDependabot } from "./index";

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
        probe: designProbe(builder, language),
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
      "docker-compose /opscrew/runtime,/opscrew/runtime/cloudflared,/opscrew/runtime/portainer",
      "github-actions /",
    ]);
    // An app in a folder that is not a workspace has its manifest there.
    const folder = facts({ languages: ["python"], packageManager: "poetry", appDir: "api" });
    expect(entries(updates(folder, plan("generated-dockerfile", "python")))[0]).toBe("pip /api");
  });

  it("watches a Portainer target's stack template, committed in opscrew/runtime", () => {
    // Dependabot reads only the default branch. The deploy-setup pull request commits the stack
    // template there; the `opscrew-deploy` branch only gets the copy with each new image.
    expect(portainerStackTemplatePath(portainerTestPlan())).toBe("opscrew/runtime/compose.yaml");
    expect(entries(updates(facts({}), portainerTestPlan()))).toContain(
      "docker-compose /opscrew/runtime,/opscrew/runtime/cloudflared,/opscrew/runtime/portainer",
    );
  });

  it("adds a named environment's own runtime folder to prod's", () => {
    const staging = inEnvironment(portainerTestPlan(), { name: "staging" });
    const compose = updates(facts({}), staging).find(
      (u) => u["package-ecosystem"] === "docker-compose",
    );
    expect(compose?.directories).toEqual([
      "/opscrew/runtime",
      "/opscrew/runtime/cloudflared",
      "/opscrew/runtime/portainer",
      "/opscrew/environments/staging/runtime",
      "/opscrew/environments/staging/runtime/cloudflared",
      "/opscrew/environments/staging/runtime/portainer",
    ]);
    // Prod's plan with its environment block renders prod's file.
    const prod = inEnvironment(portainerTestPlan(), {});
    expect(renderDependabot(facts({}), prod)).toEqual(
      renderDependabot(facts({}), portainerTestPlan()),
    );
  });

  it("lists every environment's runtime folder, so each environment's provision writes the same file", () => {
    const names = ["prod", "staging", "dev"];
    const prod = renderDependabot(facts({}), portainerTestPlan(), undefined, names);
    const staging = inEnvironment(portainerTestPlan(), { name: "staging" });
    expect(renderDependabot(facts({}), staging, undefined, names)).toEqual(prod);
    const compose = (parse(prod.content) as { updates: Update[] }).updates.find(
      (u) => u["package-ecosystem"] === "docker-compose",
    );
    // Prod's folder first, then the named environments' by name.
    expect(compose?.directories).toEqual([
      "/opscrew/runtime",
      "/opscrew/runtime/cloudflared",
      "/opscrew/runtime/portainer",
      "/opscrew/environments/dev/runtime",
      "/opscrew/environments/dev/runtime/cloudflared",
      "/opscrew/environments/dev/runtime/portainer",
      "/opscrew/environments/staging/runtime",
      "/opscrew/environments/staging/runtime/cloudflared",
      "/opscrew/environments/staging/runtime/portainer",
    ]);
    // An app with prod only renders today's file.
    expect(renderDependabot(facts({}), portainerTestPlan(), undefined, ["prod"])).toEqual(
      renderDependabot(facts({}), portainerTestPlan()),
    );
  });

  describe("with several apps in the repository", () => {
    // The first app, a pnpm workspace member with prod and staging, and the further app api, a uv
    // app with prod alone.
    const web = facts({ packageManager: "pnpm", monorepo: true, appDir: "apps/web" });
    const webPlan = plan("generated-dockerfile", "node", { dockerfile: "apps/web/Dockerfile" });
    const api = facts({ languages: ["python"], packageManager: "uv", appDir: "apps/api" });
    const apiPlan = plan("generated-dockerfile", "python", {
      key: "api",
      name: "api",
      dockerfile: "apps/api/Dockerfile",
    });

    it("covers every app's folders in one file", () => {
      const file = renderDependabot(
        web,
        webPlan,
        undefined,
        ["prod", "staging"],
        [{ facts: api, plan: apiPlan, environments: ["prod"] }],
      );
      const list = (parse(file.content) as { updates: Update[] }).updates;
      expect(entries(list)).toEqual([
        "npm /",
        "docker /apps/web",
        "uv /apps/api",
        "docker /apps/api",
        [
          "docker-compose /opscrew/runtime",
          "/opscrew/runtime/cloudflared",
          "/opscrew/runtime/portainer",
          "/opscrew/environments/staging/runtime",
          "/opscrew/environments/staging/runtime/cloudflared",
          "/opscrew/environments/staging/runtime/portainer",
          "/opscrew/apps/api/runtime",
          "/opscrew/apps/api/runtime/cloudflared",
          "/opscrew/apps/api/runtime/portainer",
        ].join(","),
        "github-actions /",
      ]);
      // Each Dockerfile's base images keep their majors.
      for (const update of list.filter((u) => u["package-ecosystem"] === "docker")) {
        expect(update.ignore?.map((rule) => rule["dependency-name"])).toEqual(NO_MAJOR_UPDATES);
      }
      expect(file.content).toMatchSnapshot();
    });

    it("is the same file whichever app's provision renders it", () => {
      const fromWeb = renderDependabot(
        web,
        webPlan,
        undefined,
        ["prod", "staging"],
        [{ facts: api, plan: apiPlan, environments: ["prod"] }],
      );
      const fromApi = renderDependabot(
        api,
        apiPlan,
        undefined,
        ["prod"],
        [{ facts: web, plan: webPlan, environments: ["prod", "staging"] }],
      );
      expect(fromApi).toEqual(fromWeb);
    });

    it("lists an entry two apps share once", () => {
      const docs = facts({ packageManager: "pnpm", monorepo: true, appDir: "apps/docs" });
      const docsPlan = plan("generated-dockerfile", "node", {
        key: "docs",
        name: "docs",
        dockerfile: "apps/docs/Dockerfile",
      });
      const file = renderDependabot(
        web,
        webPlan,
        undefined,
        ["prod"],
        [{ facts: docs, plan: docsPlan, environments: ["prod"] }],
      );
      // Both workspace members' JavaScript dependencies are in the root lockfile.
      expect(entries((parse(file.content) as { updates: Update[] }).updates).slice(0, 3)).toEqual([
        "npm /",
        "docker /apps/web",
        "docker /apps/docs",
      ]);
    });
  });

  it("gives a server-less site only its packages and the actions: no image, no Compose files", () => {
    const site = facts({ packageManager: "pnpm", appKind: "static-spa" });
    for (const serverless of [cloudflarePlan(), ssrPlan(), pagesPlan()]) {
      expect(entries(updates(site, serverless))).toEqual(["npm /", "github-actions /"]);
    }
    // A Hugo site has no package manager: only the actions.
    expect(entries(updates(facts({ packageManager: "none" }), pagesPlan()))).toEqual([
      "github-actions /",
    ]);
    // Beside a server app, only the server app's runtime folders.
    const web = facts({ packageManager: "pnpm", monorepo: true, appDir: "apps/web" });
    const webPlan = plan("generated-dockerfile", "node", { dockerfile: "apps/web/Dockerfile" });
    const docs = facts({ packageManager: "npm", appDir: "apps/docs", appKind: "static-spa" });
    const file = renderDependabot(
      web,
      webPlan,
      undefined,
      ["prod"],
      [{ facts: docs, plan: ofApp(cloudflarePlan(), "docs"), environments: ["prod", "staging"] }],
    );
    expect(entries((parse(file.content) as { updates: Update[] }).updates)).toEqual([
      "npm /",
      "docker /apps/web",
      "npm /apps/docs",
      "docker-compose /opscrew/runtime,/opscrew/runtime/cloudflared,/opscrew/runtime/portainer",
      "github-actions /",
    ]);
  });

  it("leaves the shared edge out: its pins move only with OpsCrew's version stamp", () => {
    const [sample, deployPlan] = EXAMPLES["monorepo-two-apps (pnpm workspace member)"] as [
      ProjectFacts,
      DeployPlan,
    ];
    const compose = updates(sample, deployPlan).find(
      (u) => u["package-ecosystem"] === "docker-compose",
    );
    for (const dir of compose?.directories ?? []) {
      expect(dir).not.toContain("*");
      expect(dir.startsWith("/opscrew/runtime/edge")).toBe(false);
    }
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

  it("adds Maven or Gradle for a Java app when the caller names its build tool", () => {
    const [sample, deployPlan] = EXAMPLES["spring-boot-api (Buildpacks)"] as [
      ProjectFacts,
      DeployPlan,
    ];
    const maven = renderDependabot(sample, deployPlan, "maven");
    expect(maven.content).toMatchSnapshot();
    const ecosystems = (content: string) =>
      (parse(content) as { updates: Update[] }).updates.map((u) => entries([u])[0]);
    expect(ecosystems(maven.content)[0]).toBe("maven /");
    expect(ecosystems(renderDependabot(sample, deployPlan, "gradle").content)[0]).toBe("gradle /");
    // The build tool means nothing for another language.
    const [go, goPlan] = EXAMPLES["go-api (Buildpacks)"] as [ProjectFacts, DeployPlan];
    expect(renderDependabot(go, goPlan, "maven").content).toBe(
      renderDependabot(go, goPlan).content,
    );
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
        expect(rule["update-types"]?.[0]).toBe("version-update:semver-major");
      }
    }
    expect(list.find((u) => u["package-ecosystem"] === "npm")?.ignore).toBeUndefined();
  });

  it("proposes no major updates of the catalog's services whose majors are the user's", () => {
    const locked = SERVICE_SPECS.filter((spec) => spec.majorLocked).map((spec) => spec.kind);
    expect(locked).toEqual([
      "postgres",
      "redis",
      "dragonfly",
      "mysql",
      "mariadb",
      "mongodb",
      "rabbitmq",
      "nats",
      "kafka",
      "redpanda",
      "garage",
      "opensearch",
      "elasticsearch",
      "meilisearch",
      "typesense",
      "clickhouse",
    ]);
    expect(NO_MAJOR_UPDATES).toEqual([
      "apache/kafka",
      "caddy",
      "clickhouse",
      "dragonflydb/dragonfly",
      "dxflrs/garage",
      "elasticsearch",
      "getmeili/meilisearch",
      "mariadb",
      "mongo",
      "mysql",
      "nats",
      "node",
      "opensearchproject/opensearch",
      "postgres",
      "python",
      "rabbitmq",
      "redis",
      "redpandadata/redpanda",
      "typesense/typesense",
    ]);
    const [sample, deployPlan] = EXAMPLES["nextjs-postgres (npm)"] as [ProjectFacts, DeployPlan];
    const compose = updates(sample, deployPlan).find(
      (u) => u["package-ecosystem"] === "docker-compose",
    );
    expect(compose?.ignore?.map((rule) => rule["dependency-name"])).toEqual(NO_MAJOR_UPDATES);
  });

  it("proposes no minor update of Meilisearch either: a new minor can need a dump and import", () => {
    const [sample, deployPlan] = EXAMPLES["nextjs-postgres (npm)"] as [ProjectFacts, DeployPlan];
    const compose = updates(sample, deployPlan).find(
      (u) => u["package-ecosystem"] === "docker-compose",
    );
    const rule = (name: string) =>
      compose?.ignore?.find((item) => item["dependency-name"] === name)?.["update-types"];
    expect(rule("getmeili/meilisearch")).toEqual([
      "version-update:semver-major",
      "version-update:semver-minor",
    ]);
    expect(rule("typesense/typesense")).toEqual(["version-update:semver-major"]);
  });
});
