import { OpsCrewError } from "@opscrew/core";
import { describe, expect, it } from "vitest";
import { SERVER_IPV4 } from "../testing";
import { fakeProvider, WHOLE_SERVER } from "./__fixtures__/provider";
import { SH_AVAILABLE } from "./__fixtures__/server";
import {
  DATA_IPV4,
  everythingShown,
  RUNNING,
  type SnapshotWorld,
  snapshotWorld,
  splitStagingPlan,
  stagingPlan,
} from "./__fixtures__/world";
import { deleteSnapshot } from "./delete";

const ID = "20261106T190000Z";

/** The error `promise` rejects with. */
async function failure(promise: Promise<unknown>): Promise<OpsCrewError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  if (!(error instanceof OpsCrewError)) throw new Error(`expected an OpsCrewError, got ${error}`);
  return error;
}

/** The snapshot `ID` with its parts on the app's server (Valkey) and on `data` (PostgreSQL). */
async function splitSnapshot(world: SnapshotWorld): Promise<void> {
  const about = (service: object) =>
    `${JSON.stringify({ id: ID, kind: "manual", taken: "2026-11-06T19:00:00Z", version: `sha256:${RUNNING}`, services: [service] })}\n`;
  await world.servers.app?.write(
    `.snapshots/${ID}/about.json`,
    about({ name: "cache", kind: "valkey", file: "cache.rdb", size: 100 }),
  );
  await world.servers.data?.write(
    `.snapshots/${ID}/about.json`,
    about({ name: "db", kind: "postgres", file: "db.dump", size: 1000 }),
  );
}

describe.skipIf(!SH_AVAILABLE)("opscrew snapshot delete", () => {
  it("deletes every part after the destroy-grade approval with the id typed", async () => {
    const world = await snapshotWorld(splitStagingPlan());
    await splitSnapshot(world);
    const deleted = await deleteSnapshot(world.deps, ID, { services: world.services });

    expect(deleted).toEqual({
      id: ID,
      where: "on the app's server and server data",
      outcome: "deleted",
    });
    const [request] = world.handler.requests;
    expect(request).toMatchObject({
      kind: "remote-exec",
      title: `Delete the snapshot ${ID} of staging on the app's server and server data`,
      allowDestroy: true,
      confirmPhrase: ID,
    });
    expect(request?.details).toContain(
      "Its copies of cache and db are deleted for good: `opscrew restore` can no longer put them back.",
    );
    expect(await world.servers.app?.calls()).toEqual(["list", `delete ${ID}`]);
    expect(await world.servers.data?.calls()).toEqual(["list", `delete ${ID}`]);
    expect(await world.servers.data?.read(`.snapshots/${ID}/about.json`)).toBeUndefined();
    expect(
      world.deps.audit.entries.filter((entry) => entry.action === "delete a snapshot"),
    ).toEqual([
      expect.objectContaining({ kind: "remote-exec", target: "server app", decision: "approved" }),
      expect.objectContaining({ kind: "remote-exec", target: "server data", decision: "approved" }),
    ]);
    const shown = everythingShown(world);
    expect(shown).not.toContain(SERVER_IPV4);
    expect(shown).not.toContain(DATA_IPV4);
  });

  it("deletes nothing when the id is not typed", async () => {
    const world = await snapshotWorld(splitStagingPlan(), {
      answer: () => ({ approved: true, confirmation: "yes" }),
    });
    await splitSnapshot(world);
    const error = await failure(deleteSnapshot(world.deps, ID, { services: world.services }));

    expect(error.code).toBe("APPROVAL_REFUSED");
    expect(error.message).toBe(
      `The snapshot ${ID} was not deleted: confirmation phrase did not match. Nothing was changed.`,
    );
    expect(error.hint).toBe(
      `Run \`opscrew snapshot delete ${ID}\` again and type ${ID} (in a script: --confirm ${ID}).`,
    );
    expect(await world.servers.app?.calls()).toEqual(["list"]);
  });

  it("says when the snapshot went meanwhile", async () => {
    const world = await snapshotWorld(stagingPlan([{ kind: "postgres", name: "db" }]));
    await world.servers.app?.write(
      `.snapshots/${ID}/about.json`,
      `${JSON.stringify({ id: ID, kind: "manual", taken: "2026-11-06T19:00:00Z", version: "", services: [] })}\n`,
    );
    world.handler.request = async (request) => {
      // Someone deletes it while the user reads the approval.
      world.servers.app?.sh(`rm -rf .snapshots/${ID}`);
      return {
        approved: true,
        approver: "test",
        decidedAt: "",
        confirmation: request.confirmPhrase,
      };
    };
    const deleted = await deleteSnapshot(world.deps, ID, {
      services: { ...world.services, serverSnapshots: () => undefined },
    });
    expect(deleted.outcome).toBe("already gone");
    expect(world.deps.reporter.text()).toContain(
      `The snapshot ${ID} of staging on the app's server was already gone.`,
    );
  });

  it("deletes a whole-server snapshot at the provider", async () => {
    const world = await snapshotWorld(stagingPlan([{ kind: "postgres", name: "db" }]));
    const provider = fakeProvider([WHOLE_SERVER]);
    const deleted = await deleteSnapshot(world.deps, WHOLE_SERVER.id, {
      services: { ...world.services, serverSnapshots: () => provider.api },
    });

    expect(deleted.outcome).toBe("deleted");
    expect(provider.deleted).toEqual([WHOLE_SERVER.id]);
    expect(world.handler.requests[0]).toMatchObject({
      allowDestroy: true,
      confirmPhrase: WHOLE_SERVER.id,
      title: `Delete the snapshot ${WHOLE_SERVER.id} of staging at Hetzner Cloud (server shop-staging)`,
    });
    expect(world.deps.audit.entries).toContainEqual(
      expect.objectContaining({
        kind: "provider-call",
        action: "delete a snapshot",
        target: "hetzner server shop-staging",
        detail: `${WHOLE_SERVER.id}: deleted`,
      }),
    );
  });

  it("reports a provider's 404 as already gone", async () => {
    const world = await snapshotWorld(stagingPlan([{ kind: "postgres", name: "db" }]));
    const provider = fakeProvider([WHOLE_SERVER], { gone: true });
    const deleted = await deleteSnapshot(world.deps, WHOLE_SERVER.id, {
      services: { ...world.services, serverSnapshots: () => provider.api },
    });
    expect(deleted.outcome).toBe("already gone");
  });

  it("refuses an unknown id, an id that isn't one, and a delete during a deploy", async () => {
    const world = await snapshotWorld(stagingPlan([{ kind: "postgres", name: "db" }]));
    const services = { ...world.services, serverSnapshots: () => undefined };
    const unknown = await failure(deleteSnapshot(world.deps, ID, { services }));
    expect(unknown.code).toBe("PHASE_PRECONDITION");
    expect(unknown.message).toBe(`staging has no snapshot ${ID}. Nothing was changed.`);

    const wrong = await failure(deleteSnapshot(world.deps, "../x", { services }));
    expect(wrong.code).toBe("INVALID_INPUT");

    const busy = await snapshotWorld(stagingPlan([{ kind: "postgres", name: "db" }]), {
      runs: [{ status: "queued", htmlUrl: "https://github.com/acme/shop/actions/runs/9" }],
    });
    const running = await failure(deleteSnapshot(busy.deps, ID, { services: busy.services }));
    expect(running.message).toContain("OpsCrew does not delete a snapshot during a deploy");
    expect(busy.servers.app?.commands).toEqual([]);
    expect(world.handler.requests).toEqual([]);
  });
});
