import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { Account, agentSkipReason, CAN_LINK, laravelRelease } from "../__fixtures__/account";

/*
 * A panel's file removal skips read-only files (cPanel's Fileman::fileop unlink, research R13), so
 * the agent leaves none in the app's folder. File modes mean little under Git for Windows: this
 * runs on Linux.
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
