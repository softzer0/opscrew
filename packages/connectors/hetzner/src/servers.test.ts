import type { FetchLike, VpsConnector } from "@opscrew/contracts";
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
  const ours = { "created-by": "opscrew", app: "shop", reason: "destroy" };

  it("lists OpsCrew's snapshots of the server across pages, oldest first, with sizes", async () => {
    const { connector, calls } = setup({
      "/images?page=1": {
        body: {
          images: [
            image(12, "2026-11-05T10:00:00+00:00", { labels: ours }),
            image(20, "2026-11-01T10:00:00+00:00", {
              labels: ours,
              created_from: { id: 8, name: "other" },
            }),
          ],
          meta: { pagination: { next_page: 2 } },
        },
      },
      "/images?page=2": {
        body: {
          images: [
            image(11, "2026-11-02T10:00:00+00:00", { description: null, labels: ours }),
            image(13, "2026-11-06T10:00:00+00:00", {
              labels: ours,
              status: "creating",
              image_size: null,
            }),
            image(30, "2026-11-03T10:00:00+00:00", { labels: ours, created_from: null }),
          ],
          meta: { pagination: { next_page: null } },
        },
      },
    });
    expect(await connector.servers?.listSnapshots("7")).toEqual([
      { id: "11", name: "", createdAt: "2026-11-02T10:00:00+00:00", sizeGb: 1.25, labels: ours },
      {
        id: "12",
        name: "snapshot 12",
        createdAt: "2026-11-05T10:00:00+00:00",
        sizeGb: 1.25,
        labels: ours,
      },
      { id: "13", name: "snapshot 13", createdAt: "2026-11-06T10:00:00+00:00", labels: ours },
    ]);
    expect(calls.map((call) => param(call, "type"))).toEqual(["snapshot", "snapshot"]);
    expect(calls.map((call) => param(call, "label_selector"))).toEqual([
      "created-by=opscrew",
      "created-by=opscrew",
    ]);
    expect(calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("leaves out the user's own snapshots, which lack OpsCrew's label", async () => {
    const all: { labels: Record<string, string> }[] = [
      image(12, "2026-11-05T10:00:00+00:00", { labels: ours }),
      image(14, "2026-11-04T10:00:00+00:00", { labels: {} }),
      image(15, "2026-11-04T11:00:00+00:00", { labels: { "created-by": "someone" } }),
    ];
    // Answers as Hetzner does: only images matching the `key=value` label selector.
    const fetch: FetchLike = async (input) => {
      const selector = new URL(String(input)).searchParams.get("label_selector") ?? "";
      const [key = "", value] = selector.split("=");
      const images = all.filter((i) => key === "" || i.labels[key] === value);
      return Response.json({ images, meta: { pagination: { next_page: null } } });
    };
    const connector = hetznerConnector({ env: { HCLOUD_TOKEN: token }, fetch });
    const listed = await connector.servers?.listSnapshots("7");
    expect(listed?.map((snapshot) => snapshot.id)).toEqual(["12"]);
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

  it("asks to remove the delete protection of a protected snapshot", async () => {
    const { connector } = setup({
      "DELETE /images/4711": {
        status: 403,
        body: { error: { code: "protected", message: "image is protected" } },
      },
    });
    const error = await errorOf(connector.servers?.deleteSnapshot("4711"));
    expect(error.message).toContain("image is protected");
    expect(error.hint).toBe(
      "Remove its delete protection in the Hetzner Cloud Console first, then try again.",
    );
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
  const serverState = (on: boolean) => ({
    body: { server: { id: 7, status: "running", protection: { delete: on, rebuild: on } } },
  });
  const protectAction = (id: number, status = "success") => ({
    status: 201,
    body: { action: { ...action(id, status), command: "change_protection" } },
  });
  /** `setup` with server 7 unprotected, as a server outside prod's defaults is. */
  const rebuildSetup = (routes: Record<string, FakeReply | FakeReply[]>, clockStepMs = 0) =>
    setup({ "/servers/7": serverState(false), ...routes }, clockStepMs);
  const posts = (calls: { method: string; path: string; body?: unknown }[]) =>
    calls.filter((call) => call.method === "POST").map((call) => [call.path, call.body]);

  it("rebuilds from the image and waits for the action", async () => {
    const { connector, calls, waits } = rebuildSetup({
      "POST /servers/7/actions/rebuild": rebuildAnswer,
      "/actions/77": [rebuildAction("running"), rebuildAction("success")],
    });
    expect(await connector.servers?.rebuild("7", "4711")).toBeUndefined();
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "GET /servers/7",
      "POST /servers/7/actions/rebuild",
      "GET /actions/77",
      "GET /actions/77",
    ]);
    expect(calls[1]?.body).toEqual({ image: "4711" });
    expect(waits).toEqual([2000]);
  });

  it("lifts a protected server's protection for the rebuild and sets it back", async () => {
    const { connector, calls } = setup({
      "/servers/7": serverState(true),
      "POST /servers/7/actions/change_protection": [protectAction(90), protectAction(91)],
      "/actions/90": protectAction(90),
      "/actions/91": protectAction(91),
      "POST /servers/7/actions/rebuild": rebuildAnswer,
      "/actions/77": rebuildAction("success"),
    });
    await expect(connector.servers?.rebuild("7", "4711")).resolves.toBeUndefined();
    expect(posts(calls)).toEqual([
      ["/servers/7/actions/change_protection", { delete: false, rebuild: false }],
      ["/servers/7/actions/rebuild", { image: "4711" }],
      ["/servers/7/actions/change_protection", { delete: true, rebuild: true }],
    ]);
  });

  it("sets the protection back when the rebuild fails, and passes on the failure", async () => {
    const { connector, calls } = setup({
      "/servers/7": serverState(true),
      "POST /servers/7/actions/change_protection": [protectAction(90), protectAction(91)],
      "/actions/90": protectAction(90),
      "/actions/91": protectAction(91),
      "POST /servers/7/actions/rebuild": rebuildAnswer,
      "/actions/77": rebuildAction("error", { code: "action_failed", message: "rebuild failed" }),
    });
    const error = await errorOf(connector.servers?.rebuild("7", "4711"));
    expect(error.message).toContain("rebuild failed");
    expect(posts(calls).at(-1)).toEqual([
      "/servers/7/actions/change_protection",
      { delete: true, rebuild: true },
    ]);
  });

  it("says plainly the server is unprotected when the protection cannot be set back", async () => {
    const { connector } = setup({
      "/servers/7": serverState(true),
      "POST /servers/7/actions/change_protection": [
        protectAction(90),
        { status: 503, body: { error: { code: "unavailable", message: "maintenance" } } },
      ],
      "/actions/90": protectAction(90),
      "POST /servers/7/actions/rebuild": rebuildAnswer,
      "/actions/77": rebuildAction("success"),
    });
    const error = await errorOf(connector.servers?.rebuild("7", "4711"));
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toContain("Hetzner server 7 is unprotected");
    expect(error.message).toContain("which finished");
    expect(error.hint).toContain("`opscrew provision`");
    expect(textOf(error)).not.toContain(token);
    expect(textOf(error)).not.toContain(password);
  });

  it("says the rebuild did not finish when neither it nor the protection went through", async () => {
    const { connector } = setup({
      "/servers/7": serverState(true),
      "POST /servers/7/actions/change_protection": [
        protectAction(90),
        { status: 503, body: { error: { code: "unavailable", message: "maintenance" } } },
      ],
      "/actions/90": protectAction(90),
      "POST /servers/7/actions/rebuild": {
        status: 422,
        body: { error: { code: "unsupported_error", message: "image is not compatible" } },
      },
    });
    const error = await errorOf(connector.servers?.rebuild("7", "4711"));
    expect(error.message).toContain("is unprotected");
    expect(error.message).toContain("which did not finish");
  });

  it("surfaces a rebuild action that ends in error, without the password or token", async () => {
    const { connector } = rebuildSetup({
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
    const { connector } = rebuildSetup(
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
    const { connector, calls } = rebuildSetup({
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
    expect(posts(calls)).toHaveLength(1);
  });

  it("asks to wait when another action holds the server (423)", async () => {
    const { connector } = rebuildSetup({
      "POST /servers/7/actions/rebuild": {
        status: 423,
        body: { error: { code: "locked", message: "server is locked" } },
      },
    });
    const error = await errorOf(connector.servers?.rebuild("7", "4711"));
    expect(error.hint).toContain("Another action is still running");
  });

  it("says a missing server or image may have been deleted (404)", async () => {
    const { connector } = rebuildSetup({
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

describe("servers.powerOff and powerOn", () => {
  const sent = (id: number, command: string, status: string) => ({
    body: { action: { ...action(id, status), command } },
  });
  const server = (status: string) => ({
    body: { server: { id: 7, status, protection: { delete: true, rebuild: true } } },
  });

  it("shuts down gracefully, waits for the request, then until the server is off", async () => {
    const { connector, calls } = setup({
      "POST /servers/7/actions/shutdown": {
        status: 201,
        ...sent(81, "shutdown_server", "running"),
      },
      "/actions/81": sent(81, "shutdown_server", "success"),
      "/servers/7": [server("running"), server("stopping"), server("off")],
    });
    await expect(connector.servers?.powerOff("7")).resolves.toBeUndefined();
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /servers/7/actions/shutdown",
      "GET /actions/81",
      "GET /servers/7",
      "GET /servers/7",
      "GET /servers/7",
    ]);
  });

  it("stops waiting after 5 minutes, naming the state, and never forces the power off", async () => {
    const { connector, calls } = setup(
      {
        "POST /servers/7/actions/shutdown": {
          status: 201,
          ...sent(81, "shutdown_server", "running"),
        },
        "/actions/81": sent(81, "shutdown_server", "success"),
        "/servers/7": server("running"),
      },
      60_000,
    );
    const error = await errorOf(connector.servers?.powerOff("7"));
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toContain("was not off within 5 minutes: it is running");
    expect(calls.some((call) => call.path.includes("poweroff"))).toBe(false);
    expect(textOf(error)).not.toContain(token);
  });

  it("powers on and waits for the action", async () => {
    const { connector, calls } = setup({
      "POST /servers/7/actions/poweron": { status: 201, ...sent(82, "start_server", "running") },
      "/actions/82": [sent(82, "start_server", "running"), sent(82, "start_server", "success")],
    });
    await expect(connector.servers?.powerOn("7")).resolves.toBeUndefined();
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /servers/7/actions/poweron",
      "GET /actions/82",
      "GET /actions/82",
    ]);
  });

  it("rejects a non-numeric server id without calling the API", async () => {
    const { connector, calls } = setup({});
    expect((await errorOf(connector.servers?.powerOff("7/x"))).code).toBe("INVALID_INPUT");
    expect((await errorOf(connector.servers?.powerOn("7/x"))).code).toBe("INVALID_INPUT");
    expect(calls).toHaveLength(0);
  });
});
