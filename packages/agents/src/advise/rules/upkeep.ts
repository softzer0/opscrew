import type { Proposal, Readings } from "../types";

/** The upkeep and security proposals: Dependabot, security updates, host checks, tokens. */
export function upkeepRules(_readings: Readings): Proposal[] {
  throw new Error("not implemented yet");
}
