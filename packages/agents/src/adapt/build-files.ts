import { join } from "node:path";
import { exists, readTextIfExists } from "@opscrew/core";
import {
  type DockerAssetOptions,
  imageDigest,
  type JavaBuild,
  type RenderedFile,
  renderDependabot,
  renderDockerAssets,
} from "@opscrew/iac-templates";
import type { DeployPlan, ImageBuilder, ProjectFacts, RuntimeLanguage } from "@opscrew/plan-schema";
import { parse } from "yaml";
import { z } from "zod";
import type { PhaseDeps } from "../context";
import { BUILDER_NAMES } from "../design/builder";
import { appDirOf, under } from "../design/code-changes";

/**
 * The note on the plan's Dockerfile change when another builder builds the image, or undefined
 * when OpsCrew writes its Dockerfile (`generated-dockerfile`, or a plan without a builder yet).
 */
export function noDockerfileNote(
  builder: ImageBuilder | undefined,
  dockerfile: string,
): string | undefined {
  switch (builder) {
    case "buildpacks":
    case "railpack":
      return `${BUILDER_NAMES[builder]} ${NO_DOCKERFILE_NEEDED}.`;
    case "own-dockerfile":
      return `The image is built with your own Dockerfile (${dockerfile}), so OpsCrew wrote none.`;
    default:
      return undefined;
  }
}

/** After the name of a builder that needs no Dockerfile (Buildpacks, Railpack). */
export const NO_DOCKERFILE_NEEDED =
  "builds the image from the code, so the app needs no Dockerfile";

/** After the path of the user's own Dockerfile when it has no baseline finding. */
export const BASELINE_MET =
  "meets OpsCrew's image baseline: a non-root user, base images pinned by digest and no secret in ENV or ARG";

/**
 * `Dockerfile` (with `options.dockerfile`), `.dockerignore` and `.env.example` for the plan's app
 * (`renderDockerAssets`). A runtime image OpsCrew has no pin for (a declared non-default version)
 * is pinned by the digest its registry reports through `deps.fetch`; offline, or when the lookup
 * fails, it keeps its tag only, and `options.warn` says so. Throws `INVALID_INPUT` when the
 * Dockerfile is wanted and OpsCrew has no template for the stack.
 */
export async function renderDockerFiles(
  deps: Pick<PhaseDeps, "fetch">,
  facts: ProjectFacts,
  plan: DeployPlan,
  { dockerfile, warn }: { dockerfile: boolean; warn: (text: string) => void },
): Promise<RenderedFile[]> {
  const options: DockerAssetOptions = {
    appPort: plan.app.port,
    healthPath: plan.app.healthPath,
    app: plan.app,
    dockerfile,
  };
  // The images the templates have no pin for, found by rendering once without digests.
  const unpinned = new Set<string>();
  renderDockerAssets(facts, {
    ...options,
    resolveImageDigest: (ref) => {
      unpinned.add(ref);
      return undefined;
    },
  });
  const digests = new Map<string, string>();
  for (const ref of unpinned) {
    const at = ref.lastIndexOf(":");
    try {
      digests.set(ref, await imageDigest(deps.fetch, ref.slice(0, at), ref.slice(at + 1)));
    } catch (error) {
      const why = error instanceof Error ? ` (${error.message})` : "";
      warn(
        `OpsCrew could not look up the digest of ${ref}${why}, so the Dockerfile pins it by tag only. Its header says how to add the digest.`,
      );
    }
  }
  return renderDockerAssets(facts, { ...options, resolveImageDigest: (ref) => digests.get(ref) });
}

/** The places Dependabot reads its configuration from. */
const DEPENDABOT_FILES = [".github/dependabot.yml", ".github/dependabot.yaml"];

const DependabotConfigSchema = z.object({
  updates: z
    .array(
      z.object({
        "package-ecosystem": z.string(),
        directory: z.string().optional(),
        directories: z.array(z.string()).optional(),
      }),
    )
    .default([]),
});
type DependabotEntry = z.infer<typeof DependabotConfigSchema>["updates"][number];

/** What adapt does about Dependabot: write OpsCrew's file, or leave the user's as it is. */
export type DependabotStep =
  | { action: "write"; file: RenderedFile }
  | {
      action: "keep";
      path: string;
      /** The entries OpsCrew's file has and the user's lacks (`npm in /`); undefined if unreadable. */
      missing?: string[];
    };

const folders = (entry: DependabotEntry) =>
  [entry.directory, ...(entry.directories ?? [])]
    .filter((dir) => dir !== undefined)
    .map((dir) => (dir.length > 1 ? dir.replace(/\/+$/, "") : dir));

/** The first of `names` in the app's folder or the repository root (nearest first). */
async function findInApp(
  root: string,
  facts: ProjectFacts,
  names: readonly string[],
): Promise<string | undefined> {
  for (const folder of new Set([appDirOf(facts), "."])) {
    for (const name of names) {
      if (await exists(join(root, under(folder, name)))) return name;
    }
  }
  return undefined;
}

/** A Java app's build tool, from its build file: `pom.xml` (Maven) or `build.gradle[.kts]`. */
async function javaBuildOf(root: string, facts: ProjectFacts): Promise<JavaBuild | undefined> {
  const found = await findInApp(root, facts, ["pom.xml", "build.gradle", "build.gradle.kts"]);
  return found === undefined ? undefined : found === "pom.xml" ? "maven" : "gradle";
}

/**
 * `.github/dependabot.yml` (`renderDependabot`, with a Java app's build tool) when the repository
 * has no Dependabot configuration (FR-1221); otherwise the user's stays as it is, with the entries
 * OpsCrew's would add that it lacks: an ecosystem with a folder no entry of that ecosystem lists.
 */
export async function dependabotStep(
  root: string,
  facts: ProjectFacts,
  plan: DeployPlan,
): Promise<DependabotStep> {
  const java =
    plan.app.build?.runtime.language === "java" ? await javaBuildOf(root, facts) : undefined;
  const file = renderDependabot(facts, plan, java);
  for (const path of DEPENDABOT_FILES) {
    const text = await readTextIfExists(join(root, path));
    if (text === undefined) continue;
    let config: z.infer<typeof DependabotConfigSchema>;
    try {
      config = DependabotConfigSchema.parse(parse(text) ?? {});
    } catch {
      return { action: "keep", path };
    }
    const wanted = DependabotConfigSchema.parse(parse(file.content)).updates;
    const missing = wanted.flatMap((entry) => {
      const ecosystem = entry["package-ecosystem"];
      const have = new Set(
        config.updates.filter((e) => e["package-ecosystem"] === ecosystem).flatMap(folders),
      );
      const lacking = folders(entry).filter((dir) => !have.has(dir));
      return lacking.length === 0 ? [] : [`${ecosystem} in ${lacking.join(" and ")}`];
    });
    return { action: "keep", path, missing };
  }
  return { action: "write", file };
}

/**
 * Per language with a version file of its own: the file adapt adds and the other files that
 * already declare the version. The other languages declare it in their build file (`go.mod`,
 * `pom.xml`, the project file, `composer.json`).
 */
const VERSION_FILES: Partial<
  Record<RuntimeLanguage, { file: string; others: string[]; content?: (v: string) => string }>
> = {
  node: { file: ".nvmrc", others: [".node-version"] },
  python: { file: ".python-version", others: ["runtime.txt"] },
  ruby: { file: ".ruby-version", others: [] },
  rust: {
    file: "rust-toolchain.toml",
    others: ["rust-toolchain"],
    content: (version) => `[toolchain]\nchannel = "${version}"\n`,
  },
};

/**
 * The runtime version file (`.nvmrc`, `.python-version`, `.ruby-version`,
 * `rust-toolchain.toml`) in the app's folder with the version recorded in `app.build.runtime`,
 * when neither that folder nor the repository root has one (FR-1228 rule 5); undefined otherwise.
 */
export async function runtimeVersionFile(
  root: string,
  facts: ProjectFacts,
  plan: DeployPlan,
): Promise<RenderedFile | undefined> {
  const runtime = plan.app.build?.runtime;
  const kind = runtime === undefined ? undefined : VERSION_FILES[runtime.language];
  if (runtime?.version === undefined || kind === undefined) return undefined;
  if ((await findInApp(root, facts, [kind.file, ...kind.others])) !== undefined) return undefined;
  return {
    path: under(appDirOf(facts), kind.file),
    content: kind.content?.(runtime.version) ?? `${runtime.version}\n`,
    kind: "docker",
  };
}
