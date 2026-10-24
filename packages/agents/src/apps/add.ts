import { join } from "node:path";
import {
  APP_KEY_MESSAGE,
  APP_KEY_PATTERN,
  exists,
  isUserFacingError,
  OpsCrewError,
  resolveProjectPaths,
} from "@opscrew/core";
import { detectProjectDetails, detectSite, normalizeAppDir } from "@opscrew/detect";
import { type ProjectFacts, type RepositoryApp, writeArtifact } from "@opscrew/plan-schema";
import { requireUniqueNames } from "./names";

/**
 * `opscrew app add <key> --dir <folder>`: adds the further app `key` in the repository at `root`,
 * after checking that `dir` holds an app detection can deploy (one of its app folders, of a kind
 * it knows) and that none of the names the key gives is another app's or environment's
 * (`requireUniqueNames`). Writes only the app's record, `opscrew/apps/<key>/app.yaml`
 * (`{ schemaVersion: 1, dir }`); the interview later fills the app's `requirements.yaml` from it.
 * Returns the app, its folder normalised.
 * @throws OpsCrewError `INVALID_INPUT` for a key the rules refuse, a folder that holds no
 * deployable app, or a clash; `PHASE_PRECONDITION` when the repository has the app already.
 */
export async function addApp(root: string, key: string, dir: string): Promise<RepositoryApp> {
  if (!APP_KEY_PATTERN.test(key)) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `"${key}" cannot be an app's key: a key ${APP_KEY_MESSAGE}.`,
      {
        hint: "Choose another key, for example docs.",
      },
    );
  }
  const paths = resolveProjectPaths(root, { env: {}, app: key });
  if (await exists(paths.artefactsDir)) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `The repository already has an app ${key} (opscrew/apps/${key}). Nothing was changed.`,
      { hint: `Choose another key, or remove that app with \`opscrew app remove ${key}\` first.` },
    );
  }
  const folder = normalizeAppDir(dir);
  const retry = `then run \`opscrew app add ${key} --dir <folder>\` again`;
  let facts: ProjectFacts;
  try {
    facts = (await detectProjectDetails(paths.root, { appDir: folder })).facts;
  } catch (error) {
    if (!isUserFacingError(error) || error.code !== "INVALID_INPUT") throw error;
    throw new OpsCrewError("INVALID_INPUT", error.message, {
      hint: `Name one of the listed folders with \`--dir\`, ${retry}.`,
    });
  }
  // A site with no manifest (a Hugo site) has no app kind; its site is what OpsCrew deploys.
  if (facts.appKind === "unknown" && (await detectSite(paths.root, facts)) === undefined) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `OpsCrew found no app it can deploy in ${folder}: detection recognises no framework, server or static site there. Nothing was changed.`,
      {
        hint: `Name the folder of the app's own package (its package.json, for example) with \`--dir\`, ${retry}.`,
      },
    );
  }
  await requireUniqueNames(
    paths,
    { app: key, environment: "prod" },
    `Choose another key, then run \`opscrew app add <key> --dir ${folder}\` again.`,
  );
  await writeArtifact("app", join(paths.artefactsDir, "app.yaml"), {
    schemaVersion: 1,
    dir: folder,
  });
  return { key, dir: folder };
}
