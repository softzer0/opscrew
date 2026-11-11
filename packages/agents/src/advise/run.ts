/**
 * `opscrew advise` (feature 021, US1, US2, US4; plan.md "5."): reads the environment, runs the
 * rules and lists their proposals, the most urgent first. It changes nothing.
 */
import { OpsCrewError } from "@opscrew/core";
import { type DeployPlan, isCloudProvider, monitoringOf } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { commandFlags } from "../environments/choice";
import { moveInProgress } from "../provision/guard";
import { hasDeployment, serverWords } from "../shared";
import { targetOf } from "../shared/servers";
import { type ReadingsOptions, readAdvice } from "./readings";
import { componentRules } from "./rules/components";
import { costRules } from "./rules/cost";
import { reliabilityRules } from "./rules/reliability";
import { PLAN } from "./rules/shared";
import { sizeRules } from "./rules/size";
import { upkeepRules } from "./rules/upkeep";
import {
  type AdviceReport,
  type Basis,
  CATEGORIES,
  type PlanChange,
  type Proposal,
  type ProposalCategory,
  type Readings,
  URGENCIES,
} from "./types";

export type { ReadingsOptions as RunAdviseOptions };

const RULES = [sizeRules, costRules, reliabilityRules, upkeepRules, componentRules];

/** The proposals that change the servers: none while a move is in progress. */
const SERVER_CATEGORIES: ReadonlySet<ProposalCategory> = new Set(["size", "cost", "components"]);

/** What `opscrew provision` does with a plan change, after its command (no full stop). */
export const PROVISION_APPLIES = "shows the change and applies it once you approve its hash";

/** The memory limit in MB `plan` gives `container`; `undefined` without one. */
export function memoryLimitOf(
  plan: DeployPlan,
  container: Extract<PlanChange, { kind: "memory-limit" }>["container"],
): number | undefined {
  if (container.kind === "web") return plan.app.memoryMb;
  const planned = container.kind === "worker" ? plan.processes.workers : plan.services;
  return planned.find((c) => c.name === container.name)?.memoryMb;
}

/** True when `plan` already holds `change` (a memory limit at least as high). */
function planHolds(plan: DeployPlan, change: PlanChange): boolean {
  const target = "server" in change ? targetOf(plan, change.server) : undefined;
  switch (change.kind) {
    case "server-type":
      return (
        target !== undefined && "serverType" in target && target.serverType === change.serverType
      );
    case "backups":
      return target !== undefined && "backups" in target && target.backups;
    case "check":
      return plan.observability?.check?.enabled === true;
    case "memory-limit": {
      const limit = memoryLimitOf(plan, change.container);
      return limit !== undefined && limit >= change.memoryMb;
    }
  }
}

/** `proposal`, which the plan already holds: provision applies it (the spec's edge case). */
function alreadyInPlan(proposal: Proposal, flags: string): Proposal {
  const provision = `opscrew provision${flags}`;
  return {
    ...proposal,
    title: `${proposal.title}: already in the plan, not provisioned yet`,
    reasons: [
      ...proposal.reasons,
      {
        text: `The plan already holds this change; \`${provision}\` ${PROVISION_APPLIES}`,
        basis: PLAN,
      },
    ],
    apply: { kind: "command", command: provision },
  };
}

const UNTIL_FINISHED =
  "Until it finishes, advise proposes nothing that changes the servers or the plan";

/**
 * The move in progress, when there is one: to another provider (`moveInProgress`'s words, then
 * `opscrew retarget` with the environment's flags; once an abort began, only the abort), or of a
 * service between the app's servers (provision continues it).
 */
function moveProposal(plan: DeployPlan, flags: string): Proposal | undefined {
  const fields = {
    category: "moving",
    urgency: "now",
    title: "Finish the move in progress before other changes",
  } as const;
  const retarget = moveInProgress(plan);
  if (retarget !== undefined) {
    const command = `opscrew retarget${flags}`;
    const aborting = plan.retarget?.abort !== undefined;
    const next = aborting
      ? `run \`${command} --abort\` to finish the abort, which continues where it stopped and puts the app back on the previous server`
      : `run \`${command}\` to continue it, \`${command} --finish\` after the switch, or \`${command} --abort\` before it`;
    return {
      ...fields,
      id: "moving.env.retarget",
      reasons: [
        { text: `${retarget.message.replace(/\.$/, "")}; ${next}`, basis: PLAN },
        { text: UNTIL_FINISHED, basis: PLAN },
      ],
      apply: { kind: "command", command: aborting ? `${command} --abort` : command },
    };
  }
  const { move } = plan;
  if (move === undefined) return undefined;
  const provision = `opscrew provision${flags}`;
  return {
    ...fields,
    id: "moving.env.move",
    reasons: [
      {
        text: `${move.service} is moving from ${serverWords(move.from)} to ${serverWords(move.to)}; \`${provision}\` continues the move`,
        basis: PLAN,
      },
      { text: UNTIL_FINISHED, basis: PLAN },
    ],
    apply: { kind: "command", command: provision },
  };
}

/** Per server read: its history with its days, or the one reading. */
function basisOf(readings: Readings): Record<string, Basis> {
  return Object.fromEntries(
    Object.entries(readings.servers).map(([name, { history }]): [string, Basis] => [
      name,
      history !== undefined && history.days > 0
        ? { kind: "history", days: history.days }
        : { kind: "one-reading", at: readings.at },
    ]),
  );
}

/** `proposals` by urgency, then category, each group in the rules' order. */
function ordered(proposals: Proposal[]): Proposal[] {
  return [...proposals].sort(
    (a, b) =>
      URGENCIES.indexOf(a.urgency) - URGENCIES.indexOf(b.urgency) ||
      CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category),
  );
}

/**
 * Reads the environment of `plan` (`readAdvice`), runs the rules and reports their proposals by
 * urgency, then category, with each server's basis, what was read and what couldn't be. A proposal
 * the plan already holds names `opscrew provision`. While a move is in progress, it reports the
 * move and only the proposals that change neither the servers nor the plan. Writes nothing.
 * @throws OpsCrewError `PHASE_PRECONDITION` when the environment isn't provisioned.
 */
export async function runAdvise(
  deps: PhaseDeps,
  plan: DeployPlan,
  options: ReadingsOptions = {},
): Promise<AdviceReport> {
  return (await adviseWithFlags(deps, plan, options)).report;
}

/**
 * Internal, for `applyProposal`: {@link runAdvise}'s report with the environment's `--app`/`--env`
 * flags, so they are read once.
 */
export async function adviseWithFlags(
  deps: PhaseDeps,
  plan: DeployPlan,
  options: ReadingsOptions,
): Promise<{ report: AdviceReport; flags: string }> {
  const flags = await commandFlags(deps.paths.root, deps.paths.environment, deps.paths.app);
  if (!hasDeployment(plan)) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `The ${deps.paths.environment} environment is not provisioned, so advise has nothing to read. Nothing was changed.`,
      { hint: `Run \`opscrew provision${flags}\` first, then \`opscrew advise${flags}\` again.` },
    );
  }
  // Previews on another environment's server: that environment's advice reads the server, the
  // previews' memory counted (FR-2230).
  const host = plan.environment?.previews?.server?.environment;
  if (host !== undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `The previews of ${deps.paths.environment} run on ${host}'s server, and ${host}'s advice reads that server, counting the previews' memory. Nothing was changed.`,
      {
        hint: `Run \`opscrew advise${await commandFlags(deps.paths.root, host, deps.paths.app)}\`.`,
      },
    );
  }
  const { readings, checked } = await readAdvice(deps, plan, flags, options);
  const proposals = RULES.flatMap((rule) => rule(readings)).map((proposal) =>
    proposal.apply.kind === "plan" && planHolds(plan, proposal.apply.change)
      ? alreadyInPlan(proposal, flags)
      : proposal,
  );
  const move = moveProposal(plan, flags);
  const kept =
    move === undefined
      ? proposals
      : [
          move,
          ...proposals.filter((p) => p.apply.kind !== "plan" && !SERVER_CATEGORIES.has(p.category)),
        ];
  const { provider } = plan.target;
  return {
    report: {
      proposals: ordered(kept),
      basis: basisOf(readings),
      checked,
      notRead: readings.notRead,
      suggestMonitoring: monitoringOf(plan) === undefined && isCloudProvider(provider),
    },
    flags,
  };
}
