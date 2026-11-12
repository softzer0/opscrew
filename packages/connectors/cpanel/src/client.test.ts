import { inspect } from "node:util";
import type { FetchLike } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { type FakeReply, fakeFetch, fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CpanelRefusal, cpanelClient } from "./client";

const TOKEN = fakeSecret("generic-password", "cpanel-token");
const BASE = "https://panel.example.com:2083";
const ACCESS = { url: `${BASE}/`, user: "acct", token: TOKEN };

function client(routes: Record<string, FakeReply | FakeReply[]>, timeoutMs?: number) {
  const fake = fakeFetch(routes, { base: BASE });
  return {
    cpanel: cpanelClient(ACCESS, {
      fetch: fake.fetch,
      ...(timeoutMs !== undefined && { timeoutMs }),
    }),
    calls: fake.calls,
  };
}

/** The failure, checked to be an OpsCrewError that shows the token nowhere. */
async function failure(promise: Promise<unknown>): Promise<OpsCrewError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(OpsCrewError);
    const text = `${(error as Error).message} ${(error as OpsCrewError).hint ?? ""} ${JSON.stringify(error)} ${inspect(error, { depth: 5 })}`;
    expect(text).not.toContain(TOKEN);
    return error as OpsCrewError;
  }
  throw new Error("expected a failure");
}

const uapiOk = (data: unknown): FakeReply => ({
  body: { apiversion: 3, func: "f", module: "M", result: { status: 1, data, errors: null } },
});
const uapiRefused = (...errors: string[]): FakeReply => ({
  body: { apiversion: 3, func: "f", module: "M", result: { status: 0, data: null, errors } },
});
const api2 = (fields: Record<string, unknown>): FakeReply => ({
  body: { cpanelresult: { apiversion: 2, func: "f", module: "M", ...fields } },
});

const read = { module: "Mysql", func: "list_databases", what: "list the databases" };
const DatabasesSchema = z.array(z.object({ database: z.string() }));

describe("UAPI", () => {
  it("reads with GET, the token in cPanel's Authorization header, and answers the data", async () => {
    const { cpanel, calls } = client({
      "/execute/Mysql/list_databases": uapiOk([{ database: "acct_a" }]),
    });
    await expect(
      cpanel.uapi({ ...read, params: { a: "1" }, schema: DatabasesSchema }),
    ).resolves.toEqual([{ database: "acct_a" }]);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.path).toBe("/execute/Mysql/list_databases?a=1");
    expect(calls[0]?.headers.Authorization).toBe(`cpanel acct:${TOKEN}`);
  });

  it("also reads an answer without the `result` wrapper", async () => {
    const { cpanel } = client({
      "/execute/Mysql/list_databases": { body: { status: 1, data: [{ database: "acct_b" }] } },
    });
    await expect(cpanel.uapi({ ...read, schema: DatabasesSchema })).resolves.toEqual([
      { database: "acct_b" },
    ]);
  });

  it("sends a change as a POST form, never in the URL", async () => {
    const { cpanel, calls } = client({ "/execute/Mysql/create_user": uapiOk(null) });
    const password = fakeSecret("generic-password", "db");
    await cpanel.uapi({
      module: "Mysql",
      func: "create_user",
      params: { name: "acct_u", password },
      write: true,
      what: "create the user",
      schema: z.unknown(),
    });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.path).toBe("/execute/Mysql/create_user");
    expect(calls[0]?.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(new URLSearchParams(calls[0]?.body as string).get("password")).toBe(password);
  });

  it("turns status 0 into a refusal carrying cPanel's reasons (HTTP 200)", async () => {
    const { cpanel } = client({
      "/execute/LangPHP/php_get_installed_versions": uapiRefused(
        "You do not have the feature “multiphp”.",
      ),
    });
    const error = await failure(
      cpanel.uapi({
        module: "LangPHP",
        func: "php_get_installed_versions",
        what: "list the PHP versions",
        schema: z.unknown(),
      }),
    );
    expect(error).toBeInstanceOf(CpanelRefusal);
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toBe(
      "cPanel refused to list the PHP versions: You do not have the feature “multiphp”.",
    );
    expect((error as CpanelRefusal).reason).toBe("You do not have the feature “multiphp”.");
  });

  it("redacts the token and registered secrets from cPanel's reasons", async () => {
    const password = fakeSecret("generic-password", "echoed");
    const { cpanel } = client({
      "/execute/Mysql/create_user": uapiRefused(
        `Bad header cpanel acct:${TOKEN}`,
        `pw ${password}`,
      ),
    });
    cpanel.registerSecret(password, "database password");
    const error = await failure(
      cpanel.uapi({
        module: "Mysql",
        func: "create_user",
        write: true,
        what: "x",
        schema: z.unknown(),
      }),
    );
    expect(error.message).toContain("[REDACTED:OPSCREW_HOSTING_TOKEN]");
    expect(error.message).toContain("[REDACTED:database password]");
    expect(error.message).not.toContain(password);
  });

  it("refuses an answer of the wrong shape", async () => {
    const { cpanel } = client({ "/execute/Mysql/list_databases": uapiOk({ unexpected: true }) });
    const error = await failure(cpanel.uapi({ ...read, schema: DatabasesSchema }));
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toMatch(
      /^cPanel returned an unexpected answer when trying to list the databases/,
    );
  });
});

describe("API2", () => {
  const listcron = {
    module: "Cron",
    func: "listcron",
    what: "list the cron jobs",
    schema: z.unknown(),
  };

  it("posts to /json-api/cpanel with the API2 parameters", async () => {
    const { cpanel, calls } = client({
      "POST /json-api/cpanel": api2({ data: [{ count: 1 }], event: { result: 1 } }),
    });
    await expect(cpanel.api2({ ...listcron, params: { a: "b" } })).resolves.toEqual([{ count: 1 }]);
    expect(calls[0]?.headers.Authorization).toBe(`cpanel acct:${TOKEN}`);
    expect(Object.fromEntries(new URLSearchParams(calls[0]?.body as string))).toEqual({
      cpanel_jsonapi_user: "acct",
      cpanel_jsonapi_apiversion: "2",
      cpanel_jsonapi_module: "Cron",
      cpanel_jsonapi_func: "listcron",
      a: "b",
    });
  });

  it.each([
    [
      "event.result 0 with an error",
      { event: { result: 0 }, error: "Access denied", data: [] },
      "Access denied",
    ],
    [
      "an error beside event.result 1 (R10's delkey)",
      { event: { result: 1 }, error: "Invalid filename", data: [] },
      "Invalid filename",
    ],
    [
      "a data item with result 0 (fileop)",
      { event: { result: 1 }, data: [{ result: 0, reason: "File exists" }] },
      "File exists",
    ],
    [
      "a data item with status 0 (Cron)",
      { event: { result: 1 }, data: [{ status: 0, statusmsg: "bad line" }] },
      "bad line",
    ],
    ["event.result 0 without a reason", { event: { result: 0 }, data: [] }, "no reason given"],
  ])("refuses %s", async (_name, fields, reason) => {
    const { cpanel } = client({ "POST /json-api/cpanel": api2(fields) });
    const error = await failure(cpanel.api2(listcron));
    expect(error).toBeInstanceOf(CpanelRefusal);
    expect((error as CpanelRefusal).reason).toBe(reason);
    expect(error.message).toBe(`cPanel refused to list the cron jobs: ${reason}.`);
  });
});

describe("uploads", () => {
  it("posts multipart with the folder, overwrite, permissions and file-1", async () => {
    let form: FormData | undefined;
    const fetch: FetchLike = async (_input, init) => {
      form = init?.body as FormData;
      return new Response(
        JSON.stringify({
          result: { status: 1, data: { uploads: [{ file: "a", status: 1 }], failed: 0 } },
        }),
      );
    };
    const cpanel = cpanelClient(ACCESS, { fetch });
    await cpanel.upload({
      dir: "/home/acct/x",
      files: [{ name: ".env.tmp", content: new TextEncoder().encode("A=1\n") }],
      permissions: "0600",
      what: "upload x",
    });
    expect(form?.get("dir")).toBe("/home/acct/x");
    expect(form?.get("overwrite")).toBe("1");
    expect(form?.get("permissions")).toBe("0600");
    const file = form?.get("file-1") as File;
    expect(file.name).toBe(".env.tmp");
    expect(await file.text()).toBe("A=1\n");
  });

  it("refuses a failed file even when the call's status is 1", async () => {
    const { cpanel } = client({
      "/execute/Fileman/upload_files": uapiOk({
        uploads: [{ file: "a", status: 0, reason: "Disk quota exceeded" }],
        failed: 1,
      }),
    });
    const error = await failure(
      cpanel.upload({ dir: "/home/acct", files: [], permissions: "0644", what: "upload a" }),
    );
    expect(error.message).toBe("cPanel refused to upload a: Disk quota exceeded.");
  });
});

describe("HTTP failures", () => {
  const call = (cpanel: ReturnType<typeof cpanelClient>) =>
    cpanel.uapi({ ...read, schema: z.unknown() });

  it("names a refused token as invalid credentials", async () => {
    const { cpanel } = client({ "/": { status: 401, text: "Access denied" } });
    const error = await failure(call(cpanel));
    expect(error.code).toBe("CREDENTIALS_INVALID");
    expect(error.message).toBe(
      "cPanel refused the API token (HTTP 401) when trying to list the databases.",
    );
    expect(error.hint).toContain("OPSCREW_HOSTING_TOKEN");
  });

  it("reports another HTTP status, a page that isn't JSON, a lost connection and a timeout", async () => {
    expect(
      (await failure(call(client({ "/": { status: 500, text: "oops" } }).cpanel))).message,
    ).toBe("cPanel answered HTTP 500 when trying to list the databases.");
    expect(
      (await failure(call(client({ "/": { text: "<html>login</html>" } }).cpanel))).message,
    ).toBe("cPanel's answer wasn't JSON when trying to list the databases.");
    const lost = await failure(
      call(client({ "/": { error: new Error(`socket ${TOKEN}`) } }).cpanel),
    );
    expect(lost.message).toBe(
      "Could not reach cPanel to list the databases (the connection failed).",
    );
    const slow = await failure(call(client({ "/": { hang: true } }, 20).cpanel));
    expect(slow.message).toBe(
      "Could not reach cPanel to list the databases (the request timed out).",
    );
    expect(slow.code).toBe("PROVIDER_ERROR");
  });
});

describe("access", () => {
  it("refuses an address that isn't https://<host>:<port>", () => {
    for (const url of [
      "http://panel.example.com:2083",
      "panel.example.com",
      "https://panel.example.com:2083/cpsess1",
    ]) {
      expect(() => cpanelClient({ ...ACCESS, url })).toThrow(
        "OPSCREW_HOSTING_URL isn't a cPanel address.",
      );
    }
  });

  it("asks for a missing user or token and never echoes a malformed token", () => {
    expect(() => cpanelClient({ ...ACCESS, token: " " })).toThrow(
      "OPSCREW_HOSTING_TOKEN is not set.",
    );
    expect(() => cpanelClient({ ...ACCESS, user: "" })).toThrow("OPSCREW_HOSTING_USER is not set.");
    let message = "";
    try {
      cpanelClient({ ...ACCESS, token: `${TOKEN} x` });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe("OPSCREW_HOSTING_TOKEN isn't a cPanel API token.");
  });
});
