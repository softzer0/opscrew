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
  /** Receives plain-English warnings, such as the file listing stopping at `maxFiles`. */
  onWarning?: (message: string) => void;
}

const GIT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_FILES = 20_000;

/** True when `dir` or one of its ancestors has a `.git` entry (directory, or file for worktrees). */
async function insideGitCheckout(dir: string): Promise<boolean> {
  for (let current = dir; ; ) {
    const found = await stat(path.join(current, ".git")).then(
      () => true,
      () => false,
    );
    if (found) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

/**
 * Paths tracked by git under `root`, relative to `root` (`git ls-files -z` run in `root`, which
 * also works when `root` is a subfolder of the repository), or `undefined` when no `.git` entry
 * exists in `root` or above it, git is not installed or the command fails.
 */
async function readGitTracked(
  root: string,
  runner: CommandRunner,
): Promise<ReadonlySet<string> | undefined> {
  if (!(await insideGitCheckout(root))) return undefined;
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
 * dotfiles such as `.env` included; `onWarning` is told when the listing stops at `maxFiles`),
 * `gitTracked` from `git ls-files -z` when `root` is inside a git repository, and `readFile`
 * reading UTF-8 text relative to the root.
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
  let files = options.files;
  if (files === undefined) {
    const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
    const listing = await listProjectFiles(rootDir, { maxFiles });
    files = listing.files;
    if (listing.truncated) {
      try {
        options.onWarning?.(
          `The project has more than ${maxFiles.toLocaleString("en-US")} files, so the scan stopped listing there and the rest were not checked. ` +
            "Scan the app's own folder, or add generated folders (builds, caches, vendored code) to .gitignore, so every file is checked.",
        );
      } catch {
        // A failing warning callback must not break the scan.
      }
    }
  }
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
