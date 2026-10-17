import { join } from "node:path";
import { OpsCrewError, plural, readTextIfExists, writeFileAtomic } from "@opscrew/core";
import type { RenderedFile } from "@opscrew/iac-templates";
import type { z } from "zod";
import type { PhaseDeps } from "../context";

export interface RenderedFileDiff {
  created: RenderedFile[];
  changed: RenderedFile[];
  unchanged: RenderedFile[];
}

const normalise = (text: string) => text.replace(/\r\n/g, "\n");

/**
 * The JSON file's content when it is valid for `schema`; `undefined` when the file is missing, is
 * not JSON or does not match. Any other read error (for example a file OpsCrew may not read) is
 * thrown.
 */
export async function readValidJson<T>(file: string, schema: z.ZodType<T>): Promise<T | undefined> {
  const text = await readTextIfExists(file);
  if (text === undefined) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  const parsed = schema.safeParse(json);
  return parsed.success ? parsed.data : undefined;
}

/** Compares rendered files with what is on disk under `root` (line endings ignored). */
export async function diffRenderedFiles(
  root: string,
  files: readonly RenderedFile[],
): Promise<RenderedFileDiff> {
  const diff: RenderedFileDiff = { created: [], changed: [], unchanged: [] };
  for (const file of files) {
    const current = await readTextIfExists(join(root, file.path));
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
