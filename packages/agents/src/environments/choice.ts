import { join } from "node:path";
import { exists, OpsCrewError, resolveProjectPaths } from "@opscrew/core";
import { environmentsOf, resolveEnvironmentPaths } from "@opscrew/plan-schema";

/** How {@link resolveEnvironment} asks which environment to act on. */
export interface EnvironmentChoiceDeps {
  /** Asks the user to pick one of `environments`; given only when a person can answer. */
  choose?: (environments: readonly string[]) => Promise<string>;
}

/** `name` when the app has that environment; else plan-schema's `INVALID_INPUT` with the list. */
async function known(root: string, name: string): Promise<string> {
  // Only the check matters here, so no OpsCrew home is read for the paths.
  await resolveEnvironmentPaths(root, name, { env: {} });
  return name;
}

/**
 * ` --env <name>` for the commands OpsCrew suggests for the environment `name` while the app has
 * several environments (prod included: a bare command then asks, or stops in a script), else "".
 */
export async function environmentFlag(root: string, name: string): Promise<string> {
  // Skips reading the plans while prod is alone (no environments folder): a hint is then never
  // stopped by a plan that cannot be read, as requireOwnHostnames does.
  const folder = join(resolveProjectPaths(root, { env: {} }).artefactsDir, "environments");
  if (!(await exists(folder))) return "";
  return (await environmentsOf(root)).length > 1 ? ` --env ${name}` : "";
}

/**
 * The environment a command acts on (`--env`, the MCP tools' `environment`): `requested`, which
 * must be one of the app's environments; else the only one (prod for an app without a plan yet);
 * else, with several, the one the user picks through `deps.choose`.
 * @throws OpsCrewError `INVALID_INPUT` for an unknown name, and `PHASE_PRECONDITION` with the
 * names when there are several and no one can be asked (a script).
 */
export async function resolveEnvironment(
  root: string,
  requested: string | undefined,
  deps: EnvironmentChoiceDeps = {},
): Promise<string> {
  if (requested !== undefined) return known(root, requested);
  const names = await environmentsOf(root);
  if (names.length <= 1) return names[0] ?? "prod";
  if (deps.choose !== undefined) return known(root, await deps.choose(names));
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    `The app has several environments (${names.map((name) => `"${name}"`).join(", ")}), so OpsCrew needs to know which one this is for. Nothing was changed.`,
    { hint: `Add \`--env <name>\`, for example \`--env ${names[1]}\`.` },
  );
}
