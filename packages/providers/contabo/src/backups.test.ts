import type { ProviderBackupsApi } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import type { FakeReply } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { CREDENTIALS_ENV, contaboFetch, fakeTime } from "./__fixtures__/fixtures";
import { contaboConnector } from "./connector";

const UPGRADE = "POST /v1/compute/instances/101/upgrade";

function setup(routes: Record<string, FakeReply | FakeReply[]>) {
  const fake = contaboFetch(routes);
  const time = fakeTime();
  const connector = contaboConnector({
    env: CREDENTIALS_ENV,
    fetch: fake.fetch,
    sleep: time.sleep,
    now: () => new Date(time.now()),
  });
  const api = connector.backups as ProviderBackupsApi;
  const calls = () =>
    fake.calls
      .filter((call) => !call.url.startsWith("https://auth."))
      .map((c) => `${c.method} ${c.path}`);
  const body = (route: string) =>
    fake.calls.find((call) => `${call.method} ${call.path}` === route)?.body;
  return { api, calls, body };
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

describe("backups (Contabo's Auto Backup)", () => {
  it("is there only with the credentials", () => {
    expect(contaboConnector({ env: {} }).backups).toBeUndefined();
    expect(contaboConnector({ env: CREDENTIALS_ENV }).backups).toBeDefined();
  });

  it("turns Auto Backup on with an upgrade of the instance", async () => {
    const { api, calls, body } = setup({
      [UPGRADE]: {
        body: {
          data: [{ tenantId: "INT", customerId: "10000001", instanceId: 101 }],
          _links: { self: "/v1/compute/instances/101" },
        },
      },
    });
    expect(await api.turnOn("101")).toBeUndefined();
    expect(calls()).toEqual([UPGRADE]);
    expect(body(UPGRADE)).toEqual({ backup: {} });
  });

  it("answers Contabo's refusal, so the caller knows nothing was turned on", async () => {
    const { api, calls } = setup({
      [UPGRADE]: { status: 400, body: { statusCode: 400, message: "Backup is not available" } },
    });
    expect(await api.turnOn("101")).toEqual({
      refused:
        "Contabo answered HTTP 400 to POST /v1/compute/instances/101/upgrade: Backup is not available",
    });
    expect(calls()).toEqual([UPGRADE]);
  });

  it("rejects without a clear answer, and never sends the upgrade twice", async () => {
    const { api, calls } = setup({
      [UPGRADE]: { error: new TypeError("fetch failed") },
    });
    const error = await failure(api.turnOn("101"));
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.hint).toContain("may still have been made");
    expect(calls()).toEqual([UPGRADE]);
  });

  it("refuses an id that is not a Contabo instance id before any call", async () => {
    const { api, calls } = setup({});
    const error = await failure(api.turnOn("srv-1"));
    expect(error.code).toBe("INVALID_INPUT");
    expect(calls()).toEqual([]);
  });
});
