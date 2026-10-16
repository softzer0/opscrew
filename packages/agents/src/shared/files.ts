import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { OpsCrewError, plural, writeFileAtomic } from "@opscrew/core";
import type { RenderedFile } from "@opscrew/iac-templates";
import type { PhaseDeps } from "../context";

export interface RenderedFileDiff {
  created: RenderedFile[];
  changed: RenderedFile[];
  unchanged: RenderedFile[];
}

const normalise = (text: string) => text.replace(/\r\n/g, "\n");

/** True when `path` exists (a file or a directory). */
export async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** The file's text, or `undefined` when it does not exist; any other read error is thrown. */
export async function readIfExists(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Compares rendered files with what is on disk under `root` (line endings ignored). */
export async function diffRenderedFiles(
  root: string,
  files: readonly RenderedFile[],
): Promise<RenderedFileDiff> {
  const diff: RenderedFileDiff = { created: [], changed: [], unchanged: [] };
  for (const file of files) {
    const current = await readIfExists(join(root, file.path));
    if (current === undefined) diff.created.push(file);
    else if (normalise(current) === normalise(file.content)) diff.unchanged.push(file);
    else diff.changed.push(file);
  }
  return diff;
}

/** Writes rendered files under `root` atomically with LF line endings. */
export async function writeRenderedFiles(
  root: string,
  files: readonly RenderedFile[],
): Promise<void> {
  for (const file of files) {
    await writeFileAtomic(join(root, file.path), normalise(file.content), {
      ...(file.mode !== undefined ? { mode: file.mode } : {}),
    });
  }
}

/** Plain-English summary of a diff for approvals, e.g. "3 new files, 1 changed". */
export function describeDiff(diff: RenderedFileDiff): string {
  const parts: string[] = [];
  if (diff.created.length > 0) parts.push(plural(diff.created.length, "new file"));
  if (diff.changed.length > 0) parts.push(`${diff.changed.length} changed`);
  if (parts.length === 0) return "no changes";
  return parts.join(", ");
}

/**
 * Writes the rendered files that are new or changed under `root`, after a `repo-write` approval
 * that lists them, and returns them (none when everything is already as rendered). A refusal
 * stops with `APPROVAL_REFUSED` before anything is written. `what` names the files in the title
 * and `refused` is the refusal's message.
 */
export async function approveAndWriteRenderedFiles(
  deps: Pick<PhaseDeps, "approvals" | "reporter">,
  root: string,
  files: readonly RenderedFile[],
  wording: { what?: string; refused?: string } = {},
): Promise<RenderedFile[]> {
  const diff = await diffRenderedFiles(root, files);
  const toWrite = [...diff.created, ...diff.changed];
  if (toWrite.length === 0) return [];
  const approval = await deps.approvals.request({
    kind: "repo-write",
    title: `Write ${wording.what ?? "the deployment files"} to the repository (${describeDiff(diff)})`,
    details: [
      ...diff.created.map((f) => `  new      ${f.path}`),
      ...diff.changed.map((f) => `  changed  ${f.path}`),
    ].join("\n"),
  });
  if (!approval.approved) {
    throw new OpsCrewError(
      "APPROVAL_REFUSED",
      wording.refused ?? "Nothing was written and nothing was created.",
    );
  }
  await writeRenderedFiles(root, toWrite);
  deps.reporter.success(`Wrote ${describeDiff(diff)}.`);
  return toWrite;
}
