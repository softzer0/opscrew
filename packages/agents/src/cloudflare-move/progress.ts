/**
 * The move's two machine-local files (data model 2), with no secret in them: the app's
 * `.opscrew[/apps/<key>]/cloudflare-move.json` (the plan waiting for `--approve`, the finish's
 * window) and the repository's `.opscrew/cloudflare-move-switch.json` (the switch's times). A
 * damaged file reads as absent; every write is atomic.
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { type ProjectPaths, writeFileAtomic } from "@opscrew/core";
import { EnvironmentNameSchema, FqdnSchema, IsoDateTimeSchema } from "@opscrew/plan-schema";
import { z } from "zod";
import type { PhaseDeps } from "../context";
import { environmentPaths } from "../environments/paths";
import { readValidJson } from "../shared";

/** Every infrastructure plan a move applies, each approved on its own (constitution I). */
export const MOVE_PLAN_ACTIONS = [
  "zone",
  "shared",
  "shadow-create",
  "connector",
  "secrets",
  "copy",
  "mark",
  "window",
  "finish-secrets",
  "swap-check",
  "site-adopt",
  "a-removal",
  "a-revoke",
  "a-empty",
  "mark-delete",
  "abort-empty",
  "abort-shadow",
  "abort-shared",
  "abort-zone",
] as const;
export type MovePlanAction = (typeof MOVE_PLAN_ACTIONS)[number];

/** The environment's infrastructure roots a plan of the move belongs to. */
export const MOVE_ROOTS = ["main", "storage", "backups", "pages-verification"] as const;
export type MoveRoot = (typeof MOVE_ROOTS)[number];

const HashSchema = z.string().regex(/^[0-9a-f]{64}$/i);

const PendingSchema = z.strictObject({
  action: z.enum(MOVE_PLAN_ACTIONS),
  /** Absent for a plan of the zone's (`zone`, `mark`, `mark-delete`, `abort-zone`). */
  environment: EnvironmentNameSchema.optional(),
  /** Absent for a plan of no root of the environment's. */
  root: z.enum(MOVE_ROOTS).optional(),
  planHash: HashSchema,
  savedAt: IsoDateTimeSchema,
});

/** The saved plan the move waits for: its step, environment, root and hash. */
export type PendingMovePlan = z.infer<typeof PendingSchema>;

/** Which plan of the move: its action, and its environment and root when it has them. */
export type MovePlanKey = Pick<PendingMovePlan, "action" | "environment" | "root">;

const AppProgressSchema = z.strictObject({
  pending: PendingSchema.optional(),
  /** Set before the finish stops the app; a run that finds it starts the app on A's settings first. */
  window: z
    .strictObject({ environment: EnvironmentNameSchema, stoppedAt: IsoDateTimeSchema })
    .optional(),
});

/** The app's local file of the move. */
export type AppProgress = z.infer<typeof AppProgressSchema>;

const SwitchProgressSchema = z.strictObject({
  zone: FqdnSchema,
  /** The switch plan waiting for `--approve`. */
  pending: z.strictObject({ planHash: HashSchema, savedAt: IsoDateTimeSchema }).optional(),
  /** When the registrar accepted B's nameservers. */
  nameserversSetAt: IsoDateTimeSchema.optional(),
  /** When B's zone became active. */
  activeAt: IsoDateTimeSchema.optional(),
  /** When B's edge certificate was active. */
  certificateAt: IsoDateTimeSchema.optional(),
  /** When each hostname first answered over HTTPS from B. */
  okAt: z.record(FqdnSchema, IsoDateTimeSchema).optional(),
});

/** The repository's switch file: the times of the run that switches. */
export type SwitchProgress = z.infer<typeof SwitchProgressSchema>;

/** `.opscrew[/apps/<key>]/cloudflare-move.json`: the app's, for every environment of it. */
export function appProgressFile(paths: ProjectPaths): string {
  return join(environmentPaths(paths, "prod").stateDir, "cloudflare-move.json");
}

/** The app's local file of the move; empty when there is none (or it is damaged). */
export async function readAppProgress(paths: ProjectPaths): Promise<AppProgress> {
  return (await readValidJson(appProgressFile(paths), AppProgressSchema)) ?? {};
}

/** Writes the app's file, or deletes it when nothing is left in it. */
async function writeAppProgress(paths: ProjectPaths, progress: AppProgress): Promise<void> {
  const file = appProgressFile(paths);
  if (progress.pending === undefined && progress.window === undefined) {
    await rm(file, { force: true });
    return;
  }
  await writeFileAtomic(file, `${JSON.stringify(AppProgressSchema.parse(progress))}\n`);
}

/** Records that `key`'s saved plan `planHash` waits for `--approve <hash>`. */
export async function writePending(
  deps: Pick<PhaseDeps, "paths" | "clock">,
  key: MovePlanKey,
  planHash: string,
): Promise<void> {
  const progress = await readAppProgress(deps.paths);
  const pending: PendingMovePlan = {
    action: key.action,
    ...(key.environment === undefined ? {} : { environment: key.environment }),
    ...(key.root === undefined ? {} : { root: key.root }),
    planHash: planHash.toLowerCase(),
    savedAt: deps.clock.now().toISOString(),
  };
  await writeAppProgress(deps.paths, { ...progress, pending });
}

/** True when `pending` is `key`'s plan: the same action, environment and root. */
function sameKey(pending: PendingMovePlan, key: MovePlanKey): boolean {
  return (
    pending.action === key.action &&
    pending.environment === key.environment &&
    pending.root === key.root
  );
}

/** True when `pending` is `key`'s plan (action, environment, root) and `approved` names it. */
export function pendingMatches(
  pending: PendingMovePlan | undefined,
  key: MovePlanKey,
  approved: string | undefined,
): pending is PendingMovePlan {
  return (
    pending !== undefined &&
    approved !== undefined &&
    sameKey(pending, key) &&
    pending.planHash.toLowerCase() === approved.trim().toLowerCase()
  );
}

/** Forgets the waiting plan when it is `key`'s (after it was applied); another step's stays. */
export async function clearPending(
  deps: Pick<PhaseDeps, "paths">,
  key: MovePlanKey,
): Promise<void> {
  const { pending, ...rest } = await readAppProgress(deps.paths);
  if (pending !== undefined && sameKey(pending, key)) await writeAppProgress(deps.paths, rest);
}

/** Records, before the finish stops `environment`'s app, that it was stopped now. */
export async function recordWindowStop(
  deps: Pick<PhaseDeps, "paths" | "clock">,
  environment: string,
): Promise<void> {
  const progress = await readAppProgress(deps.paths);
  const window = { environment, stoppedAt: deps.clock.now().toISOString() };
  await writeAppProgress(deps.paths, { ...progress, window });
}

/** Forgets the window's stop, once the app runs again. */
export async function clearWindow(deps: Pick<PhaseDeps, "paths">): Promise<void> {
  const { window: _done, ...rest } = await readAppProgress(deps.paths);
  await writeAppProgress(deps.paths, rest);
}

/** `.opscrew/cloudflare-move-switch.json`: the repository's, written by the run that switches. */
export function switchProgressFile(paths: Pick<ProjectPaths, "root">): string {
  return join(paths.root, ".opscrew", "cloudflare-move-switch.json");
}

/** The switch file, or `undefined` when there is none (or it is damaged). */
export function readSwitchProgress(
  paths: Pick<ProjectPaths, "root">,
): Promise<SwitchProgress | undefined> {
  return readValidJson(switchProgressFile(paths), SwitchProgressSchema);
}

/** Writes the switch file (atomically). */
export async function writeSwitchProgress(
  paths: Pick<ProjectPaths, "root">,
  progress: SwitchProgress,
): Promise<void> {
  const text = `${JSON.stringify(SwitchProgressSchema.parse(progress))}\n`;
  await writeFileAtomic(switchProgressFile(paths), text);
}

/** Deletes the switch file after the switch's last step. */
export async function clearSwitchProgress(paths: Pick<ProjectPaths, "root">): Promise<void> {
  await rm(switchProgressFile(paths), { force: true });
}
