import { type DeployPause, pinnedText, type RollbackResult, rollback } from "@opscrew/agents";
import { isPlanHash, OpsCrewError } from "@opscrew/core";
import { formatUtc } from "@opscrew/secops";
import type { Command } from "commander";
import type { CliContext } from "../context";
import { createPhaseDeps, servicesOf } from "../deps";
import { type AppEnvFlags, addEnvOption, chooseEnvironment } from "../ui/environment";
import { printNextSteps, textTable } from "../ui/output";

interface RollbackFlags extends AppEnvFlags {
  /** `--to <commit|digest|version>`: the version to go back to (default: the one before). */
  to?: string;
  list?: boolean;
  resume?: boolean;
  /** `--deploy`, with `--resume`: deploy the branch's latest commit now. */
  deploy?: boolean;
  /** `--yes`, with `--resume`: approve the resume's GitHub settings change. */
  yes?: boolean;
  approve?: string;
  /** `--allow-old-secrets <names>`: on Cloudflare's hosting, comma-separated. */
  allowOldSecrets?: string;
}

/** `sha256:` and the digest's first 12 digits. */
function shortDigest(digest: string): string {
  return digest.slice(0, 19);
}

/**
 * Refuses flags that don't go together, before any work (exit code 2), and returns the trimmed
 * `--approve` hash. `given` holds the `--app`/`--env` flags the user gave, for the hints.
 */
function checkFlags(flags: RollbackFlags, given: string): string | undefined {
  const command = `opscrew rollback${given}`;
  const approve = flags.approve?.trim();
  if (approve !== undefined && !isPlanHash(approve)) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      "--approve expects the 64-character SHA-256 rollback hash an earlier run showed.",
      { hint: `Run \`${command}\` to see the rollback and its hash.` },
    );
  }
  const others =
    flags.to !== undefined ||
    flags.resume === true ||
    flags.deploy === true ||
    flags.yes === true ||
    approve !== undefined ||
    flags.allowOldSecrets !== undefined;
  if (flags.list === true && others) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      "--list stands alone: it only shows the versions there are, and changes nothing.",
      { hint: `Run \`${command} --list\`, then \`${command} --to <one of them>\`.` },
    );
  }
  if (flags.yes === true && flags.resume !== true) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      "--yes goes only with --resume: no flag grants a rollback, which you approve by its hash.",
      {
        hint: `In a terminal, \`${command}\` asks. In a script, run it once to see the rollback and its hash, then run the command it prints, with --approve <hash>.`,
      },
    );
  }
  if (flags.deploy === true && flags.resume !== true) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      "--deploy goes only with --resume: it deploys the branch's latest commit once the deploys are on again.",
      { hint: `Run \`${command} --resume --deploy\`.` },
    );
  }
  if (
    flags.resume === true &&
    (flags.to !== undefined || approve !== undefined || flags.allowOldSecrets !== undefined)
  ) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      "--resume takes no --to, --approve or --allow-old-secrets: it ends the pause a rollback set, and a script gives --yes.",
      {
        hint: `Run \`${command} --resume\` (add --deploy to deploy the branch's latest commit now).`,
      },
    );
  }
  return approve;
}

/** The pause in one line, with what ends it. */
function pauseLine(name: string, pause: DeployPause, flag: string): string {
  const since = formatUtc(pause.since);
  if (pause.reason === "move") {
    return `Deploys of ${name} are paused since ${since} for a move's maintenance window: \`opscrew provision${flag}\` ends it.`;
  }
  return `Deploys of ${name} are paused since ${since}: ${pinnedText(pause)}. Run \`opscrew rollback${flag} --resume\` to turn them back on.`;
}

/** `--list`: the versions as a table, newest first, the pause and the images left out. */
function printList(
  ctx: CliContext,
  name: string,
  flag: string,
  result: Extract<RollbackResult, { kind: "list" }>,
): void {
  const { versions, paused, leftOut } = result;
  if (versions.length === 0) {
    ctx.stdout(`\nNo versions of ${name} were found to roll back to.\n`);
  } else {
    const rows = [
      ["Version", "Commit", "Built", "Mark", "Message"],
      ...versions.map((version) => [
        version.version ?? (version.digest !== undefined ? shortDigest(version.digest) : "-"),
        version.commit?.slice(0, 7) ?? "-",
        version.builtAt !== undefined ? formatUtc(version.builtAt) : "-",
        (version.marks ?? []).join(", "),
        version.message ?? "",
      ]),
    ];
    const table = textTable(rows)
      .split("\n")
      .map((line) => `  ${line}`.trimEnd())
      .join("\n");
    ctx.stdout(`\nVersions of ${name}, newest first:\n\n${table}\n`);
  }
  if (leftOut.length > 0) {
    const lines = leftOut.map((image) => `  ${image.commit.slice(0, 7)}: ${image.reason}`);
    ctx.stdout(`\nNot offered (${name}):\n${lines.join("\n")}\n`);
  }
  if (paused !== undefined) ctx.stdout(`\n${pauseLine(name, paused, flag)}\n`);
  if (versions.length > 1) {
    const to = versions.some((version) => version.version !== undefined)
      ? "<version>"
      : "<commit or digest>";
    printNextSteps(ctx, [
      `run \`opscrew rollback${flag} --to ${to}\` to go back to one of them; without --to, \`opscrew rollback${flag}\` goes back to the one marked previous.`,
    ]);
  }
}

/** The command's line in `opscrew --help`, and the first line of its own help. */
const SUMMARY =
  "Put an environment back on its previous deployment, or an earlier version, with no build; its automatic deploys then pause until --resume";

/**
 * `opscrew rollback` (feature 019, ADR 0023): puts an environment back on an earlier version of
 * its own, with no build and no release command, through the agents' `rollback`. Without `--to`
 * it goes back to the deployment before the running one. A rollback is a `promote` approval bound
 * to its hash: a terminal asks, a script gives `--approve <hash>`, and `--yes` never grants it.
 * Afterwards the environment's automatic deploys pause until `--resume` (whose GitHub settings
 * change `--yes` grants; `--deploy` also deploys the branch's latest commit). `--list` shows the
 * versions, read-only. Exit codes: 0 rolled back, listed, resumed or waiting for a reviewer;
 * 1 refused or not approved; 2 error.
 */
export function register(program: Command, ctx: CliContext): void {
  const command = program
    .command("rollback")
    .summary(SUMMARY)
    .description(
      [
        SUMMARY,
        "",
        "The database stays as it is: the earlier version runs with today's data, schema, settings",
        "and secrets, and the release command does not run. Restoring a backup is a separate step.",
      ].join("\n"),
    )
    .option(
      "--to <commit|digest|version>",
      "The version to go back to, as --list shows it (default: the one before the running one)",
    )
    .option(
      "--list",
      "Show the versions there are, newest first, and whether deploys are paused (read-only)",
    )
    .option("--resume", "Turn the environment's automatic deploys back on after a rollback")
    .option("--deploy", "With --resume: also deploy the branch's latest commit now")
    .option("--yes", "With --resume, in a script: approve turning the deploys back on")
    .option(
      "--approve <hash>",
      "In a script: roll back exactly as the rollback with this hash, which an earlier run showed",
    )
    .option(
      "--allow-old-secrets <names>",
      "Cloudflare's hosting: activate that Worker version even though these secrets (comma-separated, as OpsCrew's refusal names them) changed since; it runs with their old values",
    );
  addEnvOption(command)
    .addHelpText(
      "after",
      [
        "",
        "  opscrew rollback --list          the versions, newest first",
        "  opscrew rollback                  back to the previous deployment",
        "  opscrew rollback --to <commit>    back to an earlier version",
        "  opscrew rollback --resume         deploys on again, once the fix is pushed",
      ].join("\n"),
    )
    .action(async (flags: RollbackFlags) => {
      const given = `${flags.app === undefined ? "" : ` --app ${flags.app.trim()}`}${flags.env === undefined ? "" : ` --env ${flags.env.trim()}`}`;
      const approve = checkFlags(flags, given);
      const { app, name, flag } = await chooseEnvironment(ctx, flags, "rollback");
      const deps = createPhaseDeps(ctx, {
        ai: false,
        app,
        environment: name,
        approveHashes: approve === undefined ? [] : [approve],
        ...(flags.yes === true ? { assumeYes: true } : {}),
      });
      const services = servicesOf(ctx).rollback;
      // rollback checks the names.
      const oldSecrets = flags.allowOldSecrets?.split(",");
      const result = await rollback(deps, {
        ...(flags.to === undefined ? {} : { to: flags.to.trim() }),
        ...(flags.list === true ? { list: true } : {}),
        ...(flags.resume === true ? { resume: true } : {}),
        ...(flags.deploy === true ? { deploy: true } : {}),
        ...(approve === undefined ? {} : { approveHash: approve }),
        ...(oldSecrets === undefined ? {} : { allowOldSecrets: oldSecrets }),
        ...(services === undefined ? {} : { services }),
      });
      if (result.kind === "list") {
        printList(ctx, name, flag, result);
        return;
      }
      // The agent's reporter has said what runs now, what waits for a reviewer, and how to resume.
      const status = result.kind === "rolled-back" ? result.status : result.deployed?.status;
      if (status === "deployed") {
        printNextSteps(ctx, [`run \`opscrew verify${flag}\` to check the live site.`]);
      }
    });
}
