import type { CommandResult, CommandRunner, RemoteExec } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { pipedScript } from "./shell";

/**
 * A {@link RemoteExec} for the localhost target: it runs each command on this computer, as the
 * user, by piping it to `<shell> -s` (`sh` on macOS and Linux, Git for Windows' `bash.exe` on
 * Windows) the way SSH pipes long commands, with `OPSCREW_APPS_DIR` and `OPSCREW_EDGE_DIR` set to
 * `<homeDir>/local/srv/apps` and `…/edge` in forward-slash form (`D:/…` on Windows), and with Git
 * for Windows' path conversion off (`MSYS_NO_PATHCONV`, `MSYS2_ARG_CONV_EXCL`). It never uses
 * sudo, and refuses a command that would.
 */
export function localExec(deps: {
  runner: CommandRunner;
  shell: string;
  env: NodeJS.ProcessEnv;
  /** OpsCrew's home on this computer (`ProjectPaths.homeDir`). */
  homeDir: string;
}): RemoteExec {
  const srv = `${deps.homeDir.replaceAll("\\", "/")}/local/srv`;
  const env = {
    ...deps.env,
    OPSCREW_APPS_DIR: `${srv}/apps`,
    OPSCREW_EDGE_DIR: `${srv}/edge`,
    // Git for Windows' bash would otherwise rewrite arguments such as /api/health into Windows
    // paths for the programs it starts; other shells ignore these.
    MSYS_NO_PATHCONV: "1",
    MSYS2_ARG_CONV_EXCL: "*",
  };
  return {
    host: "localhost",
    async run(command, options = {}): Promise<CommandResult> {
      if (/^\s*sudo\b/.test(command)) {
        throw new OpsCrewError("INTERNAL", "OpsCrew never runs anything as root on this computer.");
      }
      // The script goes on the shell's stdin, with `input` piped into it (see `pipedScript`).
      return deps.runner.run(deps.shell, ["-s"], {
        env,
        input: pipedScript(command, options.input),
        ...(options.timeoutMs !== undefined && { timeoutMs: options.timeoutMs }),
      });
    },
  };
}
