// T2756: provision's write check of the off-server copies on the user's own storage. The pinned
// rclone, as the copies run it, writes and deletes a test file there; a refusal names what to fix.
import { dockerClient } from "@opscrew/connector-docker";
import { type FakeContainer, FakeDocker } from "@opscrew/connector-docker/testing";
import { fakeSecret } from "@opscrew/core/testing";
import { IMAGES, PORTAINER_OFFSITE_VARIABLES } from "@opscrew/iac-templates";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { createTestPhaseDeps, testPlan } from "../testing";
import {
  checkOffsiteWrite,
  checkOffsiteWriteOnServers,
  OFFSITE_CHECK_FILE,
  ownOffsiteOf,
} from "./offsite-check";

const HOST_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";
const SFTP = {
  provider: "sftp",
  host: "backup.example.com",
  user: "shop-backups",
  path: "/backups",
  hostKey: HOST_KEY,
} as const;
const S3 = {
  provider: "s3",
  endpoint: "https://s3.eu-central-1.wasabisys.com",
  bucket: "shop-backups",
  region: "eu-central-1",
} as const;

const withOffsite = (offsite: object): DeployPlan =>
  DeployPlanSchema.parse({ ...testPlan(), snapshots: { offsite } });

const v = PORTAINER_OFFSITE_VARIABLES;
const PEM = fakeSecret("private-key-pem", "offsite-check");
const SSH_KEY = PEM.split("\n").join("\\n");
const ACCESS = fakeSecret("aws-access-key-id", "offsite-check");
const SECRET = fakeSecret("aws-secret-access-key", "offsite-check");
const SFTP_VALUES = { [v.sshKey]: SSH_KEY, [v.recipient]: "age1recipient" };
const S3_VALUES = {
  [v.endpoint]: S3.endpoint,
  [v.accessKeyId]: ACCESS,
  [v.secretAccessKey]: SECRET,
  [v.recipient]: "age1recipient",
};

const WORDS = {
  who: "The app's server",
  already: "The deploy secrets are not stored yet.",
  command: "opscrew provision",
};

/** A fake Docker whose rclone one-offs end as `run` says, each kept in `ran` as it started. */
function docker(run: (container: FakeContainer) => { exitCode: number; stderr?: string }) {
  const fake = Object.assign(new FakeDocker(), { ran: [] as FakeContainer[] });
  fake.onStart = (container) => {
    fake.ran.push(container);
    return run(container);
  };
  return fake;
}

/** The env of a one-off, as a map. */
const envOf = (container: FakeContainer) =>
  Object.fromEntries(
    container.env.map((line) => [
      line.slice(0, line.indexOf("=")),
      line.slice(line.indexOf("=") + 1),
    ]),
  );

/** {@link checkOffsiteWrite} of `plan`'s own storage on `fake`'s Docker, with `values`. */
async function check(
  d: Awaited<ReturnType<typeof deps>>,
  plan: DeployPlan,
  fake: FakeDocker,
  values: Record<string, string>,
) {
  const own = ownOffsiteOf(plan);
  if (own === undefined) throw new Error("The test plan's copy is not on the user's own storage.");
  return checkOffsiteWrite(d, plan, own, dockerClient(fake), values, WORDS);
}

async function deps() {
  const d = await createTestPhaseDeps({});
  for (const secret of [ACCESS, SECRET, SSH_KEY]) d.redactor.addLiteral(secret, "test");
  return d;
}

describe("the off-server copy's write check", () => {
  it("writes and deletes a test file in the SFTP folder, with the pinned host key and the private key only in the request", async () => {
    const plan = withOffsite(SFTP);
    const fake = docker(() => ({ exitCode: 0 }));
    const d = await deps();
    await check(d, plan, fake, SFTP_VALUES);
    const ran = fake.ran;
    const file = `offsite:/backups/shop-prod/backups/${OFFSITE_CHECK_FILE}`;
    expect(ran.map((c) => c.cmd)).toEqual([
      ["touch", file],
      ["deletefile", file],
    ]);
    for (const container of ran) {
      expect(container.image).toBe(IMAGES.rclone.ref);
      expect(envOf(container)).toEqual({
        RCLONE_CONFIG_OFFSITE_TYPE: "sftp",
        RCLONE_CONFIG_OFFSITE_HOST: "backup.example.com",
        RCLONE_CONFIG_OFFSITE_PORT: "22",
        RCLONE_CONFIG_OFFSITE_USER: "shop-backups",
        RCLONE_CONFIG_OFFSITE_HOST_KEYS: HOST_KEY,
        RCLONE_CONFIG_OFFSITE_SHELL_TYPE: "none",
        RCLONE_CONFIG_OFFSITE_KEY_PEM: SSH_KEY,
      });
    }
    expect(d.reporter.text()).toContain(
      "The app's server can write to the folder /backups/shop-prod/backups on backup.example.com.",
    );
    expect(d.reporter.text()).not.toContain(PEM.split("\n")[1]);
  });

  it("writes and deletes a test file in the user's own bucket, its endpoint and key from the copies' values", async () => {
    const fake = docker(() => ({ exitCode: 0 }));
    await check(await deps(), withOffsite(S3), fake, S3_VALUES);
    const [touch] = fake.ran;
    expect(touch?.cmd).toEqual([
      "touch",
      `offsite:shop-backups/shop-prod/backups/${OFFSITE_CHECK_FILE}`,
    ]);
    expect(envOf(touch as FakeContainer)).toEqual({
      RCLONE_CONFIG_OFFSITE_TYPE: "s3",
      RCLONE_CONFIG_OFFSITE_PROVIDER: "Other",
      RCLONE_CONFIG_OFFSITE_REGION: "eu-central-1",
      RCLONE_CONFIG_OFFSITE_NO_CHECK_BUCKET: "true",
      RCLONE_CONFIG_OFFSITE_ENDPOINT: S3.endpoint,
      RCLONE_CONFIG_OFFSITE_ACCESS_KEY_ID: ACCESS,
      RCLONE_CONFIG_OFFSITE_SECRET_ACCESS_KEY: SECRET,
    });
  });

  it("names what to fix when the machine refuses, never a secret", async () => {
    const plan = withOffsite(SFTP);
    const refusal = async (stderr: string, command = "touch") => {
      const fake = docker((c) =>
        c.cmd[0] === command ? { exitCode: 1, stderr: `${stderr}\n${SSH_KEY}\n` } : { exitCode: 0 },
      );
      return check(await deps(), plan, fake, SFTP_VALUES).then(
        () => undefined,
        (error: Error & { code: string; hint?: string }) => error,
      );
    };
    const key = await refusal(
      '2026/11/14 03:28:57 CRITICAL: Failed to create file system for "offsite:/backups/": NewFs: couldn\'t connect SSH: ssh: handshake failed: ssh: unable to authenticate, attempted methods [none publickey], no supported methods remain',
    );
    expect(key).toMatchObject({
      code: "CREDENTIALS_INVALID",
      message: expect.stringMatching(
        /^The app's server could not write a test file in the folder \/backups\/shop-prod\/backups on backup\.example\.com: .*unable to authenticate.*\. The deploy secrets are not stored yet\.$/,
      ),
      hint: "The machine refused the key OPSCREW_OFFSITE_SFTP_KEY names: add its public half (`ssh-keygen -y -f <key file>` prints it) to ~/.ssh/authorized_keys of shop-backups on backup.example.com. Then run `opscrew provision` again.",
    });
    const folder = await refusal(
      '2026/11/14 03:28:55 NOTICE: Failed to touch: failed to touch (create): Put mkParentDir failed: mkdir "/backups/shop-prod" failed: permission denied',
    );
    expect(folder).toMatchObject({
      code: "PHASE_PRECONDITION",
      hint: expect.stringContaining(
        "The account shop-backups can't write in /backups/shop-prod/backups: give it write permission on /backups",
      ),
    });
    const changed = await refusal(
      "2026/11/14 03:28:56 CRITICAL: Failed to create file system: ssh: handshake failed: sftp: host key mismatch for backup.example.com:22: server offered ssh-ed25519 key with fingerprint SHA256:B8/U+nAjyhpmJINWrx+HI5/3+Hg8el/yoDL9IPskP5c",
    );
    expect(changed?.hint).toContain("another host key than the one the plan pins");
    expect(changed?.hint).toContain(
      "run `opscrew snapshot offsite on --to sftp --host backup.example.com --user shop-backups --path /backups --host-key <the new fingerprint>` again",
    );
    const deleted = await refusal(
      "2026/11/14 03:28:55 ERROR : Failed to deletefile: permission denied",
      "deletefile",
    );
    expect(deleted?.message).toContain("could not delete a test file");
    for (const error of [key, folder, changed, deleted]) {
      expect(`${error?.message} ${error?.hint}`).not.toContain(PEM.split("\n")[1]);
    }
  });

  it("names the bucket or the key when the user's own bucket refuses", async () => {
    const plan = withOffsite(S3);
    const refusal = async (stderr: string) => {
      const fake = docker(() => ({ exitCode: 1, stderr }));
      return check(await deps(), plan, fake, S3_VALUES).catch(
        (error: Error & { code: string; hint?: string }) => error,
      );
    };
    const bucket = await refusal(
      "2026/11/14 03:00:00 ERROR : Failed to touch: NoSuchBucket: The specified bucket does not exist",
    );
    expect(bucket).toMatchObject({
      code: "PHASE_PRECONDITION",
      hint: "There is no bucket shop-backups at https://s3.eu-central-1.wasabisys.com: check its name at your provider, and correct it with `opscrew snapshot offsite on --to s3 --endpoint https://s3.eu-central-1.wasabisys.com --bucket <name>`. Then run `opscrew provision` again.",
    });
    const key = await refusal(
      "2026/11/14 03:00:00 ERROR : Failed to touch: InvalidAccessKeyId: The AWS Access Key Id you provided does not exist in our records.",
    );
    expect(key).toMatchObject({
      code: "CREDENTIALS_INVALID",
      hint: expect.stringContaining(
        "The bucket refused the key: give the key permission to list, read, write and delete objects in shop-backups, then set OPSCREW_OFFSITE_ACCESS_KEY_ID and OPSCREW_OFFSITE_SECRET_ACCESS_KEY to it",
      ),
    });
    const other = await refusal("");
    expect(other).toMatchObject({
      message:
        "The app's server could not write a test file in your bucket shop-backups at https://s3.eu-central-1.wasabisys.com (eu-central-1) (rclone's exit code 1). The deploy secrets are not stored yet.",
      hint: "Fix what it names. Then run `opscrew provision` again.",
    });
  });

  it("runs on each server with data, and not for a bucket OpsCrew plans", async () => {
    const seen: string[] = [];
    const fake = docker(() => ({ exitCode: 0 }));
    const services = {
      docker: (server: string) => {
        seen.push(server);
        return fake;
      },
    };
    await checkOffsiteWriteOnServers(await deps(), withOffsite(S3), services, S3_VALUES, WORDS);
    expect(seen).toEqual(["app"]);
    expect(fake.ran).toHaveLength(2);
    const planned = withOffsite({ provider: "hetzner", bucket: "shop-backups", region: "fsn1" });
    await checkOffsiteWriteOnServers(await deps(), planned, services, S3_VALUES, WORDS);
    expect(seen).toEqual(["app"]);
  });
});
