import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PhaseDeps } from "../context";

/**
 * The lines `ensureGitignore` adds: `.opscrew/` (OpsCrew's machine-local state: saved plans,
 * Terraform state, approvals) and `.terraform/` (the OpenTofu/Terraform working directory with
 * the downloaded provider binaries, which `init` creates under `opscrew/infra/`).
 */
export const GITIGNORE_ENTRIES = [".opscrew/", ".terraform/"] as const;

/** One of {@link GITIGNORE_ENTRIES}. */
export type GitignoreEntry = (typeof GITIGNORE_ENTRIES)[number];

/** Patterns that ignore each entry: `.opscrew/` at the root, `.terraform/` in every directory. */
const ENTRY_PATTERNS: Record<GitignoreEntry, RegExp> = {
  ".opscrew/": /^\/?\.opscrew(?:\/(?:\*\*?)?)?$/,
  ".terraform/": /^(?:\*\*\/)?\.terraform(?:\/(?:\*\*?)?)?$/,
};

/** True when the `.gitignore` text ignores `entry`; a later negation un-ignores it, as in git. */
function covers(text: string, entry: GitignoreEntry): boolean {
  const pattern = ENTRY_PATTERNS[entry];
  let covered = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim(); // also strips a byte order mark
    if (line === "" || line.startsWith("#")) continue;
    const negated = line.startsWith("!");
    if (pattern.test(negated ? line.slice(1) : line)) covered = !negated;
  }
  return covered;
}

/**
 * True when the `.gitignore` text ignores the `.opscrew/` directory at the repository root
 * (`.opscrew`, `.opscrew/`, `/.opscrew/`, `.opscrew/*` or `.opscrew/**`). A later negation
 * (`!.opscrew/`) un-ignores it again, as in git.
 */
export function gitignoreCoversOpsCrew(text: string): boolean {
  return covers(text, ".opscrew/");
}

/**
 * True when the `.gitignore` text ignores `.terraform` directories at any depth (`.terraform`,
 * `.terraform/`, `**\/.terraform/`, `.terraform/*`, …; a rooted `/.terraform/` does not reach
 * `opscrew/infra/prod/.terraform/`).
 */
export function gitignoreCoversTerraform(text: string): boolean {
  return covers(text, ".terraform/");
}

/** The {@link GITIGNORE_ENTRIES} the `.gitignore` text (`undefined`: no file) does not ignore. */
export function missingGitignoreEntries(text: string | undefined): GitignoreEntry[] {
  return GITIGNORE_ENTRIES.filter((entry) => text === undefined || !covers(text, entry));
}

/** `.opscrew/` or `.opscrew/ and .terraform/`, for messages. */
export function describeGitignoreEntries(entries: readonly string[]): string {
  return entries.join(" and ");
}

/** Contents of `<root>/.gitignore`, or `undefined` when the file does not exist. */
export async function readGitignore(root: string): Promise<string | undefined> {
  try {
    return await readFile(join(root, ".gitignore"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export interface EnsureGitignoreOptions {
  /** Change the file without asking (`opscrew init --fix`). */
  fix?: boolean;
}

const WHY: Record<GitignoreEntry, string> = {
  ".opscrew/":
    "OpsCrew keeps machine-local state in .opscrew/ (saved plans, Terraform state, approvals). It must never be committed.",
  ".terraform/":
    "OpenTofu and Terraform download provider binaries into .terraform/ under opscrew/infra/ (hundreds of megabytes). They do not belong in git.",
};

/**
 * Makes sure `.gitignore` ignores {@link GITIGNORE_ENTRIES}. Appends the missing entries,
 * creating the file when missing, after a `repo-write` approval or directly with `fix`. Idempotent
 * and keeps the file's line endings. Returns the entries it added (none: the file is unchanged).
 */
export async function ensureGitignore(
  deps: PhaseDeps,
  options: EnsureGitignoreOptions = {},
): Promise<GitignoreEntry[]> {
  const file = join(deps.paths.root, ".gitignore");
  const current = await readGitignore(deps.paths.root);
  const missing = missingGitignoreEntries(current);
  if (missing.length === 0) return [];
  const named = describeGitignoreEntries(missing);

  if (options.fix !== true) {
    const approval = await deps.approvals.request({
      kind: "repo-write",
      title:
        current === undefined ? `Create .gitignore with ${named}` : `Add ${named} to .gitignore`,
      details: [
        ...missing.map((entry) => WHY[entry]),
        current === undefined
          ? `Change: create .gitignore containing ${named}`
          : `Change: append ${named} to .gitignore`,
      ].join("\n"),
    });
    if (!approval.approved) {
      deps.reporter.warn(
        `.gitignore was not changed. Add ${named} to it yourself, or run \`opscrew init --fix\`.`,
      );
      return [];
    }
  }

  if (current === undefined) {
    await writeFile(file, missing.map((entry) => `${entry}\n`).join(""), "utf8");
  } else {
    const eol = current.includes("\r\n") ? "\r\n" : "\n";
    const separator = current === "" || /\r?\n$/.test(current) ? "" : eol;
    await appendFile(
      file,
      `${separator}${missing.map((entry) => `${entry}${eol}`).join("")}`,
      "utf8",
    );
  }
  deps.reporter.success(`Added ${named} to .gitignore.`);
  return missing;
}
