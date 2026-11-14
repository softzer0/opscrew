import { mkdir, readFile, rm } from "node:fs/promises";
import { devNull } from "node:os";
import { dirname, join } from "node:path";
import type {
  IacEngine,
  ObjectStorageApi,
  PhaseName,
  ProviderObjectStorage,
} from "@opscrew/contracts";
import {
  canonicalJson,
  exists,
  formatMoney,
  OpsCrewError,
  type ProjectPaths,
  readTextIfExists,
  realSleep,
  sha256Hex,
  writeFileAtomic,
} from "@opscrew/core";
import {
  type BucketProvider,
  backupsRootDir,
  PORTAINER_OFFSITE_VARIABLES,
  PREVIOUS_BUCKET_PROFILE,
  type ProviderBucket,
  providerBucket,
  type RenderedFile,
  STORAGE_NAMES,
  STORAGE_PRICES,
  storageRootDir,
} from "@opscrew/iac-templates";
import { backupsBucketOf, type DeployPlan, snapshotOffsiteOf } from "@opscrew/plan-schema";
import { z } from "zod";
import type { PhaseDeps } from "../context";
import { CONTABO_STORAGE_GB } from "../design/storage";
import { vpsConnector } from "../providers";
import type { RefreshRecoveryOptions } from "../secrets";
import { knownRecipients } from "../secrets/store";
import {
  backupsStateFile,
  r2Endpoint,
  STORAGE_ENDPOINTS,
  type StorageLogin,
  storageStateFile,
} from "../shared";
import { credentialsMissing } from "../shared/errors";
import { readRecord, writeRecord } from "../shared/records";
import { storageS3Client } from "../shared/s3";
import type { CloudflareSetup, GitHubSetup } from "./credentials";
import { type PlanAndApplyResult, type PlanPrice, planAndApply } from "./plan-apply";
import { type RecoveryCopy, recoveryCopyFiles } from "./publish";
import type { ProvisionServices } from "./types";

export { backupsStateFile, storageStateFile } from "../shared";

export { type BucketProvider, type ProviderBucket, providerBucket };

/** What `askStorageKey` asks with: the provider in words, the bucket and the console steps. */
export interface StorageKeyQuestion {
  provider: string;
  bucket: string;
  /** What to do in the provider's console, one step each. */
  steps: string[];
}

/** The variables a non-interactive run reads the key from (they win over a stored key). */
export const STORAGE_KEY_VARS = {
  accessKeyId: "OPSCREW_STORAGE_ACCESS_KEY_ID",
  secretAccessKey: "OPSCREW_STORAGE_SECRET_ACCESS_KEY",
} as const;

/** The variables of the new bucket's key while a move takes the bucket along (read only then). */
export const NEW_STORAGE_KEY_VARS = {
  accessKeyId: "OPSCREW_NEW_STORAGE_ACCESS_KEY_ID",
  secretAccessKey: "OPSCREW_NEW_STORAGE_SECRET_ACCESS_KEY",
} as const;

/** The variables a non-interactive run reads the off-server copies' bucket's key from. */
export const OFFSITE_KEY_VARS = {
  accessKeyId: "OPSCREW_OFFSITE_ACCESS_KEY_ID",
  secretAccessKey: "OPSCREW_OFFSITE_SECRET_ACCESS_KEY",
} as const;

/**
 * The variables of the off-server copies' new bucket's key while a move to another Cloudflare
 * account takes that R2 bucket along (read only then).
 */
export const NEW_OFFSITE_KEY_VARS = {
  accessKeyId: "OPSCREW_NEW_OFFSITE_ACCESS_KEY_ID",
  secretAccessKey: "OPSCREW_NEW_OFFSITE_SECRET_ACCESS_KEY",
} as const;

type KeyVars =
  | typeof STORAGE_KEY_VARS
  | typeof NEW_STORAGE_KEY_VARS
  | typeof OFFSITE_KEY_VARS
  | typeof NEW_OFFSITE_KEY_VARS;

/** The variables of the bucket being left while a move reads the new bucket's from the others. */
const LEFT_KEY_VARS = new Map<KeyVars, KeyVars>([
  [NEW_STORAGE_KEY_VARS, STORAGE_KEY_VARS],
  [NEW_OFFSITE_KEY_VARS, OFFSITE_KEY_VARS],
]);

/** A bucket as its key, its marker and its S3 endpoint need it. */
type Bucket = Pick<ProviderBucket, "provider" | "bucket" | "region">;

/**
 * A bucket whose key the user creates: every provider's but Contabo's, which Contabo makes, and
 * the user's own S3-compatible bucket of the off-server copies (`s3`, at its `endpoint`).
 */
type UserKeyedBucket = Pick<Bucket, "bucket"> &
  (
    | { provider: Exclude<BucketProvider, "contabo">; endpoint?: undefined }
    | { provider: "s3"; endpoint: string }
  );

/** Where a bucket whose key the user creates is, in words: the provider, or the endpoint's host. */
function keyedStorageName(bucket: UserKeyedBucket): string {
  return bucket.provider === "s3" ? new URL(bucket.endpoint).host : STORAGE_NAMES[bucket.provider];
}

/** The steps to create the key in each provider's console, for `app` and `bucket`. */
const KEY_STEPS: Readonly<
  Record<UserKeyedBucket["provider"], (app: string, bucket: string) => string[]>
> = {
  hetzner: (app) => [
    "Open the Hetzner Cloud Console (https://console.hetzner.cloud), choose the project the server is in, and go to Security → S3 credentials.",
    `Choose Generate credentials, with the description opscrew-${app}. A Hetzner key works for every bucket of its project; a key of this app's own can be revoked without touching other apps.`,
    "Copy the access key and the secret key: Hetzner shows the secret key only once.",
  ],
  digitalocean: (app) => [
    "Open Spaces Object Storage → Access Keys in the DigitalOcean control panel (https://cloud.digitalocean.com/spaces/access_keys) and choose Create Access Key.",
    `Choose Full Access (a key limited to buckets cannot create the bucket) and name it opscrew-${app}.`,
    "Copy the access key ID and the secret key: DigitalOcean shows the secret key only once.",
  ],
  r2: (app, bucket) => [
    "Open R2 Object Storage in the Cloudflare dashboard (https://dash.cloudflare.com), choose Manage API tokens, then Create Account API token.",
    `Name it opscrew-${app}, give it the Object Read & Write permission, apply it to specific buckets only and pick ${bucket}.`,
    "Create it and copy the Access Key ID and the Secret Access Key (not the token value): Cloudflare shows the secret only once.",
  ],
  s3: (app, bucket) => [
    `In your storage provider's console, create an access key named opscrew-${app} that can list, read, write and delete objects in the bucket ${bucket}, and only there where the provider allows it.`,
    "Copy the access key ID and the secret key: most providers show the secret only once.",
  ],
};

/** A key's ID or secret as providers give them: letters, digits and `+/=_.-`. */
const KEY_PART = /^[A-Za-z0-9+/=_.-]{16,256}$/;

const StoredKeySchema = z.object({
  provider: z.enum(["r2", "digitalocean", "hetzner", "s3"]),
  bucket: z.string(),
  /**
   * An R2 bucket's Cloudflare account: the same-named buckets of two accounts keep their own keys
   * during a move. A key kept without it is of the account the app used before the move.
   */
  account: z.string().optional(),
  accessKeyId: z.string().regex(KEY_PART),
  secretAccessKey: z.string().regex(KEY_PART),
});

/**
 * Where the keys are kept between runs: a private file (0600) beside the deploy key, one line for
 * each bucket's key (a move that takes the bucket along needs both buckets' keys).
 */
export function storageKeyFile(paths: Pick<ProjectPaths, "projectHomeDir">): string {
  return join(paths.projectHomeDir, "storage_key.json");
}

/** File name ending of a saved plan of the `storage` root. */
export const STORAGE_PLAN_SUFFIX = "-storage.tfplan";

/**
 * The steps and where the key goes, for the stop when no key is known: `vars` are the variables
 * it is read from ({@link NEW_STORAGE_KEY_VARS} for the new bucket of a move).
 */
function keyHint(
  bucket: UserKeyedBucket,
  app: string,
  command: string,
  how: { asks: boolean; vars: KeyVars },
): string {
  const steps = KEY_STEPS[bucket.provider](app, bucket.bucket).map(
    (step, i) => `${i + 1}. ${step}`,
  );
  const variables = `${how.vars.accessKeyId} and ${how.vars.secretAccessKey}`;
  const left = LEFT_KEY_VARS.get(how.vars);
  const moving =
    left !== undefined
      ? ` While a move takes the bucket along, ${left.accessKeyId} and ${left.secretAccessKey} hold the key of the bucket being left.`
      : "";
  return how.asks
    ? `${steps.join(" ")} Then run \`${command}\` in a terminal to paste it once, or set ${variables} to it and run \`${command}\` again.${moving}`
    : `${steps.join(" ")} Then set ${variables} to it and run \`${command}\` again.${moving}`;
}

/** The key the variables `vars` hold, or undefined when neither is set. */
function keyFromEnv(env: PhaseDeps["env"], vars: KeyVars): StorageLogin | undefined {
  const accessKeyId = env[vars.accessKeyId]?.trim() ?? "";
  const secretAccessKey = env[vars.secretAccessKey]?.trim() ?? "";
  if (accessKeyId === "" && secretAccessKey === "") return undefined;
  const missing = accessKeyId === "" ? vars.accessKeyId : vars.secretAccessKey;
  if (accessKeyId === "" || secretAccessKey === "") {
    throw new OpsCrewError("INVALID_INPUT", `${missing} is not set, but its pair is.`, {
      hint: `Set both ${vars.accessKeyId} and ${vars.secretAccessKey} to the bucket's key, then run the command again.`,
    });
  }
  return checkedKey({ accessKeyId, secretAccessKey }, "The key in the environment");
}

/** `key` when both parts look like a key; never says what they hold. */
function checkedKey(key: StorageLogin, what: string): StorageLogin {
  if (KEY_PART.test(key.accessKeyId) && KEY_PART.test(key.secretAccessKey)) return key;
  throw new OpsCrewError(
    "INVALID_INPUT",
    `${what} does not look like an access key ID and its secret (16 to 256 letters, digits or +/=_.-).`,
    { hint: "Copy both from the provider's console again, without spaces, then try again." },
  );
}

type StoredKey = z.infer<typeof StoredKeySchema>;

/** True when `a` and `b` name the same bucket (provider and name). */
function sameBucket(
  a: { provider: string; bucket: string },
  b: { provider: string; bucket: string },
): boolean {
  return a.provider === b.provider && a.bucket === b.bucket;
}

/** Every kept key, one line each in {@link storageKeyFile}; none without the file. */
async function keptKeys(deps: Pick<PhaseDeps, "paths">): Promise<StoredKey[]> {
  const file = storageKeyFile(deps.paths);
  const text = await readTextIfExists(file);
  if (text === undefined) return [];
  try {
    return text
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => StoredKeySchema.parse(JSON.parse(line)));
  } catch {
    throw new OpsCrewError(
      "ARTIFACT_INVALID",
      `OpsCrew's copy of the bucket's key (${file}) is damaged, so OpsCrew stopped. Nothing was changed.`,
      { hint: "Delete that file, then run the command again to paste the key once more." },
    );
  }
}

/** Writes `keys` to {@link storageKeyFile} (mode 0600), or removes the file when none is left. */
async function keepKeys(deps: Pick<PhaseDeps, "paths">, keys: readonly StoredKey[]) {
  const file = storageKeyFile(deps.paths);
  if (keys.length === 0) {
    await rm(file, { force: true });
    return;
  }
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const lines = keys.map((key) => JSON.stringify(key));
  await writeFileAtomic(file, `${lines.join("\n")}\n`, { mode: 0o600 });
}

/**
 * Where a key is asked for: the bucket, and for an R2 bucket its Cloudflare `account` and the
 * account a move goes to (`moveTo`, from `cloudflareMove`).
 */
interface KeyedBucket {
  bucket: UserKeyedBucket;
  account?: string | undefined;
  moveTo?: string | undefined;
}

/**
 * True when `kept` is the key of `at`'s bucket: the same bucket, and the same account when both
 * name one. A key kept without an account is of the account the app used before a move, so it
 * never stands for the bucket of the account the move goes to.
 */
function keyOf(kept: StoredKey, at: KeyedBucket): boolean {
  if (!sameBucket(kept, at.bucket)) return false;
  if (at.account === undefined || kept.account === at.account) return true;
  return kept.account === undefined && at.account !== at.moveTo;
}

/**
 * The kept key for this bucket, or undefined (none kept for it): the one kept with its account
 * before one kept without.
 */
async function storedKey(deps: PhaseDeps, at: KeyedBucket): Promise<StorageLogin | undefined> {
  const keys = (await keptKeys(deps)).filter((key) => keyOf(key, at));
  const kept = keys.find((key) => key.account === at.account) ?? keys[0];
  if (kept === undefined) return undefined;
  return { accessKeyId: kept.accessKeyId, secretAccessKey: kept.secretAccessKey };
}

/** Drops the kept key of `bucket` (one a move deleted); the other buckets' keys stay. */
export async function forgetStorageKey(
  deps: Pick<PhaseDeps, "paths">,
  bucket: Pick<ProviderBucket, "provider" | "bucket">,
): Promise<void> {
  const keys = await keptKeys(deps);
  const rest = keys.filter((key) => !sameBucket(key, bucket));
  if (rest.length !== keys.length) await keepKeys(deps, rest);
}

/**
 * The user's key for the plan's provider bucket (FR-1318), or for `options.bucket`: from
 * {@link STORAGE_KEY_VARS} when they are set (never saved), else the key kept for this bucket, else
 * asked once with the console steps (`askStorageKey`, interactive runs only) and kept like a
 * provider token in a private file ({@link storageKeyFile}, mode 0600, outside the repository,
 * beside the other buckets' keys). While a move takes the bucket along
 * (`plan.retarget.from.objectStorage`), those variables hold only the key of the bucket being left,
 * and the new bucket's is read from {@link NEW_STORAGE_KEY_VARS} instead. Hetzner's and Spaces' key is needed before the bucket, R2's (a
 * token limited to the bucket) after it. An R2 bucket names its Cloudflare `account`: its key is
 * kept with it, and while a move to another Cloudflare account (`plan.cloudflareMove`) takes the
 * bucket along, the bucket in the account it goes to reads {@link NEW_STORAGE_KEY_VARS}. A bucket in Contabo's storage has the key Contabo made
 * with the storage, read through its API ({@link orderedStorageKey}), never asked, kept or
 * taken from the variables. Registered with the redactor.
 * @throws OpsCrewError `CREDENTIALS_MISSING` with the steps when no key is known and nobody can be
 * asked; `already` says what is done (default: nothing was changed), and with `asks: false` (a
 * command that never asks) the hint names only the variables.
 */
export async function requireStorageKey(
  deps: PhaseDeps,
  plan: DeployPlan,
  services: Pick<ProvisionServices, "askStorageKey" | "objectStorage">,
  options: {
    command: string;
    already?: string;
    asks?: boolean;
    bucket?: ProviderBucket;
    /** An R2 bucket's Cloudflare account. */
    account?: string;
  },
): Promise<StorageLogin> {
  const bucket = options.bucket ?? providerBucket(plan);
  if (bucket === undefined) throw new Error("The plan has no bucket at a provider.");
  if (bucket.provider === "contabo") return orderedStorageKey(deps, bucket, services, options);
  const leaving = plan.retarget?.from.objectStorage;
  const moveTo = plan.cloudflareMove?.to.accountId;
  const vars =
    (leaving !== undefined && !sameBucket(bucket, leaving)) ||
    (moveTo !== undefined && options.account === moveTo)
      ? NEW_STORAGE_KEY_VARS
      : STORAGE_KEY_VARS;
  return bucketKey(deps, services, options, {
    bucket: bucket as UserKeyedBucket,
    account: options.account,
    moveTo,
    vars,
    noun: "The app's bucket",
    keyName: plan.app.name,
  });
}

/**
 * The user's key for the bucket of the off-server copies (`snapshots.offsite`, 024 plan.md 7.), as
 * {@link requireStorageKey} gets the app's: from {@link OFFSITE_KEY_VARS}, else the key kept for
 * that bucket beside the others, else asked once (interactive runs only) and kept. Hetzner's,
 * Spaces' and the user's own bucket's (`s3`) key is needed before any change, R2's (a token
 * limited to the bucket) after its bucket. An R2 bucket names its Cloudflare `account`, as with
 * {@link requireStorageKey}; the bucket in the account a move goes to reads
 * {@link NEW_OFFSITE_KEY_VARS}. Registered with the redactor.
 * @throws OpsCrewError `CREDENTIALS_MISSING` with the steps when no key is known and nobody can be
 * asked.
 */
export async function requireOffsiteKey(
  deps: PhaseDeps,
  plan: DeployPlan,
  services: Pick<ProvisionServices, "askStorageKey">,
  options: {
    command: string;
    already?: string;
    /** An R2 bucket's Cloudflare account. */
    account?: string;
  },
): Promise<StorageLogin> {
  const offsite = snapshotOffsiteOf(plan);
  if (offsite === undefined || offsite.provider === "sftp") {
    throw new Error("The plan has no off-server copy in a bucket.");
  }
  const moveTo = plan.cloudflareMove?.to.accountId;
  return bucketKey(deps, services, options, {
    bucket:
      offsite.provider === "s3"
        ? { provider: "s3", bucket: offsite.bucket, endpoint: offsite.endpoint }
        : offsite,
    account: options.account,
    moveTo,
    vars:
      moveTo !== undefined && options.account === moveTo ? NEW_OFFSITE_KEY_VARS : OFFSITE_KEY_VARS,
    noun:
      offsite.provider === "s3"
        ? "Your bucket of the off-server copies"
        : "The off-server copies' bucket",
    keyName: `${plan.app.name}-backups`,
  });
}

/** The variable that names the private key file an SFTP machine of the off-server copies takes. */
export const OFFSITE_SFTP_KEY_VAR = "OPSCREW_OFFSITE_SFTP_KEY";

/** An SSH private key file's text, as OpenSSH and PEM write it. */
const PRIVATE_KEY =
  /^-----BEGIN ([A-Z0-9 ]*)PRIVATE KEY-----\r?\n[\s\S]+\r?\n-----END \1PRIVATE KEY-----\s*$/;

/**
 * The cipher an OpenSSH private key (`openssh-key-v1`) is encrypted with, `none` without a
 * passphrase; undefined when its body holds no such key, or ends before its cipher's name does.
 */
function opensshCipher(text: string): string | undefined {
  const body = Buffer.from(text.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, ""), "base64");
  const magic = "openssh-key-v1\0";
  const start = magic.length + 4;
  if (body.length < start || body.subarray(0, magic.length).toString("latin1") !== magic) {
    return undefined;
  }
  const end = start + body.readUInt32BE(magic.length);
  return end > body.length ? undefined : body.subarray(start, end).toString("latin1");
}

/**
 * The private key the server logs in to the SFTP machine of the off-server copies with: the file
 * {@link OFFSITE_SFTP_KEY_VAR} names on this computer, without a passphrase (the server uses it
 * unattended). Returned as `key_pem` takes it, on one line with its line ends written `\n`, and
 * registered with the redactor, line by line too. OpsCrew never logs in there with it to change
 * anything: the user puts its public half in the account's `authorized_keys`.
 * @throws OpsCrewError `CREDENTIALS_MISSING` without the variable, `INVALID_INPUT` for a file that
 * can't be read, holds no private key, or has a passphrase.
 */
export async function requireOffsiteSftpKey(
  deps: Pick<PhaseDeps, "env" | "redactor">,
  plan: DeployPlan,
  options: { command: string; already?: string },
): Promise<{ sshKey: string }> {
  const offsite = snapshotOffsiteOf(plan);
  if (offsite?.provider !== "sftp") throw new Error("The plan has no off-server copy over SFTP.");
  const already = options.already ?? "Nothing was changed.";
  const file = deps.env[OFFSITE_SFTP_KEY_VAR]?.trim() ?? "";
  const account = `${offsite.user} on ${offsite.host}`;
  if (file === "") {
    throw new OpsCrewError(
      "CREDENTIALS_MISSING",
      `The off-server copies go to ${account} over SFTP, and the server needs a private key to log in there: ${OFFSITE_SFTP_KEY_VAR} names none. ${already}`,
      {
        hint: `Make a key of its own without a passphrase (\`ssh-keygen -t ed25519 -N "" -f ~/.ssh/opscrew-backups\`), add its public half (the .pub file) to ~/.ssh/authorized_keys of ${offsite.user} on the machine, set ${OFFSITE_SFTP_KEY_VAR} to the private key's path, then run \`${options.command}\` again.`,
      },
    );
  }
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `OpsCrew could not read the private key file ${OFFSITE_SFTP_KEY_VAR} names (${file}). ${already}`,
      {
        hint: `Set ${OFFSITE_SFTP_KEY_VAR} to the key file's full path, then run \`${options.command}\` again.`,
      },
    );
  }
  const refuse = (why: string) =>
    new OpsCrewError(
      "INVALID_INPUT",
      `The file ${OFFSITE_SFTP_KEY_VAR} names (${file}) ${why}. ${already}`,
      {
        hint: `Make a key of its own without a passphrase (\`ssh-keygen -t ed25519 -N "" -f ~/.ssh/opscrew-backups\`), add its .pub file to ~/.ssh/authorized_keys of ${offsite.user} on the machine, set ${OFFSITE_SFTP_KEY_VAR} to it, then run \`${options.command}\` again.`,
      },
    );
  // An OpenSSH key names its cipher (`none` without a passphrase); a PEM key says ENCRYPTED.
  const cipher = text.includes("BEGIN OPENSSH PRIVATE KEY") ? opensshCipher(text) : "none";
  if (!PRIVATE_KEY.test(text) || cipher === undefined) throw refuse("holds no SSH private key");
  const lines = text.trim().split(/\r?\n/);
  for (const line of lines) {
    if (line.length >= 16 && !line.startsWith("-----")) deps.redactor.addLiteral(line, "sftp-key");
  }
  const sshKey = lines.join("\\n");
  deps.redactor.addLiteral(sshKey, "sftp-key");
  if (/ENCRYPTED/.test(text) || cipher !== "none") {
    throw refuse("is protected by a passphrase, and the server uses the key unattended");
  }
  return { sshKey };
}

/**
 * The login the off-server copies upload with: a bucket's key, or an SFTP machine's private key
 * on one line ({@link requireOffsiteSftpKey}).
 */
export type OffsiteLogin = StorageLogin | { sshKey: string };

/** The bucket's key of an off-server copy's login, or undefined for an SFTP machine's (or none). */
export function bucketKeyOf(login: OffsiteLogin | undefined): StorageLogin | undefined {
  return login === undefined || "sshKey" in login ? undefined : login;
}

/**
 * The login of the off-server copies (`snapshots.offsite`): the private key for an SFTP machine
 * ({@link requireOffsiteSftpKey}), else the bucket's key ({@link requireOffsiteKey}).
 */
export function requireOffsiteLogin(
  deps: PhaseDeps,
  plan: DeployPlan,
  services: Pick<ProvisionServices, "askStorageKey">,
  options: { command: string; already?: string },
): Promise<OffsiteLogin> {
  return snapshotOffsiteOf(plan)?.provider === "sftp"
    ? requireOffsiteSftpKey(deps, plan, options)
    : requireOffsiteKey(deps, plan, services, options);
}

/**
 * The key of `bucket`: from `vars` when they are set (never saved), else the kept one, else asked
 * once with the console steps for a key named `opscrew-<keyName>` and kept (with its `account`).
 */
async function bucketKey(
  deps: PhaseDeps,
  services: Pick<ProvisionServices, "askStorageKey">,
  options: { command: string; already?: string; asks?: boolean },
  what: KeyedBucket & { vars: KeyVars; noun: string; keyName: string },
): Promise<StorageLogin> {
  const { bucket, vars, noun, account } = what;
  const name = keyedStorageName(bucket);
  let key = keyFromEnv(deps.env, vars) ?? (await storedKey(deps, what));
  if (key === undefined && deps.interactive && services.askStorageKey !== undefined) {
    deps.reporter.info(
      `${noun} ${bucket.bucket} on ${name} needs a key that you create, so OpsCrew never holds one in infrastructure state.`,
    );
    const answer = await services.askStorageKey({
      provider: name,
      bucket: bucket.bucket,
      steps: KEY_STEPS[bucket.provider](what.keyName, bucket.bucket),
    });
    key = checkedKey(
      { accessKeyId: answer.accessKeyId.trim(), secretAccessKey: answer.secretAccessKey.trim() },
      "The key you entered",
    );
    const others = (await keptKeys(deps)).filter((kept) => !keyOf(kept, what));
    const kept = {
      provider: bucket.provider,
      bucket: bucket.bucket,
      ...(account !== undefined ? { account } : {}),
      ...key,
    };
    await keepKeys(deps, [...others, kept]);
  }
  if (key === undefined) {
    throw new OpsCrewError(
      "CREDENTIALS_MISSING",
      `${noun} ${bucket.bucket} on ${name} needs a key you create in ${bucket.provider === "r2" ? "Cloudflare's dashboard" : "the provider's console"}; OpsCrew never creates one. ${options.already ?? "Nothing was changed."}`,
      {
        hint: keyHint(bucket, what.keyName, options.command, {
          asks: options.asks !== false,
          vars,
        }),
      },
    );
  }
  deps.redactor.addLiteral(key.accessKeyId, "storage-key");
  deps.redactor.addLiteral(key.secretAccessKey, "storage-key");
  return key;
}

/**
 * What OpsCrew knows of the object storage that holds the environment's bucket at Contabo: its id,
 * so a storage Contabo no longer lists is noticed. Without `storageId`, an order OpsCrew sent and
 * whose outcome it does not know: it may still be under way, so no second one is offered.
 */
const OrderedStorageRecordSchema = z.object({
  provider: z.literal("contabo"),
  region: z.string(),
  storageId: z.string().optional(),
  at: z.string(),
});
type OrderedStorageRecord = z.infer<typeof OrderedStorageRecordSchema>;

/** Where {@link OrderedStorageRecord} is kept, beside the environment's other private files. */
export function orderedStorageFile(paths: Pick<ProjectPaths, "projectHomeDir">): string {
  return join(paths.projectHomeDir, "object-storage.json");
}

/** The environment's {@link OrderedStorageRecord}, or undefined; a damaged one stops. */
async function readOrderedStorage(
  deps: Pick<PhaseDeps, "paths">,
): Promise<OrderedStorageRecord | undefined> {
  const file = orderedStorageFile(deps.paths);
  return readRecord(
    file,
    OrderedStorageRecordSchema,
    () =>
      new OpsCrewError(
        "ARTIFACT_INVALID",
        `OpsCrew's note of the app's object storage (${file}) is damaged, so OpsCrew stopped. Nothing was changed.`,
        {
          hint: "Check in Contabo's Customer Control Panel which object storage holds the app's bucket, delete that file, then run the command again.",
        },
      ),
  );
}

async function writeOrderedStorage(
  deps: PhaseDeps,
  record: Omit<OrderedStorageRecord, "provider" | "at">,
) {
  const at = deps.clock.now().toISOString();
  await writeRecord(orderedStorageFile(deps.paths), { provider: "contabo", ...record, at });
}

/**
 * Contabo's object storage API: the run's (tests), else its connector's.
 * @throws OpsCrewError `CREDENTIALS_MISSING` when Contabo's credentials are not set.
 */
function orderedStorageApi(
  deps: Pick<PhaseDeps, "env" | "fetch" | "redactor" | "version">,
  services: Pick<ProvisionServices, "objectStorage">,
): ObjectStorageApi {
  const api = services.objectStorage ?? vpsConnector("contabo", deps).objectStorage;
  if (api !== undefined) return api;
  throw credentialsMissing("contabo");
}

/** Where the bucket's storage is, in words: `Contabo Object Storage in EU`. */
function storageWords(bucket: Pick<ProviderBucket, "provider" | "region">): string {
  return `${STORAGE_NAMES[bucket.provider]} in ${bucket.region}`;
}

/**
 * The account's storage in the bucket's region (Contabo sells one per region), whoever ordered
 * it, recorded by its id; undefined when there is none and nothing is under way.
 * @throws OpsCrewError `PHASE_PRECONDITION` when the recorded storage is no longer listed, or an
 * order OpsCrew sent may still be under way: never a second order then.
 */
async function knownStorage(
  deps: PhaseDeps,
  bucket: Bucket,
  api: ObjectStorageApi,
  command: string,
): Promise<ProviderObjectStorage | undefined> {
  const record = await readOrderedStorage(deps);
  const mine = record?.region === bucket.region ? record : undefined;
  const found = await api.find(bucket.region);
  const file = orderedStorageFile(deps.paths);
  if (found === undefined) {
    if (mine === undefined) return undefined;
    if (mine.storageId === undefined) {
      throw new OpsCrewError(
        "PHASE_PRECONDITION",
        `An order of ${storageWords(bucket)} that OpsCrew sent got no clear answer, and Contabo lists no storage there yet: the order may still be in progress. Nothing was changed.`,
        {
          hint: `Check Object Storage in Contabo's Customer Control Panel, then run \`${command}\` again. If the panel shows no storage and no order there, delete ${file} first: OpsCrew then plans a new order.`,
        },
      );
    }
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `Contabo no longer lists the ${storageWords(bucket)} that holds the app's bucket (${mine.storageId}). Nothing was changed.`,
      {
        hint: `Check Object Storage in Contabo's Customer Control Panel. If the storage is gone, delete ${file} and run \`${command}\` again: OpsCrew then plans a new one.`,
      },
    );
  }
  if (mine?.storageId !== found.id) {
    await writeOrderedStorage(deps, { region: bucket.region, storageId: found.id });
    deps.reporter.info(`The app's bucket goes into the ${storageWords(bucket)} (${found.id}).`);
  }
  return found;
}

/**
 * The storage's key, read through the provider's API and registered with the redactor, with the
 * storage's S3 endpoint.
 */
async function storageKeyOf(
  deps: PhaseDeps,
  api: ObjectStorageApi,
  storage: ProviderObjectStorage,
): Promise<StorageLogin> {
  const key = await api.key(storage.id);
  deps.redactor.addLiteral(key.accessKeyId, "storage-key");
  deps.redactor.addLiteral(key.secretAccessKey, "storage-key");
  return {
    accessKeyId: key.accessKeyId,
    secretAccessKey: key.secretAccessKey,
    endpoint: storage.s3Url,
  };
}

/**
 * The key of a bucket in Contabo's storage with the storage's S3 endpoint, once the storage
 * exists: the key Contabo made with it, read through Contabo's API (never asked, kept in a file or
 * printed). A storage whose cancellation the user asked for still answers until it ends, so its
 * key is read too.
 * @throws OpsCrewError `PHASE_PRECONDITION` when the storage is not ordered yet.
 */
export async function orderedStorageKey(
  deps: PhaseDeps,
  bucket: Bucket,
  services: Pick<ProvisionServices, "objectStorage">,
  options: { command: string; already?: string },
): Promise<StorageLogin> {
  const api = orderedStorageApi(deps, services);
  const storage = await knownStorage(deps, bucket, api, options.command);
  if (storage === undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `The app's bucket ${bucket.bucket} needs ${storageWords(bucket)}, and there is none yet. ${options.already ?? "Nothing was changed."}`,
      { hint: "Run `opscrew provision`: it plans the storage's order for you to approve." },
    );
  }
  return storageKeyOf(deps, api, storage);
}

/**
 * The line said after `--delete-data` deleted a bucket in Contabo's storage: the storage stays,
 * since other buckets may use it, and the user cancels it when nothing does. Undefined for every
 * other bucket.
 */
export async function orderedStorageStays(
  deps: Pick<PhaseDeps, "paths">,
  bucket: Pick<ProviderBucket, "provider" | "region">,
): Promise<string | undefined> {
  if (bucket.provider !== "contabo") return undefined;
  const id = (await readOrderedStorage(deps))?.storageId;
  return `${STORAGE_NAMES.contabo}${id === undefined ? "" : ` ${id}`} in ${bucket.region} stays and is billed monthly, as other buckets may use it; when nothing uses it, cancel it in Contabo's Customer Control Panel.`;
}

/** The plan that orders the object storage, whose SHA-256 its approval binds. */
interface StorageOrderPlan {
  kind: "object-storage-order";
  provider: "contabo";
  region: string;
  sizeTb: number;
  displayName: string;
  price: ProviderBucket["price"];
}

/** Where an order plan is saved, so a later run's `--approve` knows its hash. */
export function storageOrderPlanFile(paths: Pick<ProjectPaths, "files">, hash: string): string {
  return join(paths.files.plansDir, `object-storage-${hash.toLowerCase()}.json`);
}

/** The order plan in plain English, with its hash: shown before the approval. */
function orderPlanText(plan: StorageOrderPlan, hash: string): string[] {
  const price = formatMoney({ amount: plan.price.monthly, currency: plan.price.currency });
  return [
    `Object storage plan: order ${STORAGE_NAMES.contabo} in ${plan.region} through Contabo's API, named ${plan.displayName}.`,
    `  + ${plan.sizeTb * 1000} GB, from ${price}/month with free transfer (${plan.price.source}, checked ${plan.price.checkedOn}); a larger size costs what Contabo charges.`,
    "  Contabo sells one storage per region: every bucket of your account in this region goes into it.",
    "  Contabo bills it monthly, and OpsCrew never cancels it, as other buckets may use it: when nothing uses it, cancel it in Contabo's Customer Control Panel.",
    "  Its S3 key is made by Contabo with it: OpsCrew reads it through Contabo's API and gives it to the app as a secret, never printing or storing it.",
    `Order plan hash: ${hash}`,
  ];
}

/** What {@link prepareOrderedStorage} found or did: the key (with the endpoint), or the plan. */
export type OrderedStorage =
  | { key: StorageLogin }
  | {
      /** The order plan's hash, for `--approve`: nothing was ordered. */
      orderPlanHash: string;
    };

/**
 * Before the `storage` root of a bucket in Contabo's storage: the storage it goes into. The
 * account's storage in the bucket's region, whoever ordered it (Contabo sells one per region),
 * else a new one, ordered through Contabo's API after its plan (region, size, price, that OpsCrew
 * never cancels it) is shown and approved by its SHA-256 (`iac-apply`). A storage whose
 * cancellation the user asked for stops here: the bucket would go with it. Before the order, a
 * record notes it, so an order whose outcome is unknown is never sent twice; Contabo's refusal
 * (nothing was ordered) removes it. With `planOnly`, the plan is shown and saved, and its hash
 * returned for `--approve`: nothing is ordered. Returns the key Contabo made with the storage
 * (read through its API, registered with the redactor) and its S3 endpoint once it exists.
 * @throws OpsCrewError `APPROVAL_REFUSED` when the order is not approved: nothing was ordered.
 */
export async function prepareOrderedStorage(
  deps: PhaseDeps,
  plan: DeployPlan,
  services: Pick<ProvisionServices, "objectStorage">,
  options: { command: string; phase: PhaseName; planOnly?: boolean | undefined },
): Promise<OrderedStorage> {
  const bucket = providerBucket(plan);
  if (bucket?.provider !== "contabo") throw new Error("The plan has no bucket at Contabo.");
  const api = orderedStorageApi(deps, services);
  const known = await knownStorage(deps, bucket, api, options.command);
  if (known?.cancelledUntil !== undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `Your ${storageWords(bucket)} (${known.id}) is cancelled and ends on ${known.cancelledUntil}, and Contabo sells one storage per region, so OpsCrew can neither use it nor order another. Nothing was changed.`,
      {
        hint: `Revoke the cancellation in Contabo's Customer Control Panel (Object Storage), then run \`${options.command}\` again.`,
      },
    );
  }
  if (known !== undefined) return { key: await storageKeyOf(deps, api, known) };
  const order: StorageOrderPlan = {
    kind: "object-storage-order",
    provider: "contabo",
    region: bucket.region,
    sizeTb: CONTABO_STORAGE_GB / 1000,
    displayName: `opscrew-${plan.app.name}`,
    price: bucket.price,
  };
  const hash = sha256Hex(canonicalJson(order));
  const text = orderPlanText(order, hash);
  const file = storageOrderPlanFile(deps.paths, hash);
  await mkdir(dirname(file), { recursive: true });
  await writeFileAtomic(file, `${canonicalJson(order)}\n`);
  if (options.planOnly) {
    for (const line of text) deps.reporter.info(line);
    return { orderPlanHash: hash };
  }
  const approval = await deps.approvals.request({
    kind: "iac-apply",
    title: `Order ${storageWords(bucket)} for the app's bucket ${bucket.bucket}`,
    details: text.join("\n"),
    planHash: hash,
    costDelta: { amount: bucket.price.monthly, currency: bucket.price.currency },
  });
  if (!approval.approved) {
    throw new OpsCrewError(
      "APPROVAL_REFUSED",
      `The order of ${storageWords(bucket)} was not approved${approval.reason ? ` (${approval.reason})` : ""}. Nothing was ordered.`,
      {
        hint: `Run \`${options.command}\` again to review it, or approve it with --approve ${hash}.`,
      },
    );
  }
  await deps.approvals.assertApprovedPlan(hash);
  await writeOrderedStorage(deps, { region: bucket.region });
  deps.reporter.step(`Ordering ${storageWords(bucket)} (Contabo makes it ready in a few minutes)`);
  const answer = await api.order({
    region: order.region,
    sizeTb: order.sizeTb,
    displayName: order.displayName,
  });
  if ("refused" in answer) {
    await rm(orderedStorageFile(deps.paths), { force: true });
    throw new OpsCrewError(
      "PROVIDER_ERROR",
      `Contabo refused the order of ${storageWords(bucket)}, so nothing was ordered: ${deps.redactor.redact(answer.refused)}`,
      { hint: `Fix what Contabo named, then run \`${options.command}\` again.` },
    );
  }
  const storage = answer.ordered;
  await writeOrderedStorage(deps, { region: bucket.region, storageId: storage.id });
  await deps.audit.append({
    kind: "provider-call",
    actor: "opscrew",
    action: "order object storage",
    phase: options.phase,
    target: `contabo object storage ${storage.id}`,
    detail: `${bucket.region}, ${order.sizeTb} TB`,
  });
  deps.reporter.success(`Ordered ${storageWords(bucket)} (${storage.id}).`);
  return { key: await storageKeyOf(deps, api, storage) };
}

/**
 * Stops before any change when the plan's bucket is on R2 but the plan has no domain on
 * Cloudflare: R2 needs OpsCrew's Cloudflare token and account.
 */
export function requireR2Cloudflare(plan: DeployPlan, cloudflare: CloudflareSetup | undefined) {
  if (cloudflare !== undefined) return;
  if (providerBucket(plan)?.provider === "r2") {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      "opscrew/plan.yaml keeps the app's files on Cloudflare R2, but the app has no domain on Cloudflare, so OpsCrew has no Cloudflare account to create the bucket in. Nothing was changed.",
      {
        hint: "Give the app a domain on Cloudflare (`opscrew dns --domain <hostname>`), or run `opscrew design` again for another storage option, then run the command again.",
      },
    );
  }
  if (snapshotOffsiteOf(plan)?.provider === "r2") {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      "opscrew/plan.yaml keeps the off-server copies of the app's snapshots on Cloudflare R2, but the app has no domain on Cloudflare, so OpsCrew has no Cloudflare account to create their bucket in. Nothing was changed.",
      {
        hint: "Give the app a domain on Cloudflare (`opscrew dns --domain <hostname>`), or keep the copies at Hetzner or DigitalOcean (`opscrew snapshot offsite on --to hetzner --region <region>`), then run the command again.",
      },
    );
  }
}

/**
 * What the app receives besides `key`: R2's endpoint, from the zone's Cloudflare account; a
 * bucket in Contabo's storage has its storage's endpoint in `key`.
 */
export function storageLogin(
  plan: DeployPlan,
  key: StorageLogin,
  cloudflare: Pick<CloudflareSetup, "accountId"> | undefined,
): StorageLogin {
  if (providerBucket(plan)?.provider !== "r2" || cloudflare === undefined) return { ...key };
  return { ...key, endpoint: r2Endpoint(cloudflare.accountId) };
}

/**
 * The engine's environment for the `storage` root. For Spaces and Hetzner the `aws` provider
 * reads the user's key from `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`, never a `TF_VAR_`
 * (the saved plan would keep it); every other `AWS_*` variable is left out and the AWS config and
 * credentials files point at the null device, so the user's own AWS login (a session token, a
 * profile, a role) is never used. In a move that takes the bucket along, `previousKeyFile` is the
 * credentials file the `aws.previous` provider reads the key of the bucket being left from
 * ({@link withPreviousBucketKey}). R2 uses the Cloudflare token as the other roots do.
 */
export function storageEngineEnv(
  env: Record<string, string | undefined>,
  plan: DeployPlan,
  key: StorageLogin | undefined,
  previousKeyFile?: string,
): Record<string, string | undefined> {
  if (providerBucket(plan)?.provider === "r2") return { ...env };
  return s3EngineEnv(env, key, previousKeyFile);
}

/**
 * The engine's environment for the `backups` root, as {@link storageEngineEnv} for the `storage`
 * root, with the off-server copies' bucket's own key ({@link requireOffsiteKey}).
 */
export function backupsEngineEnv(
  env: Record<string, string | undefined>,
  plan: DeployPlan,
  key: StorageLogin | undefined,
): Record<string, string | undefined> {
  if (snapshotOffsiteOf(plan)?.provider === "r2") return { ...env };
  return s3EngineEnv(env, key);
}

/**
 * `env` without `AWS_*`, with `key` for the `aws` provider and no AWS files but `credentials`;
 * a Contabo storage's endpoint, which comes with its key, as `TF_VAR_endpoint`.
 */
function s3EngineEnv(
  env: Record<string, string | undefined>,
  key: StorageLogin | undefined,
  credentials?: string,
): Record<string, string | undefined> {
  const out = Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith("AWS_")));
  if (key === undefined) throw new Error("The aws provider needs the bucket's key.");
  return {
    ...out,
    AWS_ACCESS_KEY_ID: key.accessKeyId,
    AWS_SECRET_ACCESS_KEY: key.secretAccessKey,
    AWS_CONFIG_FILE: devNull,
    AWS_SHARED_CREDENTIALS_FILE: credentials ?? devNull,
    ...(key.endpoint !== undefined ? { TF_VAR_endpoint: key.endpoint } : {}),
  };
}

/**
 * The values of the off-server copy's variables (`PORTAINER_OFFSITE_VARIABLES`, by name, only the
 * ones the copy has: `offsiteVariables`): a bucket's S3 endpoint (R2's from the zone's Cloudflare
 * account, the user's own bucket's from the plan) and key, or an SFTP machine's private key on one
 * line, and the age recipient the copies are encrypted to; the rest of rclone's settings is the
 * plan's. Portainer's stack holds them as variables; a server as `OFFSITE_ENV_FILE`
 * ({@link offsiteEnvFile}).
 */
export function offsiteValues(
  plan: DeployPlan,
  input: {
    login: OffsiteLogin;
    recipient: string;
    cloudflare: Pick<CloudflareSetup, "accountId"> | undefined;
  },
): Record<string, string> {
  const offsite = snapshotOffsiteOf(plan);
  if (offsite === undefined) throw new Error("The plan has no off-server copy.");
  const v = PORTAINER_OFFSITE_VARIABLES;
  const { login } = input;
  if (offsite.provider === "sftp" || "sshKey" in login) {
    if (!("sshKey" in login)) throw new Error("An SFTP machine needs its private key.");
    return { [v.sshKey]: login.sshKey, [v.recipient]: input.recipient };
  }
  let endpoint: string;
  if (offsite.provider === "r2") {
    if (input.cloudflare === undefined) throw new Error("R2 needs the Cloudflare account.");
    endpoint = r2Endpoint(input.cloudflare.accountId);
  } else if (offsite.provider === "s3") {
    endpoint = offsite.endpoint;
  } else {
    const at = STORAGE_ENDPOINTS[offsite.provider];
    if (at === undefined) throw new Error(`No S3 endpoint is known for ${offsite.provider}.`);
    endpoint = at(offsite.region);
  }
  return {
    [v.endpoint]: endpoint,
    [v.accessKeyId]: login.accessKeyId,
    [v.secretAccessKey]: login.secretAccessKey,
    [v.recipient]: input.recipient,
  };
}

/** What the recovery copy's first age key needs (`ProvisionOptions.recovery`). */
type RecoveryAnswers = Pick<RefreshRecoveryOptions, "recipient" | "keyOut" | "backup">;

/** The plain stop when the off-server copies have no age key to be encrypted to. */
function noAgeKey(command: string, already: string): OpsCrewError {
  return new OpsCrewError(
    "PHASE_PRECONDITION",
    `The off-server copies of the app's snapshots are encrypted to the age key of its recovery copy, and there is none yet. ${already}`,
    {
      hint: `Run \`${command}\` in a terminal, which asks for a file to write your new age key to or for your own age key (age1…), or name the file with \`--key-out <path>\`.`,
    },
  );
}

/**
 * Before any change of a run with `snapshots.offsite` (D16): the age key the off-server copies
 * are encrypted to exists (`knownRecipients`), or this run can make it, from the user's own
 * recipient or a file for a new key, asked now. The answers come back kept, for the recovery copy
 * this run makes, so nothing is asked twice; without the copy `recovery` comes back as it is.
 * @throws OpsCrewError `PHASE_PRECONDITION` when neither gives one: nothing was changed.
 */
export async function requireOffsiteRecipient(
  deps: Pick<PhaseDeps, "paths">,
  plan: DeployPlan,
  recovery: RecoveryAnswers | undefined,
  command: string,
): Promise<RecoveryAnswers | undefined> {
  if (snapshotOffsiteOf(plan) === undefined) return recovery;
  if ((await knownRecipients(deps.paths))?.[0] !== undefined) return recovery;
  const own = await recovery?.recipient?.();
  const keyOut = own === undefined ? await recovery?.keyOut?.() : undefined;
  if (own === undefined && keyOut === undefined) {
    throw noAgeKey(command, "Nothing was changed.");
  }
  return { ...recovery, recipient: async () => own, keyOut: async () => keyOut };
}

/**
 * Before any change of a run with `snapshots.offsite` (024 plan.md 7., D16): the copies' login
 * ({@link requireOffsiteLogin}: a Hetzner, Spaces or own bucket's key, or an SFTP machine's private
 * key; R2's comes after its bucket), and, unless the run only plans, the age key they are encrypted to ({@link requireOffsiteRecipient}).
 */
export async function offsitePreflight(
  deps: PhaseDeps,
  plan: DeployPlan,
  services: Pick<ProvisionServices, "askStorageKey">,
  options: {
    command: string;
    planOnly?: boolean | undefined;
    recovery?: RecoveryAnswers | undefined;
  },
): Promise<{ key?: OffsiteLogin; recovery?: RecoveryAnswers }> {
  const { command } = options;
  const offsite = snapshotOffsiteOf(plan);
  const key =
    offsite !== undefined && offsite.provider !== "r2"
      ? await requireOffsiteLogin(deps, plan, services, { command })
      : undefined;
  const recovery = options.planOnly
    ? options.recovery
    : await requireOffsiteRecipient(deps, plan, options.recovery, command);
  return {
    ...(key === undefined ? {} : { key }),
    ...(recovery === undefined ? {} : { recovery }),
  };
}

/**
 * {@link offsiteValues} for the deploy secrets or the stack, when `snapshots.offsite` is on: the
 * bucket's key (`key`, read before the bucket at Hetzner and Spaces; R2's, a token limited to the
 * bucket, asked now that it exists) and the first recipient of the recovery copy
 * (`knownRecipients`). When there is none yet (the first provision) and `github` is given, the
 * recovery copy is brought up to date now, which makes its age key (D11), and is returned for the
 * pull request ({@link RecoveryCopy}, which holds no private key).
 * @throws OpsCrewError `PHASE_PRECONDITION` when there is still no age key: the copies could not
 * be encrypted, so nothing that holds the bucket's key is stored.
 */
export async function offsiteSetup(
  deps: PhaseDeps,
  plan: DeployPlan,
  services: Pick<ProvisionServices, "askStorageKey">,
  input: {
    /** Where the recovery copy goes, when this run may make it. */
    github?: GitHubSetup;
    recovery?: RecoveryAnswers;
    key: OffsiteLogin | undefined;
    cloudflare: Pick<CloudflareSetup, "accountId"> | undefined;
    command: string;
    /** What is done already, said when it stops. */
    already: string;
  },
): Promise<{ values: Record<string, string>; recoveryCopy?: RecoveryCopy }> {
  let recipient = (await knownRecipients(deps.paths))?.[0];
  let recoveryCopy: RecoveryCopy | undefined;
  if (recipient === undefined && input.github !== undefined) {
    recoveryCopy = await recoveryCopyFiles(deps, {
      github: input.github,
      plan,
      ...(input.recovery !== undefined ? { recovery: input.recovery } : {}),
    });
    recipient = recoveryCopy.recipients?.[0];
  }
  if (recipient === undefined) {
    throw noAgeKey(
      input.command,
      `OpsCrew stored nothing that holds their ${snapshotOffsiteOf(plan)?.provider === "sftp" ? "machine's" : "bucket's"} key. ${input.already}`,
    );
  }
  const login =
    input.key ??
    (await requireOffsiteLogin(deps, plan, services, {
      command: input.command,
      already: input.already,
    }));
  return {
    values: offsiteValues(plan, { login, recipient, cloudflare: input.cloudflare }),
    ...(recoveryCopy !== undefined ? { recoveryCopy } : {}),
  };
}

/** {@link offsiteValues} as the lines of the server's `offsite.env`, which `docker --env-file` reads. */
export function offsiteEnvFile(values: Record<string, string>): string {
  return `${Object.entries(values)
    .map(([name, value]) => `${name}=${value}`)
    .join("\n")}\n`;
}

/**
 * Where the `aws.previous` provider of a move's `storage` root reads the key of the bucket being
 * left: a private file in OpsCrew's folder of the project, there only while the engine runs.
 */
export function previousBucketKeyFile(paths: Pick<ProjectPaths, "stateDir">): string {
  return join(paths.stateDir, "storage-previous.credentials");
}

/**
 * Runs `act` while {@link previousBucketKeyFile} holds `key` under the `PREVIOUS_BUCKET_PROFILE`
 * profile (mode 0600), and removes the file afterwards, whatever happened: the key never reaches
 * a rendered file, a plan or the state.
 */
export async function withPreviousBucketKey<T>(
  deps: Pick<PhaseDeps, "paths">,
  key: StorageLogin,
  act: (file: string) => Promise<T>,
): Promise<T> {
  const file = previousBucketKeyFile(deps.paths);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const profile = [
    `[${PREVIOUS_BUCKET_PROFILE}]`,
    `aws_access_key_id = ${key.accessKeyId}`,
    `aws_secret_access_key = ${key.secretAccessKey}`,
  ];
  await writeFileAtomic(file, `${profile.join("\n")}\n`, { mode: 0o600 });
  try {
    return await act(file);
  } finally {
    await rm(file, { force: true });
  }
}

/** The bucket's resource at Hetzner and Spaces, in the `storage` and the `backups` root. */
const S3_BUCKET = "aws_s3_bucket.this";

/**
 * The `aws` provider's read of the bucket right after creating it, which a Hetzner (or Spaces)
 * node can answer before it knows the new bucket. The engine then keeps the bucket tainted, or,
 * when the provider returned no state for it, does not record it at all.
 */
const BUCKET_SHOWN_LATE = /Error: reading S3 Bucket \([^)]*\): couldn't find resource/;

/** The engine's words for an import of a bucket the provider cannot read (yet). */
const NOT_READABLE = /Cannot import non-existent remote object|couldn't find resource/;

/** How many times, and how far apart, a bucket the provider cannot read yet is imported: a minute. */
const IMPORT_TRIES = 7;
const IMPORT_INTERVAL_MS = 10_000;

/**
 * Where OpsCrew notes the bucket a `storage` apply sets out to create, beside the key, until the
 * bucket is in the state. Only a bucket it names is ever taken into the state by an import.
 */
export function storageCreateFile(paths: Pick<ProjectPaths, "projectHomeDir">): string {
  return join(paths.projectHomeDir, "storage-create.json");
}

/** File name ending of a saved plan of the `backups` root. */
export const BACKUPS_PLAN_SUFFIX = "-backups.tfplan";

/** The `backups` root's marker, as {@link storageCreateFile} is the `storage` root's. */
export function backupsCreateFile(paths: Pick<ProjectPaths, "projectHomeDir">): string {
  return join(paths.projectHomeDir, "backups-create.json");
}

const CreateMarkerSchema = z.object({
  provider: z.enum(["r2", "digitalocean", "hetzner", "contabo"]),
  bucket: z.string(),
  region: z.string(),
  planHash: z.string(),
  createdAt: z.string(),
});

/** A root of one bucket at a provider, as {@link applyBucketRoot} applies it. */
interface BucketRoot {
  bucket: Bucket;
  /** The bucket in a sentence, after "the": "app's bucket". */
  noun: string;
  /** The root's folder in the repository. */
  dir: string;
  statePath: string;
  planSuffix: string;
  /** What a refused approval calls its plan. */
  planNoun: string;
  /** Its create marker ({@link storageCreateFile}). */
  markerFile: string;
  /** The plan's field that names the bucket. */
  field: string;
  /** The variables its key is read from. */
  vars: KeyVars;
  /** What the rest of a plan after a stop adds, in the hint: "such as the bucket's CORS rule". */
  rest: string;
  /** The bucket's monthly price, which its plan's summary and approval show. */
  price: PlanPrice;
}

/** True when the marker names `bucket` (provider, region and name); a missing or damaged one names none. */
async function markerNames(root: BucketRoot): Promise<boolean> {
  const text = await readTextIfExists(root.markerFile);
  if (text === undefined) return false;
  let marker: z.infer<typeof CreateMarkerSchema>;
  try {
    marker = CreateMarkerSchema.parse(JSON.parse(text));
  } catch {
    return false;
  }
  const { bucket } = root;
  return (
    marker.provider === bucket.provider &&
    marker.region === bucket.region &&
    marker.bucket === bucket.bucket
  );
}

/** Notes that the apply of `planHash` sets out to create the root's bucket. */
function writeMarker(deps: PhaseDeps, root: BucketRoot, planHash: string) {
  return writeRecord(root.markerFile, {
    provider: root.bucket.provider,
    bucket: root.bucket.bucket,
    region: root.bucket.region,
    planHash,
    createdAt: deps.clock.now().toISOString(),
  });
}

const removeMarker = (root: BucketRoot) => rm(root.markerFile, { force: true });

/** What a failed apply of a bucket root at Hetzner or Spaces needs to keep the bucket. */
interface FailedBucketApply {
  engine: IacEngine;
  root: BucketRoot;
  /** The root's folder on this computer. */
  dir: string;
  env: Record<string, string | undefined>;
  command: string;
  sleep: (ms: number) => Promise<void>;
  /** True when an earlier run's apply set out to create this bucket (its marker was there). */
  createdEarlier: boolean;
}

/** True when the bucket answers HEAD with the user's key (200); any other answer is not ours. */
async function answersToKey(deps: PhaseDeps, bucket: Bucket, key: StorageLogin) {
  const client = storageS3Client(bucket, key, { fetch: deps.fetch, now: () => deps.clock.now() });
  try {
    return await client.headBucket();
  } catch (error) {
    if (error instanceof OpsCrewError) return false;
    throw error;
  }
}

/**
 * Records the existing bucket in the root's state (`import`, state only), trying again every 10 s
 * for about a minute while the provider cannot read it yet. False when it never could.
 */
async function importBucket(deps: PhaseDeps, failed: FailedBucketApply): Promise<boolean> {
  const { engine, dir, env } = failed;
  const { bucket } = failed.root;
  deps.reporter.step(
    `Recording the bucket ${bucket.bucket} in the bucket's state (nothing changes on ${STORAGE_NAMES[bucket.provider]})`,
  );
  for (let attempt = 1; ; attempt++) {
    try {
      await engine.importResource(dir, S3_BUCKET, bucket.bucket, { env });
      return true;
    } catch (error) {
      if (!(error instanceof OpsCrewError) || !NOT_READABLE.test(error.message)) throw error;
      if (attempt === IMPORT_TRIES) return false;
    }
    await failed.sleep(IMPORT_INTERVAL_MS);
  }
}

/**
 * Keeps a new bucket the provider showed late: untainted when the failed create recorded it
 * (state only), else imported ({@link importBucket}) when the marker names it. False when it could
 * not be imported; undefined without the marker (nothing is taken into the state).
 */
async function keepLateBucket(
  deps: PhaseDeps,
  failed: FailedBucketApply,
): Promise<boolean | undefined> {
  const state = failed.root.statePath;
  const recorded =
    (await exists(state)) &&
    (await failed.engine.stateResources(state, { env: failed.env })).includes(S3_BUCKET);
  if (recorded) {
    await failed.engine.untaint(failed.dir, S3_BUCKET, { env: failed.env });
    return true;
  }
  if (!(await markerNames(failed.root))) return undefined;
  return importBucket(deps, failed);
}

/**
 * A stop instead of the engine's words, for what an apply of a bucket root reports. At Hetzner and
 * Spaces (with `key`), a bucket this project set out to create (its marker,
 * {@link storageCreateFile}) is kept: a new bucket shown late, and a taken name whose bucket
 * answers to the user's key and that an earlier run set out to create. A bucket of the user's that
 * OpsCrew did not create for this app is never taken over. Keeping one only changes the root's
 * state, and removes the marker; what is left is planned and approved in the next run.
 */
async function bucketFailure(
  deps: PhaseDeps,
  log: string,
  failed: FailedBucketApply,
  key: StorageLogin | undefined,
): Promise<OpsCrewError | undefined> {
  const { root, command } = failed;
  const { bucket, vars } = root;
  const name = STORAGE_NAMES[bucket.provider];
  const s3Key = bucket.provider === "r2" ? undefined : key;
  const rerun = `Run \`${command}\` again: it plans what is left, ${root.rest}, for you to approve as usual.`;
  const notShown = () =>
    new OpsCrewError(
      "PROVIDER_ERROR",
      `${name} did not show the new bucket ${bucket.bucket} within a minute, so OpsCrew could not record it in the bucket's state yet. The bucket exists; nothing else was changed.`,
      {
        hint: `Wait a few minutes, then run \`${command}\` again: OpsCrew then finds the bucket and keeps it.`,
      },
    );
  const rename = `Change ${root.field} in opscrew/plan.yaml to another name (3–63 lower-case letters, digits or hyphens), then run \`${command}\` again.`;
  if (/BucketAlreadyExists|BucketAlreadyOwnedByYou/.test(log)) {
    // This apply created nothing: only an earlier run's marker may name the bucket.
    if (!failed.createdEarlier) await removeMarker(root);
    if (s3Key !== undefined && (await answersToKey(deps, bucket, s3Key))) {
      if (!failed.createdEarlier) {
        return new OpsCrewError(
          "PHASE_PRECONDITION",
          `A bucket called ${bucket.bucket} already exists in your ${name} account, but OpsCrew did not create it for this app, so it will not take it over. Nothing was changed.`,
          { hint: rename },
        );
      }
      if (!(await importBucket(deps, failed))) return notShown();
      await removeMarker(root);
      return new OpsCrewError(
        "PROVIDER_ERROR",
        `${name} says the bucket name ${bucket.bucket} is taken, and the bucket answers to your key: OpsCrew found the bucket from an earlier run and kept it.`,
        { hint: rerun },
      );
    }
    return new OpsCrewError(
      "PHASE_PRECONDITION",
      `${name} says the bucket name ${bucket.bucket} is taken: bucket names there are shared by all its customers (or another bucket of yours has it). Nothing else was changed.`,
      { hint: rename },
    );
  }
  if (s3Key === undefined) return undefined;
  if (/InvalidAccessKeyId|SignatureDoesNotMatch/.test(log)) {
    return new OpsCrewError("CREDENTIALS_INVALID", `${name} refused the bucket's key.`, {
      hint: `Create a new key (\`${command}\` shows the steps when it has none), then set ${vars.accessKeyId} and ${vars.secretAccessKey} to it, or delete OpsCrew's copy of the old one (${storageKeyFile(deps.paths)}) and run \`${command}\` in a terminal to paste the new one.`,
    });
  }
  if (BUCKET_SHOWN_LATE.test(log)) {
    // The bucket exists: kept in the state, the next plan keeps it instead of creating or
    // replacing it (which `prevent_destroy` refuses) and plans what is left, for a new approval.
    const kept = await keepLateBucket(deps, failed);
    if (kept === undefined) return undefined;
    if (!kept) return notShown();
    await removeMarker(root);
    return new OpsCrewError(
      "PROVIDER_ERROR",
      `${name} did not show the new bucket ${bucket.bucket} right away, so the apply stopped. OpsCrew kept the bucket.`,
      { hint: rerun },
    );
  }
  return undefined;
}

/** What {@link applyStorage} and {@link applyBackups} apply a root with. */
interface BucketApplyInput {
  engine: IacEngine;
  env: Record<string, string | undefined>;
  plan: DeployPlan;
  /** The rendered root. */
  files: readonly RenderedFile[];
  key: StorageLogin | undefined;
  approvePlanHash?: string;
  planOnly?: boolean;
  command: string;
  phase: PhaseName;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * The `storage` root (`opscrew/infra/storage`, the bucket and its CORS) through its own plan →
 * policies → approval bound to its hash → apply (FR-1318), with its own state
 * ({@link storageStateFile}); the key reaches the engine only as {@link storageEngineEnv} says.
 * With `approvePlanHash` it applies that saved plan of an earlier `--plan-only` run. A name taken
 * at the provider and a key it refuses stop with what to change. Before the apply, a marker
 * ({@link storageCreateFile}) notes the bucket it sets out to create, removed once the bucket is in
 * the state. A Hetzner or Spaces bucket that exists but is not kept yet (shown late after its
 * create, or left by an earlier run's failed create under a taken name that answers to the user's
 * key) is put into the state only when the marker names it (untaint or import, state only; `sleep`
 * waits between imports), and the run stops, so the next run plans what is left for a new
 * approval. A refused approval says "storage plan".
 */
export function applyStorage(
  deps: PhaseDeps,
  input: BucketApplyInput & {
    /** A move's root: the credentials file with the key of the bucket being left. */
    previousKeyFile?: string;
  },
): Promise<PlanAndApplyResult> {
  const bucket = providerBucket(input.plan);
  if (bucket === undefined) throw new Error("The plan has no bucket at a provider.");
  const root: BucketRoot = {
    bucket,
    noun: "app's bucket",
    dir: storageRootDir(input.plan),
    statePath: storageStateFile(deps.paths),
    planSuffix: STORAGE_PLAN_SUFFIX,
    planNoun: "storage plan",
    markerFile: storageCreateFile(deps.paths),
    field: "storage.objectStorage.bucket",
    vars: STORAGE_KEY_VARS,
    rest: "such as the bucket's CORS rule",
    price: {
      monthly: { amount: bucket.price.monthly, currency: bucket.price.currency },
      source: bucket.price.source,
      checkedOn: bucket.price.checkedOn,
    },
  };
  const env = storageEngineEnv(input.env, input.plan, input.key, input.previousKeyFile);
  return applyBucketRoot(deps, root, { ...input, env });
}

/**
 * The `backups` root (D9: the bucket of the off-server copies, `snapshots.offsite`) as
 * {@link applyStorage} applies the `storage` root: its own plan, approved by its hash, its own
 * state ({@link backupsStateFile}) and marker ({@link backupsCreateFile}), the bucket's own key
 * reaching the engine only as {@link backupsEngineEnv} says. A bucket shown late is kept the same
 * way. The approval names the provider's base monthly price, which the bucket adds at least. A
 * refused approval says "backups plan".
 */
export function applyBackups(
  deps: PhaseDeps,
  input: BucketApplyInput,
): Promise<PlanAndApplyResult> {
  const offsite = backupsBucketOf(input.plan);
  if (offsite === undefined)
    throw new Error("The plan has no bucket of the off-server copies to plan.");
  const base = STORAGE_PRICES[offsite.provider].monthlyPrice({ storageGb: 0, egressGbPerMonth: 0 });
  const root: BucketRoot = {
    bucket: offsite,
    noun: "off-server copies' bucket",
    dir: backupsRootDir(input.plan),
    statePath: backupsStateFile(deps.paths),
    planSuffix: BACKUPS_PLAN_SUFFIX,
    planNoun: "backups plan",
    markerFile: backupsCreateFile(deps.paths),
    field: "snapshots.offsite.bucket",
    vars: OFFSITE_KEY_VARS,
    rest: "such as the bucket's lifecycle rule",
    price: {
      monthly: { amount: base.amount, currency: base.currency },
      source: base.source,
      checkedOn: base.checkedOn,
    },
  };
  const env = backupsEngineEnv(input.env, input.plan, input.key);
  return applyBucketRoot(deps, root, { ...input, env });
}

/** {@link applyStorage}'s steps for `root`, with the engine's environment `input.env`. */
async function applyBucketRoot(
  deps: PhaseDeps,
  root: BucketRoot,
  input: BucketApplyInput,
): Promise<PlanAndApplyResult> {
  const { plan, command } = input;
  const { bucket } = root;
  const name = STORAGE_NAMES[bucket.provider];
  const dir = join(deps.paths.root, root.dir);
  const { env } = input;
  deps.reporter.step(`Planning the ${root.noun} ${bucket.bucket} on ${name}`);
  let failedLog: string | undefined;
  let createdEarlier = false;
  const applied = planAndApply(deps, {
    engine: input.engine,
    dir,
    env,
    deployPlan: plan,
    files: input.files,
    statePath: root.statePath,
    planSuffix: root.planSuffix,
    planNoun: root.planNoun,
    command,
    phase: input.phase,
    approvalTitle: `Apply the plan of the ${root.noun} ${bucket.bucket} on ${name}`,
    price: root.price,
    beforeApply: async (saved) => {
      createdEarlier = await markerNames(root);
      await writeMarker(deps, root, saved.planHash);
    },
    applyFailed: (log) => {
      failedLog = log;
    },
    ...(input.approvePlanHash !== undefined ? { approvePlanHash: input.approvePlanHash } : {}),
    ...(input.planOnly ? { planOnly: true } : {}),
  });
  let result: PlanAndApplyResult;
  try {
    result = await applied;
  } catch (error) {
    if (failedLog === undefined) throw error;
    const failed = {
      engine: input.engine,
      root,
      dir,
      env,
      command,
      sleep: input.sleep ?? realSleep,
      createdEarlier,
    };
    throw (await bucketFailure(deps, failedLog, failed, input.key)) ?? error;
  }
  // The bucket is in the state now.
  if (result.applied) await removeMarker(root);
  return result;
}
