import { restoreServerSnapshot, restoreSnapshot } from "@opscrew/agents";
import type { ApprovalHandler, Clock } from "@opscrew/contracts";
import { isPlanHash, OpsCrewError } from "@opscrew/core";
import { type Command, Option } from "commander";
import { FlagConfirmation } from "../approval";
import type { CliContext } from "../context";
import { createPhaseDeps, servicesOf } from "../deps";
import { type AppEnvFlags, addEnvOption, chooseEnvironment, givenFlags } from "../ui/environment";
import { printNextSteps } from "../ui/output";
import { readKeyFile } from "./secrets";

interface RestoreFlags extends AppEnvFlags {
  /** `--server`: rebuild the server from a whole-server snapshot at its provider. */
  server?: boolean;
  /** `--only <service>`: the one service put back. */
  only?: string;
  /** `--allow-other-version`: put back the data of a snapshot another version took. */
  allowOtherVersion?: boolean;
  /** `--from offsite`: the copy in the off-server bucket. */
  from?: "offsite";
  /** `--key-file <path>`: the age key file that opens the off-server copies. */
  keyFile?: string;
  /** `--confirm <name>`: in a script, the name typed to approve the restore. */
  confirm?: string;
  /** `--approve <hash>`: in a script, the restore's hash an earlier run showed. */
  approve?: string;
}

/**
 * Refuses flags that don't go together, before any work (exit code 2), and returns the trimmed
 * `--approve` hash. `given` holds the `--app`/`--env` flags the user gave, for the hints.
 */
function checkFlags(flags: RestoreFlags, id: string, given: string): string | undefined {
  const command = `opscrew restore${flags.server === true ? " --server" : ""} ${id}${given}`;
  const approve = flags.approve?.trim();
  if (approve !== undefined && !isPlanHash(approve)) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      "--approve expects the 64-character SHA-256 restore hash an earlier run showed.",
      { hint: `Run \`${command}\` to see the restore and its hash.` },
    );
  }
  const data = [
    [flags.only !== undefined, "--only"],
    [flags.allowOtherVersion === true, "--allow-other-version"],
    [flags.from !== undefined, "--from"],
    [flags.keyFile !== undefined, "--key-file"],
  ] as const;
  const extra = data.filter(([set]) => set).map(([, name]) => name);
  if (flags.server === true && extra.length > 0) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `--server takes no ${extra.join(", ")}: the provider rebuilds the whole server from its snapshot.`,
      {
        hint: `Run \`${command}\` without them, or leave --server out to put a snapshot's data back.`,
      },
    );
  }
  if (flags.keyFile !== undefined && flags.from === undefined) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      "--key-file goes only with --from offsite: it opens the encrypted copy in the off-server bucket.",
      {
        hint: `Run \`${command} --from offsite --key-file <path>\`, or \`${command}\` without --key-file.`,
      },
    );
  }
  if (flags.from === "offsite" && flags.keyFile === undefined) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      "--from offsite needs --key-file <path>: the age key file that opens the encrypted copy.",
      { hint: `Run \`${command} --from offsite --key-file <path>\`.` },
    );
  }
  return approve;
}

/**
 * The run's approvals: a restore loses data, so it is destroy-grade. In a terminal the name is
 * typed; in a script `--confirm <name>` approves it only with `--approve` and its hash, and the
 * request (what is lost, and its hash) is shown first, as is any request refused. `--yes` never
 * approves it.
 */
function restoreApprovals(
  ctx: CliContext,
  confirm: string | undefined,
  approve: string | undefined,
): (base: ApprovalHandler, clock: Clock) => ApprovalHandler {
  return (base, clock) =>
    new FlagConfirmation(base, {
      kinds: ["remote-exec"],
      what: "a restore",
      names: confirm === undefined ? [] : [confirm],
      hashes: approve === undefined ? [] : [approve],
      interactive: ctx.isInteractive,
      print: ctx.stdout,
      clock,
      showInScript: true,
    });
}

/** The command's line in `opscrew --help`, and the first line of its own help. */
const SUMMARY =
  "Put a snapshot's data back in an environment without changing the version that runs, or with --server rebuild a server from its whole-server snapshot";

/**
 * `opscrew restore` (feature 024, US3, US4, US6), through the agents' restores:
 * - `opscrew restore <id> [--only <service>] [--allow-other-version] [--from offsite
 *   --key-file <path>]`: the snapshot's data put back where it lives, the version that runs unchanged; a
 *   snapshot of another version is refused unless `--allow-other-version`.
 * - `opscrew restore --server <id>`: the provider rebuilds the server from its whole-server
 *   snapshot in place; OpsCrew then checks the app answers.
 * Destroy-grade: a terminal asks for the name (the app's, or with `--server` the server's); a
 * script gives `--confirm <name>` and `--approve <hash>`, which an earlier run showed; `--yes`
 * never approves it. Exit codes: 0 restored, 1 refused or not approved, 2 error.
 */
export function register(program: Command, ctx: CliContext): void {
  const command = program
    .command("restore")
    .summary(SUMMARY)
    .description(
      [
        SUMMARY,
        "",
        "Everything written since the snapshot is lost, so you approve it as a destroy: by typing",
        "the app's name (with --server, the server's); in a script, --confirm <name> with",
        "--approve <hash>. A copy of the data as it is now is taken first and put back if the",
        "restore fails.",
      ].join("\n"),
    )
    .argument("<id>", "The snapshot's id, as `opscrew snapshot list` shows it")
    .option("--only <service>", "Put back only this service's data")
    .option(
      "--allow-other-version",
      "Put back the data alone of a snapshot taken while another version ran (the version that runs stays)",
    )
    .addOption(
      new Option(
        "--from <where>",
        "offsite: restore the encrypted copy in the off-server bucket, decrypted on this computer",
      ).choices(["offsite"]),
    )
    .option(
      "--key-file <path>",
      "With --from offsite: the file with your age key, which opens the copy",
    )
    .option(
      "--server",
      "Rebuild the server from this whole-server snapshot at its provider (Hetzner, DigitalOcean)",
    )
    .option(
      "--confirm <name>",
      "In a script, with --approve: the app's name (with --server, the server's), typed to approve it",
    )
    .option(
      "--approve <hash>",
      "In a script: restore exactly as the restore with this hash, which an earlier run showed",
    );
  addEnvOption(command)
    .addHelpText(
      "after",
      [
        "",
        "  opscrew snapshot list                         the snapshots and their ids",
        "  opscrew restore <id>                          put a snapshot's data back",
        "  opscrew restore <id> --only db                only the service db",
        "  opscrew restore <id> --from offsite --key-file <path>   from the copy off the server",
        "  opscrew restore --server <id>                 rebuild the server from it",
      ].join("\n"),
    )
    .action(async (raw: string, flags: RestoreFlags) => {
      const id = raw.trim();
      const given = givenFlags(flags);
      const approve = checkFlags(flags, id, given);
      const { app, name, flag } = await chooseEnvironment(ctx, flags, "restore");
      const deps = createPhaseDeps(ctx, {
        ai: false,
        app,
        environment: name,
        wrapApprovals: restoreApprovals(ctx, flags.confirm?.trim(), approve),
      });
      const services = servicesOf(ctx).snapshot;
      const withServices = services === undefined ? {} : { services };
      if (flags.server === true) {
        const restored = await restoreServerSnapshot(deps, id, withServices);
        if (!restored.checked) {
          printNextSteps(ctx, [`run \`opscrew verify${flag}\` to check the app.`]);
        }
        return;
      }
      const only = flags.only?.trim();
      const identity =
        flags.keyFile === undefined ? undefined : await readKeyFile(ctx, flags.keyFile);
      await restoreSnapshot(deps, id, {
        ...(only === undefined ? {} : { only }),
        ...(flags.allowOtherVersion === true ? { allowOtherVersion: true } : {}),
        ...(flags.from === undefined ? {} : { from: flags.from }),
        ...(identity === undefined ? {} : { identity }),
        ...withServices,
      });
      printNextSteps(ctx, [`run \`opscrew verify${flag}\` to check the app.`]);
    });
}
