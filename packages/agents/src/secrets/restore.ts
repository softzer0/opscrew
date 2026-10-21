import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  ageRecipientOf,
  ensureStateDir,
  listText,
  OpsCrewError,
  readTextIfExists,
  sha256Hex,
  sopsDecrypt,
  writeFileAtomic,
} from "@opscrew/core";
import { z } from "zod";
import type { PhaseDeps } from "../context";
import {
  COPY_PATH,
  differingGeneratedNames,
  fileMode,
  isCopyPath,
  localPath,
  registerGeneratedValues,
} from "./files";
import { readRecord, readRepositoryCopy, sopsBinary, writeRecord } from "./store";

const PlaintextSchema = z.object({ files: z.record(z.string(), z.string()) });

/** What a restore wrote, or the files it stopped at (by path and generated value name only). */
export interface RestoreResult {
  /** The copy's paths written to this computer. */
  restored: string[];
  /** Local files that differ from the copy, when the restore stopped before writing anything. */
  conflicts?: { paths: string[]; values: string[] };
}

/** The `AGE-SECRET-KEY-1…` line of a key file's text (or the key alone), checked. */
function identityOf(text: string): string {
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.startsWith("AGE-SECRET-KEY-1"));
  const identity = line ?? text.trim();
  ageRecipientOf(identity);
  return identity;
}

/** The copy to restore from: `from` (a full path, or one relative to the project), else the repository's. */
async function readCopyToRestore(
  deps: PhaseDeps,
  from: string | undefined,
): Promise<{ encrypted: string; name: string }> {
  const file = from === undefined ? undefined : resolve(deps.paths.root, from);
  const encrypted =
    file === undefined ? await readRepositoryCopy(deps.paths) : await readTextIfExists(file);
  if (encrypted !== undefined) return { encrypted, name: file ?? COPY_PATH };
  throw file === undefined
    ? new OpsCrewError(
        "PHASE_PRECONDITION",
        `There is no recovery copy (${COPY_PATH}) in this checkout, so there is nothing to restore.`,
        {
          hint: "Switch to the branch that has it (usually the latest main: `git pull`), or name another copy, such as the folder copy, then try again.",
        },
      )
    : new OpsCrewError("INVALID_INPUT", `There is no recovery copy at ${file}.`, {
        hint: "Check the path of the copy, then try again.",
      });
}

/**
 * Rebuilds this computer's files from the recovery copy with the user's age key
 * (`input.identity`: the key, or the text of the key file OpsCrew wrote), decrypted by sops
 * through pipes (FR-1413). The copy is the repository's (`opscrew/secrets.sops.json`), or
 * `input.from`, such as the folder copy. Only the copy's allowed paths are accepted. A local file
 * that exists and differs stops the restore before any write and is listed, with the names of the
 * generated values that differ, never values; `onConflict` decides: `use-copy` writes the copy's
 * version, `keep-local` keeps this computer's. Files are written atomically with their modes, never
 * when their content would not change. A wrong key stops with `SECRETS_KEY_REJECTED` and nothing
 * written.
 */
export async function restoreRecoveryCopy(
  deps: PhaseDeps,
  input: { identity: string; from?: string; onConflict?: "use-copy" | "keep-local" },
): Promise<RestoreResult> {
  const identity = identityOf(input.identity);
  deps.redactor.addLiteral(identity, "age-identity");
  const { encrypted, name } = await readCopyToRestore(deps, input.from);
  const plaintext = await sopsDecrypt(
    await sopsBinary(deps),
    { encrypted, identity, filename: COPY_PATH },
    { exec: deps.runner, redactor: deps.redactor, env: deps.env },
  );
  const parsed = PlaintextSchema.safeParse(JSON.parse(plaintext));
  if (!parsed.success) {
    throw new OpsCrewError(
      "ARTIFACT_INVALID",
      `${name} opened, but it does not hold the files of an OpsCrew recovery copy. Nothing was written.`,
      { hint: `Check that ${name} is a copy OpsCrew wrote.` },
    );
  }
  const copy = parsed.data.files;
  registerGeneratedValues(deps.redactor, copy);
  const refused = Object.keys(copy).filter((path) => !isCopyPath(path));
  if (refused.length > 0) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `${name} holds files OpsCrew never copies (${refused.join(", ")}), so OpsCrew restored nothing.`,
      { hint: `Check where ${name} came from; OpsCrew only restores its own files.` },
    );
  }

  const local: Record<string, string> = {};
  for (const path of Object.keys(copy)) {
    const text = await readTextIfExists(localPath(deps.paths, path));
    if (text !== undefined) local[path] = text;
  }
  registerGeneratedValues(deps.redactor, local);
  const differing = Object.keys(copy)
    .filter((path) => local[path] !== undefined && local[path] !== copy[path])
    .sort();
  if (differing.length > 0 && input.onConflict === undefined) {
    return {
      restored: [],
      conflicts: { paths: differing, values: differingGeneratedNames(local, copy) },
    };
  }
  const kept = new Set(input.onConflict === "keep-local" ? differing : []);
  const restored = Object.keys(copy)
    .filter((path) => local[path] !== copy[path] && !kept.has(path))
    .sort();
  if (restored.some((path) => path.startsWith("home/"))) {
    await mkdir(deps.paths.projectHomeDir, { recursive: true, mode: 0o700 });
  }
  await ensureStateDir(deps.paths);
  for (const path of restored) {
    await writeFileAtomic(localPath(deps.paths, path), copy[path] as string, {
      mode: fileMode(path),
    });
  }
  await writeRecord(deps.paths, {
    ...(await readRecord(deps.paths)),
    hashes: Object.fromEntries(Object.entries(copy).map(([path, text]) => [path, sha256Hex(text)])),
    copySha256: sha256Hex(encrypted),
  });
  return { restored };
}

/**
 * Why a restore wrote nothing: the files on this computer that differ from the copy, and the names
 * of the generated values that differ (never values).
 */
export function restoreConflictText(conflicts: NonNullable<RestoreResult["conflicts"]>): string {
  const named =
    conflicts.values.length > 0
      ? ` The generated values that differ: ${listText(conflicts.values)}.`
      : "";
  return `These files on this computer differ from the recovery copy: ${listText(conflicts.paths)}.${named} OpsCrew wrote nothing.`;
}
