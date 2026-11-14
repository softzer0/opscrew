/**
 * The move's record, `cloudflareMove` in each covered environment's `opscrew/plan.yaml`: its steps
 * and the reading and writing of it. Ids, flags and times only (data model 1).
 */
import { isDeepStrictEqual } from "node:util";
import { OpsCrewError, type ProjectPaths } from "@opscrew/core";
import {
  type CloudflareMove,
  type DeployPlan,
  readArtifact,
  readOptionalArtifact,
  writeArtifact,
} from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { environmentPaths } from "../environments/paths";

/** What the move starts with: the zone, A's account and zone, B's account (its zone once made). */
export type MoveStart = Pick<CloudflareMove, "zone" | "from" | "to" | "dsAtStart">;

/** A covered environment's plan and paths. */
export interface MoveRecordPlan {
  environment: string;
  paths: ProjectPaths;
  plan: DeployPlan;
}

/** A step the record can't take: callers check first, so this is OpsCrew's bug. */
function outOfOrder(move: CloudflareMove, change: string): OpsCrewError {
  const at = move.abort === undefined ? move.step : `${move.step}, being aborted`;
  return new OpsCrewError(
    "INTERNAL",
    `The move of ${move.zone} is ${at}, so its record can't be ${change}.`,
    { hint: "This is a bug in OpsCrew; please report it." },
  );
}

/** The record written after the start's confirmation. */
export function startedMove(start: MoveStart, now: Date): CloudflareMove {
  return { ...start, step: "started", startedAt: now.toISOString() };
}

/** The record with B's zone id once B's zone exists; the same record when it names it already. */
export function withTargetZone(move: CloudflareMove, zoneId: string): CloudflareMove {
  if (move.to.zoneId === zoneId) return move;
  if (move.to.zoneId !== undefined) throw outOfOrder(move, `given another zone in ${zoneId}`);
  return { ...move, to: { ...move.to, zoneId } };
}

/**
 * The record at `step`: `prepared` after `started`, `adopted` after `prepared`, with its time; the
 * same record when it is there already. Never while an abort runs.
 */
export function advancedMove(
  move: CloudflareMove,
  step: "prepared" | "adopted",
  now: Date,
): CloudflareMove {
  if (move.abort === undefined && move.step === step) return move;
  const before = step === "prepared" ? "started" : "prepared";
  if (move.abort !== undefined || move.step !== before) throw outOfOrder(move, `marked ${step}`);
  const at = now.toISOString();
  return { ...move, step, ...(step === "prepared" ? { preparedAt: at } : { adoptedAt: at }) };
}

/**
 * The record with the abort at `step`: `started` first, `removed` after it; the same record when it
 * is there already. Never once B took the app over (`adopted`).
 */
export function abortingMove(move: CloudflareMove, step: "started" | "removed"): CloudflareMove {
  if (move.abort?.step === step) return move;
  const valid =
    move.step !== "adopted" &&
    (step === "started" ? move.abort === undefined : move.abort?.step === "started");
  if (!valid) throw outOfOrder(move, `marked as an abort ${step}`);
  return { ...move, abort: { step } };
}

/**
 * The plans of `environments` of the app `paths` belong to, those that have one, each with its
 * paths (the record is `plan.cloudflareMove`).
 */
export async function readMoveRecords(
  paths: ProjectPaths,
  environments: readonly string[],
): Promise<MoveRecordPlan[]> {
  const found: MoveRecordPlan[] = [];
  for (const environment of environments) {
    const own = environmentPaths(paths, environment);
    const plan = await readOptionalArtifact("plan", own.files.plan);
    if (plan !== undefined) found.push({ environment, paths: own, plan });
  }
  return found;
}

/**
 * Writes `move` as the record of the environment `paths` belong to (removes it when `undefined`),
 * into its plan as it is on disk now, atomically and validated (`ARTIFACT_INVALID` leaves the plan
 * as it was); a plan that holds that record already stays as it is. Returns the plan.
 */
export async function writeMoveRecord(
  deps: Pick<PhaseDeps, "clock">,
  paths: ProjectPaths,
  move: CloudflareMove | undefined,
): Promise<DeployPlan> {
  const onDisk = await readArtifact("plan", paths.files.plan);
  if (isDeepStrictEqual(onDisk.cloudflareMove, move)) return onDisk;
  const { cloudflareMove: _old, ...rest } = onDisk;
  const plan: DeployPlan = {
    ...rest,
    ...(move === undefined ? {} : { cloudflareMove: move }),
    updatedAt: deps.clock.now().toISOString(),
  };
  await writeArtifact("plan", paths.files.plan, plan);
  return plan;
}
