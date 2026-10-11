import { Redactor } from "@opscrew/core";
import { describe, expect, it } from "vitest";
import { colorEnabled } from "./context";
import { TerminalReporter } from "./reporter";

function capture(color: boolean) {
  const out: string[] = [];
  const err: string[] = [];
  const redactor = new Redactor();
  const reporter = new TerminalReporter({
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    redactor,
    color,
  });
  return { out, err, redactor, reporter };
}

describe("TerminalReporter", () => {
  it("prefixes each kind of message and routes warnings and errors to stderr", () => {
    const { out, err, reporter } = capture(false);
    reporter.step("Scanning");
    reporter.info("3 files");
    reporter.success("Done");
    reporter.warn("Careful");
    reporter.error("Failed");
    expect(out).toEqual(["◆ Scanning\n", "  3 files\n", "✓ Done\n"]);
    expect(err).toEqual(["▲ Careful\n", "✗ Failed\n"]);
  });

  it("redacts every message", () => {
    const { out, err, redactor, reporter } = capture(false);
    const secret = `literal-${"q".repeat(20)}`;
    redactor.addLiteral(secret, "GITHUB_TOKEN");
    for (const method of ["step", "info", "success", "warn", "error"] as const) {
      reporter[method](`token=${secret}`);
    }
    const all = [...out, ...err].join("");
    expect(all).not.toContain(secret);
    expect(all.match(/GITHUB_TOKEN/g)).toHaveLength(5);
  });

  it("uses ANSI colours only when enabled", () => {
    const plain = capture(false);
    plain.reporter.success("ok");
    expect(plain.out[0]).not.toContain("\u001b[");
    const colored = capture(true);
    colored.reporter.success("ok");
    expect(colored.out[0]).toContain("\u001b[");
  });
});

describe("colorEnabled", () => {
  it("respects NO_COLOR and FORCE_COLOR", () => {
    expect(colorEnabled({}, true)).toBe(true);
    expect(colorEnabled({}, false)).toBe(false);
    expect(colorEnabled({ NO_COLOR: "1" }, true)).toBe(false);
    expect(colorEnabled({ NO_COLOR: "" }, true)).toBe(true);
    expect(colorEnabled({ FORCE_COLOR: "1" }, false)).toBe(true);
    expect(colorEnabled({ NO_COLOR: "1", FORCE_COLOR: "1" }, true)).toBe(false);
  });
});
