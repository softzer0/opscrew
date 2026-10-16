import { isUserFacingError } from "@opscrew/core";
import type { CliContext } from "../context";
import { CliExit, exitCodeFor, printError } from "../exit";

/**
 * Runs a phase and turns any error into plain-English output (see `printError`) and a
 * {@link CliExit} with the code from {@link exitCodeFor}. `extraHint` may add advice for an error.
 */
export async function runPhaseCommand<T>(
  ctx: CliContext,
  run: () => Promise<T>,
  extraHint?: (error: unknown) => string | undefined,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof CliExit) throw error;
    const extra = extraHint?.(error);
    printError(ctx, error, extra === undefined ? {} : { extraHint: extra });
    throw new CliExit(exitCodeFor(error));
  }
}

/**
 * Hint for an approval refused in a non-interactive run without `--yes`. For `provision`, which has
 * `--confirm <app>`, it also says how a script applies a plan that deletes or replaces resources.
 */
export function assumeYesHint(
  ctx: CliContext,
  yes: boolean | undefined,
  command?: string,
): (error: unknown) => string | undefined {
  const deletions =
    command === "provision"
      ? "a plan that deletes or replaces resources also needs --confirm <app name> (opscrew provision --approve <hash> --confirm <app name>), other destroys and changed host keys need an interactive terminal."
      : "destroys and changed host keys need an interactive terminal.";
  return (error) =>
    !ctx.isInteractive &&
    yes !== true &&
    isUserFacingError(error) &&
    error.code === "APPROVAL_REFUSED"
      ? `This run is not interactive: add --yes to approve writing the generated files, storing the GitHub secrets, pushing and opening the pull request. Infrastructure changes need --approve <hash>; ${deletions}`
      : undefined;
}

/** Commander option parser for a repeatable option: collects every value in order. */
export function collect(value: string, previous: string[] | undefined): string[] {
  return [...(previous ?? []), value];
}

/** One plan of a `--plan-only` run that needs its own approval. */
export interface PlannedHash {
  /** What the plan changes, for example `infrastructure (Cloudflare)` or `host plan for your server`. */
  label: string;
  hash: string;
}

/**
 * Prints the hashes of a `--plan-only` run that made several plans (a server the user owns: the
 * infrastructure plan and the host plan), each labelled, with the exact command that applies
 * exactly these plans (one `--approve` per plan) and nothing else.
 */
export function printPlanHashes(
  ctx: CliContext,
  plans: readonly PlannedHash[],
  approveCommand: string,
): void {
  if (plans.length === 1 && plans[0] !== undefined) {
    printPlanHash(ctx, plans[0].hash, approveCommand);
    return;
  }
  const width = Math.max(...plans.map((plan) => plan.label.length));
  ctx.stdout(
    [
      "",
      "Plan hashes (SHA-256), one approval each:",
      "",
      ...plans.map((plan) => `    ${`${plan.label}:`.padEnd(width + 1)}  ${plan.hash}`),
      "",
      "Review the plans above. To apply exactly these plans, run:",
      "",
      `    ${approveCommand}`,
      "",
      "Only saved plans with these hashes are applied; if one no longer matches, OpsCrew refuses it and you plan again.",
      "",
    ].join("\n"),
  );
}

/**
 * Prints the plan hash of a `--plan-only` run on its own line, with the exact command that applies
 * that plan and nothing else.
 */
function printPlanHash(ctx: CliContext, planHash: string, approveCommand: string): void {
  ctx.stdout(
    [
      "",
      "Plan hash (SHA-256):",
      "",
      `    ${planHash}`,
      "",
      "Review the plan above. To apply exactly this plan, run:",
      "",
      `    ${approveCommand}`,
      "",
      "Only the saved plan with this hash is applied; if it no longer matches, OpsCrew refuses and you plan again.",
      "",
    ].join("\n"),
  );
}
