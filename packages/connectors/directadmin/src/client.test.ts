import { OpsCrewError } from "@opscrew/core";
import { fakeFetch, fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { DirectAdminApiError, DirectAdminClient } from "./client";

const BASE = "https://panel.example.test:2222";
const token = fakeSecret("generic-password", "directadmin");
const access = { url: BASE, user: "alice", token };

function client(routes: Parameters<typeof fakeFetch>[0]) {
  const fake = fakeFetch(routes, { base: BASE });
  return { client: new DirectAdminClient(access, { fetch: fake.fetch }), calls: fake.calls };
}

async function failure(promise: Promise<unknown>): Promise<OpsCrewError> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(OpsCrewError);
  const opsError = error as OpsCrewError;
  expect(`${opsError.message} ${opsError.hint ?? ""}`).not.toContain(token);
  return opsError;
}

describe("DirectAdminClient", () => {
  it("refuses an address that is not HTTPS", () => {
    expect(
      () => new DirectAdminClient({ ...access, url: "http://panel.example.test:2222" }),
    ).toThrow(/https/);
    expect(() => new DirectAdminClient({ ...access, url: "panel" })).toThrow(/not a valid address/);
  });

  it("sends JSON API calls with basic auth and the login key", async () => {
    const { client: da, calls } = client({
      "GET /api/session/user-config": { body: { domain: "a" } },
    });
    const answer = await da.json({
      what: "read the account",
      method: "GET",
      path: "/api/session/user-config",
      query: { x: "1" },
      schema: z.object({ domain: z.string() }),
    });
    expect(answer).toEqual({ domain: "a" });
    expect(calls[0]?.path).toBe("/api/session/user-config?x=1");
    expect(calls[0]?.headers.Authorization).toBe(
      `Basic ${Buffer.from(`alice:${token}`).toString("base64")}`,
    );
  });

  it("sends a JSON body and reads a 204 as undefined", async () => {
    const { client: da, calls } = client({ "POST /api/x": { status: 204 } });
    await da.json({
      what: "do x",
      method: "POST",
      path: "/api/x",
      body: { a: 1 },
      schema: z.undefined(),
    });
    expect(calls[0]?.headers["Content-Type"]).toBe("application/json");
    expect(calls[0]?.body).toEqual({ a: 1 });
  });

  it("turns a 401 into CREDENTIALS_INVALID with the login key steps", async () => {
    const { client: da } = client({ "/api/": { status: 401, body: { type: "UNAUTHORIZED" } } });
    const error = await failure(
      da.json({
        what: "read the account",
        method: "GET",
        path: "/api/session",
        schema: z.unknown(),
      }),
    );
    expect(error.code).toBe("CREDENTIALS_INVALID");
    expect(error.message).toContain("rejected the login key for alice");
    expect(error.hint).toContain("Login Keys");
  });

  it("turns a 403 into a refusal naming the login key's limits", async () => {
    const { client: da } = client({ "/api/": { status: 403, body: { type: "ACCESS_DENIED" } } });
    const error = await failure(
      da.json({
        what: "list databases",
        method: "GET",
        path: "/api/db-show/databases",
        schema: z.unknown(),
      }),
    );
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toContain("the login key may not do this (HTTP 403): ACCESS_DENIED");
    expect(error.hint).toContain("Login Keys");
  });

  it("keeps the type and the file manager's reasons, and masks the key in the panel's text", async () => {
    const { client: da } = client({
      "/api/": {
        status: 409,
        body: {
          type: "FILEMANAGER_MULTI_OP_ERROR",
          errors: [{ path: `x/${token}`, reason: "NOT_FOUND" }],
        },
      },
    });
    const error = await failure(
      da.json({
        what: "delete x",
        method: "POST",
        path: "/api/fm",
        body: {},
        schema: z.undefined(),
      }),
    );
    expect(error).toBeInstanceOf(DirectAdminApiError);
    expect((error as DirectAdminApiError).type).toBe("FILEMANAGER_MULTI_OP_ERROR");
    expect((error as DirectAdminApiError).reasons).toEqual(["NOT_FOUND"]);
    expect(error.message).toContain("[REDACTED:OPSCREW_HOSTING_TOKEN]");
  });

  it("masks a registered secret the panel echoes", async () => {
    const password = fakeSecret("generic-password", "db");
    const { client: da } = client({
      "/api/": { status: 500, body: { type: "INTERNAL_ERROR", message: `bad ${password}` } },
    });
    da.addSecret(password, "database password");
    const error = await failure(
      da.json({
        what: "create a database",
        method: "POST",
        path: "/api/db",
        body: {},
        schema: z.unknown(),
      }),
    );
    expect(error.message).not.toContain(password);
    expect(error.hint).toContain("ask your host");
  });

  it("reports an answer of the wrong shape or not JSON", async () => {
    const { client: da } = client({ "/api/a": { body: { other: 1 } }, "/api/b": { text: "oops" } });
    const shape = await failure(
      da.json({
        what: "read a",
        method: "GET",
        path: "/api/a",
        schema: z.object({ id: z.string() }),
      }),
    );
    expect(shape.message).toContain("unexpected answer when trying to read a");
    const text = await failure(
      da.json({ what: "read b", method: "GET", path: "/api/b", schema: z.unknown() }),
    );
    expect(text.message).toContain("not JSON");
  });

  it("names the address when DirectAdmin can't be reached, and says a write may have happened", async () => {
    const { client: da } = client({ "/api/": { error: new Error("ECONNREFUSED") } });
    const read = await failure(
      da.json({ what: "read a", method: "GET", path: "/api/a", schema: z.unknown() }),
    );
    expect(read.message).toContain(`Could not reach DirectAdmin at ${BASE}`);
    expect(read.hint).toContain("internet connection");
    const write = await failure(
      da.json({ what: "write a", method: "POST", path: "/api/a", body: {}, schema: z.unknown() }),
    );
    expect(write.hint).toContain("may still have reached DirectAdmin");
  });

  it("sends a legacy GET with a query and a POST as a form, and reads the URL-encoded answer", async () => {
    const { client: da, calls } = client({
      "GET /CMD_API_SUBDOMAINS": { text: "list[]=app&list[]=www" },
      "POST /CMD_API_SUBDOMAINS": { text: "error=0&text=Subdomain%20created&details=" },
    });
    const list = await da.legacy("list", "CMD_API_SUBDOMAINS", "GET", { domain: "example.com" });
    expect(list.getAll("list[]")).toEqual(["app", "www"]);
    expect(calls[0]?.path).toBe("/CMD_API_SUBDOMAINS?domain=example.com");
    await da.legacy("create", "CMD_API_SUBDOMAINS", "POST", {
      domain: "example.com",
      action: "create",
    });
    expect(calls[1]?.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
  });

  it("turns a legacy error=1 into a plain error with DirectAdmin's text", async () => {
    const { client: da } = client({
      "/CMD_API_": {
        text: new URLSearchParams({
          error: "1",
          text: "Cannot create subdomain",
          details: `That subdomain already exists<br>${token}`,
        }).toString(),
      },
    });
    const error = await failure(da.legacy("add app.example.com", "CMD_API_SUBDOMAINS", "POST", {}));
    expect(error.message).toBe(
      "DirectAdmin could not add app.example.com: Cannot create subdomain: That subdomain already exists [REDACTED:OPSCREW_HOSTING_TOKEN].",
    );
  });

  it("reports a web page answer and a legacy 401", async () => {
    const page = client({ "/CMD_API_": { text: "<html>login</html>" } });
    const html = await failure(page.client.legacy("list", "CMD_API_CRON_JOBS", "GET", {}));
    expect(html.message).toContain("web page");
    expect(html.hint).toContain("CMD_API_CRON_JOBS");
    const denied = client({ "/CMD_API_": { status: 401, text: "" } });
    const error = await failure(denied.client.legacy("list", "CMD_API_CRON_JOBS", "GET", {}));
    expect(error.code).toBe("CREDENTIALS_INVALID");
  });

  it("uploads multipart with the target in the query", async () => {
    const { client: da, calls } = client({
      "POST /api/filemanager-actions/upload": { status: 204 },
    });
    await da.upload(
      "upload x",
      { dir: "opscrew", name: "x.tmp", perm: "0600" },
      new Uint8Array([1]),
    );
    expect(calls[0]?.path).toBe(
      "/api/filemanager-actions/upload?dir=opscrew&name=x.tmp&perm=0600&overwrite=false",
    );
  });

  it("downloads a file, and answers undefined on 404", async () => {
    const { client: da } = client({
      "GET /api/filemanager/download?path=a": { text: "hello" },
      "GET /api/filemanager/download?path=b": { status: 404, body: { type: "NOT_FOUND" } },
    });
    expect(await da.download("read a", "a")).toBe("hello");
    expect(await da.download("read b", "b")).toBeUndefined();
  });
});
