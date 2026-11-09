import { mkdir, rm } from "node:fs/promises";
import { devNull } from "node:os";
import { dirname, join } from "node:path";
import type { IacEngine, PhaseName } from "@opscrew/contracts";
import {
  exists,
  OpsCrewError,
  type ProjectPaths,
  readTextIfExists,
  realSleep,
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
import { type DeployPlan, snapshotOffsiteOf } from "@opscrew/plan-schema";
import { z } from "zod";
import type { PhaseDeps } from "../context";
import type { RefreshRecoveryOptions } from "../secrets";
import { knownRecipients } from "../secrets/store";
import {
  backupsStateFile,
  r2Endpoint,
  STORAGE_ENDPOINTS,
  type StorageLogin,
  storageStateFile,
} from "../shared";
import { storageS3Client } from "../shared/s3";
import type { CloudflareSetup, GitHubSetup } from "./credentials";
import { type PlanAndApplyResult, type PlanPrice, planAndApply } from "./plan-apply";
import { type RecoveryCopy, recoveryCopyFiles } from "./publish";
import type { ProvisionServices } from "./types";

export { backupsStateFile, storageStateFile } from "../shared";

export { type BucketProvider, type ProviderBucket, providerBucket };

/** The user's key for the bucket: an access key ID and its secret. Never logged. */
export type StorageKey = Pick<StorageLogin, "accessKeyId" | "secretAccessKey">;

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

type KeyVars = typeof STORAGE_KEY_VARS | typeof NEW_STORAGE_KEY_VARS | typeof OFFSITE_KEY_VARS;

/** A bucket as its key, its marker and its S3 endpoint need it. */
type Bucket = Pick<ProviderBucket, "provider" | "bucket" | "region">;

/** The steps to create the key in each provider's console, for `app` and `bucket`. */
const KEY_STEPS: Readonly<Record<BucketProvider, (app: string, bucket: string) => string[]>> = {
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
};

/** A key's ID or secret as providers give them: letters, digits and `+/=_.-`. */
const KEY_PART = /^[A-Za-z0-9+/=_.-]{16,256}$/;

const StoredKeySchema = z.object({
  provider: z.enum(["r2", "digitalocean", "hetzner"]),
  bucket: z.string(),
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
  bucket: Bucket,
  app: string,
  command: string,
  how: { asks: boolean; vars: KeyVars },
): string {
  const steps = KEY_STEPS[bucket.provider](app, bucket.bucket).map(
    (step, i) => `${i + 1}. ${step}`,
  );
  const variables = `${how.vars.accessKeyId} and ${how.vars.secretAccessKey}`;
  const moving =
    how.vars === NEW_STORAGE_KEY_VARS
      ? ` While a move takes the bucket along, ${STORAGE_KEY_VARS.accessKeyId} and ${STORAGE_KEY_VARS.secretAccessKey} hold the key of the bucket being left.`
      : "";
  return how.asks
    ? `${steps.join(" ")} Then run \`${command}\` in a terminal to paste it once, or set ${variables} to it and run \`${command}\` again.${moving}`
    : `${steps.join(" ")} Then set ${variables} to it and run \`${command}\` again.${moving}`;
}

/** The key the variables `vars` hold, or undefined when neither is set. */
function keyFromEnv(env: PhaseDeps["env"], vars: KeyVars): StorageKey | undefined {
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
function checkedKey(key: StorageKey, what: string): StorageKey {
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

/** The kept key for this bucket, or undefined (none kept for it). */
async function storedKey(deps: PhaseDeps, bucket: Bucket): Promise<StorageKey | undefined> {
  const kept = (await keptKeys(deps)).find((key) => sameBucket(key, bucket));
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
 * token limited to the bucket) after it. Registered with the redactor.
 * @throws OpsCrewError `CREDENTIALS_MISSING` with the steps when no key is known and nobody can be
 * asked; `already` says what is done (default: nothing was changed), and with `asks: false` (a
 * command that never asks) the hint names only the variables.
 */
export async function requireStorageKey(
  deps: PhaseDeps,
  plan: DeployPlan,
  services: Pick<ProvisionServices, "askStorageKey">,
  options: { command: string; already?: string; asks?: boolean; bucket?: ProviderBucket },
): Promise<StorageKey> {
  const bucket = options.bucket ?? providerBucket(plan);
  if (bucket === undefined) throw new Error("The plan has no bucket at a provider.");
  const leaving = plan.retarget?.from.objectStorage;
  const vars =
    leaving !== undefined && !sameBucket(bucket, leaving) ? NEW_STORAGE_KEY_VARS : STORAGE_KEY_VARS;
  return bucketKey(deps, services, options, {
    bucket,
    vars,
    noun: "The app's bucket",
    keyName: plan.app.name,
  });
}

/**
 * The user's key for the bucket of the off-server copies (`snapshots.offsite`, 024 plan.md 7.), as
 * {@link requireStorageKey} gets the app's: from {@link OFFSITE_KEY_VARS}, else the key kept for
 * that bucket beside the others, else asked once (interactive runs only) and kept. Hetzner's and
 * Spaces' key is needed before the bucket, R2's (a token limited to the bucket) after it.
 * Registered with the redactor.
 * @throws OpsCrewError `CREDENTIALS_MISSING` with the steps when no key is known and nobody can be
 * asked.
 */
export async function requireOffsiteKey(
  deps: PhaseDeps,
  plan: DeployPlan,
  services: Pick<ProvisionServices, "askStorageKey">,
  options: { command: string; already?: string },
): Promise<StorageKey> {
  const offsite = snapshotOffsiteOf(plan);
  if (offsite === undefined) throw new Error("The plan has no off-server copy.");
  return bucketKey(deps, services, options, {
    bucket: offsite,
    vars: OFFSITE_KEY_VARS,
    noun: "The off-server copies' bucket",
    keyName: `${plan.app.name}-backups`,
  });
}

/**
 * The key of `bucket`: from `vars` when they are set (never saved), else the kept one, else asked
 * once with the console steps for a key named `opscrew-<keyName>` and kept.
 */
async function bucketKey(
  deps: PhaseDeps,
  services: Pick<ProvisionServices, "askStorageKey">,
  options: { command: string; already?: string; asks?: boolean },
  what: { bucket: Bucket; vars: KeyVars; noun: string; keyName: string },
): Promise<StorageKey> {
  const { bucket, vars, noun } = what;
  const name = STORAGE_NAMES[bucket.provider];
  let key = keyFromEnv(deps.env, vars) ?? (await storedKey(deps, bucket));
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
    const others = (await keptKeys(deps)).filter((kept) => !sameBucket(kept, bucket));
    await keepKeys(deps, [...others, { provider: bucket.provider, bucket: bucket.bucket, ...key }]);
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

/** What the app receives besides `key`: R2's endpoint, from the zone's Cloudflare account. */
export function storageLogin(
  plan: DeployPlan,
  key: StorageKey,
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
  key: StorageKey | undefined,
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
  key: StorageKey | undefined,
): Record<string, string | undefined> {
  if (snapshotOffsiteOf(plan)?.provider === "r2") return { ...env };
  return s3EngineEnv(env, key);
}

/** `env` without `AWS_*`, with `key` for the `aws` provider and no AWS files but `credentials`. */
function s3EngineEnv(
  env: Record<string, string | undefined>,
  key: StorageKey | undefined,
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
  };
}

/**
 * The values of the off-server copy's variables (`PORTAINER_OFFSITE_VARIABLES`, by name): the
 * bucket's S3 endpoint (R2's from the zone's Cloudflare account), the bucket's key and the age
 * recipient the copies are encrypted to; the region is the plan's. Portainer's stack holds them as
 * variables; a server as `OFFSITE_ENV_FILE` ({@link offsiteEnvFile}).
 */
export function offsiteValues(
  plan: DeployPlan,
  input: {
    key: StorageKey;
    recipient: string;
    cloudflare: Pick<CloudflareSetup, "accountId"> | undefined;
  },
): Record<string, string> {
  const offsite = snapshotOffsiteOf(plan);
  if (offsite === undefined) throw new Error("The plan has no off-server copy.");
  const v = PORTAINER_OFFSITE_VARIABLES;
  let endpoint: string;
  if (offsite.provider === "r2") {
    if (input.cloudflare === undefined) throw new Error("R2 needs the Cloudflare account.");
    endpoint = r2Endpoint(input.cloudflare.accountId);
  } else {
    const at = STORAGE_ENDPOINTS[offsite.provider];
    if (at === undefined) throw new Error(`No S3 endpoint is known for ${offsite.provider}.`);
    endpoint = at(offsite.region);
  }
  return {
    [v.endpoint]: endpoint,
    [v.accessKeyId]: input.key.accessKeyId,
    [v.secretAccessKey]: input.key.secretAccessKey,
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
 * Before any change of a run with `snapshots.offsite` (024 plan.md 7., D16): the user's key for a
 * Hetzner or Spaces bucket of the copies ({@link requireOffsiteKey}; R2's comes after its bucket),
 * and, unless the run only plans, the age key they are encrypted to ({@link requireOffsiteRecipient}).
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
): Promise<{ key?: StorageKey; recovery?: RecoveryAnswers }> {
  const { command } = options;
  const offsite = snapshotOffsiteOf(plan);
  const key =
    offsite !== undefined && offsite.provider !== "r2"
      ? await requireOffsiteKey(deps, plan, services, { command })
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
    key: StorageKey | undefined;
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
      `OpsCrew stored nothing that holds their bucket's key. ${input.already}`,
    );
  }
  const key =
    input.key ??
    (await requireOffsiteKey(deps, plan, services, {
      command: input.command,
      already: input.already,
    }));
  return {
    values: offsiteValues(plan, { key, recipient, cloudflare: input.cloudflare }),
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
  key: StorageKey,
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
  provider: z.enum(["r2", "digitalocean", "hetzner"]),
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
async function writeMarker(deps: PhaseDeps, root: BucketRoot, planHash: string) {
  await mkdir(dirname(root.markerFile), { recursive: true, mode: 0o700 });
  const marker = {
    provider: root.bucket.provider,
    bucket: root.bucket.bucket,
    region: root.bucket.region,
    planHash,
    createdAt: deps.clock.now().toISOString(),
  };
  await writeFileAtomic(root.markerFile, `${JSON.stringify(marker)}\n`, { mode: 0o600 });
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
async function answersToKey(deps: PhaseDeps, bucket: Bucket, key: StorageKey) {
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
  key: StorageKey | undefined,
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
  key: StorageKey | undefined;
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
  const offsite = snapshotOffsiteOf(input.plan);
  if (offsite === undefined) throw new Error("The plan has no off-server copy.");
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
