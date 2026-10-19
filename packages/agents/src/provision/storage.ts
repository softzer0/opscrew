import { mkdir } from "node:fs/promises";
import { devNull } from "node:os";
import { dirname, join } from "node:path";
import type { IacEngine, PhaseName } from "@opscrew/contracts";
import { OpsCrewError, type ProjectPaths, readTextIfExists, writeFileAtomic } from "@opscrew/core";
import { type RenderedFile, storageRootDir } from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import { z } from "zod";
import type { PhaseDeps } from "../context";
import { STORAGE_NAMES } from "../design/storage";
import type { StorageLogin } from "../shared";
import type { CloudflareSetup } from "./credentials";
import { type PlanAndApplyResult, planAndApply } from "./plan-apply";
import type { ProvisionServices } from "./types";

/** The object storage OpsCrew creates a bucket for through the `storage` root. */
export type BucketProvider = "r2" | "digitalocean" | "hetzner";

/** The plan's bucket at a provider. */
export type ProviderBucket = NonNullable<NonNullable<DeployPlan["storage"]>["objectStorage"]> & {
  provider: BucketProvider;
};

/** The plan's bucket at a provider, or undefined (no object storage, or Garage on the server). */
export function providerBucket(plan: Pick<DeployPlan, "storage">): ProviderBucket | undefined {
  const storage = plan.storage?.objectStorage;
  if (storage === undefined || storage.provider === "garage") return undefined;
  return storage as ProviderBucket;
}

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

/** Where the key is kept between runs: a private file (0600) beside the deploy key. */
export function storageKeyFile(paths: Pick<ProjectPaths, "projectHomeDir">): string {
  return join(paths.projectHomeDir, "storage_key.json");
}

/** The `storage` root's state, beside the deployment's. */
export function storageStateFile(paths: Pick<ProjectPaths, "files">): string {
  return join(paths.files.tfstateDir, "storage.tfstate");
}

/** File name ending of a saved plan of the `storage` root. */
export const STORAGE_PLAN_SUFFIX = "-storage.tfplan";

/** The steps and where the key goes, for the stop when no key is known. */
function keyHint(bucket: ProviderBucket, app: string, command: string, asks: boolean): string {
  const steps = KEY_STEPS[bucket.provider](app, bucket.bucket).map(
    (step, i) => `${i + 1}. ${step}`,
  );
  const variables = `${STORAGE_KEY_VARS.accessKeyId} and ${STORAGE_KEY_VARS.secretAccessKey}`;
  return asks
    ? `${steps.join(" ")} Then run \`${command}\` in a terminal to paste it once, or set ${variables} to it and run \`${command}\` again.`
    : `${steps.join(" ")} Then set ${variables} to it and run \`${command}\` again.`;
}

/** The key the variables of {@link STORAGE_KEY_VARS} hold, or undefined when neither is set. */
function keyFromEnv(env: PhaseDeps["env"]): StorageKey | undefined {
  const accessKeyId = env[STORAGE_KEY_VARS.accessKeyId]?.trim() ?? "";
  const secretAccessKey = env[STORAGE_KEY_VARS.secretAccessKey]?.trim() ?? "";
  if (accessKeyId === "" && secretAccessKey === "") return undefined;
  const missing =
    accessKeyId === "" ? STORAGE_KEY_VARS.accessKeyId : STORAGE_KEY_VARS.secretAccessKey;
  if (accessKeyId === "" || secretAccessKey === "") {
    throw new OpsCrewError("INVALID_INPUT", `${missing} is not set, but its pair is.`, {
      hint: `Set both ${STORAGE_KEY_VARS.accessKeyId} and ${STORAGE_KEY_VARS.secretAccessKey} to the bucket's key, then run the command again.`,
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

/** The kept key for this bucket, or undefined (none, or one for another bucket). */
async function storedKey(deps: PhaseDeps, bucket: ProviderBucket): Promise<StorageKey | undefined> {
  const file = storageKeyFile(deps.paths);
  const text = await readTextIfExists(file);
  if (text === undefined) return undefined;
  let parsed: z.infer<typeof StoredKeySchema>;
  try {
    parsed = StoredKeySchema.parse(JSON.parse(text));
  } catch {
    throw new OpsCrewError(
      "ARTIFACT_INVALID",
      `OpsCrew's copy of the bucket's key (${file}) is damaged, so OpsCrew stopped. Nothing was changed.`,
      { hint: "Delete that file, then run the command again to paste the key once more." },
    );
  }
  if (parsed.provider !== bucket.provider || parsed.bucket !== bucket.bucket) return undefined;
  return { accessKeyId: parsed.accessKeyId, secretAccessKey: parsed.secretAccessKey };
}

/**
 * The user's key for the plan's provider bucket (FR-1318): from {@link STORAGE_KEY_VARS} when they
 * are set (never saved), else the key kept for this bucket, else asked once with the console steps
 * (`askStorageKey`, interactive runs only) and kept like a provider token in a private file
 * ({@link storageKeyFile}, mode 0600, outside the repository). Hetzner's and Spaces' key is needed
 * before the bucket, R2's (a token limited to the bucket) after it. Registered with the redactor.
 * @throws OpsCrewError `CREDENTIALS_MISSING` with the steps when no key is known and nobody can be
 * asked; `already` says what is done (default: nothing was changed), and with `asks: false` (a
 * command that never asks) the hint names only the variables.
 */
export async function requireStorageKey(
  deps: PhaseDeps,
  plan: DeployPlan,
  services: Pick<ProvisionServices, "askStorageKey">,
  options: { command: string; already?: string; asks?: boolean },
): Promise<StorageKey> {
  const bucket = providerBucket(plan);
  if (bucket === undefined) throw new Error("The plan has no bucket at a provider.");
  const name = STORAGE_NAMES[bucket.provider];
  let key = keyFromEnv(deps.env) ?? (await storedKey(deps, bucket));
  if (key === undefined && deps.interactive && services.askStorageKey !== undefined) {
    deps.reporter.info(
      `The app's bucket ${bucket.bucket} on ${name} needs a key that you create, so OpsCrew never holds one in infrastructure state.`,
    );
    const answer = await services.askStorageKey({
      provider: name,
      bucket: bucket.bucket,
      steps: KEY_STEPS[bucket.provider](plan.app.name, bucket.bucket),
    });
    key = checkedKey(
      { accessKeyId: answer.accessKeyId.trim(), secretAccessKey: answer.secretAccessKey.trim() },
      "The key you entered",
    );
    const file = storageKeyFile(deps.paths);
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await writeFileAtomic(
      file,
      `${JSON.stringify({ provider: bucket.provider, bucket: bucket.bucket, ...key })}\n`,
      { mode: 0o600 },
    );
  }
  if (key === undefined) {
    throw new OpsCrewError(
      "CREDENTIALS_MISSING",
      `The app's bucket ${bucket.bucket} on ${name} needs a key you create in ${bucket.provider === "r2" ? "Cloudflare's dashboard" : "the provider's console"}; OpsCrew never creates one. ${options.already ?? "Nothing was changed."}`,
      { hint: keyHint(bucket, plan.app.name, options.command, options.asks !== false) },
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
  if (providerBucket(plan)?.provider !== "r2" || cloudflare !== undefined) return;
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    "opscrew/plan.yaml keeps the app's files on Cloudflare R2, but the app has no domain on Cloudflare, so OpsCrew has no Cloudflare account to create the bucket in. Nothing was changed.",
    {
      hint: "Give the app a domain on Cloudflare (`opscrew dns --domain <hostname>`), or run `opscrew design` again for another storage option, then run the command again.",
    },
  );
}

/** What the app receives besides `key`: R2's endpoint, from the zone's Cloudflare account. */
export function storageLogin(
  plan: DeployPlan,
  key: StorageKey,
  cloudflare: Pick<CloudflareSetup, "accountId"> | undefined,
): StorageLogin {
  if (providerBucket(plan)?.provider !== "r2" || cloudflare === undefined) return { ...key };
  return { ...key, endpoint: `https://${cloudflare.accountId}.r2.cloudflarestorage.com` };
}

/**
 * The engine's environment for the `storage` root. For Spaces and Hetzner the `aws` provider
 * reads the user's key from `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`, never a `TF_VAR_`
 * (the saved plan would keep it); every other `AWS_*` variable is left out and the AWS config and
 * credentials files point at the null device, so the user's own AWS login (a session token, a
 * profile, a role) is never used. R2 uses the Cloudflare token as the other roots do.
 */
export function storageEngineEnv(
  env: Record<string, string | undefined>,
  plan: DeployPlan,
  key: StorageKey | undefined,
): Record<string, string | undefined> {
  if (providerBucket(plan)?.provider === "r2") return { ...env };
  const out = Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith("AWS_")));
  if (key === undefined) throw new Error("The aws provider needs the bucket's key.");
  return {
    ...out,
    AWS_ACCESS_KEY_ID: key.accessKeyId,
    AWS_SECRET_ACCESS_KEY: key.secretAccessKey,
    AWS_CONFIG_FILE: devNull,
    AWS_SHARED_CREDENTIALS_FILE: devNull,
  };
}

/** A stop instead of the engine's words, for what an apply of the `storage` root reports. */
function storageFailure(
  log: string,
  bucket: ProviderBucket,
  command: string,
  keyFile: string,
): OpsCrewError | undefined {
  const name = STORAGE_NAMES[bucket.provider];
  if (/BucketAlreadyExists|BucketAlreadyOwnedByYou/.test(log)) {
    return new OpsCrewError(
      "PHASE_PRECONDITION",
      `${name} says the bucket name ${bucket.bucket} is taken: bucket names there are shared by all its customers (or another bucket of yours has it). Nothing else was changed.`,
      {
        hint: `Change storage.objectStorage.bucket in opscrew/plan.yaml to another name (3–63 lower-case letters, digits or hyphens), then run \`${command}\` again.`,
      },
    );
  }
  if (bucket.provider !== "r2" && /InvalidAccessKeyId|SignatureDoesNotMatch/.test(log)) {
    return new OpsCrewError("CREDENTIALS_INVALID", `${name} refused the bucket's key.`, {
      hint: `Create a new key (\`${command}\` shows the steps when it has none), then set ${STORAGE_KEY_VARS.accessKeyId} and ${STORAGE_KEY_VARS.secretAccessKey} to it, or delete OpsCrew's copy of the old one (${keyFile}) and run \`${command}\` in a terminal to paste the new one.`,
    });
  }
  return undefined;
}

/**
 * The `storage` root (`opscrew/infra/storage`, the bucket and its CORS) through its own plan →
 * policies → approval bound to its hash → apply (FR-1318), with its own state
 * ({@link storageStateFile}); the key reaches the engine only as {@link storageEngineEnv} says.
 * With `approvePlanHash` it applies that saved plan of an earlier `--plan-only` run. A name taken
 * at the provider and a key it refuses stop with what to change. A refused approval says "storage
 * plan".
 */
export async function applyStorage(
  deps: PhaseDeps,
  input: {
    engine: IacEngine;
    env: Record<string, string | undefined>;
    plan: DeployPlan;
    /** The rendered `storage` root (`renderStorage`). */
    files: readonly RenderedFile[];
    key: StorageKey | undefined;
    approvePlanHash?: string;
    planOnly?: boolean;
    command: string;
    phase: PhaseName;
  },
): Promise<PlanAndApplyResult> {
  const { plan, command } = input;
  const bucket = providerBucket(plan);
  if (bucket === undefined) throw new Error("The plan has no bucket at a provider.");
  deps.reporter.step(
    `Planning the app's bucket ${bucket.bucket} on ${STORAGE_NAMES[bucket.provider]}`,
  );
  return planAndApply(deps, {
    engine: input.engine,
    dir: join(deps.paths.root, storageRootDir(plan)),
    env: storageEngineEnv(input.env, plan, input.key),
    deployPlan: plan,
    files: input.files,
    statePath: storageStateFile(deps.paths),
    planSuffix: STORAGE_PLAN_SUFFIX,
    planNoun: "storage plan",
    command,
    phase: input.phase,
    approvalTitle: `Apply the plan of the app's bucket ${bucket.bucket} on ${STORAGE_NAMES[bucket.provider]}`,
    costDelta: { amount: bucket.price.monthly, currency: bucket.price.currency },
    applyFailed: (log) => {
      const failure = storageFailure(log, bucket, command, storageKeyFile(deps.paths));
      if (failure !== undefined) throw failure;
    },
    ...(input.approvePlanHash !== undefined ? { approvePlanHash: input.approvePlanHash } : {}),
    ...(input.planOnly ? { planOnly: true } : {}),
  });
}
