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

/** How a rollback treats the database (`--database`, plan.md 12.5). */
export const DATABASE_CHOICES = ["snapshot", "migrations", "keep"] as const;

export type DatabaseChoice = (typeof DATABASE_CHOICES)[number];

/**
 * What a rollback's hash binds of the database once OpsCrew read the server: the choice, the
 * target's snapshot (`taken`) and both versions' migration records, as the server holds them
 * (`null` when it has none).
 */
export interface DatabaseBinding {
  choice: DatabaseChoice;
  taken: string | null;
  /** The migration record of the version running now. */
  currentRecord: string | null;
  /** The migration record of the version it goes back to. */
  targetRecord: string | null;
}

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
  /** The database, when the plan has snapshots or down migrations (ADR 0028). */
  database?: DatabaseBinding;
}

/**
 * The rollback's approval hash: SHA-256 of the canonical `{ environment, current, target,
 * targetPlanHash }`, with `database` when there is one (`canonicalJson` leaves out an undefined
 * member), so a change of any of them needs a new approval.
 */
export function imageRollbackHash(parts: ImageRollbackParts): string {
  const { environment, current, target, targetPlanHash, database } = parts;
  return sha256Hex(canonicalJson({ environment, current, target, targetPlanHash, database }));
}

/** What a rollback did with the database (`rollback.json`): the choice, and the snapshot's time. */
const DatabaseRecordSchema = z.object({
  choice: z.enum(DATABASE_CHOICES),
  /** The restored snapshot's `taken`. */
  taken: z.string().optional(),
});

export type DatabaseRecord = z.infer<typeof DatabaseRecordSchema>;

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
  /** What it did with the database (a server's or this computer's rollback). */
  database: DatabaseRecordSchema.optional(),
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
  /** What the run is to do with the database, recorded once it succeeded. */
  database: DatabaseRecordSchema.optional(),
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
