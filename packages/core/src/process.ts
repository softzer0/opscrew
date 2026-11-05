import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { constants as osConstants } from "node:os";
import path from "node:path";
import { Duplex } from "node:stream";
import type { StreamProcess, StreamRunner } from "@opscrew/contracts";
import { OpsCrewError } from "./errors";

/** How much of a process's stderr {@link NodeStreamRunner} keeps: the end, where it says why. */
const STDERR_TAIL_BYTES = 16 * 1024;
/**
 * After the process exits, how long its stderr may take to close. A descendant that outlives it
 * (an SSH ControlPersist master) can hold stderr open for minutes.
 */
const STDERR_GRACE_MS = 2_000;

/**
 * Why `command` could not start. Node's own error stays out, even as the cause: its message can
 * quote an argument or an environment value, and its `spawnargs` hold the arguments.
 */
function startError(command: string, code: string | undefined): OpsCrewError {
  if (code === "ENOENT") {
    return new OpsCrewError(
      "COMMAND_FAILED",
      `Could not run ${command}: it is not installed or not on PATH.`,
      { hint: `Install ${path.basename(command)} (or add its folder to PATH), then try again.` },
    );
  }
  return new OpsCrewError(
    "COMMAND_FAILED",
    `Could not run ${command}${code ? ` (${code})` : ""}.`,
    {
      hint: "Check that the program exists and that you are allowed to run it, then try again.",
    },
  );
}

/**
 * The process's stdout and stdin as one Duplex. Unlike `Duplex.from`, it ends quietly when the
 * process exits (Node then closes stdin), and fails only when a write or a read does.
 */
function processStream({ stdout, stdin }: ChildProcessWithoutNullStreams): Duplex {
  const stream = new Duplex({
    read: () => {
      stdout.resume();
    },
    write: (chunk, encoding, callback) => {
      stdin.write(chunk, encoding, callback);
    },
    final: (callback) => {
      stdin.end(callback);
    },
    destroy: (error, callback) => {
      stdout.destroy();
      stdin.destroy();
      callback(error);
    },
  });
  stdout.on("data", (chunk: Buffer) => {
    if (!stream.push(chunk)) stdout.pause();
  });
  stdout.on("end", () => stream.push(null));
  stdout.on("error", (error) => stream.destroy(error));
  stdin.on("error", (error) => stream.destroy(error));
  return stream;
}

/**
 * `StreamRunner` backed by `node:child_process.spawn` (no shell, a hidden window on Windows). The
 * stream is the process's stdout and stdin; stderr keeps its last 16 KiB. `exit` resolves with the
 * exit code (128 + the signal's number when a signal ended the process) once the process has
 * exited and its stderr closed, at most 2 s later. When the program can't start, `open` throws, or `exit` rejects and the stream fails, with
 * a `COMMAND_FAILED` error that names only the command.
 */
export class NodeStreamRunner implements StreamRunner {
  open(
    command: string,
    args: readonly string[],
    options: { env?: Record<string, string | undefined>; signal?: AbortSignal } = {},
  ): StreamProcess {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(command, [...args], {
        env: options.env ?? process.env,
        signal: options.signal,
        shell: false,
        windowsHide: true,
      });
    } catch (error) {
      throw startError(command, (error as NodeJS.ErrnoException).code);
    }
    const stream = processStream(child);
    let stderr = Buffer.alloc(0);
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = Buffer.concat([stderr, chunk]).subarray(-STDERR_TAIL_BYTES);
    });
    const exit = new Promise<{ exitCode: number; stderr: string }>((resolve, reject) => {
      child.on("error", (error: NodeJS.ErrnoException) => {
        // Once started, errors come from a kill or an abort, and `close` reports the exit.
        if (child.pid !== undefined) return;
        const failure = startError(command, error.code);
        stream.destroy(failure);
        reject(failure);
      });
      child.on("exit", (code, signal) => {
        const settle = () => {
          clearTimeout(grace);
          child.stderr.destroy();
          resolve({
            exitCode: code ?? 128 + (signal ? osConstants.signals[signal] : 0),
            stderr: stderr.toString("utf8"),
          });
        };
        // The rest of stderr arrives when it closes, or is given up after the grace.
        const grace = setTimeout(settle, STDERR_GRACE_MS);
        child.once("close", settle);
      });
    });
    // A caller that reads only the stream learns of a failed start there, not as a crash.
    exit.catch(() => {});
    return {
      stream,
      exit,
      kill: () => {
        child.kill();
      },
    };
  }
}
