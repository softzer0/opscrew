import type { Money, VpsProviderId } from "@opscrew/contracts";
import { OpsCrewError, plural } from "@opscrew/core";
import type { MoveLayoutName, ServerModule } from "@opscrew/iac-templates";
import { type ModulePrefix, planHeading, unprotectPlanProblems } from "../destroy/checks";
import {
  assertDeletionPlan,
  type DeletionPreview,
  type DeletionSession,
  deletionSession,
  previewDeletion,
} from "../destroy/deletion";
import { type DestroyTexts, destroyTexts } from "../destroy/texts";
import { describeChanges, nothingDeletedHint, planStop, refusalReason } from "../shared";
import { protectionVariable } from "./layouts";
import type { MoveAction } from "./pending";
import { deletionStep } from "./plans";
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
  input: { serverInState: boolean; kept: string; beforeApply?: () => Promise<void> },
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
    ...(input.beforeApply !== undefined ? { beforeApply: input.beforeApply } : {}),
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
 * deleted." in every stop. Returns a stop for a non-interactive run.
 */
export async function removeMoveServer(
  removal: MoveRemoval,
  input: {
    preview: DeletionPreview;
    notes: readonly string[];
    note: string;
    costDelta?: Money;
    beforeApply?: () => Promise<void>;
  },
): Promise<RetargetResult | undefined> {
  const { session, which, words, del, flags } = removal;
  const { deps } = session;
  const side = SIDES[which];
  const app = del.app;
  const command = del.command;
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
    request: (plan) => ({
      kind: "iac-apply",
      title: `Delete the ${which} ${words.noun} ${app} on ${words.name} (${plural(plan.changes.length, "resource")} to delete)`,
      details: [
        planHeading(plan),
        ...describeChanges(plan.changes),
        ...input.notes,
        `Plan hash: ${plan.planHash}`,
      ].join("\n"),
      planHash: plan.planHash,
      allowDestroy: true,
      confirmPhrase: app,
      ...(input.costDelta !== undefined ? { costDelta: input.costDelta } : {}),
    }),
    refused: (approval, planHash) =>
      new OpsCrewError(
        "APPROVAL_REFUSED",
        `The removal of the ${which} ${words.noun} was not approved${refusalReason(approval)}. Nothing was deleted.${input.note}`,
        {
          hint: `Run \`${command}\` again and type ${app} when you are ready (in scripts: \`${command} ${flags.join(" ")} --approve ${planHash}\`).`,
        },
      ),
    allowDestroy: true,
    what: `deleting the ${which} server`,
    hint: `Fix the cause shown above, then run \`${command}\` again; it continues with what is left.`,
    ...(input.beforeApply !== undefined ? { beforeApply: input.beforeApply } : {}),
  });
  if (removed.kind === "pending") return pendingStop(session, removed.planHash, flags);
  if (removed.kind === "applied") {
    await recordApply(session, removed);
    deps.reporter.success(
      `Deleted the ${which} ${words.noun} (${plural(input.preview.changes.length, "resource")}).`,
    );
  }
  return undefined;
}
