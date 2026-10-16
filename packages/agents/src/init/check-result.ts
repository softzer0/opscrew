import type { UserFacingError } from "@opscrew/contracts";
import type { InitCheck } from "./checks";

/** What one check found: an `InitCheck` without its id and title. */
export type CheckResult = Omit<InitCheck, "id" | "title">;

/** A failed check from a plain error: its message (or `message`), with its hint as the fix. */
export function failFrom(error: UserFacingError, message = error.message): CheckResult {
  return { status: "fail", message, fix: error.hint };
}
