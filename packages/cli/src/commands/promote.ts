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
  /** `--version <id>`: a rollback on Cloudflare's hosting or GitHub Pages. */
  version?: string;
  /** `--allow-old-secrets <names>`: with `--version` on Cloudflare's hosting, comma-separated. */
  allowOldSecrets?: string;
  approve?: string;
}

/**
 * `opscrew promote --to <env>`: deploys to `env` exactly the image its source environment runs
 * (or, with `--digest`, its previous image for a rollback; on Cloudflare's hosting the build its
 * source runs, and with `--version` a rollback of a site to an earlier Worker version or GitHub
 * Pages run; `--allow-old-secrets` lets a Worker version older than a change of the secrets it
 * names run with their old values), after the provenance and pending-change checks, through a `promote` approval bound
 * to the promotion's hash (contracts/environments.md "Promotion"). A terminal asks; a script needs
 * `--approve <hash>` from an earlier run. No flag grants it otherwise: there is no `--yes` here.
 * `--app` picks the app. Exit codes: 0 deployed, 1 refused, 2 error.
 */
export function register(program: Command, ctx: CliContext): void {
  const command = program
    .command("promote")
    .description(
      "Deploy the image or site build another environment runs to an environment promoted from it, or roll back to the previous one",
    )
    .requiredOption("--to <env>", "The environment to deploy to")
    .option(
      "--digest <sha256:…>",
      "Deploy this image instead: the one its source runs, or its previous one to roll back",
    )
    .option(
      "--version <id>",
      "Cloudflare's hosting or GitHub Pages: roll back to this earlier Worker version or GitHub Pages run (`opscrew status` names the one before)",
    )
    .option(
      "--allow-old-secrets <names>",
      "Cloudflare's hosting, with --version: activate that version even though these secrets (comma-separated, as OpsCrew's refusal names them) changed since it was active; it runs with their old values",
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
    // promote checks the names.
    const oldSecrets = flags.allowOldSecrets?.split(",");
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
      ...(flags.version === undefined ? {} : { version: flags.version.trim() }),
      ...(oldSecrets === undefined ? {} : { allowOldSecrets: oldSecrets }),
      ...(approve === undefined ? {} : { approveHash: approve }),
      ...(services === undefined ? {} : { services }),
    });
    // The agent's reporter has said what runs now, or that the run waits for a reviewer.
    const verify = `\`opscrew verify${app.flag} --env ${target}\``;
    printNextSteps(ctx, [
      result.status === "waiting"
        ? `once the run succeeded, run ${verify}.`
        : `run ${verify} to check the live site.`,
    ]);
  });
}
