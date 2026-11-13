import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FakeZone } from "@opscrew/connector-cloudflare/testing";
import type {
  CommandRunner,
  FetchLike,
  IacApproval,
  IacEngine,
  IacInitOptions,
  IacRunOptions,
} from "@opscrew/contracts";
import {
  ageRecipientOf,
  findExecutable,
  formatMoney,
  generateAgeIdentity,
  OpsCrewError,
  readTextIfExists,
} from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { STORAGE_PRICES } from "@opscrew/iac-templates";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { readRecord } from "../secrets/store";
import {
  createProject,
  createTestPhaseDeps,
  FAKE_SOPS,
  FakeEngine,
  FakeGitHub,
  FakeSops,
  fakeCloudflare,
  fakeSharedCloudflare,
  plainState,
  projectRunner,
  readyRemote,
  ScriptedApprovalHandler,
  testPlan,
} from "../testing";
import {
  bucketChanges,
  bucketEngine,
  CONTABO_S3_URL,
  FakeObjectStorage,
  RootEngine,
  withBucket,
} from "../testing/storage";
import { findSavedPlan } from "./plan-apply";
import { DEPLOY_SETUP_BRANCH } from "./publish";
import { runProvision } from "./run";
import {
  applyStorage,
  BACKUPS_PLAN_SUFFIX,
  backupsCreateFile,
  backupsEngineEnv,
  backupsStateFile,
  forgetStorageKey,
  NEW_STORAGE_KEY_VARS,
  OFFSITE_KEY_VARS,
  offsiteEnvFile,
  offsiteValues,
  orderedStorageFile,
  previousBucketKeyFile,
  providerBucket,
  requireOffsiteKey,
  requireR2Cloudflare,
  requireStorageKey,
  STORAGE_KEY_VARS,
  STORAGE_PLAN_SUFFIX,
  type StorageKeyQuestion,
  storageCreateFile,
  storageEngineEnv,
  storageKeyFile,
  storageLogin,
  storageStateFile,
  withPreviousBucketKey,
} from "./storage";
import type { ProvisionOptions, ProvisionServices } from "./types";

const KEY = {
  accessKeyId: fakeSecret("aws-access-key-id", "bucket"),
  secretAccessKey: fakeSecret("aws-secret-access-key", "bucket"),
};
const KEY_ENV = {
  [STORAGE_KEY_VARS.accessKeyId]: KEY.accessKeyId,
  [STORAGE_KEY_VARS.secretAccessKey]: KEY.secretAccessKey,
};
const HCLOUD = fakeSecret("hcloud-token", "storage");
const OPEN_PULL = { number: 7, url: "https://github.com/acme/shop/pull/7" };
const CORS_CHANGE = {
  address: "aws_s3_bucket_cors_configuration.this",
  type: "aws_s3_bucket_cors_configuration",
  name: "this",
  provider: "registry.opentofu.org/hashicorp/aws",
  action: "create" as const,
};
/** The `aws` provider's words when it creates the bucket but cannot read it back. */
const LATE_LOG =
  "aws_s3_bucket.this: Creating...\naws_s3_bucket.this: Still creating... [10s elapsed]\nError: reading S3 Bucket (shop-uploads): couldn't find resource\n\n  with aws_s3_bucket.this,\n  on main.tf line 18";
/** Hetzner's answer to a create of a name another bucket has. */
const TAKEN_LOG =
  "Error: creating S3 Bucket (shop-uploads): operation error S3: CreateBucket, https response error StatusCode: 409, api error BucketAlreadyExists: The requested bucket name is not available.";
/** The engine's words for an import of a bucket the provider cannot read (yet). */
const NOT_READABLE =
  'Error: Cannot import non-existent remote object\n\nWhile attempting to import an existing object to "aws_s3_bucket.this", the provider detected that no object exists with the given id.';
const RERUN_HINT =
  "Run `opscrew provision` again: it plans what is left, such as the bucket's CORS rule, for you to approve as usual.";
const SHOWN_LATE = {
  code: "PROVIDER_ERROR",
  message:
    "Hetzner Object Storage did not show the new bucket shop-uploads right away, so the apply stopped. OpsCrew kept the bucket.",
  hint: RERUN_HINT,
};
const TAKEN = {
  code: "PHASE_PRECONDITION",
  message:
    "Hetzner Object Storage says the bucket name shop-uploads is taken: bucket names there are shared by all its customers (or another bucket of yours has it). Nothing else was changed.",
  hint: expect.stringContaining(
    "Change storage.objectStorage.bucket in opscrew/plan.yaml to another name",
  ),
};
/** The bucket as a failed create leaves it in the `storage` root's state. */
const BUCKET_IN_STATE = {
  mode: "managed",
  type: "aws_s3_bucket",
  name: "this",
  instances: [{ schema_version: 0, status: "tainted", attributes: { bucket: "shop-uploads" } }],
};

/**
 * Hetzner's S3 endpoint: HEAD answers `status`, or fails without an answer when it is undefined.
 * Records every request.
 */
function fakeS3(status: number | undefined) {
  const requests: { method: string; url: string; authorization: string }[] = [];
  const fetch: FetchLike = async (input, init) => {
    requests.push({
      method: init?.method ?? "GET",
      url: String(input),
      authorization: new Headers(init?.headers).get("authorization") ?? "",
    });
    if (status === undefined) throw new TypeError("fetch failed");
    return new Response(null, { status });
  };
  return { fetch, requests };
}

describe("requireStorageKey", () => {
  const hetzner = () => withBucket(testPlan(), "hetzner");
  const deps = (o: { env?: Record<string, string | undefined>; interactive?: boolean } = {}) =>
    createTestPhaseDeps({ ...(o.interactive ? { interactive: true } : {}), env: o.env ?? {} });

  it("reads the key from the environment and keeps no copy of it", async () => {
    const d = await deps({ env: KEY_ENV });
    await expect(
      requireStorageKey(d, hetzner(), {}, { command: "opscrew provision" }),
    ).resolves.toEqual(KEY);
    await expect(readTextIfExists(storageKeyFile(d.paths))).resolves.toBeUndefined();
    // Registered with the redactor, like a provider token.
    expect(d.redactor.redact(`${KEY.accessKeyId} ${KEY.secretAccessKey}`)).not.toContain(
      KEY.secretAccessKey,
    );
  });

  it("asks once with the provider's console steps, keeps it privately and asks no more", async () => {
    const d = await deps({ interactive: true });
    const questions: StorageKeyQuestion[] = [];
    const askStorageKey = async (question: StorageKeyQuestion) => {
      questions.push(question);
      return { accessKeyId: ` ${KEY.accessKeyId} `, secretAccessKey: KEY.secretAccessKey };
    };
    const plan = hetzner();
    const options = { command: "opscrew provision" };
    await expect(requireStorageKey(d, plan, { askStorageKey }, options)).resolves.toEqual(KEY);
    await expect(requireStorageKey(d, plan, { askStorageKey }, options)).resolves.toEqual(KEY);
    expect(questions).toHaveLength(1);
    expect(questions[0]).toMatchObject({
      provider: "Hetzner Object Storage",
      bucket: "shop-uploads",
    });
    expect(questions[0]?.steps.join("\n")).toContain("Security → S3 credentials");
    expect(questions[0]?.steps.join("\n")).toContain("opscrew-shop");
    const file = storageKeyFile(d.paths);
    expect(JSON.parse((await readTextIfExists(file)) ?? "{}")).toEqual({
      provider: "hetzner",
      bucket: "shop-uploads",
      ...KEY,
    });
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(d.reporter.text()).not.toContain(KEY.secretAccessKey);

    // Another bucket needs its own key (an R2 token is limited to its bucket).
    const r2 = withBucket(testPlan({ domain: "shop.example.com" }), "r2");
    await requireStorageKey(d, r2, { askStorageKey }, options);
    expect(questions).toHaveLength(2);
    expect(questions[1]?.provider).toBe("Cloudflare R2");
    expect(questions[1]?.steps.join("\n")).toContain("pick shop-uploads");
  });

  it("stops in a run nobody can answer, with the steps and the variables to set", async () => {
    const d = await deps();
    const error = await requireStorageKey(
      d,
      withBucket(testPlan(), "digitalocean"),
      {},
      { command: "opscrew provision" },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpsCrewError);
    expect(error).toMatchObject({
      code: "CREDENTIALS_MISSING",
      message:
        "The app's bucket shop-uploads on DigitalOcean Spaces needs a key you create in the provider's console; OpsCrew never creates one. Nothing was changed.",
    });
    const hint = (error as OpsCrewError).hint ?? "";
    expect(hint).toContain("1. Open Spaces Object Storage → Access Keys");
    expect(hint).toContain("Full Access");
    expect(hint).toContain(STORAGE_KEY_VARS.accessKeyId);
    expect(hint).toContain(STORAGE_KEY_VARS.secretAccessKey);
  });

  it("refuses half a key and what does not look like one, without repeating it", async () => {
    const half = await deps({ env: { [STORAGE_KEY_VARS.accessKeyId]: KEY.accessKeyId } });
    await expect(
      requireStorageKey(half, hetzner(), {}, { command: "opscrew provision" }),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: `${STORAGE_KEY_VARS.secretAccessKey} is not set, but its pair is.`,
    });
    const typed = await deps({ interactive: true });
    const error = await requireStorageKey(
      typed,
      hetzner(),
      { askStorageKey: async () => ({ accessKeyId: "short", secretAccessKey: "two words here" }) },
      { command: "opscrew provision" },
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "INVALID_INPUT" });
    expect(JSON.stringify(error)).not.toContain("two words here");
    await expect(readTextIfExists(storageKeyFile(typed.paths))).resolves.toBeUndefined();
  });

  it("keeps each bucket's key on a line of its own, and forgets one without the others", async () => {
    const d = await deps({ interactive: true });
    const other = {
      accessKeyId: fakeSecret("aws-access-key-id", "other"),
      secretAccessKey: fakeSecret("aws-secret-access-key", "other"),
    };
    const options = { command: "opscrew retarget" };
    await requireStorageKey(d, hetzner(), { askStorageKey: async () => KEY }, options);
    const spaces = withBucket(testPlan(), "digitalocean");
    await requireStorageKey(d, spaces, { askStorageKey: async () => other }, options);
    // Both are kept: neither is asked again.
    const never = async (): Promise<typeof KEY> => {
      throw new Error("asked again");
    };
    await expect(
      requireStorageKey(d, hetzner(), { askStorageKey: never }, options),
    ).resolves.toEqual(KEY);
    await expect(requireStorageKey(d, spaces, { askStorageKey: never }, options)).resolves.toEqual(
      other,
    );
    const lines = ((await readTextIfExists(storageKeyFile(d.paths))) ?? "").trim().split("\n");
    expect(lines.map((line) => JSON.parse(line).provider)).toEqual(["hetzner", "digitalocean"]);
    await forgetStorageKey(d, { provider: "hetzner", bucket: "shop-uploads" });
    expect(await readTextIfExists(storageKeyFile(d.paths))).not.toContain(KEY.secretAccessKey);
    await forgetStorageKey(d, { provider: "digitalocean", bucket: "shop-uploads" });
    await expect(readTextIfExists(storageKeyFile(d.paths))).resolves.toBeUndefined();
  });

  it("while a move takes the bucket along, reads the variables for the bucket being left only", async () => {
    const d = await deps({ env: KEY_ENV });
    const old = withBucket(testPlan(), "hetzner");
    const leaving = old.storage?.objectStorage;
    const next = withBucket(testPlan(), "digitalocean");
    const moving: DeployPlan = {
      ...next,
      retarget: {
        from: { target: old.target, deploy: old.deploy, objectStorage: leaving },
        step: "started",
        empty: [],
        startedAt: "2026-11-06T12:00:00.000Z",
      },
    };
    const options = { command: "opscrew retarget" };
    const bucket = providerBucket(old);
    await expect(requireStorageKey(d, moving, {}, { ...options, bucket })).resolves.toEqual(KEY);
    const error = await requireStorageKey(d, moving, {}, options).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: "CREDENTIALS_MISSING",
      message: expect.stringContaining("shop-uploads on DigitalOcean Spaces"),
      hint: expect.stringContaining(
        "Then run `opscrew retarget` in a terminal to paste it once, or set OPSCREW_NEW_STORAGE_ACCESS_KEY_ID and OPSCREW_NEW_STORAGE_SECRET_ACCESS_KEY to it and run `opscrew retarget` again. While a move takes the bucket along, OPSCREW_STORAGE_ACCESS_KEY_ID and OPSCREW_STORAGE_SECRET_ACCESS_KEY hold the key of the bucket being left.",
      ),
    });
    // The new bucket's key from its own variables, never kept, registered with the redactor.
    const fresh = {
      accessKeyId: fakeSecret("aws-access-key-id", "new"),
      secretAccessKey: fakeSecret("aws-secret-access-key", "new"),
    };
    const both = await deps({
      env: {
        ...KEY_ENV,
        [NEW_STORAGE_KEY_VARS.accessKeyId]: fresh.accessKeyId,
        [NEW_STORAGE_KEY_VARS.secretAccessKey]: fresh.secretAccessKey,
      },
    });
    await expect(requireStorageKey(both, moving, {}, options)).resolves.toEqual(fresh);
    await expect(requireStorageKey(both, moving, {}, { ...options, bucket })).resolves.toEqual(KEY);
    await expect(readTextIfExists(storageKeyFile(both.paths))).resolves.toBeUndefined();
    expect(both.redactor.redact(fresh.secretAccessKey)).not.toContain(fresh.secretAccessKey);
    // Without a move they are never read.
    const plain = await deps({
      env: {
        [NEW_STORAGE_KEY_VARS.accessKeyId]: fresh.accessKeyId,
        [NEW_STORAGE_KEY_VARS.secretAccessKey]: fresh.secretAccessKey,
      },
    });
    await expect(requireStorageKey(plain, next, {}, options)).rejects.toMatchObject({
      code: "CREDENTIALS_MISSING",
    });
  });

  it("stops on a damaged copy of the key instead of asking again", async () => {
    const d = await deps({ interactive: true });
    const file = storageKeyFile(d.paths);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, "{not json");
    await expect(
      requireStorageKey(
        d,
        hetzner(),
        { askStorageKey: async () => KEY },
        { command: "opscrew provision" },
      ),
    ).rejects.toMatchObject({ code: "ARTIFACT_INVALID" });
  });
});

describe("the storage root's engine environment and the app's login", () => {
  const env = {
    PATH: "/usr/bin",
    CLOUDFLARE_API_TOKEN: "cf",
    AWS_PROFILE: "work",
    AWS_SESSION_TOKEN: fakeSecret("generic-password", "session"),
    AWS_ACCESS_KEY_ID: fakeSecret("aws-access-key-id", "own-aws"),
    AWS_SECRET_ACCESS_KEY: fakeSecret("aws-secret-access-key", "own-aws"),
    AWS_ROLE_ARN: "arn:aws:iam::123456789012:role/admin",
    AWS_SHARED_CREDENTIALS_FILE: "/home/me/.aws/credentials",
  };

  it("gives the aws provider only the bucket's key, never the user's AWS login or a TF_VAR_", () => {
    const out = storageEngineEnv(env, withBucket(testPlan(), "hetzner"), KEY);
    expect(Object.keys(out).filter((name) => name.startsWith("AWS_"))).toEqual([
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_CONFIG_FILE",
      "AWS_SHARED_CREDENTIALS_FILE",
    ]);
    expect(out).toMatchObject({
      PATH: "/usr/bin",
      AWS_ACCESS_KEY_ID: KEY.accessKeyId,
      AWS_SECRET_ACCESS_KEY: KEY.secretAccessKey,
      // The user's own AWS files are never read.
      AWS_CONFIG_FILE: devNull,
      AWS_SHARED_CREDENTIALS_FILE: devNull,
    });
    expect(Object.keys(out).some((name) => name.startsWith("TF_VAR_"))).toBe(false);
    // R2's root uses the Cloudflare token as the other roots do.
    expect(storageEngineEnv(env, withBucket(testPlan(), "r2"), undefined)).toEqual(env);
  });

  it("gives a move's aws.previous provider the bucket being left's key in a file there only while it runs", async () => {
    const d = await createTestPhaseDeps({ env: {} });
    const file = previousBucketKeyFile(d.paths);
    const seen = await withPreviousBucketKey(d, KEY, async (path) => {
      expect(path).toBe(file);
      const out = storageEngineEnv(env, withBucket(testPlan(), "digitalocean"), KEY, path);
      expect(out.AWS_SHARED_CREDENTIALS_FILE).toBe(file);
      if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
      return readTextIfExists(file);
    });
    expect(seen).toBe(
      `[opscrew-previous]\naws_access_key_id = ${KEY.accessKeyId}\naws_secret_access_key = ${KEY.secretAccessKey}\n`,
    );
    await expect(readTextIfExists(file)).resolves.toBeUndefined();
    // Removed when the engine fails too.
    await expect(
      withPreviousBucketKey(d, KEY, async () => {
        throw new Error("engine failed");
      }),
    ).rejects.toThrow("engine failed");
    await expect(readTextIfExists(file)).resolves.toBeUndefined();
  });

  it("gives the app R2's endpoint from the zone's Cloudflare account", () => {
    const r2 = withBucket(testPlan({ domain: "shop.example.com" }), "r2");
    expect(storageLogin(r2, KEY, { accountId: "0123abcd" })).toEqual({
      ...KEY,
      endpoint: "https://0123abcd.r2.cloudflarestorage.com",
    });
    expect(storageLogin(withBucket(testPlan(), "hetzner"), KEY, undefined)).toEqual(KEY);
  });

  it("refuses R2 without a domain on Cloudflare", () => {
    expect(() => requireR2Cloudflare(withBucket(testPlan(), "r2"), undefined)).toThrow(
      "opscrew/plan.yaml keeps the app's files on Cloudflare R2, but the app has no domain on Cloudflare",
    );
    expect(() => requireR2Cloudflare(withBucket(testPlan(), "hetzner"), undefined)).not.toThrow();
  });
});

interface FlowOptions {
  plan: DeployPlan;
  storage: FakeEngine;
  env?: Record<string, string | undefined>;
  interactive?: boolean;
  answer?: ConstructorParameters<typeof ScriptedApprovalHandler>[0];
  services?: ProvisionServices;
  runner?: CommandRunner;
}

async function flow(o: FlowOptions) {
  const project = await createProject(o.plan);
  await writeFile(join(project.root, "production.env"), "STRIPE_SECRET_KEY=sk\n");
  const main = new FakeEngine();
  const engine = new RootEngine(main, o.storage);
  const github = new FakeGitHub();
  const handler = new ScriptedApprovalHandler(o.answer ?? (() => true));
  const {
    [STORAGE_KEY_VARS.accessKeyId]: _id,
    [STORAGE_KEY_VARS.secretAccessKey]: _secret,
    ...base
  } = process.env;
  const env: Record<string, string | undefined> = {
    ...base,
    OPSCREW_HOME: join(project.root, ".home-opscrew"),
    HCLOUD_TOKEN: HCLOUD,
    OPSCREW_APP_ENV_FILE: "production.env",
    // The user's own AWS login, which the bucket's plan must never use.
    AWS_PROFILE: "work",
    AWS_SESSION_TOKEN: fakeSecret("generic-password", "session"),
    ...o.env,
  };
  const deps = await createTestPhaseDeps({
    root: project.root,
    env,
    runner: o.runner ?? projectRunner(),
    approvalHandler: handler,
    interactive: o.interactive ?? false,
  });
  deps.redactor.addLiteral(HCLOUD, "HCLOUD_TOKEN");
  const services: ProvisionServices = {
    engine: async () => engine,
    provider: { configured: true, verify: async () => ({ ok: true, message: "ok" }) },
    github,
    cloudflare: fakeCloudflare(),
    tcpConnect: async () => true,
    remote: readyRemote,
    sleep: async () => undefined,
    sharedCloudflare: fakeSharedCloudflare(new FakeZone()),
    ...o.services,
  };
  return { ...project, deps, engine, main, github, handler, services };
}

type Flow = Awaited<ReturnType<typeof flow>>;

/** The `storage` root's state as the engine left it, holding `resources`. */
async function writeStorageState(f: Flow, resources: unknown[]): Promise<void> {
  const file = storageStateFile(f.deps.paths);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, plainState(resources));
}

/** The marker an earlier run's apply left when it set out to create `bucket` at Hetzner. */
async function writeEarlierMarker(f: Flow, bucket = "shop-uploads"): Promise<void> {
  const file = storageCreateFile(f.deps.paths);
  await mkdir(dirname(file), { recursive: true });
  const marker = {
    provider: "hetzner",
    bucket,
    region: "fsn1",
    planHash: "0".repeat(64),
    createdAt: "2026-10-10T12:00:00.000Z",
  };
  await writeFile(file, JSON.stringify(marker));
}

const markerLeft = (f: Flow) => readTextIfExists(storageCreateFile(f.deps.paths));

/** The rerun after a stop: the next plan only adds the CORS rule, applied by its own approval. */
async function expectRerunPlansOnlyCors(f: Flow, storage: FakeEngine): Promise<void> {
  storage.scenario.changes = [CORS_CHANGE];
  storage.scenario.applyOk = true;
  const before = f.handler.requests.length;
  const appliedBefore = storage.applied.length;
  await runProvision(f.deps, { services: f.services });
  const [rerun] = f.handler.requests.slice(before).filter((r) => r.kind === "iac-apply");
  expect(rerun?.title).toBe(
    "Apply the plan of the app's bucket shop-uploads on Hetzner Object Storage",
  );
  expect(storage.applied).toHaveLength(appliedBefore + 1);
  expect(storage.applied.at(-1)?.approval.approvedPlanHash).toBe(rerun?.planHash);
  expect(storage.applied.at(-1)?.approval.allowDestroy).toBe(false);
}

/** Every text the run printed, audited or wrote into the repository and the GitHub secrets but the app's. */
async function leaks(f: Flow): Promise<string> {
  const files = await f.git(f.root, "ls-files", "-z", "--others", "--cached");
  const contents = await Promise.all(
    files
      .split("\0")
      .filter((path) => path !== "")
      .map((path) => readTextIfExists(join(f.root, path)).then((text) => text ?? "")),
  );
  return [
    f.deps.reporter.text(),
    JSON.stringify(f.deps.audit.entries),
    JSON.stringify(f.handler.requests),
    ...contents,
  ].join("\n");
}

describe.skipIf(!findExecutable("git"))("provision with a bucket at a provider (FR-1318)", () => {
  it("creates a Hetzner bucket through its own approved plan with the key only in the environment", async () => {
    const f = await flow({
      plan: withBucket(testPlan(), "hetzner"),
      storage: bucketEngine("hetzner"),
      env: KEY_ENV,
    });
    const result = await runProvision(f.deps, { services: f.services });

    const applies = f.handler.requests.filter((r) => r.kind === "iac-apply");
    expect(applies.map((r) => r.title)).toEqual([
      "Apply the plan of the app's bucket shop-uploads on Hetzner Object Storage",
      expect.stringContaining("Apply the infrastructure plan on Hetzner"),
    ]);
    expect(applies[0]?.costDelta).toEqual({ amount: 6.49, currency: "EUR" });
    // The bucket's own price from the plan, not the deployment's monthly cost.
    expect(applies[0]?.details).toContain(
      "Estimated cost: €6.49 per month for what this plan creates (from test, checked on 2026-10-19).",
    );
    expect(applies[0]?.details).not.toContain(formatMoney(testPlan().cost.monthly));
    expect(result.storagePlanHash).toBe(applies[0]?.planHash);
    expect(f.engine.storage.calls).toEqual(["init", "validate", "plan", "apply"]);
    expect(f.engine.storage.initOptions?.backendConfig?.path).toBe(storageStateFile(f.deps.paths));
    expect(f.engine.storage.applied[0]?.planFile.endsWith(STORAGE_PLAN_SUFFIX)).toBe(true);
    // The key reaches the engine as the aws provider's own variables, and the user's AWS login
    // never does.
    for (const env of f.engine.storageEnvs) {
      expect(env.AWS_ACCESS_KEY_ID).toBe(KEY.accessKeyId);
      expect(env.AWS_SECRET_ACCESS_KEY).toBe(KEY.secretAccessKey);
      expect(env.AWS_PROFILE).toBeUndefined();
      expect(env.AWS_SESSION_TOKEN).toBeUndefined();
      expect(
        Object.values(env).some(
          (v) => v?.includes(KEY.secretAccessKey) && v !== KEY.secretAccessKey,
        ),
      ).toBe(false);
    }
    expect(f.main.initOptions?.env?.AWS_SECRET_ACCESS_KEY).toBeUndefined();

    // The app receives the key with the bucket's other settings.
    const appEnv = f.github.secrets.get("OPSCREW_APP_ENV") ?? "";
    expect(appEnv).toContain(`AWS_SECRET_ACCESS_KEY=${KEY.secretAccessKey}`);
    const rendered = await readTextIfExists(join(f.root, "opscrew/infra/storage/main.tf"));
    expect(rendered).toContain('resource "aws_s3_bucket" "this"');
    const printed = await leaks(f);
    expect(printed).not.toContain(KEY.secretAccessKey);
    expect(printed).not.toContain(KEY.accessKeyId);
  });

  it("notes the bucket it sets out to create before the apply, and removes the note once it is in the state", async () => {
    const storage = bucketEngine("hetzner");
    const f = await flow({ plan: withBucket(testPlan(), "hetzner"), storage, env: KEY_ENV });
    let during: string | undefined;
    const apply = storage.apply.bind(storage);
    storage.apply = async (...args: Parameters<FakeEngine["apply"]>) => {
      during = await markerLeft(f);
      return apply(...args);
    };
    await runProvision(f.deps, { services: f.services });
    const [approval] = f.handler.requests.filter((r) => r.kind === "iac-apply");
    expect(JSON.parse(during ?? "{}")).toEqual({
      provider: "hetzner",
      bucket: "shop-uploads",
      region: "fsn1",
      planHash: approval?.planHash,
      createdAt: "2026-10-11T12:00:00.000Z",
    });
    expect(await markerLeft(f)).toBeUndefined();
  });

  it("stops before any change without the key, saying how to create it", async () => {
    const f = await flow({
      plan: withBucket(testPlan(), "hetzner"),
      storage: bucketEngine("hetzner"),
    });
    await expect(runProvision(f.deps, { services: f.services })).rejects.toMatchObject({
      code: "CREDENTIALS_MISSING",
      message: expect.stringContaining("Nothing was changed."),
      hint: expect.stringContaining("Security → S3 credentials"),
    });
    expect(f.handler.requests).toEqual([]);
    expect(f.engine.storage.calls).toEqual([]);
    expect(f.main.calls).toEqual([]);
  });

  it("asks for R2's token after its bucket exists, limited to it, and gives the app R2's endpoint", async () => {
    const events: string[] = [];
    const storage = bucketEngine("r2");
    const apply = storage.apply.bind(storage);
    storage.apply = async (...args: Parameters<FakeEngine["apply"]>) => {
      events.push("bucket");
      return apply(...args);
    };
    const f = await flow({
      plan: withBucket(testPlan({ domain: "shop.example.com" }), "r2"),
      storage,
      interactive: true,
      services: {
        askEnv: async () => ({ skip: true }),
        askStorageKey: async (question) => {
          events.push(`key for ${question.bucket}`);
          return KEY;
        },
      },
    });
    await runProvision(f.deps, { services: f.services });
    expect(events).toEqual(["bucket", "key for shop-uploads"]);
    const appEnv = f.github.secrets.get("OPSCREW_APP_ENV") ?? "";
    expect(appEnv).toContain(`AWS_ACCESS_KEY_ID=${KEY.accessKeyId}`);
    expect(appEnv).toContain("AWS_ENDPOINT_URL_S3=https://");
    expect(appEnv).toContain(".r2.cloudflarestorage.com");
    // No AWS key reaches the R2 root: it creates the bucket with the Cloudflare token.
    for (const env of f.engine.storageEnvs)
      expect(env.AWS_SECRET_ACCESS_KEY).not.toBe(KEY.secretAccessKey);
  });

  it("with R2 and nobody to ask, stops after the bucket and before the app's secrets", async () => {
    const f = await flow({
      plan: withBucket(testPlan({ domain: "shop.example.com" }), "r2"),
      storage: bucketEngine("r2"),
    });
    await expect(runProvision(f.deps, { services: f.services })).rejects.toMatchObject({
      code: "CREDENTIALS_MISSING",
      message: expect.stringContaining(
        "The bucket shop-uploads exists; the deploy secrets are not stored yet.",
      ),
      hint: expect.stringContaining("apply it to specific buckets only and pick shop-uploads"),
    });
    expect(f.engine.storage.applied).toHaveLength(1);
    expect(f.github.secrets.size).toBe(0);
  });

  it("--plan-only shows the bucket's plan hash, and --approve applies it as the bucket's", async () => {
    let approved: string[] = [];
    const f = await flow({
      plan: withBucket(testPlan(), "hetzner"),
      storage: bucketEngine("hetzner"),
      env: KEY_ENV,
      answer: (request) =>
        request.kind !== "iac-apply" || approved.includes(request.planHash as string),
    });
    const planned = await runProvision(f.deps, { services: f.services, planOnly: true });
    expect(planned.storagePlanHash).toMatch(/^[0-9a-f]{64}$/);
    expect(planned.planHash).toMatch(/^[0-9a-f]{64}$/);
    const saved = await findSavedPlan(
      f.deps.paths.files.plansDir,
      planned.storagePlanHash as string,
    );
    expect(saved?.planFile.endsWith(STORAGE_PLAN_SUFFIX)).toBe(true);

    // The bucket's hash first: it is still only ever applied as the bucket's plan.
    approved = [planned.storagePlanHash as string, planned.planHash as string];
    const applied = await runProvision(f.deps, { services: f.services, approveHashes: approved });
    expect(applied.applied).toBe(true);
    expect(f.engine.storage.applied[0]?.planFile).toBe(saved?.planFile);
    expect(f.engine.storage.calls.filter((c) => c === "plan")).toHaveLength(1);
    expect(f.main.applied[0]?.planFile.endsWith(STORAGE_PLAN_SUFFIX)).toBe(false);
    const bucketPlan = await findSavedPlan(f.deps.paths.files.plansDir, approved[0] as string);
    expect(bucketPlan?.appliedAt).toBe("2026-10-11T12:00:00.000Z");

    // The same script again after a half-finished run: neither applied plan is applied twice (a
    // real engine refuses a stale plan); each root is planned afresh and finds nothing to change.
    f.engine.storage.scenario.changes = [];
    f.main.scenario.changes = [];
    f.github.openPulls.set(DEPLOY_SETUP_BRANCH, OPEN_PULL);
    await runProvision(f.deps, { services: f.services, approveHashes: approved });
    expect(f.engine.storage.calls.filter((c) => c === "plan")).toHaveLength(2);
    expect(f.engine.storage.applied).toHaveLength(1);
  });

  it.each([
    ["HTTP 403 (another customer's bucket)", 403],
    ["HTTP 404", 404],
    ["no answer", undefined],
  ])(
    "names storage.objectStorage.bucket when the name is taken and the bucket answers the key with %s",
    async (_, status) => {
      const storage = bucketEngine("hetzner", { applyOk: false, applyLog: TAKEN_LOG });
      const f = await flow({ plan: withBucket(testPlan(), "hetzner"), storage, env: KEY_ENV });
      const s3 = fakeS3(status);
      f.deps.fetch = s3.fetch;
      await expect(runProvision(f.deps, { services: f.services })).rejects.toMatchObject(TAKEN);
      expect(s3.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
        "HEAD https://fsn1.your-objectstorage.com/shop-uploads",
      ]);
      expect(storage.imports).toEqual([]);
      expect(storage.applied).toHaveLength(1);
      expect(f.main.calls).toEqual([]);
    },
  );

  it("names storage.objectStorage.bucket when R2 says the name is taken, without asking R2", async () => {
    const storage = bucketEngine("r2", { applyOk: false, applyLog: TAKEN_LOG });
    const f = await flow({
      plan: withBucket(testPlan({ domain: "shop.example.com" }), "r2"),
      storage,
      env: KEY_ENV,
    });
    const s3 = fakeS3(200);
    f.deps.fetch = s3.fetch;
    await expect(runProvision(f.deps, { services: f.services })).rejects.toMatchObject({
      ...TAKEN,
      message: expect.stringContaining("Cloudflare R2 says the bucket name shop-uploads is taken"),
    });
    expect(s3.requests).toEqual([]);
    expect(storage.imports).toEqual([]);
  });

  it("keeps the user's own bucket an earlier run set out to create when the name is taken, and the next run plans only what is left", async () => {
    const storage = bucketEngine("hetzner", {
      changes: [...bucketChanges("hetzner"), CORS_CHANGE],
      applyOk: false,
      applyLog: TAKEN_LOG,
    });
    const f = await flow({ plan: withBucket(testPlan(), "hetzner"), storage, env: KEY_ENV });
    await writeEarlierMarker(f);
    const s3 = fakeS3(200);
    f.deps.fetch = s3.fetch;
    await expect(runProvision(f.deps, { services: f.services })).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
      message:
        "Hetzner Object Storage says the bucket name shop-uploads is taken, and the bucket answers to your key: OpsCrew found the bucket from an earlier run and kept it.",
      hint: RERUN_HINT,
    });
    // The bucket is checked with the user's key, then only recorded in the state.
    expect(s3.requests).toEqual([
      {
        method: "HEAD",
        url: "https://fsn1.your-objectstorage.com/shop-uploads",
        authorization: expect.stringContaining(`Credential=${KEY.accessKeyId}/`),
      },
    ]);
    expect(storage.imports).toEqual([
      {
        address: "aws_s3_bucket.this",
        id: "shop-uploads",
        env: expect.objectContaining({ AWS_SECRET_ACCESS_KEY: KEY.secretAccessKey }),
      },
    ]);
    expect(storage.calls).toEqual(["init", "validate", "plan", "apply", "import"]);
    expect(f.main.calls).toEqual([]);
    expect(await markerLeft(f)).toBeUndefined();

    await expectRerunPlansOnlyCors(f, storage);
    expect(storage.imports).toHaveLength(1);
    const printed = await leaks(f);
    expect(printed).not.toContain(KEY.secretAccessKey);
    expect(printed).not.toContain(KEY.accessKeyId);
  });

  it.each([
    ["no marker", undefined],
    ["a marker of another bucket", "shop-files"],
  ])(
    "never takes over a bucket of the user's that OpsCrew did not create for this app (%s), in this run or the next",
    async (_, other) => {
      const storage = bucketEngine("hetzner", { applyOk: false, applyLog: TAKEN_LOG });
      const f = await flow({ plan: withBucket(testPlan(), "hetzner"), storage, env: KEY_ENV });
      if (other !== undefined) await writeEarlierMarker(f, other);
      f.deps.fetch = fakeS3(200).fetch;
      const notOurs = {
        code: "PHASE_PRECONDITION",
        message:
          "A bucket called shop-uploads already exists in your Hetzner Object Storage account, but OpsCrew did not create it for this app, so it will not take it over. Nothing was changed.",
        hint: TAKEN.hint,
      };
      await expect(runProvision(f.deps, { services: f.services })).rejects.toMatchObject(notOurs);
      // This apply created nothing, so no marker names the bucket for the next run either.
      expect(await markerLeft(f)).toBeUndefined();
      await expect(runProvision(f.deps, { services: f.services })).rejects.toMatchObject(notOurs);
      expect(storage.imports).toEqual([]);
      expect(storage.calls).not.toContain("untaint");
    },
  );

  it("takes a bucket shown late into the state only when the marker names it", async () => {
    const storage = bucketEngine("hetzner", { applyOk: false, applyLog: LATE_LOG });
    const f = await flow({ plan: withBucket(testPlan(), "hetzner"), storage, env: KEY_ENV });
    // Something removed the marker during the apply.
    const apply = storage.apply.bind(storage);
    storage.apply = async (...args: Parameters<FakeEngine["apply"]>) => {
      await rm(storageCreateFile(f.deps.paths), { force: true });
      return apply(...args);
    };
    await expect(runProvision(f.deps, { services: f.services })).rejects.toMatchObject({
      code: "ENGINE_FAILED",
      message: expect.stringContaining("couldn't find resource"),
    });
    expect(storage.imports).toEqual([]);
  });

  it("keeps a new bucket Hetzner shows late, and the next run plans only what is left", async () => {
    const storage = bucketEngine("hetzner", {
      changes: [...bucketChanges("hetzner"), CORS_CHANGE],
      applyOk: false,
      applyLog: LATE_LOG,
    });
    const f = await flow({
      plan: withBucket(testPlan(), "hetzner"),
      storage,
      env: KEY_ENV,
    });
    // The failed create left the bucket in the state, tainted.
    await writeStorageState(f, [BUCKET_IN_STATE]);
    await expect(runProvision(f.deps, { services: f.services })).rejects.toMatchObject(SHOWN_LATE);
    expect(storage.untainted).toEqual(["aws_s3_bucket.this"]);
    expect(storage.imports).toEqual([]);
    expect(storage.calls).toEqual(["init", "validate", "plan", "apply", "untaint"]);
    // The untaint reads the root's state with the same key as the apply.
    expect(f.engine.storageEnvs.at(-1)?.AWS_SECRET_ACCESS_KEY).toBe(KEY.secretAccessKey);
    expect(f.main.calls).toEqual([]);
    expect(await markerLeft(f)).toBeUndefined();

    // The bucket is no longer tainted, so the next plan only adds its CORS rule, which is applied
    // only through its own approval.
    await expectRerunPlansOnlyCors(f, storage);
    expect(storage.untainted).toHaveLength(1);
  });

  it("records a new bucket Hetzner shows late that never reached the state, and the next run plans only what is left", async () => {
    const storage = bucketEngine("hetzner", {
      changes: [...bucketChanges("hetzner"), CORS_CHANGE],
      applyOk: false,
      applyLog: LATE_LOG,
    });
    const f = await flow({ plan: withBucket(testPlan(), "hetzner"), storage, env: KEY_ENV });
    // The failed create left a state without the bucket.
    await writeStorageState(f, []);
    await expect(runProvision(f.deps, { services: f.services })).rejects.toMatchObject(SHOWN_LATE);
    expect(storage.untainted).toEqual([]);
    expect(storage.imports).toEqual([
      {
        address: "aws_s3_bucket.this",
        id: "shop-uploads",
        env: expect.objectContaining({ AWS_SECRET_ACCESS_KEY: KEY.secretAccessKey }),
      },
    ]);
    expect(storage.calls).toEqual(["init", "validate", "plan", "apply", "import"]);
    expect(f.main.calls).toEqual([]);
    expect(await markerLeft(f)).toBeUndefined();

    await expectRerunPlansOnlyCors(f, storage);
    expect(storage.imports).toHaveLength(1);
    const printed = await leaks(f);
    expect(printed).not.toContain(KEY.secretAccessKey);
    expect(printed).not.toContain(KEY.accessKeyId);
  });

  it("waits with provision's own sleep between imports while Hetzner cannot read the bucket", async () => {
    const storage = bucketEngine("hetzner", {
      applyOk: false,
      applyLog: LATE_LOG,
      importErrors: [NOT_READABLE, NOT_READABLE],
    });
    const sleeps: number[] = [];
    const f = await flow({
      plan: withBucket(testPlan(), "hetzner"),
      storage,
      env: KEY_ENV,
      services: {
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    });
    await expect(runProvision(f.deps, { services: f.services })).rejects.toMatchObject(SHOWN_LATE);
    expect(storage.imports).toHaveLength(3);
    expect(sleeps).toEqual([10_000, 10_000]);
    expect(storage.applied).toHaveLength(1);
  });

  it("leaves any other failed apply of the bucket as it is", async () => {
    const storage = bucketEngine("hetzner", {
      applyOk: false,
      applyLog:
        "Error: creating S3 Bucket (shop-uploads): operation error S3: CreateBucket, https response error StatusCode: 503, api error ServiceUnavailable",
    });
    const f = await flow({ plan: withBucket(testPlan(), "hetzner"), storage, env: KEY_ENV });
    await expect(runProvision(f.deps, { services: f.services })).rejects.toMatchObject({
      code: "ENGINE_FAILED",
      message: expect.stringContaining("ServiceUnavailable"),
    });
    expect(storage.untainted).toEqual([]);
    expect(storage.imports).toEqual([]);
    expect(storage.calls).not.toContain("untaint");
  });

  it("changes no file and asks nothing new when run again with nothing changed (SC-1307)", async () => {
    const storage = bucketEngine("hetzner");
    const f = await flow({ plan: withBucket(testPlan(), "hetzner"), storage, env: KEY_ENV });
    await runProvision(f.deps, { services: f.services });
    const head = await f.git(f.root, "rev-parse", "HEAD");
    const status = await f.git(f.root, "status", "--porcelain");
    const key = await readTextIfExists(storageKeyFile(f.deps.paths));
    // Nothing changed: the bucket's plan and the infrastructure's find nothing to do, and the
    // first run's pull request is still open.
    storage.scenario.changes = [];
    f.main.scenario.changes = [];
    f.github.openPulls.set(DEPLOY_SETUP_BRANCH, OPEN_PULL);
    const before = f.handler.requests.length;
    await runProvision(f.deps, { services: f.services });
    expect(await f.git(f.root, "rev-parse", "HEAD")).toBe(head);
    expect(await f.git(f.root, "status", "--porcelain")).toBe(status);
    expect(await readTextIfExists(storageKeyFile(f.deps.paths))).toBe(key);
    const again = f.handler.requests.slice(before).map((r) => r.kind);
    expect(again).not.toContain("repo-write");
    expect(again).not.toContain("iac-apply");
  });
});

describe.skipIf(!findExecutable("git"))("the import of a late bucket the state lacks", () => {
  /** The bucket's apply failing to read it back, with no state yet; imports fail with `importErrors`. */
  async function lateApply(importErrors: string[]) {
    const plan = withBucket(testPlan(), "hetzner");
    const storage = bucketEngine("hetzner", { applyOk: false, applyLog: LATE_LOG, importErrors });
    const f = await flow({ plan, storage, env: KEY_ENV });
    const sleeps: number[] = [];
    const applied = applyStorage(f.deps, {
      engine: f.engine,
      env: f.deps.env,
      plan,
      files: [],
      key: KEY,
      command: "opscrew provision",
      phase: "provision",
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    return { f, storage, sleeps, applied };
  }

  it("tries again every 10 s while Hetzner cannot read the bucket yet", async () => {
    const { storage, sleeps, applied } = await lateApply([NOT_READABLE, NOT_READABLE]);
    await expect(applied).rejects.toMatchObject(SHOWN_LATE);
    expect(storage.imports.map((i) => `${i.address} ${i.id}`)).toEqual([
      "aws_s3_bucket.this shop-uploads",
      "aws_s3_bucket.this shop-uploads",
      "aws_s3_bucket.this shop-uploads",
    ]);
    expect(sleeps).toEqual([10_000, 10_000]);
    expect(storage.applied).toHaveLength(1);
  });

  it("stops after about a minute, saying the next run finds the bucket", async () => {
    const { f, storage, sleeps, applied } = await lateApply(Array(7).fill(NOT_READABLE));
    await expect(applied).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
      message:
        "Hetzner Object Storage did not show the new bucket shop-uploads within a minute, so OpsCrew could not record it in the bucket's state yet. The bucket exists; nothing else was changed.",
      hint: "Wait a few minutes, then run `opscrew provision` again: OpsCrew then finds the bucket and keeps it.",
    });
    expect(storage.imports).toHaveLength(7);
    expect(sleeps).toEqual(Array(6).fill(10_000));
    expect(storage.applied).toHaveLength(1);
    expect(await leaks(f)).not.toContain(KEY.secretAccessKey);
  });

  it("stops at any other failed import with the engine's words", async () => {
    const { storage, sleeps, applied } = await lateApply(["Error: Failed to load state"]);
    await expect(applied).rejects.toMatchObject({
      code: "ENGINE_FAILED",
      message: expect.stringContaining("Failed to load state"),
    });
    expect(storage.imports).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });
});

const OFFSITE_KEY = {
  accessKeyId: fakeSecret("aws-access-key-id", "offsite"),
  secretAccessKey: fakeSecret("aws-secret-access-key", "offsite"),
};
const OFFSITE_ENV = {
  [OFFSITE_KEY_VARS.accessKeyId]: OFFSITE_KEY.accessKeyId,
  [OFFSITE_KEY_VARS.secretAccessKey]: OFFSITE_KEY.secretAccessKey,
};

/** `plan` with the off-server copies of its snapshots in `offsite`'s bucket. */
function withOffsite(
  plan: DeployPlan,
  offsite: NonNullable<DeployPlan["snapshots"]>["offsite"],
): DeployPlan {
  return DeployPlanSchema.parse({ ...plan, snapshots: { offsite } });
}
const HETZNER_OFFSITE = { provider: "hetzner", bucket: "shop-backups", region: "nbg1" } as const;

describe("the off-server copies' bucket: its key, engine environment and values", () => {
  const plan = () => withOffsite(testPlan(), HETZNER_OFFSITE);

  it("reads its own key from its own variables, keeps an asked one beside the app's, and stops without one", async () => {
    const fromEnv = await createTestPhaseDeps({ env: OFFSITE_ENV });
    await expect(
      requireOffsiteKey(fromEnv, plan(), {}, { command: "opscrew provision" }),
    ).resolves.toEqual(OFFSITE_KEY);
    // The app's bucket's variables never stand in for it.
    const appOnly = await createTestPhaseDeps({ env: KEY_ENV });
    const stop = requireOffsiteKey(appOnly, plan(), {}, { command: "opscrew provision" });
    await expect(stop).rejects.toMatchObject({
      code: "CREDENTIALS_MISSING",
      message:
        "The off-server copies' bucket shop-backups on Hetzner Object Storage needs a key you create in the provider's console; OpsCrew never creates one. Nothing was changed.",
      hint: expect.stringContaining(
        `or set ${OFFSITE_KEY_VARS.accessKeyId} and ${OFFSITE_KEY_VARS.secretAccessKey} to it`,
      ),
    });
    await expect(stop).rejects.toMatchObject({
      hint: expect.stringContaining("with the description opscrew-shop-backups"),
    });

    const asked: StorageKeyQuestion[] = [];
    const d = await createTestPhaseDeps({ env: {}, interactive: true });
    const services = {
      askStorageKey: async (question: StorageKeyQuestion) => {
        asked.push(question);
        return OFFSITE_KEY;
      },
    };
    await requireStorageKey(
      d,
      withBucket(plan(), "hetzner"),
      { askStorageKey: async () => KEY },
      { command: "x" },
    );
    await expect(requireOffsiteKey(d, plan(), services, { command: "x" })).resolves.toEqual(
      OFFSITE_KEY,
    );
    await expect(requireOffsiteKey(d, plan(), services, { command: "x" })).resolves.toEqual(
      OFFSITE_KEY,
    );
    expect(asked.map((q) => q.bucket)).toEqual(["shop-backups"]);
    const kept = (await readTextIfExists(storageKeyFile(d.paths)))?.trim().split("\n") ?? [];
    expect(kept.map((line) => JSON.parse(line).bucket)).toEqual(["shop-uploads", "shop-backups"]);
    expect(d.redactor.redact(OFFSITE_KEY.secretAccessKey)).not.toContain(
      OFFSITE_KEY.secretAccessKey,
    );
  });

  it("gives the backups root only its own key at Hetzner and Spaces, and Cloudflare's token for R2", () => {
    const env = { PATH: "/usr/bin", AWS_PROFILE: "work", CLOUDFLARE_API_TOKEN: "cf" };
    expect(backupsEngineEnv(env, plan(), OFFSITE_KEY)).toEqual({
      PATH: "/usr/bin",
      CLOUDFLARE_API_TOKEN: "cf",
      AWS_ACCESS_KEY_ID: OFFSITE_KEY.accessKeyId,
      AWS_SECRET_ACCESS_KEY: OFFSITE_KEY.secretAccessKey,
      AWS_CONFIG_FILE: devNull,
      AWS_SHARED_CREDENTIALS_FILE: devNull,
    });
    const r2 = withOffsite(testPlan(), { provider: "r2", bucket: "shop-backups" });
    expect(backupsEngineEnv(env, r2, undefined)).toEqual(env);
  });

  it("gives the off-server copy its endpoint, its key and the recipient, as the env file's lines", () => {
    const recipient = generateAgeIdentity().recipient;
    const values = offsiteValues(plan(), { key: OFFSITE_KEY, recipient, cloudflare: undefined });
    expect(values).toEqual({
      OPSCREW_OFFSITE_ENDPOINT: "https://nbg1.your-objectstorage.com",
      OPSCREW_OFFSITE_ACCESS_KEY_ID: OFFSITE_KEY.accessKeyId,
      OPSCREW_OFFSITE_SECRET_ACCESS_KEY: OFFSITE_KEY.secretAccessKey,
      OPSCREW_OFFSITE_RECIPIENT: recipient,
    });
    expect(offsiteEnvFile(values)).toBe(
      `${Object.entries(values)
        .map(([name, value]) => `${name}=${value}`)
        .join("\n")}\n`,
    );
    const spaces = withOffsite(testPlan(), {
      provider: "digitalocean",
      bucket: "shop-backups",
      region: "ams3",
    });
    expect(
      offsiteValues(spaces, { key: OFFSITE_KEY, recipient, cloudflare: undefined }),
    ).toMatchObject({ OPSCREW_OFFSITE_ENDPOINT: "https://ams3.digitaloceanspaces.com" });
    const r2 = withOffsite(testPlan(), { provider: "r2", bucket: "shop-backups" });
    const r2Values = offsiteValues(r2, {
      key: OFFSITE_KEY,
      recipient,
      cloudflare: { accountId: "0123abcd" },
    });
    expect(r2Values.OPSCREW_OFFSITE_ENDPOINT).toBe("https://0123abcd.r2.cloudflarestorage.com");
  });

  it("refuses the off-server copies on R2 without a domain on Cloudflare", () => {
    const r2 = withOffsite(testPlan(), { provider: "r2", bucket: "shop-backups" });
    expect(() => requireR2Cloudflare(r2, undefined)).toThrow(
      "opscrew/plan.yaml keeps the off-server copies of the app's snapshots on Cloudflare R2, but the app has no domain on Cloudflare",
    );
    expect(() => requireR2Cloudflare(plan(), undefined)).not.toThrow();
  });
});

/** One engine for the `backups` root's fake (`backups`) and every other root's (`others`). */
class BackupsRootEngine implements IacEngine {
  readonly info = { name: "tofu" as const, version: "1.13.1", binary: "/fake/tofu" };
  /** The environment of every call into the `backups` root. */
  readonly backupsEnvs: Record<string, string | undefined>[] = [];

  constructor(
    readonly others: IacEngine,
    readonly backups: FakeEngine,
  ) {}

  #pick(dir: string, options?: IacRunOptions): IacEngine {
    if (!/[\\/]backups$/.test(dir)) return this.others;
    if (options?.env !== undefined) this.backupsEnvs.push(options.env);
    return this.backups;
  }

  init(dir: string, options?: IacInitOptions) {
    return this.#pick(dir, options).init(dir, options);
  }
  validate(dir: string, options?: IacRunOptions) {
    return this.#pick(dir, options).validate(dir, options);
  }
  plan(dir: string, planFile: string, options?: IacRunOptions & { destroy?: boolean }) {
    return this.#pick(dir, options).plan(dir, planFile, options);
  }
  apply(dir: string, planFile: string, approval: IacApproval, options?: IacRunOptions) {
    return this.#pick(dir, options).apply(dir, planFile, approval, options);
  }
  output(dir: string, options?: IacRunOptions) {
    return this.#pick(dir, options).output(dir, options);
  }
  providerSchemas(dir: string, options?: IacRunOptions) {
    return this.#pick(dir, options).providerSchemas(dir, options);
  }
  stateResources(stateFile: string, options?: IacRunOptions) {
    return (/backups\.tfstate$/.test(stateFile) ? this.backups : this.others).stateResources(
      stateFile,
      options,
    );
  }
  untaint(dir: string, address: string, options?: IacRunOptions) {
    return this.#pick(dir, options).untaint(dir, address, options);
  }
  stateRemove(dir: string, addresses: readonly string[], options?: IacRunOptions) {
    return this.#pick(dir, options).stateRemove(dir, addresses, options);
  }
  importResource(dir: string, address: string, id: string, options?: IacRunOptions) {
    return this.#pick(dir, options).importResource(dir, address, id, options);
  }
}

/**
 * A provision of `plan` whose sops is the fake and whose first age key goes to a file of the
 * test's: the approvals in order, how many times sops ran when the deploy secrets were approved,
 * and every file committed on any branch.
 */
async function offsiteFlow(
  plan: DeployPlan,
  o: { keyOut?: boolean; refuseSecrets?: () => boolean } = {},
) {
  const sops = new FakeSops();
  let sopsAtSecrets: number | undefined;
  const f = await flow({
    plan,
    storage: bucketEngine("hetzner"),
    env: { ...OFFSITE_ENV, OPSCREW_SOPS_BIN: FAKE_SOPS },
    runner: sops.runner(projectRunner()),
    answer: (request) => {
      if (request.kind !== "github-secrets") return true;
      sopsAtSecrets = sops.calls.length;
      return o.refuseSecrets?.() !== true;
    },
  });
  const backups = bucketEngine("hetzner");
  const engine = new BackupsRootEngine(f.engine, backups);
  f.services.engine = async () => engine;
  const keyOut = join(await mkdtemp(join(tmpdir(), "opscrew-offsite-key-")), "age-key.txt");
  const run = (options: Partial<ProvisionOptions> = {}) =>
    runProvision(f.deps, {
      services: f.services,
      ...(o.keyOut === false ? {} : { recovery: { keyOut: async () => keyOut } }),
      ...options,
    });
  const committed = async () =>
    (await f.git(f.root, "log", "--all", "--name-only", "--format="))
      .split("\n")
      .filter((line) => line !== "")
      .sort();
  return { f, sops, backups, engine, keyOut, run, committed, sopsAtSecrets: () => sopsAtSecrets };
}

describe.skipIf(!findExecutable("git"))("provision with the off-server copy (024 US6)", () => {
  it("plans its bucket in a root of its own, approved by its hash, with only its own key", async () => {
    const o = await offsiteFlow(withOffsite(testPlan(), HETZNER_OFFSITE));
    const result = await o.run();

    const applies = o.f.handler.requests.filter((r) => r.kind === "iac-apply");
    expect(applies.map((r) => r.title)).toEqual([
      "Apply the plan of the off-server copies' bucket shop-backups on Hetzner Object Storage",
      expect.stringContaining("Apply the infrastructure plan on Hetzner"),
    ]);
    // Hetzner's base price, which the bucket adds at least, from the storage price data; never the
    // deployment's monthly cost (the live pass printed it for this plan, 2026-11-07).
    expect(applies[0]?.costDelta).toEqual({ amount: 6.49, currency: "EUR" });
    const base = STORAGE_PRICES.hetzner.monthlyPrice({ storageGb: 0, egressGbPerMonth: 0 });
    expect(applies[0]?.details).toContain(
      `Estimated cost: €6.49 per month for what this plan creates (from ${base.source}, checked on ${base.checkedOn}).`,
    );
    expect(applies[0]?.details).not.toContain(formatMoney(testPlan().cost.monthly));
    expect(result.backupsPlanHash).toBe(applies[0]?.planHash);
    expect(result.storagePlanHash).toBeUndefined();
    expect(o.backups.calls).toEqual(["init", "validate", "plan", "apply"]);
    expect(o.backups.initOptions?.backendConfig?.path).toBe(backupsStateFile(o.f.deps.paths));
    expect(o.backups.applied[0]?.planFile.endsWith(BACKUPS_PLAN_SUFFIX)).toBe(true);
    for (const env of o.engine.backupsEnvs) {
      expect(env.AWS_ACCESS_KEY_ID).toBe(OFFSITE_KEY.accessKeyId);
      expect(env.AWS_SECRET_ACCESS_KEY).toBe(OFFSITE_KEY.secretAccessKey);
      expect(env.AWS_PROFILE).toBeUndefined();
    }
    expect(await readTextIfExists(backupsCreateFile(o.f.deps.paths))).toBeUndefined();
    const main = await readTextIfExists(join(o.f.root, "opscrew/infra/backups/main.tf"));
    expect(main).toContain('resource "aws_s3_bucket_lifecycle_configuration" "this"');
    // The server's offsite.env goes in a deploy secret of its own, with the bucket's key.
    const recipient = (await readRecord(o.f.deps.paths)).recipients?.[0];
    expect(o.f.github.secrets.get("OPSCREW_OFFSITE_ENV")).toBe(
      [
        "OPSCREW_OFFSITE_ENDPOINT=https://nbg1.your-objectstorage.com",
        `OPSCREW_OFFSITE_ACCESS_KEY_ID=${OFFSITE_KEY.accessKeyId}`,
        `OPSCREW_OFFSITE_SECRET_ACCESS_KEY=${OFFSITE_KEY.secretAccessKey}`,
        `OPSCREW_OFFSITE_RECIPIENT=${recipient}`,
        "",
      ].join("\n"),
    );
    const printed = await leaks(o.f);
    expect(printed).not.toContain(OFFSITE_KEY.secretAccessKey);
    expect(printed).not.toContain(OFFSITE_KEY.accessKeyId);
  });

  it("makes the recovery copy's age key before the deploy secrets on the first provision, and commits that copy", async () => {
    const o = await offsiteFlow(withOffsite(testPlan(), HETZNER_OFFSITE));
    await o.run();
    // The copy was made once, before the secrets were approved, and committed as it was made.
    expect(o.sopsAtSecrets()).toBe(1);
    expect(o.sops.calls).toHaveLength(1);
    const files = await o.committed();
    for (const file of [".gitattributes", "opscrew/.sops.yaml", "opscrew/secrets.sops.json"]) {
      expect(files).toContain(file);
    }
    // No file in the repository holds the private key.
    const identity = (await readFile(o.keyOut, "utf8")).split("\n")[2] as string;
    expect(identity).toMatch(/^AGE-SECRET-KEY-/);
    expect(await leaks(o.f)).not.toContain(identity);
  });

  it("stops before any change when no age key can be made", async () => {
    const o = await offsiteFlow(withOffsite(testPlan(), HETZNER_OFFSITE), { keyOut: false });
    await expect(o.run()).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      message:
        "The off-server copies of the app's snapshots are encrypted to the age key of its recovery copy, and there is none yet. Nothing was changed.",
      hint: expect.stringContaining("--key-out <path>"),
    });
    expect(o.f.handler.requests).toEqual([]);
    expect(o.backups.calls).toEqual([]);
    expect(o.f.main.applied).toEqual([]);
    expect(o.f.github.secrets.size).toBe(0);
  });

  it("runs again after a first provision that stopped once it made the age key, to the same recipient", async () => {
    let refuse = true;
    const o = await offsiteFlow(withOffsite(testPlan(), HETZNER_OFFSITE), {
      refuseSecrets: () => refuse,
    });
    await expect(o.run()).rejects.toMatchObject({ code: "APPROVAL_REFUSED" });
    // The key exists, but no .sops.yaml reached the checkout: the record keeps its recipient.
    const identity = (await readFile(o.keyOut, "utf8")).split("\n")[2] as string;
    const recipient = ageRecipientOf(identity);
    expect(await readTextIfExists(join(o.f.root, "opscrew/.sops.yaml"))).toBeUndefined();
    expect((await readRecord(o.f.deps.paths)).recipients).toEqual([recipient]);

    refuse = false;
    await o.run();
    expect(o.f.handler.requests.filter((r) => r.kind === "github-secrets")).toHaveLength(2);
    const sopsYaml = await o.f.git(o.f.root, "show", "opscrew/deploy-setup:opscrew/.sops.yaml");
    expect(sopsYaml).toContain(`age: ${recipient}`);
    expect(await o.committed()).toContain("opscrew/secrets.sops.json");
    // The second copy is encrypted to that recipient too, and no second key was made.
    expect(o.sops.calls).toHaveLength(2);
    expect(o.sops.calls[1]?.args).toContain(recipient);
  });

  it("--plan-only shows the backups plan's hash, and --approve applies it as that root's", async () => {
    const o = await offsiteFlow(withOffsite(testPlan(), HETZNER_OFFSITE));
    const planned = await o.run({ planOnly: true });
    expect(planned.backupsPlanHash).toMatch(/^[0-9a-f]{64}$/);
    expect(o.backups.applied).toHaveLength(0);
    const saved = await findSavedPlan(o.f.deps.paths.files.plansDir, planned.backupsPlanHash ?? "");
    expect(saved?.planFile.endsWith(BACKUPS_PLAN_SUFFIX)).toBe(true);
    await o.run({ approveHashes: [planned.backupsPlanHash ?? "", planned.planHash ?? ""] });
    expect(o.backups.applied[0]?.approval.approvedPlanHash).toBe(planned.backupsPlanHash);
    expect(o.f.main.applied[0]?.approval.approvedPlanHash).toBe(planned.planHash);
  });

  it("changes nothing without the off-server copy: the same approvals in the same order, the same files, the copy made at publish", async () => {
    const without = await offsiteFlow(testPlan());
    const plain = await without.run();
    const withCopy = await offsiteFlow(withOffsite(testPlan(), HETZNER_OFFSITE));
    await withCopy.run();
    // The same approvals, but the backups root's, its four files to write and its env file's
    // secret.
    const kinds = (o: typeof without) =>
      o.f.handler.requests.map(
        (r) =>
          `${r.kind} ${r.title.replace(/\(\d+ new files\)/, "(N new files)").replace(/Store \d+ /, "Store N ")}`,
      );
    expect(kinds(withCopy).filter((k) => !k.includes("off-server copies"))).toEqual(kinds(without));
    const written = (o: typeof without) =>
      Number(
        o.f.handler.requests
          .find((r) => r.kind === "repo-write")
          ?.title.match(/\((\d+) new files\)/)?.[1],
      );
    expect(written(withCopy)).toBe(written(without) + 4);
    expect([...withCopy.f.github.secrets.keys()].sort()).toEqual(
      [...without.f.github.secrets.keys(), "OPSCREW_OFFSITE_ENV"].sort(),
    );
    expect(plain.backupsPlanHash).toBeUndefined();
    expect(without.backups.calls).toEqual([]);
    // The recovery copy is made when the pull request is, after the secrets, as before.
    expect(without.sopsAtSecrets()).toBe(0);
    expect(without.sops.calls).toHaveLength(1);
    const files = await without.committed();
    expect((await withCopy.committed()).filter((file) => !file.includes("/backups/"))).toEqual(
      files,
    );
    expect(files.some((file) => file.includes("/backups/"))).toBe(false);
    expect(await readTextIfExists(join(without.f.root, "opscrew/infra/backups/main.tf"))).toBe(
      undefined,
    );
  });
});

describe.skipIf(!findExecutable("git"))(
  "provision with a bucket in Contabo's storage (R15)",
  () => {
    const contabo = () => withBucket(testPlan({ provider: "contabo" }), "contabo");
    const record = async (f: Flow) =>
      JSON.parse((await readTextIfExists(orderedStorageFile(f.deps.paths))) ?? "null");
    const contaboFlow = (objectStorage: FakeObjectStorage, o: Partial<FlowOptions> = {}) =>
      flow({
        plan: contabo(),
        storage: bucketEngine("contabo"),
        services: { objectStorage },
        ...o,
      });

    it("orders the storage through its own approved plan, then the bucket with the key Contabo made", async () => {
      const objectStorage = new FakeObjectStorage();
      const f = await contaboFlow(objectStorage);
      const result = await runProvision(f.deps, { services: f.services });

      const applies = f.handler.requests.filter((r) => r.kind === "iac-apply");
      expect(applies.map((r) => r.title).slice(0, 2)).toEqual([
        "Order Contabo Object Storage in EU for the app's bucket shop-uploads",
        "Apply the plan of the app's bucket shop-uploads on Contabo Object Storage",
      ]);
      const order = applies[0];
      expect(order?.planHash).toMatch(/^[0-9a-f]{64}$/);
      expect(order?.costDelta).toEqual({ amount: 2.49, currency: "EUR" });
      expect(order?.details).toContain("order Contabo Object Storage in EU through Contabo's API");
      expect(order?.details).toContain(
        "effective at the next possible date: Contabo bills it until then",
      );
      expect(order?.details).toContain(`Order plan hash: ${order?.planHash}`);
      expect(objectStorage.orders).toEqual([
        { region: "EU", sizeTb: 0.25, displayName: "opscrew-shop" },
      ]);
      expect(await record(f)).toMatchObject({
        storageId: "os-1",
        s3Url: CONTABO_S3_URL,
        ordered: true,
      });
      expect(result.storagePlanHash).toBe(applies[1]?.planHash);

      // The key reaches the engine only as the aws provider's variables, with the storage's endpoint.
      const key = objectStorage.madeKey;
      expect(f.engine.storageEnvs.length).toBeGreaterThan(0);
      for (const env of f.engine.storageEnvs) {
        expect(env.AWS_ACCESS_KEY_ID).toBe(key.accessKeyId);
        expect(env.AWS_SECRET_ACCESS_KEY).toBe(key.secretAccessKey);
        expect(env.TF_VAR_endpoint).toBe(CONTABO_S3_URL);
        expect(env.AWS_PROFILE).toBeUndefined();
      }
      // The app receives it with the storage's endpoint.
      const appEnv = f.github.secrets.get("OPSCREW_APP_ENV") ?? "";
      expect(appEnv).toContain(`AWS_SECRET_ACCESS_KEY=${key.secretAccessKey}`);
      expect(appEnv).toContain(`AWS_ENDPOINT_URL_S3=${CONTABO_S3_URL}`);
      // Never kept in OpsCrew's key file, printed, audited or written into the repository.
      await expect(readTextIfExists(storageKeyFile(f.deps.paths))).resolves.toBeUndefined();
      const printed = await leaks(f);
      expect(printed).not.toContain(key.secretAccessKey);
      expect(printed).not.toContain(key.accessKeyId);
      expect(await readTextIfExists(join(f.root, "opscrew/infra/storage/variables.tf"))).toContain(
        'variable "endpoint"',
      );
    });

    it("reuses the account's storage in the region, records it as not OpsCrew's, and orders nothing", async () => {
      const objectStorage = new FakeObjectStorage([
        { id: "mine", region: "EU", s3Url: CONTABO_S3_URL },
      ]);
      const f = await contaboFlow(objectStorage);
      await runProvision(f.deps, { services: f.services });
      expect(objectStorage.orders).toEqual([]);
      expect(f.handler.requests.some((r) => r.title.startsWith("Order "))).toBe(false);
      expect(await record(f)).toMatchObject({ storageId: "mine", ordered: false });
      expect(objectStorage.keysRead).toContain("mine");
      expect(f.deps.reporter.text()).toContain(
        "The app's bucket goes into your Contabo Object Storage in EU (mine), which OpsCrew did not order: it never cancels it.",
      );
    });

    it("takes a storage an interrupted order left as OpsCrew's", async () => {
      const objectStorage = new FakeObjectStorage([
        { id: "late", region: "EU", s3Url: CONTABO_S3_URL },
      ]);
      const f = await contaboFlow(objectStorage);
      const file = orderedStorageFile(f.deps.paths);
      await mkdir(dirname(file), { recursive: true });
      const pending = { provider: "contabo", region: "EU", ordered: true, at: "x" };
      await writeFile(file, JSON.stringify(pending));
      await runProvision(f.deps, { services: f.services });
      expect(objectStorage.orders).toEqual([]);
      expect(await record(f)).toMatchObject({ storageId: "late", ordered: true });
    });

    it("with --plan-only shows the order and returns its hash, ordering and planning no bucket", async () => {
      const objectStorage = new FakeObjectStorage();
      const f = await contaboFlow(objectStorage);
      const result = await runProvision(f.deps, { services: f.services, planOnly: true });
      expect(objectStorage.orders).toEqual([]);
      expect(f.engine.storage.calls).toEqual([]);
      expect(result.storagePlanHash).toMatch(/^[0-9a-f]{64}$/);
      expect(f.deps.reporter.text()).toContain(`Order plan hash: ${result.storagePlanHash}`);
      await expect(readTextIfExists(orderedStorageFile(f.deps.paths))).resolves.toBeUndefined();
    });

    it("orders nothing when the order is refused", async () => {
      const objectStorage = new FakeObjectStorage();
      const f = await contaboFlow(objectStorage, {
        answer: (request) => !request.title.startsWith("Order "),
      });
      await expect(runProvision(f.deps, { services: f.services })).rejects.toMatchObject({
        code: "APPROVAL_REFUSED",
        message: expect.stringContaining("Nothing was ordered."),
      });
      expect(objectStorage.orders).toEqual([]);
      expect(f.engine.storage.calls).toEqual([]);
    });

    it("stops before any change when the storage in the region is cancelled", async () => {
      const objectStorage = new FakeObjectStorage([
        { id: "old", region: "EU", s3Url: CONTABO_S3_URL, cancelledUntil: "2026-12-01" },
      ]);
      const f = await contaboFlow(objectStorage);
      await expect(runProvision(f.deps, { services: f.services })).rejects.toMatchObject({
        code: "PHASE_PRECONDITION",
        message: expect.stringContaining("is cancelled and ends on 2026-12-01"),
      });
      expect(objectStorage.orders).toEqual([]);
    });
  },
);

describe("the key of a bucket in Contabo's storage", () => {
  it("is read through Contabo's API with its endpoint, never asked for or kept", async () => {
    const d = await createTestPhaseDeps({ env: {}, interactive: true });
    const objectStorage = new FakeObjectStorage([
      { id: "s1", region: "EU", s3Url: CONTABO_S3_URL },
    ]);
    const asked: StorageKeyQuestion[] = [];
    const askStorageKey = async (question: StorageKeyQuestion) => {
      asked.push(question);
      return objectStorage.madeKey;
    };
    const plan = withBucket(testPlan(), "contabo");
    const key = await requireStorageKey(
      d,
      plan,
      { objectStorage, askStorageKey },
      { command: "opscrew drift", asks: false },
    );
    expect(key).toEqual({ ...objectStorage.madeKey, endpoint: CONTABO_S3_URL });
    expect(asked).toEqual([]);
    await expect(readTextIfExists(storageKeyFile(d.paths))).resolves.toBeUndefined();
    expect(d.redactor.redact(objectStorage.madeKey.secretAccessKey)).not.toContain(
      objectStorage.madeKey.secretAccessKey,
    );
    // Drift's and destroy's engine gets the endpoint with the key.
    const env = storageEngineEnv({}, plan, key);
    expect(env.TF_VAR_endpoint).toBe(CONTABO_S3_URL);
    expect(env.AWS_SECRET_ACCESS_KEY).toBe(objectStorage.madeKey.secretAccessKey);
  });

  it("stops plainly while there is no storage yet", async () => {
    const d = await createTestPhaseDeps({ env: {} });
    await expect(
      requireStorageKey(
        d,
        withBucket(testPlan(), "contabo"),
        { objectStorage: new FakeObjectStorage() },
        { command: "opscrew drift" },
      ),
    ).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      message: expect.stringContaining("needs Contabo Object Storage in EU, and there is none yet"),
    });
  });
});
