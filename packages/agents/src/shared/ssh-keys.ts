import { createHash, generateKeyPairSync, randomBytes, randomInt } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  OpsCrewError,
  type ProjectPaths,
  type Redactor,
  readTextIfExists,
  writeFileAtomic,
} from "@opscrew/core";
import type { PhaseDeps } from "../context";

export interface Ed25519KeyPair {
  /** `-----BEGIN OPENSSH PRIVATE KEY-----` … (unencrypted openssh-key-v1). */
  privateKeyOpenSsh: string;
  /** `ssh-ed25519 AAAA… comment` */
  publicKeyOpenSsh: string;
  /** `SHA256:…` as printed by `ssh-keygen -lf`. */
  fingerprintSha256: string;
}

function sshString(value: Buffer | string): Buffer {
  const data = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([length, data]);
}

function uint32(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(value >>> 0);
  return out;
}

/** Generates an Ed25519 key pair in OpenSSH formats using Node's built-in crypto. */
export function generateEd25519KeyPair(
  comment: string,
  random: (size: number) => Buffer = randomBytes,
): Ed25519KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = privateKey.export({ format: "jwk" });
  const pub = Buffer.from(publicKey.export({ format: "jwk" }).x ?? "", "base64url");
  const seed = Buffer.from(jwk.d ?? "", "base64url");
  if (pub.length !== 32 || seed.length !== 32) throw new Error("Unexpected Ed25519 key length");

  const keyType = "ssh-ed25519";
  const publicBlob = Buffer.concat([sshString(keyType), sshString(pub)]);
  const check = random(4);
  let privateSection = Buffer.concat([
    check,
    check,
    sshString(keyType),
    sshString(pub),
    sshString(Buffer.concat([seed, pub])),
    sshString(comment),
  ]);
  const padding: number[] = [];
  for (let i = 1; (privateSection.length + padding.length) % 8 !== 0; i++) padding.push(i);
  privateSection = Buffer.concat([privateSection, Buffer.from(padding)]);

  const body = Buffer.concat([
    Buffer.from("openssh-key-v1\0", "binary"),
    sshString("none"),
    sshString("none"),
    sshString(""),
    uint32(1),
    sshString(publicBlob),
    sshString(privateSection),
  ]);
  const base64 =
    body
      .toString("base64")
      .match(/.{1,70}/g)
      ?.join("\n") ?? "";
  const fingerprint = createHash("sha256").update(publicBlob).digest("base64").replace(/=+$/, "");
  return {
    privateKeyOpenSsh: `-----BEGIN OPENSSH PRIVATE KEY-----\n${base64}\n-----END OPENSSH PRIVATE KEY-----\n`,
    publicKeyOpenSsh: `${keyType} ${publicBlob.toString("base64")} ${comment}`,
    fingerprintSha256: `SHA256:${fingerprint}`,
  };
}

/** An Ed25519 key pair OpsCrew keeps on this computer. */
export interface KeyPair {
  /** `-----BEGIN OPENSSH PRIVATE KEY-----` …, with its final newline. */
  privateKeyOpenSsh: string;
  /** `ssh-ed25519 AAAA… <comment>`. */
  publicKeyOpenSsh: string;
  /** True when this run made it. */
  created: boolean;
}

/**
 * The Ed25519 key pair in `files.private` and `files.public`, made once with `comment` (the
 * private half 0600, in a folder only the user can open) and reused; its private half is
 * registered with the redactor as `label`.
 */
export async function ensureKeyPair(
  files: { private: string; public: string },
  comment: string,
  redactor: Pick<Redactor, "addLiteral">,
  label: string,
): Promise<KeyPair> {
  const privateKeyOpenSsh = await readTextIfExists(files.private);
  const publicKeyOpenSsh = await readTextIfExists(files.public);
  let key: KeyPair;
  if (privateKeyOpenSsh && publicKeyOpenSsh) {
    key = { privateKeyOpenSsh, publicKeyOpenSsh: publicKeyOpenSsh.trim(), created: false };
  } else {
    const pair = generateEd25519KeyPair(comment);
    await mkdir(dirname(files.private), { recursive: true, mode: 0o700 });
    await writeFileAtomic(files.private, pair.privateKeyOpenSsh, { mode: 0o600 });
    await writeFileAtomic(files.public, `${pair.publicKeyOpenSsh}\n`, { mode: 0o644 });
    key = {
      privateKeyOpenSsh: pair.privateKeyOpenSsh,
      publicKeyOpenSsh: pair.publicKeyOpenSsh,
      created: true,
    };
  }
  redactor.addLiteral(key.privateKeyOpenSsh, label);
  return key;
}

export interface DeployKey extends KeyPair {
  privateKeyFile: string;
}

/**
 * Creates the project's deploy key once (`~/.opscrew/projects/<id>/deploy_key`) and reuses it. Its
 * private half is registered with the redactor.
 */
export async function ensureDeployKey(
  paths: ProjectPaths,
  redactor: Pick<Redactor, "addLiteral">,
): Promise<DeployKey> {
  const { deployKey, deployKeyPub } = paths.files;
  const files = { private: deployKey, public: deployKeyPub };
  const comment = `opscrew-deploy@${paths.projectId}`;
  const key = await ensureKeyPair(files, comment, redactor, "deploy-key");
  return { ...key, privateKeyFile: deployKey };
}

/** How to bring the deploy key to this computer; `then` ends it (`then try again.`). */
export function copyDeployKeyHint(paths: Pick<ProjectPaths, "files">, then: string): string {
  return `Copy the deploy key files from the computer that ran \`opscrew provision\` to ${paths.files.deployKey} and ${paths.files.deployKeyPub}, ${then}`;
}

/**
 * The stop (`PHASE_PRECONDITION`) when the project's deploy key is not on this computer: what
 * OpsCrew `cannot` do and what stayed as it was (`cannot reach the servers. Nothing was
 * changed.`), and the {@link copyDeployKeyHint} that ends with `then`.
 */
export function deployKeyMissing(
  paths: Pick<ProjectPaths, "files">,
  cannot: string,
  then: string,
): OpsCrewError {
  return new OpsCrewError(
    "PHASE_PRECONDITION",
    `The project's deploy key is not on this computer, so OpsCrew ${cannot}`,
    { hint: copyDeployKeyHint(paths, then) },
  );
}

/**
 * The public half of the project's deploy key, read and never created. Stops with
 * {@link deployKeyMissing} when it is not on this computer: OpsCrew `cannot` (`cannot compare
 * your server with its setup`), and nothing was checked.
 */
export async function readDeployPublicKey(
  deps: Pick<PhaseDeps, "paths">,
  cannot: string,
): Promise<string> {
  const key = ((await readTextIfExists(deps.paths.files.deployKeyPub)) ?? "").trim();
  if (key === "") {
    throw deployKeyMissing(deps.paths, `${cannot}. Nothing was checked.`, "then try again.");
  }
  return key;
}

const PASSWORD_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** Random password safe in URLs, dotenv files and shells (letters and digits only). */
export function randomPassword(length = 32): string {
  let out = "";
  for (let i = 0; i < length; i++) out += PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)];
  return out;
}
