import { PHASES, type PhaseName } from "@opscrew/contracts";
import { isUserFacingError, type PhaseRecord } from "@opscrew/core";
import type { DeployPlan } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { deploySentence } from "../design/strategy";

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

/**
 * The build and deploy lines of `opscrew status` and `opscrew_status`: who builds the image and
 * how a new version replaces the running one, each with its reason (the builder line once design
 * chose one).
 */
export function buildStatusLines(plan: Pick<DeployPlan, "app" | "deploy">): string[] {
  const { build } = plan.app;
  const { deploy } = plan;
  return [
    ...(build === undefined ? [] : [`Image builder: ${build.builder}. ${build.reason}`]),
    `Deploys: ${deploy.strategy}. ${deploySentence(deploy, deploy)}`.trimEnd(),
  ];
}

/**
 * Runs `run` as `phase`. When it throws, the phase is recorded as failed with the redacted
 * user-facing message (at most 300 characters; "unexpected error" for any other error) and the
 * error is thrown again: a failed write of the state never hides it.
 */
export async function runPhase<T>(
  deps: Pick<PhaseDeps, "state" | "redactor">,
  phase: PhaseName,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const reason = isUserFacingError(error)
      ? deps.redactor.redact(error.message).slice(0, 300)
      : "unexpected error";
    await deps.state.markPhase(phase, "failed", reason).catch(() => undefined);
    throw error;
  }
}
