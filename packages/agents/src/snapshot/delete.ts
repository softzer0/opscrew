/**
 * `opscrew snapshot delete <id>` (US2, FR-2403): a data snapshot's parts where they are (on the
 * app's servers, this computer or in the user's Portainer), or a provider's whole-server snapshot
 * at the provider, and its copy in the off-server bucket too (read from this computer with the
 * bucket's key), also one only the bucket still holds. Destroy-grade: an approval with
 * `allowDestroy` and the id typed (`--confirm <id>` in a script, never `--yes`), audited. A
 * snapshot that went meanwhile is reported as already gone.
 */
import { listText, OpsCrewError } from "@opscrew/core";
import { formatUtc } from "@opscrew/secops";
import type { PhaseDeps } from "../context";
import { NOTHING_CHANGED } from "../promote/shared";
import { hostFailure, READ_TIMEOUT_MS, type ScriptHost, scriptCommand } from "./hosts";
import { dataListings, mergeListings } from "./list";
import { portainerDelete } from "./portainer";
import { type ProviderSnapshot, providerSnapshots } from "./provider";
import {
  bucketDelete,
  bucketObjects,
  type OffsiteBucket,
  offsiteBucket,
  type RestoreServices,
} from "./restore-offsite";
import { requireNoDeployOrMove, type SnapshotRun, snapshotRun, snapshotTarget } from "./run";
import { KIND_WORDS, requireSnapshotId, SERVER_SNAPSHOTS, SNAPSHOT_ID } from "./store";
import type { DeletedSnapshot, SnapshotCommandOptions, SnapshotEntry } from "./types";

/** The exit code of a deletion whose snapshot folder went meanwhile. */
const GONE = 5;

/**
 * What the approval says is deleted for good; `bucket` names the off-server bucket that holds a
 * copy of it.
 */
function deletionLines(entry: SnapshotEntry, provider: boolean, bucket?: string): string[] {
  const copied = entry.services.filter((service) => service.state === "copied");
  return [
    `The snapshot ${entry.id} ${KIND_WORDS[entry.kind]}, ${formatUtc(entry.taken)}, ${entry.where}.`,
    provider && entry.server !== undefined
      ? `It is deleted at the provider for good: a rebuild can no longer use it.`
      : `Its copies of ${listText(copied.map((service) => service.name))} are deleted for good: \`opscrew restore\` can no longer put them back.`,
    ...(bucket === undefined
      ? []
      : [`Its copy off the server, in the bucket ${bucket}, is deleted too.`]),
    `Typing ${entry.id} approves it.`,
  ];
}

/** What the approval says of a copy only the off-server bucket still holds. */
function bucketOnlyLines(id: string, bucket: string): string[] {
  return [
    `The copy of the snapshot ${id} in the off-server bucket ${bucket}, which no server holds any more.`,
    `It is deleted for good: \`opscrew restore --from offsite\` can no longer put it back.`,
    `Typing ${id} approves it.`,
  ];
}

/** `opscrew snapshot delete`'s options. */
export interface DeleteSnapshotOptions extends SnapshotCommandOptions {
  services?: RestoreServices;
}

/** Deletes `id` on `host`: `already gone` when its folder went meanwhile. */
export async function deleteOnHost(
  run: SnapshotRun,
  host: ScriptHost,
  id: string,
): Promise<DeletedSnapshot["outcome"]> {
  const command = `[ -d ${SERVER_SNAPSHOTS}/${id} ] || exit ${GONE}; ${scriptCommand(["delete", id])}`;
  const result = await host.run(command, READ_TIMEOUT_MS);
  if (result.exitCode === GONE) return "already gone";
  if (result.exitCode !== 0) throw hostFailure(run, host, result, `delete the snapshot ${id}`);
  return "deleted";
}

/**
 * Deletes the provider's snapshot; a failure while it is no longer listed (the provider's 404) is
 * `already gone`.
 */
async function deleteAtProvider(found: ProviderSnapshot): Promise<DeletedSnapshot["outcome"]> {
  const { api, entry } = found;
  const server = entry.server as NonNullable<SnapshotEntry["server"]>;
  try {
    await api.deleteSnapshot(entry.id);
    return "deleted";
  } catch (error) {
    const left = await api.listSnapshots(server.id);
    if (left.some((snapshot) => snapshot.id === entry.id)) throw error;
    return "already gone";
  }
}

/**
 * `opscrew snapshot delete <id>` on the environment `deps` belong to: refused while a deploy or a
 * move runs; otherwise finds `id` among its data snapshots, then its providers' whole-server ones,
 * and, with the off-server copy on, in its bucket, and deletes it after the destroy-grade approval.
 * Every machine that holds a part loses it, and the bucket its copy.
 * @throws OpsCrewError `INVALID_INPUT` for an id that isn't letters and digits (or a whole-server
 * snapshot's two such parts around one colon),
 * `PHASE_PRECONDITION` for each refusal and an unknown id, `CREDENTIALS_MISSING` without the
 * bucket's key, `APPROVAL_REFUSED` when the id is not typed, `COMMAND_FAILED` and
 * `PROVIDER_ERROR` when a deletion fails.
 */
export async function deleteSnapshot(
  deps: PhaseDeps,
  id: string,
  options: DeleteSnapshotOptions = {},
): Promise<DeletedSnapshot> {
  requireSnapshotId(id, { server: true });
  // An id with a colon is only a whole-server snapshot's: no machine or bucket holds it.
  const data = SNAPSHOT_ID.test(id);
  const run = await snapshotRun(deps, options.services);
  const { environment, flags } = run;
  const target = snapshotTarget(run);
  await requireNoDeployOrMove(run, "delete a snapshot");
  const listings = data ? await dataListings(run) : [];
  const holders = listings.filter((place) => place.listing.abouts.some((about) => about.id === id));
  const held = mergeListings(holders).find((entry) => entry.id === id);
  const provider =
    held === undefined && target === "servers"
      ? (await providerSnapshots(run)).find((found) => found.entry.id === id)
      : undefined;
  // The copy in the off-server bucket: its key is needed before anything is approved. A snapshot
  // before a release is never copied off the server.
  const bucket: OffsiteBucket | undefined =
    data && provider === undefined && held?.kind !== "release"
      ? await offsiteBucket(run, options.services ?? {}, `opscrew snapshot delete ${id}${flags}`)
      : undefined;
  const inBucket = bucket !== undefined && (await bucketObjects(run, bucket, id)).length > 0;
  const entry = held ?? provider?.entry;
  if (entry === undefined && !inBucket) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `${environment} has no snapshot ${id}. ${NOTHING_CHANGED}`,
      { hint: `\`opscrew snapshot list${flags}\` shows its snapshots.` },
    );
  }
  const offBucket = inBucket ? bucket?.name : undefined;
  const where = entry?.where ?? `only in the off-server bucket ${offBucket}`;
  const approval = await deps.approvals.request({
    kind: "remote-exec",
    title: `Delete the snapshot ${id} of ${environment} ${where}`,
    details: (entry === undefined
      ? bucketOnlyLines(id, offBucket ?? "")
      : deletionLines(entry, provider !== undefined, offBucket)
    ).join("\n"),
    allowDestroy: true,
    confirmPhrase: id,
  });
  if (!approval.approved) {
    throw new OpsCrewError(
      "APPROVAL_REFUSED",
      `The snapshot ${id} was not deleted${approval.reason === undefined ? "" : `: ${approval.reason}`}. ${NOTHING_CHANGED}`,
      {
        hint: `Run \`opscrew snapshot delete ${id}${flags}\` again and type ${id} (in a script: --confirm ${id}).`,
      },
    );
  }
  const outcomes: DeletedSnapshot["outcome"][] = [];
  if (provider !== undefined) {
    const server = provider.entry.server as NonNullable<SnapshotEntry["server"]>;
    deps.reporter.step(`Deleting the snapshot ${id} ${where}`);
    outcomes.push(await deleteAtProvider(provider));
    await deps.audit.append({
      kind: "provider-call",
      actor: "opscrew",
      action: "delete a snapshot",
      target: `${server.provider} server ${server.name}`,
      decision: "approved",
      detail: `${id}: ${outcomes.at(-1)}`,
    });
  }
  for (const place of holders) {
    deps.reporter.step(`Deleting the snapshot ${id} ${place.where}`);
    const outcome =
      "portainer" in place
        ? await portainerDelete(place.portainer, id)
        : await deleteOnHost(run, place.host, id);
    outcomes.push(outcome);
    await deps.audit.append({
      kind: "remote-exec",
      actor: "opscrew",
      action: "delete a snapshot",
      target: "portainer" in place ? "portainer" : place.host.audit,
      decision: "approved",
      detail: `${id}: ${outcome}`,
    });
  }
  if (inBucket && bucket !== undefined) {
    deps.reporter.step(`Deleting the copy of the snapshot ${id} in the off-server bucket`);
    outcomes.push(await bucketDelete(run, bucket, id));
    await deps.audit.append({
      kind: "provider-call",
      actor: "opscrew",
      action: "delete a snapshot's off-server copy",
      target: `bucket ${bucket.name}`,
      decision: "approved",
      detail: `${id}: ${outcomes.at(-1)}`,
    });
  }
  const outcome = outcomes.includes("deleted") ? "deleted" : "already gone";
  if (outcome === "deleted") {
    deps.reporter.success(`Deleted the snapshot ${id} of ${environment} ${where}.`);
  } else {
    deps.reporter.info(`The snapshot ${id} of ${environment} ${where} was already gone.`);
  }
  return { id, where, outcome };
}
