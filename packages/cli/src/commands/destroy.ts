import { runDestroy } from "@opscrew/agents";
import type { ApprovalDecision, ApprovalHandler, ApprovalRequest } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { readArtifact } from "@opscrew/plan-schema";
import { type Command, Option } from "commander";
import type { CliContext } from "../context";
import { createPhaseDeps, promptsOf } from "../deps";
import { runPhaseCommand, usageErrorsExit2 } from "../ui/deploy";
import { deployServicesOf } from "../ui/deploy-services";
import { printNextSteps } from "../ui/output";

interface DestroyFlags {
  snapshot?: boolean;
  confirm?: string;
  engine?: "tofu" | "terraform";
}

/**
 * Approves this teardown's infrastructure plans (lifting protection, then deleting) once the
 * server name was typed (or given with `--confirm`); everything else goes to `base`, except that
 * a `--confirm` run also approves removing the GitHub deploy secrets (no prompts at all).
 */
class TypedConfirmationHandler implements ApprovalHandler {
  constructor(
    private readonly base: ApprovalHandler,
    private readonly name: string,
    private readonly typed: () => string | undefined,
    private readonly approveSecrets: boolean,
    private readonly print: (text: string) => void,
  ) {}

  async request(request: ApprovalRequest): Promise<ApprovalDecision> {
    const covered =
      request.kind === "iac-apply" || (this.approveSecrets && request.kind === "github-secrets");
    const phraseOk = request.confirmPhrase === undefined || request.confirmPhrase === this.name;
    if (covered && phraseOk && this.typed() === this.name) {
      this.print(`  ✓ ${request.title} (confirmed with the server name)\n`);
      return {
        approved: true,
        approver: "typed server name",
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
 * and applies the destroy plan (each plan approved by hash), then removes the GitHub deploy
 * secrets after its own approval (FR-301). Non-interactive runs need `--confirm <server name>`.
 * Exit codes: 0 torn down, 1 refused or not confirmed, 2 error.
 */
export function register(program: Command, ctx: CliContext): void {
  program
    .command("destroy")
    .description("Delete the deployment's infrastructure (asks for the server name)")
    .option("--snapshot", "Always take a Hetzner snapshot of the server first")
    .option("--no-snapshot", "Do not take a Hetzner snapshot of the server first")
    .option("--confirm <name>", "The server name, to run without prompts (for scripts and CI)")
    .addOption(
      new Option("--engine <name>", "Infrastructure engine to use instead of the plan's").choices([
        "tofu",
        "terraform",
      ]),
    )
    .exitOverride(usageErrorsExit2)
    .action(async (flags: DestroyFlags) => {
      let typed: string | undefined;
      await runPhaseCommand(ctx, async () => {
        const deps0 = createPhaseDeps(ctx, { ai: false });
        const name = (await readArtifact("plan", deps0.paths.files.plan)).app.name;
        const scripted = flags.confirm !== undefined;
        if (scripted && flags.confirm?.trim() !== name) {
          throw new OpsCrewError(
            "APPROVAL_REFUSED",
            `--confirm ${flags.confirm ?? ""} does not match the server name, so nothing was changed.`,
            { hint: `To delete the deployment, run \`opscrew destroy --confirm ${name}\`.` },
          );
        }
        if (!scripted && !ctx.isInteractive) {
          throw new OpsCrewError(
            "APPROVAL_REFUSED",
            "Deleting the deployment needs the server name typed by a person, and this run is not interactive. Nothing was changed.",
            {
              hint: `Run \`opscrew destroy\` in a terminal, or \`opscrew destroy --confirm ${name}\` in a script.`,
            },
          );
        }
        if (scripted) typed = name;
        const deps = createPhaseDeps(ctx, {
          ai: false,
          wrapApprovals: (base) =>
            new TypedConfirmationHandler(base, name, () => typed, scripted, ctx.stdout),
        });
        const services = deployServicesOf(ctx).destroy;
        return runDestroy(deps, {
          // default: a snapshot when data lives only on the server (database, backups on)
          snapshot: flags.snapshot === undefined ? "auto" : flags.snapshot,
          ...(flags.engine === undefined ? {} : { engine: flags.engine }),
          ...(services === undefined ? {} : { services }),
          confirm: async (preview) => {
            if (scripted) return true;
            const prompts = promptsOf(ctx);
            const answer = await prompts.text({
              message: `Type ${preview.name} to delete everything listed above (anything else cancels)`,
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
      ]);
    });
}
