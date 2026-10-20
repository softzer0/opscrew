import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ApprovalRecord, PlanSummary } from "@opscrew/contracts";
import { exists, OpsCrewError, plural, realSleep } from "@opscrew/core";
import {
  type RenderContext,
  renderStorage,
  STORAGE_NAMES,
  storageRootDir,
} from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import { z } from "zod";
import type { PhaseDeps } from "../context";
import {
  type ProviderBucket,
  providerBucket,
  requireStorageKey,
  type StorageKey,
  storageEngineEnv,
  storageStateFile,
} from "../provision";
import { describeChanges, type ProjectEngine, readValidJson, refusalReason } from "../shared";
import { storageS3Client } from "../shared/s3";
import { planHeading } from "./checks";
import { typeNameHint } from "./common";
import {
  applyApprovedPlan,
  assertDeletionPlan,
  type DeletionScope,
  type DeletionSession,
  deletionSession,
  discardPlan,
  savePlan,
} from "./deletion";

/** The command that deletes the app's data, named in stops and hints. */
const DELETE_DATA = "opscrew destroy --delete-data";

/** The deletion of the app's bucket, planned (never applied yet) before the confirmation. */
export interface BucketDeletion {
  session: DeletionSession;
  summary: PlanSummary;
  bucket: ProviderBucket;
  /** The user's key of a Hetzner or Spaces bucket, to check that it is gone. Never logged. */
  key?: StorageKey;
}

/** Where the bucket is, in words: `shop-uploads on Hetzner Object Storage (fsn1)`. */
function bucketWords(bucket: ProviderBucket): string {
  return `${bucket.bucket} on ${STORAGE_NAMES[bucket.provider]} (${bucket.region})`;
}

/** Said before the confirmation of a teardown without `--delete-data`, when the app has a bucket. */
export function bucketStays(bucket: ProviderBucket): string {
  return `The app's bucket ${bucketWords(bucket)} and its files stay. To delete them as well, cancel now and run \`${DELETE_DATA}\`.`;
}

/** Said before the confirmation when `--delete-data` deletes the app's bucket. */
export function bucketDeletionWarning(deletion: Pick<BucketDeletion, "bucket">): string {
  const { bucket } = deletion;
  return bucket.provider === "r2"
    ? `With --delete-data, OpsCrew also deletes the app's bucket ${bucketWords(bucket)} once it is empty: Cloudflare refuses a bucket that holds files, and OpsCrew never deletes them itself.`
    : `With --delete-data, OpsCrew also deletes the app's bucket ${bucketWords(bucket)} and every file in it. This cannot be undone.`;
}

/** Where the user deletes a bucket by hand. */
const CONSOLE: Readonly<Record<ProviderBucket["provider"], string>> = {
  r2: "the Cloudflare dashboard (R2 Object Storage)",
  hetzner: "the Hetzner Cloud Console (Object Storage)",
  digitalocean: "the DigitalOcean control panel (Spaces Object Storage)",
};

/**
 * What remains of the app's bucket after a teardown without `--delete-data` (FR-1319): the bucket
 * and its files stay where they are, billed by the provider. As for the app's other data, OpsCrew
 * deletes it only in the teardown that removes the app. Undefined without a bucket at a provider.
 */
export function bucketKept(plan: DeployPlan): string | undefined {
  const bucket = providerBucket(plan);
  if (bucket === undefined) return undefined;
  return `The app's bucket ${bucketWords(bucket)} with the app's files, which ${STORAGE_NAMES[bucket.provider]} bills until it is deleted. OpsCrew deletes it only in the teardown that removes the app, with \`${DELETE_DATA}\`; to delete it now, empty and delete it in ${CONSOLE[bucket.provider]}.`;
}

/**
 * The deletion copy of the committed `storage` root: rendered without `prevent_destroy`
 * (`renderStorage` with `deleteData`) into `.opscrew/storage-delete/`, with the Cloudflare account
 * the committed values name (an R2 bucket belongs to it). Never written into the repository.
 */
async function deletionRoot(deps: PhaseDeps, plan: DeployPlan, dir: string): Promise<void> {
  const values = await readValidJson(
    join(deps.paths.root, storageRootDir(plan), "terraform.tfvars.json"),
    z.looseObject({ cloudflare_account_id: z.string().optional() }),
  );
  if (values === undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      "The infrastructure code of the app's bucket (opscrew/infra/storage) is missing, so OpsCrew cannot plan its deletion. Nothing was changed.",
      {
        hint: `Check out the branch with opscrew/infra/storage (\`opscrew provision\` added it with its pull request), then run \`${DELETE_DATA}\` again.`,
      },
    );
  }
  const ctx: RenderContext = {
    opscrewVersion: deps.version,
    github: { owner: "", repo: "" },
    deploySshPublicKey: "",
    ...(values.cloudflare_account_id !== undefined
      ? { cloudflare: { zoneId: "", accountId: values.cloudflare_account_id } }
      : {}),
  };
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  for (const file of renderStorage(plan, ctx, { deleteData: true })) {
    await writeFile(join(dir, basename(file.path)), file.content);
  }
}

/**
 * With `--delete-data`, the plan that deletes the app's bucket and its files (FR-1319), made
 * before anything changes so the confirmation lists it: the `storage` root's deletion copy
 * ({@link deletionRoot}) is planned `-destroy` against the root's own state with the engine of
 * `setup` (a Hetzner or Spaces bucket with the user's key, only in the environment). Undefined
 * without a bucket at a provider, or when the state holds nothing to delete.
 */
export async function planBucketDeletion(
  scope: DeletionScope,
  plan: DeployPlan,
  setup: ProjectEngine,
): Promise<BucketDeletion | undefined> {
  const { deps } = scope;
  const bucket = providerBucket(plan);
  const state = storageStateFile(deps.paths);
  if (bucket === undefined || !(await exists(state))) return undefined;
  const key =
    bucket.provider === "r2"
      ? undefined
      : await requireStorageKey(deps, plan, {}, { command: DELETE_DATA, asks: false });
  const dir = join(deps.paths.stateDir, "storage-delete");
  await deletionRoot(deps, plan, dir);
  const env = storageEngineEnv(setup.env, plan, key);
  const session = deletionSession(scope, { engine: setup.engine, env, dir });
  deps.reporter.step(`Planning the deletion of the app's bucket ${bucketWords(bucket)}`);
  await setup.engine.init(dir, { env, backendConfig: { path: state } });
  const summary = await savePlan(session, "destroy-bucket", { destroy: true });
  if (summary.changes.length > 0) return { session, summary, bucket, ...(key ? { key } : {}) };
  await discardPlan(summary);
  await rm(dir, { recursive: true, force: true });
  return undefined;
}

/** How many times, and how far apart, a deleted bucket is checked: about 20 s. */
const GONE_CHECKS = 5;
const GONE_INTERVAL_MS = 5_000;

/** A deleted bucket its provider still lists: said in what remains, and the run fails at its end. */
export interface BucketStillListed {
  /** The "What remains" item naming the bucket and where to delete it. */
  remaining: string;
  /** The error the teardown ends with once everything else is done. */
  error: OpsCrewError;
}

/** What `deleteBucket` did: its approval, and the bucket when the provider still lists it. */
export interface BucketDeleted {
  approval: ApprovalRecord;
  stillListed?: BucketStillListed;
}

/**
 * Confirms that a Hetzner or Spaces bucket the engine deleted is gone: both providers can still
 * answer for a deleted bucket for a while, and keep billing it. Checks it over about 20 s, deletes
 * it again when it still answers and checks again. Returns what to say when it is still there;
 * never says it is gone before it answers 404.
 */
async function confirmBucketGone(
  deps: PhaseDeps,
  bucket: ProviderBucket,
  key: StorageKey,
  sleep: (ms: number) => Promise<void>,
): Promise<BucketStillListed | undefined> {
  const client = storageS3Client(bucket, key, { fetch: deps.fetch, now: () => deps.clock.now() });
  const gone = async () => {
    for (let check = 1; ; check++) {
      if (!(await client.headBucket())) return true;
      if (check === GONE_CHECKS) return false;
      await sleep(GONE_INTERVAL_MS);
    }
  };
  const name = STORAGE_NAMES[bucket.provider];
  if (await gone()) return undefined;
  deps.reporter.info(`${name} still lists the bucket ${bucket.bucket}; deleting it again.`);
  await client.deleteBucket();
  if (await gone()) return undefined;
  const check = `Check ${CONSOLE[bucket.provider]} in a few minutes and delete the bucket ${bucket.bucket} there if it is still listed.`;
  return {
    remaining: `The app's bucket ${bucketWords(bucket)}, which ${name} still listed after OpsCrew deleted it twice, so ${name} may still bill it. ${check}`,
    error: new OpsCrewError(
      "PROVIDER_ERROR",
      `${name} still lists the app's bucket ${bucket.bucket} after OpsCrew deleted it twice, so it may not be gone and ${name} may still bill it. The rest of the teardown is done.`,
      { hint: check },
    ),
  };
}

/** The "What remains" item of a bucket its provider still lists, if any. */
export function bucketStillListed(deleted: BucketDeleted | undefined): string[] {
  return deleted?.stillListed !== undefined ? [deleted.stillListed.remaining] : [];
}

/** Ends a finished teardown with the error of a bucket its provider still lists, if any. */
export function failIfBucketListed(deleted: BucketDeleted | undefined): void {
  if (deleted?.stillListed !== undefined) throw deleted.stillListed.error;
}

/** R2's refusal to delete a bucket that still holds files. */
const NOT_EMPTY = /not empty|BucketNotEmpty|\b10008\b/i;

/**
 * Deletes the app's bucket through its own plan (`iac-apply` with `allowDestroy` and the typed app
 * name): a Hetzner or Spaces bucket with its files (`force_destroy`), an R2 bucket only when it is
 * empty. Cloudflare refuses a bucket that holds files: then nothing is deleted, and OpsCrew says
 * how to empty it in the dashboard; it never deletes the files itself. The plan and the deletion
 * copy of the root are removed afterwards, whatever happened. A Hetzner or Spaces bucket is then
 * checked until it is gone ({@link confirmBucketGone}; `sleep` waits between checks): when it is
 * still listed, the result says so, and the caller finishes the teardown before failing with it
 * ({@link bucketStillListed}, {@link failIfBucketListed}).
 */
export async function deleteBucket(
  deletion: BucketDeletion,
  options: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<BucketDeleted> {
  const { session, summary, bucket } = deletion;
  const { deps, app } = session;
  const name = STORAGE_NAMES[bucket.provider];
  try {
    assertDeletionPlan(
      session,
      summary,
      { confirmed: new Set(summary.changes.map((change) => change.address)) },
      { note: "Nothing was deleted.", hint: `Run \`${DELETE_DATA}\` again to plan it afresh.` },
    );
    const count = summary.changes.length;
    const approval = await deps.approvals.request({
      kind: "iac-apply",
      title: `Delete the app's bucket ${bucket.bucket} on ${name} with its files (${plural(count, "resource")} to delete)`,
      details: [
        planHeading(summary, "destroy plan"),
        ...describeChanges(summary.changes),
        bucket.provider === "r2"
          ? "Cloudflare deletes an R2 bucket only when it is empty: if it still holds files, nothing is deleted and OpsCrew says how to empty it. OpsCrew never deletes the files itself."
          : "Every file in the bucket is deleted with it. This cannot be undone.",
        `Plan hash: ${summary.planHash}`,
      ].join("\n"),
      planHash: summary.planHash,
      allowDestroy: true,
      confirmPhrase: app,
      costDelta: { amount: -bucket.price.monthly, currency: bucket.price.currency },
    });
    if (!approval.approved) {
      throw new OpsCrewError(
        "APPROVAL_REFUSED",
        `The deletion of the app's bucket ${bucket.bucket} was not approved${refusalReason(approval)}. Nothing was deleted.`,
        { hint: typeNameHint(app) },
      );
    }
    await deps.approvals.assertApprovedPlan(summary.planHash, { allowDestroy: true });
    deps.reporter.step(`Deleting the app's bucket ${bucket.bucket}`);
    try {
      await applyApprovedPlan(session, summary, {
        allowDestroy: true,
        what: `deleting the bucket ${bucket.bucket}`,
        hint: `Fix the cause shown above, then run \`${DELETE_DATA}\` again.`,
      });
    } catch (error) {
      if (
        bucket.provider !== "r2" ||
        !(error instanceof OpsCrewError) ||
        !NOT_EMPTY.test(error.message)
      ) {
        throw error;
      }
      throw new OpsCrewError(
        "PHASE_PRECONDITION",
        `Cloudflare deletes an R2 bucket only when it is empty, and ${bucket.bucket} still holds files, so it was not deleted. OpsCrew never deletes the files itself.`,
        {
          hint: `Empty it in the Cloudflare dashboard (R2 Object Storage → ${bucket.bucket} → select the objects → Delete; for many files, add an object lifecycle rule that deletes them after a day), then run \`${DELETE_DATA}\` again.`,
        },
      );
    }
    if (bucket.provider !== "r2") {
      if (deletion.key === undefined) throw new Error("The bucket's key is needed to check it.");
      const stillListed = await confirmBucketGone(
        deps,
        bucket,
        deletion.key,
        options.sleep ?? realSleep,
      );
      if (stillListed !== undefined) return { approval, stillListed };
    }
    deps.reporter.success(`Deleted the app's bucket ${bucket.bucket} on ${name}.`);
    return { approval };
  } finally {
    await discardBucketDeletion(deletion);
  }
}

/** Removes the plan and the deletion copy of the root, so neither is ever applied later. */
export async function discardBucketDeletion(deletion: BucketDeletion): Promise<void> {
  await discardPlan(deletion.summary);
  await rm(deletion.session.dir, { recursive: true, force: true });
}
