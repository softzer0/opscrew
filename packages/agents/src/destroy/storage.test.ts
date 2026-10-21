import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ApprovalRequest, FetchLike } from "@opscrew/contracts";
import { findExecutable, readTextIfExists } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { renderStorage } from "@opscrew/iac-templates";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import {
  bucketChanges,
  bucketEngine,
  RootEngine,
  withBucket,
} from "../provision/__fixtures__/storage";
import { STORAGE_KEY_VARS, storageStateFile } from "../provision/storage";
import { ensureStatePassphrase } from "../shared";
import {
  createProject,
  createTestPhaseDeps,
  FakeDestroyGitHub,
  FakeServers,
  fakeCloudflare,
  projectRunner,
  ScriptedApprovalHandler,
  ScriptedDestroyEngine,
  testPlan,
} from "../testing";
import { serverData } from "./checks";
import { runDestroy } from "./run";
import type { DestroyServices } from "./types";

const KEY = {
  [STORAGE_KEY_VARS.accessKeyId]: fakeSecret("aws-access-key-id", "destroy"),
  [STORAGE_KEY_VARS.secretAccessKey]: fakeSecret("aws-secret-access-key", "destroy"),
};

function deployed(plan: DeployPlan): DeployPlan {
  return {
    ...plan,
    deployment: {
      lastPlanHash: "a".repeat(64),
      lastApplyAt: "2026-10-10T09:00:00.000Z",
    },
  };
}

/** A deployed Hetzner app whose bucket was created; the destroy engines are faked per root. */
async function setup(o: {
  plan: DeployPlan;
  storage: ReturnType<typeof bucketEngine>;
  env?: Record<string, string | undefined>;
}) {
  const project = await createProject(o.plan);
  const main = new ScriptedDestroyEngine();
  const engine = new RootEngine(main, o.storage);
  const github = new FakeDestroyGitHub();
  for (const name of ["OPSCREW_APP_ENV", "OPSCREW_SERVICE_DB_ENV", "OPSCREW_SERVICE_MYSQL_ENV"]) {
    github.secrets.set(name, "stored");
  }
  const handler = new ScriptedApprovalHandler(() => true);
  const env: Record<string, string | undefined> = {
    ...process.env,
    OPSCREW_HOME: join(project.root, ".home-opscrew"),
    HCLOUD_TOKEN: fakeSecret("hcloud-token", "destroy"),
    CLOUDFLARE_API_TOKEN: undefined,
    GITHUB_TOKEN: undefined,
    GH_TOKEN: undefined,
    [STORAGE_KEY_VARS.accessKeyId]: undefined,
    [STORAGE_KEY_VARS.secretAccessKey]: undefined,
    AWS_PROFILE: "work",
    ...o.env,
  };
  const deps = await createTestPhaseDeps({
    root: project.root,
    env,
    runner: projectRunner(),
    approvalHandler: handler,
  });
  await ensureStatePassphrase(deps.paths);
  await mkdir(deps.paths.files.tfstateDir, { recursive: true });
  await writeFile(join(deps.paths.files.tfstateDir, "prod.tfstate"), '{"version":4}\n');
  await writeFile(storageStateFile(deps.paths), '{"version":4}\n');
  await mkdir(join(project.root, o.plan.infra.dir), { recursive: true });
  // The committed storage root, as provision wrote it.
  const ctx = {
    opscrewVersion: "0.0.0-test",
    github: { owner: "acme", repo: "shop" },
    deploySshPublicKey: "",
    cloudflare: { zoneId: "zone", accountId: "0123abcd" },
  };
  for (const file of renderStorage(o.plan, ctx)) {
    await mkdir(dirname(join(project.root, file.path)), { recursive: true });
    await writeFile(join(project.root, file.path), file.content);
  }
  const services: DestroyServices = {
    engine: async () => engine,
    provider: { configured: true, verify: async () => ({ ok: true, message: "ok" }) },
    servers: new FakeServers([], "hetzner"),
    cloudflare: fakeCloudflare(),
    github,
    sleep: async () => undefined,
  };
  return { ...project, deps, engine, main, github, handler, services };
}

/**
 * Hetzner's S3 endpoint for the bucket: HEAD answers each status of `heads` in turn, then 404;
 * DELETE answers 204. Records every request.
 */
function fakeS3(heads: number[] = []) {
  const requests: { method: string; url: string; authorization: string }[] = [];
  const fetch: FetchLike = async (input, init) => {
    const method = init?.method ?? "GET";
    const authorization = new Headers(init?.headers).get("authorization") ?? "";
    requests.push({ method, url: String(input), authorization });
    if (method === "DELETE") return new Response(null, { status: 204 });
    return new Response(null, { status: heads.shift() ?? 404 });
  };
  return { fetch, requests, methods: () => requests.map((r) => r.method) };
}

const deletesBucket = (request: ApprovalRequest) =>
  request.kind === "iac-apply" && request.title.startsWith("Delete the app's bucket");

describe.skipIf(!findExecutable("git"))("destroy and the app's bucket (FR-1319)", () => {
  it("keeps the bucket and its files without --delete-data, and says where they are", async () => {
    const s = await setup({
      plan: deployed(withBucket(testPlan(), "hetzner")),
      storage: bucketEngine("hetzner", { changes: bucketChanges("hetzner", "delete") }),
      env: KEY,
    });
    const result = await runDestroy(s.deps, { services: s.services, snapshot: false });
    expect(s.engine.storage.calls).toEqual([]);
    expect(s.handler.requests.some(deletesBucket)).toBe(false);
    expect(s.deps.reporter.text()).toContain(
      "The app's bucket shop-uploads on Hetzner Object Storage (fsn1) and its files stay. To delete them as well, cancel now and run `opscrew destroy --delete-data`.",
    );
    expect(result.remaining).toContain(
      "The app's bucket shop-uploads on Hetzner Object Storage (fsn1) with the app's files, which Hetzner Object Storage bills until it is deleted. OpsCrew deletes it only in the teardown that removes the app, with `opscrew destroy --delete-data`; to delete it now, empty and delete it in the Hetzner Cloud Console (Object Storage).",
    );
    await expect(readTextIfExists(storageStateFile(s.deps.paths))).resolves.toBeDefined();
  });

  it("with --delete-data deletes a Hetzner bucket after the server, through its own approved plan without prevent_destroy", async () => {
    const storage = bucketEngine("hetzner", { changes: bucketChanges("hetzner", "delete") });
    let deletionRoot = "";
    const plan = storage.plan.bind(storage);
    storage.plan = async (dir: string, file: string) => {
      deletionRoot = await readFile(join(dir, "main.tf"), "utf8");
      return plan(dir, file);
    };
    const s = await setup({
      plan: deployed(withBucket(testPlan(), "hetzner")),
      storage,
      env: KEY,
    });
    const s3 = fakeS3();
    s.deps.fetch = s3.fetch;
    const committed = await readFile(join(s.root, "opscrew/infra/storage/main.tf"), "utf8");
    const result = await runDestroy(s.deps, {
      services: s.services,
      snapshot: false,
      deleteData: true,
      confirm: async (preview) => {
        expect(preview.resources.map((r) => r.address)).toContain("aws_s3_bucket.this");
        return true;
      },
    });

    // The deletion copy has no prevent_destroy; the committed root keeps it.
    expect(deletionRoot).not.toContain("prevent_destroy = true");
    expect(deletionRoot).toContain("force_destroy = true");
    expect(await readFile(join(s.root, "opscrew/infra/storage/main.tf"), "utf8")).toBe(committed);
    await expect(
      readTextIfExists(join(s.deps.paths.stateDir, "storage-delete", "main.tf")),
    ).resolves.toBeUndefined();
    expect(s.engine.storage.initOptions?.backendConfig?.path).toBe(storageStateFile(s.deps.paths));

    const request = s.handler.requests.find(deletesBucket);
    expect(request).toMatchObject({
      allowDestroy: true,
      confirmPhrase: "shop",
      title:
        "Delete the app's bucket shop-uploads on Hetzner Object Storage with its files (1 resource to delete)",
    });
    expect(request?.details).toContain("Every file in the bucket is deleted with it.");
    // A Hetzner or Spaces bucket goes after the server, like the app's other data.
    const applies = s.handler.requests.filter((r) => r.kind === "iac-apply");
    expect(applies.at(-1)).toBe(request);
    expect(applies.at(-2)?.title).toContain("Delete shop on Hetzner Cloud");
    expect(s.engine.storage.applied).toHaveLength(1);
    expect(s.engine.storage.applied[0]?.approval.allowDestroy).toBe(true);
    for (const env of s.engine.storageEnvs) {
      expect(env.AWS_SECRET_ACCESS_KEY).toBe(KEY[STORAGE_KEY_VARS.secretAccessKey]);
      expect(env.AWS_PROFILE).toBeUndefined();
    }
    expect(result.remaining.join("\n")).not.toContain("shop-uploads");
    // Gone at once: one check with the user's key, path-style at the bucket's endpoint.
    expect(s3.requests).toEqual([
      {
        method: "HEAD",
        url: "https://fsn1.your-objectstorage.com/shop-uploads",
        authorization: expect.stringContaining(
          `Credential=${KEY[STORAGE_KEY_VARS.accessKeyId]}/20`,
        ),
      },
    ]);
    expect(s.deps.reporter.text()).toContain("Deleted the app's bucket shop-uploads");
    const recorded = (await readFile(s.deps.paths.files.plan, "utf8")).includes(
      request?.planHash as string,
    );
    expect(recorded).toBe(true);
  });

  it("stops with the dashboard steps when R2 refuses a bucket that holds files, deleting nothing else", async () => {
    const plan = deployed(withBucket(testPlan({ domain: "shop.example.com" }), "r2"));
    const s = await setup({
      plan,
      storage: bucketEngine("r2", {
        changes: bucketChanges("r2", "delete"),
        applyOk: false,
        applyLog:
          "Error: failed to delete bucket: The bucket you tried to delete is not empty. (10008)",
      }),
      env: { CLOUDFLARE_API_TOKEN: fakeSecret("cloudflare-token", "destroy") },
    });
    const error = await runDestroy(s.deps, {
      services: s.services,
      snapshot: false,
      deleteData: true,
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: "PHASE_PRECONDITION",
      message:
        "Cloudflare deletes an R2 bucket only when it is empty, and shop-uploads still holds files, so it was not deleted. OpsCrew never deletes the files itself.",
      hint: expect.stringContaining(
        "R2 Object Storage → shop-uploads → select the objects → Delete",
      ),
    });
    expect(s.main.applied).toEqual([]);
    expect(s.github.deleted).toEqual([]);
  });

  it("a --delete-data rerun after the bucket went never claims it is still there", async () => {
    const s = await setup({
      plan: deployed(withBucket(testPlan(), "hetzner")),
      storage: bucketEngine("hetzner", { changes: [] }),
      env: KEY,
    });
    const result = await runDestroy(s.deps, {
      services: s.services,
      snapshot: false,
      deleteData: true,
    });
    expect(s.handler.requests.some(deletesBucket)).toBe(false);
    expect(result.remaining.join("\n")).not.toContain("shop-uploads");
    await expect(
      readTextIfExists(join(s.deps.paths.stateDir, "storage-delete", "main.tf")),
    ).resolves.toBeUndefined();
  });

  /** `--delete-data` of the Hetzner bucket, whose checks answer `heads`; sleeps are recorded, not waited. */
  async function deleteHetznerBucket(heads: number[]) {
    const s = await setup({
      plan: deployed(withBucket(testPlan(), "hetzner")),
      storage: bucketEngine("hetzner", { changes: bucketChanges("hetzner", "delete") }),
      env: KEY,
    });
    const s3 = fakeS3(heads);
    s.deps.fetch = s3.fetch;
    const waits: number[] = [];
    s.services.sleep = async (ms) => {
      waits.push(ms);
    };
    const result = runDestroy(s.deps, { services: s.services, snapshot: false, deleteData: true });
    return { s, s3, waits, result };
  }

  it("deletes a Hetzner bucket again when it is still listed after the destroy, then finds it gone", async () => {
    const { s, s3, waits, result } = await deleteHetznerBucket([200, 200, 200, 200, 200]);
    const done = await result;
    expect(s3.methods()).toEqual(["HEAD", "HEAD", "HEAD", "HEAD", "HEAD", "DELETE", "HEAD"]);
    // Checked over about 20 s before deleting it again.
    expect(waits.filter((ms) => ms === 5000)).toEqual([5000, 5000, 5000, 5000]);
    expect(s.deps.reporter.text()).toContain(
      "Hetzner Object Storage still lists the bucket shop-uploads; deleting it again.",
    );
    expect(s.deps.reporter.text()).toContain("Deleted the app's bucket shop-uploads");
    expect(done.remaining.join("\n")).not.toContain("shop-uploads");
  });

  it("finishes the teardown, then fails with the console steps when the bucket is still listed after both deletes", async () => {
    const { s, s3, result } = await deleteHetznerBucket(Array(10).fill(200));
    const error = await result.catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: "PROVIDER_ERROR",
      message:
        "Hetzner Object Storage still lists the app's bucket shop-uploads after OpsCrew deleted it twice, so it may not be gone and Hetzner Object Storage may still bill it. The rest of the teardown is done.",
      hint: "Check the Hetzner Cloud Console (Object Storage) in a few minutes and delete the bucket shop-uploads there if it is still listed.",
    });
    expect(s3.methods().filter((m) => m === "DELETE")).toHaveLength(1);
    expect(s3.methods()).toHaveLength(11);
    const printed = s.deps.reporter.text();
    expect(printed).not.toContain("Deleted the app's bucket");
    // The rest of the teardown went on: deploy secrets, the record, and what remains.
    expect(s.github.deleted).toContain("OPSCREW_APP_ENV");
    const recorded = await readFile(s.deps.paths.files.plan, "utf8");
    expect(recorded).toContain("destroyedAt");
    const bucketApproval = s.handler.requests.find(deletesBucket);
    expect(recorded).toContain(bucketApproval?.planHash as string);
    expect(printed).toContain(
      "The app's bucket shop-uploads on Hetzner Object Storage (fsn1), which Hetzner Object Storage still listed after OpsCrew deleted it twice",
    );
    const secret = KEY[STORAGE_KEY_VARS.secretAccessKey] as string;
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(printed).not.toContain(secret);
  });

  it("deletes every service's GitHub secret with the deploy secrets", async () => {
    const base = testPlan();
    const plan = deployed(
      DeployPlanSchema.parse({
        ...base,
        services: [
          ...base.services,
          { kind: "mysql", version: "8.4", memoryMb: 512, reason: "mysql2", licence: "GPL-2.0" },
        ],
      }),
    );
    const s = await setup({ plan, storage: bucketEngine("hetzner") });
    const result = await runDestroy(s.deps, { services: s.services, snapshot: false });
    expect(result.secretsRemoved).toContain("OPSCREW_SERVICE_MYSQL_ENV");
    expect(result.secretsRemoved).toContain("OPSCREW_SERVICE_DB_ENV");
    expect(s.github.secrets.has("OPSCREW_SERVICE_MYSQL_ENV")).toBe(false);
  });
});

describe("serverData", () => {
  it("names each component's data from the catalog, and SQLite's", () => {
    const base = testPlan();
    const plan = DeployPlanSchema.parse({
      ...base,
      services: [
        ...base.services,
        { kind: "kafka", version: "4.3", memoryMb: 1024, reason: "kafkajs", licence: "Apache-2.0" },
        {
          kind: "valkey",
          version: "8",
          memoryMb: 128,
          options: { mode: "cache" },
          reason: "redis",
          licence: "BSD-3-Clause",
        },
        {
          name: "fly",
          kind: "dragonfly",
          version: "2",
          memoryMb: 512,
          options: { mode: "cache" },
          reason: "redis",
          licence: "BSL-1.1",
        },
        {
          kind: "redis",
          version: "8",
          memoryMb: 128,
          options: { mode: "queue" },
          reason: "redis-om",
          licence: "RSALv2",
        },
      ],
      storage: { sqlite: { dir: "storage" } },
      deploy: { ...base.deploy, strategy: "recreate" },
    });
    // A cache (Valkey, Redis 8 or Dragonfly) keeps nothing on disk; a queue keeps its jobs.
    expect(serverData(plan)).toEqual([
      "the PostgreSQL database",
      "the Apache Kafka data",
      "the Redis data",
      "the SQLite database",
    ]);
    expect(serverData(testPlan({ postgres: false }))).toEqual([]);
  });
});
