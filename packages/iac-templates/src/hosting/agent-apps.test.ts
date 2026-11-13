import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { fakeSecret } from "@opscrew/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import { Account, agentSkipReason, CAN_LINK } from "./__fixtures__/account";
import type { AgentSettings } from "./agent";

/*
 * A Node.js or Python app through CloudLinux's selector (027 T2717, T2744): the agent run by bash,
 * as in agent-runs.test.ts, with a fake `cloudlinux-selector` first on the PATH, which resolves its
 * app root once as the real one does (research R14). Cases that switch a release need real
 * symbolic links: they skip on Windows and run on Linux.
 */

const reason = agentSkipReason();
const switching = it.skipIf(!CAN_LINK);
const HASH = "cd".repeat(32);
const ROOT = "opscrew/notes-prod/app";

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

/**
 * The selector's Passenger block for the Node.js app as the selector writes it (research R14): its
 * app root app/, its startup file through the link app/current.
 */
function passengerBlock(a: Account): string {
  return [
    "# DO NOT REMOVE. CLOUDLINUX PASSENGER CONFIGURATION BEGIN",
    `PassengerAppRoot "${a.home}/${ROOT}"`,
    `PassengerNodejs "${a.home}/nodevenv/${ROOT}/22/bin/node"`,
    "PassengerAppType node",
    "PassengerStartupFile current/index.js",
    'PassengerBaseURI "/"',
    "# DO NOT REMOVE. CLOUDLINUX PASSENGER CONFIGURATION END\n",
  ].join("\n");
}

/** Runs the fake selector itself with the account's environment, as a run of the agent would. */
function runSelector(a: Account, ...args: string[]) {
  return spawnSync("bash", [`${a.root}/bin/cloudlinux-selector`, ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: a.home, STUB: a.stub, APP_DIR: a.dir, SERVED: "public" },
  });
}

/** The PassengerAppRoot values in the served .htaccess of `release` (in the app's folder). */
function appRoots(a: Account, release: string): string[] {
  const htaccess = a.file(`${release}/public/.htaccess`) ?? "";
  return [...htaccess.matchAll(/^PassengerAppRoot "(.*)"$/gm)].map((match) => match[1] ?? "");
}

describe.skipIf(reason !== undefined)(
  "the hosting agent's selector apps",
  { timeout: 180_000 },
  () => {
    switching(
      "makes a Node.js app in the selector on an app request, and keeps its section's header",
      () => {
        const a = account();
        a.run();
        writeCache(a, OTHER);
        expect(app(a, "create")).toEqual({ result: "done" });
        expect(calls(a)).toEqual([
          `cloudlinux-selector create --json --interpreter nodejs --version 22 --app-root ${ROOT} --app-uri / --app-mode production --domain notes.example.com --startup-file current/index.js`,
          `cloudlinux-selector set --json --interpreter nodejs --app-root ${ROOT} --env-vars {"APP_NAME":"notes"}`,
        ]);
        // The home folder as bash names it (/d/… under Git for Windows).
        const header = a.file("state/selector-section") ?? "";
        expect(header).toMatch(/^\[\S+\/home\/opscrew\/notes-prod\/app\]\n$/);
        expect(readFileSync(cacheFile(a), "utf8")).toBe(`${OTHER}${header}app_root = ${ROOT}\n\n`);
        // The app's root is the folder app/ the agent made, never a link or a release: the selector
        // keeps it. Its startup file goes through app/current, the link to current made before the
        // app, so the placeholder app lands in the running release.
        expect(lstatSync(`${a.dir}/app`).isDirectory()).toBe(true);
        expect(readlinkSync(`${a.dir}/app/current`)).toBe("../current");
        expect(a.stubFile("selector-apps")).toBe(`nodejs ${ROOT} 22 current/index.js\n`);
        expect(a.file("releases/0-0/index.js")).toContain("It works!");
        expect(existsSync(`${a.dir}/app/index.js`)).toBe(false);
        expect(a.file("current/public/.htaccess")).toContain(passengerBlock(a));
      },
    );

    it("makes a Python app without a mode, which its selector doesn't take", () => {
      const a = account(PYTHON);
      a.run();
      expect(app(a, "create")).toEqual({ result: "done" });
      expect(calls(a)).toEqual([
        `cloudlinux-selector create --json --interpreter python --version 3.12 --app-root ${ROOT} --app-uri / --domain notes.example.com --startup-file current/passenger_wsgi.py`,
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

    switching(
      "installs the running release's packages again from app/ when a stopped install left another release's there",
      () => {
        const a = account();
        a.run();
        app(a, "create");
        a.publish(nodeRelease("one"), { run: 601 });
        expect(a.run().output).toContain("Release 601-1 serves.");
        // As a run killed part-way through another release's install leaves app/.
        writeFileSync(`${a.dir}/app/package.json`, "the other release's\n");
        rmSync(`${a.dir}/app/package-lock.json`);
        expect(a.run().output).toContain(
          "app/ holds another release's package files, left by a run that stopped while installing them: CloudLinux's selector installs release 601-1's again.",
        );
        expect(a.stubFile("selector.log").trimEnd().split("\n").slice(-2)).toEqual([
          `cloudlinux-selector install-modules --json --interpreter nodejs --app-root ${ROOT}`,
          'package.json: {"name":"notes","version":"one"}',
        ]);
        expect(a.file("app/package.json")).toBe('{"name":"notes","version":"one"}\n');
        expect(a.file("app/package-lock.json")).toBe('{"lockfileVersion":3,"lock":"1"}\n');
        expect(a.file("releases/601-1/package.json")).toBe('{"name":"notes","version":"one"}\n');
        // Then app/ matches the running release, so later runs install nothing.
        a.run();
        expect(calls(a).filter((line) => line.includes("install-modules"))).toHaveLength(2);
      },
    );

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
      expect(existsSync(`${a.dir}/app`)).toBe(false);
      expect(a.stubFile("selector-apps")).toBe("");
    });

    it("removes the empty folders above the environment folder when the selector removed it", () => {
      const a = account();
      a.run();
      app(a, "create");
      // A selector whose destroy takes the environment folder itself with it.
      rmSync(`${a.home}/nodevenv/${ROOT}`, { recursive: true });
      expect(app(a, "destroy")).toEqual({ result: "done" });
      expect(existsSync(`${a.home}/nodevenv`)).toBe(false);
      expect(existsSync(`${a.dir}/app`)).toBe(false);
      expect(existsSync(a.dir)).toBe(true);
    });

    it("finishes a destroy the selector already carried out, and answers one run again done", () => {
      const a = account();
      a.run();
      writeCache(a, OTHER);
      app(a, "create");
      // A run that stopped right after the selector's destroy: only the selector forgot the app.
      const args = ["--json", "--interpreter", "nodejs", "--app-root", ROOT];
      expect(runSelector(a, "destroy", ...args).status).toBe(0);
      const note = "CloudLinux's selector no longer had the app";
      expect(app(a, "destroy")).toEqual({ result: "done", note });
      expect(existsSync(`${a.dir}/app`)).toBe(false);
      expect(existsSync(`${a.home}/nodevenv/opscrew`)).toBe(false);
      expect(readFileSync(cacheFile(a), "utf8")).toBe(OTHER);
      expect(a.file("state/selector-section")).toBeUndefined();
      // The whole destroy again: another request, its name the hash of its text, so its expires
      // (fixed, far later than the first's) keeps it apart whatever the clock does.
      const expires = "99999999999";
      expect(app(a, "destroy", { action: "destroy", expires })).toEqual({ result: "done", note });
      expect(
        calls(a).filter((line) => line.startsWith("cloudlinux-selector destroy")),
      ).toHaveLength(3);
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
      expect(a.file("app/current/index.js")).toContain("It works!");
    });

    switching(
      "carries the selector's block into each release, linking the environment's packages, installing changed packages before the switch",
      () => {
        const a = account();
        a.run();
        app(a, "create");
        a.publish(nodeRelease("one"), { run: 101 });
        expect(a.run().output).toContain("Release 101-1 serves.");
        expect(readlinkSync(`${a.dir}/current`)).toBe("releases/101-1");
        // The packages of the release, installed from app/, where its package files went.
        expect(a.stubFile("selector.log")).toContain(
          `cloudlinux-selector install-modules --json --interpreter nodejs --app-root ${ROOT}\npackage.json: {"name":"notes","version":"one"}\n`,
        );
        expect(a.file("app/package.json")).toBe('{"name":"notes","version":"one"}\n');
        expect(existsSync(`${a.dir}/releases/0-0/package.json`)).toBe(false);
        const environment = realpathSync(`${a.home}/nodevenv/${ROOT}/22/lib/node_modules`);
        expect(readlinkSync(`${a.dir}/releases/101-1/node_modules`)).toBe(environment);
        // The document root is the release's public/, made where the release has none; the app
        // root, the source in it and its settings file stay outside it.
        expect(a.file("releases/101-1/.htaccess")).toBeUndefined();
        expect(existsSync(`${a.dir}/releases/101-1/public/index.js`)).toBe(false);
        expect(readlinkSync(`${a.dir}/releases/101-1/.env`)).toBe("../../shared/.env");
        const htaccess = a.file("releases/101-1/public/.htaccess") ?? "";
        expect(htaccess).toContain('Header always set X-OpsCrew-Release "101-1"\n');
        expect(htaccess).toContain(`# END OpsCrew\n${passengerBlock(a)}`);
        expect(existsSync(`${a.dir}/app/tmp/restart.txt`)).toBe(true);
        expect(existsSync(`${a.home}/.lsphp_restart.txt`)).toBe(false);

        // The same packages: nothing to install; the release is linked to the same environment.
        a.publish(nodeRelease("two"), { run: 102 });
        expect(a.run().output).toContain("Release 102-1 serves.");
        expect(calls(a).filter((line) => line.includes("install-modules"))).toHaveLength(2);
        expect(readlinkSync(`${a.dir}/releases/102-1/node_modules`)).toBe(environment);
        expect(appRoots(a, "releases/102-1")).toEqual([`${a.home}/${ROOT}`]);

        // A changed lockfile: installed from app/ before the switch, the running release's own
        // files untouched.
        a.publish(nodeRelease("three", "2"), { run: 103 });
        expect(a.run().output).toContain("Release 103-1 serves.");
        expect(a.stubFile("selector.log")).toContain(
          'package.json: {"name":"notes","version":"three"}',
        );
        expect(a.file("releases/102-1/package.json")).toBe('{"name":"notes","version":"two"}\n');
        expect(a.file("releases/102-1/package-lock.json")).toBe(
          '{"lockfileVersion":3,"lock":"1"}\n',
        );
        expect(a.file("app/package-lock.json")).toBe('{"lockfileVersion":3,"lock":"2"}\n');
      },
    );

    switching(
      "links each release to the packages of the environment PassengerNodejs names, where an ES module finds them",
      () => {
        const a = account({ ...NODE, startupFile: "dist/index.js" });
        // A package the fake selector installs (its stand-in for npm's registry).
        mkdirSync(`${a.stub}/packages/greet`, { recursive: true });
        writeFileSync(
          `${a.stub}/packages/greet/package.json`,
          '{"name":"greet","type":"module","exports":"./index.js"}\n',
        );
        writeFileSync(
          `${a.stub}/packages/greet/index.js`,
          'export const greet = (who) => "hello " + who;\n',
        );
        const release = (marker: string) => ({
          "package.json": '{"name":"api","type":"module","dependencies":{"greet":"1.0.0"}}\n',
          "dist/index.js": `import { greet } from "greet";\nconsole.log(greet("${marker}"));\n`,
        });
        const runs = (id: string) =>
          spawnSync(process.execPath, [`${a.dir}/releases/${id}/dist/index.js`], {
            encoding: "utf8",
          });
        const environment = `${a.home}/nodevenv/${ROOT}/22/lib/node_modules`;
        a.run();
        app(a, "create");
        // As the real selector, no node_modules link in the app root.
        expect(existsSync(`${a.dir}/app/node_modules`)).toBe(false);

        a.publish(release("one"), { run: 601 });
        expect(a.run().output).toContain("Release 601-1 serves.");
        expect(readlinkSync(`${a.dir}/releases/601-1/node_modules`)).toBe(environment);
        expect(runs("601-1")).toMatchObject({ status: 0, stdout: "hello one\n" });

        // The same packages, nothing installed; the selector's line unquoted links the same.
        const served = `${a.dir}/current/public/.htaccess`;
        writeFileSync(
          served,
          readFileSync(served, "utf8").replace(/^(PassengerNodejs )"(.*)"$/m, "$1$2"),
        );
        a.publish(release("two"), { run: 602 });
        expect(a.run().output).toContain("Release 602-1 serves.");
        expect(readlinkSync(`${a.dir}/releases/602-1/node_modules`)).toBe(environment);
        expect(runs("602-1")).toMatchObject({ status: 0, stdout: "hello two\n" });

        // A release that ships its own node_modules keeps it; a block without PassengerNodejs
        // links none.
        a.publish(
          { ...release("three"), "node_modules/own/package.json": '{"name":"own"}\n' },
          { run: 603 },
        );
        a.run();
        expect(lstatSync(`${a.dir}/releases/603-1/node_modules`).isSymbolicLink()).toBe(false);
        writeFileSync(served, readFileSync(served, "utf8").replace(/^PassengerNodejs .*\n/m, ""));
        a.publish(release("four"), { run: 604 });
        a.run();
        expect(existsSync(`${a.dir}/releases/604-1`)).toBe(true);
        expect(existsSync(`${a.dir}/releases/604-1/node_modules`)).toBe(false);
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
        expect(appRoots(a, "current")).toEqual([`${a.home}/${ROOT}`]);

        // Installing the running release's packages again fails: the status says so.
        writeFileSync(`${a.stub}/install-fails-for`, '"version":"one"');
        a.publish({ ...nodeRelease("four", "4"), "public/health-status": "500" }, { run: 504 });
        a.run();
        expect(a.keyValues("state/status").reason).toMatch(
          /; switched back to 501-1; installing release 501-1's packages again failed too \(\{"result": "npm install failed"\}\), so the app's environment may hold the failed release's$/,
        );
      },
    );

    switching("installs a Python release's requirements from app/, where its file goes", () => {
      const a = account(PYTHON);
      a.run();
      app(a, "create");
      a.publish(
        { "passenger_wsgi.py": "application = None\n", "requirements.txt": "flask==3.1.0\n" },
        { run: 301 },
      );
      expect(a.run().output).toContain("Release 301-1 serves.");
      expect(calls(a)[2]).toBe(
        `cloudlinux-selector install-modules --json --interpreter python --app-root ${ROOT} --requirements-file ${a.dir}/app/requirements.txt`,
      );
      expect(a.file("app/requirements.txt")).toBe("flask==3.1.0\n");
      expect(existsSync(`${a.dir}/releases/301-1/node_modules`)).toBe(false);
      // Passenger finds the release's passenger_wsgi.py through app/current, the startup file the
      // app was made with; the block stays as the selector wrote it, naming app/.
      expect(a.stubFile("selector-apps")).toBe(`python ${ROOT} 3.12 current/passenger_wsgi.py\n`);
      expect(a.file("app/current/passenger_wsgi.py")).toBe("application = None\n");
      expect(a.file("releases/301-1/public/.htaccess")).toContain(
        [
          `PassengerAppRoot "${a.home}/${ROOT}"`,
          `PassengerPython "${a.home}/virtualenv/${ROOT}/3.12/bin/python"`,
          'PassengerBaseURI "/"',
        ].join("\n"),
      );
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
      expect(appRoots(a, "current")).toEqual([`${a.home}/${ROOT}`]);
    });

    switching(
      "restarts the app through app/ and ends its processes on a deploy, a rollback, a switch back and destroy, the selector's block as it wrote it (R14)",
      async () => {
        const a = account();
        a.run();
        app(a, "create");
        a.publish(nodeRelease("one"), { run: 111 });
        a.run();
        // The restart file of the one app root LiteSpeed knows, app/; none in the releases.
        const signal = `${a.dir}/app/tmp/restart.txt`;
        // The restart file dated long ago, then the time the run (and its switch) starts.
        const before = () => {
          if (existsSync(signal)) utimesSync(signal, 946684800, 946684800);
          return Date.now() - 1000;
        };
        const restarted = (since: number) => statSync(signal).mtimeMs >= since;
        // The served block names app/ and current/index.js, as the selector wrote it.
        const asWritten = () =>
          expect(a.file("current/public/.htaccess")).toContain(passengerBlock(a));
        const perRelease = () =>
          a.releases().filter((id) => existsSync(`${a.dir}/releases/${id}/tmp/restart.txt`));
        // Stand-ins for processes: a sleep working in a folder, or a node process whose command
        // line names a path (as LiteSpeed's lsnode names the app's folder).
        const standIns: ChildProcess[] = [];
        const keep = (child: ChildProcess) => {
          standIns.push(child);
          return child;
        };
        const workingIn = (cwd: string) => keep(spawn("sleep", ["300"], { cwd, stdio: "ignore" }));
        const naming = (path: string) =>
          keep(
            spawn(process.execPath, ["-e", "setTimeout(() => {}, 300000)", path], {
              cwd: a.root,
              stdio: "ignore",
            }),
          );
        const ends = (child: ChildProcess) =>
          new Promise<boolean>((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null) resolve(true);
            child.once("exit", () => resolve(true));
            setTimeout(() => resolve(false), 5000);
          });
        const running = (child: ChildProcess) =>
          child.exitCode === null && child.signalCode === null;
        // Not the app's: another app's folder beside it (its name starting the same) and a folder
        // outside the app's.
        const sibling = `${a.home}/opscrew/notes-production/app`;
        mkdirSync(sibling, { recursive: true });
        const others = [naming(`${sibling}/index.js`), workingIn(sibling), workingIn(a.root)];
        try {
          // A deploy: 112-1 switched to, 111-1 switched from; the app's processes end, the one
          // naming app/ and the one working in a release.
          const lsnode = naming(`${a.dir}/app/current/index.js`);
          const old = workingIn(`${a.dir}/releases/111-1`);
          a.publish(nodeRelease("two"), { run: 112 });
          let since = before();
          let output = a.run().output;
          expect(output).toContain("Release 112-1 serves.");
          expect(output).toContain("2 of the app's processes ended.");
          expect(restarted(since)).toBe(true);
          asWritten();
          expect(perRelease()).toEqual([]);
          expect(await ends(lsnode)).toBe(true);
          expect(await ends(old)).toBe(true);
          expect(others.every(running)).toBe(true);

          // A rollback: 111-1 switched to, 112-1 switched from; a process in a folder under a
          // release ends.
          const under = workingIn(`${a.dir}/releases/112-1/public`);
          const expires = String(Math.floor(Date.now() / 1000) + 1800);
          const rollback = a.request(
            `kind=rollback\nhash=${HASH}\nexpires=${expires}\nrelease=111-1\nrestore=no\n`,
          );
          since = before();
          output = a.run().output;
          expect(a.keyValues(`state/${rollback}.result`)).toEqual({ result: "done" });
          expect(output).toContain("1 of the app's processes ended.");
          expect(restarted(since)).toBe(true);
          asWritten();
          expect(await ends(under)).toBe(true);
          expect(others.every(running)).toBe(true);

          // A switch back after a failed check: 111-1 runs again, restarted; 113-1 is gone.
          a.publish({ ...nodeRelease("three"), "public/health-status": "500" }, { run: 113 });
          since = before();
          output = a.run().output;
          expect(output).toContain("0 of the app's processes ended.");
          expect(readlinkSync(`${a.dir}/current`)).toBe("releases/111-1");
          expect(restarted(since)).toBe(true);
          asWritten();
          expect(perRelease()).toEqual([]);
          expect(existsSync(`${a.dir}/releases/113-1`)).toBe(false);
          expect(existsSync(`${a.home}/.lsphp_restart.txt`)).toBe(false);

          // Destroy ends the app's processes too, which the selector's destroy leaves running.
          const left = [naming(`${a.dir}/app/current/index.js`), workingIn(`${a.dir}/current`)];
          const logged = (a.file("state/agent.log") ?? "").length;
          expect(app(a, "destroy")).toEqual({ result: "done" });
          expect((a.file("state/agent.log") ?? "").slice(logged)).toContain(
            "2 of the app's processes ended.",
          );
          for (const child of left) expect(await ends(child)).toBe(true);
          expect(others.every(running)).toBe(true);
        } finally {
          for (const child of standIns) child.kill("SIGKILL");
        }
      },
    );

    switching(
      "installs the running release's packages again when a rollback's dump or restore fails after installing the target's",
      () => {
        const a = account({ ...NODE, database: "acct_notes", snapshots: true });
        a.run();
        app(a, "create");
        a.publish(nodeRelease("one"), { run: 701 });
        a.run();
        // Its database dump is filed under 701-1 before the next release.
        a.publish(nodeRelease("two", "2"), { run: 702 });
        a.run();
        const installed = () => a.stubFile("selector.log").match(/^package\.json: .*$/gm) ?? [];
        const [one, two] = ["one", "two"].map(
          (marker) => `package.json: {"name":"notes","version":"${marker}"}`,
        );
        const rollback = (expires: number) =>
          a.request(
            `kind=rollback\nhash=${HASH}\nexpires=${expires}\nrelease=701-1\nrestore=yes\n`,
          );
        const expires = Math.floor(Date.now() / 1000) + 1800;

        // The current database can't be dumped first.
        rmSync(`${a.stub}/db`);
        const first = rollback(expires);
        a.run();
        expect(a.keyValues(`state/${first}.result`)).toEqual({
          result: "failed",
          reason:
            "the current database couldn't be dumped first: the database is untouched and release 702-1 still runs",
        });
        expect(installed().slice(-2)).toEqual([one, two]);

        // The target's dump can't be restored: the database goes back, and the packages too.
        writeFileSync(`${a.stub}/db`, "state=two\n");
        writeFileSync(`${a.stub}/refuse`, "state=initial");
        const second = rollback(expires - 1);
        a.run();
        expect(a.keyValues(`state/${second}.result`)).toEqual({
          result: "failed",
          reason:
            "restoring release 701-1's dump failed: the database is back as it was, and release 702-1 still runs",
        });
        expect(installed().slice(-2)).toEqual([one, two]);
        expect(a.stubFile("db")).toBe("state=two\n");
        expect(readlinkSync(`${a.dir}/current`)).toBe("releases/702-1");
        expect(a.file("app/package.json")).toBe('{"name":"notes","version":"two"}\n');
      },
    );

    switching(
      "keeps the last 100 lines of a failed release's own errors in state/, the newest 3, never in its log",
      () => {
        const a = account();
        a.run();
        app(a, "create");
        a.publish(nodeRelease("one"), { run: 901 });
        a.run();
        // What Passenger wrote into the release's stderr.log: 151 lines, a secret in the last.
        const secret = fakeSecret("generic-password", "stderr");
        const lines = Array.from({ length: 150 }, (_, i) => `line ${i + 1}\n`).join("");
        const errors = `${lines}Error: ${secret}\n`;
        for (const run of [902, 903, 904, 905]) {
          const failing = { "public/health-status": "503", "stderr.log": errors };
          a.publish({ ...nodeRelease("one"), ...failing }, { run });
          a.run();
        }
        expect(readlinkSync(`${a.dir}/current`)).toBe("releases/901-1");
        const kept = readdirSync(`${a.dir}/state`).filter((file) => file.endsWith(".stderr.log"));
        expect(kept.sort()).toEqual(["903-1.stderr.log", "904-1.stderr.log", "905-1.stderr.log"]);
        const tail = a.file("state/905-1.stderr.log") ?? "";
        expect(tail.startsWith("line 52\n")).toBe(true);
        expect(tail.endsWith(`line 150\nError: ${secret}\n`)).toBe(true);
        expect(tail.split("\n")).toHaveLength(101);
        expect(statSync(`${a.dir}/state/905-1.stderr.log`).mode & 0o777).toBe(0o600);
        expect(a.keyValues("state/status").reason).toMatch(
          /; switched back to 901-1; the app's own errors are in ~\/opscrew\/notes-prod\/state\/905-1\.stderr\.log$/,
        );
        expect(a.file("state/agent.log")).not.toContain(secret);
        expect(a.file("state/status")).not.toContain(secret);
      },
    );

    switching(
      "keeps a failed release's errors from app/stderr.log, where Passenger writes them, and empties it after",
      () => {
        const a = account();
        a.run();
        app(a, "create");
        a.publish(nodeRelease("one"), { run: 921 });
        a.run();
        // What Passenger wrote into the app root's stderr.log while the release failed.
        const secret = fakeSecret("generic-password", "app-stderr");
        writeFileSync(`${a.dir}/app/stderr.log`, `starting\nError: ${secret}\n`);
        a.publish({ ...nodeRelease("two"), "public/health-status": "500" }, { run: 922 });
        a.run();
        expect(readlinkSync(`${a.dir}/current`)).toBe("releases/921-1");
        expect(a.file("state/922-1.stderr.log")).toBe(`starting\nError: ${secret}\n`);
        expect(statSync(`${a.dir}/state/922-1.stderr.log`).mode & 0o777).toBe(0o600);
        expect(a.file("app/stderr.log")).toBe("");
        expect(a.keyValues("state/status").reason).toMatch(
          /; the app's own errors are in ~\/opscrew\/notes-prod\/state\/922-1\.stderr\.log$/,
        );
        expect(a.file("state/agent.log")).not.toContain(secret);

        // With app/stderr.log empty, the release's own stderr.log is kept.
        a.publish(
          { ...nodeRelease("three"), "public/health-status": "500", "stderr.log": "own\n" },
          { run: 923 },
        );
        a.run();
        expect(a.file("state/923-1.stderr.log")).toBe("own\n");
      },
    );

    switching(
      "keeps the selector's block as it wrote it, naming app/, through two releases, a settings change and a rollback, and destroy still finds the app and leaves the releases",
      () => {
        const a = account();
        a.run();
        expect(app(a, "create")).toEqual({ result: "done" });
        // The selector wrote its block, naming app/, into the placeholder's .htaccess.
        expect(appRoots(a, "releases/0-0")).toEqual([`${a.home}/${ROOT}`]);

        a.publish(nodeRelease("one"), { run: 101 });
        expect(a.run().output).toContain("Release 101-1 serves.");
        a.publish(nodeRelease("two", "2"), { run: 102 });
        expect(a.run().output).toContain("Release 102-1 serves.");
        expect(appRoots(a, "releases/101-1")).toEqual([`${a.home}/${ROOT}`]);
        expect(a.file("current/public/.htaccess")).toContain(passengerBlock(a));

        // A settings change: the selector writes its block again, naming app/.
        const expires = String(Math.floor(Date.now() / 1000) + 1800);
        writeFileSync(`${a.dir}/shared/.env.next`, "APP_NAME=renamed\n");
        const env = a.request(`kind=env\nhash=${HASH}\nexpires=${expires}\n`);
        a.run();
        expect(a.keyValues(`state/${env}.result`)).toEqual({ result: "done" });
        expect(appRoots(a, "current")).toEqual([`${a.home}/${ROOT}`]);

        // A rollback runs the first release again, with its packages.
        const rollback = a.request(
          `kind=rollback\nhash=${HASH}\nexpires=${expires}\nrelease=101-1\nrestore=no\n`,
        );
        a.run();
        expect(a.keyValues(`state/${rollback}.result`)).toEqual({ result: "done" });
        expect(readlinkSync(`${a.dir}/current`)).toBe("releases/101-1");
        expect(a.file("current/public/.htaccess")).toContain(passengerBlock(a));
        expect(a.file("app/package.json")).toBe('{"name":"notes","version":"one"}\n');

        // Every selector command named app/, so the selector still finds the app.
        expect(app(a, "destroy")).toEqual({ result: "done" });
        expect(calls(a).filter((line) => !line.includes(`--app-root ${ROOT}`))).toEqual([]);
        expect(existsSync(`${a.dir}/app`)).toBe(false);
        expect(existsSync(`${a.home}/nodevenv/opscrew`)).toBe(false);
        // app/current was a link: the release it pointed at stays.
        expect(a.file("current/index.js")).toBe('console.log("one");\n');
      },
    );

    switching("has a fake selector that resolves the app root once, as the real one (R14)", () => {
      const a = account();
      a.run();
      const selector = (...args: string[]) => runSelector(a, ...args);
      const current = ["--interpreter", "nodejs", "--app-root", "opscrew/notes-prod/current"];
      const made = selector("create", ...current, "--version", "22", "--startup-file", "index.js");
      expect(made.status).toBe(0);
      expect(a.stubFile("selector-apps")).toBe(
        "nodejs opscrew/notes-prod/releases/0-0 22 index.js\n",
      );
      expect(a.file("releases/0-0/index.js")).toContain("It works!");
      expect(appRoots(a, "current")).toEqual([`${a.home}/opscrew/notes-prod/releases/0-0`]);

      mkdirSync(`${a.dir}/releases/7-1`);
      rmSync(`${a.dir}/current`);
      symlinkSync("releases/7-1", `${a.dir}/current`);
      const lost = selector("destroy", ...current);
      expect(lost.status).toBe(1);
      expect(lost.stdout).toContain(
        `No such application or it's broken. Unable to find app-root folder by this path ${a.home}/opscrew/notes-prod/releases/7-1`,
      );
    });
  },
);
