/**
 * The environment's unfinished rotation (025 plan.md 3., Decisions 3, FR-2512): its old and new
 * values per service and secret, the hash of its plan and how far it got, in
 * `pending_rotation.json` beside the generated values (0600), never in the recovery copy, and
 * apart from the generated values, which provision rewrites. Kept until the rotation is done or
 * undone; provision refuses while it is there.
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { OpsCrewError, type Redactor, readTextIfExists, writeFileAtomic } from "@opscrew/core";
import { z } from "zod";
import type { PhaseDeps } from "../context";

/** A secret's value before (`old`) and after (`new`) a rotation. */
const PairSchema = z.strictObject({ old: z.string().min(1), new: z.string().min(1) });

/**
 * The values of a rotation: the credentials, by the names `opscrew rotate` takes (the services in
 * the plan's order, then each device login as `grant:<device>/<service>`), each service's secrets
 * with their old and new values, and each device login's passwords by `<device>/<service>`.
 */
const RotationValuesSchema = z.strictObject({
  names: z.array(z.string().min(1)).min(1),
  services: z.record(z.string(), z.record(z.string(), PairSchema)),
  grants: z.record(z.string(), PairSchema).optional(),
});

/** The values of a rotation of services ({@link RotationValuesSchema}). */
export type RotationValues = z.infer<typeof RotationValuesSchema>;

/**
 * An unfinished rotation: its values, the hash of its plan, and how far it got here: `planned`
 * (shown, nothing changed yet: a rotation of other services replaces it), `started` (approved:
 * GitHub's secrets and the servers may hold its new values), `switched` (the app's server finished
 * its run: the rotation only goes forward).
 */
const PendingRotationSchema = RotationValuesSchema.extend({
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  step: z.enum(["planned", "started", "switched"]),
});

/** An unfinished rotation ({@link PendingRotationSchema}). */
export type PendingRotation = z.infer<typeof PendingRotationSchema>;

/** The unfinished rotation's file, beside the generated values in the environment's folder. */
export function pendingRotationFile(deps: Pick<PhaseDeps, "paths">): string {
  return join(deps.paths.projectHomeDir, "pending_rotation.json");
}

/**
 * `file` as `schema` reads it (`undefined` without the file).
 * @throws OpsCrewError `ARTIFACT_INVALID` when the file is damaged: a rotation never goes on from
 * values it can't read.
 */
export async function readStrict<T>(file: string, schema: z.ZodType<T>): Promise<T | undefined> {
  const text = await readTextIfExists(file);
  if (text === undefined) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  const parsed = schema.safeParse(json);
  if (parsed.success) return parsed.data;
  throw new OpsCrewError(
    "ARTIFACT_INVALID",
    `OpsCrew's file ${file} is damaged, so OpsCrew changed nothing.`,
    {
      hint: "Fix the JSON in that file, or restore OpsCrew's generated values from your recovery copy (`opscrew secrets restore`), then run the command again.",
    },
  );
}

/** Every old and new value of `values`, registered with the redactor. */
export function registerRotationValues(
  redactor: Pick<Redactor, "addLiteral">,
  values: RotationValues,
): void {
  for (const secrets of Object.values(values.services)) {
    for (const pair of Object.values(secrets)) {
      redactor.addLiteral(pair.old, "app-env");
      redactor.addLiteral(pair.new, "app-env");
    }
  }
  for (const pair of Object.values(values.grants ?? {})) {
    redactor.addLiteral(pair.old, "grant-password");
    redactor.addLiteral(pair.new, "grant-password");
  }
}

/**
 * The unfinished rotation of the environment of `deps.paths`, if any, each of its values
 * registered with the redactor.
 * @throws OpsCrewError `ARTIFACT_INVALID` when its file is damaged.
 */
export async function readPendingRotation(
  deps: Pick<PhaseDeps, "paths" | "redactor">,
): Promise<PendingRotation | undefined> {
  const pending = await readStrict(pendingRotationFile(deps), PendingRotationSchema);
  if (pending !== undefined) registerRotationValues(deps.redactor, pending);
  return pending;
}

/** Keeps `pending` as the environment's unfinished rotation (0600), until it is done or undone. */
export async function keepPendingRotation(
  deps: Pick<PhaseDeps, "paths">,
  pending: PendingRotation,
): Promise<void> {
  await writeFileAtomic(pendingRotationFile(deps), `${JSON.stringify(pending)}\n`);
}

/** Forgets the unfinished rotation (once done, or undone: the services keep their values). */
export async function dropPendingRotation(deps: Pick<PhaseDeps, "paths">): Promise<void> {
  await rm(pendingRotationFile(deps), { force: true });
}
