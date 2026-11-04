import type { Proposal, Readings } from "../types";

/** The size proposals: a larger or smaller server, the disk, a container at its limit. */
export function sizeRules(_readings: Readings): Proposal[] {
  throw new Error("not implemented yet");
}
