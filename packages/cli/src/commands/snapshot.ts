import {
  deleteSnapshot,
  listSnapshots,
  type OffsiteProvider,
  type SnapshotSettingChange,
  snapshotListLines,
  snapshotOffsiteOff,
  snapshotOffsiteOn,
  snapshotScheduleOff,
  snapshotScheduleOn,
  takeServerSnapshot,
  takeSnapshot,
} from "@opscrew/agents";
import { isUserFacingError, OpsCrewError } from "@opscrew/core";
import { Argument, type Command, InvalidArgumentError, Option } from "commander";
import { checkConfirmName, FlagConfirmation, withAllowDowntime } from "../approval";
import type { CliContext } from "../context";
import { createPhaseDeps, servicesOf } from "../deps";
import { quietReporter } from "../reporter";
import { collect, runPhaseCommand } from "../ui/deploy";
import { type AppEnvFlags, addEnvOption, chooseEnvironment } from "../ui/environment";
import { printNextSteps } from "../ui/output";
import { readKeyFile } from "./restore";

interface TakeFlags extends AppEnvFlags {
  /** `--skip <service>`, repeatable: services left out of the data snapshot. */
  skip?: string[];
  /** `--allow-downtime`: in a script, approve stopping a service (or the server) for its copy. */
  allowDowntime?: boolean;
  /** `--server`: the provider's snapshot of the whole server instead of the data. */
  server?: boolean;
  /** `--stop`, with `--server`: shut the server down for it. */
  stop?: boolean;
  /** `--server-name <name>`, with `--server`: one of the app's extra servers. */
  serverName?: string;
}

interface ScheduleFlags extends AppEnvFlags {
  every?: string;
  keep?: number;
  /** `--stop <service>`, repeatable. */
  stop?: string[];
}

interface OffsiteFlags extends AppEnvFlags {
  to?: OffsiteProvider;
  region?: string;
  days?: number;
}

/** `--app`/`--env` as the user gave them, for the hints of a refusal before any work. */
function givenFlags(flags: AppEnvFlags): string {
  return `${flags.app === undefined ? "" : ` --app ${flags.app.trim()}`}${flags.env === undefined ? "" : ` --env ${flags.env.trim()}`}`;
}

/** Commander's parser of a whole number from 1 up (`--keep`, `--days`). */
function wholeNumber(value: string): number {
  const number = Number(value.trim());
  if (!Number.isInteger(number) || number < 1) {
    throw new InvalidArgumentError("Give a whole number from 1 up.");
  }
  return number;
}

/**
 * Refuses `opscrew snapshot` flags that don't go together, before any work (exit code 2):
 * `--stop` and `--server-name` belong to `--server`, `--skip` to the data snapshot.
 */
function checkTakeFlags(flags: TakeFlags): void {
  const command = `opscrew snapshot${givenFlags(flags)}`;
  if (flags.server !== true && (flags.stop === true || flags.serverName !== undefined)) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      "--stop and --server-name go only with --server: they shut down or pick the server whose whole-disk snapshot the provider takes.",
      { hint: `Run \`${command} --server --stop\`, or \`${command}\` for a snapshot of the data.` },
    );
  }
  if (flags.server === true && (flags.skip ?? []).length > 0) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      "--skip goes only with a snapshot of the data: a whole-server snapshot holds the server's whole disk.",
      { hint: `Run \`${command} --skip <service>\`, or \`${command} --server\` without --skip.` },
    );
  }
}

/** Advice when a script's run refused stopping a service (or the server) for its copy. */
function downtimeHint(ctx: CliContext, flags: TakeFlags): (error: unknown) => string | undefined {
  return (error) =>
    !ctx.isInteractive &&
    flags.allowDowntime !== true &&
    isUserFacingError(error) &&
    error.code === "APPROVAL_REFUSED"
      ? "This run is not interactive: add --allow-downtime to approve the stop the summary names."
      : undefined;
}

/** `opscrew snapshot [--server]`: takes the snapshot, then says what comes next. */
async function take(ctx: CliContext, flags: TakeFlags): Promise<void> {
  checkTakeFlags(flags);
  const { app, name, flag } = await chooseEnvironment(ctx, flags, "snapshot");
  const deps = createPhaseDeps(ctx, {
    ai: false,
    app,
    environment: name,
    // A stop for the copy is a maintenance window: `--allow-downtime` approves it in a script.
    wrapApprovals: (base, clock) => withAllowDowntime(ctx, flags.allowDowntime, base, clock),
  });
  const services = servicesOf(ctx).snapshot;
  if (flags.server === true) {
    const serverName = flags.serverName?.trim();
    const taken = await takeServerSnapshot(deps, {
      ...(serverName === undefined ? {} : { serverName }),
      ...(flags.stop === true ? { stop: true } : {}),
      ...(services === undefined ? {} : { services }),
    });
    printNextSteps(ctx, [
      `\`opscrew restore --server ${taken.id}${flag}\` rebuilds the server from it, after you type its name.`,
    ]);
    return;
  }
  const skip = (flags.skip ?? []).map((service) => service.trim());
  const taken = await takeSnapshot(deps, {
    ...(skip.length === 0 ? {} : { skip }),
    ...(services === undefined ? {} : { services }),
  });
  printNextSteps(ctx, [
    `\`opscrew snapshot list${flag}\` lists it; \`opscrew restore ${taken.id}${flag}\` puts its data back, after you type the app's name.`,
  ]);
}

/** Prints what `snapshot schedule|offsite on|off` changed, and what to run next. */
function printChange(ctx: CliContext, change: SnapshotSettingChange): void {
  ctx.stdout(`${change.lines.join("\n")}\n`);
}

/**
 * Refuses `snapshot <setting> off` (`schedule`, `offsite`) with flags of `on` (exit code 2): `off`
 * takes none. `given` holds the `--app`/`--env` flags the user gave, for the hint.
 */
function checkOff(setting: string, given: string, flags: readonly [boolean, string][]): void {
  const extra = flags.filter(([set]) => set).map(([, name]) => name);
  if (extra.length === 0) return;
  throw new OpsCrewError(
    "INVALID_INPUT",
    `\`opscrew snapshot ${setting} off\` takes no ${extra.join(", ")}: they say how \`${setting} on\` works.`,
    { hint: `Run \`opscrew snapshot ${setting} off${given}\` alone.` },
  );
}

/** The command's line in `opscrew --help`, and the first line of its own help. */
const SUMMARY =
  "Take a snapshot of an environment's data (or with --server of its whole server), list or delete snapshots, and turn scheduled snapshots and their encrypted copy off the server on or off";

/**
 * `opscrew snapshot` (feature 024, US1, US2, US4–US6), through the agents' snapshot commands:
 * - `opscrew snapshot [--skip <service>]...`: a data snapshot of every service with data and the
 *   app's SQLite files, filed where the data lives. A service with no online copy stops alone for
 *   its copy after an approval like a maintenance window's (`--allow-downtime` in a script).
 * - `opscrew snapshot --server [--stop] [--server-name <name>]`: the provider's snapshot of the
 *   whole server (Hetzner, DigitalOcean); `--stop` shuts it down for it, approved the same way.
 * - `snapshot list [--json]`: every snapshot, read-only.
 * - `snapshot delete <id>`: destroy-grade, the id typed (`--confirm <id>` in a script), never
 *   `--yes`.
 * - `snapshot schedule on|off` and `snapshot offsite on|off`: only the plan changes; `opscrew
 *   provision` then shows and applies it.
 * Exit codes: 0 done, 1 refused or not approved, 2 error.
 */
export function register(program: Command, ctx: CliContext): void {
  const snapshot = program
    .command("snapshot")
    .summary(SUMMARY)
    .description(
      [
        SUMMARY,
        "",
        "PostgreSQL, MySQL, MariaDB, MongoDB, SQLite, Valkey, Redis and Dragonfly are copied while",
        "they run. Every other service with data stops alone for its copy and starts again, after",
        "you approve it (in a script: --allow-downtime). Snapshots stay on the machine that holds",
        "the data; `snapshot offsite on` also keeps an encrypted copy in a bucket of its own.",
      ].join("\n"),
    )
    // Options after a subcommand's name are the subcommand's (`snapshot schedule on --stop kafka`).
    .enablePositionalOptions()
    .option(
      "--skip <service>",
      "Leave this service out of the snapshot (repeat for several)",
      collect,
    )
    .option(
      "--allow-downtime",
      "In a script: approve stopping the services the summary names (or the server, with --server --stop) for their copy",
    )
    .option(
      "--server",
      "A snapshot of the whole server at its provider (Hetzner, DigitalOcean), taken while it runs",
    )
    .option("--stop", "With --server: shut the server down for the snapshot, then start it again")
    .option("--server-name <name>", "With --server: one of the app's extra servers, by its name");
  addEnvOption(snapshot)
    .addHelpText(
      "after",
      [
        "",
        "  opscrew snapshot --env staging            the data of staging, now",
        "  opscrew snapshot --skip kafka             everything but kafka",
        "  opscrew snapshot list                     every snapshot, newest first",
        "  opscrew snapshot delete <id>              delete one, after you type its id",
        "  opscrew snapshot schedule on --every daily   scheduled snapshots, from the next provision",
        "  opscrew snapshot offsite on --to r2       an encrypted copy of each in a bucket",
        "  opscrew restore <id>                      put a snapshot's data back",
      ].join("\n"),
    )
    .action((flags: TakeFlags) =>
      runPhaseCommand(ctx, () => take(ctx, flags), downtimeHint(ctx, flags)),
    );

  addEnvOption(
    snapshot
      .command("list")
      .description(
        "List the environment's snapshots, newest first: on its servers, this computer or your Portainer, whole-server ones at the provider, and the copies only the off-server bucket still holds (changes nothing)",
      )
      .option("--json", "Print the snapshots as JSON")
      .option(
        "--key <file>",
        "The file with your age key: the copies only the off-server bucket holds are then listed with their details",
      ),
  ).action(async (flags: AppEnvFlags & { json?: boolean; key?: string }) => {
    const json = flags.json === true;
    const identity = flags.key === undefined ? undefined : await readKeyFile(ctx, flags.key);
    const { app, name } = await chooseEnvironment(ctx, flags, "snapshot list");
    // Progress is dropped for `--json` so stdout holds only the snapshots; problems go to stderr.
    const deps = createPhaseDeps(ctx, {
      ai: false,
      app,
      environment: name,
      ...(json ? { reporter: quietReporter(ctx.reporter) } : {}),
    });
    const services = servicesOf(ctx).snapshot;
    const snapshots = await listSnapshots(deps, {
      ...(identity === undefined ? {} : { identity }),
      ...(services === undefined ? {} : { services }),
    });
    ctx.stdout(
      json
        ? `${JSON.stringify({ snapshots }, null, 2)}\n`
        : `${snapshotListLines(snapshots).join("\n")}\n`,
    );
  });

  addEnvOption(
    snapshot
      .command("delete")
      .description(
        "Delete a snapshot for good, where it is (a whole-server one at its provider) and its copy in the off-server bucket, after you type its id",
      )
      .argument("<id>", "The snapshot's id, as `opscrew snapshot list` shows it")
      .option("--confirm <id>", "In a script: the snapshot's id, typed to approve its deletion"),
  ).action(async (id: string, flags: AppEnvFlags & { confirm?: string }) => {
    const wanted = id.trim();
    const confirm = flags.confirm?.trim();
    checkConfirmName(
      confirm,
      wanted,
      "the snapshot's id",
      `Give --confirm ${wanted}, the id of the snapshot to delete.`,
    );
    const { app, name } = await chooseEnvironment(ctx, flags, "snapshot delete");
    const deps = createPhaseDeps(ctx, {
      ai: false,
      app,
      environment: name,
      // Destroy-grade: the id typed, or `--confirm <id>`; `--yes` never approves it.
      wrapApprovals: (base, clock) =>
        new FlagConfirmation(base, {
          kinds: ["remote-exec"],
          what: "deleting a snapshot",
          names: confirm === undefined ? [] : [confirm],
          hashes: [],
          interactive: ctx.isInteractive,
          print: ctx.stdout,
          clock,
        }),
    });
    const services = servicesOf(ctx).snapshot;
    await deleteSnapshot(deps, wanted, services === undefined ? {} : { services });
  });

  const schedule = snapshot
    .command("schedule")
    .description(
      "Turn scheduled snapshots of the environment's data on or off in the plan; `opscrew provision` then sets them up or removes them",
    );
  addEnvOption(
    schedule
      .addArgument(new Argument("<on|off>", "Turn them on or off").choices(["on", "off"]))
      .option("--every <when>", "How often: daily, weekly (the default) or <n>h, such as 6h")
      .option("--keep <n>", "How many scheduled snapshots stay (default 4)", wholeNumber)
      .option(
        "--stop <service>",
        "Also copy this service, which stops alone for its copy (repeat for several; left out otherwise)",
        collect,
      ),
  ).action(async (state: "on" | "off", flags: ScheduleFlags) => {
    if (state === "off") {
      checkOff("schedule", givenFlags(flags), [
        [flags.every !== undefined, "--every"],
        [flags.keep !== undefined, "--keep"],
        [flags.stop !== undefined, "--stop"],
      ]);
    }
    const { app, name } = await chooseEnvironment(ctx, flags, "snapshot schedule");
    const deps = createPhaseDeps(ctx, { ai: false, app, environment: name });
    const every = flags.every?.trim();
    const stop = flags.stop?.map((service) => service.trim());
    printChange(
      ctx,
      state === "off"
        ? await snapshotScheduleOff(deps)
        : await snapshotScheduleOn(deps, {
            ...(every === undefined ? {} : { every }),
            ...(flags.keep === undefined ? {} : { keep: flags.keep }),
            ...(stop === undefined ? {} : { stop }),
          }),
    );
  });

  const offsite = snapshot
    .command("offsite")
    .description(
      "Turn the encrypted copy of each snapshot in a bucket of its own on or off in the plan; `opscrew provision` then plans the bucket and the uploads",
    );
  addEnvOption(
    offsite
      .addArgument(new Argument("<on|off>", "Turn it on or off").choices(["on", "off"]))
      .addOption(
        new Option("--to <provider>", "With on: where the bucket is").choices([
          "r2",
          "hetzner",
          "digitalocean",
        ]),
      )
      .option(
        "--region <region>",
        "With --to hetzner or digitalocean: the bucket's region (default: the server's location, where it has object storage)",
      )
      .option("--days <n>", "How long each copy is kept, in days (default 90)", wholeNumber),
  ).action(async (state: "on" | "off", flags: OffsiteFlags) => {
    const given = givenFlags(flags);
    if (state === "off") {
      checkOff("offsite", given, [
        [flags.to !== undefined, "--to"],
        [flags.region !== undefined, "--region"],
        [flags.days !== undefined, "--days"],
      ]);
    }
    if (state === "on" && flags.to === undefined) {
      throw new OpsCrewError(
        "INVALID_INPUT",
        "`opscrew snapshot offsite on` needs --to: r2 (Cloudflare R2), hetzner or digitalocean, where the copies' bucket is.",
        {
          hint: `Run \`opscrew snapshot offsite on --to r2${given}\`, or with hetzner or digitalocean.`,
        },
      );
    }
    const { app, name } = await chooseEnvironment(ctx, flags, "snapshot offsite");
    const deps = createPhaseDeps(ctx, { ai: false, app, environment: name });
    const region = flags.region?.trim();
    printChange(
      ctx,
      flags.to === undefined
        ? await snapshotOffsiteOff(deps)
        : await snapshotOffsiteOn(deps, {
            to: flags.to,
            ...(region === undefined ? {} : { region }),
            ...(flags.days === undefined ? {} : { days: flags.days }),
          }),
    );
  });
}
