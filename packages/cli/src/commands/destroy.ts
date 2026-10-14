import { destroyConfirmPrompt, runDestroy } from "@opscrew/agents";
import type { ApprovalDecision, ApprovalHandler, ApprovalRequest } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { readArtifact } from "@opscrew/plan-schema";
import { type Command, Option } from "commander";
import type { CliContext } from "../context";
import { createPhaseDeps, promptsOf } from "../deps";
import { collect, runPhaseCommand, usageErrorsExit2 } from "../ui/deploy";
import { deployServicesOf } from "../ui/deploy-services";
import { printNextSteps } from "../ui/output";
import { addHostKeyOption, checkApproveFlags } from "./provision";

interface DestroyFlags {
  snapshot?: boolean;
  confirm?: string;
  engine?: "tofu" | "terraform";
  /** Your own server: also reverse OpsCrew's host changes (a separate host plan and approval). */
  undoHost?: boolean;
  /** Your own server: also delete the app's data (needs the typed app name). */
  deleteData?: boolean;
  hostKey?: string;
  /** Repeated `--approve <hash>`: the undo host plan (`--undo-host`) in a script. */
  approve?: string[];
}

/**
 * Approves this teardown's plans once the name was typed (or given with `--confirm`): the
 * infrastructure plans (lifting delete protection where the provider has it, then deleting) and,
 * on a server the user owns, the teardown host plan that asks for exactly that name. Everything
 * else goes to `base` (the undo host plan of `--undo-host` is a separate approval), except that a
 * `--confirm` run also approves removing the GitHub deploy secrets (no prompts at all).
 */
class TypedConfirmationHandler implements ApprovalHandler {
  constructor(
    private readonly base: ApprovalHandler,
    private readonly name: string,
    private readonly typed: () => string | undefined,
    private readonly approveSecrets: boolean,
    private readonly print: (text: string) => void,
    private readonly what: string,
  ) {}

  private covers(request: ApprovalRequest): boolean {
    if (request.kind === "iac-apply") {
      return request.confirmPhrase === undefined || request.confirmPhrase === this.name;
    }
    // The teardown host plan names the app as its phrase; the undo plan has none and is asked apart.
    if (request.kind === "host-apply") return request.confirmPhrase === this.name;
    return this.approveSecrets && request.kind === "github-secrets";
  }

  async request(request: ApprovalRequest): Promise<ApprovalDecision> {
    if (this.covers(request) && this.typed() === this.name) {
      this.print(`  ✓ ${request.title} (confirmed with ${this.what})\n`);
      return {
        approved: true,
        approver: `typed ${this.what.replace(/^the /, "").replace("'s", "")}`,
        decidedAt: new Date().toISOString(),
        ...(request.confirmPhrase !== undefined ? { confirmation: this.name } : {}),
      };
    }
    return this.base.request(request);
  }
}

/**
 * `opscrew destroy`: shows what the teardown deletes, has the user type the server name before
 * anything changes, takes a snapshot when data lives only on the server, lifts delete protection
 * (on providers that have it) and applies the destroy plan (each plan approved by hash), then removes the GitHub deploy
 * secrets after its own approval (FR-301). Non-interactive runs need `--confirm <server name>`.
 * On a server the user owns (FR-912) it removes only the app (Cloudflare resources and a teardown
 * host plan; the app's data only with `--delete-data`) after the app's name is typed, never the
 * server, and `--undo-host` adds the undo host plan as its own approval (`--approve <hash>` in
 * scripts). Exit codes: 0 torn down, 1 refused or not confirmed, 2 error.
 */
export function register(program: Command, ctx: CliContext): void {
  const command = program
    .command("destroy")
    .description(
      "Delete the deployment's infrastructure, or remove the app from your own server (asks for the name)",
    )
    .option("--snapshot", "Take a snapshot of the server first")
    .option("--no-snapshot", "Do not take a snapshot of the server first")
    .option(
      "--confirm <name>",
      "The server name (on your own server, the app's name), to run without prompts (for scripts and CI)",
    )
    .addOption(
      new Option("--engine <name>", "Infrastructure engine to use instead of the plan's").choices([
        "tofu",
        "terraform",
      ]),
    )
    .option(
      "--undo-host",
      "Your own server: also reverse OpsCrew's changes to it (deploy user, SSH and firewall settings, automatic updates), as a separate plan you approve",
    )
    .option(
      "--delete-data",
      "Your own server: also delete the app's data (/srv/data and its Docker volumes); asks for the app's name",
    )
    .option(
      "--approve <hash>",
      "With --undo-host in a script: apply the undo host plan with this hash (printed by an earlier run)",
      collect,
    );
  addHostKeyOption(command)
    .exitOverride(usageErrorsExit2)
    .action(async (flags: DestroyFlags) => {
      let typed: string | undefined;
      let own = false;
      await runPhaseCommand(ctx, async () => {
        const hashes = checkApproveFlags("destroy", flags);
        const hostKey = flags.hostKey?.trim();
        const deps0 = createPhaseDeps(ctx, { ai: false });
        const plan = await readArtifact("plan", deps0.paths.files.plan);
        const name = plan.app.name;
        own = plan.target.provider === "own";
        const what = own ? "the app's name" : "the server name";
        const scripted = flags.confirm !== undefined;
        if (scripted && flags.confirm?.trim() !== name) {
          throw new OpsCrewError(
            "APPROVAL_REFUSED",
            `--confirm ${flags.confirm ?? ""} does not match ${what}, so nothing was changed.`,
            {
              hint: `To ${own ? "remove the app from your server" : "delete the deployment"}, run \`opscrew destroy --confirm ${name}\`.`,
            },
          );
        }
        if (!own && (flags.undoHost === true || flags.deleteData === true)) {
          throw new OpsCrewError(
            "INVALID_INPUT",
            "--undo-host and --delete-data apply only to a server you already own; this deployment's server was created by OpsCrew and is deleted with its data.",
            { hint: "Run `opscrew destroy` without them." },
          );
        }
        if (!scripted && !ctx.isInteractive) {
          throw new OpsCrewError(
            "APPROVAL_REFUSED",
            `${own ? "Removing the app" : "Deleting the deployment"} needs ${what} typed by a person, and this run is not interactive. Nothing was changed.`,
            {
              hint: `Run \`opscrew destroy\` in a terminal, or \`opscrew destroy --confirm ${name}\` in a script.`,
            },
          );
        }
        if (scripted) typed = name;
        const deps = createPhaseDeps(ctx, {
          ai: false,
          ...(hashes.length === 0 ? {} : { approvePlanHashes: hashes }),
          wrapApprovals: (base) =>
            new TypedConfirmationHandler(base, name, () => typed, scripted, ctx.stdout, what),
        });
        // `--approve` can grant only the undo host plan here: every deletion needs the typed name.
        const services = deployServicesOf(ctx).destroy;
        return runDestroy(deps, {
          // default: a snapshot when data lives only on the server (database, backups on)
          snapshot: flags.snapshot === undefined ? "auto" : flags.snapshot,
          ...(flags.engine === undefined ? {} : { engine: flags.engine }),
          ...(services === undefined ? {} : { services }),
          ...(flags.undoHost === true ? { undoHost: true } : {}),
          ...(flags.deleteData === true ? { deleteData: true } : {}),
          ...(hostKey === undefined ? {} : { hostKey }),
          confirm: async (preview) => {
            if (scripted) return true;
            const prompts = promptsOf(ctx);
            const answer = await prompts.text({
              message:
                preview.confirmPrompt ?? destroyConfirmPrompt(preview.name, preview.provider),
              placeholder: preview.name,
            });
            if (prompts.isCancel(answer)) return false;
            typed = answer.trim();
            return typed === preview.name;
          },
        });
      });
      printNextSteps(ctx, [
        "run `opscrew provision` to deploy again (the plan and the repository files are kept).",
        ...(own
          ? [
              "your server stays as it is otherwise; back up anything on it yourself (OpsCrew cannot take snapshots of your own server).",
            ]
          : []),
      ]);
    });
}
