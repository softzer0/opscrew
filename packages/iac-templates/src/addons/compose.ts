// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Compose interpolation, not JavaScript templates.
import { stringify } from "yaml";

/**
 * The deploy user the add-ons run as, from the `.env` file the host step writes beside the
 * Compose file (`OPSCREW_DEPLOY_UID`, `OPSCREW_DEPLOY_GID`): their files and folders are its own.
 */
export const DEPLOY_USER = "${OPSCREW_DEPLOY_UID}:${OPSCREW_DEPLOY_GID}";

/**
 * The image for an add-on's `version`: the pinned `ref` (by digest) when `tag` is its tag, else
 * `<repository>:<tag>`, pinned by tag only.
 */
export function addonImage(ref: string, tag: string): { image: string; pinned: boolean } {
  const repository = ref.slice(0, ref.indexOf(":"));
  return ref.startsWith(`${repository}:${tag}@`)
    ? { image: ref, pinned: true }
    : { image: `${repository}:${tag}`, pinned: false };
}

/** A Compose file: the header's comment lines, then `document` (no YAML aliases). */
export function composeFile(header: readonly string[], document: object): string {
  const comments = header.map((line) => `# ${line}`).join("\n");
  return `${comments}\n${stringify(document, { lineWidth: 0, aliasDuplicateObjects: false })}`;
}
