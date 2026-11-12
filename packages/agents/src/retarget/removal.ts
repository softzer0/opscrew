import type { Money, VpsProviderId } from "@opscrew/contracts";
import { OpsCrewError, plural } from "@opscrew/core";
import type { MoveLayoutName, ServerModule } from "@opscrew/iac-templates";
import {
  type CancelledServer,
  cancelDates,
  cancelFailedHint,
  cancelledIn,
  cancelNotes,
  shutDown,
  shutdownLines,
} from "../destroy/cancel";
import { type ModulePrefix, planHeading, unprotectPlanProblems } from "../destroy/checks";
import {
  assertDeletionPlan,
  type DeletionPreview,
  type DeletionSession,
  deletionSession,
  previewDeletion,
  type ServerApiInput,
} from "../destroy/deletion";
import { type DestroyTexts, destroyTexts } from "../destroy/texts";
import { describeChanges, nothingDeletedHint, planStop, refusalReason } from "../shared";
import { protectionVariable } from "./layouts";
import type { MoveAction } from "./pending";
import { type DeletionPlan, deletionStep } from "./plans";
import { layoutOf, type MoveSession, recordApply, useLayout } from "./session";
import { pendingStop } from "./steps";
import { ABORT_COMMAND, FINISH_COMMAND, providerWords } from "./texts";
import type { RetargetResult } from "./types";

/** Which server of a move is removed: the old one (`--finish`) or the new one (`--abort`). */
export type MoveServer = "old" | "new";

/** What a removal of each server plans with: its module, its command and its layouts. */
const SIDES: Record<
  MoveServer,
  {
    module: ServerModule;
    command: string;
    preview: { layout: MoveLayoutName; suffix: string };
    lift: { layout: MoveLayoutName; action: MoveAction; suffix: string };
    remove: { action: MoveAction; suffix: string };
  }
> = {
  old: {
    module: "server_previous",
    command: FINISH_COMMAND,
    preview: { layout: "finish", suffix: "retarget-finish-preview" },
    lift: { layout: "switched", action: "finish-unprotect", suffix: "retarget-unprotect" },
    remove: { action: "finish-destroy", suffix: "retarget-finish" },
  },
  new: {
    module: "server",
    command: ABORT_COMMAND,
    preview: { layout: "abort-remove", suffix: "retarget-abort-preview" },
    lift: { layout: "both", action: "abort-unprotect", suffix: "retarget-abort-unprotect" },
    remove: { action: "abort-remove", suffix: "retarget-abort" },
  },
};

/** The removal of one server of a move, with what its steps share. */
export interface MoveRemoval {
  session: MoveSession;
  which: MoveServer;
  del: DeletionSession & { provider: VpsProviderId };
  /** Every resource of that server lives under this prefix during a move. */
  prefix: ModulePrefix;
  /** The provider's name and what it calls a server. */
  words: { name: string; noun: string };
  texts: DestroyTexts;
  /** The flags a scripted run repeats with each `--approve <hash>`. */
  flags: readonly string[];
}

/**
 * What the provider cancelling the move's server means (`cancelNotes`): its own resources go at
 * once, while the app's DNS records follow the app to the other server.
 */
export function moveCancelNotes(servers: readonly CancelledServer[], app: string): string[] {
  return cancelNotes(servers, app, "its other resources (such as its firewall and SSH key)");
}

/** The removal of the `which` server on `provider`. */
export function moveRemoval(
  session: MoveSession,
  which: MoveServer,
  provider: VpsProviderId,
  flags: readonly string[],
): MoveRemoval {
  const side = SIDES[which];
  const del = deletionSession(
    {
      deps: session.deps,
      provider,
      app: session.plan.app.name,
      command: side.command,
      what: `removal of the ${which} server`,
      phase: "retarget",
      firewalls: session.services.firewalls,
      servers: session.services.servers?.[provider],
    },
    { engine: session.engine, env: session.env, dir: session.dir },
  );
  return {
    session,
    which,
    del,
    prefix: `module.${side.module}.`,
    words: providerWords(provider),
    texts: destroyTexts(provider),
    flags,
  };
}

/**
 * What the removal deletes: a plan of the root without that server's module, which may only
 * delete resources under its prefix; it is discarded, never applied.
 */
export async function previewMoveRemoval(removal: MoveRemoval): Promise<DeletionPreview> {
  const { session, which, words, texts, del } = removal;
  const side = SIDES[which];
  session.deps.reporter.step(
    `Planning the removal of the ${which} ${words.noun} to see what it deletes`,
  );
  await useLayout(session, side.preview.layout);
  return previewDeletion(del, {
    suffix: side.preview.suffix,
    bounded: {
      prefix: removal.prefix,
      hint: `Check the ${texts.noun}s in ${texts.console} and the infrastructure files, then run \`${del.command}\` again.`,
    },
  });
}

/**
 * Lifts the delete protection of the server being removed, when its provider has one (Hetzner)
 * and it is still in the state: a plan that may only turn the protection off under its prefix,
 * approved by its hash (`iac-apply`), then the removal layout again. `kept` follows "Nothing was
 * deleted." in every stop. Returns a stop for a non-interactive run, else whether a protection was
 * there to lift (it is off now).
 */
export async function liftMoveProtection(
  removal: MoveRemoval,
  input: { serverInState: boolean; kept: string },
): Promise<{ stop: RetargetResult } | { lifted: boolean }> {
  const { session, which, words, texts, del, flags } = removal;
  const { deps } = session;
  const side = SIDES[which];
  const app = del.app;
  const command = del.command;
  const variable = protectionVariable(layoutOf(session, side.lift.layout), side.module);
  if (variable === undefined || !input.serverInState) return { lifted: false };
  deps.reporter.step(`Planning to lift delete protection on the ${which} ${words.noun}`);
  await useLayout(session, side.lift.layout);
  const lifted = await deletionStep(session, del, {
    action: side.lift.action,
    suffix: side.lift.suffix,
    vars: { [variable]: "false" },
    check: (plan) => {
      const problems = unprotectPlanProblems(plan.changes, plan.planJson, {
        prefix: removal.prefix,
      });
      if (problems.length === 0) return;
      throw planStop(
        `Lifting the delete protection on the ${which} ${words.noun} would also change other things, so OpsCrew stopped. Nothing was deleted.${input.kept}`,
        problems,
        `The infrastructure no longer matches what OpsCrew applied. Check the ${words.noun}s in ${texts.console}, then run \`${command}\` again.`,
      );
    },
    request: (plan) => ({
      kind: "iac-apply",
      title: `Lift delete protection on the ${which} ${words.noun} ${app}`,
      details: [
        planHeading(plan),
        ...describeChanges(plan.changes),
        `This only turns off the ${which} ${words.noun}'s delete and rebuild protection so that the next plan can delete it. Nothing is deleted yet.`,
        `Plan hash: ${plan.planHash}`,
      ].join("\n"),
      planHash: plan.planHash,
    }),
    refused: (approval, planHash) =>
      new OpsCrewError(
        "APPROVAL_REFUSED",
        `Delete protection on the ${which} ${words.noun} was not lifted${refusalReason(approval)}. Nothing was deleted.${input.kept}`,
        {
          hint: `Run \`${command}\` again when you are ready (in scripts: \`${command} ${flags.join(" ")} --approve ${planHash}\`).`,
        },
      ),
    allowDestroy: false,
    what: `lifting delete protection on the ${which} server`,
    hint: nothingDeletedHint(command),
  });
  if (lifted.kind === "pending") return { stop: pendingStop(session, lifted.planHash, flags) };
  if (lifted.kind === "applied") {
    await recordApply(session, lifted);
    deps.reporter.success(`Delete protection on the ${which} ${words.noun} is off.`);
  } else {
    deps.reporter.info(`Delete protection on the ${which} ${words.noun} is already off.`);
  }
  await useLayout(session, side.preview.layout);
  return { lifted: true };
}

/**
 * Deletes the server: a plan of the root without its module, bounded to the confirmed `preview`
 * and server, approved by its hash with `allowDestroy` and the typed app name (`iac-apply`).
 * `notes` go into the approval between the changes and the hash; `note` follows "Nothing was
 * deleted." in every stop. Where the provider cancels the server instead (`cancel`, from
 * `cancelledServers`), the approval says so, the server is shut down through `cancel.input` after
 * the approval and before the apply, and its end date is read back (and audited) after it. Returns
 * a stop for a non-interactive run, else those end dates in words (none when nothing was
 * cancelled).
 */
export async function removeMoveServer(
  removal: MoveRemoval,
  input: {
    preview: DeletionPreview;
    notes: readonly string[];
    note: string;
    costDelta?: Money;
    cancel?: { servers: readonly CancelledServer[]; input: ServerApiInput };
  },
): Promise<{ stop: RetargetResult } | { cancelled: string[] }> {
  const { session, which, words, del, flags } = removal;
  const { deps } = session;
  const side = SIDES[which];
  const app = del.app;
  const command = del.command;
  const { cancel } = input;
  // The servers whose deletion in `plan` is their provider's cancel.
  const cancelling = (plan: DeletionPlan) => cancelledIn(cancel?.servers ?? [], plan.changes);
  // Those the approved plan cancels, shut down before its apply.
  let cancelled: CancelledServer[] = [];
  deps.reporter.step(`Planning the removal of the ${which} ${words.noun}`);
  const removed = await deletionStep(session, del, {
    action: side.remove.action,
    suffix: side.remove.suffix,
    check: (plan) =>
      assertDeletionPlan(
        del,
        plan,
        {
          prefix: removal.prefix,
          confirmed: input.preview.addresses,
          serverIds: input.preview.serverIds,
        },
        {
          note: `Nothing was deleted.${input.note}`,
          hint: `Run \`${command}\` again to see the current list and confirm it.`,
        },
      ),
    request: (plan) => {
      const servers = cancelling(plan);
      const count = plural(plan.changes.length, "resource");
      return {
        kind: "iac-apply",
        title:
          servers.length > 0
            ? `Cancel the ${which} ${words.noun} ${app} on ${words.name} and delete its other resources (${count} in the plan)`
            : `Delete the ${which} ${words.noun} ${app} on ${words.name} (${count} to delete)`,
        details: [
          planHeading(plan),
          ...describeChanges(plan.changes),
          ...shutdownLines(servers, app),
          ...moveCancelNotes(servers, app),
          ...input.notes,
          `Plan hash: ${plan.planHash}`,
        ].join("\n"),
        planHash: plan.planHash,
        allowDestroy: true,
        confirmPhrase: app,
        ...(input.costDelta !== undefined ? { costDelta: input.costDelta } : {}),
      };
    },
    refused: (approval, planHash) =>
      new OpsCrewError(
        "APPROVAL_REFUSED",
        `The removal of the ${which} ${words.noun} was not approved${refusalReason(approval)}. Nothing was deleted.${input.note}`,
        {
          hint: `Run \`${command}\` again and type ${app} when you are ready (in scripts: \`${command} ${flags.join(" ")} --approve ${planHash}\`).`,
        },
      ),
    allowDestroy: true,
    what: cancel
      ? `cancelling the ${which} server and deleting the rest`
      : `deleting the ${which} server`,
    hint: cancel
      ? cancelFailedHint(cancel.servers, app, command)
      : `Fix the cause shown above, then run \`${command}\` again; it continues with what is left.`,
    ...(cancel
      ? {
          beforeApply: async (plan: DeletionPlan) => {
            cancelled = cancelling(plan);
            await shutDown(del, cancelled, cancel.input);
          },
        }
      : {}),
  });
  if (removed.kind === "pending") return { stop: pendingStop(session, removed.planHash, flags) };
  if (removed.kind !== "applied") return { cancelled: [] };
  await recordApply(session, removed);
  const resources = plural(input.preview.changes.length, "resource");
  if (cancel === undefined || cancelled.length === 0) {
    deps.reporter.success(`Deleted the ${which} ${words.noun} (${resources}).`);
    return { cancelled: [] };
  }
  deps.reporter.success(
    `Cancelled the ${which} ${words.noun} and deleted the rest (${resources}).`,
  );
  // When the cancelled server's contract ends, as its provider answers it (audited).
  const dates = await cancelDates(del, cancelled, cancel.input);
  for (const line of dates) deps.reporter.info(line);
  return { cancelled: dates };
}
