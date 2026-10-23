import { join } from "node:path";
import {
  exists,
  listText,
  readTextIfExists,
  resolveProjectPaths,
  toPosixRelative,
} from "@opscrew/core";
import {
  type DependabotApp,
  type JavaBuild,
  type RenderedFile,
  renderDependabot,
} from "@opscrew/iac-templates";
import {
  appsOf,
  type DeployPlan,
  environmentsOf,
  type ProjectFacts,
  readOptionalArtifact,
} from "@opscrew/plan-schema";
import { parse } from "yaml";
import { z } from "zod";
import { findInApp } from "../adapt/build-files";
import { appFlag } from "../apps/choice";
import { appPaths } from "../apps/list";
import type { PhaseDeps } from "../context";

/** The places Dependabot reads its configuration from. */
const DEPENDABOT_FILES = [".github/dependabot.yml", ".github/dependabot.yaml"];

/**
 * A named environment's runtime folder in OpsCrew's file, with a further app's key (none for the
 * first app) and the environment's name captured.
 */
const ENVIRONMENT_RUNTIME =
  /\/opscrew(?:\/apps\/([a-z][a-z0-9-]*))?\/environments\/([a-z][a-z0-9-]*)\/runtime$/gm;

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

/** What provision does about Dependabot: add OpsCrew's file, or leave the user's as it is. */
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

/** A Java app's build tool, from its build file: `pom.xml` (Maven) or `build.gradle[.kts]`. */
async function javaBuildOf(
  root: string,
  facts: ProjectFacts,
  plan: DeployPlan,
): Promise<JavaBuild | undefined> {
  if (plan.app.build?.runtime.language !== "java") return undefined;
  const found = await findInApp(root, facts, ["pom.xml", "build.gradle", "build.gradle.kts"]);
  return found === undefined ? undefined : found === "pom.xml" ? "maven" : "gradle";
}

/**
 * The repository's apps other than `plan`'s (`appsOf`), each with its analysed facts, its prod
 * plan, a Java app's build tool and its environments; an app not analysed and designed yet has no
 * entries.
 */
async function otherApps(root: string, plan: DeployPlan): Promise<DependabotApp[]> {
  const repository = resolveProjectPaths(root, { env: {} });
  const others: DependabotApp[] = [];
  for (const { key } of await appsOf(root)) {
    if (key === plan.app.key) continue;
    const paths = appPaths(repository, key);
    const analysis = await readOptionalArtifact("architecture", paths.files.architecture);
    const prod = await readOptionalArtifact("plan", paths.files.plan);
    if (analysis === undefined || prod === undefined) continue;
    others.push({
      facts: analysis.facts,
      plan: prod,
      javaBuild: await javaBuildOf(root, analysis.facts, prod),
      environments: await environmentsOf(root, key),
    });
  }
  return others;
}

/**
 * OpsCrew's file as an earlier provision may have written it: for any of `apps` (one added since
 * is not in it yet), each with the environments the file `content` names for it (one added or
 * removed since differs). A repository has few apps, so every combination is rendered.
 */
function earlierFiles(content: string, apps: readonly DependabotApp[]): string[] {
  const named = new Map<string, string[]>();
  for (const [, key = "", name] of content.matchAll(ENVIRONMENT_RUNTIME)) {
    named.set(key, [...(named.get(key) ?? []), name as string]);
  }
  const listed = apps.map((app) => ({
    ...app,
    environments: ["prod", ...(named.get(app.plan.app.key ?? "") ?? [])],
  }));
  const files: string[] = [];
  // Every combination, the current app's left out too: the file an app's provision wrote before
  // the current app was added does not list it.
  for (let mask = 1; mask < 2 ** listed.length; mask++) {
    const [one, ...rest] = listed.filter((_, i) => (mask >> i) & 1);
    if (one === undefined) continue;
    files.push(
      renderDependabot(one.facts, one.plan, one.javaBuild, one.environments, rest).content,
    );
  }
  return files;
}

/**
 * `.github/dependabot.yml` (`renderDependabot`, with a Java app's build tool and every environment
 * of every app of the repository, so each app's and environment's provision renders the same file)
 * when the repository has no Dependabot configuration (FR-1221), or has OpsCrew's file unchanged
 * (written by a `--plan-only` run, or committed earlier, so committing it again leaves it as it
 * is), or OpsCrew's file for the apps and environments it names (committed before one was added or
 * removed, so it is brought up to date); otherwise the user's stays as it is, with the entries
 * OpsCrew's would add that it lacks: an ecosystem with a folder no entry of that ecosystem lists.
 */
export async function dependabotStep(
  root: string,
  facts: ProjectFacts,
  plan: DeployPlan,
): Promise<DependabotStep> {
  const java = await javaBuildOf(root, facts, plan);
  const environments = await environmentsOf(root, plan.app.key);
  const others = await otherApps(root, plan);
  const file = renderDependabot(facts, plan, java, environments, others);
  for (const path of DEPENDABOT_FILES) {
    const text = await readTextIfExists(join(root, path));
    if (text === undefined) continue;
    const content = text.replace(/\r\n/g, "\n");
    const apps = [{ facts, plan, javaBuild: java, environments }, ...others];
    const ours = content === file.content || earlierFiles(content, apps).includes(content);
    if (path === file.path && ours) return { action: "write", file };
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
      return lacking.length === 0 ? [] : [`${ecosystem} in ${listText(lacking)}`];
    });
    return { action: "keep", path, missing };
  }
  return { action: "write", file };
}

/**
 * The deploy-setup pull request's file-list line about Dependabot: the file OpsCrew added, or the
 * user's and the entries it lacks; none when there is nothing to say.
 */
export function dependabotPullRequestLines(step: DependabotStep | undefined): string[] {
  if (step?.action === "write") {
    return [
      `- \`${step.file.path}\`: weekly dependency updates, with minor and patch versions grouped; major versions of the runtime images are left to you.`,
    ];
  }
  if (step?.missing !== undefined && step.missing.length > 0) {
    return [
      `- \`${step.path}\` is yours and stays as it is; OpsCrew's would also update: ${step.missing.join(", ")}.`,
    ];
  }
  return [];
}

/**
 * {@link dependabotStep} for the deploy-setup pull request, which brings the workflow and the
 * runtime files Dependabot watches (FR-1221), with the app's facts from its `architecture.json`.
 * Says when the user's file stays as it is and what it lacks. Undefined, with a note, when there
 * is no `architecture.json`; undefined too when the run writes no files (`writes` false: it
 * applies a saved plan) and OpsCrew's file is not on disk, so there is nothing to commit.
 */
export async function deploySetupDependabot(
  deps: Pick<PhaseDeps, "paths" | "reporter" | "redactor">,
  plan: DeployPlan,
  { writes }: { writes: boolean },
): Promise<DependabotStep | undefined> {
  const { paths } = deps;
  const architecture = await readOptionalArtifact("architecture", paths.files.architecture);
  if (architecture === undefined) {
    deps.reporter.info(
      `OpsCrew adds no Dependabot configuration, because ${toPosixRelative(paths.root, paths.files.architecture)} is missing. Run \`opscrew analyze${await appFlag(paths.root, paths.app)}\` to create it.`,
    );
    return undefined;
  }
  const step = await dependabotStep(deps.paths.root, architecture.facts, plan);
  if (
    step.action === "write" &&
    !writes &&
    !(await exists(join(deps.paths.root, step.file.path)))
  ) {
    return undefined;
  }
  if (step.action === "keep") {
    const say = (text: string) => deps.redactor.redact(text);
    if (step.missing === undefined) {
      deps.reporter.warn(
        say(
          `OpsCrew could not read ${step.path}, so it left it as it is and cannot tell which updates it lacks.`,
        ),
      );
    } else if (step.missing.length > 0) {
      deps.reporter.info(
        say(
          `${step.path} is yours, so OpsCrew left it as it is. OpsCrew's would also update: ${step.missing.join(", ")}.`,
        ),
      );
    }
  }
  return step;
}
