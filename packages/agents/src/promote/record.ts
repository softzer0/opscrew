import { join } from "node:path";
import { canonicalJson, type ProjectPaths, sha256Hex, writeFileAtomic } from "@opscrew/core";

/** What the `promote` approval binds: both environments, the image and the target's plan. */
export interface PromotionParts {
  target: string;
  source: string;
  /** `sha256:<64 hex>`. */
  digest: string;
  /** SHA-256 of the target plan's canonical JSON. */
  targetPlanHash: string;
}

/**
 * The `promote` approval's hash: SHA-256 of the canonical `{ target, source, digest,
 * targetPlanHash }`, so a change of any of the four needs a new approval.
 */
export function promotionHash(parts: PromotionParts): string {
  const { target, source, digest, targetPlanHash } = parts;
  return sha256Hex(canonicalJson({ target, source, digest, targetPlanHash }));
}

/** The image an environment last got by `opscrew promote`, once the deploy run succeeded. */
interface Promotion {
  digest: string;
  source: string;
  runUrl: string;
  /** When the run had succeeded. */
  at: string;
}

/** `promotion.json` in the environment's local state folder (`.opscrew/…`, gitignored). */
export function promotionFile(paths: Pick<ProjectPaths, "stateDir">): string {
  return join(paths.stateDir, "promotion.json");
}

/** Records the environment's promotion, replacing the one before. */
export async function writePromotion(
  paths: Pick<ProjectPaths, "stateDir">,
  promotion: Promotion,
): Promise<void> {
  await writeFileAtomic(promotionFile(paths), `${JSON.stringify(promotion, null, 2)}\n`);
}
