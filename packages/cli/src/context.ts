import type { Reporter } from "@opscrew/contracts";
import { Redactor, registerEnvSecrets } from "@opscrew/core";
import { version as packageVersion } from "../package.json";
import { TerminalReporter } from "./reporter";

/** Everything a command needs from the outside world. Tests build their own. */
export interface CliContext {
  /** Absolute project directory; the global `--cwd <dir>` option replaces it before an action. */
  cwd: string;
  env: Record<string, string | undefined>;
  /** Version of the `opscrew` package. */
  version: string;
  /** True when a human can answer prompts (stdin and stdout are TTYs and `CI` is not set). */
  isInteractive: boolean;
  /** Writes redacted text to standard output (no newline added). */
  stdout(text: string): void;
  /** Writes redacted text to standard error (no newline added). */
  stderr(text: string): void;
  /**
   * Writes `text` to standard output without redaction (no newline added): only for a secret the
   * user asked to be shown once, such as a device's database password from `opscrew vpn grant`.
   */
  showOnce(text: string): void;
  reporter: Reporter;
  redactor: Redactor;
}

/** Builds the context for the real process: `process.cwd()`, `process.env` and real streams. */
export function createDefaultContext(): CliContext {
  const env = process.env;
  const redactor = new Redactor();
  registerEnvSecrets(redactor, env);
  const stdout = (text: string) => {
    process.stdout.write(redactor.redact(text));
  };
  const stderr = (text: string) => {
    process.stderr.write(redactor.redact(text));
  };
  return {
    cwd: process.cwd(),
    env,
    version: packageVersion,
    isInteractive:
      process.stdin.isTTY === true && process.stdout.isTTY === true && !isTruthy(env.CI),
    stdout,
    stderr,
    showOnce: (text) => {
      process.stdout.write(text);
    },
    reporter: new TerminalReporter({
      stdout,
      stderr,
      redactor,
      color: colorEnabled(env, process.stdout.isTTY === true),
    }),
    redactor,
  };
}

/** Colours are on for a TTY unless `NO_COLOR` is set (non-empty); `FORCE_COLOR` turns them on. */
export function colorEnabled(env: Record<string, string | undefined>, isTty: boolean): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if (isTruthy(env.FORCE_COLOR)) return true;
  return isTty;
}

function isTruthy(value: string | undefined): boolean {
  return value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";
}
