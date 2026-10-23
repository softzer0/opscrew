/**
 * The lockfile update after adapt changed a package.json: the app's own package manager, run in
 * the user's checkout in its lockfile-only mode with install scripts off, so the deploy job's
 * install from the lockfile gets the new dependencies.
 */
import { join, posix } from "node:path";
import { exists, findExecutable, isUserFacingError, readTextIfExists } from "@opscrew/core";
import type { SiteDetection } from "@opscrew/detect";
import type { PhaseDeps } from "../context";
import { under } from "../design/code-changes";

type PackageManager = NonNullable<SiteDetection["packageManager"]>;

/** Each package manager's lockfiles. */
const LOCKFILES: Readonly<Record<PackageManager, readonly string[]>> = {
  npm: ["package-lock.json", "npm-shrinkwrap.json"],
  pnpm: ["pnpm-lock.yaml"],
  yarn: ["yarn.lock"],
  bun: ["bun.lock", "bun.lockb"],
};

/** The command that updates the lockfile only, without running any package's scripts. */
function updateArgs(manager: PackageManager, berry: boolean): string[] {
  switch (manager) {
    case "npm":
      return ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"];
    case "pnpm":
      return ["install", "--lockfile-only", "--ignore-scripts"];
    case "bun":
      return ["install", "--lockfile-only", "--ignore-scripts"];
    case "yarn":
      // Yarn 1 has no lockfile-only mode: it installs, with scripts off.
      return berry ? ["install", "--mode", "update-lockfile"] : ["install", "--ignore-scripts"];
  }
}

/** What the update did: the lockfile it updated, none to update, or the command still to run. */
export type LockfileUpdate =
  | { status: "updated"; lockfile: string; note: string }
  | { status: "none" }
  | { status: "failed"; lockfile: string; note: string };

/**
 * Updates the lockfile of the app in `dir` (repo-relative) with `manager`, through `deps.runner`
 * in the folder that holds it (the app's, or a workspace root above it). `none` when the app has
 * no lockfile; `failed`, with the command to run, when the package manager is missing or fails.
 */
export async function updateLockfile(
  deps: Pick<PhaseDeps, "runner" | "env" | "paths">,
  dir: string,
  manager: PackageManager,
): Promise<LockfileUpdate> {
  const root = deps.paths.root;
  // The app's folder, then each folder above it up to the repository root.
  const folders = [dir];
  while (folders.at(-1) !== ".") folders.push(posix.dirname(folders.at(-1) as string));
  let lockfile: string | undefined;
  for (const path of folders.flatMap((folder) => LOCKFILES[manager].map((n) => under(folder, n)))) {
    if (await exists(join(root, path))) {
      lockfile = path;
      break;
    }
  }
  if (lockfile === undefined) return { status: "none" };
  const folder = posix.dirname(lockfile);
  const cwd = join(root, folder);
  const berry =
    manager === "yarn" &&
    /^__metadata:/m.test((await readTextIfExists(join(root, lockfile))) ?? "");
  const args = updateArgs(manager, berry);
  const command = `${manager} ${args.join(" ")}`;
  const where = folder === "." ? "" : ` in ${folder}`;
  const failed = (why: string) => ({
    status: "failed" as const,
    lockfile,
    note: `OpsCrew could not update ${lockfile}: ${why}. Run \`${command}\`${where} and commit ${lockfile} to this branch, or the deploy job's install fails.`,
  });
  const bin = findExecutable(manager, deps.env);
  if (bin === undefined) return failed(`${manager} is not installed here`);
  try {
    const result = await deps.runner.run(bin, args, { cwd, env: deps.env, timeoutMs: 600_000 });
    if (result.exitCode !== 0) {
      const last = `${result.stderr}\n${result.stdout}`.trim().split("\n").at(-1) ?? "";
      return failed(`${manager} failed${last === "" ? "" : ` (${last.trim()})`}`);
    }
  } catch (error) {
    if (!isUserFacingError(error)) throw error;
    return failed(error.message.replace(/\.$/, ""));
  }
  return { status: "updated", lockfile, note: `${manager} updated ${lockfile}.` };
}
