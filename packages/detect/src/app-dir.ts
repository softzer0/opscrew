import { posix } from "node:path";
import type { UserFacingError } from "@opscrew/contracts";

/**
 * A detection input error that is safe to show to a user. It mirrors `OpsCrewError` from
 * `@opscrew/core` (code `INVALID_INPUT`, plain-English `message`, next step in `hint`) so
 * `isUserFacingError` accepts it.
 */
export class DetectError extends Error implements UserFacingError {
  override readonly name = "DetectError";
  readonly code = "INVALID_INPUT" as const;
  readonly hint: string;
  /** Deployable app directories the user can choose from. */
  readonly candidates: string[];

  constructor(message: string, init: { hint: string; candidates: string[] }) {
    super(message);
    this.hint = init.hint;
    this.candidates = init.candidates;
  }
}

/**
 * Normalises a user-supplied app directory to the repo-relative POSIX form used in facts:
 * backslashes become `/`, `./` prefixes, duplicate and trailing slashes are dropped, and an empty
 * value or `./` becomes `.`. The result is not validated; unknown directories are rejected by
 * detection.
 */
export function normalizeAppDir(input: string): string {
  const slashed = input.trim().replace(/\\/g, "/");
  if (slashed === "") return ".";
  const normalized = posix.normalize(slashed).replace(/\/+$/, "");
  return normalized === "" ? (slashed.startsWith("/") ? "/" : ".") : normalized;
}

/** Builds the error for an app directory that is not one of the detected units. */
export function unknownAppDirError(input: string, candidates: string[]): DetectError {
  const shown = JSON.stringify(input.trim().slice(0, 200));
  const list =
    candidates.length > 0
      ? `Deployable apps found: ${candidates.join(", ")}.`
      : "OpsCrew found no deployable app in a subdirectory.";
  const example = candidates[0] ?? ".";
  return new DetectError(`${shown} is not an app directory OpsCrew detected. ${list}`, {
    hint: `Pick one of the listed directories, for example \`opscrew analyze --app ${example}\`, or use "." for the repository root.`,
    candidates,
  });
}
