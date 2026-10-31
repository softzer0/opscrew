import {
  closePublicSsh,
  openPublicSsh,
  type PublicSshOptions,
  runProvision,
  runSecure,
} from "@opscrew/agents";
import { OpsCrewError, toPosixRelative } from "@opscrew/core";
import type { Command } from "commander";
import type { CliContext } from "../context";
import { createPhaseDeps, servicesOf } from "../deps";
import { CliExit, REFUSED_EXIT_CODE } from "../exit";
import { assumeYesHint, collect, runPhaseCommand } from "../ui/deploy";
import { type AppEnvFlags, addEnvOption, chooseEnvironment } from "../ui/environment";
import { printNextSteps } from "../ui/output";
import { checkApproveFlags, YES_DESCRIPTION } from "./provision";

interface SecureFlags extends AppEnvFlags {
  deep?: boolean;
  closePublicSsh?: boolean;
  openPublicSsh?: boolean;
  /** Every `--approve <hash>`: the infrastructure plan's and each server's host plan's. */
  approve?: string[];
  yes?: boolean;
}

/**
 * `secure --close-public-ssh` or `--open-public-ssh` (feature 018, FR-1815): the conditions are
 * checked first, then the infrastructure plan (the cloud firewalls) and each server's host plan,
 * each approved by its hash, and the deploy-setup pull request (`--yes` in a script).
 */
async function publicSsh(ctx: CliContext, flags: SecureFlags): Promise<void> {
  const close = flags.closePublicSsh === true;
  const command = `secure ${close ? "--close-public-ssh" : "--open-public-ssh"}`;
  await runPhaseCommand(
    ctx,
    async () => {
      const hashes = checkApproveFlags(command, flags, `opscrew ${command}`);
      const { app, name } = await chooseEnvironment(ctx, flags, "secure");
      const deps = createPhaseDeps(ctx, {
        ai: false,
        app,
        environment: name,
        approveHashes: hashes,
        ...(flags.yes === true ? { assumeYes: true } : {}),
      });
      const provision = servicesOf(ctx).provision;
      const options: PublicSshOptions = {
        ...(hashes.length > 0 ? { approveHashes: hashes } : {}),
        services: {
          ...servicesOf(ctx).vpn,
          provision: (d, o) =>
            runProvision(d, provision === undefined ? o : { ...o, services: provision }),
        },
      };
      return close ? closePublicSsh(deps, options) : openPublicSsh(deps, options);
    },
    assumeYesHint(ctx, flags.yes),
  );
}

/**
 * `opscrew secure`: re-runs the repository scan, re-checks the applied plan's policies, runs the
 * hardening checks on the server over SSH and probes its ports from outside, then writes
 * `opscrew/SECURITY_REPORT.md` (FR-216). `--deep` also runs Lynis on the server, and ssh-audit and
 * testssl.sh in Docker on this computer, read-only (FR-1420). A self-hosted runner's state is
 * among the checks (FR-1530). `--env` picks the environment, whose own report it writes.
 * `--close-public-ssh` and `--open-public-ssh` close SSH to the internet on every server of the
 * app (it answers on the private network only) or open it again, instead of the checks. Exit
 * codes: 0 nothing failed, 1 a check failed or a change was refused, 2 error.
 */
export function register(program: Command, ctx: CliContext): void {
  const command = program
    .command("secure")
    .description(
      "Check the servers' hardening and write the security report, or close or open public SSH",
    )
    .option(
      "--deep",
      "Also audit the whole server (Lynis), its SSH service (ssh-audit) and the TLS visitors see (testssl.sh); changes nothing",
    )
    .option(
      "--close-public-ssh",
      "Close SSH to the internet on every server of the app: it answers only on the app's private network (needs deploys on the server's own runner and this computer added with `opscrew vpn add <name> --this-computer`)",
    )
    .option(
      "--open-public-ssh",
      "Open SSH to the internet again on every server, to the allow-list the plan held before it closed",
    )
    .option(
      "--approve <hash>",
      "With --close-public-ssh or --open-public-ssh in a script: apply exactly the plan with this hash; give it once per plan (the infrastructure plan and each server's host plan)",
      collect,
    )
    .option("--yes", YES_DESCRIPTION);
  addEnvOption(command).action(async (flags: SecureFlags) => {
    const change = flags.closePublicSsh === true || flags.openPublicSsh === true;
    if (flags.closePublicSsh === true && flags.openPublicSsh === true) {
      throw new OpsCrewError(
        "INVALID_INPUT",
        "Use either --close-public-ssh or --open-public-ssh.",
        {
          hint: "Run `opscrew secure --close-public-ssh` to close public SSH, or `opscrew secure --open-public-ssh` to open it again.",
        },
      );
    }
    if (change && flags.deep === true) {
      throw new OpsCrewError(
        "INVALID_INPUT",
        "--deep checks the servers and changes nothing, so it does not go with --close-public-ssh or --open-public-ssh.",
        { hint: "Run them one after the other." },
      );
    }
    if (!change && (flags.approve !== undefined || flags.yes === true)) {
      throw new OpsCrewError(
        "INVALID_INPUT",
        "--approve and --yes go with --close-public-ssh or --open-public-ssh: the checks change nothing.",
        { hint: "Run `opscrew secure` without them." },
      );
    }
    if (change) {
      await publicSsh(ctx, flags);
      return;
    }
    const { app, name, flag } = await chooseEnvironment(ctx, flags, "secure");
    const deps = createPhaseDeps(ctx, { ai: false, app, environment: name });
    const result = await runSecure(deps, {
      ...servicesOf(ctx).secure,
      ...(flags.deep === true ? { deep: true } : {}),
    });
    if (result.passed) {
      printNextSteps(ctx, [
        `keep ${result.reportPath} with your records and run \`opscrew secure${flag}\` again after server or infrastructure changes.`,
        `run \`opscrew verify${flag}\` to check the live site and refresh ${toPosixRelative(deps.paths.root, deps.paths.files.runbook)}.`,
      ]);
      return;
    }
    printNextSteps(ctx, [
      `fix the problems listed in ${result.reportPath} (each one says how), then run \`opscrew secure${flag}\` again.`,
    ]);
    throw new CliExit(REFUSED_EXIT_CODE);
  });
}
