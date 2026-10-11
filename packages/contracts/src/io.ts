/** Result of running an external command. */
export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** True when the command was killed because it exceeded `timeoutMs`. */
  timedOut?: boolean;
}

export interface CommandOptions {
  cwd?: string;
  /** Full environment for the child process. When omitted the parent's environment is used. */
  env?: Record<string, string | undefined>;
  /** Text written to the child's stdin, then stdin is closed. */
  input?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Called for every complete stdout/stderr line as it arrives (for progress output). */
  onLine?: (line: string, stream: "stdout" | "stderr") => void;
}

/**
 * Runs external binaries without a shell. Injected everywhere a subprocess is needed so tests can
 * replace it with a fake.
 */
export interface CommandRunner {
  run(command: string, args: readonly string[], options?: CommandOptions): Promise<CommandResult>;
}

/** Runs commands on a remote host (SSH in production, a fake in tests). */
export interface RemoteExec {
  readonly host: string;
  run(command: string, options?: { timeoutMs?: number }): Promise<CommandResult>;
}

/** The subset of the WHATWG `fetch` signature OpsCrew uses. Injected into every HTTP client. */
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface Clock {
  now(): Date;
}

/**
 * User-visible progress output. The CLI renders it in the terminal; the MCP server collects it.
 * Implementations MUST pass every message through the redactor.
 */
export interface Reporter {
  step(message: string): void;
  info(message: string): void;
  success(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}
