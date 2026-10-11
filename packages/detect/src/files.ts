import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import ignore from "ignore";
import { joinRel, sortStrings, toFsPath } from "./paths";

/** Directory names that are never walked, at any depth. */
export const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  ".opscrew",
  ".terraform",
  "dist",
  "build",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".output",
  "coverage",
  ".venv",
  "venv",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  "target",
  "vendor",
]);

/** Options for {@link listProjectFiles}. */
export interface ListProjectFilesOptions {
  /** Stop after this many files and report `truncated: true` (default 20,000). */
  maxFiles?: number;
  /** Skip files larger than this many bytes (default 1,000,000). */
  maxFileBytes?: number;
  /** Extra gitignore-style patterns, relative to the root. */
  extraIgnores?: readonly string[];
}

/** Result of {@link listProjectFiles}. */
export interface ProjectFileList {
  /** Sorted, repo-relative POSIX paths. */
  files: string[];
  /** True when the walk stopped at `maxFiles`. */
  truncated: boolean;
}

type Ignore = ReturnType<typeof ignore>;

interface Matcher {
  /** Repo-relative directory the patterns are relative to. */
  base: string;
  ig: Ignore;
}

function createMatcher(base: string, patterns: readonly string[]): Matcher {
  return { base, ig: ignore({ ignorecase: false }).add([...patterns]) };
}

/**
 * Git semantics, simplified: every `.gitignore` from the root down to the entry's directory is
 * consulted in order and the last one with a matching rule decides (so a deeper `!pattern` can
 * re-include). Directories are tested with a trailing slash so `dir/` patterns match them.
 */
function isIgnored(matchers: readonly Matcher[], rel: string, isDirectory: boolean): boolean {
  let ignored = false;
  for (const { base, ig } of matchers) {
    const sub = base === "." ? rel : rel.slice(base.length + 1);
    const result = ig.test(isDirectory ? `${sub}/` : sub);
    if (result.ignored) ignored = true;
    else if (result.unignored) ignored = false;
  }
  return ignored;
}

/**
 * Lists the project's files as sorted, repo-relative POSIX paths. Skips
 * {@link SKIPPED_DIRECTORIES}, anything matched by `.gitignore` files at any level (or by
 * `extraIgnores`), symbolic links, and files larger than `maxFileBytes`. Stops at `maxFiles`.
 */
export async function listProjectFiles(
  root: string,
  options: ListProjectFilesOptions = {},
): Promise<ProjectFileList> {
  const maxFiles = options.maxFiles ?? 20_000;
  const maxFileBytes = options.maxFileBytes ?? 1_000_000;
  const files: string[] = [];
  let truncated = false;

  const rootMatchers: Matcher[] = [];
  if (options.extraIgnores && options.extraIgnores.length > 0) {
    rootMatchers.push(createMatcher(".", options.extraIgnores));
  }

  async function walk(dir: string, inherited: readonly Matcher[]): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(toFsPath(root, dir), { withFileTypes: true });
    } catch {
      return;
    }
    const matchers = [...inherited];
    if (entries.some((entry) => entry.name === ".gitignore" && entry.isFile())) {
      const text = await readFile(toFsPath(root, joinRel(dir, ".gitignore")), "utf8").catch(
        () => "",
      );
      matchers.push(createMatcher(dir, text.split(/\r?\n/)));
    }

    const names = sortStrings(entries.map((entry) => entry.name));
    const byName = new Map(entries.map((entry) => [entry.name, entry]));
    const subdirectories: string[] = [];
    const candidates: string[] = [];
    for (const name of names) {
      const entry = byName.get(name);
      // A backslash cannot be represented in a POSIX repo-relative path; skip such names.
      if (!entry || name.includes("\\")) continue;
      const rel = joinRel(dir, name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(name) && !isIgnored(matchers, rel, true)) {
          subdirectories.push(rel);
        }
      } else if (entry.isFile() && !isIgnored(matchers, rel, false)) {
        candidates.push(rel);
      }
    }

    const sizes = await Promise.all(
      candidates.map((rel) =>
        stat(toFsPath(root, rel)).then(
          (s) => s.size,
          () => -1,
        ),
      ),
    );
    for (const [index, rel] of candidates.entries()) {
      const size = sizes[index] ?? -1;
      if (size < 0 || size > maxFileBytes) continue;
      if (files.length >= maxFiles) {
        truncated = true;
        return;
      }
      files.push(rel);
    }
    for (const subdirectory of subdirectories) {
      await walk(subdirectory, matchers);
      if (truncated) return;
    }
  }

  await walk(".", rootMatchers);
  return { files: sortStrings(files), truncated };
}
