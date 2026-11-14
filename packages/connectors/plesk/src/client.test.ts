import { randomUUID } from "node:crypto";
import type { FetchLike } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { pleskClient } from "./client";
import { FAKE_PLESK_URL, fakePlesk } from "./fake";

const PASSWORD = fakeSecret("generic-password", "plesk client password");

const get = { operator: "webspace", operation: "get", body: { filter: "" }, what: "read it" };

async function failure(promise: Promise<unknown>): Promise<OpsCrewError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OpsCrewError);
  return error as OpsCrewError;
}

function answering(text: string, status = 200): FetchLike {
  return async () => new Response(text, { status });
}

describe("pleskClient", () => {
  it("logs in with the customer's login and password, to the XML API on the panel's port", async () => {
    const fake = fakePlesk({ token: PASSWORD });
    const client = pleskClient(
      { url: `${FAKE_PLESK_URL}/`, user: "jdoe", token: PASSWORD },
      { fetch: fake.fetch },
    );
    const results = await client.call({ ...get, write: false });
    expect(results).toHaveLength(1);
    expect(fake.requests[0]?.headers).toMatchObject({
      "Content-Type": "text/xml",
      HTTP_AUTH_LOGIN: "jdoe",
      HTTP_AUTH_PASSWD: PASSWORD,
    });
    expect(fake.requests[0]?.headers.KEY).toBeUndefined();
  });

  it("sends a secret key in the KEY header", async () => {
    const key = randomUUID();
    const fake = fakePlesk({ token: key });
    const client = pleskClient(
      { url: FAKE_PLESK_URL, user: "jdoe", token: key },
      { fetch: fake.fetch },
    );
    await client.call({ ...get, write: false });
    expect(fake.requests[0]?.headers.KEY).toBe(key);
    expect(fake.requests[0]?.headers.HTTP_AUTH_PASSWD).toBeUndefined();
  });

  it("refuses an address that is not https, or no address at all", () => {
    for (const url of ["http://plesk.example.test:8443", "plesk.example.test"]) {
      expect(() => pleskClient({ url, user: "jdoe", token: PASSWORD })).toThrow(
        "OPSCREW_HOSTING_URL isn't a panel's https:// address.",
      );
    }
  });

  it("turns a refused login into CREDENTIALS_INVALID without the password", async () => {
    const fake = fakePlesk({ token: "something else entirely" });
    const client = pleskClient(
      { url: FAKE_PLESK_URL, user: "jdoe", token: PASSWORD },
      { fetch: fake.fetch },
    );
    const error = await failure(client.call({ ...get, write: false }));
    expect(error.code).toBe("CREDENTIALS_INVALID");
    expect(error.message).toContain("Authentication failed");
    expect(error.hint).toContain("OPSCREW_HOSTING_TOKEN");
    expect(`${error.message} ${error.hint}`).not.toContain(PASSWORD);
  });

  it("names the hosting plan's remote API permission when Plesk denies it", async () => {
    const fake = fakePlesk({ token: PASSWORD, noRemoteApi: true });
    const client = pleskClient(
      { url: FAKE_PLESK_URL, user: "jdoe", token: PASSWORD },
      { fetch: fake.fetch },
    );
    const error = await failure(client.call({ ...get, write: false }));
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toBe("Plesk could not read it: Permission denied (error 1006).");
    expect(error.hint).toContain("Ability to use remote API");
  });

  it("returns error results for the caller, and words them with the token masked", async () => {
    const text = `<packet><site><del><result><status>error</status><errcode>1023</errcode><errtext>Operation failed for ${PASSWORD}.</errtext></result></del></site></packet>`;
    const client = pleskClient(
      { url: FAKE_PLESK_URL, user: "jdoe", token: PASSWORD },
      { fetch: answering(text) },
    );
    const [result] = await client.call({
      operator: "site",
      operation: "del",
      body: {},
      what: "remove it",
      write: true,
    });
    expect(result).toMatchObject({ status: "error", errcode: "1023" });
    const error = client.failure(result as never, "remove it");
    expect(error.message).toContain("Plesk could not remove it: Operation failed for [REDACTED:");
    expect(error.message).not.toContain(PASSWORD);
  });

  it("masks registered secrets, such as a database password Plesk quotes back", async () => {
    const dbPassword = fakeSecret("generic-password", "plesk client db password");
    const text = `<packet><system><status>error</status><errcode>1014</errcode><errtext>Bad value ${dbPassword}</errtext></system></packet>`;
    const client = pleskClient(
      { url: FAKE_PLESK_URL, user: "jdoe", token: PASSWORD },
      { fetch: answering(text) },
    );
    client.secret(dbPassword, "DATABASE_PASSWORD");
    const error = await failure(client.call({ ...get, write: true }));
    expect(error.message).toContain("[REDACTED:DATABASE_PASSWORD]");
    expect(error.message).not.toContain(dbPassword);
  });

  it("reads an empty operation as no results", async () => {
    const client = pleskClient(
      { url: FAKE_PLESK_URL, user: "jdoe", token: PASSWORD },
      { fetch: answering("<packet><subdomain><get/></subdomain></packet>") },
    );
    expect(
      await client.call({
        operator: "subdomain",
        operation: "get",
        body: {},
        what: "x",
        write: false,
      }),
    ).toEqual([]);
  });

  it("says a write may have been done when the answer is lost or unreadable", async () => {
    const lost: FetchLike = async () => {
      throw new TypeError("fetch failed");
    };
    const client = pleskClient(
      { url: FAKE_PLESK_URL, user: "jdoe", token: PASSWORD },
      { fetch: lost },
    );
    const write = await failure(client.call({ ...get, what: "add it", write: true }));
    expect(write.message).toBe("Could not reach Plesk at plesk.example.test:8443 to add it.");
    expect(write.hint).toContain("may still have reached Plesk");
    const read = await failure(client.call({ ...get, write: false }));
    expect(read.hint).toContain("internet connection");

    const html = pleskClient(
      { url: FAKE_PLESK_URL, user: "jdoe", token: PASSWORD },
      { fetch: answering("<html>Bad gateway", 502) },
    );
    const error = await failure(html.call({ ...get, write: true }));
    expect(error.message).toBe(
      "Plesk answered HTTP 502 without a readable packet when trying to read it.",
    );
    expect(error.hint).toContain("may still have reached Plesk");
  });

  it("gives up after its timeout", async () => {
    const hang: FetchLike = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    const client = pleskClient(
      { url: FAKE_PLESK_URL, user: "jdoe", token: PASSWORD },
      { fetch: hang, timeoutMs: 20 },
    );
    const error = await failure(client.call({ ...get, write: false }));
    expect(error.message).toBe("Plesk did not answer within 0 seconds when trying to read it.");
  });

  it("gets the fake's parse error for an operation the connector never sends", async () => {
    const fake = fakePlesk({ token: PASSWORD });
    const client = pleskClient(
      { url: FAKE_PLESK_URL, user: "jdoe", token: PASSWORD },
      { fetch: fake.fetch },
    );
    const error = await failure(
      client.call({
        operator: "database",
        operation: "get-default-user",
        body: {},
        what: "x",
        write: false,
      }),
    );
    expect(error.message).toBe("Plesk could not x: Parser error: Request is invalid (error 1014).");
  });

  it("refuses an answer that is not a Plesk packet", async () => {
    const client = pleskClient(
      { url: FAKE_PLESK_URL, user: "jdoe", token: PASSWORD },
      {
        fetch: answering(
          "<packet><webspace><get><result><status>maybe</status></result></get></webspace></packet>",
        ),
      },
    );
    const error = await failure(client.call({ ...get, write: false }));
    expect(error.message).toContain("Plesk returned an unexpected answer when trying to read it");
  });
});
