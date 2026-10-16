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
    expect(defaultError.message).toContain("did not finish within 900 seconds");

    const custom = setup(
      { "POST /servers/7/actions/create_image": createImage, "/actions/99": running },
      60_000,
    );
    const customError = (await custom.connector.servers
      ?.snapshotServer("7", { ...request, timeoutMs: 120_000 })
      .catch((e: unknown) => e)) as OpsCrewError;
    expect(customError.message).toContain("did not finish within 120 seconds");
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
