import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ResourceChange, ResourceMove } from "@opscrew/contracts";
import { findExecutable, readTextIfExists } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { storageRootDir } from "@opscrew/iac-templates";
import { readArtifact, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import {
  NEW_STORAGE_KEY_VARS,
  previousBucketKeyFile,
  STORAGE_KEY_VARS,
  type StorageKey,
  storageKeyFile,
} from "../provision/storage";
import { readServerAddresses } from "../shared";
import {
  cliAnswer,
  type MoveHarness,
  type MoveHarnessOptions,
  makeRequirements,
  moveHarness,
  movePlan,
  OLD_IPV4,
} from "../testing";
import { bucketChange, FakeBucketEngine, FakeRclone } from "../testing/bucket-move";
import { RootEngine, withBucket } from "../testing/storage";
import { caught, crashAfter, drive, moveOnDisk, run } from "./__fixtures__/assert";
import { abortRetarget } from "./abort";
import { bucketChoice } from "./bucket";
import { finishRetarget } from "./finish";
import type { RetargetResult, RetargetSummary } from "./types";

const BUCKET = "shop-uploads";
const key = (name: string): StorageKey => ({
  accessKeyId: fakeSecret("aws-access-key-id", name),
  secretAccessKey: fakeSecret("aws-secret-access-key", name),
});

/**
 * A Hetzner deployment whose files are in the bucket `shop-uploads` at Hetzner Object Storage,
 * moving to DigitalOcean: the bucket's root and state as provision left them, the old key in
 * OPSCREW_STORAGE_*, the new one pasted when asked (or in OPSCREW_NEW_STORAGE_* with `newVars`),
 * the storage root's engine and the servers' rclone one-offs.
 */
async function bucketHarness(options: MoveHarnessOptions & { newVars?: boolean } = {}) {
  const h = await moveHarness(options);
  const plan = withBucket(await readArtifact("plan", h.paths.files.plan), "hetzner");
  await writeArtifact("plan", h.paths.files.plan, plan);
  await writeFile(join(h.paths.files.tfstateDir, "storage.tfstate"), '{"version":4}\n');
  const oldKey = key("old-bucket");
  const newKey = key("new-bucket");
  h.deps.env[STORAGE_KEY_VARS.accessKeyId] = oldKey.accessKeyId;
  h.deps.env[STORAGE_KEY_VARS.secretAccessKey] = oldKey.secretAccessKey;
  if (options.newVars) {
    h.deps.env[NEW_STORAGE_KEY_VARS.accessKeyId] = newKey.accessKeyId;
    h.deps.env[NEW_STORAGE_KEY_VARS.secretAccessKey] = newKey.secretAccessKey;
  }
  const asked: string[] = [];
  h.services.askStorageKey = async (question) => {
    asked.push(`${question.provider} ${question.bucket}`);
    return newKey;
  };
  const storage = new FakeBucketEngine(h.events, { bucket: BUCKET, region: "fsn1" });
  const engine = new RootEngine<FakeBucketEngine>(h.engine, storage);
  h.services.engine = async () => engine;
  const rclone = new FakeRclone(h.events);
  for (const name of ["a.png", "b.png", "c.pdf"]) rclone.old.set(name, `${name} bytes`);
  const remote = h.services.remote;
  if (remote === undefined) throw new Error("the harness has no remote");
  h.services.remote = rclone.wrap(remote);
  // The providers answer 404 for a deleted bucket.
  const fetch = h.deps.fetch;
  const heads: string[] = [];
  h.deps.fetch = async (input, init) => {
    const url = String(input);
    if (!/your-objectstorage\.com|digitaloceanspaces\.com/.test(url)) return fetch(input, init);
    heads.push(`${init?.method ?? "GET"} ${url}`);
    return new Response(null, { status: 404 });
  };
  return { h, storage, rclone, oldKey, newKey, asked, heads };
}

type BucketHarness = Awaited<ReturnType<typeof bucketHarness>>;

const finish = (h: MoveHarness) =>
  finishRetarget(h.deps, { services: h.services, confirm: h.confirm });
const abort = (h: MoveHarness) =>
  abortRetarget(h.deps, { services: h.services, confirm: h.confirm });

/** The rclone one-offs in order, as `<host> <verb>`. */
const rcloneTrail = (b: BucketHarness) => b.rclone.runs.map((r) => `${r.host} ${r.verb}`);

/** The storage root's `main.tf` in the working tree. */
async function storageMain(b: BucketHarness): Promise<string> {
  const plan = await readArtifact("plan", b.h.paths.files.plan);
  return readFile(join(b.h.root, storageRootDir(plan), "main.tf"), "utf8");
}

/** Every file under `dir`, recursively, as text. */
async function filesUnder(dir: string): Promise<string> {
  if (!existsSync(dir)) return "";
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const texts = await Promise.all(
    entries
      .filter((e) => e.isFile())
      .map((e) => readFile(join(e.parentPath, e.name), "utf8").catch(() => "")),
  );
  return texts.join("\n");
}

describe.skipIf(!findExecutable("git"))("a move that takes the bucket along (US4)", () => {
  it("measures the bucket, creates the new one, copies before and in the window, and switches the app to it", async () => {
    const b = await bucketHarness();
    const { h } = b;
    let summary: RetargetSummary | undefined;
    const result = await run(h, {
      confirmStart: async (s) => {
        summary = s;
        return true;
      },
    });
    expect(result).toMatchObject({ step: "switched", done: true });
    const n = h.newServer.ipv4;

    // The summary: the bucket's size, objects, minutes and egress, and its own step.
    const text = h.reporter.text();
    expect(text).toContain(
      "Bucket: shop-uploads on Hetzner Object Storage (fsn1) moves to shop-uploads on DigitalOcean Spaces (fra1): 33 bytes in 3 objects, about 4 minutes to copy before the maintenance window",
    );
    expect(text).toContain("which includes about 1 TB of traffic a month");
    expect(text).toContain("not known to OpsCrew");
    expect(text).toContain("keeps billing until `opscrew retarget --finish` deletes it");
    expect(
      summary?.steps.some((s) =>
        s.startsWith("Create the bucket shop-uploads on DigitalOcean Spaces (fra1)"),
      ),
    ).toBe(true);
    // The new key was asked once, for the new bucket only.
    expect(b.asked).toEqual(["DigitalOcean Spaces shop-uploads"]);

    // rclone: the size on the old server before any change, the first copy after the new app's
    // deploy, the last one in the window once the old app stopped.
    expect(rcloneTrail(b)).toEqual([
      `${OLD_IPV4} size`,
      `${n} copy`,
      `${OLD_IPV4} size`,
      `${n} sync`,
    ]);
    const at = (op: string) => h.events.findIndex((e) => e.type === "remote" && e.op === op);
    expect(at("rclone size")).toBeLessThan(h.events.findIndex((e) => e.type === "apply"));
    expect(at("rclone copy")).toBeGreaterThan(h.events.findIndex((e) => e.type === "dispatch"));
    expect(at("rclone sync")).toBeGreaterThan(
      h.events.findIndex((e) => e.type === "remote" && e.host === OLD_IPV4 && e.op === "stop app"),
    );
    expect(at("rclone sync")).toBeLessThan(at("restore"));
    expect([...b.rclone.next.keys()].sort()).toEqual(["a.png", "b.png", "c.pdf"]);
    const sync = b.rclone.runs.find((r) => r.verb === "sync");
    expect(sync?.command).toContain(
      "--entrypoint sh rclone/rclone:1.75.2@sha256:2687085f718d3c628f7fdfb77c52a1d344332aed543110bb88088f2c70d43eb5 -c 'umask 077; cat >/tmp/r.conf; exec rclone --config /tmp/r.conf sync old:shop-uploads new:shop-uploads --checksum --metadata'",
    );
    // The configuration is held in memory in the container, never on the server's disk.
    expect(sync?.command).toContain("docker run -i --rm --tmpfs /tmp:mode=0700 ");
    expect(sync?.input).toContain("endpoint = https://fsn1.your-objectstorage.com");
    expect(sync?.input).toContain("endpoint = https://fra1.digitaloceanspaces.com");
    // The window's approval lists the bucket's last copy.
    const window = h.handler.requests.find((r) => r.title.startsWith("Maintenance window"));
    expect(window?.details).toContain("copy what changed in the bucket shop-uploads");

    // The storage root: renamed (state only), then the new bucket created, each by its hash.
    expect(b.storage.state).toEqual({
      previous: { bucket: BUCKET, region: "fsn1" },
      this: { bucket: BUCKET, region: "fra1" },
    });
    expect(b.storage.serial).toBe(2);
    const titles = h.handler.requests.filter((r) => r.kind === "iac-apply").map((r) => r.title);
    expect(titles).toContain(
      "Rename 1 resource in the infrastructure state (nothing changes in the cloud)",
    );
    expect(titles).toContain(
      "Apply the plan of the app's bucket shop-uploads on DigitalOcean Spaces",
    );
    // Every apply of the storage root followed the approval of its plan's hash.
    for (const hash of h.events.flatMap((e) => (e.type === "apply" ? [e.hash] : []))) {
      expect(h.handler.requests.some((r) => r.planHash === hash)).toBe(true);
    }
    expect(await storageMain(b)).toContain('resource "aws_s3_bucket" "previous"');

    // opscrew/plan.yaml: the new bucket, the one being left in the move's record.
    const plan = await readArtifact("plan", h.paths.files.plan);
    expect(plan.storage?.objectStorage).toMatchObject({
      provider: "digitalocean",
      bucket: BUCKET,
      region: "fra1",
      price: { currency: "USD" },
    });
    expect(plan.retarget?.from.objectStorage).toMatchObject({
      provider: "hetzner",
      region: "fsn1",
    });
    // The new app's deploy secrets carry the new bucket's login.
    const appEnv = h.github.secrets.get("OPSCREW_APP_ENV") ?? "";
    expect(appEnv).toContain(`AWS_SECRET_ACCESS_KEY=${b.newKey.secretAccessKey}`);
    expect(appEnv).toContain("https://fra1.digitaloceanspaces.com");
    expect(appEnv).not.toContain(b.oldKey.secretAccessKey);

    // --finish: the old server, then the bucket being left after its own typed name.
    const done = await finish(h);
    expect(done).toMatchObject({ step: "finished", done: true });
    const deletion = h.events.findLast((e) => e.type === "approval" && e.kind === "iac-apply");
    expect(deletion).toMatchObject({ allowDestroy: true, confirmation: BUCKET, approved: true });
    expect(h.events.some((e) => e.type === "confirm" && e.name === "shop")).toBe(true);
    expect(b.storage.state).toEqual({ this: { bucket: BUCKET, region: "fra1" } });
    expect(b.heads).toEqual([`HEAD https://fsn1.your-objectstorage.com/${BUCKET}`]);
    // The final files hold the new bucket only, and the move is gone from the plan.
    const main = await storageMain(b);
    expect(main).not.toContain("previous");
    expect(main).toContain('resource "aws_s3_bucket" "this"');
    const final = await readArtifact("plan", h.paths.files.plan);
    expect(final.retarget).toBeUndefined();
    expect(final.storage?.objectStorage?.provider).toBe("digitalocean");
    expect(h.reporter.text()).toContain(
      "Deleted the bucket shop-uploads on Hetzner Object Storage (fsn1).",
    );
  });

  it("FR-2312: the keys reach rclone and the engine only on standard input and in a file removed afterwards", async () => {
    const b = await bucketHarness();
    const { h } = b;
    // A failing copy whose output names the new key: it is redacted.
    let failures = 1;
    b.rclone.fail = (verb) =>
      verb === "copy" && failures-- > 0
        ? {
            exitCode: 1,
            stdout: "",
            stderr: `ERROR: access denied for ${b.newKey.secretAccessKey}`,
          }
        : undefined;
    const error = await caught(run(h));
    expect(error.code).toBe("COMMAND_FAILED");
    expect(error.message).toContain(
      "Copying the bucket shop-uploads to shop-uploads on DigitalOcean Spaces (fra1) failed on the new Droplet on DigitalOcean: ERROR: access denied for [REDACTED:storage-key]",
    );
    expect(error.message).not.toContain(b.newKey.secretAccessKey);
    expect((await moveOnDisk(h))?.step).toBe("created");
    expect(await run(h)).toMatchObject({ step: "switched" });
    await finish(h);

    const secrets = [b.oldKey, b.newKey].flatMap((k) => [k.accessKeyId, k.secretAccessKey]);
    // Both keys went in on standard input; the one being left reached the engine in its file.
    const inputs = b.rclone.runs.map((r) => r.input).join("\n");
    for (const secret of secrets.slice(0, 2)) expect(inputs).toContain(secret);
    expect(
      b.rclone.runs
        .filter((r) => r.verb !== "size")
        .every((r) => r.input.includes(b.newKey.secretAccessKey)),
    ).toBe(true);
    expect(b.storage.credentials.length).toBeGreaterThan(0);
    for (const file of b.storage.credentials) {
      expect(file).toContain("[opscrew-previous]");
      expect(file).toContain(`aws_secret_access_key = ${b.oldKey.secretAccessKey}`);
    }
    expect(b.storage.accessKeys.every((id) => id === b.newKey.accessKeyId)).toBe(true);
    expect(existsSync(previousBucketKeyFile(h.paths))).toBe(false);
    // Never on a command line, in a plan or its sidecar, a rendered file, the plan, a log or the audit.
    const commands = b.rclone.runs.map((r) => r.command).join("\n");
    const plans = await filesUnder(h.paths.files.plansDir);
    const rendered = await filesUnder(join(h.root, "opscrew"));
    const shown = `${h.reporter.text()}\n${JSON.stringify(h.audit.entries)}\n${JSON.stringify(h.events)}`;
    for (const secret of secrets) {
      for (const [where, text] of Object.entries({ commands, plans, rendered, shown })) {
        expect(text.includes(secret), `${where} holds a key`).toBe(false);
      }
    }
    // The key of the deleted bucket was never kept; the new bucket's is, privately.
    const kept = (await readTextIfExists(storageKeyFile(h.paths))) ?? "";
    expect(kept).toContain(b.newKey.secretAccessKey);
    expect(kept).not.toContain(b.oldKey.secretAccessKey);
  });

  it("--abort deletes the new bucket after its typed name and gives the old side its login back", async () => {
    const b = await bucketHarness();
    const { h } = b;
    // The window is refused: the move stays deployed, with the new bucket copied.
    h.handler.answer = (r) => !r.title.startsWith("Maintenance window");
    expect((await caught(run(h))).code).toBe("APPROVAL_REFUSED");
    expect((await moveOnDisk(h))?.step).toBe("deployed");
    h.handler.answer = () => true;

    const result = await abort(h);
    expect(result).toMatchObject({ step: "aborted", done: true });
    const deletes = h.events.filter((e) => e.type === "approval" && e.allowDestroy === true);
    expect(deletes.map((e) => (e.type === "approval" ? e.confirmation : ""))).toEqual([
      "shop",
      BUCKET,
    ]);
    expect(b.storage.state).toEqual({ this: { bucket: BUCKET, region: "fsn1" } });
    expect(b.heads).toEqual([`HEAD https://fra1.digitaloceanspaces.com/${BUCKET}`]);
    const plan = await readArtifact("plan", h.paths.files.plan);
    expect(plan.storage?.objectStorage).toMatchObject({ provider: "hetzner", region: "fsn1" });
    const appEnv = h.github.secrets.get("OPSCREW_APP_ENV") ?? "";
    expect(appEnv).toContain(`AWS_SECRET_ACCESS_KEY=${b.oldKey.secretAccessKey}`);
    expect(appEnv).toContain("https://fsn1.your-objectstorage.com");
    // The original storage files, and no key kept for the deleted bucket.
    const main = await storageMain(b);
    expect(main).not.toContain("previous");
    expect(main).not.toContain("moved");
    expect((await readTextIfExists(storageKeyFile(h.paths))) ?? "").not.toContain(
      b.newKey.secretAccessKey,
    );
  });

  it("an abort before the bucket's rename changes nothing in its root", async () => {
    const b = await bucketHarness();
    const { h } = b;
    h.handler.answer = (r) => !(r.kind === "iac-apply" && r.title.startsWith("Rename"));
    expect((await caught(run(h))).code).toBe("APPROVAL_REFUSED");
    expect((await moveOnDisk(h))?.step).toBe("started");
    h.handler.answer = () => true;
    await abort(h);
    expect(b.storage.state).toEqual({ this: { bucket: BUCKET, region: "fsn1" } });
    expect(h.events.filter((e) => e.type === "apply")).toEqual([]);
    expect((await readArtifact("plan", h.paths.files.plan)).storage?.objectStorage?.provider).toBe(
      "hetzner",
    );
  });

  it("a script gives the new key in OPSCREW_NEW_STORAGE_*, approves each plan by its hash, and --finish asks for both names", async () => {
    const b = await bucketHarness({ interactive: false, newVars: true });
    const { h } = b;
    expect(await drive(h, { allowDowntime: true })).toMatchObject({ step: "switched", done: true });
    expect(b.storage.state.this).toEqual({ bucket: BUCKET, region: "fra1" });
    // The new key reached the new bucket's uses, was never kept and never shown.
    expect(h.github.secrets.get("OPSCREW_APP_ENV")).toContain(b.newKey.secretAccessKey);
    expect(b.rclone.runs.find((r) => r.verb === "copy")?.input).toContain(b.newKey.secretAccessKey);
    expect(b.storage.accessKeys.every((id) => id === b.newKey.accessKeyId)).toBe(true);
    await expect(readTextIfExists(storageKeyFile(h.paths))).resolves.toBeUndefined();
    const shown = `${h.reporter.text()}\n${JSON.stringify(h.audit.entries)}`;
    expect(shown).not.toContain(b.newKey.secretAccessKey);
    expect(shown).not.toContain(b.newKey.accessKeyId);

    const { result, confirms } = await scripted(h, (approvePlanHash) =>
      finishRetarget(h.deps, {
        services: h.services,
        confirm: h.confirm,
        ...(approvePlanHash !== undefined ? { approvePlanHash } : {}),
      }),
    );
    expect(result).toMatchObject({ step: "finished", done: true });
    expect(confirms.at(-1)).toBe(BUCKET);
    expect(confirms).toContain("shop");
    expect(b.storage.state).toEqual({ this: { bucket: BUCKET, region: "fra1" } });
  });

  it("stops before any change in a script that does not know the new bucket's key", async () => {
    const b = await bucketHarness({ interactive: false });
    const error = await caught(run(b.h));
    expect(error.code).toBe("CREDENTIALS_MISSING");
    expect(error.message).toContain("shop-uploads on DigitalOcean Spaces");
    expect(error.hint).toContain(
      "in a terminal to paste it once, or set OPSCREW_NEW_STORAGE_ACCESS_KEY_ID and OPSCREW_NEW_STORAGE_SECRET_ACCESS_KEY to it",
    );
    expect(error.hint).toContain(
      "OPSCREW_STORAGE_ACCESS_KEY_ID and OPSCREW_STORAGE_SECRET_ACCESS_KEY hold the key of the bucket being left",
    );
    expect(await moveOnDisk(b.h)).toBeUndefined();
    expect(b.rclone.runs).toEqual([]);
  });

  it("--keep-bucket keeps the bucket where it is, billed, with the same key", async () => {
    const b = await bucketHarness();
    const { h } = b;
    expect(await run(h, { keepBucket: true })).toMatchObject({ step: "switched" });
    expect(h.reporter.text()).toContain(
      "Bucket: shop-uploads on Hetzner Object Storage (fsn1) stays there and keeps billing after the move (--keep-bucket)",
    );
    expect(b.rclone.runs).toEqual([]);
    expect(b.storage.state).toEqual({ this: { bucket: BUCKET, region: "fsn1" } });
    const plan = await readArtifact("plan", h.paths.files.plan);
    expect(plan.storage?.objectStorage?.provider).toBe("hetzner");
    expect(plan.retarget?.from.objectStorage).toBeUndefined();
    expect(h.github.secrets.get("OPSCREW_APP_ENV")).toContain(b.oldKey.secretAccessKey);
  });

  it("says plainly that --keep-bucket after the start changes nothing", async () => {
    const b = await bucketHarness();
    const { h } = b;
    h.handler.answer = (r) => !r.title.startsWith("Maintenance window");
    await caught(run(h));
    h.handler.answer = () => true;
    expect(await run(h, { keepBucket: true })).toMatchObject({ step: "switched" });
    expect(h.reporter.text()).toContain(
      "--keep-bucket: the bucket's choice was made at the start; it stays as chosen.",
    );
    expect((await readArtifact("plan", h.paths.files.plan)).storage?.objectStorage?.provider).toBe(
      "digitalocean",
    );
  });

  it("a failed last copy rolls the window back and starts the old app again", async () => {
    const b = await bucketHarness();
    const { h } = b;
    b.rclone.fail = (verb) =>
      verb === "sync"
        ? { exitCode: 1, stdout: "", stderr: `ERROR: denied for ${b.oldKey.secretAccessKey}` }
        : undefined;
    const error = await caught(run(h));
    expect(error.code).toBe("COMMAND_FAILED");
    expect(error.message).toContain("The maintenance window failed");
    expect(error.message).toContain("[REDACTED:storage-key]");
    expect(error.message).not.toContain(b.oldKey.secretAccessKey);
    expect((await moveOnDisk(h))?.step).toBe("deployed");
    expect((await moveOnDisk(h))?.oldAppStoppedAt).toBeUndefined();
    expect(h.hosts.host(OLD_IPV4).app).toBe(true);
    // Once it works, the window runs again.
    b.rclone.fail = undefined;
    expect(await run(h)).toMatchObject({ step: "switched" });
  });

  it("a failed measure of the bucket stops the start with nothing recorded", async () => {
    const b = await bucketHarness();
    const { h } = b;
    b.rclone.fail = (verb) =>
      verb === "size" ? { exitCode: 1, stdout: "", stderr: "AccessDenied" } : undefined;
    const error = await caught(run(h));
    expect(error.code).toBe("COMMAND_FAILED");
    expect(error.message).toContain(
      "Measuring the bucket shop-uploads failed on the old server on Hetzner Cloud: AccessDenied",
    );
    expect(await moveOnDisk(h)).toBeUndefined();
    expect((await readServerAddresses(h.paths)).retarget).toBeUndefined();
    expect((await readArtifact("plan", h.paths.files.plan)).target.provider).toBe("hetzner");
    expect(rcloneTrail(b)).toEqual([`${OLD_IPV4} size`]);
    expect(h.events.filter((e) => e.type === "apply")).toEqual([]);
  });

  describe("stops a bucket plan that does more than its step, before any approval", () => {
    const cases = [
      {
        name: "the create plan deleting the bucket being left",
        extra: (changes: ResourceChange[]) =>
          changes.some((c) => c.action === "create") ? [bucketChange("previous", "delete")] : [],
        problem: "delete aws_s3_bucket.previous",
        finish: false,
      },
      {
        name: "the rename plan changing anything",
        extra: (_: ResourceChange[], moves: ResourceMove[]) =>
          moves.length > 0 ? [bucketChange("this", "update")] : [],
        problem: "update aws_s3_bucket.this",
        finish: false,
      },
      {
        name: "the finish plan deleting the new bucket too",
        extra: (changes: ResourceChange[]) =>
          changes.some((c) => c.action === "delete") ? [bucketChange("this", "delete")] : [],
        problem: "delete aws_s3_bucket.this",
        finish: true,
      },
    ];
    for (const c of cases) {
      it(c.name, async () => {
        const b = await bucketHarness();
        const { h } = b;
        if (c.finish) await run(h);
        b.storage.extra = c.extra;
        const error = await caught(c.finish ? finish(h) : run(h));
        expect(error.code).toBe("PHASE_PRECONDITION");
        expect(error.message).toContain("The plan of the app's bucket would do more than");
        expect(error.message).toContain(c.problem);
        const planned = h.events.findLast((e) => e.type === "plan");
        const hash = planned?.type === "plan" ? planned.hash : "";
        expect(h.handler.requests.some((r) => r.planHash === hash)).toBe(false);
        expect(h.events.some((e) => e.type === "apply" && e.hash === hash)).toBe(false);
        const file = b.storage.planFiles.at(-1) ?? "";
        expect(existsSync(file)).toBe(false);
        expect(existsSync(`${file}.json`)).toBe(false);
      });
    }
  });

  it("a script without the buckets' keys stops --finish before the old server is deleted", async () => {
    const b = await bucketHarness();
    const { h } = b;
    await run(h);
    h.deps.interactive = false;
    delete h.deps.env[STORAGE_KEY_VARS.accessKeyId];
    delete h.deps.env[STORAGE_KEY_VARS.secretAccessKey];
    const error = await caught(finish(h));
    expect(error.code).toBe("CREDENTIALS_MISSING");
    expect(error.message).toContain("Nothing was changed.");
    expect(h.engine.state.servers.server_previous).toBeDefined();
    expect(h.events.some((e) => e.type === "snapshot" || e.type === "confirm")).toBe(false);
  });

  it("a scripted --abort asks for the app's name, then the new bucket's", async () => {
    const b = await bucketHarness({ newVars: true });
    const { h } = b;
    crashAfter(h, "deployed");
    await expect(run(h)).rejects.toThrow("interrupted");
    // From here on like a script.
    h.deps.interactive = false;
    h.handler.answer = cliAnswer(() => h.cli);
    const { result, confirms } = await scripted(h, (approvePlanHash) =>
      abortRetarget(h.deps, {
        services: h.services,
        confirm: h.confirm,
        ...(approvePlanHash !== undefined ? { approvePlanHash } : {}),
      }),
    );
    expect(result).toMatchObject({ step: "aborted", done: true });
    // The new server first, then the new bucket (the later renames repeat the app's name).
    expect(confirms.slice(0, 2)).toEqual(["shop", BUCKET]);
    expect(b.storage.state).toEqual({ this: { bucket: BUCKET, region: "fsn1" } });
  });

  it("an app whose only data is the bucket gets a window for the bucket's last copy", async () => {
    const b = await bucketHarness({ postgres: false });
    const { h } = b;
    expect(await run(h)).toMatchObject({ step: "switched" });
    const n = h.newServer.ipv4;
    expect(rcloneTrail(b)).toEqual([
      `${OLD_IPV4} size`,
      `${n} copy`,
      `${OLD_IPV4} size`,
      `${n} sync`,
    ]);
    expect(h.reporter.text()).toContain(
      "Expected maintenance window: about 3 minutes, for the bucket's last copy.",
    );
    const window = h.handler.requests.find((r) => r.title.startsWith("Maintenance window"));
    expect(window?.details).toContain("copy what changed in the bucket shop-uploads");
    expect(window?.details).not.toContain("Docker's archive API");
    expect(window?.details).toContain("About 3 minutes");
    // The window's sync has a timeout of its own, from the bucket's object count.
    expect(b.rclone.runs.find((r) => r.verb === "sync")?.timeoutMs).toBe(8 * 60_000);
  });
});

/**
 * Runs `call` like a script: approves each plan hash it stops with, with the `--confirm` name its
 * next command gives. Returns the last result and the names, in order.
 */
async function scripted(
  h: MoveHarness,
  call: (approvePlanHash?: string) => Promise<RetargetResult>,
): Promise<{ result: RetargetResult; confirms: string[] }> {
  const confirms: string[] = [];
  let result = await call();
  for (let i = 0; i < 8 && result.pendingPlanHash !== undefined; i++) {
    const confirm = /--confirm (\S+)/.exec(result.next.join(" "))?.[1];
    if (confirm !== undefined) confirms.push(confirm);
    h.cli.approve = result.pendingPlanHash;
    h.cli.confirm = confirm;
    result = await call(result.pendingPlanHash);
  }
  return { result, confirms };
}

describe("bucketChoice", () => {
  const requirements = makeRequirements({ provider: "digitalocean" });
  const hetzner = () => withBucket(movePlan(), "hetzner");

  it("moves a bucket at the provider being left to the other cloud provider's storage", () => {
    const choice = bucketChoice(hetzner(), "digitalocean", { keep: false, requirements });
    expect(choice).toMatchObject({
      moves: {
        old: { provider: "hetzner", region: "fsn1" },
        next: { provider: "digitalocean", region: "fra1", bucket: BUCKET },
      },
    });
  });

  it("keeps it for the user's own server or Portainer, with --keep-bucket, and on R2", () => {
    for (const to of ["own", "portainer"] as const) {
      expect(bucketChoice(hetzner(), to, { keep: false })).toEqual({
        stays: `Bucket: ${BUCKET} on Hetzner Object Storage (fsn1) stays there and keeps billing after the move: a bucket moves only to another cloud provider's object storage; the app on the new side keeps using it with the same key.`,
      });
    }
    expect(bucketChoice(hetzner(), "digitalocean", { keep: true, requirements })).toMatchObject({
      stays: expect.stringContaining("(--keep-bucket)"),
    });
    const r2 = withBucket(movePlan(), "r2");
    expect(bucketChoice(r2, "digitalocean", { keep: false, requirements })).toEqual({
      stays: `Bucket: ${BUCKET} on Cloudflare R2 (auto) stays where it is; the app on the new side keeps using it with the same key.`,
    });
    // A region without the new provider's storage.
    const west = makeRequirements({ provider: "hetzner", region: "us-west" });
    const spaces = withBucket(movePlan({ from: "digitalocean" }), "digitalocean");
    expect(bucketChoice(spaces, "hetzner", { keep: false, requirements: west })).toMatchObject({
      stays: expect.stringContaining("Hetzner Cloud has no object storage in the app's region"),
    });
  });

  it("keeps it on a move to or from Contabo, whose storage a move never takes", () => {
    const contabo = makeRequirements({ provider: "contabo" });
    expect(bucketChoice(hetzner(), "contabo", { keep: false, requirements: contabo })).toEqual({
      stays: `Bucket: ${BUCKET} on Hetzner Object Storage (fsn1) stays there and keeps billing after the move: OpsCrew moves a bucket only between Hetzner Object Storage and DigitalOcean Spaces; the app on the new side keeps using it with the same key.`,
    });
  });
});
