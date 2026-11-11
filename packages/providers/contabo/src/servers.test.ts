import type { ServerSnapshotApi } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import type { FakeReply } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import {
  CREDENTIALS_ENV,
  contaboFetch,
  fakeTime,
  fixture,
  instance,
  page,
  param,
} from "./__fixtures__/fixtures";
import { contaboConnector } from "./connector";

function setup(routes: Record<string, FakeReply | FakeReply[]>) {
  const fake = contaboFetch(routes);
  const time = fakeTime();
  const connector = contaboConnector({
    env: CREDENTIALS_ENV,
    fetch: fake.fetch,
    sleep: time.sleep,
    now: () => new Date(time.now()),
  });
  const api = connector.servers as ServerSnapshotApi;
  const calls = () =>
    fake.calls
      .filter((call) => !call.url.startsWith("https://auth."))
      .map((c) => `${c.method} ${c.path}`);
  return { api, fake, calls, time };
}

const INSTANCES = {
  "/v1/compute/instances?page=1": { body: fixture("instances-page1.json") },
  "/v1/compute/instances?page=2": { body: fixture("instances-page2.json") },
};

/** The OpsCrew app tags `shop` (on 101 and 103) and `shop-api` (on 104). */
const TAGS = {
  "/v1/tags?": { body: fixture("tags.json") },
  "/v1/tags/7/assignments?": { body: fixture("assignments.json") },
  "/v1/tags/8/assignments?": { body: fixture("assignments-other-app.json") },
};

/** A snapshot as Contabo lists it. */
function snapshot(id: string, name: string, createdDate: string, instanceId = 101) {
  return { snapshotId: id, name, description: "", instanceId, createdDate };
}

/** The error `promise` rejects with. */
async function failure(promise: Promise<unknown>): Promise<OpsCrewError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OpsCrewError);
  return error as OpsCrewError;
}

describe("servers.findAppServers", () => {
  it("finds the app's tagged instances, and untagged ones named after it as nameOnly", async () => {
    const { api, calls } = setup({ ...TAGS, ...INSTANCES });
    expect(await api.findAppServers("shop")).toEqual([
      // Tagged and named `shop`: once, without nameOnly.
      { id: "101", name: "shop", status: "running" },
      // Untagged and named `shop`: a create that stopped before the tag was attached.
      { id: "102", name: "shop", status: "provisioning", nameOnly: true },
      // A cancelled one carries the day its contract ends.
      { id: "103", name: "shop-worker", status: "stopped", cancelledUntil: "2026-12-10" },
      // Untagged and named `shop-…`: an extra server's create that stopped halfway.
      { id: "106", name: "shop-web", status: "running", nameOnly: true },
    ]);
    // `shopping` (105) is another name; `shop-api` (104) carries another app's tag; `blog` (200)
    // is neither.
    expect(calls()[0]).toBe("GET /v1/tags?page=1&size=100");
  });

  it("finds untagged instances by name when the app has no tag yet", async () => {
    const { api } = setup({ "/v1/tags?": page([]), ...INSTANCES });
    expect(await api.findAppServers("shop")).toEqual([
      { id: "101", name: "shop", status: "running", nameOnly: true },
      { id: "102", name: "shop", status: "provisioning", nameOnly: true },
      {
        id: "103",
        name: "shop-worker",
        status: "stopped",
        cancelledUntil: "2026-12-10",
        nameOnly: true,
      },
      { id: "104", name: "shop-api", status: "running", nameOnly: true },
      { id: "106", name: "shop-web", status: "running", nameOnly: true },
    ]);
  });

  it("finds no servers when neither a tag nor a name matches", async () => {
    const { api } = setup({ ...TAGS, ...INSTANCES });
    expect(await api.findAppServers("wiki")).toEqual([]);
  });

  it("ignores tags that are not OpsCrew's app tags and assignments that are not instances", async () => {
    const { api, calls } = setup({
      "/v1/tags?": page([
        { tagId: 7, name: "opscrew-app:shop" },
        { tagId: 9, name: "team-opscrew-app:shop" },
      ]),
      "/v1/tags/7/assignments?": page([
        { tagId: 7, resourceType: "image", resourceId: "200", resourceName: "an image" },
      ]),
      "/v1/compute/instances?": page([{ instanceId: 200, name: "vmi200", status: "running" }]),
    });
    expect(await api.findAppServers("shop")).toEqual([]);
    expect(calls().some((call) => call.includes("/v1/tags/9/"))).toBe(false);
  });

  it("reads every page of a tag's assignments", async () => {
    const { api, fake } = setup({
      "/v1/tags?": page([{ tagId: 7, name: "opscrew-app:shop" }]),
      "/v1/tags/7/assignments?page=1": {
        body: {
          data: [{ resourceType: "instance", resourceId: "101" }],
          _pagination: { page: 1, totalPages: 2 },
        },
      },
      "/v1/tags/7/assignments?page=2": {
        body: {
          data: [{ resourceType: "instance", resourceId: 200 }],
          _pagination: { page: 2, totalPages: 2 },
        },
      },
      ...INSTANCES,
    });
    const tagged = (await api.findAppServers("shop")).filter((server) => !server.nameOnly);
    expect(tagged.map((server) => server.id)).toEqual(["101", "200"]);
    const pages = fake.calls.filter((call) => call.path.startsWith("/v1/tags/7/"));
    expect(pages.map((call) => param(call, "page"))).toEqual(["1", "2"]);
  });
});

describe("servers snapshots", () => {
  it("snapshots the instance with a name Contabo accepts, once, and returns its id", async () => {
    const created = snapshot(
      "snap1762862400",
      "opscrew-shop-before-destroy-20",
      "2026-11-11T12:00:00Z",
    );
    const { api, calls, fake, time } = setup({
      "POST /v1/compute/instances/101/snapshots": {
        status: 201,
        body: { data: [created], _links: {} },
      },
    });
    const result = await api.snapshotServer("101", {
      name: "opscrew-shop-before-destroy-20261111T120000Z",
      description: "OpsCrew snapshot of shop before destroy",
      labels: { "created-by": "opscrew" },
    });
    expect(result).toEqual({ snapshotId: "101:snap1762862400" });
    expect(calls()).toEqual(["POST /v1/compute/instances/101/snapshots"]);
    expect(fake.calls.at(-1)?.body).toEqual({
      name: "opscrew-shop-before-destroy-20",
      description: "OpsCrew snapshot of shop before destroy",
    });
    expect(time.waits).toEqual([]);
  });

  // Contabo's reference documents no error body for this refusal: the 400 and its wording are
  // unverified (the spike checks them).
  it("says how to make room when Contabo refuses a snapshot at the plan's limit", async () => {
    const { api, calls } = setup({
      "POST /v1/compute/instances/101/snapshots": {
        status: 400,
        body: { statusCode: 400, message: "Snapshot limit reached for this instance" },
      },
    });
    const error = await failure(
      api.snapshotServer("101", { name: "opscrew-shop", description: "d", labels: {} }),
    );
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toBe(
      "Contabo answered HTTP 400 to POST /v1/compute/instances/101/snapshots: Snapshot limit reached for this instance",
    );
    expect(error.hint).toContain(
      "Contabo counts every snapshot on the server, including ones taken by hand",
    );
    expect(error.hint).toContain("`opscrew snapshot delete <id>`");
    expect(error.hint).toContain("Customer Control Panel");
    expect(calls()).toEqual(["POST /v1/compute/instances/101/snapshots"]);
  });

  it("keeps the general hint for another refusal of a snapshot", async () => {
    const { api } = setup({
      "POST /v1/compute/instances/101/snapshots": {
        status: 400,
        body: { statusCode: 400, message: "description must not be empty" },
      },
    });
    const error = await failure(
      api.snapshotServer("101", { name: "opscrew-shop", description: "", labels: {} }),
    );
    expect(error.hint).toBe(
      "Contabo refused the request as sent: fix what it named above, then try again.",
    );
  });

  it("lists the snapshots OpsCrew took, oldest first, with their instance in the id", async () => {
    const { api } = setup({
      "/v1/compute/instances/101/snapshots?": { body: fixture("snapshots.json") },
    });
    expect(await api.listSnapshots("101")).toEqual([
      { id: "101:snap1762754400", createdAt: "2026-11-10T06:00:00.000Z" },
      { id: "101:snap1762851600", createdAt: "2026-11-11T09:00:00.000Z" },
    ]);
  });

  it("deletes a snapshot through the instance its id names", async () => {
    const { api, calls } = setup({
      "DELETE /v1/compute/instances/102/snapshots/snap1762851600": { status: 204 },
    });
    await api.deleteSnapshot("102:snap1762851600");
    expect(calls()).toEqual(["DELETE /v1/compute/instances/102/snapshots/snap1762851600"]);
  });

  it("refuses a malformed snapshot id before calling Contabo", async () => {
    const { api, fake } = setup({});
    for (const id of [
      "snap1762851600",
      "x:snap1",
      "101:",
      "101:a:b",
      ":snap1",
      "101:..",
      "101:snap/1",
    ]) {
      const error = await failure(api.deleteSnapshot(id));
      expect(error.code).toBe("INVALID_INPUT");
      expect(error.message).toContain("<instance id>:<snapshot id>");
    }
    expect(fake.calls).toEqual([]);
  });

  it("refuses an id that is not an instance's before calling Contabo", async () => {
    const { api, fake } = setup({});
    const error = await failure(api.listSnapshots("vmi101"));
    expect(error.code).toBe("INVALID_INPUT");
    expect(fake.calls).toEqual([]);
  });
});

describe("servers revert and power", () => {
  it("rebuilds by reverting to the snapshot, then waits until the instance runs", async () => {
    const { api, calls, time } = setup({
      "POST /v1/compute/instances/101/snapshots/snap1/rollback": { body: { _links: {} } },
      "GET /v1/compute/instances/101": [instance(101, "installing"), instance(101, "running")],
    });
    await api.rebuild("101", "101:snap1");
    expect(calls()).toEqual([
      "POST /v1/compute/instances/101/snapshots/snap1/rollback",
      "GET /v1/compute/instances/101",
      "GET /v1/compute/instances/101",
    ]);
    expect(time.waits).toEqual([5000]);
  });

  it("refuses to revert an instance to another instance's snapshot", async () => {
    const { api, fake } = setup({});
    const error = await failure(api.rebuild("101", "102:snap1"));
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.message).toContain("is of Contabo instance 102, not 101");
    expect(fake.calls).toEqual([]);
  });

  it("stops waiting when the instance is in error, with Contabo's reason", async () => {
    const { api } = setup({
      "POST /v1/compute/instances/101/snapshots/snap1/rollback": { body: { _links: {} } },
      "GET /v1/compute/instances/101": instance(101, "error", { errorMessage: "disk failure" }),
    });
    const error = await failure(api.rebuild("101", "101:snap1"));
    expect(error.message).toBe("Contabo instance 101 is in error: disk failure");
  });

  it("powers off with a graceful shutdown, never a stop, and waits until it is stopped", async () => {
    const { api, calls, time } = setup({
      "POST /v1/compute/instances/101/actions/shutdown": {
        status: 201,
        body: { data: [{ instanceId: 101, action: "shutdown" }], _links: {} },
      },
      "GET /v1/compute/instances/101": [instance(101, "running"), instance(101, "stopped")],
    });
    await api.powerOff("101");
    expect(calls()).toEqual([
      "POST /v1/compute/instances/101/actions/shutdown",
      "GET /v1/compute/instances/101",
      "GET /v1/compute/instances/101",
    ]);
    expect(time.waits).toEqual([5000]);
  });

  it("gives up after five minutes when the instance does not stop, naming its status", async () => {
    const { api, calls } = setup({
      "POST /v1/compute/instances/101/actions/shutdown": { status: 201, body: { data: [] } },
      "GET /v1/compute/instances/101": instance(101, "running"),
    });
    const error = await failure(api.powerOff("101"));
    expect(error.message).toBe(
      "Contabo instance 101 was not stopped within 5 minutes: it is running.",
    );
    expect(calls().some((call) => call.endsWith("/actions/stop"))).toBe(false);
  });

  it("powers on and waits until the instance runs", async () => {
    const { api, calls } = setup({
      "POST /v1/compute/instances/101/actions/start": { status: 201, body: { data: [] } },
      "GET /v1/compute/instances/101": [instance(101, "stopped"), instance(101, "running")],
    });
    await api.powerOn("101");
    expect(calls()[0]).toBe("POST /v1/compute/instances/101/actions/start");
    expect(calls()).toHaveLength(3);
  });
});
