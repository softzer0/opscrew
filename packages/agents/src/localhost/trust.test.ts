import { X509Certificate } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readTextIfExists } from "@opscrew/core";
import { describe, expect, it } from "vitest";
import { ScriptedApprovalHandler } from "../testing";
import { FakeComputer, localPlan, localProject } from "./__fixtures__/computer";
import { caFiles, caTrusted } from "./ca";
import { localTrust } from "./trust";

/** A project on `platform`, interactive or not, answering the trust approval with `agree`. */
async function computerOn(platform: NodeJS.Platform, interactive: boolean, agree = true) {
  const computer = new FakeComputer();
  const approve = new ScriptedApprovalHandler(() => agree);
  const { deps } = await localProject(localPlan(), computer, { approve });
  const services = computer.services({ platform });
  const trust = (action: "trust" | "untrust") =>
    localTrust({ ...deps, interactive }, { action, services });
  return { deps, computer, approve, trust };
}

describe("localTrust", () => {
  it("in scripts only prints the OS's command, per OS, and changes nothing", async () => {
    const expected: Record<string, RegExp> = {
      darwin:
        /^security add-trusted-cert -r trustRoot -k \/home\/me\/Library\/Keychains\/login\.keychain-db .+ca\.pem$/,
      win32: /^certutil -user -addstore Root .+ca\.pem$/,
      linux:
        /^certutil -d sql:\/home\/me\/\.pki\/nssdb -A -t "C,," -n "OpsCrew local CA" -i .+ca\.pem$/,
    };
    for (const [platform, command] of Object.entries(expected)) {
      const { deps, computer, approve, trust } = await computerOn(
        platform as NodeJS.Platform,
        false,
      );
      const result = await trust("trust");
      expect(result.done).toBe(false);
      expect(result.command.replaceAll("\\", "/")).toMatch(command);
      expect(computer.commands).toEqual([]);
      expect(approve.requests).toEqual([]);
      expect(await caTrusted(deps.paths)).toBe(false);
      // It shows the command, what it changes and how to undo it.
      const text = deps.reporter.text();
      expect(text).toContain(`Command: ${result.command}`);
      expect(text).toContain("`opscrew localhost untrust` undoes it");
      if (platform === "linux") expect(text).toContain("sudo update-ca-certificates");
      // Trusting makes the CA on first use; its key never appears in the output.
      const key = await readFile(caFiles(deps.paths).key, "utf8");
      expect(text).not.toContain(key.split("\n")[1] as string);
    }
  });

  it("runs the command in a terminal once the user agrees, and records the trust", async () => {
    const { deps, computer, approve, trust } = await computerOn("win32", true);
    const result = await trust("trust");
    expect(result.done).toBe(true);
    expect(approve.requests).toEqual([
      expect.objectContaining({
        kind: "remote-exec",
        details: expect.stringContaining(result.command),
      }),
    ]);
    expect(computer.commands).toEqual([
      {
        command: "certutil",
        args: ["-user", "-addstore", "Root", caFiles(deps.paths).certificate],
      },
    ]);
    expect(await caTrusted(deps.paths)).toBe(true);
    expect(deps.audit.entries.map((e) => e.action)).toContain("localhost trust");

    const serial = new X509Certificate(await readFile(caFiles(deps.paths).certificate, "utf8"))
      .serialNumber;
    const undone = await trust("untrust");
    expect(undone).toMatchObject({
      command: `certutil -user -delstore Root ${serial}`,
      done: true,
    });
    expect(await caTrusted(deps.paths)).toBe(false);
    expect(await readTextIfExists(join(caFiles(deps.paths).dir, "trust.json"))).toBeUndefined();
  });

  it("undoes macOS's and Linux's trust with their own commands", async () => {
    const mac = await computerOn("darwin", true);
    await mac.trust("trust");
    const fingerprint = new X509Certificate(
      await readFile(caFiles(mac.deps.paths).certificate, "utf8"),
    ).fingerprint.replaceAll(":", "");
    // Paths are joined with this test computer's separator.
    expect((await mac.trust("untrust")).command.replaceAll("\\", "/")).toBe(
      `security delete-certificate -Z ${fingerprint} /home/me/Library/Keychains/login.keychain-db`,
    );
    const linux = await computerOn("linux", true);
    await linux.trust("trust");
    expect((await linux.trust("untrust")).command.replaceAll("\\", "/")).toBe(
      'certutil -d sql:/home/me/.pki/nssdb -D -n "OpsCrew local CA"',
    );
  });

  it("changes nothing when the user does not agree, and has nothing to untrust without a CA", async () => {
    const { deps, computer, trust } = await computerOn("darwin", true, false);
    expect((await trust("trust")).done).toBe(false);
    expect(computer.commands).toEqual([]);
    expect(await caTrusted(deps.paths)).toBe(false);
    const fresh = await computerOn("linux", true);
    await expect(fresh.trust("untrust")).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      message: "This computer has no OpsCrew local CA, so there is nothing to untrust.",
    });
  });
});
