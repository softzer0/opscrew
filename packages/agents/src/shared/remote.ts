import type { CommandResult, CommandRunner, RemoteExec } from "@opscrew/contracts";

export interface SshRemoteExecOptions {
  host: string;
  /** Login name (default `deploy`); a server the user owns uses the recorded admin login. */
  user?: string;
  /**
   * Private key file (`-i`, with `IdentitiesOnly=yes`). Absent: the SSH agent offers the key (no
   * `-i`, so a key the agent holds, even one with a passphrase, is used as is).
   */
  keyFile?: string;
  knownHostsFile: string;
  runner: CommandRunner;
  port?: number;
  /**
   * Never reuse an existing SSH connection (`ControlMaster=no`, `ControlPath=none`), even when the
   * user's own SSH configuration multiplexes connections: every command is a real, new login.
   * Needed to prove that logins still work after an SSH or firewall change.
   */
  fresh?: boolean;
  /** Seconds between keep-alive probes (`ServerAliveInterval`), for long commands behind NAT. */
  keepAliveSeconds?: number;
}

/**
 * `ssh` arguments shared by every OpsCrew connection: key only (a key file, or the SSH agent),
 * pinned host key, no prompts. Options a caller does not set add no arguments, so the deploy
 * user's connections stay exactly as they were.
 */
export function sshArgs(options: Omit<SshRemoteExecOptions, "runner">): string[] {
  const identity =
    options.keyFile === undefined ? [] : ["-i", options.keyFile, "-o", "IdentitiesOnly=yes"];
  const fresh = options.fresh === true ? ["-o", "ControlMaster=no", "-o", "ControlPath=none"] : [];
  const keepAlive =
    options.keepAliveSeconds === undefined
      ? []
      : [
          "-o",
          `ServerAliveInterval=${Math.max(1, Math.round(options.keepAliveSeconds))}`,
          "-o",
          "ServerAliveCountMax=4",
        ];
  return [
    ...identity,
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    `UserKnownHostsFile=${options.knownHostsFile}`,
    "-o",
    "ConnectTimeout=10",
    ...fresh,
    ...keepAlive,
    "-p",
    String(options.port ?? 22),
    `${options.user ?? "deploy"}@${options.host}`,
  ];
}

/**
 * Runs commands on the server over SSH, as the unprivileged deploy user unless another login is
 * given (a server the user owns: the recorded admin login, with a key file or the SSH agent). The
 * host key must already be pinned in `knownHostsFile` (see `pinHostKey` and `connectOwnServer`);
 * unknown or changed keys are refused by ssh. On Windows, OpenSSH requires the key file to be
 * readable only by the current user — files that OpsCrew creates under the user profile satisfy that.
 */
export class SshRemoteExec implements RemoteExec {
  readonly host: string;
  readonly #options: SshRemoteExecOptions;

  constructor(options: SshRemoteExecOptions) {
    this.host = options.host;
    this.#options = options;
  }

  run(
    command: string,
    options: { timeoutMs?: number; input?: string } = {},
  ): Promise<CommandResult> {
    const { runner, ...rest } = this.#options;
    const sent = remoteInvocation(command, options.input);
    return runner.run("ssh", [...sshArgs(rest), sent.command], {
      timeoutMs: options.timeoutMs ?? 60_000,
      ...(sent.input === undefined ? {} : { input: sent.input }),
    });
  }
}

/**
 * Longest command (UTF-8 bytes) sent on the ssh command line. Longer ones, and any with a
 * newline, go over stdin: Git for Windows' `ssh` (an MSYS program) receives only about 8 KiB of a
 * command-line argument and native Windows OpenSSH about 32 KiB.
 */
export const MAX_INLINE_COMMAND_BYTES = 2_000;

/**
 * The short POSIX command line that runs a command arriving on stdin: it copies exactly `bytes`
 * bytes into a private temporary file (`dd bs=1` never reads past them, so the caller's `input`
 * that follows stays on stdin for the command and never touches the file), refuses to run a
 * command that arrived short (exit 125), runs it with `sh`, keeps its exit code and removes the
 * file in every case.
 */
export function stdinBootstrap(bytes: number): string {
  return (
    "umask 077; f=$(mktemp) || exit 125; trap 'rm -f \"$f\"' EXIT HUP INT TERM; " +
    `dd bs=1 count=${bytes} of="$f" 2>/dev/null; ` +
    `[ $(wc -c < "$f") -eq ${bytes} ] || ` +
    '{ echo "opscrew: the command did not arrive in full" >&2; exit 125; }; ' +
    'sh "$f"; exit $?'
  );
}

/**
 * What goes on the ssh command line and stdin for `command` with optional stdin `input`. Short
 * single-line commands are sent as they are; others become `stdinBootstrap` with the command's
 * bytes on stdin, followed by `input`.
 */
export function remoteInvocation(
  command: string,
  input?: string,
): { command: string; input?: string } {
  const bytes = Buffer.byteLength(command, "utf8");
  if (bytes <= MAX_INLINE_COMMAND_BYTES && !command.includes("\n")) {
    return input === undefined ? { command } : { command, input };
  }
  return { command: stdinBootstrap(bytes), input: command + (input ?? "") };
}
