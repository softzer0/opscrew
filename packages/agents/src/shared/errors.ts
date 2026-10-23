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
