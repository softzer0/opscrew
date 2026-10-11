import { type ChildProcess, spawn } from "node:child_process";
import { accessSync, constants as fsConstants, statSync } from "node:fs";
import { constants as osConstants } from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { CommandOptions, CommandResult, CommandRunner } from "@opscrew/contracts";
import { OpsCrewError } from "./errors";

/** Exit code reported when a command is killed because it exceeded its timeout (as in `timeout(1)`). */
const TIMEOUT_EXIT_CODE = 124;
/** Largest delay `setTimeout` accepts. */
const MAX_TIMER_MS = 2_147_483_647;
/** After killing a process tree, how long to wait for its pipes to close before giving up on them. */
const KILL_GRACE_MS = 5_000;
const TRUNCATED_MARKER = "\n[output truncated]";

export interface NodeCommandRunnerOptions {
  /** Timeout for commands that do not pass `timeoutMs`. Default 600000 (10 minutes). */
  defaultTimeoutMs?: number;
  /** Maximum bytes kept per stream (stdout, stderr); the rest is dropped. Default 16 MiB. */
  maxOutputBytes?: number;
}

/** Collects one output stream with a byte cap and splits it into lines for `onLine`. */
class StreamCollector {
  private readonly chunks: Buffer[] = [];
  private bytes = 0;
  private truncated = false;
  private readonly decoder = new StringDecoder("utf8");
  private partial = "";

  constructor(
    private readonly maxBytes: number,
    private readonly onLine?: (line: string) => void,
  ) {}

  push(chunk: Buffer): void {
    if (!this.truncated) {
      const room = this.maxBytes - this.bytes;
      if (chunk.length <= room) {
        this.chunks.push(chunk);
        this.bytes += chunk.length;
      } else {
        this.chunks.push(chunk.subarray(0, room));
        this.bytes += room;
        this.truncated = true;
      }
    }
    if (this.onLine) this.emitLines(this.decoder.write(chunk));
  }

  finish(): string {
    if (this.onLine) {
      this.emitLines(this.decoder.end());
      if (this.partial !== "") this.emit(this.partial);
      this.partial = "";
    }
    const text = Buffer.concat(this.chunks).toString("utf8");
    return this.truncated ? text + TRUNCATED_MARKER : text;
  }

  private emitLines(text: string): void {
    const parts = (this.partial + text).split("\n");
    this.partial = parts.pop() ?? "";
    for (const line of parts) this.emit(line);
  }

  private emit(line: string): void {
    try {
      this.onLine?.(line.endsWith("\r") ? line.slice(0, -1) : line);
    } catch {
      // A failing progress callback must not break the command it reports on.
    }
  }
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The command was aborted.", "AbortError");
}

function spawnError(command: string, error: unknown): OpsCrewError {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT") {
    return new OpsCrewError(
      "COMMAND_FAILED",
      `Could not run ${command}: it is not installed or not on PATH.`,
      {
        hint: `Install ${path.basename(command)} (or add its folder to PATH), then try again.`,
        cause: error,
      },
    );
  }
  const reason = error instanceof Error ? error.message : String(error);
  return new OpsCrewError("COMMAND_FAILED", `Could not run ${command}: ${reason}`, {
    hint: "Check that the program exists and that you are allowed to run it, then try again.",
    cause: error,
  });
}

/** Kills `child` and everything it started. */
function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === "win32") {
    try {
      const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      killer.on("error", () => child.kill("SIGKILL"));
    } catch {
      child.kill("SIGKILL");
    }
    return;
  }
  try {
    // The child leads its own process group (spawned with `detached`), so -pid hits the tree.
    process.kill(-pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

function definedEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (value !== undefined) out[key] = value;
  return out;
}

/**
 * `CommandRunner` backed by `node:child_process.spawn` (no shell, hidden window on Windows).
 * Non-zero exit codes resolve normally; only a failure to start the program rejects
 * (`OpsCrewError` `COMMAND_FAILED`) and an abort through `signal` rejects with an `AbortError`.
 * On timeout the whole process tree is killed and the result has `timedOut: true`, exit code 124.
 */
export class NodeCommandRunner implements CommandRunner {
  private readonly defaultTimeoutMs: number;
  private readonly maxOutputBytes: number;

  constructor(options: NodeCommandRunnerOptions = {}) {
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 600_000;
    this.maxOutputBytes = options.maxOutputBytes ?? 16 * 1024 * 1024;
  }

  run(
    command: string,
    args: readonly string[],
    options: CommandOptions = {},
  ): Promise<CommandResult> {
    const { signal, onLine } = options;
    if (signal?.aborted) return Promise.reject(abortError(signal));

    return new Promise<CommandResult>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawn(command, [...args], {
          cwd: options.cwd,
          env: options.env ? definedEnv(options.env) : process.env,
          shell: false,
          windowsHide: true,
          // Own process group on POSIX so a timeout can kill grandchildren too.
          detached: process.platform !== "win32",
          stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        });
      } catch (error) {
        reject(spawnError(command, error));
        return;
      }

      const stdout = new StreamCollector(
        this.maxOutputBytes,
        onLine && ((line) => onLine(line, "stdout")),
      );
      const stderr = new StreamCollector(
        this.maxOutputBytes,
        onLine && ((line) => onLine(line, "stderr")),
      );
      child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));

      let settled = false;
      let timedOut = false;
      let aborted = false;
      let timer: NodeJS.Timeout | undefined;
      let graceTimer: NodeJS.Timeout | undefined;

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        if (graceTimer) clearTimeout(graceTimer);
        signal?.removeEventListener("abort", onAbort);
      };

      const terminate = () => {
        killTree(child);
        // If a descendant escaped the kill and still holds our pipes, stop waiting for them.
        graceTimer = setTimeout(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
        }, KILL_GRACE_MS);
        graceTimer.unref();
      };

      function onAbort() {
        if (settled || aborted) return;
        aborted = true;
        terminate();
      }

      child.on("error", (error) => {
        // Only spawn failures are fatal; errors after start (e.g. kill failures) are ignored.
        if (settled || child.pid !== undefined) return;
        settled = true;
        cleanup();
        reject(spawnError(command, error));
      });

      child.on("close", (code, killSignal) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (aborted && signal) {
          reject(abortError(signal));
          return;
        }
        const result: CommandResult = {
          exitCode: timedOut
            ? TIMEOUT_EXIT_CODE
            : (code ?? (killSignal ? 128 + (osConstants.signals[killSignal] ?? 0) : 1)),
          stdout: stdout.finish(),
          stderr: stderr.finish(),
        };
        if (timedOut) result.timedOut = true;
        resolve(result);
      });

      if (child.stdin) {
        child.stdin.on("error", () => {
          // The child may exit without reading its input (EPIPE); its exit code tells the story.
        });
        child.stdin.end(options.input);
      }

      const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        timer = setTimeout(
          () => {
            if (settled) return;
            timedOut = true;
            terminate();
          },
          Math.min(timeoutMs, MAX_TIMER_MS),
        );
      }
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

function lookupEnv(env: Record<string, string | undefined>, name: string): string | undefined {
  if (process.platform !== "win32") return env[name];
  // Windows environment names are case-insensitive (`Path`, `PATH`).
  const key = Object.keys(env).find((k) => k.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

function isExecutableFile(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    if (process.platform !== "win32") accessSync(file, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Finds `name` on `PATH` (on Windows also trying each `PATHEXT` extension, default
 * `.EXE;.CMD;.BAT`) and returns its absolute path, or `undefined` when it is not installed.
 * A name containing a path separator is checked directly.
 */
export function findExecutable(
  name: string,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const isWindows = process.platform === "win32";
  const extensions = isWindows
    ? (lookupEnv(env, "PATHEXT") || ".EXE;.CMD;.BAT")
        .split(";")
        .map((ext) => ext.trim())
        .filter((ext) => ext !== "")
    : [];
  const candidatesFor = (base: string): string[] => {
    if (!isWindows) return [base];
    const ext = path.extname(base).toUpperCase();
    if (ext !== "" && extensions.some((e) => e.toUpperCase() === ext)) return [base];
    return extensions.map((e) => base + e.toLowerCase());
  };

  if (name.includes("/") || (isWindows && name.includes("\\"))) {
    return candidatesFor(path.resolve(name)).find(isExecutableFile);
  }

  const dirs = (lookupEnv(env, "PATH") ?? "")
    .split(path.delimiter)
    .map((dir) => (isWindows ? dir.trim().replace(/^"(.*)"$/, "$1") : dir))
    .filter((dir) => dir !== "");
  for (const dir of dirs) {
    const found = candidatesFor(path.resolve(dir, name)).find(isExecutableFile);
    if (found !== undefined) return found;
  }
  return undefined;
}
