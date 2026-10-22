import { rm } from "node:fs/promises";
import { join } from "node:path";
import { exists, listText, OpsCrewError, toPosixRelative } from "@opscrew/core";
import { storageRootDir } from "@opscrew/iac-templates";
import { environmentsOf, readArtifact } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { resolveEnvironment } from "./choice";
import { environmentDeployed } from "./list";
import { environmentInfraDir, environmentPaths, environmentWorkflowPath } from "./paths";

/**
 * `opscrew env remove <name>`: removes the files of the environment `deps.paths` belong to: its
 * folders in `opscrew/environments/`, `.opscrew/environments/` and the project's OpsCrew home,
 * its infrastructure roots (`opscrew/infra/<env>`, its storage root) and its deploy workflow.
 * Only those OpsCrew names after the environment: a folder the plan was pointed to by hand stays.
 * Returns what was removed (repository paths relative to the root).
 * @throws OpsCrewError `INVALID_INPUT` for prod or an unknown environment, and
 * `PHASE_PRECONDITION` (nothing removed) while it is deployed or another environment is promoted
 * from it.
 */
export async function removeEnvironment(
  deps: Pick<PhaseDeps, "paths" | "reporter" | "redactor">,
): Promise<string[]> {
  const { paths } = deps;
  const name = paths.environment;
  if (name === "prod") {
    throw new OpsCrewError(
      "INVALID_INPUT",
      "prod is the app's own environment, so `opscrew env remove` leaves it.",
      { hint: "Run `opscrew destroy` to remove prod's deployment." },
    );
  }
  await resolveEnvironment(paths.root, name);
  const plan = await readArtifact("plan", paths.files.plan);
  if (await environmentDeployed(paths, plan)) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `The ${name} environment is deployed, so OpsCrew removed none of its files.`,
      { hint: `Run \`opscrew destroy --env ${name}\` first, then \`opscrew env remove ${name}\`.` },
    );
  }
  const sources = await Promise.all(
    (await environmentsOf(paths.root)).map(async (other) => {
      const source = (await readArtifact("plan", environmentPaths(paths, other).files.plan))
        .environment?.deploySource;
      return source?.from === "promote" && source.source === name ? other : undefined;
    }),
  );
  const promoted = sources.filter((other) => other !== undefined);
  if (promoted.length > 0) {
    const before = plan.environment?.deploySource;
    const from = before?.from === "promote" ? before.source : "main";
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `${listText(promoted)} ${promoted.length === 1 ? "is" : "are"} promoted from ${name}, so OpsCrew removed none of its files.`,
      {
        hint: `Deploy ${promoted.length === 1 ? "it" : "them"} from another source first, for example \`opscrew env set ${promoted[0]} --from ${from}\`.`,
      },
    );
  }
  const infraDir = environmentInfraDir(name);
  const repository = [
    infraDir,
    storageRootDir({ ...plan, infra: { ...plan.infra, dir: infraDir } }),
    environmentWorkflowPath(name),
  ].map((path) => join(paths.root, path));
  const removed: string[] = [];
  // The plan's folder goes last: until it is gone the environment is listed, so a removal that
  // failed half-way (a file in use on Windows) can be run again.
  for (const path of [paths.stateDir, ...repository, paths.projectHomeDir, paths.artefactsDir]) {
    if (!(await exists(path))) continue;
    await rm(path, { recursive: true, force: true });
    const shown = toPosixRelative(paths.root, path);
    removed.push(shown.startsWith("..") ? path : shown);
  }
  deps.reporter.success(
    deps.redactor.redact(
      `Removed the ${name} environment's files: ${removed.length === 0 ? "none were left" : listText(removed)}.`,
    ),
  );
  return removed;
}
