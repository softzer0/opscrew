import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  Account,
  agentSkipReason,
  CAN_LINK,
  HAS_FLOCK,
  laravelRelease,
} from "./__fixtures__/account";
import { releaseKeyPair } from "./__fixtures__/release-signing";

/*
 * The agent run by bash, as cron runs it, against a local bare repository in place of GitHub
 * (027 T2704). Cases that switch a release need real symbolic links, which Git for Windows' `ln -s`
 * doesn't make (it copies): they skip there and run on Linux.
 */

const reason = agentSkipReason();
if (reason !== undefined)
  console.warn(`[iac-templates] skipping the hosting agent's runs: ${reason}`);
if (reason === undefined && !CAN_LINK) {
  console.warn(
    "[iac-templates] skipping the hosting agent's switch cases: ln -s makes no symbolic link here (Git for Windows copies); they run on Linux",
  );
}
if (reason === undefined && !HAS_FLOCK) {
  console.warn(
    "[iac-templates] skipping the hosting agent's held lock case: flock is not available here (a shim grants the lock in the other cases)",
  );
}

/** A case that switches a release, so needs real symbolic links. */
const switching = it.skipIf(!CAN_LINK);
const POSIX = process.platform !== "win32";
const HASH = "ab".repeat(32);

const accounts: Account[] = [];
afterEach(() => {
  for (const account of accounts.splice(0)) account.remove();
});

function account(...args: ConstructorParameters<typeof Account>): Account {
  const made = new Account(...args);
  accounts.push(made);
  return made;
}

/** A request's bytes as the CLI writes them, valid for 30 minutes unless `expires` says otherwise. */
function requestText(
  fields: Record<string, string>,
  expires = Math.floor(Date.now() / 1000) + 1800,
): string {
  return Object.entries({ kind: "", hash: HASH, expires: String(expires), ...fields })
    .map(([key, value]) => `${key}=${value}\n`)
    .join("");
}

function current(a: Account): string {
  return readlinkSync(`${a.dir}/current`);
}

/** A snapshot's id from one of its files' names. */
function idOf(file: string | undefined): string {
  return (file ?? "").replace(/\.sql\.gz$|\.shared\.tar\.gz$/, "");
}

function dumpOf(a: Account, file: string): string {
  return gunzipSync(readFileSync(`${a.dir}/dumps/${file}`)).toString("utf8");
}

/** The names in the tar.gz `file` of `folder`, sorted, as bash's tar lists them. */
function tarNames(folder: string, file: string): string[] {
  const listed = spawnSync("bash", ["-c", 'cd "$1" && tar -tzf "$2"', "_", folder, file], {
    encoding: "utf8",
  });
  return listed.stdout.split("\n").filter(Boolean).sort();
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

/** The app's .htaccess part after OpsCrew's block. */
function afterBlock(htaccess: string | undefined): string {
  const end = "# END OpsCrew\n";
  return (htaccess ?? "").slice((htaccess ?? "").indexOf(end) + end.length);
}

const APP_HTACCESS = laravelRelease("x")["public/.htaccess"];

describe.skipIf(reason !== undefined)("the hosting agent", { timeout: 180_000 }, () => {
  it("makes its deploy key and the report on its first run, and a placeholder release", () => {
    const a = account();
    writeFileSync(`${a.stub}/no-22`, "");
    const first = a.run();
    expect(first.status).toBe(0);
    const report = a.keyValues("state/report");
    expect(report.public_key).toBe(a.file("keys/github.pub")?.trim());
    expect(report.public_key).toMatch(/^ssh-ed25519 \S+ opscrew-notes-prod$/);
    expect(existsSync(`${a.dir}/keys/github`)).toBe(true);
    expect(report).toEqual({
      public_key: report.public_key,
      "php.1.path": `${a.phpRoot}/usr/local/bin/php`,
      "php.1.version": "PHP 7.0.33 (cli) (built: Oct 30 2026 10:00:00) ( NTS )",
      "php.1.modules": "Core,ctype,pdo_mysql,Zend OPcache",
      "php.2.path": `${a.phpRoot}/opt/alt/php85/usr/bin/php`,
      "php.2.version": "PHP 8.5.12 (cli) (built: Oct 30 2026 10:00:00) ( NTS )",
      "php.2.modules": "Core,ctype,pdo_mysql,Zend OPcache",
      "tool.git": "yes",
      "tool.openssl": "yes",
      "tool.flock": "yes",
      "tool.mysqldump": "yes",
      "tool.tar": "yes",
      "tool.curl": "yes",
      "tool.ssh": "yes",
      "tool.ssh-keygen": "yes",
      "github.22": "no",
      "github.443": "yes",
    });
    const ssh = a.stubFile("ssh.log");
    expect(ssh).toContain(" -o IdentitiesOnly=yes ");
    expect(ssh).toContain("-F /dev/null");
    expect(ssh).toContain("UserKnownHostsFile=");
    expect(ssh).toContain("-p 443 -T git@ssh.github.com");
    expect(existsSync(`${a.dir}/releases/0-0/public`)).toBe(true);
    if (CAN_LINK) expect(current(a)).toBe("releases/0-0");
    if (POSIX) {
      for (const folder of ["keys", "state", "requests", "dumps"])
        expect(mode(`${a.dir}/${folder}`)).toBe(0o700);
      for (const folder of [".", "releases", "shared"])
        expect(mode(`${a.dir}/${folder}`)).toBe(0o711);
    }

    const second = a.run();
    expect(second.output).toBe("");
    expect(a.keyValues("state/report")).toEqual(report);
  });

  switching(
    "deploys a signed release: the switch, the restart, the purge file and the status",
    () => {
      const a = account({ phpHandler: "application/x-httpd-alt-php85___lsphp" }, { envPhp: true });
      a.run();
      const commit = a.publish(laravelRelease("one"), { run: 101 });
      const run = a.run();
      expect(run.status).toBe(0);
      expect(run.output).toContain("Deploying release 101-1");
      expect(run.output).toContain("Release 101-1 serves.");
      expect(current(a)).toBe("releases/101-1");
      expect(a.releases()).toEqual(["101-1"]);
      expect(existsSync(`${a.home}/.lsphp_restart.txt`)).toBe(true);
      const purges = a.stubFile("purges").trim().split("\n");
      expect(purges).toEqual([expect.stringMatching(/^there \/opscrew-purge-[0-9a-f]{32}\.php$/)]);
      expect(
        readdirSync(`${a.dir}/releases/101-1/public`).filter((f) => f.includes("purge")),
      ).toEqual([]);
      expect(a.keyValues("state/status")).toEqual({
        running: "101-1",
        previous: "",
        kept: "",
        attempt: "101-1",
        result: "deployed",
        reason: "",
        at: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/),
      });
      expect(a.file("state/last")).toBe("101-1\n");
      expect(a.file("state/commit")).toBe(`${commit}\n`);

      // The shared paths are links into shared/, storage moved there from the first release.
      expect(readlinkSync(`${a.dir}/releases/101-1/.env`)).toBe("../../shared/.env");
      expect(readlinkSync(`${a.dir}/releases/101-1/storage`)).toBe("../../shared/storage");
      expect(existsSync(`${a.dir}/shared/storage/logs/.gitignore`)).toBe(true);

      // Laravel's caches, then the release command, with the chosen PHP and the app's settings.
      const calls = a
        .stubFile("php.log")
        .split("\n")
        .filter((line) => line.includes("artisan"));
      expect(calls).toEqual([
        expect.stringMatching(
          /^php -d auto_prepend_file=\S+\/notes-prod\/shared\/env\.php artisan optimize in 101-1$/,
        ),
        expect.stringMatching(/artisan migrate --force in 101-1$/),
      ]);
      expect(a.stubFile("db")).toBe("state=one\n");
      if (POSIX) expect(mode(`${a.dir}/releases/101-1/bootstrap/cache/config.php`)).toBe(0o600);

      const htaccess = a.file("releases/101-1/public/.htaccess") ?? "";
      expect(
        htaccess.startsWith(
          "# BEGIN OpsCrew\nRewriteEngine On\nRewriteCond %{HTTP_HOST} !^notes\\.example\\.com(:[0-9]+)?$ [NC]\nRewriteRule ^ - [F]\nOptions -Indexes\n",
        ),
      ).toBe(true);
      expect(htaccess).toContain('<FilesMatch "^\\.">\nRequire all denied\n</FilesMatch>\n');
      expect(htaccess).toContain('Header always set X-OpsCrew-Release "101-1"\n');
      expect(htaccess).toContain("AddHandler application/x-httpd-alt-php85___lsphp .php\n");
      for (const module of ["LiteSpeed", "lsapi_module", "php_module"]) {
        expect(htaccess).toMatch(
          new RegExp(
            `<IfModule ${module}>\\nphp_value auto_prepend_file "\\S+/shared/env\\.php"\\n</IfModule>\\n`,
          ),
        );
      }
      expect(htaccess).not.toContain("HTTPS");
      expect(htaccess).not.toContain("Strict-Transport-Security");
      expect(afterBlock(htaccess)).toBe(
        `# BEGIN OpsCrew: app\n${APP_HTACCESS}# END OpsCrew: app\n`,
      );
      expect(a.file("releases/101-1/public/.user.ini")).toMatch(
        /^; BEGIN OpsCrew\nauto_prepend_file = "\S+\/shared\/env\.php"\n; END OpsCrew\n$/,
      );

      // A run with nothing new does nothing.
      const status = a.file("state/status");
      expect(a.run().output).toBe("");
      expect(a.file("state/status")).toBe(status);
    },
  );

  switching("deploys a static site served from the release itself, without touching PHP", () => {
    const a = account({
      appKind: "static",
      releaseBranch: "opscrew/release/site-prod",
      webRoot: ".",
      phpCli: undefined,
      releaseCommand: undefined,
      sharedPaths: [],
      database: undefined,
    });
    a.run();
    a.publish(
      { "index.html": "<h1>Site</h1>\n", ".htaccess": "ErrorDocument 404 /404.html\n" },
      { run: 901 },
    );
    expect(a.run().output).toContain("Release 901-1 serves.");
    expect(existsSync(`${a.home}/.lsphp_restart.txt`)).toBe(false);
    expect(a.stubFile("purges")).toBe("");
    const htaccess = a.file("releases/901-1/.htaccess");
    expect(htaccess).toContain(
      "RewriteRule ^(vendor|storage|composer\\.json|composer\\.lock)(/|$) - [F]\n",
    );
    expect(htaccess).not.toContain("auto_prepend_file");
    expect(afterBlock(htaccess)).toBe(
      "# BEGIN OpsCrew: app\nErrorDocument 404 /404.html\n# END OpsCrew: app\n",
    );
    expect(a.file("releases/901-1/.user.ini")).toBeUndefined();
  });

  switching(
    "forces HTTPS in the same run when the certificate verifies by the end of the deploy",
    () => {
      // The release command makes the certificate verify: after the run's first check, before the switch.
      const a = account({
        appKind: "static",
        releaseBranch: "opscrew/release/site-prod",
        webRoot: ".",
        phpCli: undefined,
        releaseCommand: 'touch "$STUB/certificate"',
        sharedPaths: [],
        database: undefined,
      });
      a.run();
      a.publish({ "index.html": "<h1>Site</h1>\n" }, { run: 901 });
      const run = a.run().output;
      expect(run).toContain("Release 901-1 serves.");
      expect(run).toContain(
        "The certificate on notes.example.com verifies: HTTPS is forced from now on.",
      );
      expect(run.indexOf("Release 901-1 serves.")).toBeLessThan(run.indexOf("HTTPS is forced"));
      expect(existsSync(`${a.dir}/state/https`)).toBe(true);
      expect(a.file("releases/901-1/.htaccess")).toContain(
        "RewriteCond %{HTTPS} !=on\nRewriteRule ^ https://notes.example.com%{REQUEST_URI} [R=301,L]\n",
      );
    },
  );

  it("refuses a release signed with another key or for another environment, and switches nothing", () => {
    const a = account();
    a.run();
    mkdirSync(`${a.root}/other`);
    const other = releaseKeyPair(`${a.root}/other`, "other");
    a.publish(laravelRelease("forged"), { run: 200, key: other.key });
    let run = a.run();
    expect(run.output).toContain(
      "Refused release 200-1: it isn't signed by this environment's release key.",
    );
    expect(a.keyValues("state/status")).toMatchObject({
      running: "",
      attempt: "200-1",
      result: "refused",
    });
    expect(a.releases()).toEqual(["0-0"]);
    expect(a.file("state/last")).toBeUndefined();
    expect(a.run().output).toBe("");

    a.publish(laravelRelease("staging"), { run: 201, env: "staging" });
    run = a.run();
    expect(run.output).toContain(
      "Refused release 201-1: it was signed for the staging environment, not prod.",
    );
    expect(a.releases()).toEqual(["0-0"]);
    expect(a.stubFile("php.log")).not.toContain("artisan");
    if (CAN_LINK) expect(current(a)).toBe("releases/0-0");
  });

  it("runs no PHP release command before provision chose the app's PHP (T2711)", () => {
    const a = account({ phpCli: undefined });
    a.run();
    a.publish(laravelRelease("two"), { run: 310 });
    const run = a.run();
    expect(run.output).toContain(
      "Release 310-1 failed: no PHP CLI is chosen for the app yet, so its release command can't run (run opscrew provision). The running release is untouched.",
    );
    expect(a.releases()).toEqual(["0-0"]);
    expect(a.stubFile("php.log")).not.toContain("artisan");
  });

  it("leaves the running release untouched when the release command fails, and refuses older releases after it", () => {
    const a = account();
    a.run();
    a.publish(laravelRelease("two", { "fail-migrate": "" }), { run: 300 });
    let run = a.run();
    expect(run.output).toContain(
      "Release 300-1 failed: the release command failed. The running release is untouched.",
    );
    expect(a.releases()).toEqual(["0-0"]);
    expect(a.keyValues("state/status")).toMatchObject({
      running: "",
      attempt: "300-1",
      result: "failed",
      reason: "the release command failed; the running release is untouched",
    });
    expect(a.file("state/last")).toBe("300-1\n");
    expect(existsSync(`${a.home}/.lsphp_restart.txt`)).toBe(false);
    if (CAN_LINK) expect(current(a)).toBe("releases/0-0");

    a.publish(laravelRelease("one"), { run: 299 });
    run = a.run();
    expect(run.output).toContain(
      "Refused release 299-1: it isn't newer than release 300-1, the last one attempted: an old release pushed again.",
    );
    a.publish(laravelRelease("two again"), { run: 300 });
    expect(a.run().output).toContain("Refused release 300-1: it isn't newer than release 300-1");
    expect(a.releases()).toEqual(["0-0"]);

    if (CAN_LINK) {
      a.publish(laravelRelease("two fixed"), { run: 300, attempt: 2 });
      expect(a.run().output).toContain("Release 300-2 serves.");
    }
  });

  switching("switches back when the new release doesn't answer", () => {
    const a = account();
    a.run();
    a.publish(laravelRelease("one"), { run: 401 });
    a.run();
    a.publish(laravelRelease("two", { "public/health-status": "500" }), { run: 402 });
    const run = a.run();
    expect(run.output).toContain(
      "Release 402-1 failed its check (it answered 500 with release 402-1): switched back to 401-1.",
    );
    expect(current(a)).toBe("releases/401-1");
    expect(a.releases()).toEqual(["401-1"]);
    expect(a.keyValues("state/status")).toMatchObject({
      running: "401-1",
      attempt: "402-1",
      result: "failed",
      reason:
        "http://notes.example.com/ didn't answer 2xx or 3xx with it (it answered 500 with release 402-1); switched back to 401-1",
    });
    expect(a.stubFile("sleep.log").trim().split("\n")).toHaveLength(25);
    expect(dumpOf(a, "401-1.sql.gz")).toContain("state=one");
    expect(a.stubFile("purges").trim().split("\n")).toHaveLength(3);
  });

  switching(
    "carries the panel's blocks byte for byte, and forces HTTPS once the certificate verifies",
    () => {
      const a = account();
      a.run();
      // cPanel writes into a new document root through current, so into the placeholder.
      const cpanel =
        "# BEGIN cPanel-generated php ini directives, do not edit\n<IfModule lsapi_module>\n   php_flag display_errors Off  \n</IfModule>\n# END cPanel-generated php ini directives, do not edit\n";
      const served = `${a.dir}/current/public`;
      writeFileSync(`${served}/.htaccess`, cpanel);
      writeFileSync(
        `${served}/.user.ini`,
        "; cPanel-generated php ini directives, do not edit\ndisplay_errors = Off\n",
      );
      writeFileSync(`${served}/php.ini`, "display_errors = Off\r\n");
      mkdirSync(`${served}/.well-known/acme-challenge`, { recursive: true });
      writeFileSync(`${served}/.well-known/acme-challenge/token`, "proof");
      writeFileSync(`${served}/.well-known/security.txt`, "Contact: placeholder\n");
      a.publish(laravelRelease("one"), { run: 501 });
      a.run();
      let htaccess = a.file("releases/501-1/public/.htaccess");
      expect(afterBlock(htaccess)).toBe(
        `${cpanel}# BEGIN OpsCrew: app\n${APP_HTACCESS}# END OpsCrew: app\n`,
      );
      expect(a.file("releases/501-1/public/.user.ini")).toBe(
        "; cPanel-generated php ini directives, do not edit\ndisplay_errors = Off\n",
      );
      expect(a.file("releases/501-1/public/php.ini")).toBe("display_errors = Off\r\n");
      expect(a.file("releases/501-1/public/.well-known/acme-challenge/token")).toBe("proof");
      expect(a.file("releases/501-1/public/.well-known/security.txt")).toBeUndefined();

      // The selector adds its block to the running release, last and without a final newline.
      const selector =
        '# DO NOT REMOVE. CLOUDLINUX PASSENGER CONFIGURATION BEGIN\nPassengerAppRoot "/home/acct/app"\n# DO NOT REMOVE. CLOUDLINUX PASSENGER CONFIGURATION END';
      writeFileSync(`${served}/.htaccess`, `${htaccess}${selector}`);

      writeFileSync(`${a.stub}/certificate`, "");
      expect(a.run().output).toContain(
        "The certificate on notes.example.com verifies: HTTPS is forced from now on.",
      );
      htaccess = a.file("releases/501-1/public/.htaccess") ?? "";
      expect(htaccess).toContain(
        "RewriteRule ^ - [F]\nRewriteCond %{HTTPS} !=on\nRewriteRule ^ https://notes.example.com%{REQUEST_URI} [R=301,L]\n",
      );
      expect(htaccess).toContain(
        'Header always set Strict-Transport-Security "max-age=31536000; includeSubDomains"\n',
      );
      expect(afterBlock(htaccess)).toBe(
        `${cpanel}# BEGIN OpsCrew: app\n${APP_HTACCESS}# END OpsCrew: app\n${selector}`,
      );

      // The app's own php.ini, .user.ini and .well-known files win over the panel's.
      const own = {
        "public/php.ini": "memory_limit = 256M\n",
        "public/.user.ini": "max_execution_time = 60\n",
        "public/.well-known/security.txt": "Contact: mailto:security@example.com\n",
      };
      a.publish(laravelRelease("two", own), { run: 502 });
      expect(a.run().output).toContain("Release 502-1 serves.");
      expect(a.file("releases/502-1/public/php.ini")).toBe(own["public/php.ini"]);
      expect(a.file("releases/502-1/public/.user.ini")).toBe(
        `; BEGIN OpsCrew: app\n${own["public/.user.ini"]}; END OpsCrew: app\n`,
      );
      expect(a.file("releases/502-1/public/.well-known/security.txt")).toBe(
        own["public/.well-known/security.txt"],
      );
      expect(a.file("releases/502-1/public/.well-known/acme-challenge/token")).toBe("proof");
      const next = a.file("releases/502-1/public/.htaccess") ?? "";
      expect(next).toContain("RewriteCond %{HTTPS} !=on\n");
      expect(next).toContain('Header always set X-OpsCrew-Release "502-1"\n');
      expect(afterBlock(next)).toBe(
        `${cpanel}${selector}\n# BEGIN OpsCrew: app\n${APP_HTACCESS}# END OpsCrew: app\n`,
      );
      expect(a.stubFile("curl.log")).toContain("curl https://notes.example.com/\n");
    },
  );

  switching(
    "keeps the newest releases besides the running one, and the dumps filed under them",
    () => {
      const a = account({ keep: 2 });
      a.run();
      for (const run of [801, 802, 803, 804, 805]) {
        a.publish(laravelRelease(`r${run}`), { run });
        expect(a.run().output).toContain(`Release ${run}-1 serves.`);
      }
      expect(a.releases()).toEqual(["803-1", "804-1", "805-1"]);
      expect(current(a)).toBe("releases/805-1");
      expect(readdirSync(`${a.dir}/dumps`).sort()).toEqual(["803-1.sql.gz", "804-1.sql.gz"]);
      expect(dumpOf(a, "804-1.sql.gz")).toContain("state=r804");
      expect(a.keyValues("state/status")).toMatchObject({
        running: "805-1",
        previous: "804-1",
        kept: "804-1,803-1",
      });
    },
  );

  switching(
    "rolls back on a request, restoring the target's dump after dumping the current database",
    () => {
      const a = account();
      a.run();
      a.publish(laravelRelease("one"), { run: 601 });
      a.run();
      a.publish(laravelRelease("two"), { run: 602 });
      a.run();
      expect(a.keyValues("state/status")).toMatchObject({
        running: "602-1",
        previous: "601-1",
        kept: "601-1",
      });
      const text = requestText({ kind: "rollback", release: "601-1", restore: "yes" });
      const name = a.request(text);
      a.run();
      expect(a.keyValues(`state/${name}.result`)).toEqual({ result: "done" });
      expect(current(a)).toBe("releases/601-1");
      expect(a.stubFile("db")).toBe("state=one\n");
      expect(dumpOf(a, "602-1.sql.gz")).toContain("state=two");
      expect(a.file("releases/601-1/public/.htaccess")).toContain('X-OpsCrew-Release "601-1"');
      expect(a.keyValues("state/status")).toMatchObject({
        running: "601-1",
        previous: "",
        kept: "602-1",
        attempt: "602-1",
        result: "deployed",
      });
      expect(existsSync(`${a.dir}/requests/${name}.req`)).toBe(false);
      expect(a.stubFile("php.log").match(/artisan migrate/g)).toHaveLength(2);

      // Carried out once: the same request again is removed, not carried out.
      a.request(text);
      expect(a.run().output).toBe("");
      expect(existsSync(`${a.dir}/requests/${name}.req`)).toBe(false);

      const missing = a.request(requestText({ kind: "rollback", release: "600-1", restore: "no" }));
      a.run();
      expect(a.keyValues(`state/${missing}.result`)).toEqual({
        result: "refused",
        reason: "release 600-1 isn't kept on the account",
      });
    },
  );

  switching(
    "applies a settings change on a request: .env.next into place, Laravel's config cache, the restart",
    () => {
      const a = account();
      a.run();
      a.publish(laravelRelease("one"), { run: 701 });
      a.run();
      rmSync(`${a.home}/.lsphp_restart.txt`);
      writeFileSync(`${a.dir}/shared/.env.next`, "APP_NAME=notes2\n");
      const name = a.request(requestText({ kind: "env" }));
      a.run();
      expect(a.keyValues(`state/${name}.result`)).toEqual({ result: "done" });
      expect(a.file("shared/.env")).toBe("APP_NAME=notes2\n");
      expect(existsSync(`${a.dir}/shared/.env.next`)).toBe(false);
      expect(a.stubFile("php.log")).toMatch(/artisan config:cache in current\n/);
      if (POSIX) {
        expect(mode(`${a.dir}/shared/.env`)).toBe(0o600);
        expect(mode(`${a.dir}/current/bootstrap/cache/config.php`)).toBe(0o600);
      }
      expect(existsSync(`${a.home}/.lsphp_restart.txt`)).toBe(true);

      const again = a.request(requestText({ kind: "env" }, Math.floor(Date.now() / 1000) + 1700));
      a.run();
      expect(a.keyValues(`state/${again}.result`)).toEqual({
        result: "refused",
        reason: "shared/.env.next isn't there",
      });
    },
  );

  it("refuses a commit with two OpsCrew-Release lines, one with a fifth field, or none", () => {
    const a = account();
    a.run();
    const shapes: [run: number, lines: (trailer: string) => string[]][] = [
      [210, (trailer) => [trailer, trailer]],
      [211, (trailer) => [`${trailer} extra`]],
      [212, () => []],
    ];
    for (const [run, lines] of shapes) {
      const commit = a.publish(laravelRelease(`r${run}`), { run, lines });
      expect(a.run().output).toContain(
        `Refused release ${commit}: its commit has no single OpsCrew-Release line.`,
      );
    }
    expect(a.releases()).toEqual(["0-0"]);
    expect(a.file("state/last")).toBeUndefined();
  });

  it("puts the database back when a restore fails", () => {
    const a = account();
    a.run();
    writeFileSync(`${a.stub}/db`, "state=before\n");
    const snapshot = a.request(requestText({ kind: "snapshot" }));
    a.run();
    const taken = a.keyValues(`state/${snapshot}.result`);
    // shared/ held only the settings files: the snapshot is the dump alone.
    expect(taken).toEqual({ result: "done", dump: expect.stringMatching(/\.sql\.gz$/) });
    expect(readdirSync(`${a.dir}/dumps`)).toEqual([taken.dump]);
    writeFileSync(`${a.stub}/db`, "state=after\n");
    writeFileSync(`${a.stub}/refuse`, "state=before");
    mkdirSync(`${a.dir}/shared/storage`);
    writeFileSync(`${a.dir}/shared/storage/upload.txt`, "after");
    const restore = a.request(requestText({ kind: "restore", snapshot: idOf(taken.dump) }));
    a.run();
    expect(a.keyValues(`state/${restore}.result`)).toEqual({
      result: "failed",
      reason: "the restore failed: the database is back as it was",
      saved: expect.stringMatching(/^snapshot-\d{8}T\d{6}Z(-\d+)?$/),
    });
    expect(a.stubFile("db")).toBe("state=after\n");
    expect(a.file("shared/storage/upload.txt")).toBe("after");
  });

  it("puts the database and the shared files back when unpacking the shared files fails", () => {
    const a = account();
    a.run();
    writeFileSync(`${a.stub}/db`, "state=before\n");
    mkdirSync(`${a.dir}/shared/storage`);
    writeFileSync(`${a.dir}/shared/storage/upload.txt`, "before");
    const snapshot = a.request(requestText({ kind: "snapshot" }));
    a.run();
    const taken = a.keyValues(`state/${snapshot}.result`);
    writeFileSync(`${a.dir}/dumps/${taken.shared}`, "not a tar");
    writeFileSync(`${a.stub}/db`, "state=after\n");
    writeFileSync(`${a.dir}/shared/storage/upload.txt`, "after");
    const restore = a.request(requestText({ kind: "restore", snapshot: idOf(taken.dump) }));
    a.run();
    expect(a.keyValues(`state/${restore}.result`)).toEqual({
      result: "failed",
      reason:
        "putting the shared files back failed: the database and the shared files are back as they were",
      saved: expect.stringMatching(/^snapshot-\S+$/),
    });
    expect(a.stubFile("db")).toBe("state=after\n");
    expect(a.file("shared/storage/upload.txt")).toBe("after");
  });

  switching(
    "keeps the running release and puts the database back when a rollback's restore fails",
    () => {
      const a = account();
      a.run();
      a.publish(laravelRelease("one"), { run: 611 });
      a.run();
      a.publish(laravelRelease("two"), { run: 612 });
      a.run();
      writeFileSync(`${a.stub}/refuse`, "state=one");
      const name = a.request(requestText({ kind: "rollback", release: "611-1", restore: "yes" }));
      a.run();
      expect(a.keyValues(`state/${name}.result`)).toEqual({
        result: "failed",
        reason:
          "restoring release 611-1's dump failed: the database is back as it was, and release 612-1 still runs",
      });
      expect(current(a)).toBe("releases/612-1");
      expect(a.stubFile("db")).toBe("state=two\n");
    },
  );

  switching("never carries out a request twice, even when a run stops part-way through it", () => {
    const a = account();
    a.run();
    a.publish(laravelRelease("one"), { run: 621 });
    a.run();
    a.publish(laravelRelease("two"), { run: 622 });
    a.run();
    // The rollback's carry-over stops the run: a file stands where the target's .well-known goes.
    mkdirSync(`${a.dir}/current/public/.well-known/acme-challenge`, { recursive: true });
    writeFileSync(`${a.dir}/releases/621-1/public/.well-known`, "");
    const name = a.request(requestText({ kind: "rollback", release: "621-1", restore: "yes" }));
    expect(a.run().status).not.toBe(0);
    expect(a.keyValues(`state/${name}.result`)).toEqual({
      result: "failed",
      reason: "the agent stopped while carrying it out",
    });
    const dumps = a.stubFile("mysql.log").match(/^mysqldump /gm)?.length;
    expect(dumps).toBe(2);

    expect(a.run().status).toBe(0);
    expect(a.stubFile("mysql.log").match(/^mysqldump /gm)?.length).toBe(dumps);
    expect(existsSync(`${a.dir}/requests/${name}.req`)).toBe(false);
    expect(current(a)).toBe("releases/622-1");
  });

  switching("keeps Laravel's cached config 0600 when the release command caches it again", () => {
    const a = account({ releaseCommand: "php artisan migrate --force && php artisan optimize" });
    a.run();
    a.publish(laravelRelease("one"), { run: 631 });
    expect(a.run().output).toContain("Release 631-1 serves.");
    expect(a.stubFile("php.log").match(/artisan optimize in 631-1/g)).toHaveLength(2);
    if (POSIX) expect(mode(`${a.dir}/releases/631-1/bootstrap/cache/config.php`)).toBe(0o600);
  });

  // As root, a folder without write permission still takes the file, so this needs another user.
  it.skipIf(!CAN_LINK || process.getuid?.() === 0)(
    "switches back when the run stops after the switch",
    () => {
      const a = account();
      a.run();
      a.publish(laravelRelease("one"), { run: 641 });
      a.run();
      rmSync(`${a.home}/.lsphp_restart.txt`);
      // The restart file can't be written (the account's quota, for example).
      chmodSync(a.home, 0o555);
      try {
        a.publish(laravelRelease("two"), { run: 642 });
        expect(a.run().status).not.toBe(0);
        expect(current(a)).toBe("releases/641-1");
        expect(a.releases()).toEqual(["641-1"]);
        expect(a.keyValues("state/status")).toMatchObject({
          running: "641-1",
          attempt: "642-1",
          result: "failed",
          reason: "the agent stopped while deploying it (exit 1), and 641-1 runs: see opscrew logs",
        });
      } finally {
        chmodSync(a.home, 0o755);
      }
    },
  );

  it("takes a snapshot of the database and the shared files, and restores one, on requests", () => {
    const a = account({}, { envPhp: true });
    a.run();
    writeFileSync(`${a.stub}/db`, "state=before\n");
    mkdirSync(`${a.dir}/shared/storage/app`, { recursive: true });
    writeFileSync(`${a.dir}/shared/storage/app/photo.txt`, "before");
    writeFileSync(`${a.dir}/shared/.env.next`, "APP_NAME=next\n");
    const snapshot = a.request(requestText({ kind: "snapshot" }));
    a.run();
    const taken = a.keyValues(`state/${snapshot}.result`);
    const id = idOf(taken.dump);
    expect(id).toMatch(/^snapshot-\d{8}T\d{6}Z$/);
    // The same name for the shared files' copy, without the settings files.
    const copy = `${id}.shared.tar.gz`;
    expect(taken).toEqual({ result: "done", dump: `${id}.sql.gz`, shared: copy });
    expect(dumpOf(a, taken.dump ?? "")).toContain("state=before");
    expect(a.stubFile("mysql.log")).toContain(
      "mysqldump --defaults-extra-file=shared/mysql.cnf --single-transaction --no-tablespaces acct_notes\n",
    );
    expect(readdirSync(`${a.dir}/dumps`).sort()).toEqual([taken.dump, copy].sort());
    expect(tarNames(`${a.dir}/dumps`, copy)).toEqual([
      "./storage/",
      "./storage/app/",
      "./storage/app/photo.txt",
    ]);
    if (POSIX) {
      expect(mode(`${a.dir}/dumps/${taken.dump}`)).toBe(0o600);
      expect(mode(`${a.dir}/dumps/${copy}`)).toBe(0o600);
    }

    writeFileSync(`${a.stub}/db`, "state=after\n");
    writeFileSync(`${a.dir}/shared/storage/app/photo.txt`, "after");
    writeFileSync(`${a.dir}/shared/storage/app/new.txt`, "new");
    writeFileSync(`${a.dir}/shared/.env`, "APP_NAME=changed\n");
    const restore = a.request(requestText({ kind: "restore", snapshot: id }));
    a.run();
    const restored = a.keyValues(`state/${restore}.result`);
    expect(restored).toEqual({ result: "done", saved: expect.stringMatching(/^snapshot-\S+$/) });
    expect(restored.saved).not.toBe(id);
    expect(a.stubFile("db")).toBe("state=before\n");
    expect(dumpOf(a, `${restored.saved}.sql.gz`)).toContain("state=after");
    // The shared files as they were, the settings files as they are now.
    expect(a.file("shared/storage/app/photo.txt")).toBe("before");
    expect(existsSync(`${a.dir}/shared/storage/app/new.txt`)).toBe(false);
    expect(a.file("shared/.env")).toBe("APP_NAME=changed\n");
    expect(a.file("shared/.env.next")).toBe("APP_NAME=next\n");
    expect(a.file("shared/mysql.cnf")).toBe("[client]\nuser=acct_notes\n");
    expect(a.file("shared/env.php")).toContain("<?php");
    expect(tarNames(`${a.dir}/dumps`, `${restored.saved}.shared.tar.gz`)).toContain(
      "./storage/app/new.txt",
    );

    const missing = a.request(requestText({ kind: "restore", snapshot: "nope" }));
    a.run();
    expect(a.keyValues(`state/${missing}.result`)).toEqual({
      result: "refused",
      reason: "the snapshot nope isn't in dumps/",
    });
  });

  it("snapshots and restores the shared files of an app without a database, and refuses one with neither", () => {
    const a = account({ database: undefined, snapshots: false });
    a.run();
    const none = a.request(requestText({ kind: "snapshot" }));
    a.run();
    expect(a.keyValues(`state/${none}.result`)).toEqual({
      result: "refused",
      reason: "this app has no database and no shared files besides its settings",
    });

    mkdirSync(`${a.dir}/shared/storage`);
    writeFileSync(`${a.dir}/shared/storage/upload.txt`, "before");
    // Another expiry than the first request's, so another name within the same second.
    const later = Math.floor(Date.now() / 1000) + 1801;
    const snapshot = a.request(requestText({ kind: "snapshot" }, later));
    a.run();
    const taken = a.keyValues(`state/${snapshot}.result`);
    expect(taken).toEqual({ result: "done", shared: expect.stringMatching(/\.shared\.tar\.gz$/) });
    expect(readdirSync(`${a.dir}/dumps`)).toEqual([taken.shared]);
    expect(a.stubFile("mysql.log")).toBe("");

    writeFileSync(`${a.dir}/shared/storage/upload.txt`, "after");
    const restore = a.request(requestText({ kind: "restore", snapshot: idOf(taken.shared) }));
    a.run();
    expect(a.keyValues(`state/${restore}.result`)).toEqual({
      result: "done",
      saved: expect.stringMatching(/^snapshot-\S+$/),
    });
    expect(a.file("shared/storage/upload.txt")).toBe("before");
    expect(a.stubFile("mysql.log")).toBe("");

    // A copy holding settings files never puts them back over the current ones.
    const old = `${a.root}/old-shared`;
    mkdirSync(`${old}/storage`, { recursive: true });
    for (const name of [".env", ".env.next", "env.php", "mysql.cnf"]) {
      writeFileSync(`${old}/${name}`, "old values\n");
    }
    writeFileSync(`${old}/storage/upload.txt`, "old");
    const made = spawnSync(
      "bash",
      [
        "-c",
        'cd "$2" && tar -czf old.shared.tar.gz -C "$1" ./.env ./.env.next ./env.php ./mysql.cnf ./storage',
        "_",
        old,
        `${a.dir}/dumps`,
      ],
      { encoding: "utf8" },
    );
    expect(made.status).toBe(0);
    const restoreOld = a.request(requestText({ kind: "restore", snapshot: "old" }));
    a.run();
    expect(a.keyValues(`state/${restoreOld}.result`)).toMatchObject({ result: "done" });
    expect(a.file("shared/storage/upload.txt")).toBe("old");
    expect(a.file("shared/.env")).toBe("APP_NAME=notes\n");
    expect(a.file("shared/mysql.cnf")).toBe("[client]\nuser=acct_notes\n");
    for (const name of [".env.next", "env.php"]) {
      expect(existsSync(`${a.dir}/shared/${name}`)).toBe(false);
    }

    // A database dump can't go back into an app without a database.
    writeFileSync(`${a.dir}/dumps/12-1.sql.gz`, "");
    const dump = a.request(requestText({ kind: "restore", snapshot: "12-1" }));
    a.run();
    expect(a.keyValues(`state/${dump}.result`)).toEqual({
      result: "refused",
      reason: "the snapshot 12-1 holds a database dump, and this app has no database",
    });
  });

  it("refuses an expired, altered or malformed request, and leaves other files alone", () => {
    const a = account();
    a.run();
    const results: Record<string, string> = {
      expired: a.request(requestText({ kind: "snapshot" }, Math.floor(Date.now() / 1000) - 10)),
      altered: a.request(
        requestText({ kind: "snapshot" }),
        createHash("sha256")
          .update(requestText({ kind: "env" }))
          .digest("hex"),
      ),
      notKeyValue: a.request(`kind=snapshot\nhash=${HASH}\nexpires=9999999999\nnote=$(id)\n`),
      twice: a.request(`kind=snapshot\nkind=env\nhash=${HASH}\nexpires=9999999999\n`),
      extraKey: a.request(requestText({ kind: "snapshot", command: "rm" })),
      missingKey: a.request(`kind=snapshot\nexpires=9999999999\n`),
      unknownKind: a.request(requestText({ kind: "shell" })),
      badRelease: a.request(requestText({ kind: "rollback", release: "../601-1", restore: "yes" })),
    };
    writeFileSync(`${a.dir}/requests/upload.tmp`, "kind=snapshot\n");
    a.run();
    const reasons = Object.fromEntries(
      Object.entries(results).map(([key, name]) => [key, a.keyValues(`state/${name}.result`)]),
    );
    expect(reasons).toEqual({
      expired: { result: "refused", reason: expect.stringMatching(/^it expired \(expires=\d+\)$/) },
      altered: {
        result: "refused",
        reason: "its content doesn't match its name: it changed after it was written",
      },
      notKeyValue: { result: "refused", reason: "line 4 isn't a key=value line OpsCrew writes" },
      twice: { result: "refused", reason: "the key kind is there twice" },
      extraKey: {
        result: "refused",
        reason: "the key command doesn't belong in a snapshot request",
      },
      missingKey: { result: "refused", reason: "the key hash is missing" },
      unknownKind: { result: "refused", reason: "the kind shell isn't one the agent carries out" },
      badRelease: { result: "refused", reason: "line 4 isn't a key=value line OpsCrew writes" },
    });
    expect(readdirSync(`${a.dir}/requests`)).toEqual(["upload.tmp"]);
    expect(a.stubFile("mysql.log")).toBe("");
  });

  it.skipIf(!HAS_FLOCK)("stops at once while another run holds the lock", async () => {
    const a = account();
    const holder = await a.holdLock();
    try {
      const run = a.run();
      expect(run.status).toBe(0);
      expect(run.output).toContain("Another run of the agent holds the lock: this one stops.");
      expect(a.file("state/report")).toBeUndefined();
    } finally {
      holder.kill();
    }
  });

  it("keeps its log to the last 1,000 lines", () => {
    const a = account();
    const lines = Array.from({ length: 1500 }, (_, i) => `line ${i + 1}\n`).join("");
    writeFileSync(`${a.dir}/state/agent.log`, lines);
    a.run();
    const log = (a.file("state/agent.log") ?? "").split("\n");
    expect(log[0]).toBe("line 501");
    expect(log.length).toBeLessThan(1010);
  });
});
