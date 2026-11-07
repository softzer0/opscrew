import { readFile } from "node:fs/promises";
import { type DeployPlan, readArtifact, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { localPlan } from "../localhost/__fixtures__/computer";
import { createTestPhaseDeps, ownPlan, testPlan } from "../testing";
import { stagingPlan } from "./__fixtures__/world";
import { snapshotOffsiteOff, snapshotOffsiteOn } from "./offsite";

const DB = [{ kind: "postgres" as const, name: "db" }];

/** Phase deps of `plan`'s environment with `plan` written, and the plan file's text. */
async function world(plan: DeployPlan) {
  const deps = await createTestPhaseDeps({ environment: plan.environment?.name ?? "prod" });
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

  it("takes R2 for a domain on Cloudflare, with --days, and keeps the bucket's name", async () => {
    const plan = stagingPlan(DB, {
      base: testPlan({ deployed: true, domain: "shop.example.com" }),
    });
    const { deps } = await world(plan);
    await snapshotOffsiteOn(deps, { to: "hetzner", region: "fsn1" });
    const change = await snapshotOffsiteOn(deps, { to: "r2", days: 30 });

    expect(change.plan.snapshots?.offsite).toEqual({
      provider: "r2",
      bucket: "shop-staging-backups",
      days: 30,
    });
    expect(change.lines[0]).toBe(
      "The copy of staging's snapshots off the server (snapshots.offsite in opscrew/environments/staging/plan.yaml): the private bucket shop-staging-backups on Hetzner Object Storage (fsn1), each copy kept 90 days → the private bucket shop-staging-backups on Cloudflare R2, each copy kept 30 days.",
    );
    expect(change.lines[2]).toBe(
      "Expected cost: $0.00/month at Cloudflare R2, plus what the copies store beyond what that includes.",
    );
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
      "The bucket shop-staging-backups and the copies in it stay: OpsCrew never deletes them, and Hetzner Object Storage deletes each 60 days after it was copied. To delete them sooner, empty and delete the bucket in the Hetzner Console (Object Storage).",
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
});
