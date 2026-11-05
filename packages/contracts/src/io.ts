import type { Duplex, Readable } from "node:stream";

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
  /** The most output bytes this call may collect; the runner's default otherwise. */
  maxOutputBytes?: number;
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
  /**
   * `input` is written to the remote command's stdin: the only way a secret may reach the server
   * (never on the command line, which other users can see in the process list). `onLine` gets each
   * complete output line as it arrives (`--follow`), and `signal` stops the command.
   */
  run(command: string, options?: RemoteRunOptions): Promise<CommandResult>;
}

/** The options of {@link RemoteExec.run}. */
export interface RemoteRunOptions {
  timeoutMs?: number;
  input?: string;
  /** Called for every complete stdout/stderr line as it arrives. */
  onLine?: (stream: "stdout" | "stderr", line: string) => void;
  /** Stops the command (a followed log). */
  signal?: AbortSignal;
}

/**
 * A child process whose stdin and stdout are one byte stream, such as `ssh … docker system
 * dial-stdio` (the Docker API over SSH). Started by {@link StreamRunner.open}.
 */
export interface StreamProcess {
  /** The process's stdout as the readable side and its stdin as the writable side. */
  readonly stream: Duplex;
  /** Settles when the process exits: its exit code and the end of its stderr (bounded). */
  readonly exit: Promise<{ exitCode: number; stderr: string }>;
  /** Ends the process. */
  kill(): void;
}

/**
 * Starts a binary without a shell and hands back its stdin and stdout as one stream. Injected
 * like {@link CommandRunner}, so tests replace it with a fake.
 */
export interface StreamRunner {
  open(
    command: string,
    args: readonly string[],
    options?: { env?: Record<string, string | undefined>; signal?: AbortSignal },
  ): StreamProcess;
}

/** One request to the Docker Engine API (feature 023). */
export interface DockerRequest {
  method: "GET" | "HEAD" | "POST" | "PUT" | "DELETE";
  /** The API path with its query and without a version prefix, such as `/containers/json?all=1`. */
  path: string;
  headers?: Record<string, string>;
  /** A JSON body as text, or an archive as a stream (sent chunked). */
  body?: string | Readable;
  signal?: AbortSignal;
}

/** The answer to a {@link DockerRequest}; `body` streams, and the caller reads or drains it. */
export interface DockerResponse {
  status: number;
  headers: Record<string, string>;
  body: Readable;
}

/**
 * Carries Docker Engine API requests to one Docker host: over SSH (`docker system dial-stdio`) or
 * through Portainer's Docker proxy. `close` ends the connection when there is one.
 */
export interface DockerTransport {
  request(request: DockerRequest): Promise<DockerResponse>;
  close?(): Promise<void>;
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
