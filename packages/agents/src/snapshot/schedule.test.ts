import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { snapshotScheduleTag } from "@opscrew/connector-ssh-host";
import { switchCommands } from "@opscrew/iac-templates";
import { type DeployPlan, readArtifact, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { localPlan } from "../localhost/__fixtures__/computer";
import { createTestPhaseDeps, testPlan } from "../testing";
import { portainerPlan } from "../testing/portainer";
import { previewTestPlan } from "../testing/previews";
import { sitePlan } from "../testing/serverless";
import { SH_AVAILABLE } from "./__fixtures__/server";
import { stagingPlan } from "./__fixtures__/world";
import { snapshotScheduleOff, snapshotScheduleOn } from "./schedule";

/** `shop` in staging on a Hetzner server with PostgreSQL `db` and the stop-only Kafka `events`. */
function serverPlan(fields?: Record<string, unknown>): DeployPlan {
  return stagingPlan(
    [
      { kind: "postgres", name: "db" },
      { kind: "kafka", name: "events" },
    ],
    fields === undefined ? {} : { fields },
  );
}

/** Phase deps of staging with `plan` written, and the plan file's text before any command. */
async function world(plan: DeployPlan) {
  const deps = await createTestPhaseDeps({ environment: plan.environment?.name ?? "prod" });
  await writeArtifact("plan", deps.paths.files.plan, plan);
  const before = await readFile(deps.paths.files.plan, "utf8");
  const onDisk = () => readFile(deps.paths.files.plan, "utf8");
  return { deps, before, onDisk };
}

describe("opscrew snapshot schedule on", () => {
  it("writes the defaults, says what changed and what is left out, and to provision", async () => {
    const { deps } = await world(serverPlan());
    const change = await snapshotScheduleOn(deps);

    expect(change.changed).toBe(true);
    expect(change.plan.snapshots).toEqual({ schedule: { every: "weekly", keep: 4 } });
    expect((await readArtifact("plan", deps.paths.files.plan)).snapshots).toEqual({
      schedule: { every: "weekly", keep: 4 },
    });
    expect(change.lines).toEqual([
      "Scheduled snapshots of staging's data (snapshots.schedule in opscrew/environments/staging/plan.yaml): off → weekly, the last 4 kept.",
      "events is left out: it must stop for its copy. Add --stop events to copy it on the schedule, stopped alone meanwhile.",
      "Each stays on the machine that holds the data, as the snapshots by hand do.",
      "Run `opscrew provision` to put the schedule on the server.",
    ]);
  });

  it("takes --every, --keep and --stop over the plan's values, and keeps those not given", async () => {
    const { deps } = await world(serverPlan());
    await snapshotScheduleOn(deps, { every: "12h", stop: ["events"] });
    const change = await snapshotScheduleOn(deps, { keep: 7 });

    expect(change.plan.snapshots?.schedule).toEqual({ every: "12h", keep: 7, stop: ["events"] });
    expect(change.lines[0]).toBe(
      "Scheduled snapshots of staging's data (snapshots.schedule in opscrew/environments/staging/plan.yaml): every 12 hours, the last 4 kept, events stopped for its copy → every 12 hours, the last 7 kept, events stopped for its copy.",
    );
    expect(change.lines.join("\n")).not.toContain("left out");
  });

  it("writes nothing when the plan already says so", async () => {
    const { deps, before, onDisk } = await world(
      serverPlan({ snapshots: { schedule: { every: "weekly", keep: 4 } } }),
    );
    const change = await snapshotScheduleOn(deps);

    expect(change.changed).toBe(false);
    expect(change.lines).toEqual([
      "Scheduled snapshots of staging's data are already weekly, the last 4 kept. Nothing was changed.",
    ]);
    expect(await onDisk()).toBe(before);
  });

  it("refuses a value the plan refuses, naming it, and writes nothing", async () => {
    const { deps, before, onDisk } = await world(serverPlan());
    await expect(snapshotScheduleOn(deps, { every: "200h" })).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: expect.stringContaining(
        'OpsCrew cannot take scheduled snapshots: snapshots.schedule.every must be "daily", "weekly" or a number of hours from 1 to 168',
      ),
    });
    await expect(snapshotScheduleOn(deps, { stop: ["db"] })).rejects.toMatchObject({
      message: expect.stringContaining("a snapshot copies postgres while it runs"),
    });
    await expect(snapshotScheduleOn(deps, { keep: 31 })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(await onDisk()).toBe(before);
  });

  it("refuses --stop in Portainer (D3), and says what the schedule leaves out there", async () => {
    const plan = stagingPlan(
      [
        { kind: "postgres", name: "db" },
        { kind: "kafka", name: "events" },
      ],
      { base: portainerPlan({ deployed: true }) },
    );
    const { deps, before, onDisk } = await world(plan);
    await expect(snapshotScheduleOn(deps, { stop: ["events"] })).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: expect.stringContaining(
        "In Portainer a scheduled snapshot can't stop a service: stopping one needs Docker on the host",
      ),
    });
    expect(await onDisk()).toBe(before);

    const change = await snapshotScheduleOn(deps, { every: "daily" });
    expect(change.lines.slice(1)).toEqual([
      "events is left out: in Portainer the scheduled snapshots copy only the services copied while they run, because stopping one needs Docker on the host, which the stack has no access to. Take a snapshot with it by hand with `opscrew snapshot`.",
      "Each stays on the machine that holds the data, as the snapshots by hand do.",
      "Run `opscrew provision` to put the schedule on the app's stack in your Portainer.",
    ]);
  });

  it("refuses this computer, a preview environment, a site and an environment without data", async () => {
    const local = await world(localPlan({ environment: "staging" }));
    await expect(snapshotScheduleOn(local.deps)).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      message:
        "OpsCrew does not take scheduled snapshots on this computer: it isn't always on to take them. Nothing was changed.",
    });
    expect(await local.onDisk()).toBe(local.before);

    const preview = await world(previewTestPlan());
    await expect(snapshotScheduleOn(preview.deps)).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      message: expect.stringContaining("a preview environment"),
    });

    const site = await world(sitePlan());
    await expect(snapshotScheduleOn(site.deps)).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      message: expect.stringContaining("nothing to snapshot"),
    });

    const empty = await world(testPlan({ postgres: false }));
    await expect(snapshotScheduleOn(empty.deps)).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      message: expect.stringContaining("no service that keeps data and no SQLite volume"),
    });
  });
});

describe("opscrew snapshot schedule off", () => {
  it("removes the schedule, says the snapshots stay, and to provision", async () => {
    const { deps } = await world(
      serverPlan({ snapshots: { schedule: { every: "daily", keep: 2 } } }),
    );
    const change = await snapshotScheduleOff(deps);

    expect(change.changed).toBe(true);
    expect((await readArtifact("plan", deps.paths.files.plan)).snapshots).toBeUndefined();
    expect(change.lines).toEqual([
      "Scheduled snapshots of staging's data (snapshots.schedule in opscrew/environments/staging/plan.yaml): daily, the last 2 kept → off.",
      "The scheduled snapshots already taken stay until you delete them with `opscrew snapshot delete <id>`; `opscrew snapshot list` lists them.",
      "Run `opscrew provision` to take the schedule off the server.",
    ]);
  });

  it("keeps the off-server copy, and says when the schedule is already off", async () => {
    const offsite = { provider: "hetzner", bucket: "shop-staging-backups", region: "nbg1" };
    const { deps, before, onDisk } = await world(serverPlan({ snapshots: { offsite } }));
    const change = await snapshotScheduleOff(deps);

    expect(change).toMatchObject({
      changed: false,
      lines: ["Scheduled snapshots of staging's data are already off. Nothing was changed."],
    });
    expect(await onDisk()).toBe(before);
  });
});

describe.skipIf(!SH_AVAILABLE)("the schedule's crontab line", () => {
  it("ends with the tag ssh-host finds the app's line by (the two packages keep a copy each)", () => {
    const plan = serverPlan({ snapshots: { schedule: { every: "daily", keep: 2 } } });
    const write = switchCommands(plan, []).find((line) => line.endsWith("| crontab -")) as string;
    // A crontab that starts empty and prints what it is given.
    const crontab = 'crontab() { if [ "$1" = -l ]; then return 1; fi; cat; }; APPS_DIR=/srv/apps';
    const run = spawnSync("sh", ["-c", `${crontab}\n${write}`], { encoding: "utf8" });
    const app = plan.app.name;

    expect(run.stdout).toBe(
      `0 * * * * sh /srv/apps/${app}/snapshot.sh take scheduled > /dev/null 2>&1${snapshotScheduleTag(app)}\n`,
    );
  });
});
