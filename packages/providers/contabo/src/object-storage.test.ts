import type { ObjectStorageApi } from "@opscrew/contracts";
import { OpsCrewError, Redactor } from "@opscrew/core";
import { type FakeReply, fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { CREDENTIALS_ENV, contaboFetch, fakeTime, page, param } from "./__fixtures__/fixtures";
import { contaboConnector } from "./connector";

function setup(routes: Record<string, FakeReply | FakeReply[]>) {
  const fake = contaboFetch(routes);
  const time = fakeTime();
  const redactor = new Redactor();
  const connector = contaboConnector({
    env: CREDENTIALS_ENV,
    fetch: fake.fetch,
    redactor,
    sleep: time.sleep,
    now: () => new Date(time.now()),
  });
  const api = connector.objectStorage as ObjectStorageApi;
  const calls = () =>
    fake.calls
      .filter((call) => !call.url.startsWith("https://auth."))
      .map((c) => `${c.method} ${c.path}`);
  return { api, fake, calls, time, redactor };
}

/** An object storage as Contabo answers it. */
function storage(id: string, region: string, status: string, extra: Record<string, unknown> = {}) {
  return {
    objectStorageId: id,
    region,
    s3Url: "https://eu2.contabostorage.com",
    status,
    cancelDate: "",
    totalPurchasedSpaceTB: 0.25,
    ...extra,
  };
}

/** One object storage's answer (`GET /v1/object-storages/{id}`). */
const one = (value: unknown) => ({ body: { data: [value], _links: {} } });

/** The error `promise` rejects with. */
async function failure(promise: Promise<unknown>): Promise<OpsCrewError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OpsCrewError);
  return error as OpsCrewError;
}

describe("objectStorage", () => {
  it("is there only with the credentials", () => {
    expect(contaboConnector({ env: {} }).objectStorage).toBeUndefined();
    expect(contaboConnector({ env: CREDENTIALS_ENV }).objectStorage).toBeDefined();
  });

  it("finds the account's storage in a region, never one whose contract ended", async () => {
    const { api } = setup({
      "/v1/object-storages?": page([
        storage("old", "Somewhere", "CANCELLED"),
        storage("sin-1", "SIN", "READY", { s3Url: "sin1.contabostorage.com/" }),
        storage("eu-1", "EU", "READY", { cancelDate: "2026-12-11" }),
      ]),
    });
    expect(await api.find("EU")).toEqual({
      id: "eu-1",
      region: "EU",
      s3Url: "https://eu2.contabostorage.com",
      cancelledUntil: "2026-12-11",
    });
    // Without its scheme and with a slash, as Contabo's examples give it.
    expect((await api.find("SIN"))?.s3Url).toBe("https://sin1.contabostorage.com");
    expect(await api.find("US-central")).toBeUndefined();
  });

  it("fails rather than answer none when a storage is in a region it does not know", async () => {
    const { api } = setup({
      "/v1/object-storages?": page([storage("eu-1", "European Union", "READY")]),
    });
    const error = await failure(api.find("EU"));
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toBe(
      'Contabo lists the object storage eu-1 in the region "European Union", which OpsCrew does not know, so it cannot tell whether the account has object storage in EU. Nothing was changed.',
    );
  });

  it("orders a storage and waits until it is ready", async () => {
    const { api, fake, calls, time } = setup({
      "POST /v1/object-storages": one(storage("new-1", "EU", "PROVISIONING")),
      "GET /v1/object-storages/new-1": [
        one(storage("new-1", "EU", "PROVISIONING")),
        one(storage("new-1", "EU", "READY")),
      ],
    });
    const ordered = await api.order({ region: "EU", sizeTb: 0.25, displayName: "opscrew-shop" });
    expect(ordered).toEqual({
      ordered: { id: "new-1", region: "EU", s3Url: "https://eu2.contabostorage.com" },
    });
    expect(
      fake.calls.find((c) => c.method === "POST" && c.path === "/v1/object-storages")?.body,
    ).toEqual({
      region: "EU",
      totalPurchasedSpaceTB: 0.25,
      displayName: "opscrew-shop",
    });
    expect(calls()).toEqual([
      "POST /v1/object-storages",
      "GET /v1/object-storages/new-1",
      "GET /v1/object-storages/new-1",
    ]);
    expect(time.waits).toEqual([5_000]);
  });

  it("answers refused when Contabo answered the order with an error status", async () => {
    const { api, calls } = setup({
      "POST /v1/object-storages": { status: 400, body: { message: "Region not available" } },
    });
    const answer = await api.order({ region: "EU", sizeTb: 0.25, displayName: "x" });
    expect(answer).toEqual({
      refused: "Contabo answered HTTP 400 to POST /v1/object-storages: Region not available",
    });
    expect(calls()).toEqual(["POST /v1/object-storages"]);
  });

  it("answers a rate limit as refused: Contabo ordered nothing", async () => {
    const { api } = setup({
      "POST /v1/object-storages": { status: 429, body: { message: "Too many requests" } },
    });
    const answer = await api.order({ region: "EU", sizeTb: 0.25, displayName: "x" });
    expect(answer).toMatchObject({ refused: expect.stringContaining("rate limit was reached") });
  });

  it("rejects on a 5xx answer to the order, as Contabo may have taken it, and never sends it twice", async () => {
    const { api, calls } = setup({
      "POST /v1/object-storages": { status: 502, body: { message: "Bad Gateway" } },
    });
    const error = await failure(api.order({ region: "EU", sizeTb: 0.25, displayName: "x" }));
    expect(error.message).toContain("HTTP 502");
    expect(calls()).toEqual(["POST /v1/object-storages"]);
  });

  it("rejects when the order got no answer: it may have been made", async () => {
    const { api } = setup({ "POST /v1/object-storages": { error: new Error("socket hang up") } });
    const error = await failure(api.order({ region: "EU", sizeTb: 0.25, displayName: "x" }));
    expect(error.hint).toContain("The change may still have been made");
  });

  it("stops plainly when the new storage fails", async () => {
    const { api } = setup({
      "POST /v1/object-storages": one(storage("new-1", "EU", "PROVISIONING")),
      "GET /v1/object-storages/new-1": one(storage("new-1", "EU", "ERROR")),
    });
    const error = await failure(api.order({ region: "EU", sizeTb: 0.25, displayName: "x" }));
    expect(error.message).toBe("Contabo's object storage new-1 is ERROR.");
  });

  it("reads the storage's key as the API user, and redacts it", async () => {
    const accessKey = fakeSecret("generic-password", "access");
    const secretKey = fakeSecret("generic-password", "secret");
    const { api, fake, redactor } = setup({
      "/v1/users?": page([
        { userId: "u-other", email: `x${CREDENTIALS_ENV.CNTB_OAUTH2_USER}` },
        { userId: "u-api", email: CREDENTIALS_ENV.CNTB_OAUTH2_USER.toUpperCase() },
      ]),
      "/v1/users/u-api/object-storages/credentials?": page([
        { objectStorageId: "other", accessKey: "a", secretKey: "b", credentialId: 1 },
        { objectStorageId: "eu-1", accessKey, secretKey, credentialId: 2 },
      ]),
    });
    expect(await api.key("eu-1")).toEqual({ accessKeyId: accessKey, secretAccessKey: secretKey });
    const users = fake.calls.find((c) => c.path.startsWith("/v1/users?"));
    expect(param(users, "email")).toBe(CREDENTIALS_ENV.CNTB_OAUTH2_USER);
    const listed = fake.calls.find((c) => c.path.includes("/credentials"));
    expect(param(listed, "objectStorageId")).toBe("eu-1");
    expect(redactor.redact(`${accessKey} ${secretKey}`)).not.toContain(secretKey);
    expect(redactor.redact(`${accessKey} ${secretKey}`)).not.toContain(accessKey);
  });

  it("stops plainly when the storage has no key for the API user", async () => {
    const { api } = setup({
      "/v1/users?": page([{ userId: "u-api", email: CREDENTIALS_ENV.CNTB_OAUTH2_USER }]),
      "/v1/users/u-api/object-storages/credentials?": page([]),
    });
    const error = await failure(api.key("eu-1"));
    expect(error.message).toBe(
      "Contabo lists no S3 key of the object storage eu-1 for the API user.",
    );
  });
});
