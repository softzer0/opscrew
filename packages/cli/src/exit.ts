import { type ErrorCode, isUserFacingError } from "@opscrew/core";
import type { CliContext } from "./context";

/** Thrown by a command to end the process with `exitCode` after it has printed its own output. */
export class CliExit extends Error {
  constructor(readonly exitCode: number) {
    super(`exit ${exitCode}`);
    this.name = "CliExit";
  }
}

/** Exit code when checks or policies failed, or an approval was refused. */
export const REFUSED_EXIT_CODE = 1;
/** Exit code when the command could not run (bad input, missing credentials, engine errors). */
export const ERROR_EXIT_CODE = 2;

/** Error codes that mean "stopped on purpose" (exit 1) rather than "could not run" (exit 2). */
const REFUSED_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "APPROVAL_REFUSED",
  "PLAN_NOT_APPROVED",
  "PLAN_HASH_MISMATCH",
  "DESTROY_NOT_APPROVED",
  "PHASE_PRECONDITION",
  "ARTIFACT_MISSING",
]);

/**
 * Exit codes for every command: 0 done, 1 stopped on purpose (refused or cancelled approval,
 * failed policy or check, an earlier step not run yet), 2 could not run (bad input, missing credentials, engine or
 * unexpected errors).
 */
export function exitCodeFor(error: unknown): number {
  if (error instanceof CliExit) return error.exitCode;
  return isUserFacingError(error) && REFUSED_CODES.has(error.code as ErrorCode)
    ? REFUSED_EXIT_CODE
    : ERROR_EXIT_CODE;
}

/**
 * Prints `error` for the user on standard error: a user-facing error's message, then its hint
 * (once); anything else as `<unexpected>: <message>` with how to see the details. The stack
 * follows only with `OPSCREW_DEBUG=1`, and `extraHint` (advice for this run) comes last.
 */
export function printError(
  ctx: CliContext,
  error: unknown,
  options: { unexpected?: string; extraHint?: string } = {},
): void {
  const debug = ctx.env.OPSCREW_DEBUG === "1";
  if (isUserFacingError(error)) {
    ctx.reporter.error(error.message);
    if (error.hint && !error.message.includes(error.hint)) ctx.stderr(`  ${error.hint}\n`);
  } else {
    const message = error instanceof Error ? error.message : String(error);
    ctx.reporter.error(`${options.unexpected ?? "Something went wrong"}: ${message}`);
    if (!debug) ctx.stderr("  Re-run with OPSCREW_DEBUG=1 to see the details.\n");
  }
  if (debug && error instanceof Error && error.stack !== undefined) {
    ctx.stderr(`${error.stack}\n`);
  }
  if (options.extraHint !== undefined && options.extraHint !== "") {
    ctx.stderr(`  ${options.extraHint}\n`);
  }
}
