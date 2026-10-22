import { posix } from "node:path";
import type {
  DeployPlan,
  PackageManager,
  ProjectFacts,
  RuntimeLanguage,
} from "@opscrew/plan-schema";
import { stringify } from "yaml";
import { imageName, SERVICE_SPECS, serviceSpec } from "../catalog";
import { appDirectory } from "../docker/stacks";
import { runtimeDir } from "../runtime-dir";
import type { RenderedFile } from "../types";

/** Dependabot ecosystem of each package manager detection reports. */
const PACKAGE_MANAGER_ECOSYSTEM: Partial<Record<PackageManager, string>> = {
  npm: "npm",
  pnpm: "npm",
  yarn: "npm",
  bun: "bun",
  pip: "pip",
  poetry: "pip",
  pipenv: "pip",
  uv: "uv",
};

/**
 * Dependabot ecosystem of each runtime whose packages no detected package manager covers. Java's
 * is its build tool, which the caller names ({@link JavaBuild}).
 */
const RUNTIME_ECOSYSTEM: Partial<Record<RuntimeLanguage, string>> = {
  ruby: "bundler",
  go: "gomod",
  php: "composer",
  rust: "cargo",
  dotnet: "nuget",
};

/**
 * Images whose major versions are the user's to change (FR-1228 rule 6, FR-1326): the runtime base
 * images of OpsCrew's Dockerfiles, and the catalog's services marked `majorLocked` (databases,
 * queues and brokers whose data a new major may not read). Dependabot proposes no major update
 * for them, and a carried-over pin keeps their committed major.
 */
export const NO_MAJOR_UPDATES: readonly string[] = [
  "caddy",
  "node",
  "python",
  ...SERVICE_SPECS.filter((spec) => spec.majorLocked).map(imageName),
].sort();

/**
 * Images of {@link NO_MAJOR_UPDATES} whose minor versions are the user's too: a new Meilisearch
 * minor can need its data dumped and imported again.
 */
export const NO_MINOR_UPDATES: readonly string[] = [imageName(serviceSpec("meilisearch"))];

/**
 * The folders OpsCrew's Compose files are in (the cloudflared and Portainer ones one deeper):
 * prod's runtime folder, and a named environment's plan adds its own ({@link runtimeDir}). A
 * Portainer target's stack template is committed here on the default branch too, the only branch
 * Dependabot reads; the orphan deploy branch Portainer deploys holds only its copy. The shared
 * edge (`<runtimeDir>/edge`) is left out: its pins move only with OpsCrew's releases and its
 * version stamp, which decides which app's copy a server keeps.
 */
function runtimeFolders(plan: DeployPlan): string[] {
  const own = plan.environment?.name === undefined ? [] : [runtimeDir(plan)];
  return ["opscrew/runtime", ...own].flatMap((dir) => [
    `/${dir}`,
    `/${dir}/cloudflared`,
    `/${dir}/portainer`,
  ]);
}

function update(
  ecosystem: string,
  where: { directory: string } | { directories: string[] },
  ignoreMajors = false,
): Record<string, unknown> {
  return {
    "package-ecosystem": ecosystem,
    ...where,
    schedule: { interval: "weekly" },
    groups: {
      [`${ecosystem}-minor-and-patch`]: { patterns: ["*"], "update-types": ["minor", "patch"] },
    },
    ...(ignoreMajors
      ? {
          ignore: NO_MAJOR_UPDATES.map((name) => ({
            "dependency-name": name,
            "update-types": [
              "version-update:semver-major",
              ...(NO_MINOR_UPDATES.includes(name) ? ["version-update:semver-minor"] : []),
            ],
          })),
        }
      : {}),
  };
}

/** `/<dir>` for a normalised repo-relative folder (`/` for the root). */
function rooted(dir: string): string {
  return dir === "." ? "/" : `/${dir}`;
}

/** The build tool of a Java app, which is also its Dependabot ecosystem. */
export type JavaBuild = "maven" | "gradle";

/**
 * `.github/dependabot.yml`: weekly updates with minor and patch versions grouped, one entry per
 * detected ecosystem and folder, plus the Dockerfile (when the builder uses one), the Compose files
 * in `opscrew/runtime` (and a named environment's own runtime folder) and the GitHub Actions. Runtime base images get no major updates. A Java
 * app's entry needs its build tool, `javaBuild` (`pom.xml` or `build.gradle[.kts]`). The caller
 * adds the file only when the repository has no Dependabot configuration.
 */
export function renderDependabot(
  facts: ProjectFacts,
  plan: DeployPlan,
  javaBuild?: JavaBuild,
): RenderedFile {
  const entries: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  const add = (ecosystem: string | undefined, directory: string) => {
    if (ecosystem === undefined || seen.has(`${ecosystem} ${directory}`)) return;
    seen.add(`${ecosystem} ${directory}`);
    entries.push(update(ecosystem, { directory }));
  };

  const appDir = rooted(appDirectory(facts));
  const pm = PACKAGE_MANAGER_ECOSYSTEM[facts.packageManager];
  // A workspace member's JavaScript dependencies are in the root lockfile.
  const jsWorkspace = facts.monorepo && (pm === "npm" || pm === "bun");
  add(pm, jsWorkspace ? "/" : appDir);
  const runtime = plan.app.build?.runtime.language;
  add(runtime === "java" ? javaBuild : runtime && RUNTIME_ECOSYSTEM[runtime], appDir);

  const builder = plan.app.build?.builder;
  if (builder === undefined || builder === "generated-dockerfile" || builder === "own-dockerfile") {
    entries.push(update("docker", { directory: rooted(posix.dirname(plan.app.dockerfile)) }, true));
  }
  entries.push(update("docker-compose", { directories: runtimeFolders(plan) }, true));
  entries.push(update("github-actions", { directory: "/" }));

  const header = [
    "# Generated by OpsCrew: weekly dependency updates, with minor and patch versions grouped per",
    "# ecosystem. Major versions of the runtime images and of the databases, queues and brokers are",
    "# left to you: change them when your code and data are ready for them. You own this file;",
    "# OpsCrew only creates it when missing.",
  ].join("\n");
  return {
    path: ".github/dependabot.yml",
    content: `${header}\n${stringify({ version: 2, updates: entries }, { lineWidth: 0 })}`,
    kind: "workflow",
  };
}
