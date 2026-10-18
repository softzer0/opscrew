import { join } from "node:path";
import { OpsCrewError, plural, readTextIfExists, writeFileAtomic } from "@opscrew/core";
import { keepNewerPins, type RenderedFile } from "@opscrew/iac-templates";
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

/**
 * What OpsCrew writes for `file` over `current`, the copy on disk: the rendered content with the
 * copy's newer image and action pins kept (FR-1222), so a pin the user or Dependabot updated is
 * never reverted.
 */
function withCommittedPins(file: RenderedFile, current: string | undefined): RenderedFile {
  return current === undefined ? file : { ...file, content: keepNewerPins(current, file.content) };
}

/**
 * The repository's copies of those of `paths` that exist under `root`, joined: what OpsCrew
 * passes to `keepNewerPins` for content it sends to a server or compares with one instead of
 * writing it (FR-1222), so it carries the pins the user or Dependabot set in the committed files.
 */
export async function committedText(root: string, paths: readonly string[]): Promise<string> {
  const copies = await Promise.all(paths.map((path) => readTextIfExists(join(root, path))));
  return copies.filter((copy) => copy !== undefined).join("\n");
}

/**
 * Compares rendered files with what is on disk under `root` (line endings ignored). A file on disk
 * is compared with, and `changed` and `unchanged` hold, the rendered content with its newer pins
 * kept.
 */
export async function diffRenderedFiles(
  root: string,
  files: readonly RenderedFile[],
): Promise<RenderedFileDiff> {
  const diff: RenderedFileDiff = { created: [], changed: [], unchanged: [] };
  for (const rendered of files) {
    const current = await readTextIfExists(join(root, rendered.path));
    const file = withCommittedPins(rendered, current);
    if (current === undefined) diff.created.push(file);
    else if (normalise(current) === normalise(file.content)) diff.unchanged.push(file);
    else diff.changed.push(file);
  }
  return diff;
}

/**
 * Writes rendered files under `root` atomically with LF line endings, keeping the newer pins of a
 * file already there.
 */
export async function writeRenderedFiles(
  root: string,
  files: readonly RenderedFile[],
): Promise<void> {
  for (const rendered of files) {
    const target = join(root, rendered.path);
    const file = withCommittedPins(rendered, await readTextIfExists(target));
    await writeFileAtomic(target, normalise(file.content), {
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
