import { posix } from "node:path";
import {
  type DeployPlan,
  EnvironmentSchema,
  isServerlessTarget,
  type PackageManager,
  type ProjectFacts,
  type RuntimeLanguage,
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
 * The folders OpsCrew's Compose files are in (the cloudflared and Portainer ones one deeper) for
 * the plan's app: prod's runtime folder, then the other `environments`' by name, each its plan's
 * {@link runtimeDir}. A Portainer target's stack template is committed here on the default branch
 * too, the only branch Dependabot reads; the orphan deploy branch Portainer deploys holds only its
 * copy. The shared edge (`<runtimeDir>/edge`) is left out: its pins move only with OpsCrew's
 * releases and its version stamp, which decides which app's copy a server keeps.
 */
function runtimeFolders(plan: DeployPlan, environments: readonly string[]): string[] {
  const named = [...new Set(environments)].filter((name) => name !== "prod").sort();
  const dirs = [undefined, ...named].map((name) =>
    runtimeDir({
      ...plan,
      environment: name === undefined ? undefined : EnvironmentSchema.parse({ name }),
    }),
  );
  return dirs.flatMap((dir) => [`/${dir}`, `/${dir}/cloudflared`, `/${dir}/portainer`]);
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

/** An app of the repository, for {@link renderDependabot}'s entries. */
export interface DependabotApp {
  /** The app's analysed facts (its `architecture.json`). */
  facts: ProjectFacts;
  /** One of the app's plans: its key, builder, Dockerfile and runtime. */
  plan: DeployPlan;
  /** A Java app's build tool. */
  javaBuild?: JavaBuild | undefined;
  /** The app's environments (`environmentsOf`), whose runtime folders are listed. */
  environments: readonly string[];
}

/**
 * `.github/dependabot.yml`, one file for the repository: weekly updates with minor and patch
 * versions grouped, for each app one entry per detected ecosystem and folder plus its Dockerfile
 * (when the builder uses one), then the Compose files in every app's environments' runtime folders
 * and the GitHub Actions. An app on a server-less target has no image and no runtime folder, so
 * only its package ecosystem. Runtime base images get no major updates. A Java app's entry needs its
 * build tool, `javaBuild` (`pom.xml` or `build.gradle[.kts]`). `environments` names the app's
 * environments whose runtime folders it lists besides prod's (by default the plan's own):
 * `environmentsOf`, so that every environment's provision writes the same file. `others` are the
 * repository's other apps (`appsOf`); the apps come in the repository's order (the first app, then
 * the further apps by key), so every app's provision writes the same file too. An entry two apps
 * share is listed once. The caller adds the file only when the repository has no Dependabot
 * configuration.
 */
export function renderDependabot(
  facts: ProjectFacts,
  plan: DeployPlan,
  javaBuild?: JavaBuild,
  environments: readonly string[] = [plan.environment?.name ?? "prod"],
  others: readonly DependabotApp[] = [],
): RenderedFile {
  const key = (app: DependabotApp) => app.plan.app.key ?? "";
  const apps = [{ facts, plan, javaBuild, environments }, ...others].sort((a, b) =>
    key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0,
  );
  const entries: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  const add = (ecosystem: string | undefined, directory: string, ignoreMajors = false) => {
    if (ecosystem === undefined || seen.has(`${ecosystem} ${directory}`)) return;
    seen.add(`${ecosystem} ${directory}`);
    entries.push(update(ecosystem, { directory }, ignoreMajors));
  };

  for (const app of apps) {
    const appDir = rooted(appDirectory(app.facts));
    const pm = PACKAGE_MANAGER_ECOSYSTEM[app.facts.packageManager];
    // A workspace member's JavaScript dependencies are in the root lockfile.
    const jsWorkspace = app.facts.monorepo && (pm === "npm" || pm === "bun");
    add(pm, jsWorkspace ? "/" : appDir);
    // A server-less site has no image and no Compose files: only its packages.
    if (isServerlessTarget(app.plan.target)) continue;
    const runtime = app.plan.app.build?.runtime.language;
    add(runtime === "java" ? app.javaBuild : runtime && RUNTIME_ECOSYSTEM[runtime], appDir);
    const builder = app.plan.app.build?.builder;
    if (
      builder === undefined ||
      builder === "generated-dockerfile" ||
      builder === "own-dockerfile"
    ) {
      add("docker", rooted(posix.dirname(app.plan.app.dockerfile)), true);
    }
  }
  const compose = apps
    .filter((app) => !isServerlessTarget(app.plan.target))
    .flatMap((app) => runtimeFolders(app.plan, app.environments));
  if (compose.length > 0) {
    entries.push(update("docker-compose", { directories: compose }, true));
  }
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
