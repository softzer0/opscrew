import { join } from "node:path";
import {
  durationText,
  exists,
  formatMoney,
  OpsCrewError,
  plural,
  realSleep,
  replaceNames,
} from "@opscrew/core";
import {
  IMAGES,
  type MoveLayoutName,
  type ProviderBucket,
  providerBucket,
  type RenderContext,
  type RenderedFile,
  renderStorage,
  STORAGE_NAMES,
  storageRootDir,
} from "@opscrew/iac-templates";
import type { DeployPlan, Requirements } from "@opscrew/plan-schema";
import { isCloudProvider } from "@opscrew/plan-schema";
import { z } from "zod";
import { sellsBuckets, storageOffers } from "../design/storage";
import { confirmBucketGone } from "../destroy/storage";
import { providerProfile } from "../providers";
import { findSavedPlan, isMovesOnly, planAndApply, type SavedPlan } from "../provision";
import {
  applyStorage,
  forgetStorageKey,
  requireStorageKey,
  STORAGE_PLAN_SUFFIX,
  type StorageKey,
  storageEngineEnv,
  storageStateFile,
  withPreviousBucketKey,
} from "../provision/storage";
import { writeRenderedFiles } from "../shared";
import { STORAGE_ENDPOINTS } from "../shared/app-env";
import { discardSaved, planBounded, quietly } from "./plans";
import { auditMove, type MoveBase, type MoveSession, remoteFor, serverOf } from "./session";
import { sideTarget, sideWords } from "./sides";
import { pendingStop } from "./steps";
import { FINISH_COMMAND, sizeText } from "./texts";
import type { MoveTargetId, RetargetResult } from "./types";

/** The two buckets of a move that takes the app's bucket along (plan.md "5."). */
export interface MovingBucket {
  /** The bucket being left (`retarget.from.objectStorage`), at the cloud provider being left. */
  old: ProviderBucket;
  /** The new one (`storage.objectStorage`), at the new cloud provider. */
  next: ProviderBucket;
}

/** The users' keys of both buckets. Never logged. */
export interface BucketKeys {
  old: StorageKey;
  next: StorageKey;
}

/** A bucket's size, from `rclone size --json`. */
export interface BucketSize {
  bytes: number;
  /** Its number of objects. */
  count: number;
}

/** The move's two buckets while it takes the bucket along; undefined otherwise. */
export function movingBucket(
  plan: Pick<DeployPlan, "storage" | "retarget">,
): MovingBucket | undefined {
  const old = providerBucket({ storage: { objectStorage: plan.retarget?.from.objectStorage } });
  const next = providerBucket(plan);
  return old === undefined || next === undefined ? undefined : { old, next };
}

/** `shop-uploads on Hetzner Object Storage (fsn1)`. */
function bucketWords(bucket: ProviderBucket): string {
  return `${bucket.bucket} on ${STORAGE_NAMES[bucket.provider]} (${bucket.region})`;
}

/**
 * What a move to `to` does with the app's bucket at a provider (FR-2310, FR-2311): it moves when
 * it is at the cloud provider being left and `to` is the other one, with object storage in the
 * plan's region (the new bucket keeps its name and settings, in the new provider's location and at
 * its price), unless `keep` (`--keep-bucket`). Otherwise it stays, and `stays` is the summary's
 * line: R2 is Cloudflare's, a bucket at another provider is not left, and a bucket left behind
 * keeps billing. Undefined without a bucket at a provider.
 */
export function bucketChoice(
  plan: DeployPlan,
  to: MoveTargetId,
  input: { keep: boolean; requirements?: Requirements },
): { moves: MovingBucket } | { stays: string } | undefined {
  const old = providerBucket(plan);
  if (old === undefined) return undefined;
  const same = "the app on the new side keeps using it with the same key";
  if (old.provider !== plan.target.provider) {
    return { stays: `Bucket: ${bucketWords(old)} stays where it is; ${same}.` };
  }
  const billing = `Bucket: ${bucketWords(old)} stays there and keeps billing after the move`;
  if (!isCloudProvider(to)) {
    return {
      stays: `${billing}: a bucket moves only to another cloud provider's object storage; ${same}.`,
    };
  }
  if (input.keep) return { stays: `${billing} (--keep-bucket); ${same}.` };
  if (!sellsBuckets(to)) {
    return {
      stays: `${billing}: OpsCrew uses no object storage at ${providerProfile(to).displayName}; ${same}.`,
    };
  }
  // Contabo's storage is ordered through its API, not the `storage` root a move changes.
  if (old.provider === "contabo" || to === "contabo") {
    return {
      stays: `${billing}: OpsCrew moves a bucket only between Hetzner Object Storage and DigitalOcean Spaces; ${same}.`,
    };
  }
  const offer =
    input.requirements === undefined
      ? undefined
      : storageOffers({ ...input.requirements, provider: to }, old.expected).find(
          (o) => o.provider === to,
        );
  if (offer === undefined) {
    return {
      stays: `${billing}: ${providerProfile(to).displayName} has no object storage in the app's region; ${same}.`,
    };
  }
  const { amount, currency, source, checkedOn } = offer.price;
  return {
    moves: {
      old,
      next: {
        ...old,
        provider: to,
        region: offer.region,
        price: { monthly: amount, currency, source, checkedOn },
      },
    },
  };
}

/**
 * Both buckets' keys (`requireStorageKey`): the one being left's from the variables or its kept
 * copy, the new one's from its kept copy, asked once in a terminal. `base.plan` is the move's.
 */
export async function bucketKeys(
  base: Pick<MoveBase, "deps" | "plan" | "services" | "command">,
  bucket: MovingBucket,
): Promise<BucketKeys> {
  const { deps, plan, services, command } = base;
  return {
    old: await requireStorageKey(deps, plan, services, { command, bucket: bucket.old }),
    next: await requireStorageKey(deps, plan, services, { command, bucket: bucket.next }),
  };
}

/** Both buckets' keys when the session's move takes the bucket along, else undefined. */
export async function movingBucketKeys(session: MoveBase): Promise<BucketKeys | undefined> {
  const bucket = movingBucket(session.plan);
  return bucket === undefined ? undefined : bucketKeys(session, bucket);
}

const GIB = 1024 ** 3;
const MINUTE = 60_000;
/** How long one copy of the bucket may run on the new server. */
const COPY_TIMEOUT_MS = 6 * 60 * MINUTE;

/** Rough time of a copy between providers: two minutes, plus one per started GiB and 2,000 objects. */
export function bucketMinutes(size: BucketSize): number {
  return 2 + Math.ceil(size.bytes / GIB) + syncMinutes(size.count);
}

/**
 * Rough time of the window's last copy, which compares every object and copies only what changed:
 * a minute per started 2,000 objects.
 */
export function syncMinutes(count: number): number {
  return Math.ceil(count / 2000);
}

/** The step of the summary that creates the new bucket and copies the files. */
export function bucketStep(bucket: MovingBucket): string {
  return `Create the bucket ${bucketWords(bucket.next)} with a plan you approve by its hash, then copy the files of ${bucket.old.bucket} there from the new server, where the app uses the new bucket.`;
}

/** The summary's lines of a bucket that moves: its size, objects, minutes, egress and deletion. */
export function bucketSummaryLines(bucket: MovingBucket, size: BucketSize): string[] {
  const { old } = bucket;
  const sent = sizeText(size.bytes);
  const egress =
    old.provider === "digitalocean"
      ? `Egress: the copy sends about ${sent} out of DigitalOcean Spaces, which includes 1,024 GiB of outbound traffic a month and then charges $0.01 per GiB: at most ${formatMoney({ amount: Math.ceil(size.bytes / GIB) * 0.01, currency: "USD" })} for this copy.`
      : `Egress: the copy sends about ${sent} out of Hetzner Object Storage, which includes about 1 TB of traffic a month in its base price; what Hetzner charges beyond that is not known to OpsCrew.`;
  return [
    `Bucket: ${bucketWords(old)} moves to ${bucketWords(bucket.next)}: ${sent} in ${plural(size.count, "object")}, about ${bucketMinutes(size)} minutes to copy before the maintenance window; the window copies only what changed since.`,
    egress,
    `${bucketWords(old)} keeps billing until \`${FINISH_COMMAND}\` deletes it, after you type its name.`,
  ];
}

/** One `[name]` section of rclone's configuration for `bucket`'s service, with `key`. */
function rcloneRemote(name: "old" | "new", bucket: ProviderBucket, key: StorageKey): string[] {
  const endpoint = STORAGE_ENDPOINTS[bucket.provider];
  if (endpoint === undefined) throw new Error(`No S3 endpoint is known for ${bucket.provider}.`);
  return [
    `[${name}]`,
    "type = s3",
    `provider = ${bucket.provider === "digitalocean" ? "DigitalOcean" : "Other"}`,
    `access_key_id = ${key.accessKeyId}`,
    `secret_access_key = ${key.secretAccessKey}`,
    `endpoint = ${endpoint(bucket.region)}`,
    ...(bucket.provider === "hetzner" ? [`region = ${bucket.region}`] : []),
    // The buckets exist: rclone never tries to create one.
    "no_check_bucket = true",
  ];
}

/**
 * A one-off container of the pinned rclone image running `args`. Its configuration, with the
 * keys, arrives on standard input only: `sh` writes it to a file only this container can read, in
 * a `/tmp` held in memory (never on the server's disk), which goes with the container (`--rm`).
 * The image's entrypoint is rclone itself, so `sh` is named as the entrypoint.
 */
function rcloneCommand(args: string): string {
  return `docker run -i --rm --tmpfs /tmp:mode=0700 --entrypoint sh ${IMAGES.rclone.ref} -c 'umask 077; cat >/tmp/r.conf; exec rclone --config /tmp/r.conf ${args}'`;
}

/**
 * Runs rclone `args` on the `which` side's server (as `deploy`, over SSH) with `config` on its
 * standard input. Returns its output; a failure stops with the end of its output, redacted and
 * with the server's address in words.
 */
async function runRclone(
  session: MoveBase,
  which: "old" | "new",
  input: { args: string; config: string[]; timeoutMs: number; what: string; hint: string },
): Promise<string> {
  const { deps } = session;
  const host = serverOf(session, which).ipv4;
  const words = sideWords(sideTarget(session, which), which);
  const remote = remoteFor(deps, session.services, session.deployKey.privateKeyFile, host);
  const result = await remote.run(rcloneCommand(input.args), {
    input: `${input.config.join("\n")}\n`,
    timeoutMs: input.timeoutMs,
  });
  if (result.exitCode === 0 && result.timedOut !== true) return result.stdout;
  const said = (result.stderr || result.stdout).trim().split("\n").slice(-5).join("\n");
  const why =
    result.timedOut === true
      ? `it did not finish within ${durationText(input.timeoutMs)}`
      : said || `exit code ${result.exitCode}`;
  throw new OpsCrewError(
    "COMMAND_FAILED",
    replaceNames(deps.redactor.redact(`${input.what} failed on ${words}: ${why}`), [host], words),
    { hint: input.hint },
  );
}

const RcloneSizeSchema = z.object({
  count: z.number().int().nonnegative(),
  bytes: z.number().nonnegative(),
});

/**
 * The size and object count of the bucket being left (`rclone size --json`), read in a one-off
 * container on the old server with its key on standard input only.
 */
export async function measureBucket(
  session: MoveBase,
  bucket: MovingBucket,
  key: StorageKey,
): Promise<BucketSize> {
  const { deps } = session;
  deps.reporter.step(`Measuring the bucket ${bucketWords(bucket.old)}`);
  const out = await runRclone(session, "old", {
    args: `size --json old:${bucket.old.bucket}`,
    config: rcloneRemote("old", bucket.old, key),
    timeoutMs: 30 * MINUTE,
    what: `Measuring the bucket ${bucket.old.bucket}`,
    hint: `Check that the key of the bucket ${bucket.old.bucket} can list it, then run \`${session.command}\` again. Nothing was changed.`,
  });
  let size: z.infer<typeof RcloneSizeSchema>;
  try {
    size = RcloneSizeSchema.parse(JSON.parse(out));
  } catch {
    throw new OpsCrewError(
      "COMMAND_FAILED",
      `rclone did not say the size of the bucket ${bucket.old.bucket}. Nothing was changed.`,
      { hint: `Run \`${session.command}\` again.` },
    );
  }
  return { bytes: size.bytes, count: size.count };
}

/**
 * Copies the files of the bucket being left into the new bucket, in a one-off rclone container on
 * the new server with both keys on standard input only: `copy` before the maintenance window,
 * `sync` in it (the destination was made by this move, so `sync` deletes only what was deleted at
 * the source since). Checksums and metadata are compared and kept. Audited without any key. A
 * window's sync has `timeoutMs` from the bucket's object count; a first copy may take hours.
 */
export async function copyBucket(
  session: MoveBase,
  how: "copy" | "sync",
  keys: BucketKeys,
  timeoutMs = COPY_TIMEOUT_MS,
): Promise<void> {
  const bucket = movingBucket(session.plan);
  if (bucket === undefined) return;
  const { old, next } = bucket;
  const fresh = sideWords(session.plan.target, "new");
  session.deps.reporter.step(
    how === "copy"
      ? `Copying the files of the bucket ${bucketWords(old)} to ${bucketWords(next)}, from ${fresh}`
      : `Copying what changed in the bucket ${old.bucket} to ${bucketWords(next)}`,
  );
  await runRclone(session, "new", {
    args: `${how} old:${old.bucket} new:${next.bucket} --checksum --metadata`,
    config: [...rcloneRemote("old", old, keys.old), ...rcloneRemote("new", next, keys.next)],
    // A copy that runs out of time is no harm: the next run copies only what is still missing.
    timeoutMs,
    what: `Copying the bucket ${old.bucket} to ${bucketWords(next)}`,
    hint: `Check both buckets' keys and the free traffic of your providers, then run \`${session.command}\` again: it copies what is missing.`,
  });
  await auditMove(session, {
    kind: "remote-exec",
    action: `${how} bucket`,
    target: fresh,
    decision: "approved",
    detail: `${how === "copy" ? "copied" : "synced"} the bucket ${bucketWords(old)} to ${bucketWords(next)} with rclone`,
  });
}

/** The slot a bucket resource's address names: `aws_s3_bucket.this`, `…_cors_configuration.previous`. */
function slotOf(address: string): "this" | "previous" | undefined {
  return /^aws_s3_bucket(?:_cors_configuration)?\.(this|previous)$/.exec(address)?.[1] as
    | "this"
    | "previous"
    | undefined;
}

/** The words of a bucket plan's {@link planBounded} stop: it would do more than `what`. */
function bucketStop(what: string, command: string): { lead: string; hint: string } {
  return {
    lead: `The plan of the app's bucket would do more than ${what}, so OpsCrew stopped. Nothing was changed.`,
    hint: `The bucket's infrastructure no longer matches what OpsCrew applied. Check the buckets in your providers' consoles, then run \`${command}\` again.`,
  };
}

/** One plan of the move's `storage` root. */
interface StoragePlan {
  layout: MoveLayoutName;
  /** The default `aws` provider's key, and the `aws.previous` provider's when the layout has it. */
  key: StorageKey;
  previous?: StorageKey;
  check: (saved: Pick<SavedPlan, "changes" | "moves">) => void;
  /** The new bucket's creation, through `applyStorage` (which keeps a bucket shown late). */
  creates?: true;
  /** The bucket it deletes: its name is typed to approve the plan. */
  deletes?: ProviderBucket;
  /** Awaited right before the engine applies it (an abort records that it began). */
  beforeApply?: () => Promise<void>;
}

/** The render context of the `storage` root, which reads none of it for a bucket at Hetzner or Spaces. */
function storageContext(session: MoveSession): RenderContext {
  return {
    opscrewVersion: session.deps.version,
    github: { owner: session.github.owner, repo: session.github.repo },
    deploySshPublicKey: session.deployKey.publicKeyOpenSsh,
  };
}

/**
 * The saved plan of this step of the `storage` root (its file name ends in `suffix`) that
 * `--approve <hash>` names (an earlier run's stop), checked again with `check` (deleted when it
 * fails), or undefined when it names no such plan. The approval is used up either way.
 */
async function approvedStoragePlan(
  session: MoveSession,
  suffix: string,
  check: StoragePlan["check"],
): Promise<string | undefined> {
  const hash = session.approve;
  if (hash === undefined) return undefined;
  const saved = await findSavedPlan(session.deps.paths.files.plansDir, hash);
  if (saved === undefined || !saved.planFile.endsWith(suffix)) return undefined;
  session.approve = undefined;
  try {
    check(saved);
  } catch (error) {
    await discardSaved(saved.planFile);
    throw error;
  }
  return saved.planHash;
}

/**
 * The `storage` root in `step.layout` (written into the working tree, as the infra root's layouts
 * are): planned, checked before any approval, then applied after the `iac-apply` approval bound to
 * its hash (a deletion with `allowDestroy` and the bucket's typed name). Non-interactive runs stop
 * with the hash (`--approve <hash>`, and `--confirm <bucket>` for a deletion). The key of the
 * bucket being left reaches the engine only in a credentials file that exists while it runs.
 */
async function storagePlan(
  session: MoveSession,
  step: StoragePlan,
): Promise<"applied" | "unchanged" | RetargetResult> {
  const { deps } = session;
  const plan = session.plan;
  const files = renderStorage(plan, storageContext(session), { layout: step.layout });
  await writeRenderedFiles(deps.paths.root, files);
  const deleted = step.deletes;
  // Each step's saved plans end in a name of their own, so `--approve` names one step's plan.
  const suffix = step.creates ? STORAGE_PLAN_SUFFIX : `-bucket-${step.layout}.tfplan`;
  const run = (
    keyFile: string | undefined,
    how: { planOnly: true } | { approvePlanHash: string },
  ) => {
    const runDeps = "planOnly" in how && deps.interactive ? quietly(deps) : deps;
    if (step.creates) {
      return applyStorage(runDeps, {
        engine: session.engine,
        env: session.env,
        plan,
        files,
        key: step.key,
        ...(keyFile !== undefined ? { previousKeyFile: keyFile } : {}),
        command: session.command,
        phase: "retarget",
        ...(session.services.sleep !== undefined ? { sleep: session.services.sleep } : {}),
        ...how,
      });
    }
    return planAndApply(runDeps, {
      engine: session.engine,
      dir: join(deps.paths.root, storageRootDir(plan)),
      env: storageEngineEnv(session.env, plan, step.key, keyFile),
      deployPlan: plan,
      files,
      statePath: storageStateFile(deps.paths),
      planSuffix: suffix,
      planNoun: "storage plan",
      command: session.command,
      phase: "retarget",
      ...(deleted !== undefined
        ? {
            approvalTitle: `Delete the bucket ${bucketWords(deleted)} with its files`,
            approvalNotes: [
              `Every file in ${deleted.bucket} on ${STORAGE_NAMES[deleted.provider]} is deleted with it. This cannot be undone. Type the bucket's name to approve.`,
            ],
            costDelta: { amount: -deleted.price.monthly, currency: deleted.price.currency },
            confirmPhrase: () => deleted.bucket,
          }
        : { costDelta: null }),
      ...(step.beforeApply !== undefined ? { beforeApply: step.beforeApply } : {}),
      ...how,
    });
  };
  const withKey = <T>(act: (keyFile?: string) => Promise<T>): Promise<T> =>
    step.previous === undefined ? act() : withPreviousBucketKey(deps, step.previous, act);
  return withKey(async (keyFile) => {
    const approved = await approvedStoragePlan(session, suffix, step.check);
    if (approved !== undefined) {
      await run(keyFile, { approvePlanHash: approved });
      return "applied";
    }
    const saved = (await run(keyFile, { planOnly: true })).plan;
    if (saved === undefined || (saved.changes.length === 0 && !isMovesOnly(saved))) {
      return "unchanged";
    }
    try {
      step.check(saved);
    } catch (error) {
      await discardSaved(saved.planFile);
      throw error;
    }
    if (!deps.interactive) {
      return pendingStop(
        session,
        saved.planHash,
        deleted !== undefined ? ["--confirm", deleted.bucket] : [],
      );
    }
    await run(keyFile, { approvePlanHash: saved.planHash });
    return "applied";
  });
}

/** True when the `storage` root's state holds `address`. */
async function stateHolds(session: MoveSession, address: string): Promise<boolean> {
  const state = storageStateFile(session.deps.paths);
  if (!(await exists(state))) return false;
  return (await session.engine.stateResources(state, { env: session.env })).includes(address);
}

/** The bucket being left once it is renamed in the state: the move's other bucket plans need it. */
const PREVIOUS = "aws_s3_bucket.previous";

/**
 * Step `renamed`: the moves-only plan that renames the app's bucket to `aws_s3_bucket.previous` in
 * its root's state (nothing changes at the provider), so the new bucket can take its place.
 */
export async function renameBucket(session: MoveSession): Promise<RetargetResult | undefined> {
  const bucket = movingBucket(session.plan);
  if (bucket === undefined) return undefined;
  session.deps.reporter.step(
    `Renaming the bucket ${bucket.old.bucket} in the bucket's state (nothing changes on ${STORAGE_NAMES[bucket.old.provider]})`,
  );
  const keys = await bucketKeys(session, bucket);
  const done = await storagePlan(session, {
    layout: "rename",
    key: keys.next,
    previous: keys.old,
    check: planBounded({
      ...bucketStop("renaming the bucket in its state", session.command),
      move: (m) => slotOf(m.from) === "this" && slotOf(m.to) === "previous",
    }),
  });
  return typeof done === "string" ? undefined : done;
}

/** Step `created`: the plan that creates the new bucket next to the one being left. */
export async function createBucket(session: MoveSession): Promise<RetargetResult | undefined> {
  const bucket = movingBucket(session.plan);
  if (bucket === undefined) return undefined;
  session.deps.reporter.step(`Creating the bucket ${bucketWords(bucket.next)}`);
  const keys = await bucketKeys(session, bucket);
  const done = await storagePlan(session, {
    layout: "both",
    key: keys.next,
    previous: keys.old,
    creates: true,
    check: planBounded({
      ...bucketStop("creating the new bucket", session.command),
      change: (c) => c.action === "create" && slotOf(c.address) === "this",
    }),
  });
  return typeof done === "string" ? undefined : done;
}

/** After a deletion: the bucket checked until it is gone, and its kept key dropped. */
async function afterDeletion(
  session: MoveSession,
  bucket: ProviderBucket,
  key: StorageKey,
): Promise<string | undefined> {
  const { deps, services } = session;
  const still = await confirmBucketGone(deps, bucket, key, services.sleep ?? realSleep);
  await forgetStorageKey(deps, bucket);
  if (still !== undefined) {
    deps.reporter.warn(still.error.message);
    return still.remaining;
  }
  deps.reporter.success(`Deleted the bucket ${bucketWords(bucket)}.`);
  await auditMove(session, {
    kind: "phase",
    action: "retarget bucket deleted",
    detail: `the bucket ${bucketWords(bucket)} is deleted`,
  });
  return undefined;
}

/**
 * `--finish` (FR-2311): the bucket being left (`aws_s3_bucket.previous`) is deleted with its files
 * through the `finish` layout's plan, after the `iac-apply` approval with its own typed name.
 * `keys` were read before any change of the finish. Returns a script's stop, or what remains (a
 * bucket its provider still lists).
 */
export async function deleteOldBucket(
  session: MoveSession,
  keys: BucketKeys,
): Promise<{ stop: RetargetResult } | { remaining: string[] }> {
  const bucket = movingBucket(session.plan);
  if (bucket === undefined || !(await stateHolds(session, PREVIOUS))) return { remaining: [] };
  session.deps.reporter.step(`Planning the deletion of the bucket ${bucketWords(bucket.old)}`);
  const done = await storagePlan(session, {
    layout: "finish",
    key: keys.next,
    previous: keys.old,
    deletes: bucket.old,
    check: planBounded({
      ...bucketStop("deleting the bucket being left", session.command),
      change: (c) => c.action === "delete" && slotOf(c.address) === "previous",
    }),
  });
  if (typeof done !== "string") return { stop: done };
  if (done === "unchanged") return { remaining: [] };
  const still = await afterDeletion(session, bucket.old, keys.old);
  return { remaining: still === undefined ? [] : [still] };
}

/**
 * `--abort`: the new bucket (`aws_s3_bucket.this` once the bucket being left is renamed) is
 * deleted with its files through the `abort-remove` layout's plan, after the `iac-apply` approval
 * with its typed name; `beforeApply` runs right before. `keys` were read before any change of the
 * abort. Returns a script's stop.
 */
export async function removeNewBucket(
  session: MoveSession,
  keys: BucketKeys,
  beforeApply: () => Promise<void>,
): Promise<RetargetResult | undefined> {
  const bucket = movingBucket(session.plan);
  if (bucket === undefined || !(await stateHolds(session, PREVIOUS))) return undefined;
  session.deps.reporter.step(`Planning the deletion of the new bucket ${bucketWords(bucket.next)}`);
  const done = await storagePlan(session, {
    layout: "abort-remove",
    key: keys.next,
    previous: keys.old,
    deletes: bucket.next,
    beforeApply,
    check: planBounded({
      ...bucketStop("deleting the new bucket", session.command),
      change: (c) => c.action === "delete" && slotOf(c.address) === "this",
    }),
  });
  if (typeof done !== "string") return done;
  if (done === "applied") await afterDeletion(session, bucket.next, keys.next);
  return undefined;
}

/**
 * `--abort`, after the new bucket is gone: the moves-only plan that renames the bucket being left
 * back to `aws_s3_bucket.this` (nothing changes at the provider). Returns a script's stop.
 */
export async function renameBucketBack(
  session: MoveSession,
  keys: BucketKeys,
): Promise<RetargetResult | undefined> {
  const bucket = movingBucket(session.plan);
  if (bucket === undefined || !(await stateHolds(session, PREVIOUS))) return undefined;
  session.deps.reporter.step(`Renaming the bucket ${bucket.old.bucket} back in the bucket's state`);
  const done = await storagePlan(session, {
    // Only the bucket being left's provider is in this layout (the new bucket is gone).
    layout: "abort-rename",
    key: keys.old,
    check: planBounded({
      ...bucketStop("renaming the bucket back in its state", session.command),
      move: (m) => slotOf(m.from) === "previous" && slotOf(m.to) === "this",
    }),
  });
  return typeof done === "string" ? undefined : done;
}

/**
 * The `storage` root as `plan` (without a move) renders it, written into the working tree: the
 * final files after `--finish`, the original ones after `--abort`. Returns them; none without a
 * bucket at a provider.
 */
export async function writeStorageFiles(
  session: MoveSession,
  plan: DeployPlan,
): Promise<RenderedFile[]> {
  const files = renderStorage(plan, storageContext(session));
  await writeRenderedFiles(session.deps.paths.root, files);
  return files;
}
