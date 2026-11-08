import { randomBytes } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
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

/** A new state passphrase: 32 random bytes, base64url (43 characters). */
export function newStatePassphrase(): string {
  return randomBytes(32).toString("base64url");
}

/** The OpenTofu state passphrase for this project, created once (32 random bytes, base64url). */
export function ensureStatePassphrase(paths: Pick<ProjectPaths, "files">): Promise<string> {
  return ensureSecretFile(statePassphraseFile(paths), newStatePassphrase);
}

/**
 * The new state passphrase of an unfinished rotation (`state_passphrase.next`, beside the current
 * one, feature 025): kept right before the apply that rewrites the state under it, so the state is
 * never encrypted with a passphrase this computer does not keep, until it replaces the current one.
 */
export function nextStatePassphraseFile(paths: Pick<ProjectPaths, "files">): SecretFile {
  const file = `${paths.files.statePassphrase}.next`;
  return {
    file,
    valid: (value) => value.length >= 16,
    damaged: {
      message: `The new state passphrase of an unfinished rotation (${file}) is damaged, so OpsCrew stopped: the infrastructure state may already be encrypted with it. Nothing was changed.`,
      hint: "Put the file back from a backup, then run `opscrew rotate state-passphrase` again.",
    },
  };
}

/**
 * Keeps `passphrase` as the new one of the unfinished rotation of the state passphrase (0600, in
 * a folder only the user can open), before anything is encrypted with it.
 */
export async function keepNextStatePassphrase(
  paths: Pick<ProjectPaths, "files">,
  passphrase: string,
): Promise<void> {
  const { file } = nextStatePassphraseFile(paths);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFileAtomic(file, `${passphrase}\n`, { mode: 0o600 });
}

/**
 * Ends the rotation of the state passphrase: its new passphrase replaces the current one (0600),
 * then its own file goes.
 */
export async function adoptNextStatePassphrase(
  paths: Pick<ProjectPaths, "files">,
  passphrase: string,
): Promise<void> {
  await writeFileAtomic(paths.files.statePassphrase, `${passphrase}\n`, { mode: 0o600 });
  await rm(nextStatePassphraseFile(paths).file, { force: true });
}
