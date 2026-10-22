import { runnerDir } from "./constants";
import { shellQuote } from "./shell";

/**
 * The systemd user unit OpsCrew writes for `app`'s runner (deploy's `runnerUnit(app)`).
 *
 * `run.sh` runs through `sg docker`, so the runner and its jobs have the docker group from
 * /etc/group whatever groups deploy's user manager has: the manager keeps the groups it started
 * with, so one started before deploy joined docker (a login while the server was being set up)
 * gives its services no docker group, and on a server OpsCrew created only root could restart it.
 * deploy is a member, so `sg` asks no password.
 *
 * A stop signals every process of the unit (`KillMode=control-group`): `sg` runs the command in a
 * child of its own and passes no signal on, so a stop of its process alone would leave the runner
 * running. The runner's listener stops on SIGTERM.
 */
export function runnerUnitText(app: string): string {
  const command = `exec ${shellQuote(`${runnerDir(app)}/run.sh`)}`;
  // One double-quoted word for systemd: \ and " escaped, % (its specifiers) and $ (its variables)
  // doubled.
  const word = `"${command.replace(/[\\"]/g, "\\$&").replace(/[%$]/g, "$&$&")}"`;
  return [
    "[Unit]",
    `Description=GitHub Actions runner of ${app} (OpsCrew)`,
    "",
    "[Service]",
    `ExecStart=/usr/bin/sg docker -c ${word}`,
    `WorkingDirectory=${runnerDir(app)}`,
    "Restart=always",
    "RestartSec=5",
    "KillMode=control-group",
    "KillSignal=SIGTERM",
    "TimeoutStopSec=5min",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}
