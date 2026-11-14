import {
  type ErrorCode,
  errorMessage,
  isUserFacingError,
  listText,
  OpsCrewError,
  zodIssues,
} from "@opscrew/core";
import { cloudProvider } from "@opscrew/providers";
import type { z } from "zod";

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

/** OpsCrew can't reach `provider`'s API: its credentials are not set. */
export function credentialsMissing(provider: string): OpsCrewError {
  const { displayName, credentials } = cloudProvider(provider);
  return new OpsCrewError(
    "CREDENTIALS_MISSING",
    `OpsCrew cannot reach ${displayName}: its credentials (${listText(credentials.envVars)}) are not set.`,
    { hint: "Set them, then run the command again." },
  );
}

/** The infrastructure's outputs don't hold `what` (`the firewalls the servers want`) as rendered. */
export function unreadableOutputs(what: string, error: z.ZodError): OpsCrewError {
  return new OpsCrewError(
    "ENGINE_FAILED",
    `OpsCrew could not read ${what} from the infrastructure's outputs (${zodIssues(error)}).`,
    {
      hint: "Undo manual edits under opscrew/infra (they are regenerated), then run the command again.",
    },
  );
}
