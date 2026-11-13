/**
 * The app's queues on a rollback (ADR 0028, 2026-11-12): which of them a snapshot's restore puts
 * back, which the rollback keeps as they are (`--keep-queues`, or the terminal's answer), and what
 * the approval says of each.
 */
import { listText } from "@opscrew/core";
import { queueServices } from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import type { About } from "../snapshot/store";
import type { RollbackRun } from "./run";

/** The terminal's question when a snapshot's restore would put the app's queues back. */
export interface QueueQuestion {
  /** What restoring them does. */
  restore: string;
  /** What keeping them as they are does. */
  keep: string;
}

/** The names of the parts `abouts` (each server's part of a snapshot) hold a copy of. */
function copiedParts(abouts: Iterable<About>): Set<string> {
  return new Set(
    [...abouts].flatMap((about) =>
      about.services.filter((entry) => "file" in entry).map((entry) => entry.name),
    ),
  );
}

/** True when `kept` names every part `abouts` hold a copy of: a restore would change nothing. */
export function keepsEverything(abouts: Iterable<About>, kept: readonly string[]): boolean {
  return [...copiedParts(abouts)].every((name) => kept.includes(name));
}

/** The app's queues `abouts` (each server's part of a snapshot) hold a copy of, in plan order. */
export function heldQueues(plan: DeployPlan, abouts: Iterable<About>): string[] {
  const copied = copiedParts(abouts);
  return queueServices(plan).filter((name) => copied.has(name));
}

/** What restoring `queues` does. */
function restoreText(queues: readonly string[]): string {
  const one = queues.length === 1;
  return `Restoring the snapshot puts ${listText(queues)} back as ${one ? "it was" : "they were"} before the release: the jobs queued since are lost, and jobs run since can run again.`;
}

/** What keeping `queues` as they are does. */
function keepText(queues: readonly string[]): string {
  const one = queues.length === 1;
  return `${listText(queues)} ${one ? "stays as it is" : "stay as they are"}: jobs the newer version queued there may fail on the older version, and retry or fail.`;
}

/**
 * The queues among `held` (those the snapshot holds) that the rollback keeps as they are: every
 * one with `--keep-queues`; else, in a terminal, every one when the user keeps them; else none,
 * and the restore puts them back.
 */
export async function keptQueues(run: RollbackRun, held: readonly string[]): Promise<string[]> {
  const { options } = run;
  if (held.length === 0) return [];
  if (options.keepQueues === true) return [...held];
  if (options.chooseKeepQueues === undefined) return [];
  const keep = await options.chooseKeepQueues({
    restore: restoreText(held),
    keep: keepText(held),
  });
  return keep ? [...held] : [];
}

/**
 * The approval's lines on the app's queues, `restored` naming those the rollback restores: what
 * restoring them does, with the flag that keeps them; then, for every other queue (kept, not in
 * the snapshot, or the data kept), what keeping it does. None without queues.
 */
export function queueLines(plan: DeployPlan, restored: readonly string[]): string[] {
  const others = queueServices(plan).filter((name) => !restored.includes(name));
  const them = restored.length === 1 ? "it as it is" : "them as they are";
  return [
    ...(restored.length > 0
      ? [`Queues: ${restoreText(restored)} --keep-queues keeps ${them}.`]
      : []),
    ...(others.length > 0 ? [`Queues: ${keepText(others)}`] : []),
  ];
}
