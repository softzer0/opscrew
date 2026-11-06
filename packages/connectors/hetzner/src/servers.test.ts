import type { VpsConnector } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { type FakeReply, fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { fakeSleep, hetznerFetch, param } from "./__fixtures__/fixtures";
import { type HetznerConnector, hetznerConnector } from "./connector";

const token = fakeSecret("hcloud-token");

// Type-level check: the Hetzner connector satisfies the VPS connector contract.
const asVps = (c: HetznerConnector) => c satisfies VpsConnector;

function setup(routes: Record<string, FakeReply | FakeReply[]>, clockStepMs = 0) {
  const fake = hetznerFetch(routes);
  const sleeper = fakeSleep();
  let time = Date.parse("2026-10-12T10:00:00Z");
  const connector = hetznerConnector({
    env: { HCLOUD_TOKEN: token },
    fetch: fake.fetch,
    sleep: sleeper.sleep,
    now: () => {
      const current = new Date(time);
      time += clockStepMs;
      return current;
    },
  });
  return { connector, calls: fake.calls, waits: sleeper.waits };
}

function action(id: number, status: string, error: unknown = null) {
  return {
    id,
    command: "create_image",
    status,
    progress: status === "success" ? 100 : 40,
    started: "2026-10-12T10:00:00+00:00",
    finished: null,
    resources: [{ id: 7, type: "server" }],
    error,
  };
}

const createImage = {
  status: 201,
  body: {
    image: { id: 4711, type: "snapshot", status: "creating", description: "before destroy" },
    action: action(99, "running"),
  },
};

const request = {
  name: "shop-before-destroy",
  description: "before destroy",
  labels: { "managed-by": "opscrew", app: "shop" },
};

describe("hetznerConnector as a VpsConnector", () => {
  it("is configured with a token and exposes the server API", () => {
    const { connector } = setup({});
    expect(asVps(connector).configured).toBe(true);
    expect(connector.servers).toBeDefined();
  });

  it("is not configured and has no server API without a token", () => {
    for (const env of [{}, { HCLOUD_TOKEN: "  " }]) {
      const c = hetznerConnector({ env });
      expect(c.configured).toBe(false);
      expect(c.servers).toBeUndefined();
    }
  });
});

describe("servers.findAppServers", () => {
  it("lists servers by the OpsCrew app label selector and returns string ids", async () => {
    const { connector, calls } = setup({
      "/servers": {
        body: {
          servers: [
            {
              id: 42,
              name: "shop-web",
              status: "running",
              labels: { "managed-by": "opscrew", app: "shop" },
              public_net: { ipv4: { ip: "203.0.113.10" } },
            },
          ],
          meta: { pagination: { next_page: null } },
        },
      },
    });
    expect(await connector.servers?.findAppServers("shop")).toEqual([
      { id: "42", name: "shop-web", status: "running" },
    ]);
    expect(calls[0]?.method).toBe("GET");
    expect(param(calls[0], "label_selector")).toBe("managed-by=opscrew,app=shop");
  });
});

describe("servers.snapshotServer", () => {
  it("creates the snapshot with the description and labels, waits and returns the image id", async () => {
    const { connector, calls, waits } = setup({
      "POST /servers/7/actions/create_image": createImage,
      "/actions/99": [
        { body: { action: action(99, "running") } },
        { body: { action: action(99, "success") } },
      ],
    });
    expect(await connector.servers?.snapshotServer("7", request)).toEqual({ snapshotId: "4711" });
    expect(calls[0]?.body).toEqual({
      type: "snapshot",
      description: "before destroy",
      labels: { "managed-by": "opscrew", app: "shop" },
    });
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /servers/7/actions/create_image",
      "GET /actions/99",
      "GET /actions/99",
    ]);
    expect(waits).toEqual([2000]);
  });

  it("surfaces an action that ends in error", async () => {
    const { connector } = setup({
      "POST /servers/7/actions/create_image": createImage,
      "/actions/99": { body: { action: action(99, "error", { code: "x", message: "disk busy" }) } },
    });
    const error = (await connector.servers
      ?.snapshotServer("7", request)
      .catch((e: unknown) => e)) as OpsCrewError;
    expect(error).toBeInstanceOf(OpsCrewError);
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toContain("disk busy");
    expect(`${error.message} ${error.hint}`).not.toContain(token);
  });

  it("waits 15 minutes by default and honours the request timeout", async () => {
    const running = { body: { action: action(99, "running") } };
    const byDefault = setup(
      { "POST /servers/7/actions/create_image": createImage, "/actions/99": running },
      60_000,
    );
    const defaultError = (await byDefault.connector.servers
      ?.snapshotServer("7", request)
      .catch((e: unknown) => e)) as OpsCrewError;
    expect(defaultError.code).toBe("PROVIDER_ERROR");
    expect(defaultError.message).toContain("did not finish within 15 minutes");

    const custom = setup(
      { "POST /servers/7/actions/create_image": createImage, "/actions/99": running },
      60_000,
    );
    const customError = (await custom.connector.servers
      ?.snapshotServer("7", { ...request, timeoutMs: 120_000 })
      .catch((e: unknown) => e)) as OpsCrewError;
    expect(customError.message).toContain("did not finish within 2 minutes");
  });

  it("rejects a non-numeric server id without calling the API", async () => {
    const { connector, calls } = setup({});
    const error = (await connector.servers
      ?.snapshotServer("abc", request)
      .catch((e: unknown) => e)) as OpsCrewError;
    expect(error.code).toBe("INVALID_INPUT");
    expect(calls).toHaveLength(0);
  });
});

const password = fakeSecret("generic-password");

function image(id: number, created: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    type: "snapshot",
    status: "available",
    description: `snapshot ${id}`,
    created,
    image_size: 1.25,
    disk_size: 40,
    created_from: { id: 7, name: "shop-web" },
    bound_to: null,
    labels: {},
    ...extra,
  };
}

function errorOf(promise: Promise<unknown> | undefined): Promise<OpsCrewError> {
  return (promise ?? Promise.resolve()).then(
    () => {
      throw new Error("expected a failure");
    },
    (e: unknown) => e as OpsCrewError,
  );
}

function textOf(error: OpsCrewError): string {
  return `${error.message} ${error.hint ?? ""}`;
}

describe("servers.listSnapshots", () => {
  it("lists the server's snapshots across pages, oldest first, with labels and sizes", async () => {
    const opscrew = { "managed-by": "opscrew", "opscrew-app": "shop", "opscrew-env": "production" };
    const { connector, calls } = setup({
      "/images?page=1": {
        body: {
          images: [
            image(12, "2026-11-05T10:00:00+00:00", { labels: opscrew }),
            image(20, "2026-11-01T10:00:00+00:00", { created_from: { id: 8, name: "other" } }),
          ],
          meta: { pagination: { next_page: 2 } },
        },
      },
      "/images?page=2": {
        body: {
          images: [
            image(11, "2026-11-02T10:00:00+00:00", { description: null, labels: undefined }),
            image(13, "2026-11-06T10:00:00+00:00", { status: "creating", image_size: null }),
            image(30, "2026-11-03T10:00:00+00:00", { created_from: null }),
          ],
          meta: { pagination: { next_page: null } },
        },
      },
    });
    expect(await connector.servers?.listSnapshots("7")).toEqual([
      { id: "11", name: "", createdAt: "2026-11-02T10:00:00+00:00", sizeGb: 1.25, labels: {} },
      {
        id: "12",
        name: "snapshot 12",
        createdAt: "2026-11-05T10:00:00+00:00",
        sizeGb: 1.25,
        labels: opscrew,
      },
      { id: "13", name: "snapshot 13", createdAt: "2026-11-06T10:00:00+00:00", labels: {} },
    ]);
    expect(calls.map((call) => param(call, "type"))).toEqual(["snapshot", "snapshot"]);
    expect(calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("rejects a non-numeric server id without calling the API", async () => {
    const { connector, calls } = setup({});
    const error = await errorOf(connector.servers?.listSnapshots("7; rm"));
    expect(error.code).toBe("INVALID_INPUT");
    expect(calls).toHaveLength(0);
  });
});

describe("servers.deleteSnapshot", () => {
  it("deletes the image and resolves on Hetzner's 204", async () => {
    const { connector, calls } = setup({ "DELETE /images/4711": { status: 204 } });
    await expect(connector.servers?.deleteSnapshot("4711")).resolves.toBeUndefined();
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual(["DELETE /images/4711"]);
    expect(calls[0]?.headers.Authorization).toBe(`Bearer ${token}`);
  });

  it("says a missing snapshot may be deleted already, without the token", async () => {
    const { connector, calls } = setup({
      "DELETE /images/4711": {
        status: 404,
        body: { error: { code: "not_found", message: "image with ID '4711' not found" } },
      },
    });
    const error = await errorOf(connector.servers?.deleteSnapshot("4711"));
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toContain("HTTP 404");
    expect(error.message).toContain("not found");
    expect(error.hint).toContain("may have been deleted");
    expect(textOf(error)).not.toContain(token);
    expect(calls).toHaveLength(1);
  });

  it("never sends a delete twice after a 5xx", async () => {
    const { connector, calls } = setup({
      "DELETE /images/4711": {
        status: 503,
        body: { error: { code: "unavailable", message: "maintenance" } },
      },
    });
    const error = await errorOf(connector.servers?.deleteSnapshot("4711"));
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(calls).toHaveLength(1);
  });

  it("rejects a non-numeric snapshot id without calling the API", async () => {
    const { connector, calls } = setup({});
    const error = await errorOf(connector.servers?.deleteSnapshot("../servers/7"));
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.message).toContain("snapshot id");
    expect(calls).toHaveLength(0);
  });
});

describe("servers.rebuild", () => {
  const rebuildAnswer = {
    status: 201,
    body: {
      action: { ...action(77, "running"), command: "rebuild_server" },
      root_password: password,
    },
  };
  const rebuildAction = (status: string, error: unknown = null) => ({
    body: { action: { ...action(77, status, error), command: "rebuild_server" } },
  });

  it("rebuilds from the image and waits for the action", async () => {
    const { connector, calls, waits } = setup({
      "POST /servers/7/actions/rebuild": rebuildAnswer,
      "/actions/77": [rebuildAction("running"), rebuildAction("success")],
    });
    expect(await connector.servers?.rebuild("7", "4711")).toBeUndefined();
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /servers/7/actions/rebuild",
      "GET /actions/77",
      "GET /actions/77",
    ]);
    expect(calls[0]?.body).toEqual({ image: "4711" });
    expect(waits).toEqual([2000]);
  });

  it("surfaces a rebuild action that ends in error, without the password or token", async () => {
    const { connector } = setup({
      "POST /servers/7/actions/rebuild": rebuildAnswer,
      "/actions/77": rebuildAction("error", { code: "action_failed", message: "rebuild failed" }),
    });
    const error = await errorOf(connector.servers?.rebuild("7", "4711"));
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toContain("rebuild_server");
    expect(error.message).toContain("rebuild failed");
    expect(error.hint).toContain("Hetzner Cloud Console");
    expect(textOf(error)).not.toContain(password);
    expect(textOf(error)).not.toContain(token);
  });

  it("gives up after 15 minutes and says the rebuild may still be running", async () => {
    const { connector } = setup(
      {
        "POST /servers/7/actions/rebuild": rebuildAnswer,
        "/actions/77": rebuildAction("running"),
      },
      60_000,
    );
    const error = await errorOf(connector.servers?.rebuild("7", "4711"));
    expect(error.message).toContain("did not finish within 15 minutes");
    expect(error.hint).toContain("may still be running");
  });

  it("passes on a refusal (422) with what to do next, sent once", async () => {
    const { connector, calls } = setup({
      "POST /servers/7/actions/rebuild": {
        status: 422,
        body: { error: { code: "unsupported_error", message: "image is not compatible" } },
      },
    });
    const error = await errorOf(connector.servers?.rebuild("7", "4711"));
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toContain("image is not compatible");
    expect(error.hint).toContain("fix what it named above");
    expect(textOf(error)).not.toContain(token);
    expect(calls).toHaveLength(1);
  });

  it("asks to wait when another action holds the server (423)", async () => {
    const { connector } = setup({
      "POST /servers/7/actions/rebuild": {
        status: 423,
        body: { error: { code: "locked", message: "server is locked" } },
      },
    });
    const error = await errorOf(connector.servers?.rebuild("7", "4711"));
    expect(error.hint).toContain("Another action is still running");
  });

  it("says a missing server or image may have been deleted (404)", async () => {
    const { connector } = setup({
      "POST /servers/7/actions/rebuild": {
        status: 404,
        body: { error: { code: "not_found", message: "server not found" } },
      },
    });
    const error = await errorOf(connector.servers?.rebuild("7", "4711"));
    expect(error.message).toContain("server not found");
    expect(error.hint).toContain("may have been deleted");
  });

  it("rejects non-numeric ids without calling the API", async () => {
    const { connector, calls } = setup({});
    expect((await errorOf(connector.servers?.rebuild("x", "4711"))).code).toBe("INVALID_INPUT");
    expect((await errorOf(connector.servers?.rebuild("7", "ubuntu-24.04"))).code).toBe(
      "INVALID_INPUT",
    );
    expect(calls).toHaveLength(0);
  });
});
