import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PhaseDeps } from "../context";

/** The line `ensureGitignore` adds. */
export const OPSCREW_GITIGNORE_ENTRY = ".opscrew/";

const ENTRY_PATTERN = /^\/?\.opscrew(?:\/(?:\*\*?)?)?$/;

/**
 * True when the `.gitignore` text ignores the `.opscrew/` directory at the repository root
 * (`.opscrew`, `.opscrew/`, `/.opscrew/`, `.opscrew/*` or `.opscrew/**`). A later negation
 * (`!.opscrew/`) un-ignores it again, as in git.
 */
export function gitignoreCoversOpsCrew(text: string): boolean {
  let covered = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim(); // also strips a byte order mark
    if (line === "" || line.startsWith("#")) continue;
    const negated = line.startsWith("!");
    if (ENTRY_PATTERN.test(negated ? line.slice(1) : line)) covered = !negated;
  }
  return covered;
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

/**
 * Makes sure `.gitignore` ignores `.opscrew/` (OpsCrew's machine-local state: plans, Terraform
 * state, approvals). Appends the entry, creating the file when missing, after a `repo-write`
 * approval or directly with `fix`. Idempotent and keeps the file's line endings. Returns true when
 * it changed the file.
 */
export async function ensureGitignore(
  deps: PhaseDeps,
  options: EnsureGitignoreOptions = {},
): Promise<boolean> {
  const file = join(deps.paths.root, ".gitignore");
  const current = await readGitignore(deps.paths.root);
  if (current !== undefined && gitignoreCoversOpsCrew(current)) return false;

  if (options.fix !== true) {
    const approval = await deps.approvals.request({
      kind: "repo-write",
      title: `${current === undefined ? "Create .gitignore with" : "Add"} ${OPSCREW_GITIGNORE_ENTRY}${current === undefined ? "" : " to .gitignore"}`,
      details: [
        "OpsCrew keeps machine-local state in .opscrew/ (saved plans, Terraform state, approvals).",
        "It must never be committed.",
        current === undefined
          ? `Change: create .gitignore containing ${OPSCREW_GITIGNORE_ENTRY}`
          : `Change: append ${OPSCREW_GITIGNORE_ENTRY} to .gitignore`,
      ].join("\n"),
    });
    if (!approval.approved) {
      deps.reporter.warn(
        `.gitignore was not changed. Add ${OPSCREW_GITIGNORE_ENTRY} to it yourself, or run \`opscrew init --fix\`.`,
      );
      return false;
    }
  }

  if (current === undefined) {
    await writeFile(file, `${OPSCREW_GITIGNORE_ENTRY}\n`, "utf8");
  } else {
    const eol = current.includes("\r\n") ? "\r\n" : "\n";
    const separator = current === "" || /\r?\n$/.test(current) ? "" : eol;
    await appendFile(file, `${separator}${OPSCREW_GITIGNORE_ENTRY}${eol}`, "utf8");
  }
  deps.reporter.success(`Added ${OPSCREW_GITIGNORE_ENTRY} to .gitignore.`);
  return true;
}
