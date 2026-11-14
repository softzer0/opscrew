/**
 * OpsCrew's private records on this computer, beside the deploy key: one JSON file each, readable
 * by the user only (0600 in a 0700 folder). They hold what a provider can't be asked again, such
 * as an order whose outcome is unknown.
 */
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { type OpsCrewError, readTextIfExists, writeFileAtomic } from "@opscrew/core";
import type { z } from "zod";

/** The record in `file` as `schema` reads it; undefined without the file; `damaged()` when unreadable. */
export async function readRecord<T>(
  file: string,
  schema: z.ZodType<T>,
  damaged: () => OpsCrewError,
): Promise<T | undefined> {
  const text = await readTextIfExists(file);
  if (text === undefined) return undefined;
  try {
    return schema.parse(JSON.parse(text));
  } catch {
    throw damaged();
  }
}

/** Writes `record` to `file` at once, readable by the user only. */
export async function writeRecord(file: string, record: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFileAtomic(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}
