import {
  type AddRunnerHostInput,
  addRunnerHost,
  applyRunnerHost,
  listRunnerHosts,
  removeRunnerHost,
  startLocalRunner,
} from "@opscrew/agents";
import { OpsCrewError } from "@opscrew/core";
import type { Command } from "commander";
import { checkConfirmName, FlagConfirmation } from "../approval";
import type { CliContext } from "../context";
import { createPhaseDeps, servicesOf } from "../deps";
import { addEnvOption, chooseEnvironment } from "../ui/environment";
import { textTable } from "../ui/output";
import { checkApproveFlags } from "./provision";

/** The add command with its login, for the hints. */
const addCommand = (name: string) => `opscrew runner host add ${name} --ssh <user@host[:port]>`;

/**
 * `--ssh user@host[:port]` as `addRunnerHost`'s login (an IPv6 address in brackets:
 * `ana@[fd00::1]:22`). The user and host are checked by `addRunnerHost`.
 * @throws OpsCrewError `INVALID_INPUT` for another shape or a port outside 1–65535.
 */
export function sshLogin(text: string): AddRunnerHostInput["ssh"] {
  const match = /^([^@\s]+)@(\[[^\]\s]+\]|[^:@[\]\s]+)(?::(\d+))?$/.exec(text.trim());
  const port = match?.[3] === undefined ? undefined : Number(match[3]);
  if (match === null || (port !== undefined && (port < 1 || port > 65535))) {
    // The login is not repeated: it names the machine's address.
    throw new OpsCrewError("INVALID_INPUT", "--ssh expects user@host or user@host:port.", {
      hint: "For example --ssh ana@192.168.1.30 or --ssh ana@build-box.lan:2222; an IPv6 address goes in brackets, --ssh ana@[fd00::30]:22.",
    });
  }
  return {
    user: match[1] as string,
    host: match[2] as string,
    ...(port === undefined ? {} : { port }),
  };
}

/**
 * `--approve <hash>` (provision's check, with `--host-key`'s), trimmed; `shows` is the command
 * that prints the host plan's hash.
 */
function approvedHash(
  command: string,
  flags: { approve?: string; hostKey?: string },
  shows: string,
): string | undefined {
  return checkApproveFlags(
    command,
    {
      ...(flags.approve === undefined ? {} : { approve: [flags.approve] }),
      ...(flags.hostKey === undefined ? {} : { hostKey: flags.hostKey }),
    },
    shows,
  )[0];
}

interface AddFlags {
  ssh?: string;
  key?: string;
  hostKey?: string;
  approve?: string;
}

/**
 * `opscrew runner host add <name>`: with `--ssh`, connects (the host key confirmed at first
 * contact, or `--host-key` in a script), inspects and records the machine; then shows its host
 * plan (Docker and the deploy user) and applies it once approved by its hash: in a terminal by
 * the prompt, in a script by `--approve <hash>`, which alone applies the recorded machine's plan.
 */
async function add(ctx: CliContext, name: string, flags: AddFlags): Promise<void> {
  const approve = approvedHash("runner host add", flags, addCommand(name));
  if (flags.ssh === undefined && approve === undefined) {
    throw new OpsCrewError("INVALID_INPUT", "Adding a runner machine needs its SSH login.", {
      hint: `Run \`${addCommand(name)}\`, with --key <file> unless the key is in your SSH agent.`,
    });
  }
  const deps = createPhaseDeps(ctx, {
    ai: false,
    approveHashes: approve === undefined ? [] : [approve],
  });
  const machine = servicesOf(ctx).runnerHost?.machine;
  const services = machine === undefined ? {} : { services: machine };
  let hash = approve;
  if (flags.ssh !== undefined) {
    const hostKey = flags.hostKey?.trim();
    const added = await addRunnerHost(deps, {
      name,
      ssh: sshLogin(flags.ssh),
      ...(flags.key === undefined ? {} : { keyFile: flags.key }),
      ...(hostKey === undefined ? {} : { hostKey }),
      ...services,
    });
    hash ??= added.hash;
  }
  await applyRunnerHost(deps, { name, approvedHash: hash as string, ...services });
}

interface RemoveFlags {
  confirm?: string;
  approve?: string;
}

/**
 * `opscrew runner host remove <name>`: refused while an environment uses the machine; otherwise
 * shows the plan that takes back what OpsCrew set up there and applies it once the machine's name
 * is typed back (a terminal), or with `--approve <hash> --confirm <name>` (a script). A machine
 * OpsCrew cannot reach is forgotten once its name is typed (`--confirm <name>` alone in a script).
 */
async function remove(ctx: CliContext, name: string, flags: RemoveFlags): Promise<void> {
  const command = `opscrew runner host remove ${name}`;
  const confirm = flags.confirm?.trim();
  checkConfirmName(
    confirm,
    name,
    "the runner machine's name",
    `In a script, run \`${command} --approve <hash> --confirm ${name}\`.`,
  );
  const approve = approvedHash("runner host remove", flags, command);
  const hashes = approve === undefined ? [] : [approve];
  const deps = createPhaseDeps(ctx, {
    ai: false,
    approveHashes: hashes,
    wrapApprovals: (base, clock) =>
      new FlagConfirmation(base, {
        kinds: ["host-apply", "github-settings"],
        what: `removing the runner machine ${name}`,
        app: name,
        confirmed: confirm !== undefined,
        hashes,
        interactive: ctx.isInteractive,
        print: ctx.stdout,
        clock,
      }),
  });
  const runnerHost = servicesOf(ctx).runnerHost;
  await removeRunnerHost(deps, {
    name,
    ...(approve === undefined ? {} : { approvedHash: approve }),
    ...(runnerHost?.machine === undefined ? {} : { services: runnerHost.machine }),
    ...(runnerHost?.github === undefined ? {} : { runnerGitHub: runnerHost.github }),
  });
}

/** `opscrew runner host list`: the runner machines this computer knows for the project. */
async function list(ctx: CliContext): Promise<void> {
  const machines = await listRunnerHosts(createPhaseDeps(ctx, { ai: false }));
  if (machines.length === 0) {
    ctx.stdout(
      `This computer knows no runner machine for this project. Add one with \`${addCommand("<name>")}\`.\n`,
    );
    return;
  }
  const rows = [
    ["Machine", "CPU", "Docker", "Environments"],
    ...machines.map((machine) => [
      machine.name,
      machine.arch,
      machine.docker ? "yes" : "not yet",
      machine.environments.length === 0 ? "none" : machine.environments.join(", "),
    ]),
  ];
  ctx.stdout(`${textTable(rows)}\n`);
}

/**
 * `opscrew runner start [--env <name>]`: runs GitHub's self-hosted runner for an environment on
 * this computer (`environment.runner: local`) in the foreground, so its deploy job deploys to the
 * local stack. It registers the runner, runs one job at a time and registers it again; Ctrl+C
 * stops it gracefully (a running job may finish first) and removes it from GitHub.
 *
 * `opscrew runner host add|remove|list`: runner machines (`environment.runner: host`), machines of
 * the user's that run the deploy jobs, and builds, of the environments that choose them.
 */
export function register(program: Command, ctx: CliContext): void {
  const runner = program
    .command("runner")
    .description(
      "Run an environment's self-hosted GitHub Actions runner on this computer, or set up a runner machine of yours",
    );
  const start = runner
    .command("start")
    .description(
      "Start the runner in the foreground until Ctrl+C, which stops it and removes it from GitHub",
    );
  addEnvOption(start).action(async (flags: { env?: string }) => {
    const { name } = await chooseEnvironment(ctx, flags.env, "runner start");
    const services = servicesOf(ctx).localRunner;
    const local = await startLocalRunner(createPhaseDeps(ctx, { ai: false, environment: name }), {
      environment: name,
      ...(services === undefined ? {} : { services }),
    });
    await local.finished;
  });

  const host = runner
    .command("host")
    .description(
      "Add, remove or list runner machines: machines of yours (a home server, a spare PC, a VM) that run environments' deploy jobs and builds",
    );
  host
    .command("add")
    .description(
      "Set up a machine you reach over SSH as a runner machine: OpsCrew installs Docker and the deploy user after you approve its host plan",
    )
    .argument("<name>", "The machine's name in the project, for example home or build-box")
    .option("--ssh <login>", "user@host or user@host:port: root or a user with passwordless sudo")
    .option("--key <file>", "Your private SSH key file (default: the key in your SSH agent)")
    .option(
      "--host-key <fingerprint>",
      "Trust this SSH host key fingerprint (SHA256:…) on the first connection, for scripts; check it on the machine first",
    )
    .option(
      "--approve <hash>",
      "In a script, apply exactly the machine's host plan with this hash (shown by an earlier run)",
    )
    .action((name: string, flags: AddFlags) => add(ctx, name, flags));
  host
    .command("remove")
    .description(
      "Take back what OpsCrew set up on a runner machine and forget it; refused while an environment uses it",
    )
    .argument("<name>", "The runner machine")
    .option("--confirm <name>", "The machine's name, to remove it without a prompt (scripts)")
    .option(
      "--approve <hash>",
      "In a script, apply exactly the removal plan with this hash (shown by an earlier run)",
    )
    .action((name: string, flags: RemoveFlags) => remove(ctx, name, flags));
  host
    .command("list")
    .description("List the runner machines this computer knows and the environments on each")
    .action(() => list(ctx));
}
