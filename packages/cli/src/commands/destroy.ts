import {
  type DestroyOptions,
  type DestroyPreview,
  type DestroyResult,
  destroyConfirmPrompt,
  extraCloudServers,
  type PhaseDeps,
  providerBucket,
  runDestroy,
  savedHostPlanPurpose,
  savedLocalPlanPurpose,
} from "@opscrew/agents";
import type { ApprovalDecision, ApprovalHandler, ApprovalRequest, Clock } from "@opscrew/contracts";
import { approvalDecision, OpsCrewError, systemClock } from "@opscrew/core";
import { type DeployPlan, isServerlessProvider, readArtifact } from "@opscrew/plan-schema";
import type { Command } from "commander";
import { askTypedName, checkConfirmName, hashListed } from "../approval";
import type { CliContext } from "../context";
import { createPhaseDeps, promptsOf, servicesOf } from "../deps";
import { collect, runPhaseCommand } from "../ui/deploy";
import { addEnvOption, chooseEnvironment } from "../ui/environment";
import { printNextSteps } from "../ui/output";
import { addHostKeyOption, checkApproveFlags, deployAgainStep, engineOption } from "./provision";

/** The flags of `opscrew destroy`. */
export interface DestroyFlags {
  snapshot?: boolean;
  /**
   * Every `--confirm <name>`: the server name (the app's on the user's own server, in a Portainer,
   * on this computer or a site), then each extra cloud server's name at its provider.
   */
  confirm?: string[];
  engine?: "tofu" | "terraform";
  /** Your own server: also reverse OpsCrew's host changes (a separate host plan and approval). */
  undoHost?: boolean;
  /** Your own server: also delete the app's data (needs the typed app name). */
  deleteData?: boolean;
  hostKey?: string;
  /** Repeated `--approve <hash>`: the undo host plan (`--undo-host`) in a script. */
  approve?: string[];
  /** `--app <key>`: the repository's app. */
  app?: string;
  /** `--env <name>`: the app's environment. */
  env?: string;
  /** GitHub Pages: also delete GitHub's domain verification record. */
  deleteVerification?: boolean;
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
 * that name; a `stack-apply` without them is never covered); on GitHub Pages, the Pages plan that
 * removes the site (a `pages-apply` with `allowDestroy` that asks for exactly that name,
 * likewise); on every target, the Cloudflare plan that removes the app's hostnames from OpsCrew's
 * shared rules (a `cloudflare-apply` with `allowDestroy` that asks for exactly that name,
 * likewise). A `--confirm` run also approves
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
    if (
      request.kind === "stack-apply" ||
      request.kind === "cloudflare-apply" ||
      request.kind === "pages-apply"
    ) {
      // The user's Portainer's teardown, this app's hostnames leaving OpsCrew's shared Cloudflare
      // rules, and the GitHub Pages site's removal: only a plan that deletes (allowDestroy) and
      // asks for the name.
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
 * Each extra server OpsCrew created (feature 018) needs its own name typed after it, or one more
 * `--confirm <app>-<server>` in a script.
 * On a server the user owns (FR-912) it removes only the app (Cloudflare resources and a teardown
 * host plan; the app's data only with `--delete-data`) after the app's name is typed, never the
 * server, and `--undo-host` adds the undo host plan as its own approval: it deletes the deploy user
 * OpsCrew created, so the app's name is typed again (`--confirm <app>` with `--approve <hash>` in
 * scripts). In the user's Portainer (FR-1014) it removes only what OpsCrew created there (its
 * stacks, registry entry and repository access) and on Cloudflare, after the app's name is typed;
 * the stack teardown plan is approved with that name, the app's data volumes only with
 * `--delete-data`. On this computer (the localhost target) it removes the app's containers,
 * networks and folders after the app's name is typed (the local teardown plan, approved by its
 * hash), its data volumes only with `--delete-data`. A site on Cloudflare's hosting or GitHub
 * Pages (FR-1608) is removed after the app's name is typed, each plan approved with that name;
 * GitHub's domain verification record goes only with `--delete-verification`. `--env` picks the
 * environment. Exit codes: 0 torn down, 1 refused or not confirmed, 2 error.
 */
export function register(program: Command, ctx: CliContext): void {
  const command = program
    .command("destroy")
    .description(
      "Delete the deployment's infrastructure, or remove the app from your own server, your Portainer, this computer, Cloudflare's hosting or GitHub Pages (asks for the name)",
    )
    .option("--snapshot", "Take a snapshot of the server first")
    .option("--no-snapshot", "Do not take a snapshot of the server first")
    .option(
      "--confirm <name>",
      "The server name (on your own server, in your Portainer, on this computer, Cloudflare's hosting or GitHub Pages, the app's name), to run without prompts (for scripts and CI); with extra servers OpsCrew created, give it again for each one's name (<app>-<server>)",
      collect,
    )
    .option(
      "--delete-verification",
      "GitHub Pages: also delete GitHub's domain verification record (kept by default, so the domain stays verified for your account)",
    )
    .addOption(engineOption())
    .option(
      "--undo-host",
      "Your own server: also reverse OpsCrew's changes to it (deploy user, SSH and firewall settings, automatic updates), as a separate plan you approve",
    )
    .option(
      "--delete-data",
      "Also delete the app's data: its Docker volumes and /srv/data on your own server, in your Portainer or on this computer, and its bucket at a provider with its files; asks for the name",
    )
    .option(
      "--approve <hash>",
      "With --undo-host and --confirm <app> in a script: apply the undo host plan with this hash (printed by an earlier run)",
      collect,
    );
  addEnvOption(command);
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
  // The deployment's name, typed or given; each extra server's name is checked on its own.
  let typed: string | undefined;
  // An extra server whose name a script did not give.
  let unconfirmed: string | undefined;
  let provider = "hetzner" as DeployPlan["target"]["provider"];
  let flag = "";
  const scriptHint = () =>
    unconfirmed === undefined
      ? undefined
      : `In a script, add --confirm ${unconfirmed}: each server OpsCrew created is deleted only with its own name.`;
  const teardown = async (): Promise<DestroyResult> => {
    const hashes = checkApproveFlags("destroy", flags);
    const hostKey = flags.hostKey?.trim();
    const environment = await chooseEnvironment(ctx, flags, "destroy");
    flag = environment.flag;
    const deps0 = createPhaseDeps(ctx, {
      ai: false,
      app: environment.app,
      environment: environment.name,
    });
    const plan = await readArtifact("plan", deps0.paths.files.plan);
    const name = plan.app.name;
    provider = plan.target.provider;
    const own = provider === "own";
    const portainer = provider === "portainer";
    const local = provider === "localhost";
    const site = isServerlessProvider(provider);
    const app = own || portainer || local || site;
    const what = app ? "the app's name" : "the server name";
    const confirms = (flags.confirm ?? []).map((value) => value.trim());
    const scripted = confirms.length > 0;
    const again = `opscrew destroy${flag}`;
    // Each extra server OpsCrew created is deleted only with its own name at its provider.
    const extras = extraCloudServers(plan).map((server) => server.resource);
    const confirmFlags = [name, ...extras].map((value) => ` --confirm ${value}`).join("");
    const howTo = `To ${own ? "remove the app from your server" : portainer ? "remove the app from your Portainer" : local ? "remove the app from this computer" : site ? "remove the site" : "delete the deployment"}, run \`${again}${confirmFlags}\`.`;
    // A value that names no server stops; so does a script without the deployment's own name.
    checkConfirmName(
      confirms.find((value) => value !== name && !extras.includes(value)),
      name,
      extras.length === 0 ? what : `${what} or an extra server's name (${extras.join(", ")})`,
      howTo,
    );
    if (scripted && !confirms.includes(name)) {
      throw new OpsCrewError(
        "APPROVAL_REFUSED",
        `Add --confirm ${name}: the deployment is deleted only with its own name, as each extra server is with its own. Nothing was changed.`,
        { hint: howTo },
      );
    }
    if (flags.deleteVerification === true && provider !== "github-pages") {
      throw new OpsCrewError(
        "INVALID_INPUT",
        "--delete-verification applies only to a site on GitHub Pages, whose domain GitHub verifies with a DNS record.",
        { hint: `Run \`${again}\` without it.` },
      );
    }
    if (
      site &&
      (flags.undoHost === true || flags.deleteData === true || flags.snapshot !== undefined)
    ) {
      throw new OpsCrewError(
        "INVALID_INPUT",
        `--undo-host, --delete-data and --snapshot do not apply to a site on ${provider === "github-pages" ? "GitHub Pages" : "Cloudflare's hosting"}: OpsCrew changed nothing on a machine of yours to undo, and keeps no data of the app's there to delete or snapshot.`,
        {
          hint: `Run \`${again}\` without them${provider === "github-pages" ? " (add --delete-verification to delete GitHub's domain verification record too)" : ""}.`,
        },
      );
    }
    if ((portainer || local) && flags.undoHost === true) {
      throw new OpsCrewError(
        "INVALID_INPUT",
        portainer
          ? "--undo-host applies only to a server you already own; OpsCrew never changes the host your Portainer runs on, so there is nothing to undo there."
          : "--undo-host applies only to a server you already own; on this computer OpsCrew changes nothing outside its own folders and Docker objects, which the removal takes away.",
        { hint: `Run \`${again}\` without it (add --delete-data to delete the app's data).` },
      );
    }
    // On a server OpsCrew created, --delete-data deletes only the app's bucket at a provider.
    const bucket = providerBucket(plan) !== undefined;
    if (!app && (flags.undoHost === true || (flags.deleteData === true && !bucket))) {
      throw new OpsCrewError(
        "INVALID_INPUT",
        bucket
          ? "--undo-host applies only to a server you already own; this deployment's server was created by OpsCrew and is deleted with its data."
          : "--undo-host and --delete-data apply only to a server you already own, your Portainer, this computer or an app with a bucket at a provider; this deployment's server was created by OpsCrew and is deleted with its data.",
        { hint: `Run \`${again}\` without them.` },
      );
    }
    if (!scripted && !ctx.isInteractive) {
      throw new OpsCrewError(
        "APPROVAL_REFUSED",
        `${app ? "Removing the app" : "Deleting the deployment"} needs ${what} typed by a person, and this run is not interactive. Nothing was changed.`,
        {
          hint: `Run \`${again}\` in a terminal, or \`${again}${confirmFlags}\` in a script.`,
        },
      );
    }
    if (scripted) typed = name;
    // The typed name covers only a saved teardown plan: on this computer the local plan's, else
    // the host plan's of the user's own server.
    const purposeOf = (hash: string | undefined) =>
      local ? savedLocalPlanPurpose(deps0.paths, hash) : savedHostPlanPurpose(deps0.paths, hash);
    const deps = createPhaseDeps(ctx, {
      ai: false,
      app: environment.app,
      environment: environment.name,
      approveHashes: hashes,
      wrapApprovals: (base, clock) =>
        new TypedConfirmationHandler(
          base,
          name,
          () => typed,
          scripted,
          ctx.stdout,
          what,
          { purposeOf, scripted, hashes },
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
      ...(flags.deleteVerification === true ? { deleteVerification: true } : {}),
      ...(hostKey === undefined ? {} : { hostKey }),
      confirm: async (preview) => {
        // An extra cloud server, asked after the deployment's name: its own name.
        const extra = preview.server !== undefined;
        if (scripted) {
          if (!extra || confirms.includes(preview.name)) return true;
          unconfirmed = preview.name;
          return false;
        }
        const answer = await askTypedName(promptsOf(ctx), confirmMessage(preview), preview.name);
        if (!extra) typed = answer;
        return answer === preview.name;
      },
    });
  };
  const result = await runPhaseCommand(ctx, teardown, scriptHint);
  if (provider === "portainer") {
    if (result.stackPlan !== undefined) {
      ctx.stdout(`\nApplied the stack teardown plan ${result.stackPlan} to your Portainer.\n`);
    }
    printNextSteps(ctx, [
      deployAgainStep(flag),
      "your Portainer, its other stacks and the host stay as they are; back up anything you keep yourself (OpsCrew cannot back up a Portainer host).",
    ]);
    return;
  }
  if (provider === "localhost") {
    ctx.stdout(`\nWhat remains:\n${result.remaining.map((item) => `  - ${item}`).join("\n")}\n`);
    printNextSteps(ctx, [deployAgainStep(flag)]);
    return;
  }
  printNextSteps(ctx, [
    deployAgainStep(flag),
    ...(provider === "own"
      ? [
          "your server stays as it is otherwise; back up anything on it yourself (OpsCrew cannot take snapshots of your own server).",
        ]
      : []),
  ]);
}
