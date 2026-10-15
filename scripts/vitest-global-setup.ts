/**
 * Vitest global setup shared by every OpsCrew package (wired in through `scripts/vitest-base.ts`).
 *
 * Tests create many temporary folders (`mkdtemp(join(tmpdir(), "opscrew-…"))`) and the engine
 * tests download a provider into each one. Instead of cleaning up file by file, each `vitest run`
 * gets one run folder, `opscrew-test-run-XXXX`, under `OPSCREW_TEST_TMP` (when set) or the
 * system temporary folder. `TMPDIR`, `TEMP` and `TMP` point at it before the workers start, so
 * `os.tmpdir()` in test files and in child processes (git, tofu, terraform) lands inside it, and
 * teardown removes the whole folder. A run that was killed before its teardown (for example when
 * turbo stops the other tasks after a failure) is cleaned up by the next run on the same machine.
 */
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  interface ProvidedContext {
    /** Absolute path of this run's temporary folder (see `scripts/vitest-global-setup.ts`). */
    opscrewTestRunDir: string;
  }
}

/** Prefix of the per-run temporary folder. */
export const RUN_DIR_PREFIX = "opscrew-test-run-";

/** File inside each run folder naming the process and machine that own it. */
export const RUN_MARKER_FILE = ".opscrew-test-run.json";

/** Environment variables that `os.tmpdir()` reads (POSIX: `TMPDIR`; Windows: `TEMP`, `TMP`). */
export const TEMP_DIR_VARIABLES = ["TMPDIR", "TEMP", "TMP"] as const;

/** Side effects of {@link removeRunFolder}, injectable for tests. */
export interface RemoveRunFolderDeps {
  rm: typeof rm;
  warn: (line: string) => void;
}

/** Side effects of {@link sweepStaleRunFolders}, injectable for tests. */
export interface SweepDeps extends RemoveRunFolderDeps {
  hostname: string;
  isAlive: (pid: number) => boolean;
}

const defaultRemoveDeps: RemoveRunFolderDeps = { rm, warn: (line) => console.warn(line) };

/**
 * Removes a run folder with retries. A failure prints one warning line naming the folder and
 * never throws, so a locked file cannot fail an otherwise green run.
 */
export async function removeRunFolder(
  dir: string,
  deps: RemoveRunFolderDeps = defaultRemoveDeps,
): Promise<boolean> {
  try {
    await deps.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code ?? "unknown error";
    deps.warn(
      `OpsCrew tests: could not remove the temporary folder ${dir} (${code}); delete it by hand.`,
    );
    return false;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Removes run folders under `parent` left by runs that ended without their teardown. Only folders
 * with a readable marker from this machine whose process has ended are touched; anything else
 * (another live run, another machine, a folder still being created) is left alone.
 */
export async function sweepStaleRunFolders(
  parent: string,
  deps: SweepDeps = { ...defaultRemoveDeps, hostname: hostname(), isAlive: processIsAlive },
): Promise<string[]> {
  const removed: string[] = [];
  let entries: string[];
  try {
    entries = await readdir(parent);
  } catch {
    return removed;
  }
  for (const name of entries) {
    if (!name.startsWith(RUN_DIR_PREFIX)) continue;
    const dir = join(parent, name);
    let marker: { pid?: unknown; hostname?: unknown };
    try {
      marker = JSON.parse(await readFile(join(dir, RUN_MARKER_FILE), "utf8"));
    } catch {
      continue;
    }
    if (typeof marker.pid !== "number" || marker.hostname !== deps.hostname) continue;
    if (deps.isAlive(marker.pid)) continue;
    if (await removeRunFolder(dir, deps)) removed.push(dir);
  }
  return removed;
}

/** Creates the run folder, redirects the temp variables to it and returns the teardown. */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const parent = resolve(process.env.OPSCREW_TEST_TMP || tmpdir());
  await mkdir(parent, { recursive: true });
  await sweepStaleRunFolders(parent);
  const dir = await mkdtemp(join(parent, RUN_DIR_PREFIX));
  await writeFile(
    join(dir, RUN_MARKER_FILE),
    JSON.stringify({ pid: process.pid, hostname: hostname() }),
  );

  const previous = new Map(TEMP_DIR_VARIABLES.map((name) => [name, process.env[name]]));
  for (const name of TEMP_DIR_VARIABLES) process.env[name] = dir;
  project.provide("opscrewTestRunDir", dir);

  return async () => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await removeRunFolder(dir);
  };
}
