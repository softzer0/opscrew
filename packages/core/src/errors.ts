import type { UserFacingError } from "@opscrew/contracts";

/** Stable error codes. Add new codes here; never reuse or rename an existing one. */
export const ERROR_CODES = [
  "ARTIFACT_INVALID",
  "ARTIFACT_MISSING",
  "PLAN_NOT_APPROVED",
  "PLAN_HASH_MISMATCH",
  "DESTROY_NOT_APPROVED",
  "APPROVAL_REFUSED",
  "TOOL_DENIED",
  "ENGINE_NOT_FOUND",
  "ENGINE_FAILED",
  "CREDENTIALS_MISSING",
  "CREDENTIALS_INVALID",
  "PROVIDER_ERROR",
  "RUNTIME_NOT_CONFIGURED",
  "PHASE_PRECONDITION",
  "COMMAND_FAILED",
  "INVALID_INPUT",
  "INTERNAL",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * An error that is safe to show to a user: plain-English `message`, optional `hint` with the next
 * step. Never put secrets in either field.
 */
export class OpsCrewError extends Error implements UserFacingError {
  readonly code: ErrorCode;
  readonly hint?: string;

  constructor(code: ErrorCode, message: string, options?: { hint?: string; cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "OpsCrewError";
    this.code = code;
    if (options?.hint !== undefined) this.hint = options.hint;
  }
}

/**
 * True for errors that are safe and meaningful to show as-is: an `OpsCrewError` or a lookalike
 * (for example `ArtifactError` from plan-schema) whose `code` is one of {@link ERROR_CODES}.
 * Node system errors such as `ENOENT` also carry `code` and `message` but are not user-facing.
 */
export function isUserFacingError(value: unknown): value is UserFacingError {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.message === "string" &&
    typeof candidate.code === "string" &&
    (ERROR_CODES as readonly string[]).includes(candidate.code)
  );
}
