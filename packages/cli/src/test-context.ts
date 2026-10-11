import { Redactor } from "@opscrew/core";
import type { CliContext } from "./context";
import { TerminalReporter } from "./reporter";

/** A `CliContext` that records output instead of writing to the terminal. For tests only. */
export interface TestContext extends CliContext {
  out: string[];
  err: string[];
  /** Everything written to stdout. */
  readonly output: string;
  /** Everything written to stderr. */
  readonly errors: string;
}

export function createTestContext(options: Partial<CliContext> = {}): TestContext {
  const out: string[] = [];
  const err: string[] = [];
  const redactor = options.redactor ?? new Redactor();
  const stdout = (text: string) => out.push(redactor.redact(text));
  const stderr = (text: string) => err.push(redactor.redact(text));
  return {
    cwd: process.cwd(),
    env: {},
    version: "9.9.9-test",
    isInteractive: false,
    stdout,
    stderr,
    reporter: new TerminalReporter({ stdout, stderr, redactor, color: false }),
    redactor,
    ...options,
    out,
    err,
    get output() {
      return out.join("");
    },
    get errors() {
      return err.join("");
    },
  };
}
