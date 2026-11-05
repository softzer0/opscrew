/**
 * `opscrew advise` (feature 021, US1, US2, US4; plan.md "5."): reads the environment, runs the
 * rules and lists their proposals, the most urgent first. It changes nothing.
 */
import { OpsCrewError } from "@opscrew/core";
import { APP_SERVER, type DeployPlan } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { commandFlags } from "../environments/choice";
import { moveInProgress } from "../provision/guard";
import { hasDeployment, serverWords } from "../shared";
import { type ReadingsOptions, readAdvice } from "./readings";
import { componentRules } from "./rules/components";
import { costRules } from "./rules/cost";
import { reliabilityRules } from "./rules/reliability";
import { PLAN } from "./rules/shared";
import { sizeRules } from "./rules/size";
import { upkeepRules } from "./rules/upkeep";
import type {
  AdviceReport,
  Basis,
  PlanChange,
  Proposal,
  ProposalCategory,
  Readings,
  Urgency,
} from "./types";

/** What `runAdvise` reads through besides `deps`: the servers', GitHub's and Cloudflare's fakes in tests. */
export type RunAdviseOptions = ReadingsOptions;

const RULES = [sizeRules, costRules, reliabilityRules, upkeepRules, componentRules];

/** The urgencies, most urgent first. */
const URGENCIES: readonly Urgency[] = ["now", "soon", "when-convenient"];

/**
 * Within an urgency: a move in progress first, then a server's size, security, upkeep, savings,
 * and the rest (US1-3).
 */
const CATEGORIES: readonly ProposalCategory[] = [
  "moving",
  "size",
  "security",
  "upkeep",
  "cost",
  "reliability",
  "components",
];

/** The proposals that change the servers: none while a move is in progress. */
const SERVER_CATEGORIES: ReadonlySet<ProposalCategory> = new Set(["size", "cost", "components"]);

/** True when `plan` already holds `change` (a memory limit at least as high). */
function planHolds(plan: DeployPlan, change: PlanChange): boolean {
  const target =
    "server" in change
      ? change.server === APP_SERVER
        ? plan.target
        : plan.servers?.find((s) => s.name === change.server)?.target
      : undefined;
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
      const { container } = change;
      const limit =
        container.kind === "web"
          ? plan.app.memoryMb
          : container.kind === "worker"
            ? plan.processes.workers.find((w) => w.name === container.name)?.memoryMb
            : plan.services.find((s) => s.name === container.name)?.memoryMb;
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
        text: `The plan already holds this change; \`${provision}\` shows it and applies it once you approve its hash.`,
        basis: PLAN,
      },
    ],
    apply: { kind: "command", command: provision },
  };
}

const UNTIL_FINISHED =
  "Until it finishes, advise proposes nothing that changes the servers or the plan.";

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
      ? `Run \`${command} --abort\` to finish the abort; it continues where it stopped and puts the app back on the previous server.`
      : `Run \`${command}\` to continue it, \`${command} --finish\` after the switch, or \`${command} --abort\` before it.`;
    return {
      ...fields,
      id: "moving.env.retarget",
      reasons: [
        { text: `${retarget.message} ${next}`, basis: PLAN },
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
        text: `${move.service} is moving from ${serverWords(move.from)} to ${serverWords(move.to)}; \`${provision}\` continues the move.`,
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
  options: RunAdviseOptions = {},
): Promise<AdviceReport> {
  return (await adviseWithFlags(deps, plan, options)).report;
}

/**
 * Internal, for `applyProposal`: {@link runAdvise}'s report with the `--app`/`--env` flags the
 * readings found, so the flags are read once.
 */
export async function adviseWithFlags(
  deps: PhaseDeps,
  plan: DeployPlan,
  options: RunAdviseOptions,
): Promise<{ report: AdviceReport; flags: string }> {
  if (!hasDeployment(plan)) {
    const flags = await commandFlags(deps.paths.root, deps.paths.environment, deps.paths.app);
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `The ${deps.paths.environment} environment is not provisioned, so advise has nothing to read. Nothing was changed.`,
      { hint: `Run \`opscrew provision${flags}\` first, then \`opscrew advise${flags}\` again.` },
    );
  }
  const { readings, checked } = await readAdvice(deps, plan, options);
  const { flags } = readings;
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
  return {
    report: {
      proposals: ordered(kept),
      basis: basisOf(readings),
      checked,
      notRead: readings.notRead,
    },
    flags,
  };
}
