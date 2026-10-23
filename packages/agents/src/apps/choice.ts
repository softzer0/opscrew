import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { APP_KEY_MESSAGE, APP_KEY_PATTERN, OpsCrewError } from "@opscrew/core";
import { appsOf, type RepositoryApp } from "@opscrew/plan-schema";

/**
 * What `--app` (and the MCP tools' `app`) names the repository's first app by, which has no key:
 * `.`, never a key.
 */
export const FIRST_APP = ".";

/** How {@link resolveApp} asks which app to act on. */
export interface AppChoiceDeps {
  /**
   * Asks the user to pick one of `apps` (the first app, then the further apps by key) and returns
   * its key, or {@link FIRST_APP} for the first app; given only when a person can answer.
   */
  choose?: (apps: readonly RepositoryApp[]) => Promise<string>;
}

/**
 * True when the repository may have further apps: `opscrew/apps/` holds a folder (no file in it
 * is read, so a damaged record never stands in for the error a command would give).
 */
export async function mayHaveFurtherApps(root: string): Promise<boolean> {
  try {
    const entries = await readdir(join(root, "opscrew", "apps"), { withFileTypes: true });
    return entries.some((entry) => entry.isDirectory());
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }
}

/** The apps for a message: `the first app (in sites/web)`, `"docs" (in sites/docs)`. */
function appsText(apps: readonly RepositoryApp[]): string {
  return apps
    .map(({ key, dir }) => `${key === undefined ? "the first app" : `"${key}"`} (in ${dir})`)
    .join(", ");
}

/**
 * The key `requested` names: `undefined` for {@link FIRST_APP}, else a further app's key the
 * repository has.
 * @throws OpsCrewError `INVALID_INPUT` for anything else, listing the repository's apps.
 */
async function known(root: string, requested: string): Promise<string | undefined> {
  const wanted = requested.trim();
  if (wanted === FIRST_APP) return undefined;
  if (!APP_KEY_PATTERN.test(wanted)) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `"${wanted}" is not an app's key: a key ${APP_KEY_MESSAGE}. \`--app .\` is the first app.`,
      { hint: "Run `opscrew app list` to see the repository's apps." },
    );
  }
  const apps = (await mayHaveFurtherApps(root)) ? await appsOf(root) : [];
  if (apps.some((app) => app.key === wanted)) return wanted;
  const further = apps.filter((app) => app.key !== undefined);
  throw new OpsCrewError(
    "INVALID_INPUT",
    `The repository has no app "${wanted}". Its further apps: ${further.length === 0 ? "none yet" : appsText(further)}.`,
    {
      hint: "Run `opscrew app list` to see the repository's apps, or add this one with `opscrew app add <key> --dir <folder>`.",
    },
  );
}

/**
 * The app a command acts on (`--app`, the MCP tools' `app`): `requested`, a further app's key or
 * {@link FIRST_APP}; else the first app while it is the repository's only one; else, with
 * several, the one the user picks through `deps.choose`. Returns the further app's key, or
 * `undefined` for the first app. Reads no file while the repository has no further app.
 * @throws OpsCrewError `INVALID_INPUT` for an unknown key, and `PHASE_PRECONDITION` with the apps
 * when there are several and no one can be asked (a script).
 */
export async function resolveApp(
  root: string,
  requested: string | undefined,
  deps: AppChoiceDeps = {},
): Promise<string | undefined> {
  if (requested !== undefined) return known(root, requested);
  if (!(await mayHaveFurtherApps(root))) return undefined;
  const apps = await appsOf(root);
  if (apps.length === 1) return undefined;
  if (deps.choose !== undefined) return known(root, await deps.choose(apps));
  const example = apps.find((app) => app.key !== undefined)?.key;
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    `The repository has several apps (${appsText(apps)}), so OpsCrew needs to know which one this is for. Nothing was changed.`,
    {
      hint: `Add \`--app <key>\`, for example \`--app ${example}\`, or \`--app .\` for the first app.`,
    },
  );
}

/**
 * ` --app <key>` for the commands OpsCrew suggests for the further app `key`; for the first app
 * (`undefined`) ` --app .` while the repository has further apps ({@link mayHaveFurtherApps}: a
 * bare command then asks, or stops in a script), else "".
 */
export async function appFlag(root: string, key: string | undefined): Promise<string> {
  if (key !== undefined) return ` --app ${key}`;
  return (await mayHaveFurtherApps(root)) ? ` --app ${FIRST_APP}` : "";
}
