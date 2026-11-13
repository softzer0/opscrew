import { spawnSync } from "node:child_process";
import { statSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  Account,
  agentSkipReason,
  CAN_LINK,
  laravelRelease,
  phpRelease,
} from "../__fixtures__/account";

/*
 * A panel's file removal skips read-only files (cPanel's Fileman::fileop unlink, research R13), so
 * the agent leaves none in the app's folder. A plain PHP app's paths reach its index.php through
 * OpsCrew's .htaccess block, as on a server (research R13). File modes mean little under Git for
 * Windows: this runs on Linux.
 */

const reason = agentSkipReason();
const runs = reason === undefined && CAN_LINK && process.platform !== "win32";

const accounts: Account[] = [];
afterEach(() => {
  for (const made of accounts.splice(0)) made.remove();
});

describe.skipIf(!runs)("the hosting agent's files", { timeout: 180_000 }, () => {
  it("are all writable by the account's user after two releases, so a panel can remove them", () => {
    const a = new Account();
    accounts.push(a);
    expect(a.run().status).toBe(0);
    a.publish(laravelRelease("one"), { run: 101 });
    expect(a.run().status).toBe(0);
    a.publish(laravelRelease("two"), { run: 102 });
    expect(a.run().status).toBe(0);
    expect(a.keyValues("state/status")).toMatchObject({ running: "102-1" });
    const found = spawnSync("find", [a.dir, "!", "-perm", "-u+w"], { encoding: "utf8" });
    expect(found.status, found.stderr).toBe(0);
    expect(found.stdout).toBe("");
  });
});

describe.skipIf(!runs)("the hosting agent's kept folders", { timeout: 180_000 }, () => {
  it("makes one the release doesn't ship empty in shared/, so the app writes through its link", () => {
    const a = new Account({ sharedPaths: [".env", "storage", "public/uploads"] });
    accounts.push(a);
    a.run();
    a.publish(laravelRelease("one"), { run: 101 });
    expect(a.run().output).toContain("Release 101-1 serves.");
    expect(statSync(`${a.dir}/shared/public/uploads`).mode & 0o777).toBe(0o755);
    writeFileSync(`${a.dir}/releases/101-1/public/uploads/photo.jpg`, "photo");
    expect(a.file("shared/public/uploads/photo.jpg")).toBe("photo");

    a.publish(laravelRelease("two"), { run: 102 });
    expect(a.run().output).toContain("Release 102-1 serves.");
    expect(a.file("releases/102-1/public/uploads/photo.jpg")).toBe("photo");
  });
});

/** OpsCrew's block in `htaccess`, up to its end line. */
function block(htaccess: string | undefined): string {
  const end = "# END OpsCrew\n";
  return (htaccess ?? "").slice(0, (htaccess ?? "").indexOf(end) + end.length);
}

const FALLBACK =
  "RewriteCond %{REQUEST_FILENAME} !-f\nRewriteCond %{REQUEST_FILENAME} !-d\nRewriteRule ^ index.php [L]\n# END OpsCrew\n";

describe.skipIf(!runs)("the hosting agent's .htaccess block", { timeout: 180_000 }, () => {
  it("sends a plain PHP app's paths that are no file to index.php, also once HTTPS is forced", () => {
    const a = new Account();
    accounts.push(a);
    a.run();
    const { "public/.htaccess": _, ...plain } = phpRelease("one");
    a.publish(plain, { run: 101 });
    expect(a.run().output).toContain("Release 101-1 serves.");
    expect(block(a.file("releases/101-1/public/.htaccess")).endsWith(FALLBACK)).toBe(true);
    // An app's .htaccess whose only RewriteRule is a comment gets it too.
    a.publish(
      { ...plain, "public/.htaccess": "# RewriteRule ^old$ /new\nOptions -MultiViews\n" },
      { run: 102 },
    );
    expect(a.run().output).toContain("Release 102-1 serves.");
    expect(block(a.file("releases/102-1/public/.htaccess")).endsWith(FALLBACK)).toBe(true);

    writeFileSync(`${a.stub}/certificate`, "");
    expect(a.run().output).toContain("HTTPS is forced from now on.");
    const forced = block(a.file("releases/102-1/public/.htaccess"));
    expect(forced).toContain("RewriteCond %{HTTPS} !=on\n");
    expect(forced.endsWith(FALLBACK)).toBe(true);
  });

  it("leaves an app that rewrites its own paths, and a static site, without it", () => {
    const a = new Account();
    accounts.push(a);
    a.run();
    a.publish(laravelRelease("one"), { run: 101 });
    expect(a.run().output).toContain("Release 101-1 serves.");
    expect(block(a.file("releases/101-1/public/.htaccess"))).not.toContain("index.php");
    writeFileSync(`${a.stub}/certificate`, "");
    expect(a.run().output).toContain("HTTPS is forced from now on.");
    expect(block(a.file("releases/101-1/public/.htaccess"))).not.toContain("index.php");

    const site = new Account({
      appKind: "static",
      releaseBranch: "opscrew/release/site-prod",
      webRoot: ".",
      phpCli: undefined,
      releaseCommand: undefined,
      sharedPaths: [],
      database: undefined,
    });
    accounts.push(site);
    site.run();
    site.publish({ "index.html": "<h1>Site</h1>\n" }, { run: 901 });
    expect(site.run().output).toContain("Release 901-1 serves.");
    expect(block(site.file("releases/901-1/.htaccess"))).not.toContain("index.php");
  });
});
