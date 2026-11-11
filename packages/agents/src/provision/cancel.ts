/**
 * Provision's removal of a server at a provider that cancels it at the end of its term instead of
 * deleting it (feature 026, US4, FR-2609, plan 4.1): an extra server design dropped, or any other
 * server the infrastructure plan deletes or replaces there. The plan's approval says so, each such
 * server is shut down after the approval and before the apply, and its end date is read back after
 * it, in destroy's words and through destroy's calls (`../destroy/cancel`, imported directly: the
 * `../destroy` barrel would make an import cycle). Servers at Hetzner and DigitalOcean are deleted
 * at once and never reach this module.
 */
import type { PhaseName } from "@opscrew/contracts";
import { APP_SERVER, type DeployPlan, isCloudProvider } from "@opscrew/plan-schema";
import { CLOUD_PROVIDERS } from "@opscrew/providers";
import type { PhaseDeps } from "../context";
import {
  byProvider,
  type CancelledServer,
  cancelDates,
  cancelFailedHint,
  cancelledText,
  cancelNotes,
  shutDown,
  shutdownLines,
} from "../destroy/cancel";
import { serverIdsInPlan } from "../destroy/checks";
import type { DeletionScope, ServerApiInput } from "../destroy/deletion";
import { cancelTerm } from "../destroy/texts";
import { cloudServerName } from "../shared/servers";
import { extraServerOf } from "./servers";
import type { ProvisionServices, SavedPlan } from "./types";

/**
 * A cancelled server with the name it has in the plan (`app` or an extra server's), and whether the
 * plan replaces the server and deletes nothing else of it (`replacedAlone`).
 */
interface PlannedCancel extends CancelledServer {
  server: string;
  replacedAlone: boolean;
}

/**
 * The servers `saved` deletes or replaces at a provider that cancels them at the end of their term,
 * in plan order, each with its module and its ids as the plan's prior state records them.
 */
export function cancelledByPlan(
  plan: Pick<DeployPlan, "app">,
  saved: Pick<SavedPlan, "changes" | "planJson">,
): PlannedCancel[] {
  return saved.changes.flatMap((change): PlannedCancel[] => {
    if (change.action !== "delete" && change.action !== "replace") return [];
    const provider = CLOUD_PROVIDERS.find(
      (p) => p.terraform.serverResourceType === change.type,
    )?.id;
    if (
      provider === undefined ||
      !isCloudProvider(provider) ||
      cancelTerm(provider) === undefined
    ) {
      return [];
    }
    const module = change.address.slice(0, change.address.indexOf(`${change.type}.`));
    const extra = extraServerOf(change.address);
    const othersDeleted = saved.changes.some(
      (other) =>
        other.address !== change.address &&
        other.address.startsWith(module) &&
        (other.action === "delete" || other.action === "replace"),
    );
    return [
      {
        server: extra ?? APP_SERVER,
        provider,
        module,
        ids: serverIdsInPlan(saved.planJson, provider, module),
        replacedAlone: change.action === "replace" && !othersDeleted,
        ...(extra !== undefined ? { name: cloudServerName(plan, extra) } : {}),
      },
    ];
  });
}

/**
 * The approval's lines for the servers `saved` cancels: the shutdowns that come before its apply,
 * what each cancel means (billed to the end of the term, what else of the server goes at once, the
 * disk and the provider's snapshots gone then), and that nothing is saved on them until their terms
 * end. A server replaced with nothing else of it deleted keeps its other resources, and the plan
 * creates its replacement. None for any other plan.
 */
export function cancelApprovalNotes(
  plan: Pick<DeployPlan, "app">,
  saved: Pick<SavedPlan, "changes" | "planJson">,
): string[] {
  const servers = cancelledByPlan(plan, saved);
  if (servers.length === 0) return [];
  const app = plan.app.name;
  const notes = servers.flatMap((server) => {
    if (!server.replacedAlone) {
      return cancelNotes([server], app, "its other resources (such as its firewall)");
    }
    // cancelNotes' lines: billed to the end of the term, shut down now, gone when the term ends.
    const [billed, , gone] = cancelNotes([server], app);
    return [
      billed,
      "OpsCrew shuts it down now; nothing else of it is deleted, and this plan creates its replacement.",
      gone,
    ].filter((line) => line !== undefined);
  });
  return [
    ...shutdownLines(servers, app),
    ...notes,
    `Nothing is saved on ${cancelledText(servers, app)} until ${servers.length === 1 ? "its term ends" : "their terms end"}.`,
  ];
}

/** What the shutdowns and the read-back need: who runs them, and how each provider is reached. */
export interface ProvisionCancel {
  deps: PhaseDeps;
  plan: DeployPlan;
  services: Pick<ProvisionServices, "provider" | "providers" | "sleep" | "now">;
  command: string;
  phase: PhaseName;
}

/**
 * For each provider of the servers `saved` cancels: destroy's scope (audited under `phase`) and
 * its server API when one was given with its credential check (else destroy's `serverApi` builds
 * its connector, with the waits, or stops when its credentials are missing).
 */
function providerCalls(
  ctx: ProvisionCancel,
  saved: Pick<SavedPlan, "changes" | "planJson">,
): { scope: DeletionScope; servers: PlannedCancel[]; input: ServerApiInput }[] {
  const { deps, plan, services } = ctx;
  return byProvider(cancelledByPlan(plan, saved)).map(([provider, servers]) => {
    const api =
      provider === plan.target.provider
        ? services.provider?.servers
        : services.providers?.[provider]?.servers;
    return {
      scope: {
        deps,
        provider,
        app: plan.app.name,
        command: ctx.command,
        what: "removal",
        phase: ctx.phase,
      },
      servers,
      input: {
        ...(api !== undefined ? { servers: api } : {}),
        ...(services.sleep !== undefined ? { sleep: services.sleep } : {}),
        ...(services.now !== undefined ? { now: services.now } : {}),
      },
    };
  });
}

/**
 * After the approval and before the engine's apply: shuts each server `saved` cancels down through
 * its provider's API, audited; a failure stops with nothing applied.
 */
export async function shutDownCancelled(
  ctx: ProvisionCancel,
  saved: Pick<SavedPlan, "changes" | "planJson">,
): Promise<void> {
  for (const { scope, servers, input } of providerCalls(ctx, saved)) {
    await shutDown(scope, servers, input);
  }
}

/**
 * After the apply: when the contract of each server `saved` cancelled ends, as its provider
 * answers it (audited), shown and returned; none for a plan that cancels nothing.
 */
export async function showCancelDates(
  ctx: ProvisionCancel,
  saved: Pick<SavedPlan, "changes" | "planJson">,
): Promise<string[]> {
  const lines: string[] = [];
  for (const { scope, servers, input } of providerCalls(ctx, saved)) {
    lines.push(...(await cancelDates(scope, servers, input)));
  }
  for (const line of lines) ctx.deps.reporter.info(line);
  return lines;
}

/**
 * What a failed apply of a plan that cancels servers adds to provision's own hint: the provider
 * may have refused the cancel (its reason is in the log), where to cancel by hand, and that the
 * servers are shut down already. None for any other plan.
 */
export function cancelFailedNote(
  plan: Pick<DeployPlan, "app">,
  saved: Pick<SavedPlan, "changes" | "planJson">,
): string | undefined {
  const servers = cancelledByPlan(plan, saved);
  return servers.length === 0 ? undefined : cancelFailedHint(servers, plan.app.name);
}
