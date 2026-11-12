import { OpsCrewError, Redactor } from "@opscrew/core";
import type { FakeCall, FakeReply } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import {
  CREDENTIALS,
  contaboFetch,
  fakeTime,
  fixture,
  LOGIN,
  page,
  param,
  token,
} from "./__fixtures__/fixtures";
import { CONTABO_AUTH_URL, ContaboClient, readContaboCredentials } from "./client";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SECRETS = Object.values(CREDENTIALS);

function setup(
  routes: Record<string, FakeReply | FakeReply[]>,
  extra: { version?: string; timeoutMs?: number } = {},
) {
  const fake = contaboFetch(routes);
  const time = fakeTime();
  const redactor = new Redactor();
  for (const value of SECRETS) redactor.addLiteral(value);
  const client = new ContaboClient({
    credentials: CREDENTIALS,
    redactor,
    fetch: fake.fetch,
    sleep: time.sleep,
    now: time.now,
    ...extra,
  });
  return { client, calls: fake.calls, time, redactor };
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

const apiCalls = (calls: FakeCall[]) =>
  calls.filter((call) => !call.url.startsWith(CONTABO_AUTH_URL));
const logins = (calls: FakeCall[]) => calls.filter((call) => call.url.startsWith(CONTABO_AUTH_URL));

describe("readContaboCredentials", () => {
  it("names the missing variables and registers the others with the redactor as it reads them", () => {
    const redactor = new Redactor();
    const read = readContaboCredentials(
      {
        CNTB_OAUTH2_CLIENT_ID: CREDENTIALS.clientId,
        CNTB_OAUTH2_USER: CREDENTIALS.user,
        CNTB_OAUTH2_PASS: " ",
      },
      redactor,
    );
    expect(read.credentials).toBeUndefined();
    expect(read.missing).toEqual(["CNTB_OAUTH2_CLIENT_SECRET", "CNTB_OAUTH2_PASS"]);
    expect(redactor.redact(`id ${CREDENTIALS.clientId}`)).not.toContain(CREDENTIALS.clientId);
    expect(redactor.redact(`user ${CREDENTIALS.user}`)).not.toContain(CREDENTIALS.user);
  });

  it("returns all four when they are set", () => {
    const read = readContaboCredentials(
      {
        CNTB_OAUTH2_CLIENT_ID: CREDENTIALS.clientId,
        CNTB_OAUTH2_CLIENT_SECRET: CREDENTIALS.clientSecret,
        CNTB_OAUTH2_USER: CREDENTIALS.user,
        CNTB_OAUTH2_PASS: CREDENTIALS.password,
      },
      new Redactor(),
    );
    expect(read).toEqual({ credentials: CREDENTIALS, missing: [] });
  });
});

describe("ContaboClient login and requests", () => {
  it("logs in with a password grant first, then sends the token, an x-request-id and the User-Agent", async () => {
    const { client, calls } = setup({ "/v1/compute/instances?": page([]) }, { version: "1.2.3" });
    await client.verify();

    const [login, read] = calls;
    expect(login?.method).toBe("POST");
    expect(login?.url).toBe(CONTABO_AUTH_URL);
    expect(login?.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(new URLSearchParams(String(login?.body)))).toEqual({
      grant_type: "password",
      client_id: CREDENTIALS.clientId,
      client_secret: CREDENTIALS.clientSecret,
      username: CREDENTIALS.user,
      password: CREDENTIALS.password,
    });

    expect(read?.path).toBe("/v1/compute/instances?page=1&size=1");
    expect(read?.headers.Authorization).toBe("Bearer access-1");
    expect(read?.headers["x-request-id"]).toMatch(UUID_V4);
    expect(read?.headers["User-Agent"]).toBe("opscrew/1.2.3");
    // The credentials go only to the login, never to the API.
    expect(JSON.stringify(apiCalls(calls))).not.toMatch(
      new RegExp(SECRETS.map((s) => s.replace(/[^\w]/g, "\\$&")).join("|")),
    );
  });

  it("sends a new x-request-id with every call and keeps the token until it expires", async () => {
    const { client, calls, time } = setup({
      [LOGIN]: [token("access-1", 300), token("access-2", 300)],
      "/v1/compute/instances?": page([]),
    });
    await client.verify();
    await client.verify();
    time.advance(271_000); // past the expiry, less the 30 seconds kept in hand
    await client.verify();

    expect(logins(calls)).toHaveLength(2);
    const api = apiCalls(calls);
    expect(api.map((call) => call.headers.Authorization)).toEqual([
      "Bearer access-1",
      "Bearer access-1",
      "Bearer access-2",
    ]);
    expect(new Set(api.map((call) => call.headers["x-request-id"])).size).toBe(3);
  });

  it("renews the token once on a 401 and repeats the call once", async () => {
    const { client, calls } = setup({
      [LOGIN]: [token("access-1"), token("access-2")],
      "/v1/compute/instances?": [
        { status: 401, body: { statusCode: 401, message: "Unauthorized" } },
        page([]),
      ],
    });
    await client.verify();
    expect(calls.map((call) => call.method)).toEqual(["POST", "GET", "POST", "GET"]);
    expect(apiCalls(calls).map((call) => call.headers.Authorization)).toEqual([
      "Bearer access-1",
      "Bearer access-2",
    ]);
  });

  it("stops with the credentials named when the renewed token is refused too", async () => {
    const { client, calls } = setup({
      [LOGIN]: [token("access-1"), token("access-2")],
      "/v1/compute/instances?": { status: 401, body: { statusCode: 401, message: "Unauthorized" } },
    });
    const error = await failure(client.verify());
    expect(error.code).toBe("CREDENTIALS_INVALID");
    expect(error.hint).toContain("CNTB_OAUTH2_CLIENT_ID");
    expect(calls).toHaveLength(4);
  });

  it("names the four variables when Contabo's login refuses the credentials", async () => {
    const { client, calls } = setup({
      [LOGIN]: {
        status: 401,
        body: { error: "invalid_grant", error_description: "Invalid user credentials" },
      },
    });
    const error = await failure(client.verify());
    expect(error.code).toBe("CREDENTIALS_INVALID");
    expect(error.message).toContain("Invalid user credentials");
    expect(error.hint).toContain(
      "CNTB_OAUTH2_CLIENT_ID, CNTB_OAUTH2_CLIENT_SECRET, CNTB_OAUTH2_USER and CNTB_OAUTH2_PASS",
    );
    expect(error.hint).toContain("https://new.contabo.com/account/security");
    expect(calls).toHaveLength(1);
  });

  it("says to wait when Contabo's login is rate-limited", async () => {
    const { client } = setup({ [LOGIN]: { status: 429, body: { error: "too many requests" } } });
    const error = await failure(client.verify());
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toBe("Contabo's login failed (HTTP 429): too many requests");
    expect(error.hint).toBe("Wait a minute and try again.");
  });

  it("follows the pages of a list", async () => {
    const { client, calls } = setup({
      "/v1/compute/instances?page=1": { body: fixture("instances-page1.json") },
      "/v1/compute/instances?page=2": { body: fixture("instances-page2.json") },
    });
    const instances = await client.listInstances();
    expect(instances.map((instance) => instance.instanceId)).toEqual([
      101, 102, 105, 103, 104, 106, 200,
    ]);
    expect((instances[0] as Record<string, unknown>).future_field).toEqual({ kept: true });
    const api = apiCalls(calls);
    expect(api.map((call) => param(call, "page"))).toEqual(["1", "2"]);
    expect(api.every((call) => param(call, "size") === "100")).toBe(true);
    expect(logins(calls)).toHaveLength(1);
  });

  it("refuses an answer that does not match what Contabo documents", async () => {
    const { client } = setup({
      "/v1/compute/instances?": { body: { data: [{ instanceId: "not a number" }] } },
    });
    const error = await failure(client.listInstances());
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toContain("unexpected answer");
  });

  it.each([
    ["a body", { status: 200, body: { _links: { self: "/v1/x" } } }],
    ["no body", { status: 204 }],
  ])("takes any success with %s for a call whose answer it does not use", async (_, reply) => {
    const { client } = setup({ "/v1/": reply });
    const firewall = "0f6c1d2e-0000-4000-8000-000000000001";
    await client.instanceAction(101, "start");
    await client.rollbackSnapshot(101, "snap1");
    await client.deleteSnapshot(101, "snap1");
    await client.setFirewallRules(firewall, []);
    await client.updateFirewall(firewall, { description: "d", status: "active" });
    await client.assignFirewall(firewall, 101);
    await client.unassignFirewall(firewall, 101);
    await client.deleteFirewall(firewall);
  });
});

describe("ContaboClient errors", () => {
  const cases: {
    status: number;
    code: string;
    message: RegExp;
    hint: RegExp;
  }[] = [
    {
      status: 403,
      code: "CREDENTIALS_INVALID",
      message: /refused the API credentials \(HTTP 403/,
      hint: /may manage compute instances/,
    },
    {
      status: 402,
      code: "PROVIDER_ERROR",
      message: /needs a paid service/,
      hint: /Order or pay for the service/,
    },
    { status: 404, code: "PROVIDER_ERROR", message: /HTTP 404/, hint: /cancelled or removed/ },
    { status: 409, code: "PROVIDER_ERROR", message: /HTTP 409/, hint: /wait until it is done/ },
    { status: 422, code: "PROVIDER_ERROR", message: /HTTP 422/, hint: /refused the request/ },
    { status: 400, code: "PROVIDER_ERROR", message: /HTTP 400/, hint: /refused the request/ },
    { status: 429, code: "PROVIDER_ERROR", message: /rate limit/, hint: /Wait a minute/ },
    { status: 503, code: "PROVIDER_ERROR", message: /HTTP 503/, hint: /failed on its side/ },
  ];

  for (const { status, code, message, hint } of cases) {
    it(`maps ${status} to plain English with the next step`, async () => {
      const reply = { status, body: { statusCode: status, message: `Contabo says ${status}` } };
      const { client } = setup({
        "/v1/compute/instances/101/actions/start": reply,
      });
      const error = await failure(client.instanceAction(101, "start"));
      expect(error.code).toBe(code);
      expect(error.message).toMatch(message);
      expect(error.message).toContain(`Contabo says ${status}`);
      expect(error.hint).toMatch(hint);
    });
  }

  it("joins a list of messages", async () => {
    const { client } = setup({
      "/v1/compute/instances/101/snapshots": {
        status: 400,
        body: { statusCode: 400, message: ["name is too long", "description is empty"] },
      },
    });
    const error = await failure(client.createSnapshot(101, { name: "x", description: "" }));
    expect(error.message).toContain("name is too long; description is empty");
  });

  it("waits and repeats a request Contabo answered with 429", async () => {
    const { client, calls, time } = setup({
      "/v1/compute/instances/101/actions/shutdown": [
        { status: 429, body: { statusCode: 429, message: "Too many requests" } },
        { status: 201, body: { data: [{ instanceId: 101, action: "shutdown" }], _links: {} } },
      ],
    });
    await client.instanceAction(101, "shutdown");
    expect(apiCalls(calls)).toHaveLength(2);
    expect(time.waits).toEqual([1000]);
  });

  it("never repeats a create that got no answer", async () => {
    const { client, calls } = setup(
      { "/v1/compute/instances/101/snapshots": { hang: true } },
      { timeoutMs: 20 },
    );
    const error = await failure(
      client.createSnapshot(101, { name: "opscrew-shop", description: "before destroy" }),
    );
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toContain("did not answer");
    expect(error.hint).toContain("may still have been made");
    expect(apiCalls(calls).filter((call) => call.method === "POST")).toHaveLength(1);
  });

  it("puts no credential in any error, even when Contabo repeats one", async () => {
    const echo = (status: number) => ({
      status,
      body: { statusCode: status, message: `bad ${CREDENTIALS.clientId} for ${CREDENTIALS.user}` },
    });
    const errors: OpsCrewError[] = [];
    const failing: Record<string, FakeReply>[] = [
      {
        [LOGIN]: {
          status: 401,
          body: { error: "invalid_client", error_description: `${CREDENTIALS.clientSecret}?` },
        },
      },
      { [LOGIN]: { status: 500, text: `oops ${CREDENTIALS.password}` } },
      { [LOGIN]: { error: new Error(`refused ${CREDENTIALS.password}`) } },
      { "/v1/compute/instances?": echo(401) },
      { "/v1/compute/instances?": echo(403) },
      { "/v1/compute/instances?": echo(422) },
      { "/v1/compute/instances?": echo(429) },
      { "/v1/compute/instances?": echo(500) },
    ];
    for (const routes of failing) {
      const { client } = setup(routes);
      errors.push(await failure(client.verify()));
    }
    const probe = new Redactor();
    for (const value of SECRETS) probe.addLiteral(value);
    for (const error of errors) {
      const text = `${error.message} ${error.hint ?? ""}`;
      expect(probe.redact(text)).toBe(text);
      for (const value of SECRETS) expect(text).not.toContain(value);
    }
  });
});
