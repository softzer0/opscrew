/**
 * The rotation record (`opscrew/credentials.yaml`, committed: names, dates and generations, never a
 * value) and the generation of the values this computer keeps, which the two-computer guard
 * compares with it.
 */
import { join } from "node:path";
import { OpsCrewError, type ProjectPaths, toPosixRelative } from "@opscrew/core";
import { type CredentialsRecord, readOptionalArtifact, writeArtifact } from "@opscrew/plan-schema";
import { z } from "zod";
import { appPaths } from "../apps/list";
import type { PhaseDeps } from "../context";
import { commandFlags } from "../environments/choice";
import { changeGenerated, generatedValuesFile } from "../shared/app-secrets";
import { readValidJson } from "../shared/files";

/** The names of the user's own tokens: OpsCrew copies them and never keeps a generation of them. */
export const USER_TOKEN_NAMES = [
  "hetzner",
  "digitalocean",
  "cloudflare",
  "github",
  "cloudflare-deploy",
  "ghcr",
  "ntfy",
] as const;

/** The name a user's token has in `opscrew rotate`. */
export type UserTokenName = (typeof USER_TOKEN_NAMES)[number];

function isUserToken(name: string): boolean {
  return (USER_TOKEN_NAMES as readonly string[]).includes(name);
}

/**
 * The record's file: one per app, beside its prod plan (`opscrew/credentials.yaml` for the first
 * app, `opscrew/apps/<key>/credentials.yaml` for a further one), holding every environment.
 */
export function credentialsRecordFile(paths: Pick<ProjectPaths, "root" | "homeDir" | "app">) {
  return join(appPaths(paths, paths.app).artefactsDir, "credentials.yaml");
}

/**
 * The app's rotation record; an empty one when the file does not exist yet.
 * @throws ArtifactError `ARTIFACT_INVALID` when the file is damaged.
 */
export async function readCredentialsRecord(
  deps: Pick<PhaseDeps, "paths">,
): Promise<CredentialsRecord> {
  return (
    (await readOptionalArtifact("credentials", credentialsRecordFile(deps.paths))) ?? {
      schemaVersion: 1,
      environments: {},
    }
  );
}

/**
 * Records that the credentials `names` of the environment of `deps.paths` were rotated now (its
 * clock): each gets `rotatedAt`, one generation more (2 for one made before the record had it) and
 * keeps its `madeAt`. This computer's values (not the user's tokens, which are never its) are
 * marked with the same generations first, so a failed write of the record leaves this computer ahead of it, never behind
 * ({@link assertValuesCurrent}). Returns the record written.
 * @throws ArtifactError `ARTIFACT_INVALID` when the record is damaged; OpsCrewError
 * `ARTIFACT_INVALID` when the generated values are ({@link changeGenerated}).
 */
export async function recordRotation(
  deps: Pick<PhaseDeps, "paths" | "clock">,
  names: readonly string[],
): Promise<CredentialsRecord> {
  const env = deps.paths.environment;
  const now = deps.clock.now().toISOString();
  const record = await readCredentialsRecord(deps);
  const entries = { ...record.environments[env] };
  const generations: Record<string, number> = {};
  for (const name of names) {
    const { madeAt, generation = 1 } = entries[name] ?? {};
    entries[name] = {
      ...(madeAt === undefined ? {} : { madeAt }),
      rotatedAt: now,
      generation: generation + 1,
    };
    // The user's tokens are never this computer's values: no generation of them is kept.
    if (!isUserToken(name)) generations[name] = generation + 1;
  }
  const next: CredentialsRecord = {
    ...record,
    environments: { ...record.environments, [env]: entries },
  };
  if (Object.keys(generations).length > 0) await keepValueGenerations(deps, generations);
  await writeArtifact("credentials", credentialsRecordFile(deps.paths), next);
  return next;
}

/**
 * Beside the generated values (`generated_values.json`, which the recovery copy holds whole): the
 * generation of each credential's value this computer keeps, by its name. A credential without an
 * entry has the value it was made with, generation 1. Numbers only, so no generation is ever taken
 * for a value to hide.
 */
const GenerationsSchema = z.record(z.string(), z.int().min(1));

const GeneratedGenerationsSchema = z.looseObject({ generations: GenerationsSchema.optional() });

/**
 * Sets the generations of the values this computer keeps for the environment of `deps.paths`,
 * keeping every other generated value (0600).
 * @throws OpsCrewError `ARTIFACT_INVALID` when the generated values are damaged.
 */
export async function keepValueGenerations(
  deps: Pick<PhaseDeps, "paths">,
  generations: Readonly<Record<string, number>>,
): Promise<void> {
  await changeGenerated(deps, (values) => ({
    ...values,
    generations: {
      ...GenerationsSchema.catch({}).parse(values.generations),
      ...generations,
    },
  }));
}

/**
 * The two-computer guard: stops when the record has a credential of the environment of
 * `deps.paths` (other than the user's own tokens) at a later generation than the value this
 * computer keeps, since writing the old one back would break the app. Passes without a record.
 * @throws OpsCrewError `PHASE_PRECONDITION` naming the credentials and `opscrew secrets restore`.
 */
export async function assertValuesCurrent(deps: Pick<PhaseDeps, "paths">): Promise<void> {
  const entries = (await readCredentialsRecord(deps)).environments[deps.paths.environment] ?? {};
  const kept =
    (await readValidJson(generatedValuesFile(deps), GeneratedGenerationsSchema))?.generations ?? {};
  const behind = Object.entries(entries)
    .filter(([name]) => !isUserToken(name))
    .filter(([name, entry]) => entry.generation > (kept[name] ?? 1))
    .map(([name]) => name)
    .sort();
  if (behind.length === 0) return;
  const { root, environment, app } = deps.paths;
  const record = toPosixRelative(root, credentialsRecordFile(deps.paths));
  const flags = await commandFlags(root, environment, app);
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    `This computer has older values of ${behind.join(", ")} for the ${environment} environment than ${record} records: another computer rotated ${behind.length === 1 ? "it" : "them"}, and going on from here would put the old ${behind.length === 1 ? "value" : "values"} back. Nothing was changed.`,
    {
      hint: `Run \`opscrew secrets restore${flags}\` to bring the current values from the recovery copy, then run the command again.`,
    },
  );
}
