import { utimes } from "node:fs/promises";
import { join } from "node:path";
import { fakeSecret } from "@opscrew/core/testing";
import { DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { portainerWorld } from "../snapshot/__fixtures__/portainer";
import { SH_AVAILABLE } from "../snapshot/__fixtures__/server";
import {
  everythingShown,
  RUNNING,
  type SnapshotWorld,
  snapshotWorld,
  splitStagingPlan,
  stagingPlan,
} from "../snapshot/__fixtures__/world";
import { portainerPlan, SERVER_IPV4 } from "../testing";
import { snapshotStatusReport } from "./snapshots";

const VERSION = `sha256:${RUNNING}`;

/** `about.json` as `snapshot.sh` writes it. */
function about(id: string, kind: string, taken: string, services: object[]): string {
  return `${JSON.stringify({ id, kind, taken, version: VERSION, services })}\n`;
}

/** `shop` in staging with PostgreSQL `db` and scheduled snapshots. */
function scheduledPlan() {
  return stagingPlan([{ kind: "postgres", name: "db" }], {
    fields: { snapshots: { schedule: { every: "daily", keep: 4 } } },
  });
}

/** The scheduled snapshot's log on `world`'s app server, last written at `at`. */
async function scheduledLog(world: SnapshotWorld, text: string, at: string): Promise<void> {
  const app = world.servers.app;
  await app?.write(".snapshots/scheduled.log", text);
  const time = new Date(at);
  await utimes(join(app?.dir ?? "", ".snapshots/scheduled.log"), time, time);
}

describe.skipIf(!SH_AVAILABLE)("status's snapshots on servers", () => {
  it("shows the newest snapshot across the servers, scheduled ones included, with its result", async () => {
    const world = await snapshotWorld(splitStagingPlan());
    const { app, data } = world.servers;
    const id = "20261107T030000Z";
    await app?.write(
      ".snapshots/20261106T190000Z/about.json",
      about("20261106T190000Z", "manual", "2026-11-06T19:00:00Z", []),
    );
    await app?.write(
      `.snapshots/${id}/about.json`,
      about(id, "scheduled", "2026-11-07T03:00:05Z", [
        { name: "cache", kind: "valkey", file: "cache.rdb", size: 10 },
      ]),
    );
    await data?.write(
      `.snapshots/${id}/about.json`,
      about(id, "scheduled", "2026-11-07T03:00:05Z", [
        { name: "db", kind: "postgres", file: "db.dump", size: 10 },
      ]),
    );
    await app?.write(`.snapshots/${id}/offsite.done`, "");
    await data?.write(`.snapshots/${id}/offsite.done`, "");
    await scheduledLog(world, `${id}\n`, "2026-11-07T03:00:09Z");

    const report = await snapshotStatusReport(world.deps, world.plan, world.services);

    expect(report.lines).toEqual([
      "Last snapshot: 20261107T030000Z, scheduled, 2026-11-07 03:00 UTC, every part copied, on the app's server and server data, copied off the server.",
    ]);
    expect(report.snapshot?.last?.services.map((service) => service.name)).toEqual(["cache", "db"]);
    expect(report.snapshot?.scheduledFailures).toEqual([]);
    expect(everythingShown(world)).not.toContain(SERVER_IPV4);
  });

  it("says where the copies off the server go, with no secret (T2756)", async () => {
    const machine = {
      provider: "sftp",
      host: "backup.example.com",
      user: "shop-backups",
      path: "/backups",
      hostKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl",
      days: 30,
    };
    const plan = DeployPlanSchema.parse({
      ...stagingPlan([{ kind: "postgres", name: "db" }]),
      snapshots: { offsite: machine },
    });
    const world = await snapshotWorld(plan);
    const report = await snapshotStatusReport(world.deps, world.plan, world.services);
    expect(report.lines).toEqual([
      "Snapshots: none yet; `opscrew snapshot` takes one.",
      "Copies off the server: the folder /backups/shop-staging/backups on backup.example.com, each copy kept 30 days.",
    ]);
    expect(report.snapshot?.offsite).toBe(
      "the folder /backups/shop-staging/backups on backup.example.com, each copy kept 30 days",
    );
  });

  it("names a part left out, and says none yet before the first snapshot", async () => {
    const world = await snapshotWorld(stagingPlan([{ kind: "kafka", name: "events" }]));
    expect((await snapshotStatusReport(world.deps, world.plan, world.services)).lines).toEqual([
      "Snapshots: none yet; `opscrew snapshot` takes one.",
    ]);
    await world.servers.app?.write(
      ".snapshots/20261107T030000Z/about.json",
      about("20261107T030000Z", "scheduled", "2026-11-07T03:00:05Z", [
        { name: "events", kind: "kafka", skipped: true },
      ]),
    );
    const report = await snapshotStatusReport(world.deps, world.plan, world.services);
    expect(report.lines[0]).toBe(
      "Last snapshot: 20261107T030000Z, scheduled, 2026-11-07 03:00 UTC, events left out, on the app's server.",
    );
  });

  it("reports a scheduled snapshot that failed, redacted, but not one being taken", async () => {
    const world = await snapshotWorld(scheduledPlan());
    const secret = fakeSecret("generic-password", "a value in the log");
    world.deps.redactor.addLiteral(secret, "test-secret");
    await scheduledLog(
      world,
      `db was copied\nOpsCrew took no snapshot: ${secret} broke it.\n`,
      "2026-11-07T03:00:20Z",
    );

    const report = await snapshotStatusReport(world.deps, world.plan, world.services);
    expect(report.lines).toEqual([
      "Snapshots: none yet; `opscrew snapshot` takes one.",
      expect.stringMatching(
        /^The last scheduled snapshot on the app's server failed at 2026-11-07 03:00 UTC: OpsCrew took no snapshot: .+ broke it\. Its output is in \.snapshots\/scheduled\.log in the app's folder there\.$/,
      ),
    ]);
    expect(report.snapshot?.scheduledFailures).toEqual([
      expect.objectContaining({ where: "on the app's server", at: "2026-11-07T03:00:20.000Z" }),
    ]);
    expect(JSON.stringify(report)).not.toContain(secret);

    // A `.partial` folder left by a run that stopped is stale: the failure stays.
    await world.servers.app?.write(".snapshots/20261107T040000Z.partial/db.dump", "");
    const stale = await snapshotStatusReport(world.deps, world.plan, world.services);
    expect(stale.snapshot?.scheduledFailures).toHaveLength(1);
    // While a snapshot is being taken (the start lock held), its log is not finished.
    await world.servers.app?.write("lock.held", "");
    const running = await snapshotStatusReport(world.deps, world.plan, world.services);
    expect(running.snapshot?.scheduledFailures).toEqual([]);
  });

  it("reports an off-server copy that failed after the snapshot was taken, not the snapshot", async () => {
    const world = await snapshotWorld(scheduledPlan());
    const id = "20261107T030000Z";
    await world.servers.app?.write(
      `.snapshots/${id}/about.json`,
      about(id, "scheduled", "2026-11-07T03:00:05Z", [
        { name: "db", kind: "postgres", file: "db.dump", size: 10 },
      ]),
    );
    await scheduledLog(
      world,
      `${id}\nCopying the snapshot ${id} off the server failed, so the bucket has no complete copy of it yet.\n`,
      "2026-11-07T03:01:00Z",
    );
    const report = await snapshotStatusReport(world.deps, world.plan, world.services);
    expect(report.lines).toEqual([
      `Last snapshot: ${id}, scheduled, 2026-11-07 03:00 UTC, every part copied, on the app's server.`,
      `The off-server copy of the scheduled snapshot ${id} on the app's server failed at 2026-11-07 03:01 UTC: Copying the snapshot ${id} off the server failed, so the bucket has no complete copy of it yet. Its output is in .snapshots/scheduled.log in the app's folder there.`,
    ]);
    expect(report.snapshot?.scheduledFailures).toEqual([
      expect.objectContaining({ id, at: "2026-11-07T03:01:00.000Z" }),
    ]);

    // An id with nothing after it: taken and copied.
    await scheduledLog(world, `left out: nothing\n${id}\n`, "2026-11-07T03:01:00Z");
    const fine = await snapshotStatusReport(world.deps, world.plan, world.services);
    expect(fine.snapshot?.scheduledFailures).toEqual([]);
  });

  it("reads no scheduled failure once the schedule is off", async () => {
    const world = await snapshotWorld(stagingPlan([{ kind: "postgres", name: "db" }]));
    await scheduledLog(world, "OpsCrew took no snapshot.\n", "2026-11-07T03:00:20Z");
    const report = await snapshotStatusReport(world.deps, world.plan, world.services);
    expect(report.snapshot?.scheduledFailures).toEqual([]);
    expect(world.servers.app?.commands.join("\n")).not.toContain("scheduled.log");
  });

  it("gives a note when a server can't be read, and nothing without data", async () => {
    const world = await snapshotWorld(stagingPlan([{ kind: "postgres", name: "db" }]));
    if (world.servers.app !== undefined) {
      world.servers.app.answer = () => ({ exitCode: 255, stdout: "", stderr: "" });
    }
    expect((await snapshotStatusReport(world.deps, world.plan, world.services)).lines).toEqual([
      "Snapshots: The app's server did not answer over SSH, so OpsCrew could not read the snapshots. Check that it is on and reachable (`opscrew status`), then try again.",
    ]);
    const empty = await snapshotWorld(stagingPlan([]));
    expect(await snapshotStatusReport(empty.deps, empty.plan, empty.services)).toEqual({
      lines: [],
    });
  });
});

describe("status's snapshots in Portainer", () => {
  it("shows the last one with the scheduled parts that failed", async () => {
    const plan = stagingPlan(
      [
        { kind: "postgres", name: "db" },
        { kind: "valkey", name: "cache" },
      ],
      { base: portainerPlan({ deployed: true }) },
    );
    const world = await portainerWorld(plan);
    world.store("20261107T030000Z", {
      id: "20261107T030000Z",
      kind: "scheduled",
      taken: "2026-11-07T03:00:30Z",
      version: VERSION,
      services: [
        { name: "db", kind: "postgres", file: "db.dump", size: 10 },
        { name: "cache", kind: "valkey", failed: true },
      ],
    });
    const report = await snapshotStatusReport(world.deps, world.plan, world.services);
    expect(report.lines).toEqual([
      "Last snapshot: 20261107T030000Z, scheduled, 2026-11-07 03:00 UTC, the copy of cache failed, in your Portainer.",
    ]);
  });
});
