import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { type DeployPlan, readArtifact, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { localPlan } from "../localhost/__fixtures__/computer";
import { backupsStateFile } from "../provision/storage";
import { hostKeyFingerprint } from "../shared";
import {
  createTestPhaseDeps,
  HOST_KEY,
  ownPlan,
  projectRunner,
  ScriptedApprovalHandler,
  ScriptedRunner,
  type TestPhaseDepsOptions,
  testPlan,
} from "../testing";
import { stagingPlan } from "./__fixtures__/world";
import { snapshotOffsiteOff, snapshotOffsiteOn } from "./offsite";

const DB = [{ kind: "postgres" as const, name: "db" }];

/** Phase deps of `plan`'s environment with `plan` written, and the plan file's text. */
async function world(plan: DeployPlan, options: TestPhaseDepsOptions = {}) {
  const deps = await createTestPhaseDeps({
    environment: plan.environment?.name ?? "prod",
    ...options,
  });
  await writeArtifact("plan", deps.paths.files.plan, plan);
  const before = await readFile(deps.paths.files.plan, "utf8");
  const onDisk = () => readFile(deps.paths.files.plan, "utf8");
  return { deps, before, onDisk };
}

const PROVISION =
  "Run `opscrew provision` to create the bucket after you approve its plan; it asks for the bucket's access key, which you create.";
const ENCRYPTED =
  "Each snapshot taken by hand or on the schedule is encrypted to the recovery copy's age key before it leaves the machine that holds the data, so only your key opens the copies.";

describe("opscrew snapshot offsite on", () => {
  it("plans the bucket at the server's location on Hetzner, with its price, and says to provision", async () => {
    // The test server is in nbg1, where Hetzner has object storage.
    const { deps } = await world(stagingPlan(DB));
    const change = await snapshotOffsiteOn(deps, { to: "hetzner" });

    const offsite = {
      provider: "hetzner",
      bucket: "shop-staging-backups",
      region: "nbg1",
      days: 90,
    };
    expect(change.plan.snapshots).toEqual({ offsite });
    expect((await readArtifact("plan", deps.paths.files.plan)).snapshots).toEqual({ offsite });
    expect(change.lines).toEqual([
      "The copy of staging's snapshots off the server (snapshots.offsite in opscrew/environments/staging/plan.yaml): off → the private bucket shop-staging-backups on Hetzner Object Storage (nbg1), each copy kept 90 days.",
      ENCRYPTED,
      // provision's price data: Hetzner's base price, charged once per account.
      "Expected cost: €6.49/month at Hetzner Object Storage, plus what the copies store beyond what that includes. Hetzner charges the base price once per account, for every hour any bucket exists. If your account already pays it, this app adds only what it uses beyond the shared quota.",
      PROVISION,
    ]);
  });

  it("takes R2 for a domain on Cloudflare, with --days", async () => {
    const plan = stagingPlan(DB, {
      base: testPlan({ deployed: true, domain: "shop.example.com" }),
    });
    const { deps } = await world(plan);
    const change = await snapshotOffsiteOn(deps, { to: "r2", days: 30 });

    expect(change.plan.snapshots?.offsite).toEqual({
      provider: "r2",
      bucket: "shop-staging-backups",
      days: 30,
    });
    expect(change.lines[0]).toBe(
      "The copy of staging's snapshots off the server (snapshots.offsite in opscrew/environments/staging/plan.yaml): off → the private bucket shop-staging-backups on Cloudflare R2, each copy kept 30 days.",
    );
    expect(change.lines[2]).toBe(
      "Expected cost: $0.00/month at Cloudflare R2, plus what the copies store beyond what that includes.",
    );
  });

  it("keeps a region given earlier when --days alone changes", async () => {
    // The server is in nbg1; the copies went to hel1.
    const { deps } = await world(stagingPlan(DB));
    await snapshotOffsiteOn(deps, { to: "hetzner", region: "hel1" });
    const change = await snapshotOffsiteOn(deps, { to: "hetzner", days: 30 });
    expect(change.plan.snapshots?.offsite).toEqual({
      provider: "hetzner",
      bucket: "shop-staging-backups",
      region: "hel1",
      days: 30,
    });
  });

  it("refuses another provider or region while the copies' bucket exists, saying how to start over", async () => {
    const plan = stagingPlan(DB, {
      base: testPlan({ deployed: true, domain: "shop.example.com" }),
    });
    const { deps, onDisk } = await world(plan);
    await snapshotOffsiteOn(deps, { to: "hetzner", region: "fsn1" });
    const before = await onDisk();
    const state = backupsStateFile(deps.paths);
    await expect(
      snapshotOffsiteOn(deps, { to: "digitalocean", region: "fra1" }),
    ).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      message:
        "The copies of staging's snapshots are in the bucket shop-staging-backups on Hetzner Object Storage (fsn1), and OpsCrew does not move that bucket or its copies. Nothing was changed.",
      hint: expect.stringContaining(
        `first delete the bucket shop-staging-backups in the Hetzner Console (Object Storage), then delete OpsCrew's record of it (${state}`,
      ),
    });
    await expect(snapshotOffsiteOn(deps, { to: "hetzner", region: "hel1" })).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
    });
    expect(await onDisk()).toBe(before);

    // After `off`, the backups root's state still holds the bucket.
    await snapshotOffsiteOff(deps);
    await mkdir(dirname(state), { recursive: true });
    await writeFile(
      state,
      JSON.stringify({
        resources: [
          {
            type: "aws_s3_bucket",
            instances: [{ attributes: { bucket: "shop-staging-backups" } }],
          },
        ],
      }),
    );
    await expect(snapshotOffsiteOn(deps, { to: "r2" })).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      message: expect.stringContaining("are in the bucket shop-staging-backups, and OpsCrew"),
      hint: expect.stringContaining("in its provider's console"),
    });
    // The same bucket again is fine.
    const again = await snapshotOffsiteOn(deps, { to: "hetzner", region: "fsn1" });
    expect(again.changed).toBe(true);
  });

  it("takes the Spaces region of a droplet's location, and writes nothing when nothing changes", async () => {
    const { deps } = await world(testPlan({ provider: "digitalocean", deployed: true }));
    const first = await snapshotOffsiteOn(deps, { to: "digitalocean" });
    expect(first.plan.snapshots?.offsite).toEqual({
      provider: "digitalocean",
      bucket: "shop-prod-backups",
      region: "fra1",
      days: 90,
    });
    expect(first.lines[2]).toContain("Expected cost: $5.00/month at DigitalOcean Spaces");

    const text = await readFile(deps.paths.files.plan, "utf8");
    const again = await snapshotOffsiteOn(deps, { to: "digitalocean" });
    expect(again).toMatchObject({
      changed: false,
      lines: [
        "The copy of prod's snapshots off the server is already the private bucket shop-prod-backups on DigitalOcean Spaces (fra1), each copy kept 90 days. Nothing was changed.",
      ],
    });
    expect(await readFile(deps.paths.files.plan, "utf8")).toBe(text);
  });

  it("asks for --region where the server's location has none, and refuses wrong regions", async () => {
    const { deps, before, onDisk } = await world(ownPlan({ deployed: true }));
    await expect(snapshotOffsiteOn(deps, { to: "hetzner" })).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message:
        "OpsCrew needs the bucket's region at Hetzner Object Storage: the app's server is elsewhere. Nothing was changed.",
      hint: "Choose one of fsn1, nbg1, hel1: `opscrew snapshot offsite on --to hetzner --region <region>`.",
    });
    await expect(snapshotOffsiteOn(deps, { to: "digitalocean" })).rejects.toMatchObject({
      hint: expect.stringContaining("Choose a Spaces region, such as fra1"),
    });
    await expect(snapshotOffsiteOn(deps, { to: "hetzner", region: "ash" })).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: "Hetzner has no object storage in ash. Nothing was changed.",
    });
    await expect(snapshotOffsiteOn(deps, { to: "r2", region: "weur" })).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: expect.stringContaining("R2 picks"),
    });
    await expect(
      snapshotOffsiteOn(deps, { to: "hetzner", region: "fsn1", days: 0 }),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: expect.stringContaining("snapshots.offsite.days"),
    });
    expect(await onDisk()).toBe(before);

    const own = await snapshotOffsiteOn(deps, { to: "hetzner", region: "hel1" });
    expect(own.plan.snapshots?.offsite).toMatchObject({ region: "hel1" });
  });

  it("refuses R2 without a domain on Cloudflare, and this computer", async () => {
    const { deps, before, onDisk } = await world(stagingPlan(DB));
    await expect(snapshotOffsiteOn(deps, { to: "r2" })).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      message: expect.stringContaining("Cloudflare R2 needs the app's domain on Cloudflare"),
    });
    expect(await onDisk()).toBe(before);

    const local = await world(localPlan());
    await expect(
      snapshotOffsiteOn(local.deps, { to: "hetzner", region: "fsn1" }),
    ).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      message:
        "OpsCrew does not copy the snapshots off the server on this computer: its snapshots stay on this computer, beside the data. Nothing was changed.",
    });
  });
});

describe("opscrew snapshot offsite off", () => {
  it("removes the copy and says the bucket and its copies stay, and how to delete them", async () => {
    const offsite = {
      provider: "hetzner",
      bucket: "shop-staging-backups",
      region: "nbg1",
      days: 60,
    };
    const schedule = { every: "daily", keep: 4 };
    const { deps } = await world(stagingPlan(DB, { fields: { snapshots: { schedule, offsite } } }));
    const change = await snapshotOffsiteOff(deps);

    expect((await readArtifact("plan", deps.paths.files.plan)).snapshots).toEqual({ schedule });
    expect(change.lines).toEqual([
      "The copy of staging's snapshots off the server (snapshots.offsite in opscrew/environments/staging/plan.yaml): the private bucket shop-staging-backups on Hetzner Object Storage (nbg1), each copy kept 60 days → off.",
      "The bucket shop-staging-backups and the copies in it stay: OpsCrew never deletes them, and Hetzner Object Storage expires each copy after 60 days. To delete them sooner, empty and delete the bucket in the Hetzner Console (Object Storage).",
      "Run `opscrew provision` to stop the uploads.",
    ]);
  });

  it("says Spaces' copies stay until deleted, and that an off copy is already off", async () => {
    const offsite = { provider: "digitalocean", bucket: "shop-prod-backups", region: "fra1" };
    const plan = {
      ...testPlan({ provider: "digitalocean", deployed: true }),
      snapshots: { offsite },
    };
    const { deps } = await world(plan as DeployPlan);
    const change = await snapshotOffsiteOff(deps);
    expect(change.lines[1]).toBe(
      "The bucket shop-prod-backups and the copies in it stay: OpsCrew never deletes them, and with no more uploads nothing deletes the old ones. To delete them sooner, empty and delete the bucket in the DigitalOcean control panel (Spaces Object Storage).",
    );
    expect((await snapshotOffsiteOff(deps)).lines).toEqual([
      "The copy of prod's snapshots off the server is already off. Nothing was changed.",
    ]);
  });

  it("says the copies stay in the user's own folder or bucket, and how to delete them (T2756)", async () => {
    const machine = {
      provider: "sftp",
      host: "backup.example.com",
      port: 23,
      user: "shop-backups",
      path: "/",
      hostKey: HOST_KEY,
    };
    const { deps } = await world({
      ...testPlan({ deployed: true }),
      snapshots: { offsite: machine },
    } as DeployPlan);
    const change = await snapshotOffsiteOff(deps);
    expect(change.lines).toEqual([
      "The copy of prod's snapshots off the server (snapshots.offsite in opscrew/plan.yaml): the folder /shop-prod/backups on backup.example.com (port 23), each copy kept 90 days → off.",
      "The folder /shop-prod/backups on backup.example.com and the copies in it stay: OpsCrew never deletes them, and with no more uploads nothing deletes the old ones. To delete them, delete that folder on the machine.",
      "Run `opscrew provision` to stop the uploads.",
    ]);
    const own = { provider: "s3", endpoint: "https://s3.example.com", bucket: "shop-backups" };
    const bucket = await world({
      ...testPlan({ deployed: true }),
      snapshots: { offsite: own },
    } as DeployPlan);
    expect((await snapshotOffsiteOff(bucket.deps)).lines[1]).toBe(
      "Your bucket shop-backups and the copies in it stay: OpsCrew never deletes them, and with no more uploads nothing deletes the old ones. To delete them, delete the folder shop-prod/ in the bucket with your provider's console.",
    );
  });
});

describe("opscrew snapshot offsite on, to the user's own storage (T2756)", () => {
  const ENDPOINT = "https://s3.eu-central-1.wasabisys.com";
  const FINGERPRINT = hostKeyFingerprint(HOST_KEY.split(" ")[1] ?? "");
  const SFTP = {
    to: "sftp",
    host: "backup.example.com",
    user: "shop-backups",
    path: "/backups/",
  } as const;
  /** A world whose `ssh-keyscan` reads {@link HOST_KEY}, run in a terminal or not. */
  const machineWorld = async (interactive: boolean) => {
    const handler = new ScriptedApprovalHandler(() => true);
    const w = await world(stagingPlan(DB), {
      runner: projectRunner(HOST_KEY),
      approvalHandler: handler,
      interactive,
    });
    return { ...w, handler };
  };

  it("keeps the copies in the user's own S3-compatible bucket, priced by nobody, which provision checks", async () => {
    const { deps } = await world(stagingPlan(DB));
    const change = await snapshotOffsiteOn(deps, {
      to: "s3",
      endpoint: `${ENDPOINT}/`,
      bucket: "shop-backups",
      region: "eu-central-1",
    });
    const offsite = {
      provider: "s3",
      endpoint: ENDPOINT,
      bucket: "shop-backups",
      region: "eu-central-1",
      days: 90,
    };
    expect(change.plan.snapshots).toEqual({ offsite });
    expect((await readArtifact("plan", deps.paths.files.plan)).snapshots).toEqual({ offsite });
    expect(change.lines).toEqual([
      `The copy of staging's snapshots off the server (snapshots.offsite in opscrew/environments/staging/plan.yaml): off → your bucket shop-backups at ${ENDPOINT} (eu-central-1), each copy kept 90 days.`,
      ENCRYPTED,
      "OpsCrew prices nothing for it: the copies go to your own bucket, and its provider bills what they store.",
      "Run `opscrew provision` to put the bucket's key on the server and check that it can write there; it asks for the key, which you create (in a script: OPSCREW_OFFSITE_ACCESS_KEY_ID and OPSCREW_OFFSITE_SECRET_ACCESS_KEY).",
    ]);
  });

  it("refuses an http endpoint, a missing flag, a relative folder and a flag of another --to, changing nothing", async () => {
    const { deps, before, onDisk } = await world(stagingPlan(DB));
    await expect(
      snapshotOffsiteOn(deps, { to: "s3", endpoint: "http://minio.local:9000", bucket: "b-1" }),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message:
        "--endpoint must be an https:// address: the server sends the bucket's key there, never over plain http. Nothing was changed.",
    });
    await expect(snapshotOffsiteOn(deps, { to: "s3", endpoint: ENDPOINT })).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message:
        "`opscrew snapshot offsite on --to s3` needs --endpoint and --bucket: your bucket's S3 address (https://…) and its name. --bucket is missing. Nothing was changed.",
      hint: "Run `opscrew snapshot offsite on --to s3 --endpoint https://<your provider's S3 address> --bucket <name>`.",
    });
    await expect(
      snapshotOffsiteOn(deps, { to: "sftp", host: "backup.example.com" }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("--user and --path are missing."),
    });
    await expect(
      snapshotOffsiteOn(deps, { to: "s3", endpoint: ENDPOINT, bucket: "b-1", host: "x", port: 23 }),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: "--host and --port do not apply to --to s3. Nothing was changed.",
      hint: "Leave them out: --to s3 takes --endpoint, --bucket, --region and --days.",
    });
    await expect(snapshotOffsiteOn(deps, { ...SFTP, region: "eu" })).rejects.toMatchObject({
      message: "--region does not apply to --to sftp. Nothing was changed.",
    });
    await expect(snapshotOffsiteOn(deps, { to: "hetzner", bucket: "b-1" })).rejects.toMatchObject({
      message: "--bucket does not apply to --to hetzner. Nothing was changed.",
    });
    await expect(snapshotOffsiteOn(deps, { ...SFTP, path: "backups" })).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message:
        "--path must be an absolute folder on the machine, such as /backups or /home/<user>/backups: a relative one would depend on where the account starts. Nothing was changed.",
    });
    await expect(
      snapshotOffsiteOn(deps, { to: "s3", endpoint: ENDPOINT, bucket: "Shop_Backups" }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("snapshots.offsite.bucket must be the bucket's name"),
    });
    expect(await onDisk()).toBe(before);
  });

  it("reads the SFTP machine's host key, shows its fingerprint to confirm in a terminal, and pins the key in the plan", async () => {
    const { deps, handler } = await machineWorld(true);
    const change = await snapshotOffsiteOn(deps, SFTP);
    const offsite = {
      provider: "sftp",
      host: "backup.example.com",
      user: "shop-backups",
      path: "/backups",
      hostKey: HOST_KEY,
      days: 90,
    };
    expect(change.plan.snapshots).toEqual({ offsite });
    expect(handler.requests).toHaveLength(1);
    expect(handler.requests[0]).toMatchObject({
      kind: "remote-exec",
      title: "Trust the SSH host key of the machine for the off-server copies",
      details: expect.stringContaining(`  ssh-ed25519 ${FINGERPRINT}`),
    });
    expect(change.lines).toEqual([
      "The copy of staging's snapshots off the server (snapshots.offsite in opscrew/environments/staging/plan.yaml): off → the folder /backups/shop-staging/backups on backup.example.com, each copy kept 90 days.",
      `The machine's host key, which you confirmed: ssh-ed25519 ${FINGERPRINT}; the copies go only to a machine that presents it.`,
      ENCRYPTED,
      "OpsCrew prices nothing for it: the copies go to your own machine, and its provider bills what they store.",
      "Run `opscrew provision` to put the private key the file in OPSCREW_OFFSITE_SFTP_KEY holds on the server and check that it can write there; first add its public half to ~/.ssh/authorized_keys of shop-backups on the machine.",
    ]);
    // Again with --days: the pinned key still matches, so nothing is asked.
    const again = await snapshotOffsiteOn(deps, { ...SFTP, days: 30 });
    expect(again.plan.snapshots?.offsite).toEqual({ ...offsite, days: 30 });
    expect(handler.requests).toHaveLength(1);
  });

  it("takes the fingerprint with --host-key in a script, and refuses another one or none", async () => {
    const { deps, before, onDisk, handler } = await machineWorld(false);
    await expect(snapshotOffsiteOn(deps, SFTP)).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      message: `The machine's host key must be confirmed before OpsCrew trusts it: backup.example.com (port 22) presents ssh-ed25519 ${FINGERPRINT}. Nothing was changed.`,
      hint: expect.stringContaining(
        `run \`opscrew snapshot offsite on --to sftp --host backup.example.com --user <user> --path <folder> --host-key ${FINGERPRINT}\``,
      ),
    });
    const other = "SHA256:B8/U+nAjyhpmJINWrx+HI5/3+Hg8el/yoDL9IPskP5c";
    await expect(snapshotOffsiteOn(deps, { ...SFTP, hostKey: other })).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      message: `The machine at backup.example.com (port 22) presented ssh-ed25519 ${FINGERPRINT}, not the fingerprint you gave (${other}). Nothing was changed.`,
      hint: expect.stringContaining("Otherwise someone may be intercepting the connection."),
    });
    await expect(snapshotOffsiteOn(deps, { ...SFTP, hostKey: "ab:cd" })).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: expect.stringContaining("--host-key must be the machine's host key fingerprint"),
    });
    expect(await onDisk()).toBe(before);
    const change = await snapshotOffsiteOn(deps, { ...SFTP, port: 23, hostKey: FINGERPRINT });
    expect(change.plan.snapshots?.offsite).toMatchObject({ port: 23, hostKey: HOST_KEY });
    expect(handler.requests).toEqual([]);
  });

  it("checks the machine's fields before it connects, so a host is never read as an option", async () => {
    const ran: string[] = [];
    const { deps } = await world(stagingPlan(DB), {
      runner: new ScriptedRunner((command) => {
        ran.push(command);
        return { exitCode: 0, stdout: "", stderr: "" };
      }),
      interactive: true,
    });
    await expect(
      snapshotOffsiteOn(deps, { ...SFTP, host: "-oProxyCommand=touch /tmp/x" }),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: expect.stringContaining(
        "snapshots.offsite.host must be a host name or an IP address",
      ),
    });
    await expect(snapshotOffsiteOn(deps, { ...SFTP, user: "-x" })).rejects.toMatchObject({
      message: expect.stringContaining("snapshots.offsite.user must be the account's user name"),
    });
    expect(ran).toEqual([]);
  });

  it("refuses a host key that changed since it was confirmed, and a machine that doesn't answer", async () => {
    const { deps } = await machineWorld(true);
    await snapshotOffsiteOn(deps, SFTP);
    const pinned = await readFile(deps.paths.files.plan, "utf8");
    const again = (runner?: ReturnType<typeof projectRunner>) =>
      createTestPhaseDeps({
        root: deps.paths.root,
        env: deps.env,
        environment: "staging",
        ...(runner === undefined ? {} : { runner }),
        interactive: true,
      });
    const changed = await again(
      projectRunner(
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAnotherKeyForTestsOnlyAnotherKeyForTests",
      ),
    );
    await expect(snapshotOffsiteOn(changed, { ...SFTP, days: 7 })).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      message: expect.stringContaining(
        `The host key of the machine at backup.example.com (port 22) changed since you confirmed it (confirmed: ${FINGERPRINT}; now: ssh-ed25519 SHA256:`,
      ),
    });
    expect(await readFile(deps.paths.files.plan, "utf8")).toBe(pinned);
    await expect(
      snapshotOffsiteOn(await again(), { ...SFTP, host: "other.example.com" }),
    ).rejects.toMatchObject({
      code: "COMMAND_FAILED",
      message:
        "OpsCrew could not reach SSH at other.example.com (port 22), so it could not read the machine's host key. Nothing was changed.",
    });
  });

  it("moves from a bucket OpsCrew made to the user's own storage, saying the earlier copies stay there", async () => {
    const { deps } = await machineWorld(true);
    await snapshotOffsiteOn(deps, { to: "hetzner", region: "fsn1" });
    const own = await snapshotOffsiteOn(deps, {
      to: "s3",
      endpoint: ENDPOINT,
      bucket: "shop-backups",
    });
    expect(own.lines).toContain(
      `The copies made so far stay in the private bucket shop-staging-backups on Hetzner Object Storage (fsn1): OpsCrew never deletes them, and \`opscrew restore --from offsite\` reads only your bucket shop-backups at ${ENDPOINT} (us-east-1) from now on.`,
    );
    const machine = await snapshotOffsiteOn(deps, SFTP);
    expect(machine.lines).toContainEqual(
      expect.stringMatching(
        /^The copies made so far stay in your bucket shop-backups at .* reads only the folder \/backups\/shop-staging\/backups on backup\.example\.com from now on\.$/,
      ),
    );
  });
});
