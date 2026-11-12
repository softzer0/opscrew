import type { FetchLike, HostingOperation } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { type FakePleskOptions, fakePlesk } from "./fake";
import { PleskPanel } from "./panel";

const PASSWORD = fakeSecret("generic-password", "plesk panel password");
const DB_PASSWORD = fakeSecret("generic-password", "plesk panel database password");

function setup(
  options: Omit<FakePleskOptions, "token"> = {},
  wrap?: (fetch: FetchLike) => FetchLike,
) {
  const fake = fakePlesk({ token: PASSWORD, ...options });
  const fetch = wrap ? wrap(fake.fetch) : fake.fetch;
  const panel = new PleskPanel({ url: fake.url, user: fake.login, token: PASSWORD }, { fetch });
  return { fake, panel };
}

async function failure(promise: Promise<unknown>): Promise<OpsCrewError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OpsCrewError);
  return error as OpsCrewError;
}

const SITES: FakePleskOptions["sites"] = [
  { name: "blog.example.com", wwwRoot: "blog", subdomainOf: "example.com" },
  { name: "shop.test", wwwRoot: "shop.test/public" },
];

describe("PleskPanel.inspect", () => {
  it("reads the subscription's domains, addresses and quota", async () => {
    const { panel, fake } = setup({ sites: SITES });
    expect(await panel.inspect()).toEqual({
      panel: "plesk",
      domains: [
        { name: "example.com", kind: "main", documentRoot: "httpdocs" },
        { name: "blog.example.com", kind: "subdomain", documentRoot: "blog" },
        { name: "shop.test", kind: "addon", documentRoot: "shop.test/public" },
      ],
      addresses: ["192.0.2.10", "2001:db8::10"],
      quota: { usedMb: 300, limitMb: 1024 },
      databases: { engines: ["mysql"] },
      apps: { selectors: [] },
      phpPerHostname: [],
      documentRoots: "anywhere",
    });
    expect(fake.requests.map((r) => `${r.operator}.${r.operation}`)).toEqual([
      "webspace.get",
      "site.get",
      "subdomain.get",
    ]);
    expect(fake.requests[0]?.body).toEqual({
      filter: "",
      dataset: { gen_info: "", hosting: "", limits: "" },
    });
    expect(fake.requests[1]?.body).toMatchObject({ filter: { "parent-id": "1" } });
  });

  it("reads an unlimited disk as a quota without a limit, and no limit as no quota", async () => {
    const unlimited = setup({
      subscriptions: [{ id: 3, name: "a.test", realSize: 0, diskSpace: -1 }],
    });
    expect((await unlimited.panel.inspect()).quota).toEqual({ usedMb: 0 });
    const unsaid = setup({ subscriptions: [{ id: 3, name: "a.test", realSize: 0 }] });
    expect((await unsaid.panel.inspect()).quota).toBeUndefined();
  });

  it("refuses a login with several subscriptions, and one with none", async () => {
    const several = setup({
      subscriptions: [
        { id: 1, name: "example.com" },
        { id: 2, name: "other.test" },
      ],
    });
    const error = await failure(several.panel.inspect());
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.message).toBe(
      "The Plesk login jdoe has 2 subscriptions (example.com, other.test); OpsCrew works with a login that has one.",
    );
    const none = setup({ subscriptions: [] });
    expect((await failure(none.panel.inspect())).message).toBe(
      "The Plesk login jdoe has no subscription.",
    );
  });
});

describe("PleskPanel hostnames", () => {
  it("reads a hostname's document root relative to the home folder, or undefined", async () => {
    const { panel } = setup({ sites: SITES });
    expect(await panel.documentRoot("shop.test")).toBe("shop.test/public");
    expect(await panel.documentRoot("example.com")).toBe("httpdocs");
    expect(await panel.documentRoot("nowhere.test")).toBeUndefined();
  });

  it("adds a subdomain under the account's closest domain, with its document root", async () => {
    const { panel, fake } = setup({ sites: SITES });
    expect(await panel.addHostname("app.blog.example.com", "opscrew/app/current/public")).toBe(
      "opscrew/app/current/public",
    );
    const add = fake.requests.find((r) => r.operation === "add");
    expect(add?.body).toEqual({
      gen_setup: {
        name: "app.blog.example.com",
        "webspace-id": "1",
        "parent-site-name": "blog.example.com",
      },
      hosting: {
        vrt_hst: { property: [{ name: "www_root", value: "/opscrew/app/current/public" }] },
      },
    });
    expect(await panel.documentRoot("app.blog.example.com")).toBe("opscrew/app/current/public");
    expect((await panel.inspect()).domains).toContainEqual({
      name: "app.blog.example.com",
      kind: "subdomain",
      documentRoot: "opscrew/app/current/public",
    });
  });

  it("adds a name outside the account's domains as a domain of its own", async () => {
    const { panel, fake } = setup();
    expect(await panel.addHostname("app.other.test", "opscrew/app/current")).toBe(
      "opscrew/app/current",
    );
    const add = fake.requests.find((r) => r.operation === "add");
    expect(add?.body.gen_setup).toEqual({ name: "app.other.test", "webspace-id": "1" });
    expect((await panel.inspect()).domains).toContainEqual({
      name: "app.other.test",
      kind: "addon",
      documentRoot: "opscrew/app/current",
    });
  });

  it("answers the root Plesk made when called without one", async () => {
    const { panel, fake } = setup();
    expect(await panel.addHostname("app.example.com")).toBe("app.example.com");
    const add = fake.requests.find((r) => r.operation === "add");
    expect(add?.body).toEqual({
      gen_setup: { name: "app.example.com", "webspace-id": "1", "parent-site-name": "example.com" },
    });
  });

  it("passes Plesk's refusal on, and refuses a document root outside the home folder", async () => {
    const { panel } = setup({ sites: SITES });
    const exists = await failure(panel.addHostname("shop.test", "x"));
    expect(exists.message).toBe(
      "Plesk could not add the hostname shop.test: Site with such name already exists (error 1007).",
    );
    for (const root of ["/var/www", "a/../../b", ""]) {
      expect((await failure(panel.addHostname("x.example.com", root))).code).toBe("INVALID_INPUT");
    }
  });

  it("removes a hostname, counts one already gone as removed, and never removes the main domain", async () => {
    const { panel, fake } = setup({ sites: SITES });
    await panel.removeHostname("shop.test");
    expect(fake.state.sites.map((s) => s.name)).toEqual(["blog.example.com"]);
    await panel.removeHostname("shop.test");
    const main = await failure(panel.removeHostname("Example.com"));
    expect(main.message).toBe(
      "Example.com is your subscription's main domain; OpsCrew never removes it.",
    );
    expect(fake.requests.filter((r) => r.operation === "del")).toHaveLength(2);
  });
});

describe("PleskPanel databases", () => {
  it("lists the subscription's databases", async () => {
    const { panel } = setup({ databases: [{ name: "shop" }, { name: "wp_1" }] });
    expect(await panel.listDatabases()).toEqual(["shop", "wp_1"]);
    expect(await setup().panel.listDatabases()).toEqual([]);
  });

  it("adds a MySQL database and its user with every privilege on it", async () => {
    const { panel, fake } = setup();
    await panel.addDatabase({ name: "app", user: "app_user", password: DB_PASSWORD });
    expect(fake.state.databases).toEqual([
      expect.objectContaining({
        name: "app",
        type: "mysql",
        users: [
          expect.objectContaining({ login: "app_user", password: DB_PASSWORD, role: "readWrite" }),
        ],
      }),
    ]);
    const user = fake.requests.find((r) => r.operation === "add-db-user");
    expect(Object.keys(user?.body ?? {})).toEqual([
      "db-id",
      "login",
      "password",
      "password-type",
      "role",
    ]);
  });

  it("removes the database it made when its user can't be made, and never shows the password", async () => {
    const { panel, fake } = setup({
      failures: {
        "database.add-db-user": { errcode: "1019", errtext: `Weak password ${DB_PASSWORD}` },
      },
    });
    const error = await failure(
      panel.addDatabase({ name: "app", user: "app_user", password: DB_PASSWORD }),
    );
    expect(error.message).toBe(
      "Plesk could not add the database user app_user: Weak password [REDACTED:DATABASE_PASSWORD] (error 1019).",
    );
    expect(fake.state.databases).toEqual([]);
    expect(fake.requests.at(-1)?.operation).toBe("del-db");
  });

  it("keeps the user's error when removing the database it made fails too", async () => {
    const { panel } = setup({
      failures: {
        "database.add-db-user": { errcode: "1007", errtext: "Database user already exists" },
        "database.del-db": { errcode: "1023", errtext: "Operation failed" },
      },
    });
    const error = await failure(
      panel.addDatabase({ name: "app", user: "app_user", password: DB_PASSWORD }),
    );
    expect(error.message).toBe(
      "Plesk could not add the database user app_user: Database user already exists (error 1007).",
    );
  });

  it("removes the user and the database, and counts a database already gone as removed", async () => {
    const { panel, fake } = setup({ databases: [{ name: "app", users: ["app_user", "other"] }] });
    await panel.removeDatabase({ name: "app", user: "app_user" });
    expect(fake.state.databases).toEqual([]);
    expect(fake.requests.map((r) => r.operation)).toEqual([
      "get",
      "get-db",
      "get-db-users",
      "del-db-user",
      "del-db",
      "get-db",
    ]);
    expect(fake.requests[4]?.body).toEqual({ filter: { id: expect.any(String) } });
    await panel.removeDatabase({ name: "app", user: "app_user" });
  });

  it("says so when Plesk still lists the database after removing it", async () => {
    const { panel } = setup({ databases: [{ name: "app" }] }, (fetch) => async (input, init) => {
      if (String(init?.body).includes("<del-db>")) {
        return new Response(
          "<packet><database><del-db><result><status>ok</status><id>1</id></result></del-db></database></packet>",
        );
      }
      return fetch(input, init);
    });
    const error = await failure(panel.removeDatabase({ name: "app", user: "app_user" }));
    expect(error.message).toBe("Plesk still lists the database app after removing it.");
  });
});

describe("PleskPanel outside the customer API", () => {
  it("lists only the operations Plesk's customer API documents", () => {
    expect([...setup().panel.operations].sort()).toEqual([
      "addDatabase",
      "addHostname",
      "removeDatabase",
      "removeHostname",
    ]);
  });

  it("can't list scheduled tasks", async () => {
    expect(await setup().panel.listCron()).toBeUndefined();
  });

  it("refuses every other change with INVALID_INPUT, without calling Plesk", async () => {
    const { panel, fake } = setup();
    const calls: [HostingOperation, () => Promise<unknown>][] = [
      ["addCron", () => panel.addCron({ schedule: "* * * * *", command: "x" })],
      ["removeCron", () => panel.removeCron("1")],
      ["requestCertificate", () => panel.requestCertificate("a.example.com")],
      ["removeCertificate", () => panel.removeCertificate("1")],
      ["setPhpVersion", () => panel.setPhpVersion("a.example.com", "8.3")],
    ];
    for (const [operation, call] of calls) {
      expect(panel.operations.has(operation)).toBe(false);
      const error = await failure(call());
      expect(error.code).toBe("INVALID_INPUT");
      expect(error.message).toMatch(/^Plesk's API for customers can't /);
    }
    expect(fake.requests).toEqual([]);
  });

  it("refuses every file call, reading included, without calling Plesk", async () => {
    const { panel, fake } = setup();
    for (const operation of ["writeFile", "uploadTar", "remove"] as const) {
      expect(panel.operations.has(operation)).toBe(false);
    }
    for (const call of [
      () => panel.writeFile("a", new Uint8Array(), 0o600),
      () => panel.uploadTar("a", new Uint8Array()),
      () => panel.readFile("a"),
      () => panel.list("a"),
      () => panel.remove("a"),
    ]) {
      const error = await failure(call());
      expect(error.code).toBe("INVALID_INPUT");
      expect(error.message).toBe("Plesk's API for customers has no file calls.");
      expect(error.hint).toBe("OpsCrew reaches a Plesk account's files over SFTP.");
    }
    expect(fake.requests).toEqual([]);
  });

  it("can't read a certificate", async () => {
    const { panel, fake } = setup();
    expect(await panel.certificate("a.example.com")).toBeUndefined();
    expect(fake.requests).toEqual([]);
  });

  it("gives the panel step of an operation", () => {
    expect(
      setup().panel.panelStep("setPhpVersion", { hostname: "a.example.com", version: "8.3" }),
    ).toEqual({
      operation: "setPhpVersion",
      what: 'Select "PHP support" and this PHP version, then click OK',
      where: "Websites & Domains → a.example.com → PHP",
      value: "8.3",
    });
  });
});
