import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { OpsCrewError, type ProjectPaths, readTextIfExists, writeFileAtomic } from "@opscrew/core";

/** A secret OpsCrew keeps in a private file (mode 0600) of the user's OpsCrew folder. */
export interface SecretFile {
  file: string;
  /** True for a value OpsCrew can use (the trimmed text of the file). */
  valid: (value: string) => boolean;
  /** The plain stop when the file holds no valid value: what is wrong and what to do. */
  damaged: { message: string; hint: string };
}

/**
 * The secret's value (trimmed), or `undefined` when its file does not exist. A file that holds no
 * valid value (short or damaged) stops with `ARTIFACT_INVALID` and is never replaced: what was
 * made with the secret (encrypted state, an admin account) needs exactly that value.
 */
export async function readSecretFile(secret: SecretFile): Promise<string | undefined> {
  const text = await readTextIfExists(secret.file);
  if (text === undefined) return undefined;
  const value = text.trim();
  if (!secret.valid(value)) {
    throw new OpsCrewError("ARTIFACT_INVALID", secret.damaged.message, {
      hint: secret.damaged.hint,
    });
  }
  return value;
}

/**
 * {@link readSecretFile}, or, when the file does not exist, a new value from `create`, written once
 * (mode 0600, in a folder only the user can open).
 */
export async function ensureSecretFile(secret: SecretFile, create: () => string): Promise<string> {
  const existing = await readSecretFile(secret);
  if (existing !== undefined) return existing;
  const value = create();
  await mkdir(dirname(secret.file), { recursive: true, mode: 0o700 });
  await writeFileAtomic(secret.file, `${value}\n`, { mode: 0o600 });
  return value;
}

/** The project's OpenTofu state passphrase: at least 16 characters (OpsCrew writes 43). */
export function statePassphraseFile(paths: Pick<ProjectPaths, "files">): SecretFile {
  const file = paths.files.statePassphrase;
  return {
    file,
    valid: (value) => value.length >= 16,
    damaged: {
      message: `OpsCrew's state passphrase for this project (${file}) is damaged, so OpsCrew stopped instead of making a new one: the infrastructure state in .opscrew/tfstate is encrypted with it, and a new passphrase could not read that state. Nothing was changed.`,
      hint: "Put the passphrase back from a backup of that file (or copy the file from the computer that ran `opscrew provision`), then run the command again.",
    },
  };
}

/** The OpenTofu state passphrase for this project, created once (32 random bytes, base64url). */
export function ensureStatePassphrase(paths: Pick<ProjectPaths, "files">): Promise<string> {
  return ensureSecretFile(statePassphraseFile(paths), () => randomBytes(32).toString("base64url"));
}
