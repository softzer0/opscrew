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
    return runner.run("ssh", [...sshArgs(rest), command], {
      timeoutMs: options.timeoutMs ?? 60_000,
      ...(options.input === undefined ? {} : { input: options.input }),
    });
  }
}
