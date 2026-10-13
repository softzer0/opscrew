import { OpsCrewError } from "@opscrew/core";
import type { PhaseDeps } from "../context";
import type {
  AbortRetargetOptions,
  FinishRetargetOptions,
  RetargetOptions,
  RetargetResult,
} from "./types";

export type * from "./types";

function notYet(): never {
  throw new OpsCrewError("INTERNAL", "Moving between providers is not implemented yet.", {
    hint: "Update OpsCrew; `opscrew retarget` arrives with feature 005.",
  });
}

/** Starts or continues a move to another provider (T508). */
export async function runRetarget(
  _deps: PhaseDeps,
  _options: RetargetOptions = {},
): Promise<RetargetResult> {
  return notYet();
}

/** Deletes the old server after the switch and publishes the final files (T508). */
export async function finishRetarget(
  _deps: PhaseDeps,
  _options: FinishRetargetOptions = {},
): Promise<RetargetResult> {
  return notYet();
}

/** Undoes a move before the DNS switch (T508). */
export async function abortRetarget(
  _deps: PhaseDeps,
  _options: AbortRetargetOptions = {},
): Promise<RetargetResult> {
  return notYet();
}
