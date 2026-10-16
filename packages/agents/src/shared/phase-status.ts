import { PHASES, type PhaseName } from "@opscrew/contracts";
import type { PhaseRecord } from "@opscrew/core";

/** Phases shown only once they ran: a move to another provider and the Portainer add-on. */
const OPTIONAL_PHASES: readonly PhaseName[] = ["retarget", "portainer"];

/**
 * The phase table of `opscrew status` and `opscrew_status`: one line per phase with its result,
 * time and summary, or "not run". A move and the Portainer add-on have a line only once they ran.
 */
export function phaseStatusLines(phases: Partial<Record<PhaseName, PhaseRecord>>): string[] {
  const width = Math.max(...PHASES.map((phase) => phase.length));
  return PHASES.flatMap((phase) => {
    const record = phases[phase];
    const name = phase.padEnd(width);
    if (record === undefined) return OPTIONAL_PHASES.includes(phase) ? [] : [`  ${name}  not run`];
    const summary = record.summary === undefined ? "" : `  ${record.summary}`;
    return [`  ${name}  ${record.status.padEnd(7)}  ${record.at}${summary}`];
  });
}
