import type { ProjectPaths, Redactor } from "@opscrew/core";
import { appPaths } from "../apps/list";
import { ensureSecretFile, readSecretFile, type SecretFile } from "../shared/secret-files";
import { generateEd25519KeyPair } from "../shared/ssh-keys";

/** The scheduled check's key: the one key servers let run only `df`. */
export interface CheckKey {
  /** The unencrypted OpenSSH private key, with its final newline. */
  privateKeyOpenSsh: string;
  /** `ssh-ed25519 AAAA…`, without a comment. */
  publicKeyOpenSsh: string;
  /** True when this run generated it. */
  created: boolean;
}

const ARMOUR =
  /^-----BEGIN OPENSSH PRIVATE KEY-----\n([A-Za-z0-9+/=\n]+)\n-----END OPENSSH PRIVATE KEY-----$/;

/**
 * The public key inside an unencrypted OpenSSH private key (`openssh-key-v1`): the first public
 * key blob after the cipher, KDF and key count. `undefined` for anything else.
 */
function publicKeyOf(privateKey: string): string | undefined {
  const body = ARMOUR.exec(privateKey.replace(/\r\n/g, "\n").trim())?.[1];
  if (body === undefined) return undefined;
  const data = Buffer.from(body.replace(/\n/g, ""), "base64");
  const magic = "openssh-key-v1\0";
  if (data.subarray(0, magic.length).toString("binary") !== magic) return undefined;
  let at = magic.length;
  const next = (): Buffer | undefined => {
    if (at + 4 > data.length) return undefined;
    const length = data.readUInt32BE(at);
    const value = data.subarray(at + 4, at + 4 + length);
    at += 4 + length;
    return value.length === length ? value : undefined;
  };
  for (let i = 0; i < 3; i++) next(); // cipher name, KDF name, KDF options
  at += 4; // the number of keys
  const blob = next();
  if (blob === undefined || blob.length === 0) return undefined;
  const type = blob.subarray(4, 4 + blob.readUInt32BE(0)).toString("utf8");
  return type === "ssh-ed25519" ? `${type} ${blob.toString("base64")}` : undefined;
}

/**
 * The check key's file: one per repository, the first app's prod `check_key`
 * (`~/.opscrew/projects/<id>/check_key`, in the recovery copy), whatever app or environment runs.
 */
function checkKeyFile(paths: Pick<ProjectPaths, "root" | "homeDir">): SecretFile {
  const file = appPaths(paths, undefined).files.checkKey;
  return {
    file,
    valid: (value) => publicKeyOf(value) !== undefined,
    damaged: {
      message: `The scheduled check's key (${file}) is damaged, so OpsCrew stopped instead of making a new one: your servers and GitHub hold the one it should be. Nothing was changed.`,
      hint: "Put the file back from your recovery copy (`opscrew secrets restore`) or from the computer that ran `opscrew provision`, or delete it to have OpsCrew make a new key, then run the command again.",
    },
  };
}

/** The key from its file's text (trimmed), its private half registered with the redactor. */
function checkKeyOf(
  value: string,
  redactor: Pick<Redactor, "addLiteral">,
  created: boolean,
): CheckKey {
  const privateKeyOpenSsh = `${value}\n`;
  redactor.addLiteral(privateKeyOpenSsh, "check-key");
  redactor.addLiteral(value, "check-key");
  return { privateKeyOpenSsh, publicKeyOpenSsh: publicKeyOf(value) as string, created };
}

/** The scheduled check's key when this computer has it ({@link checkKeyFile}), else `undefined`. */
export async function readCheckKey(
  paths: Pick<ProjectPaths, "root" | "homeDir">,
  redactor: Pick<Redactor, "addLiteral">,
): Promise<CheckKey | undefined> {
  const value = await readSecretFile(checkKeyFile(paths));
  return value === undefined ? undefined : checkKeyOf(value, redactor, false);
}

/**
 * The scheduled check's Ed25519 key, generated once for the repository ({@link checkKeyFile}) and
 * reused; its private half is registered with the redactor.
 */
export async function ensureCheckKey(
  paths: Pick<ProjectPaths, "root" | "homeDir" | "projectId">,
  redactor: Pick<Redactor, "addLiteral">,
): Promise<CheckKey> {
  const existing = await readCheckKey(paths, redactor);
  if (existing !== undefined) return existing;
  const value = await ensureSecretFile(checkKeyFile(paths), () =>
    generateEd25519KeyPair(`opscrew-check@${paths.projectId}`).privateKeyOpenSsh.trim(),
  );
  return checkKeyOf(value, redactor, true);
}
