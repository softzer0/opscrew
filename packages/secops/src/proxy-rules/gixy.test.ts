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

  it("sets apart http_splitting and regex_redos on a block OpsCrew wrote, and only there", async () => {
    // As gixy-ng 0.2.57 reports them on OpsCrew's translation of vercel.json, and on the user's own.
    const regex = "^(?!/\\.well-known/)(?!.*[\\r\\n])(?:/old(?:/((?:[^/]+)(?:/(?:[^/]+))*))?$)";
    const guarded = `\nif ($uri ~ ${regex}) {\n\treturn 308 $scheme://$host/new/$1;\n}`;
    const own = "\nif ($uri ~ ^/old/(.+)$) {\n\treturn 308 $scheme://$host/new/$1;\n}";
    const issue = (plugin: string, config: string, flagged = regex) => ({
      path: FILE,
      plugin,
      summary: plugin,
      severity: "HIGH",
      reason:
        plugin === "regex_redos"
          ? `Regex \`${flagged}\` is vulnerable: Nested quantifier in group`
          : 'At least variable "$1" can contain "\\n"',
      config,
    });
    const report = JSON.stringify([
      issue("http_splitting", guarded),
      issue("regex_redos", guarded),
      issue("host_spoofing", guarded),
      issue("http_splitting", own),
      issue("regex_redos", own, "^/old/(.+)$"),
    ]);
    const results = await runGixy(
      FILE,
      runner({ exitCode: 1, stdout: report, stderr: "" }),
      installed,
    );
    expect(results.map((r) => [r.id, r.noise !== undefined])).toEqual([
      ["gixy-ng/http_splitting", true],
      ["gixy-ng/regex_redos", true],
      ["gixy-ng/host_spoofing", false],
      ["gixy-ng/http_splitting", false],
      ["gixy-ng/regex_redos", false],
    ]);
    expect(results[0]?.noise).toContain("(?!.*[\\r\\n])");
    expect(results[0]).toMatchObject({ status: "warn", severity: "high", source: "gixy-ng" });
  });

  it("keeps regex_redos on a guarded pattern the user wrote with a repeated group of its own", async () => {
    const guard = "^(?!/\\.well-known/)(?!.*[\\r\\n])";
    const redos = (flagged: string) => ({
      path: FILE,
      plugin: "regex_redos",
      summary: "regex_redos",
      severity: "HIGH",
      reason: `Regex \`${flagged}\` is vulnerable: Nested quantifier in group`,
      config: `\nlocation ~ ${flagged} {\n}`,
    });
    const report = JSON.stringify([
      // vercel.json's `^/api/((?:\w+)+)$`, and a parameter with its own pattern (`/a/:p(\d+)+`).
      redos(`${guard}(?:/api/((?:\\w+)+)$)`),
      redos(`${guard}(?:/a/((?:\\d+)(?:/(?:\\d+))*)$)`),
      // OpsCrew's own repeats: cleanUrls' pages, and a rewrite location joining two sources.
      redos(`${guard}(?:/((?:[^/]+/)*[^/.]+)$)`),
      redos(`${guard}(?:(?:/((?:[^/]+/)*[^/.]+)$)|(?:/blog/([^/]+)$))`),
      // A reason that does not name the regular expression is never noise.
      { ...redos(`${guard}(?:/((?:[^/]+/)*[^/.]+)$)`), reason: "Nested quantifier in group" },
    ]);
    const results = await runGixy(
      FILE,
      runner({ exitCode: 1, stdout: report, stderr: "" }),
      installed,
    );
    expect(results.map((r) => r.noise !== undefined)).toEqual([false, false, true, true, false]);
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
