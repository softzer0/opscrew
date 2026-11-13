import { inspect } from "node:util";
import type { FetchLike } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { type FakeCpanel, type FakeCpanelOptions, fakeCpanel } from "./fake";
import { CpanelPanel } from "./index";

const TOKEN = fakeSecret("generic-password", "cpanel-token");
const NOW = Date.parse("2026-11-12T12:00:00Z");
const ACCESS = { url: "https://panel.example.com:2083", user: "acct", token: TOKEN };
const APP = "opscrew/shop-prod";
const ROOT = `${APP}/current/public`;

function setup(options: Partial<FakeCpanelOptions> = {}, wrap?: (fetch: FetchLike) => FetchLike) {
  const fake = fakeCpanel({ user: "acct", token: TOKEN, now: () => NOW, ...options });
  let names = 0;
  const panel = new CpanelPanel(ACCESS, {
    fetch: wrap ? wrap(fake.fetch) : fake.fetch,
    randomName: () => `r${++names}`,
    now: () => NOW,
  });
  return { fake, panel };
}

/** `Module::func` of each call since `from`. */
const called = (fake: FakeCpanel, from = 0) =>
  fake.calls.slice(from).map((call) => `${call.module}::${call.func}`);
const lastCall = (fake: FakeCpanel, name: string) =>
  fake.calls.filter((call) => `${call.module}::${call.func}` === name).at(-1);

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

const text = (value: string) => new TextEncoder().encode(value);

/** A ustar archive of files, folders and symbolic links. */
function tar(
  entries: {
    name: string;
    type: "0" | "2" | "5";
    content?: string;
    target?: string;
    mode?: number;
  }[],
) {
  const blocks: Uint8Array[] = [];
  for (const entry of entries) {
    const header = new Uint8Array(512);
    const put = (offset: number, value: string) => header.set(text(value), offset);
    const body = text(entry.content ?? "");
    put(0, entry.name);
    put(100, `${(entry.mode ?? 0o644).toString(8).padStart(7, "0")}\0`);
    put(124, `${body.length.toString(8).padStart(11, "0")}\0`);
    put(156, entry.type);
    if (entry.target) put(157, entry.target);
    put(257, "ustar\0");
    put(263, "00");
    blocks.push(header);
    if (body.length > 0) {
      const padded = new Uint8Array(Math.ceil(body.length / 512) * 512);
      padded.set(body);
      blocks.push(padded);
    }
  }
  blocks.push(new Uint8Array(1024));
  return new Uint8Array(Buffer.concat(blocks));
}

describe("the contract", () => {
  it("is cPanel, supports every operation, and has no panel step", () => {
    const { panel } = setup();
    expect(panel.kind).toBe("cpanel");
    expect(panel.operations.size).toBe(12);
    for (const operation of ["setPhpVersion", "addCron"] as const) {
      expect(() => panel.panelStep(operation)).toThrow(/cPanel's API makes every change/);
    }
  });
});

describe("inspect", () => {
  it("reads the test account's facts (R1, R10) without asking MultiPHP", async () => {
    const { fake, panel } = setup();
    await expect(panel.inspect()).resolves.toEqual({
      panel: "cpanel",
      domains: [{ name: "example.com", kind: "main", documentRoot: "public_html" }],
      addresses: ["192.0.2.10"],
      quota: { usedMb: 512, limitMb: 10_240 },
      databases: { engines: ["mariadb"], prefix: "acct_", maxDatabaseName: 64, maxUserName: 47 },
      apps: { selectors: ["nodejs", "python"], slotsLeft: 4 },
      phpPerHostname: [],
      documentRoots: "anywhere",
    });
    expect(called(fake).sort()).toEqual([
      "DomainInfo::domains_data",
      "Features::list_features",
      "Mysql::get_restrictions",
      "PassengerApps::list_applications",
      "Quota::get_quota_info",
      "Variables::get_server_information",
      "Variables::get_user_information",
    ]);
  });

  it("lists MultiPHP's versions, counts the apps left, and reads the account's limits", async () => {
    const { fake, panel } = setup({
      features: { multiphp: 1, lvepythonsel: 0 },
      phpVersions: ["ea-php82", "ea-php74", "alt-php82"],
      docrootsInPublicHtmlOnly: true,
    });
    fake.state.passengerApps.push("one");
    fake.state.quota.limitMb = 0;
    await panel.addHostname("shop.example.org", "public_html/shop");
    const facts = await panel.inspect();
    expect(facts.phpPerHostname).toEqual(["7.4", "8.2"]);
    expect(facts.apps).toEqual({ selectors: ["nodejs"], slotsLeft: 3 });
    expect(facts.quota).toEqual({ usedMb: 512 });
    expect(facts.documentRoots).toBe("public_html");
    expect(facts.domains).toEqual([
      { name: "example.com", kind: "main", documentRoot: "public_html" },
      { name: "shop.example.org", kind: "addon", documentRoot: "public_html/shop" },
    ]);
  });

  it("reads the parked domains with the main domain's root, in one domains_data call without format", async () => {
    const { fake, panel } = setup();
    fake.state.domains.push({ name: "parked.example.org", kind: "parked" });
    await panel.addHostname("shop.example.org", ROOT);
    expect((await panel.inspect()).domains).toEqual([
      { name: "example.com", kind: "main", documentRoot: "public_html" },
      { name: "shop.example.org", kind: "addon", documentRoot: ROOT },
      { name: "parked.example.org", kind: "parked", documentRoot: "public_html" },
    ]);
    const reads = fake.calls.filter(
      (call) => `${call.module}::${call.func}` === "DomainInfo::domains_data",
    );
    expect(reads.map((call) => call.params)).toEqual([{}, {}]);
  });

  it("leaves the app slots out without the passengerapps feature", async () => {
    const { fake, panel } = setup({ features: { passengerapps: 0 } });
    expect((await panel.inspect()).apps).toEqual({ selectors: ["nodejs", "python"] });
    expect(called(fake)).not.toContain("PassengerApps::list_applications");
  });
});

describe("hostnames", () => {
  it("adds a subdomain with its document root relative to home, answers it, and reads it", async () => {
    const { fake, panel } = setup();
    fake.state.files.set(`${APP}/current`, { kind: "link", target: "releases/0-0" });
    await expect(panel.addHostname("Shop.Example.com", ROOT)).resolves.toBe(ROOT);
    expect(fake.state.folders.has(`${APP}/current/public`)).toBe(false);
    expect(lastCall(fake, "SubDomain::addsubdomain")).toMatchObject({
      api: "uapi",
      params: { domain: "shop", rootdomain: "example.com", dir: ROOT, disallowdot: "0" },
    });
    await expect(panel.documentRoot("shop.example.com")).resolves.toBe(ROOT);
    await expect(panel.documentRoot("other.example.com")).resolves.toBeUndefined();
    await panel.addHostname("a.b.example.com", `${APP}/b`);
    expect(lastCall(fake, "SubDomain::addsubdomain")?.params.domain).toBe("a.b");
  });

  it("adds a name outside the account's domains as an addon domain, and removes it", async () => {
    const { fake, panel } = setup();
    await panel.addHostname("shop.example.org", ROOT);
    expect(lastCall(fake, "AddonDomain::addaddondomain")).toMatchObject({
      api: "api2",
      params: { newdomain: "shop.example.org", subdomain: "shop-example-org", dir: ROOT },
    });
    await panel.removeHostname("shop.example.org");
    expect(lastCall(fake, "AddonDomain::deladdondomain")?.params).toEqual({
      domain: "shop.example.org",
      subdomain: "shop-example-org_example.com",
    });
    expect(fake.state.domains.map((domain) => domain.name)).toEqual(["example.com"]);
  });

  it("removes a subdomain, does nothing for a name the account doesn't serve, and keeps the main domain", async () => {
    const { fake, panel } = setup();
    await panel.addHostname("shop.example.com", ROOT);
    await panel.removeHostname("shop.example.com");
    expect(lastCall(fake, "SubDomain::delsubdomain")).toMatchObject({
      api: "api2",
      params: { domain: "shop.example.com" },
    });
    const before = fake.calls.length;
    await panel.removeHostname("shop.example.com");
    expect(called(fake, before)).toEqual(["DomainInfo::domains_data"]);
    expect((await failure(panel.removeHostname("example.com"))).code).toBe("INVALID_INPUT");
  });

  it("adds a hostname under a parked domain as its subdomain, and never removes the parked domain", async () => {
    const { fake, panel } = setup();
    fake.state.domains.push({ name: "parked.example.org", kind: "parked" });
    await panel.addHostname("shop.parked.example.org", ROOT);
    expect(lastCall(fake, "SubDomain::addsubdomain")?.params).toEqual({
      domain: "shop",
      rootdomain: "parked.example.org",
      dir: ROOT,
      disallowdot: "0",
    });
    await expect(panel.documentRoot("shop.parked.example.org")).resolves.toBe(ROOT);
    const error = await failure(panel.removeHostname("parked.example.org"));
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.message).toBe(
      "parked.example.org is the account's parked domain; OpsCrew removes only the hostnames it added.",
    );
    expect(fake.state.domains.map((domain) => domain.name)).toContain("parked.example.org");
  });

  it("never takes over a hostname the account serves", async () => {
    const { fake, panel } = setup();
    const error = await failure(panel.addHostname("example.com", ROOT));
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.message).toBe("The account already serves example.com.");
    expect(called(fake)).toEqual(["DomainInfo::domains_data"]);
  });

  it("passes on cPanel's refusal, and refuses a bad name or root before any call", async () => {
    const { fake, panel } = setup({ docrootsInPublicHtmlOnly: true });
    const error = await failure(panel.addHostname("shop.example.com", ROOT));
    expect(error.message).toBe(
      "cPanel refused to add the subdomain shop.example.com: The document root must be inside “public_html”.",
    );
    const before = fake.calls.length;
    expect((await failure(panel.addHostname("not a name", ROOT))).code).toBe("INVALID_INPUT");
    expect((await failure(panel.addHostname("shop.example.com", "../x"))).code).toBe(
      "INVALID_INPUT",
    );
    const noRoot = await failure(panel.addHostname("shop.example.com"));
    expect(noRoot.code).toBe("INVALID_INPUT");
    expect(noRoot.message).toBe(
      "cPanel takes the document root OpsCrew gives, and none was given for shop.example.com.",
    );
    expect(fake.calls.length).toBe(before);
  });
});

describe("databases", () => {
  const db = { name: "acct_shop", user: "acct_shop" };

  it("makes the database and its user, and grants every privilege", async () => {
    const { fake, panel } = setup();
    const password = fakeSecret("generic-password", "db");
    await panel.addDatabase({ ...db, password });
    expect(called(fake)).toEqual([
      "Mysql::create_database",
      "Mysql::create_user",
      "Mysql::set_privileges_on_database",
    ]);
    expect(lastCall(fake, "Mysql::create_user")?.params).toEqual({ name: "acct_shop", password });
    expect(lastCall(fake, "Mysql::set_privileges_on_database")?.params).toEqual({
      user: "acct_shop",
      database: "acct_shop",
      privileges: "ALL PRIVILEGES",
    });
    await expect(panel.listDatabases()).resolves.toEqual(["acct_shop"]);
  });

  it("never shows the database password in an error", async () => {
    const { fake, panel } = setup();
    const password = fakeSecret("generic-password", "db");
    fake.failNext("Mysql", "create_user", `Password “${password}” is too weak.`);
    const error = await failure(panel.addDatabase({ ...db, password }));
    expect(error.message).toBe(
      "cPanel refused to create the database user acct_shop: Password “[REDACTED:database password]” is too weak.",
    );
  });

  it("removes the user and the database, then checks the list", async () => {
    const { fake, panel } = setup();
    await panel.addDatabase({ ...db, password: fakeSecret("generic-password", "db") });
    const before = fake.calls.length;
    await panel.removeDatabase(db);
    expect(called(fake, before)).toEqual([
      "Mysql::list_users",
      "Mysql::delete_user",
      "Mysql::list_databases",
      "Mysql::delete_database",
      "Mysql::list_databases",
    ]);
    expect(fake.state.databases.size).toBe(0);
    expect(fake.state.databaseUsers.size).toBe(0);
  });

  it("makes and removes once more a database that comes back after its removal (R10)", async () => {
    const { fake, panel } = setup({ reappearingDatabases: true });
    await panel.addDatabase({ ...db, password: fakeSecret("generic-password", "db") });
    const before = fake.calls.length;
    await panel.removeDatabase(db);
    expect(called(fake, before).slice(4)).toEqual([
      "Mysql::list_databases",
      "Mysql::create_database",
      "Mysql::delete_database",
      "Mysql::list_databases",
    ]);
    await expect(panel.listDatabases()).resolves.toEqual([]);
  });

  it("removes a database listed again later, which answers 'does not control'", async () => {
    const { fake, panel } = setup();
    fake.state.databases.set("acct_shop", { users: new Set(), ghost: true });
    await panel.removeDatabase(db);
    expect(called(fake)).toEqual([
      "Mysql::list_users",
      "Mysql::list_databases",
      "Mysql::delete_database",
      "Mysql::create_database",
      "Mysql::delete_database",
      "Mysql::list_databases",
    ]);
    expect(fake.state.databases.size).toBe(0);
  });

  it("fails when the database is still listed after the second removal", async () => {
    const { fake, panel } = setup({}, (fetch) => async (input, init) => {
      const response = await fetch(input, init);
      if (fake.calls.at(-1)?.func === "delete_database") {
        fake.state.databases.set("acct_shop", { users: new Set(), ghost: true });
      }
      return response;
    });
    fake.state.databases.set("acct_shop", { users: new Set(), ghost: true });
    const error = await failure(panel.removeDatabase(db));
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toBe(
      "cPanel still lists the database acct_shop after removing it twice.",
    );
  });
});

describe("cron", () => {
  it("adds a line and answers its linekey, lists the lines without the trailing count, and removes one", async () => {
    const { fake, panel } = setup();
    await expect(panel.listCron()).resolves.toEqual([]);
    const command = `/bin/bash ~/${APP}/agent.sh >> ~/${APP}/state/agent.log 2>&1`;
    const job = await panel.addCron({ schedule: "* * * * *", command });
    expect(lastCall(fake, "Cron::add_line")?.params).toEqual({
      command,
      minute: "*",
      hour: "*",
      day: "*",
      month: "*",
      weekday: "*",
    });
    expect(job).toEqual({ key: fake.state.cron[0]?.linekey, schedule: "* * * * *", command });
    await panel.addCron({ schedule: "*/5  2 * * 1-5", command: "true" });
    expect(await panel.listCron()).toEqual([
      job,
      { key: fake.state.cron[1]?.linekey, schedule: "*/5 2 * * 1-5", command: "true" },
    ]);
    await panel.removeCron(job.key);
    expect(lastCall(fake, "Cron::remove_line")?.params).toEqual({ linekey: job.key });
    expect((await panel.listCron()).map((line) => line.command)).toEqual(["true"]);
  });

  it("refuses a schedule that isn't five fields and a command of several lines", async () => {
    const { fake, panel } = setup();
    for (const schedule of ["* * * *", "@daily", "* * * * * *", "1;2 * * * *"]) {
      expect((await failure(panel.addCron({ schedule, command: "true" }))).code).toBe(
        "INVALID_INPUT",
      );
    }
    expect((await failure(panel.addCron({ schedule: "* * * * *", command: "a\nb" }))).code).toBe(
      "INVALID_INPUT",
    );
    expect(fake.calls).toEqual([]);
  });

  it("passes on a refusal for a line that isn't there", async () => {
    const { panel } = setup();
    const error = await failure(panel.removeCron("missing"));
    expect(error.message).toBe(
      "cPanel refused to remove a cron job: No cron job has the key “missing”.",
    );
  });
});

describe("files", () => {
  const path = `${APP}/shared/.env`;
  const dir = `/home/acct/${APP}/shared`;

  it("writes a new file under a temporary name with its mode, then renames it", async () => {
    const { fake, panel } = setup();
    await panel.writeFile(path, text("A=1\n"), 0o600);
    expect(called(fake)).toEqual([
      "DomainInfo::domains_data",
      "Fileman::upload_files",
      "Fileman::list_files",
      "Fileman::fileop",
    ]);
    expect(lastCall(fake, "Fileman::upload_files")).toMatchObject({
      params: { dir, overwrite: "1", permissions: "0600" },
      files: [".opscrew-r1.tmp"],
    });
    expect(lastCall(fake, "Fileman::fileop")).toMatchObject({
      api: "api2",
      params: {
        op: "rename",
        sourcefiles: `${dir}/.opscrew-r1.tmp`,
        destfiles: `${dir}/.env`,
        doubledecode: "0",
      },
    });
    expect(fake.state.files.get(path)).toEqual({
      kind: "file",
      content: text("A=1\n"),
      mode: 0o600,
    });
    expect([...fake.state.files.keys()]).toEqual([path]);
  });

  it("removes an existing target before the rename, which refuses an existing name (R10)", async () => {
    const { fake, panel } = setup();
    fake.writeText(path, "OLD=1\n", 0o600);
    await panel.writeFile(path, text("NEW=1\n"), 0o600);
    const fileops = fake.calls.filter((call) => call.func === "fileop").map((call) => call.params);
    expect(fileops).toEqual([
      { op: "unlink", sourcefiles: `${dir}/.env`, doubledecode: "0" },
      {
        op: "rename",
        sourcefiles: `${dir}/.opscrew-r1.tmp`,
        destfiles: `${dir}/.env`,
        doubledecode: "0",
      },
    ]);
    expect(fake.readText(path)).toBe("NEW=1\n");
    expect([...fake.state.files.keys()]).toEqual([path]);
  });

  it("removes the temporary file when the rename fails, and refuses a folder as the target", async () => {
    const { fake, panel } = setup();
    fake.failNext("Fileman", "fileop", "Permission denied");
    const error = await failure(panel.writeFile(path, text("A=1\n"), 0o600));
    expect(error.message).toBe(`cPanel refused to put ${path} in place: Permission denied.`);
    expect([...fake.state.files.keys()]).toEqual([]);

    fake.writeText(`${APP}/releases/1/index.php`, "<?php");
    const folder = await failure(panel.writeFile(`${APP}/releases`, text("x"), 0o644));
    expect(folder.code).toBe("INVALID_INPUT");
    expect([...fake.state.files.keys()]).toEqual([`${APP}/releases/1/index.php`]);
  });

  it("keeps the temporary file, the only copy, when the rename fails after the old file was removed", async () => {
    const { fake, panel } = setup({}, (fetch) => async (input, init) => {
      const response = await fetch(input, init);
      const call = fake.calls.at(-1);
      if (call?.func === "fileop" && call.params.op === "unlink") {
        fake.failNext("Fileman", "fileop", "Permission denied");
      }
      return response;
    });
    fake.writeText(path, "OLD=1\n", 0o600);
    const error = await failure(panel.writeFile(path, text("NEW=1\n"), 0o600));
    const kept = `${APP}/shared/.opscrew-r1.tmp`;
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toBe(
      `cPanel refused to put ${path} in place: Permission denied. The old ${path} was already removed; its new content is kept in ${kept}.`,
    );
    expect(error.hint).toBe(
      `Rename ${kept} to ${path} in cPanel's File Manager, or run the command again.`,
    );
    expect([...fake.state.files.keys()]).toEqual([kept]);
    expect(fake.readText(kept)).toBe("NEW=1\n");
  });

  it("passes on a failed upload and writes nothing", async () => {
    const { fake, panel } = setup();
    fake.failNext("Fileman", "upload_files", "Disk quota exceeded");
    const error = await failure(panel.writeFile(path, text("A=1\n"), 0o600));
    expect(error.message).toBe(`cPanel refused to upload ${path}: Disk quota exceeded.`);
    expect(fake.state.files.size).toBe(0);
  });

  it("refuses a mode outside 0 to 0777", async () => {
    const { panel } = setup();
    expect((await failure(panel.writeFile(path, text(""), 0o1777))).code).toBe("INVALID_INPUT");
  });

  it("uploads a tar, unpacks it into the folder, then removes it", async () => {
    const { fake, panel } = setup();
    const archive = tar([
      { name: "opscrew-shop-prod", type: "2", target: `/home/acct/${ROOT}` },
      { name: "notes/", type: "5" },
      { name: "notes/readme.txt", type: "0", content: "hello\n" },
    ]);
    await panel.uploadTar("public_html", archive);
    expect(lastCall(fake, "Fileman::upload_files")).toMatchObject({
      params: { dir: "/home/acct/public_html", permissions: "0600" },
      files: [".opscrew-r1.tar"],
    });
    expect(fake.calls.filter((call) => call.func === "fileop").map((call) => call.params)).toEqual([
      {
        op: "extract",
        sourcefiles: "/home/acct/public_html/.opscrew-r1.tar",
        destfiles: "/home/acct/public_html",
        doubledecode: "0",
      },
      { op: "unlink", sourcefiles: "/home/acct/public_html/.opscrew-r1.tar", doubledecode: "0" },
    ]);
    expect(fake.state.files.get("public_html/opscrew-shop-prod")).toEqual({
      kind: "link",
      target: `/home/acct/${ROOT}`,
    });
    expect(fake.readText("public_html/notes/readme.txt")).toBe("hello\n");
    expect(fake.state.files.has("public_html/.opscrew-r1.tar")).toBe(false);
  });

  it('unpacks a tar into the home folder for ".", making the app\'s folder in one go', async () => {
    const { fake, panel } = setup();
    const archive = tar([
      { name: `${APP}/`, type: "5" },
      { name: `${APP}/shared/`, type: "5" },
      { name: `${APP}/shared/.env`, type: "0", content: "A=1\n", mode: 0o600 },
      { name: `${APP}/agent.sh`, type: "0", content: "#!/bin/bash\n", mode: 0o700 },
    ]);
    await panel.uploadTar(".", archive);
    expect(lastCall(fake, "Fileman::upload_files")).toMatchObject({
      params: { dir: "/home/acct", permissions: "0600" },
      files: [".opscrew-r1.tar"],
    });
    expect(fake.calls.filter((call) => call.func === "fileop").map((call) => call.params)).toEqual([
      {
        op: "extract",
        sourcefiles: "/home/acct/.opscrew-r1.tar",
        destfiles: "/home/acct",
        doubledecode: "0",
      },
      { op: "unlink", sourcefiles: "/home/acct/.opscrew-r1.tar", doubledecode: "0" },
    ]);
    expect(fake.state.folders.has(`${APP}/shared`)).toBe(true);
    expect(fake.state.files.get(`${APP}/shared/.env`)).toEqual({
      kind: "file",
      content: text("A=1\n"),
      mode: 0o600,
    });
    expect(fake.state.files.get(`${APP}/agent.sh`)).toMatchObject({ mode: 0o700 });
    expect(fake.state.files.has(".opscrew-r1.tar")).toBe(false);
  });

  it("removes the tar when unpacking it fails", async () => {
    const { fake, panel } = setup();
    fake.failNext("Fileman", "fileop", "The archive could not be read.");
    const error = await failure(panel.uploadTar("public_html", text("not a tar")));
    expect(error.message).toBe(
      "cPanel refused to unpack the files into public_html: The archive could not be read.",
    );
    expect([...fake.state.files.keys()]).toEqual([]);
  });

  it("reads a file, answers undefined for a missing one, and passes on other refusals", async () => {
    const { fake, panel } = setup();
    fake.writeText(`${APP}/state/report`, "php=8.5.12\n");
    await expect(panel.readFile(`${APP}/state/report`)).resolves.toBe("php=8.5.12\n");
    expect(lastCall(fake, "Fileman::get_file_content")?.params).toEqual({
      dir: `/home/acct/${APP}/state`,
      file: "report",
    });
    await expect(panel.readFile(`${APP}/state/missing`)).resolves.toBeUndefined();
    await expect(panel.readFile(`${APP}/nowhere/report`)).resolves.toBeUndefined();
    fake.failNext("Fileman", "get_file_content", "Permission denied");
    const error = await failure(panel.readFile(`${APP}/state/report`));
    expect(error.message).toBe(`cPanel refused to read ${APP}/state/report: Permission denied.`);
  });

  it("reads an empty file, which cPanel answers with content null, as empty", async () => {
    const { fake, panel } = setup();
    fake.writeText(`${APP}/shared/.env`, "");
    await expect(panel.readFile(`${APP}/shared/.env`)).resolves.toBe("");
  });

  it("removes a folder with everything in it, counts a missing one as removed, and passes on other refusals", async () => {
    const { fake, panel } = setup();
    fake.writeText(`${APP}/agent.sh`, "#!/bin/bash\n");
    fake.writeText(`${APP}/releases/1/index.php`, "<?php");
    fake.writeText("public_html/index.html", "hi");
    await panel.remove(APP);
    expect(lastCall(fake, "Fileman::fileop")?.params).toEqual({
      op: "unlink",
      sourcefiles: `/home/acct/${APP}`,
      doubledecode: "0",
    });
    expect([...fake.state.files.keys()]).toEqual(["public_html/index.html"]);
    await expect(panel.remove(APP)).resolves.toBeUndefined();
    fake.failNext("Fileman", "fileop", "Permission denied");
    const error = await failure(panel.remove("public_html/index.html"));
    expect(error.message).toBe(
      "cPanel refused to remove public_html/index.html: Permission denied.",
    );
  });

  it("refuses a path that isn't relative to home before any call", async () => {
    const { fake, panel } = setup();
    for (const bad of ["", "/etc/passwd", "a/../b", "a//b", "./a", "a,b", "a\\b", "a\nb", "a/"]) {
      expect((await failure(panel.remove(bad))).code).toBe("INVALID_INPUT");
      expect((await failure(panel.readFile(bad))).code).toBe("INVALID_INPUT");
      expect((await failure(panel.list(bad))).code).toBe("INVALID_INPUT");
      expect((await failure(panel.uploadTar(bad, tar([])))).code).toBe("INVALID_INPUT");
    }
    for (const call of [
      panel.writeFile(".", text("x"), 0o644),
      panel.readFile("."),
      panel.remove("."),
      panel.list("."),
    ]) {
      expect((await failure(call)).code).toBe("INVALID_INPUT");
    }
    expect(fake.calls).toEqual([]);
  });

  it("lists a folder's names, hidden ones included, and answers undefined for a missing folder", async () => {
    const { fake, panel } = setup();
    fake.writeText(`${APP}/shared/.env`, "A=1\n", 0o600);
    fake.writeText(`${APP}/agent.sh`, "#!/bin/bash\n");
    fake.writeText(`${APP}/releases/1/index.php`, "<?php");
    expect((await panel.list(APP))?.sort()).toEqual(["agent.sh", "releases", "shared"]);
    expect(lastCall(fake, "Fileman::list_files")?.params).toEqual({
      dir: `/home/acct/${APP}`,
      types: "dir|file|link",
      show_hidden: "1",
      include_mime: "0",
    });
    await expect(panel.list(`${APP}/shared`)).resolves.toEqual([".env"]);
    await expect(panel.list(`${APP}/missing`)).resolves.toBeUndefined();
    fake.failNext("Fileman", "list_files", "Permission denied");
    const error = await failure(panel.list(APP));
    expect(error.message).toBe(`cPanel refused to list ${APP}: Permission denied.`);
  });
});

describe("certificates", () => {
  const host = "shop.example.com";

  it("reads the certificate AutoSSL issued when the hostname was made (R10, R11)", async () => {
    const { fake, panel } = setup();
    await panel.addHostname(host, ROOT);
    const id = fake.state.installed.get(host);
    await expect(panel.certificate(host)).resolves.toEqual({
      hostname: host,
      installed: true,
      notAfter: new Date(NOW + 90 * 86_400_000).toISOString(),
      id,
      inProgress: false,
    });
  });

  it("names AutoSSL's problem, a check in progress, and an expired certificate", async () => {
    const { fake, panel } = setup({ autoSslProblem: "The domain resolves to another address." });
    await panel.addHostname(host, ROOT);
    fake.state.autosslInProgress = true;
    await expect(panel.certificate(host)).resolves.toEqual({
      hostname: host,
      installed: false,
      inProgress: true,
      problem: "The domain resolves to another address.",
    });
    const expired = setup();
    await expired.panel.addHostname(host, ROOT);
    for (const certificate of expired.fake.state.certificates)
      certificate.notAfter = NOW / 1000 - 1;
    expect((await expired.panel.certificate(host)).installed).toBe(false);
  });

  it("starts an AutoSSL check on request", async () => {
    const { fake, panel } = setup();
    await panel.requestCertificate(host);
    expect(lastCall(fake, "SSL::start_autossl_check")).toMatchObject({ api: "uapi", params: {} });
  });

  it("removes a certificate and its key once its hostname is gone, and refuses it before", async () => {
    const { fake, panel } = setup();
    await panel.addHostname(host, ROOT);
    const { id } = await panel.certificate(host);
    const refused = await failure(panel.removeCertificate(id as string));
    expect(refused.code).toBe("INVALID_INPUT");
    expect(refused.message).toBe(
      `The certificate is still installed for ${host}; nothing was removed.`,
    );

    await panel.removeHostname(host);
    const before = fake.calls.length;
    const keys = fake.state.keys.length;
    await panel.removeCertificate(id as string);
    expect(called(fake, before)).toEqual([
      "SSL::installed_hosts",
      "SSL::list_certs",
      "SSL::delete_cert",
      "SSL::list_keys",
      "SSL::delete_key",
    ]);
    expect(fake.state.certificates.map((certificate) => certificate.id)).not.toContain(id);
    expect(fake.state.keys.length).toBe(keys - 1);

    const again = fake.calls.length;
    await panel.removeCertificate(id as string);
    expect(called(fake, again)).toEqual(["SSL::installed_hosts", "SSL::list_certs"]);
  });

  it("keeps a key another certificate uses", async () => {
    const { fake, panel } = setup();
    await panel.addHostname(host, ROOT);
    const { id } = await panel.certificate(host);
    const certificate = fake.state.certificates.find((entry) => entry.id === id);
    fake.state.certificates.push({
      ...(certificate as NonNullable<typeof certificate>),
      id: "renewed",
    });
    await panel.removeHostname(host);
    const keys = fake.state.keys.length;
    await panel.removeCertificate(id as string);
    expect(called(fake)).not.toContain("SSL::delete_key");
    expect(fake.state.keys.length).toBe(keys);
  });
});

describe("PHP", () => {
  const host = "shop.example.com";

  it("refuses plainly where the account has no MultiPHP", async () => {
    const { fake, panel } = setup();
    const error = await failure(panel.setPhpVersion(host, "8.2"));
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.message).toBe(
      `This cPanel account has no MultiPHP, so OpsCrew can't set ${host}'s PHP version.`,
    );
    expect(called(fake)).toEqual(["Features::list_features"]);
  });

  it("sets a hostname's version through MultiPHP by its X.Y version", async () => {
    const { fake, panel } = setup({
      features: { multiphp: 1 },
      phpVersions: ["ea-php74", "ea-php82"],
    });
    await panel.addHostname(host, ROOT);
    await panel.setPhpVersion(host, "8.2");
    expect(lastCall(fake, "LangPHP::php_set_vhost_versions")?.params).toEqual({
      version: "ea-php82",
      vhost: host,
    });
    expect(fake.state.vhostPhp.get(host)).toBe("ea-php82");
    const error = await failure(panel.setPhpVersion(host, "8.4"));
    expect(error.message).toBe("MultiPHP has no PHP 8.4 on this account.");
    expect(error.hint).toBe("Choose 7.4 or 8.2.");
  });
});

describe("every call's refusal", () => {
  type Panel = ReturnType<typeof setup>["panel"];
  const host = "shop.example.com";
  const withHost = async (panel: Panel) => panel.addHostname(host, ROOT);
  const withoutHost = async (panel: Panel) => {
    await withHost(panel);
    await panel.removeHostname(host);
  };
  const certificateId = (fake: FakeCpanel) => fake.state.certificates.at(-1)?.id as string;
  const db = {
    name: "acct_shop",
    user: "acct_shop",
    password: fakeSecret("generic-password", "db"),
  };
  const cases: [
    string,
    string,
    (panel: Panel, fake: FakeCpanel) => Promise<unknown>,
    ((panel: Panel, fake: FakeCpanel) => Promise<unknown>)?,
  ][] = [
    ...[
      "Variables::get_server_information",
      "DomainInfo::domains_data",
      "Quota::get_quota_info",
      "Mysql::get_restrictions",
      "Features::list_features",
      "Variables::get_user_information",
      "PassengerApps::list_applications",
    ].map(
      (key) =>
        ["inspect", key, (panel: Panel) => panel.inspect()] as [
          string,
          string,
          (panel: Panel) => Promise<unknown>,
        ],
    ),
    ["documentRoot", "DomainInfo::domains_data", (panel) => panel.documentRoot(host)],
    ["addHostname", "SubDomain::addsubdomain", (panel) => panel.addHostname(host, ROOT)],
    [
      "addHostname",
      "AddonDomain::addaddondomain",
      (panel) => panel.addHostname("shop.example.org", ROOT),
    ],
    ["removeHostname", "SubDomain::delsubdomain", (panel) => panel.removeHostname(host), withHost],
    ["listDatabases", "Mysql::list_databases", (panel) => panel.listDatabases()],
    ["addDatabase", "Mysql::create_database", (panel) => panel.addDatabase(db)],
    ["addDatabase", "Mysql::create_user", (panel) => panel.addDatabase(db)],
    ["addDatabase", "Mysql::set_privileges_on_database", (panel) => panel.addDatabase(db)],
    [
      "removeDatabase",
      "Mysql::list_users",
      (panel) => panel.removeDatabase(db),
      (panel) => panel.addDatabase(db),
    ],
    [
      "removeDatabase",
      "Mysql::delete_user",
      (panel) => panel.removeDatabase(db),
      (panel) => panel.addDatabase(db),
    ],
    [
      "removeDatabase",
      "Mysql::delete_database",
      (panel) => panel.removeDatabase(db),
      (panel) => panel.addDatabase(db),
    ],
    ["listCron", "Cron::listcron", (panel) => panel.listCron()],
    [
      "addCron",
      "Cron::add_line",
      (panel) => panel.addCron({ schedule: "* * * * *", command: "true" }),
    ],
    ["writeFile", "Fileman::upload_files", (panel) => panel.writeFile("a/b", text("x"), 0o644)],
    ["writeFile", "Fileman::list_files", (panel) => panel.writeFile("a/b", text("x"), 0o644)],
    ["uploadTar", "Fileman::fileop", (panel) => panel.uploadTar("a", tar([]))],
    ["readFile", "Fileman::get_file_content", (panel) => panel.readFile("a/b")],
    ["list", "Fileman::list_files", (panel) => panel.list("a")],
    ["certificate", "SSL::installed_hosts", (panel) => panel.certificate(host)],
    ["certificate", "SSL::is_autossl_check_in_progress", (panel) => panel.certificate(host)],
    ["certificate", "SSL::get_autossl_problems", (panel) => panel.certificate(host)],
    ["requestCertificate", "SSL::start_autossl_check", (panel) => panel.requestCertificate(host)],
    [
      "removeCertificate",
      "SSL::list_certs",
      (panel, fake) => panel.removeCertificate(certificateId(fake)),
      withoutHost,
    ],
    [
      "removeCertificate",
      "SSL::delete_cert",
      (panel, fake) => panel.removeCertificate(certificateId(fake)),
      withoutHost,
    ],
    [
      "removeCertificate",
      "SSL::list_keys",
      (panel, fake) => panel.removeCertificate(certificateId(fake)),
      withoutHost,
    ],
    [
      "removeCertificate",
      "SSL::delete_key",
      (panel, fake) => panel.removeCertificate(certificateId(fake)),
      withoutHost,
    ],
  ];

  it.each(cases)(
    "%s passes on %s's refusal without the token",
    async (_name, key, run, prepare) => {
      const { fake, panel } = setup({ features: { multiphp: 1 }, phpVersions: ["ea-php82"] });
      await prepare?.(panel, fake);
      const [module, func] = key.split("::") as [string, string];
      fake.failNext(module, func, `Refused for cpanel acct:${TOKEN}.`);
      const error = await failure(run(panel, fake));
      expect(error.code).toBe("PROVIDER_ERROR");
      expect(error.message).toMatch(
        /^cPanel refused to .*: Refused for cpanel acct:\[REDACTED:OPSCREW_HOSTING_TOKEN\]\.$/,
      );
    },
  );

  it.each([["php_get_installed_versions"], ["php_set_vhost_versions"]])(
    "setPhpVersion passes on LangPHP::%s's refusal",
    async (func) => {
      const { fake, panel } = setup({ features: { multiphp: 1 }, phpVersions: ["ea-php82"] });
      await withHost(panel);
      fake.failNext("LangPHP", func, `Refused ${TOKEN}`);
      expect((await failure(panel.setPhpVersion(host, "8.2"))).code).toBe("PROVIDER_ERROR");
    },
  );

  it("removeCron and removeHostname of an addon pass on API2's refusal", async () => {
    const { fake, panel } = setup();
    await panel.addHostname("shop.example.org", ROOT);
    fake.failNext("AddonDomain", "deladdondomain", `Refused ${TOKEN}`);
    expect((await failure(panel.removeHostname("shop.example.org"))).code).toBe("PROVIDER_ERROR");
    fake.failNext("Cron", "remove_line", `Refused ${TOKEN}`);
    expect((await failure(panel.removeCron("1"))).code).toBe("PROVIDER_ERROR");
  });

  it("answers a wrong token with HTTP 401, shown without the token", async () => {
    const fake = fakeCpanel({ user: "acct", token: fakeSecret("generic-password", "other") });
    const panel = new CpanelPanel(ACCESS, { fetch: fake.fetch });
    const error = await failure(panel.listDatabases());
    expect(error.code).toBe("CREDENTIALS_INVALID");
  });
});
