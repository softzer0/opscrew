import { rm } from "node:fs/promises";
import { join } from "node:path";
import { OpsCrewError } from "@opscrew/core";
import { DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { localPlan } from "../localhost/__fixtures__/computer";
import { inEnvironment } from "../promote/__fixtures__/world";
import { recordOwnServer } from "../shared";
import {
  OWN_IPV4,
  ownPlan,
  pagesTestPlan,
  ScriptedRunner,
  SERVER_IPV4,
  testPlan,
} from "../testing";
import { SH_AVAILABLE } from "./__fixtures__/server";
import {
  DATA_IPV4,
  everythingShown,
  RUNNING,
  type ServiceEntry,
  snapshotWorld,
  splitStagingPlan,
  stagingPlan,
} from "./__fixtures__/world";
import { takeSnapshot } from "./take";

/** PostgreSQL and Valkey copied while they run, Kafka stopped for its copy, and SQLite. */
const MIXED: ServiceEntry[] = [
  { kind: "postgres", name: "db" },
  { kind: "valkey", name: "cache" },
  { kind: "kafka", name: "kafka" },
];

/** The error `promise` rejects with. */
async function failure(promise: Promise<unknown>): Promise<OpsCrewError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  if (!(error instanceof OpsCrewError)) throw new Error(`expected an OpsCrewError, got ${error}`);
  return error;
}

describe.skipIf(!SH_AVAILABLE)("opscrew snapshot on servers", () => {
  it("names the stop-only service and its stop, and takes the snapshot after the approval", async () => {
    const world = await snapshotWorld(stagingPlan(MIXED, { sqlite: true }));
    const taken = await takeSnapshot(world.deps, { services: world.services });

    expect(taken.id).toBe("20261106T190000Z");
    expect(taken.where).toBe("on the app's server");
    expect(await world.servers.app?.calls()).toEqual([
      `take manual --stop kafka --version sha256:${RUNNING}`,
    ]);
    const summary = world.deps.reporter.lines.find((line) => line.level === "info")?.message;
    expect(summary).toContain("- db (PostgreSQL) on the app's server, while it runs");
    expect(summary).toContain(
      "- sqlite (the app's SQLite files) on the app's server, while it runs",
    );
    expect(summary).toContain(
      "- kafka (Apache Kafka) on the app's server: it stops alone for its copy (up to 120 seconds to stop cleanly",
    );
    const [request] = world.handler.requests;
    expect(world.handler.requests).toHaveLength(1);
    expect(request?.kind).toBe("remote-exec");
    expect(request?.title).toBe(
      "Maintenance window: stop kafka of staging, one at a time, for its copy in a snapshot",
    );
    expect(request?.details).toContain(
      "Only kafka stops; the app and every other service keep running.",
    );
    expect(request?.allowDestroy).toBeUndefined();
    expect(world.deps.audit.entries).toContainEqual(
      expect.objectContaining({
        kind: "remote-exec",
        action: "take a snapshot",
        target: "server app",
        decision: "approved",
        detail: "20261106T190000Z: db, cache, kafka, sqlite",
      }),
    );
    expect(taken.services).toContainEqual({
      name: "kafka",
      kind: "kafka",
      server: "app",
      state: "copied",
    });
  });

  it("leaves a service out with --skip, and asks nothing when nothing stops", async () => {
    const world = await snapshotWorld(stagingPlan(MIXED));
    const taken = await takeSnapshot(world.deps, { skip: ["kafka"], services: world.services });

    expect(await world.servers.app?.calls()).toEqual([
      `take manual --skip kafka --version sha256:${RUNNING}`,
    ]);
    expect(world.handler.requests).toEqual([]);
    expect(world.deps.reporter.text()).toContain("Left out (--skip): kafka.");
    expect(taken.services.find((service) => service.name === "kafka")?.state).toBe("skipped");
  });

  it("stops nothing when the stop is not approved", async () => {
    const world = await snapshotWorld(stagingPlan(MIXED), { answer: () => false });
    const error = await failure(takeSnapshot(world.deps, { services: world.services }));

    expect(error.code).toBe("APPROVAL_REFUSED");
    expect(error.message).toBe("Nothing was stopped. No snapshot was taken.");
    expect(error.hint).toContain("leave kafka out with --skip");
    expect(await world.servers.app?.calls()).toEqual([]);
  });

  it("refuses a --skip of no service with data", async () => {
    const world = await snapshotWorld(stagingPlan(MIXED));
    const error = await failure(
      takeSnapshot(world.deps, { skip: ["queue"], services: world.services }),
    );
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.message).toBe("queue is no service with data in staging. No snapshot was taken.");
    expect(world.servers.app?.commands).toEqual([]);
  });

  it("refuses too little disk before anything, saying how much is needed", async () => {
    const world = await snapshotWorld(stagingPlan(MIXED));
    // 10 GiB with 512 MiB free: it needs 1 GiB.
    await world.servers.app?.disk(10_485_760, 524_288);
    const error = await failure(takeSnapshot(world.deps, { services: world.services }));

    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toBe(
      "The disk that holds the snapshots on the app's server has 512.0 MB free of 10.0 GB: a snapshot needs 1.0 GB free (1 GiB and 10% of the disk), so OpsCrew took no snapshot. Nothing was changed.",
    );
    expect(error.hint).toContain("Free 512.0 MB there");
    expect(world.handler.requests).toEqual([]);
    expect(await world.servers.app?.calls()).toEqual([]);
  });

  it("refuses while a deploy runs, naming it, before reaching the server", async () => {
    const url = "https://github.com/acme/shop/actions/runs/7";
    const world = await snapshotWorld(stagingPlan(MIXED), {
      runs: [{ status: "in_progress", htmlUrl: url }],
    });
    const error = await failure(takeSnapshot(world.deps, { services: world.services }));

    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toContain(
      `A run of staging's deploy workflow is queued or in progress: ${url}.`,
    );
    expect(world.servers.app?.commands).toEqual([]);
  });

  it("refuses while the app moves to another target or a service between servers", async () => {
    const plan = stagingPlan(MIXED);
    const moving = DeployPlanSchema.parse({
      ...plan,
      retarget: {
        from: { target: testPlan({ provider: "digitalocean" }).target },
        step: "renamed",
        startedAt: "2026-11-06T09:00:00.000Z",
      },
    });
    const world = await snapshotWorld(moving);
    const error = await failure(takeSnapshot(world.deps, { services: world.services }));
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toContain("OpsCrew does not take a snapshot while the app moves.");

    const split = splitStagingPlan();
    const shifting = await snapshotWorld(
      DeployPlanSchema.parse({
        ...split,
        move: { service: "db", from: "data", to: "app", step: "started", copy: "dump" },
      }),
    );
    const moved = await failure(takeSnapshot(shifting.deps, { services: shifting.services }));
    expect(moved.message).toBe(
      "db moves between the app's servers, so OpsCrew does not take a snapshot until the move is finished. Nothing was changed.",
    );
    expect(shifting.servers.app?.commands).toEqual([]);
  });

  it("gives the parts on an extra server the app's server's id and running version", async () => {
    const world = await snapshotWorld(splitStagingPlan());
    const taken = await takeSnapshot(world.deps, { services: world.services });

    expect(await world.servers.app?.calls()).toEqual([`take manual --version sha256:${RUNNING}`]);
    expect(await world.servers.data?.calls()).toEqual([
      `take manual --id 20261106T190000Z --version sha256:${RUNNING}`,
    ]);
    expect(taken.where).toBe("on the app's server and server data");
    expect(taken.services).toEqual([
      { name: "cache", kind: "valkey", server: "app", state: "copied" },
      { name: "db", kind: "postgres", server: "data", state: "copied" },
    ]);
    expect(world.deps.audit.entries.map((entry) => entry.target)).toEqual([
      "server app",
      "server data",
    ]);
  });

  it("says which parts stay when an extra server's part fails", async () => {
    const world = await snapshotWorld(splitStagingPlan());
    await world.servers.data?.write("take.exit", "1");
    await world.servers.data?.write("take.stderr", "The copy of db failed.");
    const error = await failure(takeSnapshot(world.deps, { services: world.services }));

    expect(error.code).toBe("COMMAND_FAILED");
    expect(error.message).toBe(
      "OpsCrew could not take the snapshot on server data (exit code 1): The copy of db failed. The parts the app's server took stay in the snapshot 20261106T190000Z: delete it with `opscrew snapshot delete 20261106T190000Z` before you take a new one, or keep them.",
    );
  });

  it("asks for a deploy when the server has no snapshot.sh", async () => {
    const world = await snapshotWorld(stagingPlan(MIXED));
    await rm(join(world.servers.app?.dir ?? "", "snapshot.sh"));
    const error = await failure(
      takeSnapshot(world.deps, { skip: ["kafka"], services: world.services }),
    );
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toBe(
      "The app's folder on the app's server has no snapshot.sh, which each deploy uploads, so OpsCrew could not take the snapshot.",
    );
    expect(error.hint).toContain("Deploy the app again (push to main");
  });

  it("shows no server address, password or data in its output, audit or approval", async () => {
    const world = await snapshotWorld(stagingPlan(MIXED));
    await world.servers.app?.write("take.exit", "2");
    await world.servers.app?.write(
      "take.stderr",
      `ssh: connect to host ${SERVER_IPV4}: The disk that holds /srv/apps/shop-staging has less than 1 GiB or 10% free.`,
    );
    const error = await failure(takeSnapshot(world.deps, { services: world.services }));

    expect(error.message).toContain("[REDACTED:server-address]");
    const shown = everythingShown(world, error);
    expect(shown).not.toContain(SERVER_IPV4);
    expect(shown).not.toContain(DATA_IPV4);
  });

  it("on the user's own server, runs the script as deploy through the admin login's sudo", async () => {
    const world = await snapshotWorld(
      stagingPlan(MIXED, { base: { ...ownPlan({ deployed: true }), services: [] } }),
    );
    await recordOwnServer(world.deps.paths, {
      host: OWN_IPV4,
      port: 22,
      user: "alice",
      agent: true,
      reachable: true,
    });
    const app = world.servers.app;
    if (app === undefined) throw new Error("no server");
    // The host adapter's probe: this login reaches Docker only through passwordless sudo.
    app.answer = (command) =>
      command.includes("echo sudo") ? { exitCode: 0, stdout: "sudo\n", stderr: "" } : undefined;
    await takeSnapshot(world.deps, { skip: ["kafka"], services: world.services });

    const take = app.commands.find((command) => command.includes("take"));
    expect(take).toMatch(/^sudo -n sh -c '/);
    expect(take).toContain("runuser -u deploy -- sh -c");
    expect(await app.calls()).toEqual([`take manual --skip kafka --version sha256:${RUNNING}`]);
    expect(everythingShown(world)).not.toContain(OWN_IPV4);
  });

  it("refuses a site, which keeps no data", async () => {
    const world = await snapshotWorld(inEnvironment(pagesTestPlan(), "staging"));
    const error = await failure(takeSnapshot(world.deps, { services: world.services }));
    expect(error.message).toContain("is a site on GitHub Pages");
  });
});

describe.skipIf(!SH_AVAILABLE)("opscrew snapshot on this computer", () => {
  it("runs snapshot.sh in the app's folder through the local shell", async () => {
    const local = localPlan();
    const plan = stagingPlan(MIXED, { base: { ...local, services: [] } });
    const world = await snapshotWorld(plan);
    const machine = world.servers.app;
    if (machine === undefined) throw new Error("no machine");
    const runner = new ScriptedRunner((command, args, options) => {
      if (command === "docker") return { exitCode: 1, stdout: "", stderr: "" };
      if (command === "sh" && args[0] === "-s") {
        const script = String(options?.input ?? "")
          .replace(/^\{\n/, "")
          .replace(/\n\} ; exit \$\?\n$/, "");
        return machine.sh(script);
      }
      return { exitCode: 1, stdout: "", stderr: "not scripted" };
    });
    world.deps.runner = runner;
    const taken = await takeSnapshot(world.deps, {
      skip: ["kafka"],
      services: { ...world.services, localhost: { platform: "linux", which: () => "sh" } },
    });

    expect(taken.where).toBe("on this computer");
    expect(await machine.calls()).toEqual([`take manual --skip kafka --version sha256:${RUNNING}`]);
    expect(taken.services.every((service) => service.server === undefined)).toBe(true);
  });
});
