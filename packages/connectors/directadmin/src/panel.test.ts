import type { HostingOperation } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { FakeDirectAdmin, type FakeDirectAdminOptions } from "./fake";
import { DirectAdminPanel } from "./panel";

function setup(options: FakeDirectAdminOptions = {}) {
  const fake = new FakeDirectAdmin({ domains: ["example.com", "shop.test"], ...options });
  return { fake, panel: new DirectAdminPanel(fake.access, { fetch: fake.fetch }) };
}

async function failure(promise: Promise<unknown>, code: string): Promise<OpsCrewError> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(OpsCrewError);
  expect((error as OpsCrewError).code).toBe(code);
  return error as OpsCrewError;
}

/**
 * A ustar archive of files, folders (names ending in `/`) and links (`-> target`); `modes` by name
 * (0644 otherwise).
 */
function tar(entries: Record<string, string>, modes: Record<string, number> = {}): Uint8Array {
  const blocks: Uint8Array[] = [];
  const encoder = new TextEncoder();
  for (const [name, value] of Object.entries(entries)) {
    const header = new Uint8Array(512);
    const link = value.startsWith("-> ") ? value.slice(3) : undefined;
    const dir = name.endsWith("/");
    const data = dir || link !== undefined ? new Uint8Array() : encoder.encode(value);
    const put = (text: string, at: number) => header.set(encoder.encode(text), at);
    put(name, 0);
    put(`${(modes[name] ?? 0o644).toString(8).padStart(7, "0")}\0`, 100);
    put(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
    put(dir ? "5" : link !== undefined ? "2" : "0", 156);
    if (link !== undefined) put(link, 157);
    put("ustar\0", 257);
    put("00", 263);
    blocks.push(header, data, new Uint8Array((512 - (data.length % 512)) % 512));
  }
  blocks.push(new Uint8Array(1024));
  const out = new Uint8Array(blocks.reduce((sum, block) => sum + block.length, 0));
  let offset = 0;
  for (const block of blocks) {
    out.set(block, offset);
    offset += block.length;
  }
  return out;
}

describe("DirectAdminPanel", () => {
  it("is DirectAdmin's panel with the operations its user API documents", () => {
    const { panel } = setup();
    expect(panel.kind).toBe("directadmin");
    expect([...panel.operations].sort()).toEqual(
      [
        "addCron",
        "addDatabase",
        "addHostname",
        "remove",
        "removeCertificate",
        "removeCron",
        "removeDatabase",
        "removeHostname",
        "requestCertificate",
        "uploadTar",
        "writeFile",
      ].sort(),
    );
    expect(panel.operations.has("setPhpVersion" as HostingOperation)).toBe(false);
  });

  describe("inspect", () => {
    it("reads the domains, subdomains, address, quota and database limits", async () => {
      const { fake, panel } = setup({
        quota: { usedBytes: 300 * 1024 * 1024, limitBytes: 2048 * 1024 * 1024 },
      });
      fake.subdomains.get("example.com")?.push("blog");
      expect(await panel.inspect()).toEqual({
        panel: "directadmin",
        domains: [
          { name: "example.com", kind: "main", documentRoot: "domains/example.com/public_html" },
          { name: "blog.example.com", kind: "subdomain" },
          { name: "shop.test", kind: "addon", documentRoot: "domains/shop.test/public_html" },
        ],
        addresses: ["203.0.113.10"],
        quota: { usedMb: 300, limitMb: 2048 },
        databases: { engines: ["mariadb"], prefix: "alice_", maxDatabaseName: 64, maxUserName: 32 },
        apps: { selectors: [] },
        phpPerHostname: [],
        documentRoots: "panel",
      });
    });

    it("leaves out the limit of an unlimited quota and tells MySQL from MariaDB", async () => {
      const { panel } = setup({ databaseVersion: "8.0.36" });
      const facts = await panel.inspect();
      expect(facts.quota).toEqual({ usedMb: 0 });
      expect(facts.databases.engines).toEqual(["mysql"]);
    });
  });

  describe("hostnames", () => {
    it("adds a subdomain and answers the root DirectAdmin made, in either layout", async () => {
      const own = setup();
      expect(await own.panel.addHostname("app.example.com")).toBe(
        "domains/app.example.com/public_html",
      );
      expect(own.fake.subdomains.get("example.com")).toEqual(["app"]);
      expect(own.fake.calls).toContainEqual({ method: "POST", path: "/CMD_API_SUBDOMAINS" });
      expect(await own.panel.documentRoot("APP.example.com")).toBe(
        "domains/app.example.com/public_html",
      );
      expect(await own.panel.documentRoot("shop.test")).toBe("domains/shop.test/public_html");
      expect(await own.panel.documentRoot("nope.example.com")).toBeUndefined();
      expect(await own.panel.documentRoot("other.org")).toBeUndefined();

      const parent = setup({ subdomainLayout: "parent" });
      expect(await parent.panel.addHostname("app.shop.test")).toBe(
        "domains/shop.test/public_html/app",
      );
      expect(await parent.panel.documentRoot("app.shop.test")).toBe(
        "domains/shop.test/public_html/app",
      );
    });

    it("refuses a document root, a name outside the domains, a domain and a bad name", async () => {
      const { fake, panel } = setup();
      const root = await failure(
        panel.addHostname("app.example.com", "domains/app.example.com/public_html"),
        "INVALID_INPUT",
      );
      expect(root.message).toContain("DirectAdmin chooses app.example.com's document root");
      const outside = await failure(panel.addHostname("app.other.org"), "INVALID_INPUT");
      expect(outside.hint).toContain("Domain Setup");
      await failure(panel.addHostname("shop.test"), "INVALID_INPUT");
      await failure(panel.addHostname("not a name"), "INVALID_INPUT");
      expect(fake.subdomains.get("example.com")).toEqual([]);
      expect(fake.calls.some((call) => call.method === "POST")).toBe(false);
    });

    it("fails plainly when a subdomain's root was overridden", async () => {
      const { fake, panel } = setup();
      fake.subdomains.get("example.com")?.push("old");
      const error = await failure(panel.documentRoot("old.example.com"), "PROVIDER_ERROR");
      expect(error.hint).toContain("Document Root Override");
    });

    it("removes a subdomain but keeps its folder, and never a domain", async () => {
      const { fake, panel } = setup();
      await panel.addHostname("app.example.com");
      await panel.removeHostname("app.example.com");
      expect(fake.subdomains.get("example.com")).toEqual([]);
      expect(fake.files.has("domains/app.example.com/public_html")).toBe(true);
      const calls = fake.calls.length;
      await panel.removeHostname("app.example.com");
      expect(fake.calls.slice(calls).every((call) => call.method === "GET")).toBe(true);
      await panel.removeHostname("app.other.org");
      await failure(panel.removeHostname("example.com"), "INVALID_INPUT");
    });
  });

  describe("databases", () => {
    it("creates a database with its user, lists it, and removes both", async () => {
      const { fake, panel } = setup();
      const password = fakeSecret("generic-password", "db");
      await panel.addDatabase({ name: "alice_shop", user: "alice_shop", password });
      expect(await panel.listDatabases()).toEqual(["alice_shop"]);
      expect(fake.databaseUsers.get("alice_shop")).toBe("alice_shop");
      await panel.removeDatabase({ name: "alice_shop", user: "alice_shop" });
      expect(await panel.listDatabases()).toEqual([]);
      expect(fake.databaseUsers.size).toBe(0);
      await panel.removeDatabase({ name: "alice_shop", user: "alice_shop" });
    });

    it("reports an existing database without the password", async () => {
      const { panel } = setup();
      const password = fakeSecret("generic-password", "db");
      await panel.addDatabase({ name: "alice_shop", user: "alice_shop", password });
      const error = await failure(
        panel.addDatabase({ name: "alice_shop", user: "alice_shop", password }),
        "PROVIDER_ERROR",
      );
      expect(error.message).toContain("ALREADY_EXISTS");
      expect(error.message).not.toContain(password);
    });

    it("fails when the database is still listed after deleting it", async () => {
      const { fake, panel } = setup();
      await panel.addDatabase({ name: "alice_shop", user: "alice_shop", password: "x".repeat(12) });
      const original = fake.fetch;
      const keep = async (input: string | URL, init?: RequestInit) =>
        init?.method === "DELETE" && String(input).includes("/databases/")
          ? new Response(null, { status: 204 })
          : original(input, init);
      const stubborn = new DirectAdminPanel(fake.access, { fetch: keep });
      const error = await failure(
        stubborn.removeDatabase({ name: "alice_shop", user: "alice_shop" }),
        "PROVIDER_ERROR",
      );
      expect(error.message).toContain("still lists the database alice_shop");
    });
  });

  describe("cron", () => {
    it("adds, lists and removes a job", async () => {
      const { fake, panel } = setup();
      fake.cron.set("7", "0 3 * * * /usr/bin/true");
      const job = await panel.addCron({
        schedule: "*  * * * *",
        command: "bash ~/opscrew/agent.sh >/dev/null 2>&1",
      });
      expect(job).toEqual({
        key: "1",
        schedule: "* * * * *",
        command: "bash ~/opscrew/agent.sh >/dev/null 2>&1",
      });
      expect(await panel.listCron()).toEqual([
        { key: "7", schedule: "0 3 * * *", command: "/usr/bin/true" },
        job,
      ]);
      await panel.removeCron("1");
      expect([...fake.cron.keys()]).toEqual(["7"]);
    });

    it("refuses a schedule that isn't five fields, a command of two lines and a bad id", async () => {
      const { fake, panel } = setup();
      await failure(panel.addCron({ schedule: "* * * *", command: "x" }), "INVALID_INPUT");
      await failure(panel.addCron({ schedule: "@hourly x y z w", command: "x" }), "INVALID_INPUT");
      await failure(panel.addCron({ schedule: "* * * * *", command: "a\nb" }), "INVALID_INPUT");
      await failure(panel.removeCron("1; rm"), "INVALID_INPUT");
      expect(fake.cron.size).toBe(0);
    });

    it("reports a listing it can't read", async () => {
      const { fake, panel } = setup();
      fake.cron.set("3", "* * *");
      await failure(panel.listCron(), "PROVIDER_ERROR");
    });

    it("reports a job the panel accepted but doesn't list", async () => {
      const { fake } = setup();
      const original = fake.fetch;
      const lose = async (input: string | URL, init?: RequestInit) => {
        const answer = await original(input, init);
        if (init?.method === "POST") fake.cron.clear();
        return answer;
      };
      const forgetful = new DirectAdminPanel(fake.access, { fetch: lose });
      await failure(forgetful.addCron({ schedule: "* * * * *", command: "x" }), "PROVIDER_ERROR");
    });
  });

  describe("files", () => {
    it("writes a file with its mode under a temporary name, then renames it over the old one", async () => {
      const { fake, panel } = setup();
      await panel.uploadTar("domains/example.com", tar({ "keep/": "" }));
      await panel.writeFile(
        "domains/example.com/keep/.env",
        new TextEncoder().encode("A=1"),
        0o600,
      );
      await panel.writeFile(
        "domains/example.com/keep/.env",
        new TextEncoder().encode("A=2"),
        0o600,
      );
      expect(fake.text("domains/example.com/keep/.env")).toBe("A=2");
      expect(fake.files.get("domains/example.com/keep/.env")).toMatchObject({ mode: 0o600 });
      const uploads = fake.calls.filter((call) =>
        call.path.startsWith("/api/filemanager-actions/upload"),
      );
      expect(uploads[1]?.path).toMatch(/name=\.\.env\.opscrew-[0-9a-f]{12}\.tmp&perm=0600/);
      expect([...fake.files.keys()].filter((key) => key.includes(".tmp"))).toEqual([]);
    });

    it("writes into the home folder itself", async () => {
      const { fake, panel } = setup();
      await panel.writeFile("note.txt", new TextEncoder().encode("hi"), 0o644);
      expect(fake.text("note.txt")).toBe("hi");
    });

    it("removes the temporary file when the rename fails", async () => {
      const { fake, panel } = setup();
      fake.failNext("POST /api/filemanager-actions/move", {
        status: 409,
        body: { type: "FILEMANAGER_OP_ERROR", path: "x", reason: "NO_SPACE" },
      });
      const error = await failure(
        panel.writeFile("domains/example.com/x", new Uint8Array([1]), 0o600),
        "PROVIDER_ERROR",
      );
      expect(error.message).toContain("NO_SPACE");
      expect([...fake.files.keys()].filter((key) => key.includes(".tmp"))).toEqual([]);
    });

    it("unpacks a tar into a folder, links included, and removes the tar", async () => {
      const { fake, panel } = setup();
      await panel.uploadTar(
        "domains/example.com",
        tar({
          "opscrew/releases/1/index.php": "<?php echo 1;",
          "opscrew/current": "-> releases/1",
        }),
      );
      expect(fake.text("domains/example.com/opscrew/releases/1/index.php")).toBe("<?php echo 1;");
      expect(fake.files.get("domains/example.com/opscrew/current")).toEqual({
        type: "symlink",
        target: "releases/1",
      });
      expect([...fake.files.keys()].filter((key) => key.endsWith(".tar"))).toEqual([]);
    });

    it('unpacks a tar into the home folder for ".", making the app\'s folder in one go', async () => {
      const { fake, panel } = setup();
      await panel.uploadTar(
        ".",
        tar(
          {
            "opscrew/shop-prod/": "",
            "opscrew/shop-prod/shared/": "",
            "opscrew/shop-prod/shared/.env": "A=1",
            "opscrew/shop-prod/agent.sh": "#!/bin/bash",
          },
          { "opscrew/shop-prod/shared/.env": 0o600, "opscrew/shop-prod/agent.sh": 0o700 },
        ),
      );
      const upload = fake.calls.find((call) =>
        call.path.startsWith("/api/filemanager-actions/upload"),
      );
      expect(upload?.path).toMatch(/dir=\.&name=\.opscrew-[0-9a-f]{12}\.tar&perm=0600/);
      expect(fake.files.get("opscrew/shop-prod/shared")).toEqual({ type: "dir" });
      expect(fake.text("opscrew/shop-prod/shared/.env")).toBe("A=1");
      expect(fake.files.get("opscrew/shop-prod/shared/.env")).toMatchObject({ mode: 0o600 });
      expect(fake.files.get("opscrew/shop-prod/agent.sh")).toMatchObject({ mode: 0o700 });
      expect([...fake.files.keys()].filter((key) => key.endsWith(".tar"))).toEqual([]);
    });

    it("lists a folder's names, hidden ones included, or undefined when it doesn't exist", async () => {
      const { fake, panel } = setup();
      await panel.uploadTar(
        ".",
        tar({
          "opscrew/app/shared/.env": "A=1",
          "opscrew/app/agent.sh": "x",
          "opscrew/app/r/": "",
        }),
      );
      expect((await panel.list("opscrew/app"))?.sort()).toEqual(["agent.sh", "r", "shared"]);
      expect(await panel.list("opscrew/app/shared")).toEqual([".env"]);
      expect(fake.calls.at(-1)?.path).toBe(
        "/api/filemanager/list?path=opscrew%2Fapp%2Fshared&limit=0",
      );
      expect(await panel.list("opscrew/missing")).toBeUndefined();
    });

    it("removes the tar when unpacking fails", async () => {
      const { fake, panel } = setup();
      await failure(
        panel.uploadTar("domains/example.com", new Uint8Array(512).fill(1)),
        "PROVIDER_ERROR",
      );
      expect([...fake.files.keys()].filter((key) => key.endsWith(".tar"))).toEqual([]);
    });

    it("reads a file, or undefined when it doesn't exist", async () => {
      const { panel } = setup();
      await panel.writeFile("a.txt", new TextEncoder().encode("hello"), 0o644);
      expect(await panel.readFile("a.txt")).toBe("hello");
      expect(await panel.readFile("b.txt")).toBeUndefined();
    });

    it("removes a folder with everything in it, and counts a missing path as removed", async () => {
      const { fake, panel } = setup();
      await panel.uploadTar("domains/example.com", tar({ "old/a": "1", "old/b/c": "2" }));
      await panel.remove("domains/example.com/old");
      expect([...fake.files.keys()].some((key) => key.includes("/old"))).toBe(false);
      await panel.remove("domains/example.com/old");
    });

    it("refuses paths outside the home folder", async () => {
      const { panel } = setup();
      for (const path of ["", "/etc/passwd", "a/../b", "./a", "a/", "a//b"]) {
        await failure(panel.remove(path), "INVALID_INPUT");
        await failure(panel.readFile(path), "INVALID_INPUT");
        await failure(panel.list(path), "INVALID_INPUT");
        await failure(panel.uploadTar(path, tar({})), "INVALID_INPUT");
      }
      await failure(panel.writeFile(".", new Uint8Array(), 0o644), "INVALID_INPUT");
      await failure(panel.readFile("."), "INVALID_INPUT");
      await failure(panel.remove("."), "INVALID_INPUT");
      await failure(panel.list("."), "INVALID_INPUT");
      await failure(panel.writeFile("a", new Uint8Array(), 0o1000), "INVALID_INPUT");
    });
  });

  describe("certificates", () => {
    it("requests a certificate, reads it with its id, and removes it", async () => {
      const { fake, panel } = setup();
      await panel.addHostname("app.example.com");
      expect(await panel.certificate("app.example.com")).toEqual({
        hostname: "app.example.com",
        installed: false,
        inProgress: false,
        problem: "No certificate covers it yet.",
      });
      await panel.requestCertificate("app.example.com");
      const cert = await panel.certificate("app.example.com");
      expect(cert).toMatchObject({
        hostname: "app.example.com",
        installed: true,
        inProgress: false,
      });
      expect(cert.notAfter).toMatch(/^\d{4}-\d\d-\d\dT/);
      expect(cert.id).toMatch(/^example\.com\/cert-\d+$/);
      expect(cert.names).toEqual(["app.example.com"]);
      await panel.removeCertificate(cert.id as string);
      expect(
        fake.certificates.get("example.com")?.some((c) => c.dnsNames.includes("app.example.com")),
      ).toBe(false);
      await panel.removeCertificate(cert.id as string);
      await failure(panel.removeCertificate("nonsense"), "INVALID_INPUT");
    });

    it("gives no id for a certificate other names share, and names a broken one's problem", async () => {
      const { fake, panel } = setup();
      fake.certificates.set("example.com", [
        {
          id: "w",
          dnsNames: ["example.com", "*.example.com"],
          notAfter: "2027-02-01T00:00:00Z",
          error: "",
        },
      ]);
      const shared = await panel.certificate("app.example.com");
      expect(shared).toEqual({
        hostname: "app.example.com",
        installed: true,
        inProgress: false,
        notAfter: "2027-02-01T00:00:00.000Z",
        names: ["example.com", "*.example.com"],
      });
      fake.certificates.set("example.com", [
        {
          id: "e",
          dnsNames: ["app.example.com"],
          notAfter: "2026-01-01T00:00:00Z",
          error: "expired",
        },
      ]);
      expect((await panel.certificate("app.example.com")).problem).toBe(
        "The certificate covering it is expired.",
      );
      await failure(panel.certificate("app.other.org"), "INVALID_INPUT");
    });

    it("says when automatic certificates are off, and accepts a request already running", async () => {
      const off = setup({ acme: false });
      const error = await failure(off.panel.requestCertificate("example.com"), "PROVIDER_ERROR");
      expect(error.message).toContain("turned off for example.com");
      expect(error.hint).toContain("SSL Certificates");

      const { fake, panel } = setup();
      fake.failNext("POST /api/domain-tls/domains/example.com/provision-certs", {
        status: 491,
        body: { type: "DOMAIN_ACME_ALREADY_IN_PROGRESS" },
      });
      await panel.requestCertificate("example.com");
      fake.failNext("POST /api/domain-tls/domains/example.com/provision-certs", {
        status: 490,
        body: { type: "RATELIMIT_REACHED" },
      });
      const limited = await failure(panel.requestCertificate("example.com"), "PROVIDER_ERROR");
      expect(limited.message).toContain("rate limit");
    });
  });

  it("refuses to set a PHP version, with the panel step", async () => {
    const { panel } = setup();
    const error = await failure(panel.setPhpVersion("app.example.com", "8.3"), "INVALID_INPUT");
    expect(error.hint).toContain("Choose PHP 8.3 for app.example.com");
  });

  it("fails with the login key steps when the key is wrong", async () => {
    const { fake } = setup();
    const panel = new DirectAdminPanel(
      { ...fake.access, token: "wrong-login-key-123" },
      { fetch: fake.fetch },
    );
    const error = await failure(panel.inspect(), "CREDENTIALS_INVALID");
    expect(error.message).not.toContain("wrong-login-key-123");
  });
});
