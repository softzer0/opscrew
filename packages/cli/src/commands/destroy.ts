import {
  type DestroyOptions,
  type DestroyPreview,
  type DestroyResult,
  destroyConfirmPrompt,
  type PhaseDeps,
  runDestroy,
  savedHostPlanPurpose,
} from "@opscrew/agents";
import type { ApprovalDecision, ApprovalHandler, ApprovalRequest, Clock } from "@opscrew/contracts";
import { approvalDecision, OpsCrewError, systemClock } from "@opscrew/core";
import { type DeployPlan, readArtifact } from "@opscrew/plan-schema";
import type { Command } from "commander";
import { askTypedName, checkConfirmName, hashListed } from "../approval";
import type { CliContext } from "../context";
import { createPhaseDeps, promptsOf, servicesOf } from "../deps";
import { collect, runPhaseCommand } from "../ui/deploy";
import { printNextSteps } from "../ui/output";
import { addHostKeyOption, checkApproveFlags, DEPLOY_AGAIN_STEP, engineOption } from "./provision";

/** The flags of `opscrew destroy`. */
export interface DestroyFlags {
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

/** Where the undo host plan's own approval comes from (`--undo-host`). */
export interface UndoApproval {
  /** The purpose of the saved host plan with this hash (the undo plan is told apart by it). */
  purposeOf: (hash: string | undefined) => Promise<string | undefined>;
  /** `--confirm <app>` was given: a script, where only `--approve <hash>` can add the undo plan. */
  scripted: boolean;
  /** The `--approve` values. */
  hashes: readonly string[];
}

/**
 * Approves this teardown's plans once the name was typed (or given with `--confirm`): the
 * infrastructure plans (lifting delete protection where the provider has it, then deleting) and,
 * on a server the user owns, the teardown host plan that asks for exactly that name; in the user's
 * Portainer, the stack teardown plan (a `stack-apply` with `allowDestroy` that asks for exactly
 * that name; a `stack-apply` without them is never covered). A `--confirm` run also approves
 * removing the GitHub deploy secrets (no prompts at all). `--yes` does not exist here.
 *
 * The undo host plan of `--undo-host` deletes the deploy user OpsCrew created (and its home), so
 * it asks for the app's name as well (`allowDestroy`), but always as its own approval: the name
 * typed for the teardown never covers it. In a terminal the base handler asks for the name again;
 * in a script it is approved only with `--confirm <app>` together with `--approve <its hash>`.
 * A `host-apply` whose saved plan is not known to be the teardown (any other purpose, or the
 * lookup failed) is never covered by the typed name and goes to `base`, like everything else.
 * Exported for tests.
 */
export class TypedConfirmationHandler implements ApprovalHandler {
  constructor(
    private readonly base: ApprovalHandler,
    private readonly name: string,
    private readonly typed: () => string | undefined,
    private readonly approveSecrets: boolean,
    private readonly print: (text: string) => void,
    private readonly what: string,
    private readonly undo: UndoApproval,
    private readonly clock: Clock = systemClock,
  ) {}

  /**
   * `purpose`: of the saved host plan a `host-apply` names. Only the teardown host plan is covered
   * by the typed name; any other or unknown purpose goes to the base handler (fail closed).
   */
  private covers(request: ApprovalRequest, purpose: string | undefined): boolean {
    if (request.kind === "iac-apply") {
      return request.confirmPhrase === undefined || request.confirmPhrase === this.name;
    }
    if (request.kind === "host-apply") {
      return purpose === "teardown" && request.confirmPhrase === this.name;
    }
    if (request.kind === "stack-apply") {
      // The user's Portainer: only the teardown, which deletes (allowDestroy) and asks for the name.
      return request.allowDestroy === true && request.confirmPhrase === this.name;
    }
    return this.approveSecrets && request.kind === "github-secrets";
  }

  /** The undo host plan's approval: `--confirm <app>` with `--approve <hash>`, or the base handler. */
  private async undoDecision(request: ApprovalRequest): Promise<ApprovalDecision> {
    if (!this.undo.scripted) return this.base.request(request);
    const decide = (approved: boolean, extra: Pick<ApprovalDecision, "confirmation" | "reason">) =>
      approvalDecision(this.clock, "--confirm and --approve flags", approved, extra);
    const listed = hashListed(this.undo.hashes, request.planHash);
    if (request.confirmPhrase === this.name && this.typed() === this.name && listed) {
      this.print(`  ✓ ${request.title} (confirmed with --confirm ${this.name} and --approve)\n`);
      return decide(true, { confirmation: this.name });
    }
    return decide(false, {
      reason: `it deletes the deploy user OpsCrew created and its home directory, so a script approves it only with --confirm ${this.name} together with --approve ${request.planHash ?? "<hash>"} (the hash of this undo plan)`,
    });
  }

  async request(request: ApprovalRequest): Promise<ApprovalDecision> {
    let purpose: string | undefined;
    if (request.kind === "host-apply") {
      purpose = await this.undo.purposeOf(request.planHash).catch(() => undefined);
      if (purpose === "undo") return this.undoDecision(request);
    }
    if (this.covers(request, purpose) && this.typed() === this.name) {
      this.print(`  ✓ ${request.title} (confirmed with ${this.what})\n`);
      return approvalDecision(
        this.clock,
        `typed ${this.what.replace(/^the /, "").replace("'s", "")}`,
        true,
        request.confirmPhrase !== undefined ? { confirmation: this.name } : {},
      );
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
 * server, and `--undo-host` adds the undo host plan as its own approval: it deletes the deploy user
 * OpsCrew created, so the app's name is typed again (`--confirm <app>` with `--approve <hash>` in
 * scripts). In the user's Portainer (FR-1014) it removes only what OpsCrew created there (its
 * stacks, registry entry and repository access) and on Cloudflare, after the app's name is typed;
 * the stack teardown plan is approved with that name, the app's data volumes only with
 * `--delete-data`. Exit codes: 0 torn down, 1 refused or not confirmed, 2 error.
 */
export function register(program: Command, ctx: CliContext): void {
  const command = program
    .command("destroy")
    .description(
      "Delete the deployment's infrastructure, or remove the app from your own server or your Portainer (asks for the name)",
    )
    .option("--snapshot", "Take a snapshot of the server first")
    .option("--no-snapshot", "Do not take a snapshot of the server first")
    .option(
      "--confirm <name>",
      "The server name (on your own server or in your Portainer, the app's name), to run without prompts (for scripts and CI)",
    )
    .addOption(engineOption())
    .option(
      "--undo-host",
      "Your own server: also reverse OpsCrew's changes to it (deploy user, SSH and firewall settings, automatic updates), as a separate plan you approve",
    )
    .option(
      "--delete-data",
      "Your own server or your Portainer: also delete the app's data (its Docker volumes, and /srv/data on your own server); asks for the app's name",
    )
    .option(
      "--approve <hash>",
      "With --undo-host and --confirm <app> in a script: apply the undo host plan with this hash (printed by an earlier run)",
      collect,
    );
  addHostKeyOption(command).action((flags: DestroyFlags) => runDestroyCommand(ctx, flags));
}

/**
 * The question asked before the user types the name: what the user's Portainer loses (the stack
 * teardown's changes, already listed above in full) and the prompt for the name.
 */
export function confirmMessage(preview: DestroyPreview): string {
  const prompt = preview.confirmPrompt ?? destroyConfirmPrompt(preview.name, preview.provider);
  const changes = preview.stackChanges ?? [];
  if (preview.provider !== "portainer" || changes.length === 0) return prompt;
  return `Removes from your Portainer: ${changes.join("; ")}.\n${prompt}`;
}

/**
 * Runs `opscrew destroy` with `flags` (exported for tests, which pass a fake `destroy`): checks
 * the flags against the plan's target, has the name typed (or takes `--confirm`), builds the
 * typed-name approval handler and prints what was removed and the next steps.
 */
export async function runDestroyCommand(
  ctx: CliContext,
  flags: DestroyFlags,
  destroy: (deps: PhaseDeps, options: DestroyOptions) => Promise<DestroyResult> = runDestroy,
): Promise<void> {
  let typed: string | undefined;
  let provider = "hetzner" as DeployPlan["target"]["provider"];
  const result = await runPhaseCommand(ctx, async () => {
    const hashes = checkApproveFlags("destroy", flags);
    const hostKey = flags.hostKey?.trim();
    const deps0 = createPhaseDeps(ctx, { ai: false });
    const plan = await readArtifact("plan", deps0.paths.files.plan);
    const name = plan.app.name;
    provider = plan.target.provider;
    const own = provider === "own";
    const portainer = provider === "portainer";
    const what = own || portainer ? "the app's name" : "the server name";
    const scripted = flags.confirm !== undefined;
    checkConfirmName(
      flags.confirm,
      name,
      what,
      `To ${own ? "remove the app from your server" : portainer ? "remove the app from your Portainer" : "delete the deployment"}, run \`opscrew destroy --confirm ${name}\`.`,
    );
    if (portainer && flags.undoHost === true) {
      throw new OpsCrewError(
        "INVALID_INPUT",
        "--undo-host applies only to a server you already own; OpsCrew never changes the host your Portainer runs on, so there is nothing to undo there.",
        { hint: "Run `opscrew destroy` without it (add --delete-data to delete the app's data)." },
      );
    }
    if (!own && !portainer && (flags.undoHost === true || flags.deleteData === true)) {
      throw new OpsCrewError(
        "INVALID_INPUT",
        "--undo-host and --delete-data apply only to a server you already own or your Portainer; this deployment's server was created by OpsCrew and is deleted with its data.",
        { hint: "Run `opscrew destroy` without them." },
      );
    }
    if (!scripted && !ctx.isInteractive) {
      throw new OpsCrewError(
        "APPROVAL_REFUSED",
        `${own || portainer ? "Removing the app" : "Deleting the deployment"} needs ${what} typed by a person, and this run is not interactive. Nothing was changed.`,
        {
          hint: `Run \`opscrew destroy\` in a terminal, or \`opscrew destroy --confirm ${name}\` in a script.`,
        },
      );
    }
    if (scripted) typed = name;
    const deps = createPhaseDeps(ctx, {
      ai: false,
      approveHashes: hashes,
      wrapApprovals: (base, clock) =>
        new TypedConfirmationHandler(
          base,
          name,
          () => typed,
          scripted,
          ctx.stdout,
          what,
          { purposeOf: (hash) => savedHostPlanPurpose(deps0.paths, hash), scripted, hashes },
          clock,
        ),
    });
    // `--approve` can grant only the undo host plan here (with `--confirm`), never the rest.
    const services = servicesOf(ctx).destroy;
    return destroy(deps, {
      // default: a snapshot when data lives only on the server (database, backups on)
      snapshot: flags.snapshot === undefined ? "auto" : flags.snapshot,
      ...(flags.engine === undefined ? {} : { engine: flags.engine }),
      ...(services === undefined ? {} : { services }),
      ...(flags.undoHost === true ? { undoHost: true } : {}),
      ...(flags.deleteData === true ? { deleteData: true } : {}),
      ...(hostKey === undefined ? {} : { hostKey }),
      confirm: async (preview) => {
        if (scripted) return true;
        typed = await askTypedName(promptsOf(ctx), confirmMessage(preview), preview.name);
        return typed === preview.name;
      },
    });
  });
  if (provider === "portainer") {
    if (result.stackPlan !== undefined) {
      ctx.stdout(`\nApplied the stack teardown plan ${result.stackPlan} to your Portainer.\n`);
    }
    printNextSteps(ctx, [
      DEPLOY_AGAIN_STEP,
      "your Portainer, its other stacks and the host stay as they are; back up anything you keep yourself (OpsCrew cannot back up a Portainer host).",
    ]);
    return;
  }
  printNextSteps(ctx, [
    DEPLOY_AGAIN_STEP,
    ...(provider === "own"
      ? [
          "your server stays as it is otherwise; back up anything on it yourself (OpsCrew cannot take snapshots of your own server).",
        ]
      : []),
  ]);
}
