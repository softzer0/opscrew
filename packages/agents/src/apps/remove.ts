import { rm } from "node:fs/promises";
import { join } from "node:path";
import { exists, listText, OpsCrewError, toPosixRelative } from "@opscrew/core";
import { pagesVerificationRootDir, storageRootDir } from "@opscrew/iac-templates";
import {
  environmentsOf,
  infraDirFor,
  readArtifact,
  readOptionalArtifact,
  workflowPathFor,
} from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import {
  chooseEngine,
  type EngineFactory,
  pagesVerificationStateFile,
  stateContents,
} from "../shared/engine";
import { resolveApp } from "./choice";
import { appPaths, deployedEnvironments } from "./list";

/** Options of {@link removeApp}. */
export interface RemoveAppOptions {
  /** Picks the IaC engine that reads an encrypted state (default: the installed one). */
  engine?: EngineFactory;
}

/**
 * `opscrew app remove <key>`: removes the files of the further app `deps.paths` belong to
 * (`deps.paths.app`): its folders in `opscrew/apps/`, `.opscrew/apps/` and the project's OpsCrew
 * home (its environments' inside them), and each environment's infrastructure roots
 * (`opscrew/infra/<key>[-<env>]`, its storage root and its GitHub Pages verification root) and
 * deploy workflow. Only those OpsCrew names after the app: a folder a plan was pointed to by hand
 * stays. Returns what was removed (repository paths relative to the root).
 * @throws OpsCrewError `INVALID_INPUT` for the first app or an unknown key, and
 * `PHASE_PRECONDITION` (nothing removed) while one of its environments is deployed, or while the
 * state of its GitHub Pages verification root may still hold the record (an encrypted state the
 * engine cannot read counts), since without the state nothing could delete it later.
 */
export async function removeApp(
  deps: Pick<PhaseDeps, "paths" | "reporter" | "redactor" | "runner" | "env" | "clock">,
  options: RemoveAppOptions = {},
): Promise<string[]> {
  const key = deps.paths.app;
  if (key === undefined) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      "The first app is the repository's own, so `opscrew app remove` leaves it: it removes a further app.",
      { hint: "Run `opscrew destroy --app .` to remove the first app's deployment." },
    );
  }
  await resolveApp(deps.paths.root, key);
  const deployed = await deployedEnvironments(deps.paths, key);
  if (deployed.length > 0) {
    const named = deployed.map((name) => (name === "prod" ? "" : ` --env ${name}`));
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `The app ${key} is deployed (${listText(deployed)}), so OpsCrew removed none of its files.`,
      {
        hint: `Run ${listText(named.map((flag) => `\`opscrew destroy --app ${key}${flag}\``))} first, then \`opscrew app remove ${key}\`.`,
      },
    );
  }
  const paths = appPaths(deps.paths, key);
  const prod = await readOptionalArtifact("plan", paths.files.plan);
  const verification = pagesVerificationStateFile(paths);
  const held = await stateContents({ ...deps, paths }, verification, () =>
    chooseEngine({ ...deps, paths }, prod?.infra.engine ?? "auto", options.engine),
  );
  if (held !== "nothing") {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `The app ${key}'s GitHub Pages verification record may still be in DNS (its state, ${toPosixRelative(paths.root, verification)}, ${held === "unknown" ? "cannot be read here" : "holds it"}), so OpsCrew removed none of its files: without that state nothing could delete the record later.`,
      {
        hint: `Run \`opscrew destroy --app ${key} --delete-verification\` first, then \`opscrew app remove ${key}\`.`,
      },
    );
  }
  // Only an environment with a plan was ever provisioned, so only its roots and workflow exist.
  const repository: string[] = [];
  for (const name of await environmentsOf(paths.root, key)) {
    const plan = await readArtifact("plan", appPaths(deps.paths, key, name).files.plan);
    const dir = infraDirFor(key, name);
    const roots = { ...plan, infra: { ...plan.infra, dir } };
    repository.push(
      ...[
        dir,
        storageRootDir(roots),
        ...(name === "prod" ? [pagesVerificationRootDir(roots)] : []),
        workflowPathFor(key, name),
      ].map((path) => join(paths.root, path)),
    );
  }
  const removed: string[] = [];
  // The app's folder goes last: its record keeps the app listed until then, so a removal that
  // failed half-way (a file in use on Windows) can be run again.
  for (const path of [paths.stateDir, ...repository, paths.projectHomeDir, paths.artefactsDir]) {
    if (!(await exists(path))) continue;
    await rm(path, { recursive: true, force: true });
    const shown = toPosixRelative(paths.root, path);
    removed.push(shown.startsWith("..") ? path : shown);
  }
  deps.reporter.success(
    deps.redactor.redact(
      `Removed the app ${key}'s files: ${removed.length === 0 ? "none were left" : listText(removed)}.`,
    ),
  );
  return removed;
}
