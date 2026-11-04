import type { Proposal, Readings } from "../types";

/** The reliability proposals: backups, the scheduled check, check flaps, restart loops. */
export function reliabilityRules(_readings: Readings): Proposal[] {
  throw new Error("not implemented yet");
}
