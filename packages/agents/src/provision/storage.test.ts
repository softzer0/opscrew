import { mkdir, stat, writeFile } from "node:fs/promises";
import { devNull } from "node:os";
import { dirname, join } from "node:path";
import { FakeZone } from "@opscrew/connector-cloudflare/testing";
import { findExecutable, OpsCrewError, readTextIfExists } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import type { DeployPlan } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import {
  createProject,
  createTestPhaseDeps,
  FakeEngine,
  FakeGitHub,
  fakeCloudflare,
  fakeSharedCloudflare,
  projectRunner,
  readyRemote,
  ScriptedApprovalHandler,
  testPlan,
} from "../testing";
import { bucketEngine, RootEngine, withBucket } from "./__fixtures__/storage";
import { findSavedPlan } from "./plan-apply";
import { DEPLOY_SETUP_BRANCH } from "./publish";
import { runProvision } from "./run";
import {
  requireR2Cloudflare,
  requireStorageKey,
  STORAGE_KEY_VARS,
  STORAGE_PLAN_SUFFIX,
  type StorageKeyQuestion,
  storageEngineEnv,
  storageKeyFile,
  storageLogin,
  storageStateFile,
} from "./storage";
import type { ProvisionServices } from "./types";

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
    runner: projectRunner(),
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

    // The same script again after a half-finished run: the bucket's applied plan is never applied
    // twice; its root is planned afresh and finds nothing to change.
    f.engine.storage.scenario.changes = [];
    f.github.openPulls.set(DEPLOY_SETUP_BRANCH, OPEN_PULL);
    await runProvision(f.deps, { services: f.services, approveHashes: approved });
    expect(f.engine.storage.calls.filter((c) => c === "plan")).toHaveLength(2);
    expect(f.engine.storage.applied).toHaveLength(1);
  });

  it("names storage.objectStorage.bucket when the provider says the name is taken", async () => {
    const f = await flow({
      plan: withBucket(testPlan(), "hetzner"),
      storage: bucketEngine("hetzner", {
        applyOk: false,
        applyLog:
          "Error: creating S3 Bucket (shop-uploads): operation error S3: CreateBucket, https response error StatusCode: 409, api error BucketAlreadyExists: The requested bucket name is not available.",
      }),
      env: KEY_ENV,
    });
    await expect(runProvision(f.deps, { services: f.services })).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      message:
        "Hetzner Object Storage says the bucket name shop-uploads is taken: bucket names there are shared by all its customers (or another bucket of yours has it). Nothing else was changed.",
      hint: expect.stringContaining(
        "Change storage.objectStorage.bucket in opscrew/plan.yaml to another name",
      ),
    });
    expect(f.main.calls).toEqual([]);
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
