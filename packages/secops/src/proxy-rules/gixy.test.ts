import type { CommandResult, CommandRunner } from "@opscrew/contracts";
import { describe, expect, it } from "vitest";
import { runGixy } from "./gixy";

const FILE = "/tmp/edge/sites/app.conf";

function runner(result: CommandResult): CommandRunner & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    async run(command, args) {
      calls.push([command, ...args]);
      return result;
    },
  };
}

const installed = { which: (name: string) => (name === "gixy" ? "/usr/bin/gixy" : undefined) };

const REPORT = JSON.stringify([
  {
    path: FILE,
    plugin: "add_header_redefinition",
    summary: "Nested add_header drops parent headers.",
    severity: "MEDIUM",
    description: "add_header in a nested block replaces the parent's headers.",
    reference: "https://gixy.getpagespeed.com/en/plugins/addheaderredefinition/",
    reason: 'Parent headers "x-frame-options" was dropped in current level',
    config: "add_header Cache-Control public;",
  },
  { path: FILE, plugin: "host_spoofing", summary: "The proxied Host header may be spoofed." },
]);

describe("runGixy", () => {
  it("returns nothing and runs nothing when gixy-ng is not installed", async () => {
    const exec = runner({ exitCode: 0, stdout: "", stderr: "" });
    expect(await runGixy(FILE, exec, { which: () => undefined })).toEqual([]);
    expect(exec.calls).toEqual([]);
  });

  it("returns its findings as advice", async () => {
    const exec = runner({ exitCode: 1, stdout: REPORT, stderr: "" });
    const results = await runGixy(FILE, exec, installed);
    expect(exec.calls).toEqual([["/usr/bin/gixy", "-f", "json", FILE]]);
    expect(results).toEqual([
      {
        id: "gixy-ng/add_header_redefinition",
        title: "Nested add_header drops parent headers.",
        status: "warn",
        severity: "medium",
        message: 'Parent headers "x-frame-options" was dropped in current level',
        remediation: "See https://gixy.getpagespeed.com/en/plugins/addheaderredefinition/",
        source: "gixy-ng",
      },
      {
        id: "gixy-ng/host_spoofing",
        title: "The proxied Host header may be spoofed.",
        status: "warn",
        severity: "info",
        message: "The proxied Host header may be spoofed.",
        source: "gixy-ng",
      },
    ]);
  });

  it("returns nothing for a clean file", async () => {
    expect(
      await runGixy(FILE, runner({ exitCode: 0, stdout: "[]", stderr: "" }), installed),
    ).toEqual([]);
  });

  it("gives one skip result, never a failure, when gixy-ng cannot check the file", async () => {
    const crashed = runner({ exitCode: 2, stdout: "", stderr: "Traceback\nValueError: bad" });
    const timedOut = runner({ exitCode: 1, stdout: "", stderr: "", timedOut: true });
    const [crash] = await runGixy(FILE, crashed, installed);
    const [late] = await runGixy(FILE, timedOut, installed);
    expect(crash).toMatchObject({ id: "gixy-ng", status: "skip", source: "gixy-ng" });
    expect(crash?.message).toBe(
      `gixy-ng could not check ${FILE}: gixy-ng exited with code 2: Traceback ValueError: bad`,
    );
    expect(late?.message).toBe(`gixy-ng could not check ${FILE}: gixy-ng timed out.`);
  });
});
