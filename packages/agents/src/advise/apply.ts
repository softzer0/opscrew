/**
 * `opscrew advise --apply <id>` (feature 021, US2; plan.md "5."): on a fresh reading, a proposal
 * the plan holds becomes that one field of the plan, which `opscrew provision` then applies after
 * its hash is approved; the others give their command or what to do by hand. Nothing else changes.
 */
import { OpsCrewError } from "@opscrew/core";
import { APP_SERVER, type DeployPlan, isCloudProvider } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { planFile } from "../runners";
import { writePlanIfChanged } from "../shared";
import { targetOf } from "../shared/servers";
import { priceWords } from "./render";
import { adviseWithFlags, memoryLimitOf, PROVISION_APPLIES, type RunAdviseOptions } from "./run";
import type { PlanChange, Proposal } from "./types";

/**
 * What applying a proposal did: the plan written, with its summary; or the command that applies
 * it; or, with nothing to type, what to do by hand.
 */
export type AppliedProposal =
  | { plan: DeployPlan; summary: string }
  | { command: string }
  | { manual: string };

/**
 * `edit` on the target of `server` (the app's, or an extra server's), a server OpsCrew created:
 * the rules propose a type or backups for no other.
 */
function onServer(
  plan: DeployPlan,
  server: string,
  edit: { serverType: string } | { backups: true },
): DeployPlan {
  const cloud = <T extends { provider: string }>(target: T): T =>
    isCloudProvider(target.provider) ? { ...target, ...edit } : target;
  if (server === APP_SERVER) return { ...plan, target: cloud(plan.target) };
  return {
    ...plan,
    servers: (plan.servers ?? []).map((s) =>
      s.name === server ? { ...s, target: cloud(s.target) } : s,
    ),
  };
}

/** `plan` with `change`, and that field before and after in words. */
function withChange(
  plan: DeployPlan,
  change: PlanChange,
): { plan: DeployPlan; field: string; before: string; after: string } {
  const field = (app: string, extra: string, server: string) =>
    server === APP_SERVER ? app : `${extra} of server ${server}`;
  switch (change.kind) {
    case "server-type": {
      const { server, serverType } = change;
      const target = targetOf(plan, server);
      return {
        plan: onServer(plan, server, { serverType }),
        field: field("target.serverType", "servers[].target.serverType", server),
        before: target !== undefined && "serverType" in target ? target.serverType : "none",
        after: serverType,
      };
    }
    case "backups":
      return {
        plan: onServer(plan, change.server, { backups: true }),
        field: field("target.backups", "servers[].target.backups", change.server),
        before: "off",
        after: "on",
      };
    case "check":
      return {
        plan: {
          ...plan,
          observability: {
            ...plan.observability,
            check: { ...plan.observability?.check, enabled: true },
          },
        },
        field: "observability.check.enabled",
        before: "off",
        after: "on",
      };
    case "memory-limit": {
      const { container, memoryMb } = change;
      const mb = (value: number | undefined) => `${value ?? "no"} MB`;
      const words = { before: mb(memoryLimitOf(plan, container)), after: mb(memoryMb) };
      if (container.kind === "web") {
        return {
          plan: { ...plan, app: { ...plan.app, memoryMb } },
          field: "app.memoryMb",
          ...words,
        };
      }
      if (container.kind === "worker") {
        const { workers } = plan.processes;
        return {
          plan: {
            ...plan,
            processes: {
              ...plan.processes,
              workers: workers.map((w) => (w.name === container.name ? { ...w, memoryMb } : w)),
            },
          },
          field: `processes.workers[].memoryMb of worker ${container.name}`,
          ...words,
        };
      }
      return {
        plan: {
          ...plan,
          services: plan.services.map((s) => (s.name === container.name ? { ...s, memoryMb } : s)),
        },
        field: `services[].memoryMb of ${container.name}`,
        ...words,
      };
    }
  }
}

/**
 * Applies the proposal `id` on a fresh reading (`runAdvise`): a plan proposal writes only its
 * field of the plan (through the plan's writer, as `opscrew addon enable` does) and returns the new
 * plan with a summary of the change, the new monthly price and the provision to run; a command
 * proposal returns its command, a manual one what to do. Nothing else is changed.
 * @throws OpsCrewError `INVALID_INPUT`, before any change, when `id` isn't among the proposals of
 * the fresh reading (unknown, or no longer standing), naming the current ones; and `runAdvise`'s.
 */
export async function applyProposal(
  deps: PhaseDeps,
  plan: DeployPlan,
  id: string,
  options: RunAdviseOptions = {},
): Promise<AppliedProposal> {
  const { report, flags } = await adviseWithFlags(deps, plan, options);
  const proposal: Proposal | undefined = report.proposals.find((p) => p.id === id);
  if (proposal === undefined) {
    const current = report.proposals.map((p) => p.id);
    throw new OpsCrewError(
      "INVALID_INPUT",
      `"${id}" is not among advise's proposals on a fresh reading (the figures may have changed since the list was shown). ${
        current.length === 0 ? "There are none now." : `The current ones are ${current.join(", ")}.`
      } Nothing was changed.`,
      {
        hint: `Run \`opscrew advise${flags}\` to see them, then \`opscrew advise --apply <id>${flags}\` with one of their ids.`,
      },
    );
  }
  const { apply } = proposal;
  if (apply.kind === "command") return { command: apply.command };
  if (apply.kind === "manual") return { manual: apply.text };
  const changed = withChange(plan, apply.change);
  await writePlanIfChanged(deps, changed.plan);
  const whose = proposal.server === undefined ? "The" : `Server ${proposal.server}'s`;
  const summary = [
    `Changed ${planFile(plan)}: ${changed.field} from ${changed.before} to ${changed.after}.`,
    proposal.price === undefined
      ? "The monthly price doesn't change."
      : `${whose} monthly price: ${priceWords(proposal.price)}.`,
    `Run \`opscrew provision${flags}\`: it ${PROVISION_APPLIES}.`,
  ].join("\n");
  return { plan: changed.plan, summary };
}
