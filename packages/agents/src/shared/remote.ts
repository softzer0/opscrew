import type { CommandResult, CommandRunner, RemoteExec } from "@opscrew/contracts";

export interface SshRemoteExecOptions {
  host: string;
  user?: string;
  keyFile: string;
  knownHostsFile: string;
  runner: CommandRunner;
  port?: number;
}

/** `ssh` arguments shared by every OpsCrew connection: key only, pinned host key, no prompts. */
export function sshArgs(options: Omit<SshRemoteExecOptions, "runner">): string[] {
  return [
    "-i",
    options.keyFile,
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    `UserKnownHostsFile=${options.knownHostsFile}`,
    "-o",
    "ConnectTimeout=10",
    "-p",
    String(options.port ?? 22),
    `${options.user ?? "deploy"}@${options.host}`,
  ];
}

/**
 * Runs commands on the server over SSH as the unprivileged deploy user. The host key must already
 * be pinned in `knownHostsFile` (see `pinHostKey`); unknown or changed keys are refused by ssh.
 * On Windows, OpenSSH requires the key file to be readable only by the current user — files that
 * OpsCrew creates under the user profile satisfy that.
 */
export class SshRemoteExec implements RemoteExec {
  readonly host: string;
  readonly #options: SshRemoteExecOptions;

  constructor(options: SshRemoteExecOptions) {
    this.host = options.host;
    this.#options = options;
  }

  run(command: string, options: { timeoutMs?: number } = {}): Promise<CommandResult> {
    const { runner, ...rest } = this.#options;
    return runner.run("ssh", [...sshArgs(rest), command], {
      timeoutMs: options.timeoutMs ?? 60_000,
    });
  }
}
