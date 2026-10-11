import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "@opscrew/core";
import type { RenderedFile } from "@opscrew/iac-templates";

export interface RenderedFileDiff {
  created: RenderedFile[];
  changed: RenderedFile[];
  unchanged: RenderedFile[];
}

const normalise = (text: string) => text.replace(/\r\n/g, "\n");

/** Compares rendered files with what is on disk under `root` (line endings ignored). */
export async function diffRenderedFiles(
  root: string,
  files: readonly RenderedFile[],
): Promise<RenderedFileDiff> {
  const diff: RenderedFileDiff = { created: [], changed: [], unchanged: [] };
  for (const file of files) {
    let current: string | undefined;
    try {
      current = await readFile(join(root, file.path), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
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
  if (diff.created.length > 0)
    parts.push(`${diff.created.length} new file${diff.created.length === 1 ? "" : "s"}`);
  if (diff.changed.length > 0) parts.push(`${diff.changed.length} changed`);
  if (parts.length === 0) return "no changes";
  return parts.join(", ");
}
