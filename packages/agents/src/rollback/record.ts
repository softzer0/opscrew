/**
 * What a rollback binds and records (data-model.md): its approval's hash, and on this computer the
 * environment's last rollback (`rollback.json`) and a run left waiting for a reviewer
 * (`pending-rollback.json`), in the environment's state folder (`.opscrew/…`, gitignored).
 */
import { join } from "node:path";
import { canonicalJson, type ProjectPaths, sha256Hex, writeFileAtomic } from "@opscrew/core";
import { z } from "zod";
import { readValidJson } from "../shared";
import { DeployPauseSchema } from "../shared/deploy-pause";

/** What a rollback's `promote` approval binds (ADR 0023 D5). */
export interface ImageRollbackParts {
  /** The environment's key, `<app>/<env>` (`checkEnvironmentKey`). */
  environment: string;
  /** The image it runs now: its digest (this computer: its reference). */
  current: string;
  /** The image it goes back to, in the same form. */
  target: string;
  /** SHA-256 of the environment plan's canonical JSON. */
  targetPlanHash: string;
}

/**
 * The rollback's approval hash: SHA-256 of the canonical `{ environment, current, target,
 * targetPlanHash }`, so a change of any of the four needs a new approval.
 */
export function imageRollbackHash(parts: ImageRollbackParts): string {
  const { environment, current, target, targetPlanHash } = parts;
  return sha256Hex(canonicalJson({ environment, current, target, targetPlanHash }));
}

/** An image a rollback went to or from (this computer's: by its reference, maybe no commit). */
const ImageSchema = z.object({ digest: z.string(), commit: z.string().optional() });

/** A rollback that succeeded. */
const RolledBackSchema = ImageSchema.extend({
  /** What ran before it. */
  from: ImageSchema,
  /** The deploy run (none on Cloudflare's hosting or this computer). */
  runUrl: z.string().optional(),
  /** When it succeeded. */
  at: z.string(),
  /** The approval's hash. */
  hash: z.string(),
});

export type RolledBack = z.infer<typeof RolledBackSchema>;

/** `rollback.json`: the environment's last rollback, with the one it replaced. */
const RollbackRecordSchema = RolledBackSchema.extend({ previous: RolledBackSchema.optional() });

export type RollbackRecord = z.infer<typeof RollbackRecordSchema>;

/** `rollback.json` in the environment's local state folder. */
export function rollbackFile(paths: Pick<ProjectPaths, "stateDir">): string {
  return join(paths.stateDir, "rollback.json");
}

/** The environment's last rollback on this computer, if any. */
export function readRollback(
  paths: Pick<ProjectPaths, "stateDir">,
): Promise<RollbackRecord | undefined> {
  return readValidJson(rollbackFile(paths), RollbackRecordSchema);
}

/** Records the environment's rollback, with the one it replaces (without that one's own). */
export async function writeRollback(
  paths: Pick<ProjectPaths, "stateDir">,
  rolledBack: RolledBack,
): Promise<void> {
  const replaced = await readRollback(paths);
  const record: RollbackRecord =
    replaced === undefined
      ? rolledBack
      : { ...rolledBack, previous: RolledBackSchema.parse(replaced) };
  await writeFileAtomic(rollbackFile(paths), `${JSON.stringify(record, null, 2)}\n`);
}

/** A rollback whose deploy run still waited for a required reviewer when the command ended. */
const PendingRollbackSchema = z.object({
  digest: z.string(),
  commit: z.string(),
  from: ImageSchema,
  runId: z.number(),
  /** When the run was left waiting. */
  at: z.string(),
  hash: z.string(),
  /** The environment's pause entry the rollback replaced, put back when the run fails. */
  pauseBefore: DeployPauseSchema.nullable(),
});

export type PendingRollback = z.infer<typeof PendingRollbackSchema>;

/** The pending rollback's file in the environment's local state folder. */
export const PENDING_ROLLBACK_FILE = "pending-rollback.json";

/** The environment's pending rollback, if any. */
export function readPendingRollback(
  paths: Pick<ProjectPaths, "stateDir">,
): Promise<PendingRollback | undefined> {
  return readValidJson(join(paths.stateDir, PENDING_ROLLBACK_FILE), PendingRollbackSchema);
}

/** Records the environment's pending rollback, replacing the one before. */
export async function writePendingRollback(
  paths: Pick<ProjectPaths, "stateDir">,
  pending: PendingRollback,
): Promise<void> {
  await writeFileAtomic(
    join(paths.stateDir, PENDING_ROLLBACK_FILE),
    `${JSON.stringify(pending, null, 2)}\n`,
  );
}
