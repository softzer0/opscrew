import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { fakeSecret } from "@opscrew/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import { Account, agentSkipReason, CAN_LINK } from "./__fixtures__/account";
import type { AgentSettings } from "./agent";

/*
 * A Node.js or Python app through CloudLinux's selector (027 T2717): the agent run by bash, as in
 * agent-runs.test.ts, with a fake `cloudlinux-selector` first on the PATH. Cases that switch a
 * release need real symbolic links: they skip on Windows and run on Linux.
 */

const reason = agentSkipReason();
const switching = it.skipIf(!CAN_LINK);
const HASH = "cd".repeat(32);
const ROOT = "opscrew/notes-prod/current";

const NODE: Partial<AgentSettings> = {
  appKind: "node",
  webRoot: "public",
  phpCli: undefined,
  releaseCommand: undefined,
  sharedPaths: [".env"],
  snapshots: false,
  database: undefined,
  runtimeVersion: "22",
  startupFile: "index.js",
};

const PYTHON: Partial<AgentSettings> = {
  ...NODE,
  appKind: "python",
  runtimeVersion: "3.12",
  startupFile: "passenger_wsgi.py",
};

const accounts: Account[] = [];
afterEach(() => {
  for (const account of accounts.splice(0)) account.remove();
});

function account(settings: Partial<AgentSettings> = NODE): Account {
  const made = new Account(settings);
  accounts.push(made);
  return made;
}

/** An `app` request as the CLI writes it (or with `fields` instead), and its answer after a run. */
function app(a: Account, action: string, fields: Record<string, string> = { action }) {
  const expires = String(Math.floor(Date.now() / 1000) + 1800);
  const text = Object.entries({ kind: "app", hash: HASH, expires, ...fields })
    .map(([key, value]) => `${key}=${value}\n`)
    .join("");
  const name = a.request(text);
  a.run();
  return a.keyValues(`state/${name}.result`);
}

/** The selector's calls, one per line, without the package.json lines. */
function calls(a: Account): string[] {
  return a
    .stubFile("selector.log")
    .split("\n")
    .filter((line) => line.startsWith("cloudlinux-selector "));
}

const cacheFile = (a: Account) => `${a.home}/.cl.selector/htaccess_cache`;

function writeCache(a: Account, text: string): void {
  mkdirSync(`${a.home}/.cl.selector`, { recursive: true });
  writeFileSync(cacheFile(a), text);
}

const OTHER = "[/home/acct/blog]\napp_root = blog\n\n";
const LATER = "[/home/acct/shop]\napp_root = shop";

/** A Node.js release: its start file and package files. */
function nodeRelease(marker: string, lock = "1"): Record<string, string> {
  return {
    "index.js": `console.log("${marker}");\n`,
    "package.json": `{"name":"notes","version":"${marker}"}\n`,
    "package-lock.json": `{"lockfileVersion":3,"lock":"${lock}"}\n`,
  };
}

describe.skipIf(reason !== undefined)(
  "the hosting agent's selector apps",
  { timeout: 180_000 },
  () => {
    it("makes a Node.js app in the selector on an app request, and keeps its section's header", () => {
      const a = account();
      a.run();
      writeCache(a, OTHER);
      expect(app(a, "create")).toEqual({ result: "done" });
      expect(calls(a)).toEqual([
        `cloudlinux-selector create --json --interpreter nodejs --version 22 --app-root ${ROOT} --app-uri / --app-mode production --domain notes.example.com --startup-file index.js`,
        `cloudlinux-selector set --json --interpreter nodejs --app-root ${ROOT} --env-vars {"APP_NAME":"notes"}`,
      ]);
      // The home folder as bash names it (/d/… under Git for Windows).
      const header = a.file("state/selector-section") ?? "";
      expect(header).toMatch(/^\[\S+\/home\/opscrew\/notes-prod\/current\]\n$/);
      expect(readFileSync(cacheFile(a), "utf8")).toBe(`${OTHER}${header}app_root = ${ROOT}\n\n`);
    });

    it("makes a Python app without a mode, which its selector doesn't take", () => {
      const a = account(PYTHON);
      a.run();
      expect(app(a, "create")).toEqual({ result: "done" });
      expect(calls(a)).toEqual([
        `cloudlinux-selector create --json --interpreter python --version 3.12 --app-root ${ROOT} --app-uri / --domain notes.example.com --startup-file passenger_wsgi.py`,
        `cloudlinux-selector set --json --interpreter python --app-root ${ROOT} --env-vars {"APP_NAME":"notes"}`,
      ]);
    });

    it("hands the selector the app's settings on create and on each env request", () => {
      const a = account();
      a.run();
      // As provision writes them: bare, in single quotes, or in double quotes with escapes.
      writeFileSync(
        `${a.dir}/shared/.env`,
        [
          "APP_NAME=notes",
          `QUOTED='it is "x" \\ y'`,
          `ESCAPED="line1\\nline2 \\$HOME \\"q\\" \\\\ tab\\t"`,
          "",
        ].join("\n"),
      );
      expect(app(a, "create")).toEqual({ result: "done" });
      expect(JSON.parse(a.stubFile("env-vars"))).toEqual({
        APP_NAME: "notes",
        QUOTED: 'it is "x" \\ y',
        ESCAPED: 'line1\nline2 $HOME "q" \\ tab\t',
      });

      writeFileSync(`${a.dir}/shared/.env.next`, "APP_NAME=renamed\nNEW_KEY=1\n");
      const expires = Math.floor(Date.now() / 1000) + 1800;
      const env = (at: number) => a.request(`kind=env\nhash=${HASH}\nexpires=${at}\n`);
      const name = env(expires);
      a.run();
      expect(a.keyValues(`state/${name}.result`)).toEqual({ result: "done" });
      expect(JSON.parse(a.stubFile("env-vars"))).toEqual({ APP_NAME: "renamed", NEW_KEY: "1" });

      // A selector that doesn't take them: the answer says so.
      writeFileSync(`${a.stub}/selector-fails`, "set\n");
      writeFileSync(`${a.dir}/shared/.env.next`, "APP_NAME=again\n");
      const later = env(expires - 1);
      a.run();
      expect(a.keyValues(`state/${later}.result`)).toEqual({
        result: "failed",
        reason:
          "the settings changed, but CloudLinux's selector refused them, so the app's environment still holds the earlier ones (the app's own file has the new ones)",
      });
    });

    it("answers done with a note when the selector made the app but refused its settings, never repeating them", () => {
      const a = account();
      a.run();
      const secret = fakeSecret("generic-password", "selector-env");
      writeFileSync(`${a.dir}/shared/.env`, `API_KEY=${secret}\n`);
      writeFileSync(`${a.stub}/selector-fails`, "set\n");
      expect(app(a, "create")).toEqual({
        result: "done",
        note: "CloudLinux's selector made the app but refused its settings, so the app gets them only from its .env file until a settings change hands them over again",
      });
      // The selector's refusal repeated the values; the agent passes none of it on.
      expect(a.stubFile("selector.log")).toContain(secret);
      writeFileSync(`${a.dir}/shared/.env.next`, `API_KEY=${secret}x\n`);
      const expires = Math.floor(Date.now() / 1000) + 1800;
      const name = a.request(`kind=env\nhash=${HASH}\nexpires=${expires}\n`);
      a.run();
      expect(a.keyValues(`state/${name}.result`).result).toBe("failed");
      const said = readdirSync(`${a.dir}/state`)
        .filter((file) => file.endsWith(".result") || file === "agent.log" || file === "status")
        .map((file) => readFileSync(`${a.dir}/state/${file}`, "utf8"));
      expect(said.length).toBeGreaterThan(2);
      for (const text of said) expect(text).not.toContain(secret);
    });

    it("puts back the running release's package files a stopped install left aside", () => {
      const a = account();
      a.run();
      // As a run killed part-way through an install leaves them: one file put aside, one marked as
      // missing from the running release, the other release's copies in its place.
      mkdirSync(`${a.dir}/state/packages`);
      writeFileSync(`${a.dir}/state/packages/package.json`, "running's own\n");
      writeFileSync(`${a.dir}/state/packages/package-lock.json.none`, "");
      writeFileSync(`${a.dir}/current/package.json`, "the other release's\n");
      writeFileSync(`${a.dir}/current/package-lock.json`, "the other release's\n");
      expect(a.run().status).toBe(0);
      expect(a.file("current/package.json")).toBe("running's own\n");
      expect(existsSync(`${a.dir}/current/package-lock.json`)).toBe(false);
      expect(existsSync(`${a.dir}/state/packages`)).toBe(false);
    });

    it("answers failed with the selector's answer when it can't make the app", () => {
      const a = account();
      a.run();
      writeFileSync(`${a.stub}/selector-fails`, "create\n");
      expect(app(a, "create")).toEqual({
        result: "failed",
        reason:
          'CloudLinux\'s selector didn\'t make the app: {"result": "Something went wrong in the fake selector"}',
      });
      expect(a.file("state/selector-section")).toBeUndefined();
    });

    it("refuses an app request for a PHP app, or with another action", () => {
      const php = account({});
      php.run();
      expect(app(php, "create")).toEqual({
        result: "refused",
        reason: "this app isn't a Node.js or Python app, which CloudLinux's selector runs",
      });
      const node = account();
      node.run();
      expect(app(node, "restart")).toEqual({
        result: "refused",
        reason: "action isn't create or destroy",
      });
      expect(app(node, "", {})).toEqual({ result: "refused", reason: "the key action is missing" });
      expect(calls(php)).toEqual([]);
      expect(calls(node)).toEqual([]);
    });

    it("removes the app, its empty environment folder and only its section of htaccess_cache", () => {
      const a = account();
      a.run();
      writeCache(a, OTHER);
      app(a, "create");
      // Another app the user made later, its section after OpsCrew's, the file without a last newline.
      writeFileSync(cacheFile(a), `${readFileSync(cacheFile(a), "utf8")}${LATER}`);
      mkdirSync(`${a.home}/nodevenv/blog/20`, { recursive: true });

      expect(app(a, "destroy")).toEqual({ result: "done" });
      expect(calls(a)[2]).toBe(
        `cloudlinux-selector destroy --json --interpreter nodejs --app-root ${ROOT}`,
      );
      expect(readFileSync(cacheFile(a), "utf8")).toBe(`${OTHER}${LATER}`);
      expect(existsSync(`${a.home}/nodevenv/opscrew`)).toBe(false);
      expect(existsSync(`${a.home}/nodevenv/blog/20`)).toBe(true);
      expect(a.file("state/selector-section")).toBeUndefined();
    });

    it("leaves htaccess_cache as it is when the selector added no section to it", () => {
      const a = account();
      a.run();
      // The section the selector writes is there already, so making the app adds none.
      const home = spawnSync("bash", ["-c", 'cd "$1" && pwd', "_", a.home], { encoding: "utf8" });
      writeCache(a, `${OTHER}[${home.stdout.trim()}/${ROOT}]\napp_root = old\n\n`);
      app(a, "create");
      expect(a.file("state/selector-section")).toBe("");
      const cache = readFileSync(cacheFile(a), "utf8");
      expect(app(a, "destroy")).toEqual({
        result: "done",
        note: "~/.cl.selector/htaccess_cache stays as it is: the selector added no section, or more than one, to it when it made the app, so OpsCrew can't tell which is the app's",
      });
      expect(readFileSync(cacheFile(a), "utf8")).toBe(cache);
    });

    it("leaves htaccess_cache and a folder that isn't empty as they are, and says so", () => {
      const a = account(PYTHON);
      a.run();
      app(a, "create");
      const header = (a.file("state/selector-section") ?? "").trim();
      const cache = `${readFileSync(cacheFile(a), "utf8")}${header}\napp_root = copy\n`;
      writeFileSync(cacheFile(a), cache);
      // A file the fake destroy leaves (its glob skips dotfiles).
      writeFileSync(`${a.home}/virtualenv/${ROOT}/.notes`, "the user's");
      const before = createHash("sha256").update(cache).digest("hex");

      expect(app(a, "destroy")).toEqual({
        result: "done",
        note: `~/virtualenv/${ROOT} isn't empty, so it stays; ~/.cl.selector/htaccess_cache stays as it is: the app's section ${header} is in it more than once, so OpsCrew can't tell which is the app's`,
      });
      const after = createHash("sha256")
        .update(readFileSync(cacheFile(a)))
        .digest("hex");
      expect(after).toBe(before);
    });

    it("answers failed when the selector can't remove the app, and changes nothing else", () => {
      const a = account();
      a.run();
      app(a, "create");
      const cache = readFileSync(cacheFile(a), "utf8");
      writeFileSync(`${a.stub}/selector-fails`, "destroy\n");
      expect(app(a, "destroy")).toMatchObject({ result: "failed" });
      expect(readFileSync(cacheFile(a), "utf8")).toBe(cache);
      expect(existsSync(`${a.home}/nodevenv/${ROOT}/22`)).toBe(true);
    });

    switching(
      "carries the selector's link and block into each release, installing changed packages before the switch",
      () => {
        const a = account();
        a.run();
        app(a, "create");
        a.publish(nodeRelease("one"), { run: 101 });
        expect(a.run().output).toContain("Release 101-1 serves.");
        expect(readlinkSync(`${a.dir}/current`)).toBe("releases/101-1");
        // The packages of the release, installed while the running placeholder was the app root.
        expect(a.stubFile("selector.log")).toContain(
          `cloudlinux-selector install-modules --json --interpreter nodejs --app-root ${ROOT}\npackage.json: {"name":"notes","version":"one"}\n`,
        );
        expect(existsSync(`${a.dir}/releases/0-0/package.json`)).toBe(false);
        expect(readlinkSync(`${a.dir}/releases/101-1/node_modules`)).toBe(
          `${a.home}/nodevenv/${ROOT}/22/lib/node_modules`,
        );
        // The document root is the release's public/, made where the release has none; the app
        // root, the source in it and its settings file stay outside it.
        expect(a.file("releases/101-1/.htaccess")).toBeUndefined();
        expect(existsSync(`${a.dir}/releases/101-1/public/index.js`)).toBe(false);
        expect(readlinkSync(`${a.dir}/releases/101-1/.env`)).toBe("../../shared/.env");
        const htaccess = a.file("releases/101-1/public/.htaccess") ?? "";
        expect(htaccess).toContain('Header always set X-OpsCrew-Release "101-1"\n');
        expect(htaccess).toContain(
          `# END OpsCrew\n# DO NOT REMOVE. CLOUDLINUX PASSENGER CONFIGURATION BEGIN\nPassengerAppRoot "${a.home}/${ROOT}"\n# DO NOT REMOVE. CLOUDLINUX PASSENGER CONFIGURATION END\n`,
        );
        expect(existsSync(`${a.dir}/releases/101-1/tmp/restart.txt`)).toBe(true);
        expect(existsSync(`${a.home}/.lsphp_restart.txt`)).toBe(false);

        // The same packages: nothing to install.
        a.publish(nodeRelease("two"), { run: 102 });
        expect(a.run().output).toContain("Release 102-1 serves.");
        expect(calls(a).filter((line) => line.includes("install-modules"))).toHaveLength(2);
        expect(readlinkSync(`${a.dir}/releases/102-1/node_modules`)).toBe(
          `${a.home}/nodevenv/${ROOT}/22/lib/node_modules`,
        );
        expect(a.file("releases/102-1/public/.htaccess")).toContain("PassengerAppRoot");

        // A changed lockfile: installed before the switch, the running release's own files put back.
        a.publish(nodeRelease("three", "2"), { run: 103 });
        expect(a.run().output).toContain("Release 103-1 serves.");
        expect(a.stubFile("selector.log")).toContain(
          'package.json: {"name":"notes","version":"three"}',
        );
        expect(a.file("releases/102-1/package.json")).toBe('{"name":"notes","version":"two"}\n');
        expect(a.file("releases/102-1/package-lock.json")).toBe(
          '{"lockfileVersion":3,"lock":"1"}\n',
        );
      },
    );

    switching("keeps the running release when the selector can't install the packages", () => {
      const a = account();
      a.run();
      app(a, "create");
      a.publish(nodeRelease("one"), { run: 201 });
      a.run();
      writeFileSync(`${a.stub}/selector-fails`, "install-modules\n");
      a.publish(nodeRelease("two", "2"), { run: 202 });
      a.run();
      expect(readlinkSync(`${a.dir}/current`)).toBe("releases/201-1");
      expect(a.releases()).toEqual(["201-1"]);
      expect(a.file("releases/201-1/package.json")).toBe('{"name":"notes","version":"one"}\n');
      expect(a.keyValues("state/status")).toMatchObject({
        running: "201-1",
        attempt: "202-1",
        result: "failed",
        reason: `CloudLinux's selector couldn't install its packages ({"result": "Something went wrong in the fake selector"}), so the app's environment, which the running release shares, may have changed; the running release stays`,
      });
    });

    switching(
      "installs the running release's packages again when a release fails after installing its own",
      () => {
        const a = account({ ...NODE, releaseCommand: "test ! -f fail-me" });
        a.run();
        app(a, "create");
        a.publish(nodeRelease("one"), { run: 501 });
        a.run();
        const installed = () => a.stubFile("selector.log").match(/^package\.json: .*$/gm) ?? [];
        const one = 'package.json: {"name":"notes","version":"one"}';

        // Its release command fails: abandoned before the switch.
        a.publish({ ...nodeRelease("two", "2"), "fail-me": "" }, { run: 502 });
        a.run();
        expect(readlinkSync(`${a.dir}/current`)).toBe("releases/501-1");
        expect(installed().slice(-2)).toEqual([
          'package.json: {"name":"notes","version":"two"}',
          one,
        ]);
        expect(a.keyValues("state/status").reason).toBe(
          "the release command failed; the running release is untouched",
        );

        // Its check fails after the switch: switched back.
        a.publish({ ...nodeRelease("three", "3"), "public/health-status": "500" }, { run: 503 });
        a.run();
        expect(readlinkSync(`${a.dir}/current`)).toBe("releases/501-1");
        expect(installed().at(-1)).toBe(one);
        expect(a.keyValues("state/status").reason).toMatch(/; switched back to 501-1$/);

        // Installing the running release's packages again fails: the status says so.
        writeFileSync(`${a.stub}/install-fails-for`, '"version":"one"');
        a.publish({ ...nodeRelease("four", "4"), "public/health-status": "500" }, { run: 504 });
        a.run();
        expect(a.keyValues("state/status").reason).toMatch(
          /; switched back to 501-1; installing release 501-1's packages again failed too \(\{"result": "npm install failed"\}\), so the app's environment may hold the failed release's$/,
        );
      },
    );

    switching("installs a Python release's requirements from the release itself", () => {
      const a = account(PYTHON);
      a.run();
      app(a, "create");
      a.publish(
        { "passenger_wsgi.py": "application = None\n", "requirements.txt": "flask==3.1.0\n" },
        { run: 301 },
      );
      expect(a.run().output).toContain("Release 301-1 serves.");
      expect(calls(a)[2]).toBe(
        `cloudlinux-selector install-modules --json --interpreter python --app-root ${ROOT} --requirements-file ${a.dir}/releases/301-1/requirements.txt`,
      );
      expect(existsSync(`${a.dir}/releases/301-1/node_modules`)).toBe(false);
      expect(a.file("releases/301-1/public/.htaccess")).toContain("PassengerAppRoot");
    });

    switching("installs a rollback target's packages before switching back to it", () => {
      const a = account();
      a.run();
      app(a, "create");
      a.publish(nodeRelease("one"), { run: 401 });
      a.run();
      a.publish(nodeRelease("two", "2"), { run: 402 });
      a.run();
      const name = a.request(
        Object.entries({
          kind: "rollback",
          hash: HASH,
          expires: String(Math.floor(Date.now() / 1000) + 1800),
          release: "401-1",
          restore: "no",
        })
          .map(([key, value]) => `${key}=${value}\n`)
          .join(""),
      );
      a.run();
      expect(a.keyValues(`state/${name}.result`)).toEqual({ result: "done" });
      expect(readlinkSync(`${a.dir}/current`)).toBe("releases/401-1");
      const installs = a.stubFile("selector.log").match(/^package\.json: .*$/gm);
      expect(installs?.at(-1)).toBe('package.json: {"name":"notes","version":"one"}');
    });
  },
);
