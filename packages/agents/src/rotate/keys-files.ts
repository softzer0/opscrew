/**
 * The files of an SSH key while it rotates (plan.md 5.): the new pair made on this computer and
 * kept beside the current one (`<key>.next`, `<key>.next.pub`) until it proved itself, then moved
 * into place, with the old public half (`<key>.previous.pub`) kept until every server dropped it.
 * The files say where a rotation stopped, so running it again goes on from there.
 */
import { rename, rm } from "node:fs/promises";
import {
  OpsCrewError,
  type ProjectPaths,
  type Redactor,
  readTextIfExists,
  writeFileAtomic,
} from "@opscrew/core";
import { appPaths } from "../apps/list";
import { readCheckKey } from "../check/key";
import { ensureKeyPair } from "../shared/ssh-keys";

/** The SSH keys `opscrew rotate` replaces. */
export type SshKeyName = "deploy-key" | "check-key" | "preview-key";

/** One half-pair as OpsCrew keeps it. */
export interface KeyHalves {
  /** The unencrypted OpenSSH private key, with its final newline. */
  privateKeyOpenSsh: string;
  /** `ssh-ed25519 AAAA… [comment]`: with OpsCrew's comment (the check key's file has none). */
  publicKeyOpenSsh: string;
}

/** Where a rotation of the key stands, from its files. */
export type KeyStage =
  /** The new pair waits beside the current one: added, replaced and proven next. */
  | { stage: "add"; current: KeyHalves; next: KeyHalves; nextFile: string }
  /** The new pair is in place and proved itself; the old public half is removed next. */
  | { stage: "remove"; current: KeyHalves; previousPublicKey: string };

/** The key's files on this computer. */
interface KeyFiles {
  private: string;
  /** Its public half's file; the check key has none (its public half is read from the private). */
  public?: string;
  comment: string;
}

function keyFiles(paths: ProjectPaths, which: SshKeyName): KeyFiles {
  switch (which) {
    case "deploy-key":
      return {
        private: paths.files.deployKey,
        public: paths.files.deployKeyPub,
        comment: `opscrew-deploy@${paths.projectId}`,
      };
    case "preview-key":
      return {
        private: paths.files.previewKey,
        public: paths.files.previewKeyPub,
        comment: `opscrew-preview@${paths.projectId}`,
      };
    case "check-key":
      // The repository's one key, the first app's prod's (check/key.ts).
      return {
        private: appPaths(paths, undefined).files.checkKey,
        comment: `opscrew-check@${paths.projectId}`,
      };
  }
}

const next = (file: string) => `${file}.next`;
const previous = (file: string) => `${file}.previous.pub`;

/** `<type> <base64>` of a public key line: what an authorized_keys line holds, whatever else. */
export function bareKey(publicKey: string): string {
  return publicKey.trim().split(/\s+/).slice(0, 2).join(" ");
}

/** The current pair, its private half registered with the redactor. */
async function readCurrent(
  paths: ProjectPaths,
  which: SshKeyName,
  redactor: Pick<Redactor, "addLiteral">,
): Promise<KeyHalves | undefined> {
  const files = keyFiles(paths, which);
  if (files.public === undefined) {
    const key = await readCheckKey(paths, redactor);
    return key === undefined
      ? undefined
      : { privateKeyOpenSsh: key.privateKeyOpenSsh, publicKeyOpenSsh: key.publicKeyOpenSsh };
  }
  const privateKeyOpenSsh = await readTextIfExists(files.private);
  const publicKeyOpenSsh = (await readTextIfExists(files.public))?.trim();
  if (privateKeyOpenSsh === undefined || !publicKeyOpenSsh) return undefined;
  redactor.addLiteral(privateKeyOpenSsh, which);
  return { privateKeyOpenSsh, publicKeyOpenSsh };
}

/** Moves the files of the new pair over the current ones, those that are still there. */
async function moveNext(files: KeyFiles): Promise<void> {
  const nextFile = next(files.private);
  if ((await readTextIfExists(nextFile)) !== undefined) await rename(nextFile, files.private);
  if ((await readTextIfExists(`${nextFile}.pub`)) === undefined) return;
  if (files.public === undefined) await rm(`${nextFile}.pub`);
  else await rename(`${nextFile}.pub`, files.public);
}

/**
 * Where the rotation of `which` stands on this computer: the old public half kept means the new
 * pair is in place (a move that stopped half-way is finished first); a new pair beside the current
 * one is reused; otherwise a new Ed25519 pair is made beside it (`ensureKeyPair`). Every
 * private half is registered with the redactor.
 * @throws OpsCrewError `PHASE_PRECONDITION` when this computer does not have the key.
 */
export async function keyStage(
  paths: ProjectPaths,
  which: SshKeyName,
  redactor: Pick<Redactor, "addLiteral">,
): Promise<KeyStage> {
  const files = keyFiles(paths, which);
  const kept = (await readTextIfExists(previous(files.private)))?.trim();
  if (kept) {
    await moveNext(files);
    const current = await readCurrent(paths, which, redactor);
    if (current !== undefined) return { stage: "remove", current, previousPublicKey: kept };
  }
  const current = await readCurrent(paths, which, redactor);
  if (current === undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `The ${which} is not on this computer (${files.private}), so OpsCrew cannot replace it: the new key is added with the old one's help. Nothing was changed.`,
      {
        hint: "Run the command on the computer that ran `opscrew provision`, or put the key back with `opscrew secrets restore`, then run it again.",
      },
    );
  }
  const nextFile = next(files.private);
  const pair = await ensureKeyPair(
    { private: nextFile, public: `${nextFile}.pub` },
    files.comment,
    redactor,
    which,
  );
  const made = {
    privateKeyOpenSsh: pair.privateKeyOpenSsh,
    publicKeyOpenSsh: pair.publicKeyOpenSsh,
  };
  // The check key's secret is its file's text, which may end without the newline.
  redactor.addLiteral(made.privateKeyOpenSsh.trim(), which);
  return { stage: "add", current, next: made, nextFile };
}

/**
 * Puts the new pair in place once it proved itself: the old public half kept first (the servers
 * still to drop it), then the new files moved over the current ones.
 */
export async function moveIntoPlace(
  paths: ProjectPaths,
  which: SshKeyName,
  oldPublicKey: string,
): Promise<void> {
  const files = keyFiles(paths, which);
  await writeFileAtomic(previous(files.private), `${oldPublicKey}\n`, { mode: 0o644 });
  await moveNext(files);
}

/** Forgets the old public half once no server holds it: the rotation is done. */
export async function forgetPrevious(paths: ProjectPaths, which: SshKeyName): Promise<void> {
  await rm(previous(keyFiles(paths, which).private), { force: true });
}
