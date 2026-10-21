import type { ComputeCatalog } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { appDir, edgeProxy } from "@opscrew/iac-templates";
import {
  type CloudDeployTarget,
  type CostEstimate,
  type DeployPlan,
  readArtifact,
} from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { costFor } from "../design";
import { confirmDeletion, forgetHostKeys } from "../destroy/deletion";
import { providerProfile, vpsConnector } from "../providers";
import { describeChanges } from "../shared";
import { runPhase } from "../shared/phase-status";
import { moveProvider } from "../shared/vps-target";
import { previousTarget } from "./layouts";
import { clearPending } from "./pending";
import { applyInfraPlan, type InfraPlanInput, prepareInfraPlan } from "./plans";
import { liftMoveProtection, moveRemoval, previewMoveRemoval, removeMoveServer } from "./removal";
import { isAppHealthy } from "./server-ops";
import { endMoveServers, oldServer } from "./servers";
import {
  auditStep,
  layoutOf,
  type MoveSession,
  moveBase,
  moveOf,
  openSession,
  recordApply,
  remoteFor,
  saveMove,
  savePlan,
  useLayout,
  warnUnusedApproval,
  writeFinalFiles,
} from "./session";
import { assertRenameOnly, pendingStop, storeDeploySecrets } from "./steps";
import { assertDnsUpdatesOnly } from "./switch";
import {
  ABORT_COMMAND,
  FINISH_COMMAND,
  managedDns,
  providerWords,
  RUN_COMMAND,
  START_MOVE_HINT,
} from "./texts";
import type { AbortRetargetOptions, RetargetResult } from "./types";
import { recoverInterruptedWindow, restartOldApp, stepBefore } from "./window";

/**
 * The old server's monthly cost, priced again from its provider's catalogue (the injected one,
 * else the live one, else the dated price list) as `opscrew design` priced it; `undefined` when
 * the server type is not listed any more.
 */
async function previousCost(
  session: MoveSession,
  target: CloudDeployTarget,
): Promise<CostEstimate | undefined> {
  const { deps, services } = session;
  const injected = services.catalogs?.[target.provider];
  const catalogs: ComputeCatalog[] = injected
    ? [injected]
    : [
        vpsConnector(target.provider, deps, { now: () => deps.clock.now() }).catalog(),
        vpsConnector(target.provider, { ...deps, env: {} }).catalog(),
      ];
  for (const catalog of catalogs) {
    try {
      const offer = (await catalog.listOffers(target.location)).find(
        (o) => o.id === target.serverType && o.location === target.location,
      );
      if (offer === undefined) continue;
      return costFor(offer, await catalog.extras(target.location), {
        backups: target.backups,
        backupPercent: providerProfile(target.provider).backupPercent,
      });
    } catch {
      // Try the next catalogue.
    }
  }
  return undefined;
}

/**
 * Removes the new server when it exists: preview (deletes only under `module.server.`), typed app
 * name, for a new Hetzner server a protection-lifting plan first, then the removal plan bounded to
 * the confirmed preview. Returns a stop for a non-interactive run, else `undefined`.
 */
async function removeNewServer(
  session: MoveSession,
  options: AbortRetargetOptions,
  flags: readonly string[],
): Promise<RetargetResult | undefined> {
  const { deps } = session;
  const app = session.plan.app.name;
  const provider = moveProvider(session.plan.target);
  const removal = moveRemoval(session, "new", provider, flags);
  const { del, words } = removal;
  const preview = await previewMoveRemoval(removal);
  if (preview.changes.length === 0) {
    deps.reporter.info(`There is no new ${words.noun} to delete.`);
    return undefined;
  }
  deps.reporter.info(
    [
      `Aborting the move deletes these resources of the new ${words.noun} on ${words.name}:`,
      ...describeChanges(preview.changes),
    ].join("\n"),
  );
  await confirmDeletion(
    del,
    {
      name: app,
      provider,
      deleteProtection: providerProfile(provider).deleteProtection,
      resources: preview.changes,
      snapshot: false,
    },
    options.confirm,
  );
  // The typed name commits to the abort; without a confirmation hook, the first apply does.
  if (options.confirm !== undefined) await recordAbort(session);

  const beforeApply = () => recordAbort(session);
  const lift = await liftMoveProtection(removal, {
    serverInState: preview.serverInState,
    kept: "",
    beforeApply,
  });
  if ("stop" in lift) return lift.stop;
  return removeMoveServer(removal, {
    preview,
    notes: [
      `The app keeps running on the old server; the new ${words.noun} and what it holds are deleted.`,
    ],
    note: "",
    costDelta: {
      amount: -session.plan.cost.monthly.amount,
      currency: session.plan.cost.monthly.currency,
    },
    beforeApply,
  });
}

/** Progress of an abort: nothing done (no record yet), new server removed, secrets restored. */
const ABORT_PROGRESS = { started: 0, "new-removed": 1, "secrets-restored": 2 } as const;

function abortProgress(session: MoveSession): number {
  return ABORT_PROGRESS[moveOf(session).abort?.step ?? "started"];
}

/**
 * Records that the abort began (`retarget.abort`) at its first change or typed confirmation, so a
 * refusal before that leaves the move as it was (it can still be continued).
 */
async function recordAbort(session: MoveSession): Promise<void> {
  if (moveOf(session).abort !== undefined) return;
  await saveMove(session, { ...moveOf(session), abort: { step: "started" } });
  await auditStep(session, "abort started", `abort from step ${moveOf(session).step}`);
}

/** Records the abort's progress once it began (nothing to record when nothing changed yet). */
async function recordAbortStep(
  session: MoveSession,
  step: "new-removed" | "secrets-restored",
  detail: string,
): Promise<void> {
  if (moveOf(session).abort === undefined) return;
  await saveMove(session, { ...moveOf(session), abort: { step } });
  await auditStep(session, `abort ${step}`, detail);
}

/**
 * A DNS switch that failed half-way may have left records pointing at the new server: a plan in
 * the `both` layout (DNS follows the old server) points them back first, approved by its hash.
 * Returns a stop for a non-interactive run.
 */
async function pointDnsBack(
  session: MoveSession,
  flags: readonly string[],
): Promise<RetargetResult | undefined> {
  const { deps, plan } = session;
  const move = moveOf(session);
  if (!managedDns(plan) || stepBefore(move.step, "deployed")) return undefined;
  const old = providerWords(move.from.target.provider);
  deps.reporter.step(`Checking that the DNS records of ${plan.dns.domain} point to the old server`);
  const files = await useLayout(session, "both");
  const input: InfraPlanInput = {
    action: "abort-dns",
    files,
    costDelta: null,
    check: (saved) =>
      assertDnsUpdatesOnly(saved, {
        what: "DNS restore",
        hint: `Check the records in the Cloudflare dashboard (DNS → Records), then run \`${ABORT_COMMAND}\` again.`,
      }),
    notes: [
      `A switch that failed half-way left some DNS records of ${plan.dns.domain} pointing at the new server; this points them back to the old ${old.noun}, where the app runs.`,
    ],
  };
  const prepared = await prepareInfraPlan(session, input);
  if (prepared.kind === "pending") return pendingStop(session, prepared.planHash, flags);
  if (prepared.kind === "unchanged") return undefined;
  await recordAbort(session);
  const applied = await applyInfraPlan(session, input, prepared.planHash);
  await recordApply(session, { planHash: prepared.planHash, ...applied });
  deps.reporter.success(`The DNS records of ${plan.dns.domain} point to the old server again.`);
  return undefined;
}

async function abort(session: MoveSession, options: AbortRetargetOptions): Promise<RetargetResult> {
  const { deps } = session;
  const app = session.plan.app.name;
  const flags = ["--confirm", app];
  const move = moveOf(session);
  const from = previousTarget(move);
  const to = session.plan.target;
  const old = providerWords(from.provider);

  // 1. DNS back to the old server, then the new server (it can only exist once the rename was
  // recorded).
  if (abortProgress(session) < ABORT_PROGRESS["new-removed"]) {
    const dnsStop = await pointDnsBack(session, flags);
    if (dnsStop !== undefined) return dnsStop;
    if (move.step !== "started") {
      const stop = await removeNewServer(session, options, flags);
      if (stop !== undefined) return stop;
    }
    await forgetHostKeys(deps, [session.servers.next?.ipv4, session.servers.next?.ipv6]);
    await recordAbortStep(session, "new-removed", "the new server is gone");
  }

  // 2. The deploy secrets (they may point to the new server from the deploy step on).
  if (abortProgress(session) < ABORT_PROGRESS["secrets-restored"]) {
    if (!stepBefore(move.step, "created")) {
      await recordAbort(session);
      await storeDeploySecrets(session, oldServer(session).ipv4, "old");
    }
    await recordAbortStep(
      session,
      "secrets-restored",
      "the deploy secrets point to the old server",
    );
  }

  // 3. The moves-only plan that renames the old server back to `module.server`.
  deps.reporter.step(`Renaming the old ${old.noun} back in the infrastructure state`);
  const files = await useLayout(session, "abort-rename");
  const renameBack: InfraPlanInput = {
    action: "abort-rename",
    files,
    deployPlan: { ...session.plan, target: from },
    check: (saved) =>
      assertRenameOnly(saved, {
        fromPrefix: "module.server_previous.",
        toPrefix: "module.server.",
        what: "rename-back",
        hint: `The infrastructure no longer matches what OpsCrew applied. Check the servers in your provider consoles (\`opscrew drift\` works again once the move is cleared), then run \`${ABORT_COMMAND}\` again.`,
      }),
    notes: [
      `This only renames the old ${old.noun} from module.server_previous back to module.server in OpsCrew's infrastructure state. Nothing changes in your cloud.`,
    ],
  };
  const prepared = await prepareInfraPlan(session, renameBack);
  if (prepared.kind === "pending") return pendingStop(session, prepared.planHash, flags);
  if (prepared.kind === "ready") {
    await recordAbort(session);
    const applied = await applyInfraPlan(session, renameBack, prepared.planHash);
    await recordApply(session, { planHash: prepared.planHash, ...applied });
  } else {
    deps.reporter.info("The infrastructure state already uses the original names.");
  }

  // 4. The plan as before the move, and the original files.
  const cost = await previousCost(session, from);
  if (cost === undefined) {
    deps.reporter.warn(
      `OpsCrew could not price the old ${old.noun} again (${from.serverType} is no longer listed), so opscrew/plan.yaml keeps the new server's cost. Run \`opscrew design\` to refresh it.`,
    );
  }
  const { retarget: _aborted, ...rest } = session.plan;
  // The old server's deploy settings and image build, as recorded when the move started.
  const { build: _moved, ...unbuilt } = rest.app;
  const restored: DeployPlan = {
    ...rest,
    app: move.from.build === undefined ? unbuilt : { ...unbuilt, build: move.from.build },
    target: from,
    deploy: move.from.deploy,
    ...(cost !== undefined ? { cost } : {}),
  };
  await writeFinalFiles(session, restored, layoutOf(session, "both"), "infra");
  const oldAddress = oldServer(session);
  const oldHost = oldAddress.ipv4;
  await savePlan(session, restored);
  await clearPending(deps);
  await endMoveServers(deps, oldAddress);
  await deps.state.markPhase(
    "retarget",
    "skipped",
    `move to ${providerWords(moveProvider(to)).name} aborted`,
  );
  await auditStep(session, "aborted", `the deployment stays on ${from.provider} at ${oldHost}`);

  const healthy = await isAppHealthy(
    remoteFor(deps, session.services, session.deployKey.privateKeyFile, oldHost),
    restored.app.port,
    restored.app.healthPath,
    edgeProxy(restored),
  );
  if (healthy) {
    deps.reporter.success(`The move is aborted; ${app} runs on the old ${old.noun} (${oldHost}).`);
  } else {
    deps.reporter.warn(
      `The move is aborted, but the app on the old ${old.noun} (${oldHost}) does not answer its health check. Check it with \`ssh deploy@${oldHost}\` and \`cd ${appDir(restored)} && docker compose ps\`.`,
    );
  }
  return {
    step: "aborted",
    done: true,
    next: [
      `${app} stays on ${old.name}; pushes to ${restored.cicd.branch} deploy there again.`,
      `To move later, run \`${RUN_COMMAND} --to ${to.provider}\` again.`,
    ],
  };
}

/**
 * `opscrew retarget --abort` (only before the switch): starts the old app again when OpsCrew
 * stopped it; removes the new server when it exists (preview under `module.server.`, typed app
 * name, protection lift for a new Hetzner server, bounded removal plan); points the deploy secrets
 * back to the old server; renames the old server back with a moves-only plan; restores the plan's
 * target and cost, the original files, and forgets the new host key. Each step is recorded in
 * `retarget.abort.step`, so an interrupted abort continues.
 */
export async function abortRetarget(
  deps: PhaseDeps,
  options: AbortRetargetOptions = {},
): Promise<RetargetResult> {
  let plan = await readArtifact("plan", deps.paths.files.plan);
  const move = plan.retarget;
  if (move === undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      "No move to another provider is in progress, so there is nothing to abort.",
      { hint: START_MOVE_HINT },
    );
  }
  if (move.step === "switched") {
    const to = providerWords(moveProvider(plan.target));
    const from = move.from.target.provider;
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `Traffic already goes to the new ${to.noun} on ${to.name}, so the move can no longer be aborted. Nothing was changed.`,
      {
        hint: `To go back to ${providerWords(from).name}, finish this move with \`${FINISH_COMMAND}\` and then move again with \`${RUN_COMMAND} --to ${from}\`.`,
      },
    );
  }
  return runPhase(deps, "retarget", async () => {
    const services = options.services ?? {};
    // Users first: the old app runs again before anything else is checked (no provider token
    // needed; the infrastructure state names the servers when the local record is gone).
    if (move.oldAppStoppedAt !== undefined) {
      const base = await moveBase(deps, plan, {
        command: ABORT_COMMAND,
        services,
        ...(options.engine !== undefined ? { engine: options.engine } : {}),
      });
      if (stepBefore(move.step, "migrated")) await recoverInterruptedWindow(base);
      else await restartOldApp(base);
      plan = base.plan;
    }
    const session = await openSession(deps, plan, {
      command: ABORT_COMMAND,
      providers: [move.from.target.provider, moveProvider(plan.target)],
      services,
      ...(options.engine !== undefined ? { engine: options.engine } : {}),
      ...(options.approvePlanHash !== undefined
        ? { approvePlanHash: options.approvePlanHash }
        : {}),
    });
    const result = await abort(session, options);
    warnUnusedApproval(session);
    return result;
  });
}
