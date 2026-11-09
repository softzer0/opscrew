import { type ErrorCode, errorMessage, isUserFacingError, OpsCrewError } from "@opscrew/core";

/** The reason of an error in plain words, without a trailing full stop. */
export function reasonOf(error: unknown): string {
  return errorMessage(error).replace(/[.\s]+$/, "");
}

/** The error's code when it is OpsCrew's, else `COMMAND_FAILED`. */
export function codeOf(error: unknown): ErrorCode {
  return error instanceof OpsCrewError ? error.code : "COMMAND_FAILED";
}

/** The error's hint followed by a space, or nothing. */
export function hintOf(error: unknown): string {
  return isUserFacingError(error) && error.hint ? `${error.hint} ` : "";
}

/**
 * A user-facing `error` continued with what is true after it and the way on: its message, then
 * `said`; its hint (`fallback`, as "Fix what it names. ", when it has none), then `next`. Any other
 * error is returned as it is.
 */
export function continued(
  error: unknown,
  text: { said: string; next: string; fallback?: string },
): unknown {
  if (!isUserFacingError(error)) return error;
  return new OpsCrewError(codeOf(error), `${error.message.replace(/\s+$/, "")} ${text.said}`, {
    hint: `${hintOf(error) || (text.fallback ?? "")}${text.next}`,
    cause: error,
  });
}
