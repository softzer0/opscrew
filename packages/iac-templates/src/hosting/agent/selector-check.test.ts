import { chmodSync, readlinkSync, renameSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { Account, agentSkipReason, CAN_LINK } from "../__fixtures__/account";
import type { AgentSettings } from "../agent";

/*
 * The selector's own check of the app (027 T2741, research R13): `install-modules` answers an error
 * that says "The operation was performed" when the packages went in but its check of the app's
 * answers failed. The fake selector is wrapped so install-modules answers that while
 * $STUB/install-performed exists. Cases switch releases, so they need real symbolic links.
 */

const reason = agentSkipReason();
const switching = it.skipIf(!CAN_LINK);
const HASH = "cd".repeat(32);

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

const PERFORMED =
  '{"result": "An error occured during installation of modules. The operation was performed, but check availability of application has failed."}';

const WRAPPER = `#!/bin/bash
said=$("$(dirname "$0")/cloudlinux-selector.fake" "$@") || { printf '%s\\n' "$said"; exit 1; }
if [ "$1" = install-modules ] && [ -f "$STUB/install-performed" ]; then
  printf '%s\\n' '${PERFORMED}'
  exit 1
fi
printf '%s\\n' "$said"
`;

const accounts: Account[] = [];
afterEach(() => {
  for (const account of accounts.splice(0)) account.remove();
});

/** A Node.js account whose app the selector made, its fake selector wrapped. */
function account(): Account {
  const a = new Account(NODE);
  accounts.push(a);
  const bin = `${a.root}/bin/cloudlinux-selector`;
  renameSync(bin, `${bin}.fake`);
  writeFileSync(bin, WRAPPER);
  chmodSync(bin, 0o755);
  a.run();
  const expires = String(Math.floor(Date.now() / 1000) + 1800);
  a.request(`kind=app\nhash=${HASH}\nexpires=${expires}\naction=create\n`);
  a.run();
  return a;
}

function nodeRelease(marker: string, lock = "1"): Record<string, string> {
  return {
    "index.js": `console.log("${marker}");\n`,
    "package.json": `{"name":"notes","version":"${marker}"}\n`,
    "package-lock.json": `{"lockfileVersion":3,"lock":"${lock}"}\n`,
  };
}

const installed = (a: Account) => a.stubFile("selector.log").match(/^package\.json: .*$/gm) ?? [];
const NOTE = `Note: CloudLinux's selector installed the packages, but its own check of the app failed (${PERFORMED}).`;

describe.skipIf(reason !== undefined)(
  "the hosting agent and the selector's own check",
  { timeout: 180_000 },
  () => {
    switching(
      "deploys a first release when the selector's own check failed after installing",
      () => {
        const a = account();
        writeFileSync(`${a.stub}/install-performed`, "");
        a.publish(nodeRelease("one"), { run: 101 });
        const output = a.run().output;
        expect(output).toContain(NOTE);
        expect(output).toContain("Release 101-1 serves.");
        expect(readlinkSync(`${a.dir}/current`)).toBe("releases/101-1");
        expect(a.keyValues("state/status")).toMatchObject({ running: "101-1", result: "deployed" });
      },
    );

    switching(
      "switches back and installs the running release's packages again when the check fails",
      () => {
        const a = account();
        a.publish(nodeRelease("one"), { run: 201 });
        a.run();
        writeFileSync(`${a.stub}/install-performed`, "");
        a.publish({ ...nodeRelease("two", "2"), "public/health-status": "500" }, { run: 202 });
        const output = a.run().output;
        expect(output).toContain(NOTE);
        expect(readlinkSync(`${a.dir}/current`)).toBe("releases/201-1");
        expect(installed(a).slice(-2)).toEqual([
          'package.json: {"name":"notes","version":"two"}',
          'package.json: {"name":"notes","version":"one"}',
        ]);
        expect(a.keyValues("state/status").reason).toMatch(/; switched back to 201-1$/);
      },
    );

    switching("still fails a release before the switch on any other error", () => {
      const a = account();
      writeFileSync(`${a.stub}/selector-fails`, "install-modules\n");
      a.publish(nodeRelease("one"), { run: 301 });
      const output = a.run().output;
      expect(output).not.toContain("Note:");
      expect(readlinkSync(`${a.dir}/current`)).toBe("releases/0-0");
      expect(a.releases()).not.toContain("301-1");
      expect(a.keyValues("state/status")).toMatchObject({
        attempt: "301-1",
        result: "failed",
        reason: `CloudLinux's selector couldn't install its packages ({"result": "Something went wrong in the fake selector"}), so the app's environment, which the running release shares, may have changed; the running release stays`,
      });
    });
  },
);
