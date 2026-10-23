import { rm } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson, type ProjectPaths, sha256Hex, writeFileAtomic } from "@opscrew/core";
import { z } from "zod";
import { readValidJson } from "../shared";

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

/** The image an environment got by `opscrew promote`, once the deploy run succeeded. */
const PromotionSchema = z.object({
  digest: z.string(),
  source: z.string(),
  runUrl: z.string(),
  /** When the run had succeeded. */
  at: z.string(),
  /** The services of the environment's plan the image was deployed with, by name. */
  services: z.array(z.string()),
});

type Promotion = z.infer<typeof PromotionSchema>;

/** `promotion.json`: the environment's last promotion, with the one it replaced. */
const PromotionRecordSchema = PromotionSchema.extend({ previous: PromotionSchema.optional() });

export type PromotionRecord = z.infer<typeof PromotionRecordSchema>;

/** `promotion.json` in the environment's local state folder (`.opscrew/…`, gitignored). */
export function promotionFile(paths: Pick<ProjectPaths, "stateDir">): string {
  return join(paths.stateDir, "promotion.json");
}

/** The environment's recorded promotion on this computer, if any. */
export async function readPromotion(
  paths: Pick<ProjectPaths, "stateDir">,
): Promise<PromotionRecord | undefined> {
  return readValidJson(promotionFile(paths), PromotionRecordSchema);
}

/** A promotion whose deploy run still waited for a required reviewer when promote ended. */
const PendingPromotionSchema = z.object({
  digest: z.string(),
  source: z.string(),
  runId: z.number(),
  /** When the run was left waiting. */
  at: z.string(),
});

export type PendingPromotion = z.infer<typeof PendingPromotionSchema>;

/** `pending-promotion.json` in the environment's local state folder. */
function pendingFile(paths: Pick<ProjectPaths, "stateDir">): string {
  return join(paths.stateDir, "pending-promotion.json");
}

/** The environment's pending promotion, if any. */
export async function readPendingPromotion(
  paths: Pick<ProjectPaths, "stateDir">,
): Promise<PendingPromotion | undefined> {
  return readValidJson(pendingFile(paths), PendingPromotionSchema);
}

/** Records the environment's pending promotion, replacing the one before. */
export async function writePendingPromotion(
  paths: Pick<ProjectPaths, "stateDir">,
  pending: PendingPromotion,
): Promise<void> {
  await writeFileAtomic(pendingFile(paths), `${JSON.stringify(pending, null, 2)}\n`);
}

/** Removes the environment's pending promotion. */
export async function clearPendingPromotion(paths: Pick<ProjectPaths, "stateDir">): Promise<void> {
  await rm(pendingFile(paths), { force: true });
}

/**
 * Records the environment's promotion, with the one it replaces as `previous` (what a rollback to
 * the image before is checked against).
 */
export async function writePromotion(
  paths: Pick<ProjectPaths, "stateDir">,
  promotion: Promotion,
): Promise<void> {
  const replaced = await readPromotion(paths);
  const record: PromotionRecord =
    replaced === undefined
      ? promotion
      : { ...promotion, previous: PromotionSchema.parse(replaced) };
  await writeFileAtomic(promotionFile(paths), `${JSON.stringify(record, null, 2)}\n`);
}
