import { PHASES, type PhaseName } from "@opscrew/contracts";
import { isUserFacingError, type PhaseRecord } from "@opscrew/core";
import type { DeployPlan } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { deploySentence } from "../design/strategy";
import { signingPublicLog } from "../interview/questions";

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
 * The build and deploy lines of design and status (CLI and MCP): who builds the image and how a
 * new version replaces the running one, each with its reason (the builder line once design chose
 * one). `designed` is what design chose for the server, so a strategy the user set in `plan.yaml`
 * reads as theirs; without it the plan's own settings are taken as design's.
 */
export function buildStatusLines(
  plan: Pick<DeployPlan, "app" | "deploy">,
  designed: Pick<DeployPlan["deploy"], "strategy" | "reason"> = plan.deploy,
): string[] {
  const { build } = plan.app;
  const { deploy } = plan;
  return [
    ...(build === undefined ? [] : [`Image builder: ${build.builder}. ${build.reason}`]),
    `Deploys: ${deploy.strategy}. ${deploySentence(deploy, designed)}`.trimEnd(),
  ];
}

/**
 * The supply-chain lines of design and status (CLI and MCP): image signing, deploy tags and image
 * retention, each with what it does and the `opscrew/plan.yaml` setting that changes it. Signing,
 * on or off, says what it makes public for a private repository (FR-1219).
 */
export function supplyChainLines(plan: Pick<DeployPlan, "supplyChain" | "cicd">): string[] {
  const { deployTags, imageRetention } = plan.cicd;
  const publicLog = signingPublicLog(undefined);
  return [
    plan.supplyChain.sign
      ? `Image signing: on. Each image gets a keyless cosign signature. ${publicLog}`
      : `Image signing: off (the default). Set supplyChain.sign: true in opscrew/plan.yaml to sign each image with cosign. ${publicLog}`,
    deployTags.enabled
      ? `Deploy tags: on. Each healthy deploy tags its commit deploy-<UTC time>${deployTags.release ? " and gets a GitHub Release naming the image digest" : ""}.`
      : "Deploy tags: off (the default). Set cicd.deployTags.enabled: true in opscrew/plan.yaml to tag each healthy deploy.",
    imageRetention.enabled
      ? `Image retention: keeps the newest ${imageRetention.keep} deployed images in GitHub's container registry, never the running or the previous one (cicd.imageRetention in opscrew/plan.yaml).`
      : "Image retention: off. Every deployed image stays in GitHub's container registry (cicd.imageRetention in opscrew/plan.yaml).",
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
