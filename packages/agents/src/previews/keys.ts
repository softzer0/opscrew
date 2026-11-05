import type { ProjectPaths, Redactor } from "@opscrew/core";
import { ensureKeyPair, type KeyPair } from "../shared/ssh-keys";

/**
 * The environment's Ed25519 preview key (ADR 0026, `files.previewKey`, `files.previewKeyPub`):
 * the only key of the preview server GitHub gets, whose line there runs nothing but the recipe's
 * `opscrew-preview`; the environment's deploy key stays on this computer. Made once and reused
 * (`ensureKeyPair`).
 */
export function ensurePreviewKey(
  paths: Pick<ProjectPaths, "files" | "projectId">,
  redactor: Pick<Redactor, "addLiteral">,
): Promise<KeyPair> {
  const files = { private: paths.files.previewKey, public: paths.files.previewKeyPub };
  return ensureKeyPair(files, `opscrew-preview@${paths.projectId}`, redactor, "preview-key");
}
