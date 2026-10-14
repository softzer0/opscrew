import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { OpsCrewError, type ProjectPaths, writeFileAtomic } from "@opscrew/core";
import { PortainerSchema, type PortainerSettings } from "@opscrew/plan-schema";
import { z } from "zod";

/**
 * What a `--plan-only` run of `opscrew portainer enable|disable` planned, so a later `--approve`
 * applies exactly that change: `.opscrew/portainer-pending.json` (local, no secrets).
 */
export interface PendingPortainerChange {
  command: "enable" | "disable";
  /** The Portainer settings the plans were made for; `null` when Portainer is turned off. */
  settings: PortainerSettings | null;
  deleteData: boolean;
}

const PendingSchema = z.strictObject({
  command: z.enum(["enable", "disable"]),
  settings: PortainerSchema.nullable(),
  deleteData: z.boolean(),
});

/** `.opscrew/portainer-pending.json`. */
export function pendingPortainerFile(paths: Pick<ProjectPaths, "stateDir">): string {
  return join(paths.stateDir, "portainer-pending.json");
}

/** Saves what a `--plan-only` run planned. */
export async function savePendingPortainer(
  paths: Pick<ProjectPaths, "stateDir">,
  pending: PendingPortainerChange,
): Promise<void> {
  await writeFileAtomic(pendingPortainerFile(paths), `${JSON.stringify(pending, null, 2)}\n`);
}

/** The saved `--plan-only` change, or `undefined`; a damaged file stops (fail closed). */
export async function readPendingPortainer(
  paths: Pick<ProjectPaths, "stateDir">,
): Promise<PendingPortainerChange | undefined> {
  let text: string;
  try {
    text = await readFile(pendingPortainerFile(paths), "utf8");
  } catch {
    return undefined;
  }
  try {
    return PendingSchema.parse(JSON.parse(text));
  } catch {
    throw new OpsCrewError(
      "PLAN_HASH_MISMATCH",
      "OpsCrew's record of the Portainer change you planned (.opscrew/portainer-pending.json) is damaged, so it cannot tell what you approved. Nothing was changed.",
      { hint: "Make a new plan with --plan-only, review it and approve the new hashes." },
    );
  }
}

/** Forgets the planned change once it was applied. */
export async function clearPendingPortainer(paths: Pick<ProjectPaths, "stateDir">): Promise<void> {
  await rm(pendingPortainerFile(paths), { force: true });
}

/** The stop when `--approve` comes with options other than the planned ones. */
export function optionsDiffer(): OpsCrewError {
  return new OpsCrewError(
    "PLAN_HASH_MISMATCH",
    "The options differ from the plan you approved, so OpsCrew changed nothing.",
    { hint: "Run with the same options, or make a new plan with --plan-only." },
  );
}

/** True when two Portainer settings are the same change (email order ignored). */
export function sameSettings(a: PortainerSettings | null, b: PortainerSettings | null): boolean {
  const canonical = (s: PortainerSettings | null) => {
    if (s === null) return null;
    const value: Record<string, unknown> = {
      ...s,
      ...(s.allowedEmails !== undefined
        ? { allowedEmails: [...s.allowedEmails].map((e) => e.toLowerCase()).sort() }
        : {}),
    };
    return JSON.stringify(
      Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((k) => [k, value[k]]),
      ),
    );
  };
  return canonical(a) === canonical(b);
}
