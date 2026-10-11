import { readFile as readFileFs, stat } from "node:fs/promises";
import path from "node:path";
import type { CommandRunner, FetchLike, ScanContext } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { listProjectFiles } from "@opscrew/detect";

/** Options for {@link createScanContext}. */
export interface ScanContextOptions {
  /** When true, scanners must not use the network. */
  offline: boolean;
  fetch: FetchLike;
  /** Used for `git ls-files` and by external scanners. */
  runner: CommandRunner;
  /** Stop listing after this many files (default: `listProjectFiles` default, 20,000). */
  maxFiles?: number;
  /** Use these repo-relative POSIX paths instead of listing the project. */
  files?: readonly string[];
}

const GIT_TIMEOUT_MS = 30_000;

/**
 * Repo-relative paths tracked by git (`git ls-files -z`), or `undefined` when `root` has no `.git`
 * entry, git is not installed or the command fails.
 */
async function readGitTracked(
  root: string,
  runner: CommandRunner,
): Promise<ReadonlySet<string> | undefined> {
  const hasGit = await stat(path.join(root, ".git")).then(
    () => true,
    () => false,
  );
  if (!hasGit) return undefined;
  try {
    const result = await runner.run("git", ["ls-files", "-z"], {
      cwd: root,
      timeoutMs: GIT_TIMEOUT_MS,
    });
    if (result.exitCode !== 0 || result.timedOut) return undefined;
    return new Set(
      result.stdout
        .split("\0")
        .map((file) => file.replace(/\\/g, "/"))
        .filter((file) => file !== ""),
    );
  } catch {
    return undefined;
  }
}

/** Absolute path for a repo-relative path; rejects paths that escape `root`. */
function resolveInside(root: string, relativePath: string): string {
  const absolute = path.resolve(root, ...relativePath.split("/"));
  const relative = path.relative(root, absolute);
  if (
    path.isAbsolute(relativePath) ||
    relative === "" ||
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `Refusing to read "${relativePath}": scanners may only read files inside the project.`,
    );
  }
  return absolute;
}

/**
 * Builds the {@link ScanContext} for `root`: files from `listProjectFiles` (gitignore-aware,
 * dotfiles such as `.env` included), `gitTracked` from `git ls-files -z` when the project is a git
 * repository, and `readFile` reading UTF-8 text relative to the root.
 */
export async function createScanContext(
  root: string,
  options: ScanContextOptions,
): Promise<ScanContext> {
  const rootDir = path.resolve(root);
  const isDirectory = await stat(rootDir).then(
    (info) => info.isDirectory(),
    () => false,
  );
  if (!isDirectory) {
    throw new OpsCrewError("INVALID_INPUT", `"${path.basename(rootDir)}" is not a directory.`, {
      hint: "Run the scan from your project folder or pass the path of an existing directory.",
    });
  }
  const files =
    options.files ??
    (
      await listProjectFiles(
        rootDir,
        options.maxFiles === undefined ? {} : { maxFiles: options.maxFiles },
      )
    ).files;
  const gitTracked = await readGitTracked(rootDir, options.runner);
  const context: ScanContext = {
    rootDir,
    files: [...files],
    readFile: async (relativePath) => readFileFs(resolveInside(rootDir, relativePath), "utf8"),
    offline: options.offline,
    fetch: options.fetch,
    runner: options.runner,
  };
  if (gitTracked) context.gitTracked = gitTracked;
  return context;
}
