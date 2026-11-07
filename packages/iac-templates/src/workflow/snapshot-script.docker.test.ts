/**
 * `snapshot.sh offsite <id>` against a local S3 (024 plan.md 7., D10): the pinned Garage on Docker
 * stands in for the off-server copies' bucket, reached at its address on Docker's default network.
 * - The script fetches the pinned age with the pinned rclone image, checks its hashes, and streams
 *   each file the snapshot's `about.json` names, then `about.json`, through `age -r <recipient>`
 *   into `rclone rcat`, the key only in the mode-600 `offsite.env`. Each object holds age's
 *   ciphertext only, and decrypts with the test's own age key to exactly the snapshot's file.
 * - On DigitalOcean Spaces, whose bucket expires nothing itself, the copies older than the
 *   retention go after the upload, and the new ones stay.
 * Neither the script's output nor its log holds the bucket's key.
 *
 * It pulls the pinned images and fetches age from GitHub, so it runs only with
 * OPSCREW_DOCKER_TESTS=1. It removes its container and the images it pulled.
 */
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateAgeIdentity } from "@opscrew/core";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { afterAll, describe, expect, it } from "vitest";
import { withServices } from "../catalog/__fixtures__/plans";
import { IMAGES } from "../pins";
import { inEnvironment } from "./__fixtures__/plans";
import { skipReason, write } from "./__fixtures__/sh";
import { OFFSITE_ENV_FILE, snapshotScript } from "./snapshot-script";

const reason = skipReason();
if (reason) console.warn(`[iac-templates] skipping the off-server copy on Docker: ${reason}`);

const RUN = randomBytes(3).toString("hex");
const GARAGE = `opscrew-t2406-garage-${RUN}`;
const BUCKET = "shop-staging-backups";

/** Docker without Git Bash's path conversion, its output; a failure throws with the output. */
function docker(args: string[], input?: string): string {
  const result = spawnSync("docker", args, {
    input,
    env: { ...process.env, MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*" },
    encoding: "utf8",
    timeout: 600_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `docker ${args.join(" ")} failed (${result.status ?? result.signal}):\n${result.stdout}${result.stderr}`,
    );
  }
  return result.stdout.trim();
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** `shop` in staging with PostgreSQL `db`, its snapshots copied off to `offsite`'s bucket. */
function offsitePlan(offsite: NonNullable<DeployPlan["snapshots"]>["offsite"]): DeployPlan {
  const base = inEnvironment(withServices([{ kind: "postgres", name: "db" }]), {
    name: "staging",
  });
  return DeployPlanSchema.parse({ ...base, snapshots: { offsite } });
}

/** The images this test pulled, removed at the end. */
const pulled: string[] = [];
let dir: string | undefined;

afterAll(() => {
  spawnSync("docker", ["rm", "-f", GARAGE], { encoding: "utf8" });
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  for (const ref of pulled) spawnSync("docker", ["image", "rm", ref], { encoding: "utf8" });
});

describe.skipIf(reason !== undefined)("the off-server copy on Docker", { timeout: 900_000 }, () => {
  it("uploads each file encrypted to the recipient, about.json last, which the test's key opens", async () => {
    for (const ref of [IMAGES.garage.ref, IMAGES.rclone.ref]) {
      if (spawnSync("docker", ["image", "inspect", ref]).status !== 0) pulled.push(ref);
    }
    dir = mkdtempSync(join(tmpdir(), "opscrew-offsite-")).replaceAll("\\", "/");
    const keyId = `GK${randomBytes(12).toString("hex")}`;
    const secret = randomBytes(32).toString("hex");
    write(
      `${dir}/garage.toml`,
      [
        'metadata_dir = "/var/lib/garage/meta"',
        'data_dir = "/var/lib/garage/data"',
        'db_engine = "sqlite"',
        "replication_factor = 1",
        'rpc_bind_addr = "0.0.0.0:3901"',
        'rpc_public_addr = "127.0.0.1:3901"',
        "",
        "[s3_api]",
        // The region every client signs with: DigitalOcean's, which names none, signs with us-east-1.
        's3_region = "us-east-1"',
        'api_bind_addr = "0.0.0.0:3900"',
        "",
      ].join("\n"),
    );
    docker([
      "run",
      "-d",
      "--name",
      GARAGE,
      "-e",
      `GARAGE_RPC_SECRET=${randomBytes(32).toString("hex")}`,
      "-e",
      `GARAGE_DEFAULT_ACCESS_KEY=${keyId}`,
      "-e",
      `GARAGE_DEFAULT_SECRET_KEY=${secret}`,
      "-e",
      `GARAGE_DEFAULT_BUCKET=${BUCKET}`,
      "-v",
      `${dir}/garage.toml:/etc/garage.toml:ro`,
      IMAGES.garage.ref,
      "/garage",
      "server",
      "--single-node",
      "--default-bucket",
    ]);
    const address = docker([
      "inspect",
      "-f",
      "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
      GARAGE,
    ]);
    expect(address).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    const { identity, recipient } = generateAgeIdentity();
    const login = [
      `OPSCREW_OFFSITE_ENDPOINT=http://${address}:3900`,
      "OPSCREW_OFFSITE_REGION=us-east-1",
      `OPSCREW_OFFSITE_ACCESS_KEY_ID=${keyId}`,
      `OPSCREW_OFFSITE_SECRET_ACCESS_KEY=${secret}`,
      `OPSCREW_OFFSITE_RECIPIENT=${recipient}`,
    ];
    // The test's own rclone remote `bucket:`, with the same key.
    const remote = [
      "RCLONE_CONFIG_BUCKET_TYPE=s3",
      "RCLONE_CONFIG_BUCKET_PROVIDER=Other",
      `RCLONE_CONFIG_BUCKET_ENDPOINT=http://${address}:3900`,
      "RCLONE_CONFIG_BUCKET_REGION=us-east-1",
      `RCLONE_CONFIG_BUCKET_ACCESS_KEY_ID=${keyId}`,
      `RCLONE_CONFIG_BUCKET_SECRET_ACCESS_KEY=${secret}`,
      "HOME=/tmp",
    ].flatMap((variable) => ["-e", variable]);
    /** `script` in the pinned rclone image with the bucket's login, `/tools` the app's age. */
    const rclone = (app: string, script: string, input?: string) =>
      docker(
        [
          "run",
          "--rm",
          "-i",
          ...remote,
          "-v",
          `${app}/.offsite:/tools:ro`,
          "--entrypoint",
          "sh",
          IMAGES.rclone.ref,
          "-c",
          script,
        ],
        input,
      );
    // The bucket answers once Garage made it.
    for (let attempt = 0; ; attempt++) {
      const listed = spawnSync(
        "docker",
        ["run", "--rm", ...remote, IMAGES.rclone.ref, "lsf", `bucket:${BUCKET}`],
        { encoding: "utf8", env: { ...process.env, MSYS_NO_PATHCONV: "1" } },
      );
      if (listed.status === 0) break;
      if (attempt === 30) throw new Error(`Garage never served the bucket: ${listed.stderr}`);
      await sleep(2_000);
    }

    /** `plan`'s app folder with its script, `offsite.env` and a snapshot `id` of `bytes`. */
    const app = (plan: DeployPlan, name: string, id: string, bytes: Buffer) => {
      const folder = `${dir}/${name}/apps/${plan.app.name}`;
      write(`${folder}/snapshot.sh`, `${snapshotScript(plan).join("\n")}\n`);
      write(`${folder}/${OFFSITE_ENV_FILE}`, `${login.join("\n")}\n`);
      chmodSync(`${folder}/${OFFSITE_ENV_FILE}`, 0o600);
      snapshot(folder, id, bytes);
      return folder;
    };
    const snapshot = (folder: string, id: string, bytes: Buffer) => {
      mkdirSync(`${folder}/.snapshots/${id}`, { recursive: true });
      writeFileSync(`${folder}/.snapshots/${id}/db.dump`, bytes);
      write(`${folder}/.snapshots/${id}/taken`, "2026-11-07T00:00:00Z\n");
      write(
        `${folder}/.snapshots/${id}/about.json`,
        `${JSON.stringify({
          id,
          kind: "manual",
          taken: "2026-11-07T00:00:00Z",
          version: `sha256:${"c".repeat(64)}`,
          services: [{ name: "db", kind: "postgres", file: "db.dump", size: bytes.length }],
        })}\n`,
      );
    };
    const offsite = (folder: string, id: string) => {
      const result = spawnSync("sh", [`${folder}/snapshot.sh`, "offsite", id], {
        cwd: folder,
        env: {
          ...process.env,
          MSYS_NO_PATHCONV: "1",
          MSYS2_ARG_CONV_EXCL: "*",
          OPSCREW_APPS_DIR: folder.slice(0, folder.lastIndexOf("/")),
        },
        encoding: "utf8",
        timeout: 600_000,
      });
      // The upload's own output, never printed by the script, shown when this test fails.
      const log = readFileSync(`${folder}/.snapshots/offsite.log`, "utf8");
      return { status: result.status, output: `${result.stdout}${result.stderr}`, log };
    };
    const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

    // Hetzner (a bucket that expires copies itself), a dump of 7 MB: a multipart upload.
    const id = "20261107T000000Z";
    const dump = randomBytes(7 * 1024 * 1024);
    const hetzner = app(
      offsitePlan({ provider: "hetzner", bucket: BUCKET, region: "fsn1" }),
      "hetzner",
      id,
      dump,
    );
    const uploaded = offsite(hetzner, id);
    expect(
      uploaded.status,
      `${uploaded.output}
${uploaded.log}`,
    ).toBe(0);
    expect(existsSync(`${hetzner}/.snapshots/${id}/offsite.done`)).toBe(true);
    expect(existsSync(`${hetzner}/.offsite/age`)).toBe(true);
    for (const text of [uploaded.output, uploaded.log]) expect(text).not.toContain(secret);

    const objects = rclone(hetzner, `rclone lsf -R bucket:${BUCKET}/backups/${id}`).split("\n");
    expect(objects.sort()).toEqual(["about.json.age", "db.dump.age"]);
    const header = rclone(
      hetzner,
      `rclone cat bucket:${BUCKET}/backups/${id}/db.dump.age | head -c 21`,
    );
    expect(header).toBe("age-encryption.org/v1");
    const decrypted = rclone(
      hetzner,
      [
        "set -e",
        "umask 077",
        "cat > /tmp/id",
        "for f in db.dump about.json; do",
        `  rclone cat bucket:${BUCKET}/backups/${id}/$f.age | /tools/age -d -i /tmp/id | sha256sum | cut -d ' ' -f 1`,
        "done",
      ].join("\n"),
      `${identity}\n`,
    ).split("\n");
    expect(decrypted).toEqual([
      sha(dump),
      sha(readFileSync(`${hetzner}/.snapshots/${id}/about.json`)),
    ]);

    // Spaces: an old copy goes after the next upload, the new copies stay.
    rclone(
      hetzner,
      [
        "set -e",
        `echo old | rclone rcat bucket:${BUCKET}/backups/20250101T000000Z/db.dump.age`,
        `rclone touch -t 2025-01-01T00:00:00 bucket:${BUCKET}/backups/20250101T000000Z/db.dump.age`,
      ].join("\n"),
    );
    const later = "20261107T010000Z";
    const spaces = app(
      offsitePlan({ provider: "digitalocean", bucket: BUCKET, region: "fra1" }),
      "spaces",
      later,
      randomBytes(1024),
    );
    const pruned = offsite(spaces, later);
    expect(
      pruned.status,
      `${pruned.output}
${pruned.log}`,
    ).toBe(0);
    for (const text of [pruned.output, pruned.log]) expect(text).not.toContain(secret);
    const left = rclone(spaces, `rclone lsf -R bucket:${BUCKET}/backups`)
      .split("\n")
      .filter((line) => !line.endsWith("/"))
      .sort();
    expect(left).toEqual([
      `${id}/about.json.age`,
      `${id}/db.dump.age`,
      `${later}/about.json.age`,
      `${later}/db.dump.age`,
    ]);
  });
});
