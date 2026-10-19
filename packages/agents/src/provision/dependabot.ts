import { join } from "node:path";
import { exists, readTextIfExists } from "@opscrew/core";
import { type JavaBuild, type RenderedFile, renderDependabot } from "@opscrew/iac-templates";
import { type DeployPlan, type ProjectFacts, readOptionalArtifact } from "@opscrew/plan-schema";
import { parse } from "yaml";
import { z } from "zod";
import { findInApp } from "../adapt/build-files";
import type { PhaseDeps } from "../context";

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
async function javaBuildOf(root: string, facts: ProjectFacts): Promise<JavaBuild | undefined> {
  const found = await findInApp(root, facts, ["pom.xml", "build.gradle", "build.gradle.kts"]);
  return found === undefined ? undefined : found === "pom.xml" ? "maven" : "gradle";
}

/**
 * `.github/dependabot.yml` (`renderDependabot`, with a Java app's build tool) when the repository
 * has no Dependabot configuration (FR-1221), or has OpsCrew's file unchanged (written by a
 * `--plan-only` run, or committed earlier, so committing it again leaves it as it is); otherwise
 * the user's stays as it is, with the entries OpsCrew's would add that it lacks: an ecosystem with
 * a folder no entry of that ecosystem lists.
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
    if (path === file.path && text.replace(/\r\n/g, "\n") === file.content) {
      return { action: "write", file };
    }
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
 * runtime files Dependabot watches (FR-1221), with the app's facts from
 * `opscrew/architecture.json`. Says when the user's file stays as it is and what it lacks.
 * Undefined, with a note, when there is no `opscrew/architecture.json`; undefined too when the run
 * writes no files (`writes` false: it applies a saved plan) and OpsCrew's file is not on disk, so
 * there is nothing to commit.
 */
export async function deploySetupDependabot(
  deps: Pick<PhaseDeps, "paths" | "reporter" | "redactor">,
  plan: DeployPlan,
  { writes }: { writes: boolean },
): Promise<DependabotStep | undefined> {
  const architecture = await readOptionalArtifact("architecture", deps.paths.files.architecture);
  if (architecture === undefined) {
    deps.reporter.info(
      "OpsCrew adds no Dependabot configuration, because opscrew/architecture.json is missing. Run `opscrew analyze` to create it.",
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
