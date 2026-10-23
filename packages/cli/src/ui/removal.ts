import { OpsCrewError } from "@opscrew/core";
import { askTypedName, checkConfirmName } from "../approval";
import type { CliContext } from "../context";
import { promptsOf } from "../deps";

/** What {@link confirmRemoval} has typed back, and how its messages name it. */
export interface RemovalConfirmation {
  /** The name to type back, or to give with `--confirm`: an environment's name, an app's key. */
  name: string;
  /** `--confirm <name>`, when given. */
  confirm: string | undefined;
  /** How messages call the name: `the environment's name`. */
  what: string;
  /** What is removed: `the staging environment`. */
  subject: string;
  /** The full list of what goes, printed before the name is asked for. */
  details: string;
  /** The command that runs the removal again, without `--confirm`. */
  again: string;
}

/**
 * Has the name typed back before files that hold secrets (a deploy key, a state passphrase,
 * generated secrets) are removed: `--confirm <name>` in a script, which must match; in a
 * terminal, `details` and then a prompt for the name. Anything else stops with
 * `APPROVAL_REFUSED`, and nothing is removed.
 */
export async function confirmRemoval(ctx: CliContext, removal: RemovalConfirmation): Promise<void> {
  const { name, again } = removal;
  checkConfirmName(removal.confirm, name, removal.what, `Run \`${again} --confirm ${name}\`.`);
  if (removal.confirm !== undefined) return;
  if (!ctx.isInteractive) {
    throw new OpsCrewError(
      "APPROVAL_REFUSED",
      `Removing ${removal.subject} deletes its deploy key, state passphrase and generated secrets on this computer, so it needs ${removal.what} typed by a person, and this run is not interactive. Nothing was removed.`,
      { hint: `Run \`${again}\` in a terminal, or \`${again} --confirm ${name}\` in a script.` },
    );
  }
  ctx.stdout(`\n${removal.details}\n`);
  const typed = await askTypedName(
    promptsOf(ctx),
    `Type ${name} to remove it (anything else cancels)`,
    name,
  );
  if (typed !== name) {
    throw new OpsCrewError(
      "APPROVAL_REFUSED",
      `The name typed was not ${name}, so nothing was removed.`,
      { hint: `Run \`${again}\` again when you are ready.` },
    );
  }
}
