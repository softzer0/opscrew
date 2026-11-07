import { checkKeyLine } from "@opscrew/connector-ssh-host";
import type { RemoteExec } from "@opscrew/contracts";
import { CHECK_COMMAND } from "@opscrew/iac-templates";
import { describe, expect, it } from "vitest";
import { createTestPhaseDeps } from "../testing";
import { hasCheckKey } from "./host";
import { ensureCheckKey } from "./key";

/** A shell whose `cat ~/.ssh/authorized_keys` prints `keys`. */
function shell(keys: string): RemoteExec {
  return {
    run: async () => ({ exitCode: 0, stdout: keys, stderr: "" }),
  } as unknown as RemoteExec;
}

describe("hasCheckKey", () => {
  it("finds only the repository's line with today's command, so an older OpsCrew's line is planned again", async () => {
    const deps = await createTestPhaseDeps();
    const key = await ensureCheckKey(deps.paths, deps.redactor);
    const line = checkKeyLine(key.publicKeyOpenSsh, "acme/shop");
    const old = `restrict,command="df -P -B1 /" ${key.publicKeyOpenSsh} opscrew-check:acme/shop`;
    expect(
      await hasCheckKey(deps, shell(`ssh-ed25519 AAAAdeploy deploy\n${line}\n`), key, "acme/shop"),
    ).toBe(true);
    expect(await hasCheckKey(deps, shell(`${old}\n`), key, "acme/shop")).toBe(false);
    expect(await hasCheckKey(deps, shell(`${line}\n`), key, "acme/blog")).toBe(false);
  });
});

describe("the check's command", () => {
  it("is the same in check.mjs, which the server's own runner runs, as the check key's forced command", () => {
    expect(checkKeyLine("ssh-ed25519 AAAA", "acme/shop")).toBe(
      `restrict,command="${CHECK_COMMAND}" ssh-ed25519 AAAA opscrew-check:acme/shop`,
    );
  });
});
