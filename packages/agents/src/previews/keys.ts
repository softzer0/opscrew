import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { type ProjectPaths, type Redactor, readTextIfExists, writeFileAtomic } from "@opscrew/core";
import { generateEd25519KeyPair } from "../shared/ssh-keys";

/**
 * A preview environment's preview key (ADR 0026): the only key of the preview server GitHub gets,
 * whose line there runs nothing but the recipe's `opscrew-preview`. The environment's deploy key
 * stays on this computer.
 */
export interface PreviewKey {
  /** `-----BEGIN OPENSSH PRIVATE KEY-----` …, with its final newline. */
  privateKeyOpenSsh: string;
  /** `ssh-ed25519 AAAA… opscrew-preview@<project>`. */
  publicKeyOpenSsh: string;
  /** True when this run made it. */
  created: boolean;
}

/**
 * The environment's Ed25519 preview key (`files.previewKey`, `files.previewKeyPub`), made once
 * (the private half 0600, in a folder only the user can open) and reused; its private half is
 * registered with the redactor.
 */
export async function ensurePreviewKey(
  paths: Pick<ProjectPaths, "files" | "projectId">,
  redactor: Pick<Redactor, "addLiteral">,
): Promise<PreviewKey> {
  const { previewKey, previewKeyPub } = paths.files;
  const privateKeyOpenSsh = await readTextIfExists(previewKey);
  const publicKeyOpenSsh = (await readTextIfExists(previewKeyPub))?.trim();
  let key: PreviewKey;
  if (privateKeyOpenSsh && publicKeyOpenSsh) {
    key = { privateKeyOpenSsh, publicKeyOpenSsh, created: false };
  } else {
    const pair = generateEd25519KeyPair(`opscrew-preview@${paths.projectId}`);
    await mkdir(dirname(previewKey), { recursive: true, mode: 0o700 });
    await writeFileAtomic(previewKey, pair.privateKeyOpenSsh, { mode: 0o600 });
    await writeFileAtomic(previewKeyPub, `${pair.publicKeyOpenSsh}\n`, { mode: 0o644 });
    key = {
      privateKeyOpenSsh: pair.privateKeyOpenSsh,
      publicKeyOpenSsh: pair.publicKeyOpenSsh,
      created: true,
    };
  }
  redactor.addLiteral(key.privateKeyOpenSsh, "preview-key");
  return key;
}
