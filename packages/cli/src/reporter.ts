import type { Reporter } from "@opscrew/contracts";
import type { Redactor } from "@opscrew/core";
import { createColors } from "picocolors";

export interface TerminalReporterOptions {
  /** Writes to standard output (step, info, success). */
  stdout(text: string): void;
  /** Writes to standard error (warn, error). */
  stderr(text: string): void;
  redactor: Redactor;
  /** Use ANSI colours. Derive it with `colorEnabled` so `NO_COLOR` is respected. */
  color: boolean;
}

/** `Reporter` for the terminal: one line per message, prefixed ◆ ✓ ▲ ✗, always redacted. */
export class TerminalReporter implements Reporter {
  private readonly colors: ReturnType<typeof createColors>;

  constructor(private readonly options: TerminalReporterOptions) {
    this.colors = createColors(options.color);
  }

  step(message: string): void {
    this.options.stdout(`${this.colors.cyan("◆")} ${this.colors.bold(this.redact(message))}\n`);
  }

  info(message: string): void {
    this.options.stdout(`  ${this.redact(message)}\n`);
  }

  success(message: string): void {
    this.options.stdout(`${this.colors.green("✓")} ${this.redact(message)}\n`);
  }

  warn(message: string): void {
    this.options.stderr(`${this.colors.yellow("▲")} ${this.redact(message)}\n`);
  }

  error(message: string): void {
    this.options.stderr(`${this.colors.red("✗")} ${this.redact(message)}\n`);
  }

  private redact(message: string): string {
    return this.options.redactor.redact(message);
  }
}
