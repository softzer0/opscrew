import { OpsCrewError } from "@opscrew/core";
import { type FakeReply, fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { hetznerFetch, param } from "./__fixtures__/fixtures";
import { HetznerClient } from "./client";

const token = fakeSecret("hcloud-token");

/** A client whose sleeps are recorded and advance its clock (starting at `start`). */
function client(
  routes: Record<string, FakeReply | FakeReply[]>,
  options: { timeoutMs?: number; start?: number } = {},
) {
  const fake = hetznerFetch(routes);
  const waits: number[] = [];
  let clock = options.start ?? 0;
  const c = new HetznerClient({
    token,
    fetch: fake.fetch,
    sleep: async (ms) => {
      waits.push(ms);
      clock += ms;
    },
    now: () => clock,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  return { client: c, calls: fake.calls, waits, clock: () => clock };
}

function action(id: number, status: string, extra: Record<string, unknown> = {}) {
  return {
    action: {
      id,
      command: "create_image",
      status,
      progress: status === "success" ? 100 : 40,
      started: "2026-10-12T10:00:00+00:00",
      finished: null,
      resources: [{ id: 7, type: "server" }],
      error: null,
      ...extra,
    },
  };
}

function errorText(error: OpsCrewError): string {
  return `${error.message} ${error.hint ?? ""}`;
}

describe("HetznerClient.listServers", () => {
  it("follows pagination, sends the label selector and maps addresses and labels", async () => {
    const { client: c, calls } = client({
      "/servers?page=1": {
        body: {
          servers: [
            {
              id: 1,
              name: "shop-web",
              status: "running",
              labels: { "managed-by": "opscrew", app: "shop" },
              public_net: { ipv4: { ip: "203.0.113.10" }, ipv6: { ip: "2001:db8:1::/64" } },
              future_field: true,
            },
          ],
          meta: { pagination: { page: 1, per_page: 50, next_page: 2, last_page: 2 } },
        },
      },
      "/servers?page=2": {
        body: {
          servers: [
            {
              id: 2,
              name: "shop-worker",
              status: "off",
              public_net: { ipv4: null, ipv6: null },
            },
          ],
          meta: { pagination: { page: 2, per_page: 50, next_page: null, last_page: 2 } },
        },
      },
    });
    const servers = await c.listServers({ labelSelector: "managed-by=opscrew,app=shop" });
    expect(servers).toEqual([
      {
        id: 1,
        name: "shop-web",
        status: "running",
        labels: { "managed-by": "opscrew", app: "shop" },
        ipv4: "203.0.113.10",
        ipv6: "2001:db8:1::/64",
      },
      { id: 2, name: "shop-worker", status: "off", labels: {} },
    ]);
    expect(calls.map((call) => param(call, "page"))).toEqual(["1", "2"]);
    expect(
      calls.every((call) => param(call, "label_selector") === "managed-by=opscrew,app=shop"),
    ).toBe(true);
    expect(calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("lists every server when no selector is given", async () => {
    const { client: c, calls } = client({
      "/servers": { body: { servers: [], meta: { pagination: { next_page: null } } } },
    });
    expect(await c.listServers()).toEqual([]);
    expect(param(calls[0], "label_selector")).toBeNull();
  });
});

describe("HetznerClient.createSnapshot", () => {
  it("posts create_image with type snapshot and returns the image and action ids", async () => {
    const { client: c, calls } = client({
      "POST /servers/7/actions/create_image": {
        status: 201,
        body: {
          image: { id: 4711, type: "snapshot", status: "creating", description: "before destroy" },
          action: action(99, "running").action,
        },
      },
    });
    const result = await c.createSnapshot(7, {
      description: "before destroy",
      labels: { "managed-by": "opscrew" },
    });
    expect(result).toEqual({ imageId: 4711, actionId: 99 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe("https://api.hetzner.cloud/v1/servers/7/actions/create_image");
    expect(calls[0]?.headers["Content-Type"]).toBe("application/json");
    expect(calls[0]?.headers.Authorization).toBe(`Bearer ${token}`);
    expect(calls[0]?.body).toEqual({
      type: "snapshot",
      description: "before destroy",
      labels: { "managed-by": "opscrew" },
    });
  });

  it("retries a 429 that rejected the request, then succeeds", async () => {
    const {
      client: c,
      calls,
      waits,
    } = client({
      "POST /servers/7/actions/create_image": [
        {
          status: 429,
          body: { error: { code: "rate_limit_exceeded", message: "limit reached" } },
        },
        {
          status: 201,
          body: { image: { id: 1, type: "snapshot" }, action: action(2, "running").action },
        },
      ],
    });
    expect(await c.createSnapshot(7, { description: "x" })).toEqual({ imageId: 1, actionId: 2 });
    expect(calls).toHaveLength(2);
    expect(waits).toEqual([1000]);
  });

  it("never retries a POST after a 5xx because the server may have accepted it", async () => {
    const { client: c, calls } = client({
      "POST /servers/7/actions/create_image": {
        status: 503,
        body: { error: { code: "unavailable", message: "maintenance" } },
      },
    });
    const error = (await c
      .createSnapshot(7, { description: "x" })
      .catch((e: unknown) => e)) as OpsCrewError;
    expect(error).toBeInstanceOf(OpsCrewError);
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toContain("maintenance");
    expect(errorText(error)).not.toContain(token);
    expect(calls).toHaveLength(1);
  });

  it("never retries a POST that timed out and says it may have run", async () => {
    const {
      client: c,
      calls,
      waits,
    } = client({ "POST /servers/7/actions/create_image": { hang: true } }, { timeoutMs: 5 });
    const error = (await c
      .createSnapshot(7, { description: "x" })
      .catch((e: unknown) => e)) as OpsCrewError;
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toContain("did not answer within");
    expect(error.hint).toMatch(/Hetzner Cloud Console/);
    expect(errorText(error)).not.toContain(token);
    expect(calls).toHaveLength(1);
    expect(waits).toEqual([]);
  });

  it("rejects a response without image or action", async () => {
    const { client: c } = client({
      "POST /servers/7/actions/create_image": { status: 201, body: { image: null } },
    });
    const error = (await c
      .createSnapshot(7, { description: "x" })
      .catch((e: unknown) => e)) as OpsCrewError;
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toContain("unexpected response");
  });
});

describe("HetznerClient.waitForAction", () => {
  it("polls every 2 seconds until the action succeeds", async () => {
    const {
      client: c,
      calls,
      waits,
    } = client({
      "/actions/99": [
        { body: action(99, "running") },
        { body: action(99, "running") },
        { body: action(99, "success", { finished: "2026-10-12T10:01:00+00:00" }) },
      ],
    });
    const done = await c.waitForAction(99, { timeoutMs: 60_000 });
    expect(done.status).toBe("success");
    expect(done.id).toBe(99);
    expect(calls).toHaveLength(3);
    expect(calls.every((call) => call.path === "/actions/99")).toBe(true);
    expect(waits).toEqual([2_000, 2_000]);
  });

  it("turns an action that ends in error into PROVIDER_ERROR with the API's message", async () => {
    const { client: c } = client({
      "/actions/99": [
        { body: action(99, "running") },
        {
          body: action(99, "error", {
            error: { code: "action_failed", message: "Image creation failed: disk busy" },
          }),
        },
      ],
    });
    const error = (await c
      .waitForAction(99, { timeoutMs: 60_000 })
      .catch((e: unknown) => e)) as OpsCrewError;
    expect(error).toBeInstanceOf(OpsCrewError);
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toContain("Image creation failed: disk busy");
    expect(errorText(error)).not.toContain(token);
  });

  it("times out with a plain-English hint using the injected clock", async () => {
    const {
      client: c,
      calls,
      clock,
    } = client({ "/actions/99": { body: action(99, "running") } }, { start: 1_000_000 });
    const error = (await c
      .waitForAction(99, { timeoutMs: 9_000 })
      .catch((e: unknown) => e)) as OpsCrewError;
    expect(error).toBeInstanceOf(OpsCrewError);
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toMatch(/did not finish within 9 seconds/);
    expect(error.hint).toMatch(/Hetzner Cloud Console/);
    expect(errorText(error)).not.toContain(token);
    // Polls at t=0, 2, 4, 6, 8 s, then one last check at the deadline.
    expect(calls).toHaveLength(6);
    expect(clock()).toBe(1_009_000);
  });

  it("retries a 429 while polling", async () => {
    const {
      client: c,
      calls,
      waits,
    } = client({
      "/actions/5": [
        { status: 429, body: { error: { code: "rate_limit_exceeded", message: "slow down" } } },
        { body: action(5, "success") },
      ],
    });
    const done = await c.waitForAction(5, { timeoutMs: 1_000 });
    expect(done.status).toBe("success");
    expect(calls).toHaveLength(2);
    expect(waits).toEqual([1000]);
  });
});
