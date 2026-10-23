import { promote } from "@opscrew/agents";
import { isPlanHash, OpsCrewError } from "@opscrew/core";
import type { Command } from "commander";
import type { CliContext } from "../context";
import { createPhaseDeps, servicesOf } from "../deps";
import { addAppOption, chooseApp } from "../ui/app";
import { printNextSteps } from "../ui/output";

interface PromoteFlags {
  /** `--app <key>`: the repository's app. */
  app?: string;
  to: string;
  digest?: string;
  approve?: string;
}

/**
 * `opscrew promote --to <env>`: deploys to `env` exactly the image its source environment runs
 * (or, with `--digest`, its previous image for a rollback), after the provenance and pending-change
 * checks, through a `promote` approval bound to the promotion's hash (contracts/environments.md
 * "Promotion"). A terminal asks; a script needs `--approve <hash>` from an earlier run. No flag
 * grants it otherwise: there is no `--yes` here. `--app` picks the app. Exit codes: 0 deployed, 1 refused, 2 error.
 */
export function register(program: Command, ctx: CliContext): void {
  const command = program
    .command("promote")
    .description(
      "Deploy the image another environment runs (or the previous one, to roll back) to an environment promoted from it",
    )
    .requiredOption("--to <env>", "The environment to deploy to")
    .option(
      "--digest <sha256:…>",
      "Deploy this image instead: the one its source runs, or its previous one to roll back",
    )
    .option(
      "--approve <hash>",
      "In a script: deploy exactly the promotion with this hash, which an earlier run showed",
    );
  addAppOption(command).action(async (flags: PromoteFlags) => {
    const target = flags.to.trim();
    const approve = flags.approve?.trim();
    if (approve !== undefined && !isPlanHash(approve)) {
      const given = flags.app === undefined ? "" : ` --app ${flags.app.trim()}`;
      throw new OpsCrewError(
        "INVALID_INPUT",
        "--approve expects the 64-character SHA-256 promotion hash an earlier run showed.",
        {
          hint: `Run \`opscrew promote${given} --to ${target}\` to see the promotion and its hash.`,
        },
      );
    }
    const app = await chooseApp(ctx, flags.app, "promote");
    const deps = createPhaseDeps(ctx, {
      ai: false,
      app: app.key,
      environment: target,
      approveHashes: approve === undefined ? [] : [approve],
    });
    const services = servicesOf(ctx).promote;
    const result = await promote(deps, {
      target,
      ...(flags.digest === undefined ? {} : { digest: flags.digest.trim() }),
      ...(approve === undefined ? {} : { approveHash: approve }),
      ...(services === undefined ? {} : { services }),
    });
    if (result.status === "waiting") {
      // Not a failure: GitHub holds the run for the environment's required reviewer.
      ctx.stdout(
        `\nThe deploy run for ${result.digest} waits in GitHub for a required reviewer of ${target}: ${result.runUrl}\nThe deploy goes on once the reviewer approves it in GitHub.\n`,
      );
      printNextSteps(ctx, [
        `once the run succeeded, run \`opscrew promote${app.flag} --to ${target}\` again (it records the image without a new deploy), then \`opscrew verify${app.flag} --env ${target}\`.`,
      ]);
      return;
    }
    ctx.stdout(`\nDeployed ${result.digest} to ${target}: ${result.runUrl}\n`);
    printNextSteps(ctx, [
      `run \`opscrew verify${app.flag} --env ${target}\` to check the live site.`,
    ]);
  });
}
