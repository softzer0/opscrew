import { join } from "node:path";
import type { ProjectPaths } from "@opscrew/core";
import { readArtifact } from "@opscrew/plan-schema";
import { appPaths } from "./list";

/**
 * The folder of the further app `paths` belong to, from its record `opscrew/apps/<key>/app.yaml`
 * (`opscrew app add` wrote it); `undefined` for the first app, whose folder its answers and
 * analysis choose.
 * @throws ArtifactError when the record is missing or invalid.
 */
export async function recordedAppDir(paths: ProjectPaths): Promise<string | undefined> {
  if (paths.app === undefined) return undefined;
  const { artefactsDir } = appPaths(paths, paths.app);
  return (await readArtifact("app", join(artefactsDir, "app.yaml"))).dir;
}
