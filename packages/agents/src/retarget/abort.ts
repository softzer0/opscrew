import { rm } from "node:fs/promises";
import type { ComputeCatalog } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { appDir, edgeProxy } from "@opscrew/iac-templates";
import {
  type CloudDeployTarget,
  type CostEstimate,
  type DeployPlan,
  isCloudProvider,
  isServerlessTarget,
  readArtifact,
} from "@opscrew/plan-schema";
import { resumeCheck } from "../check/provision";
import type { PhaseDeps } from "../context";
import { costFor } from "../design";
import { forgetHostKeys } from "../destroy/deletion";
import type { DestroyPreview } from "../destroy/types";
import { providerProfile, vpsConnector } from "../providers";
import { previousBucketKeyFile } from "../provision/storage";
import { restoreOldConnection, type ServerAddress } from "../shared";
import { reasonOf } from "../shared/errors";
import { runPhase } from "../shared/phase-status";
import { movingBucketKeys, removeNewBucket, renameBucketBack, writeStorageFiles } from "./bucket";
import { oldSideTarget, previousTarget } from "./layouts";
import { endMoveKey, networkBeforeMove, undoMoveNetwork } from "./network";
import { clearPending } from "./pending";
import { applyInfraPlan, type InfraPlanInput, planBounded, prepareInfraPlan } from "./plans";
import { isAppHealthy } from "./server-ops";
import { endMoveServers } from "./servers";
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
import { cloudProviders, moveSide, placeWords, sideWords } from "./sides";
import { abortSiteMove } from "./site-end";
import { pendingStop, proposeWorkflow, storeDeploySecrets, workflowChanged } from "./steps";
import { dnsSwitchPlan } from "./switch";
import {
  ABORT_COMMAND,
  FINISH_COMMAND,
  managedDns,
  noMove,
  noSideCost,
  RUN_COMMAND,
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
 * `--abort`'s removal of the new side, through the side's `remove` after the typed app name: a
 * cloud server, only the app on the user's own server (a teardown host plan), only the app's
 * stacks and volumes in their Portainer. Never the user's server, Portainer or its environment
 * (SC-2304). The typed name commits to the abort, so `retarget.abort` is recorded as soon as it is
 * confirmed, before the side changes anything; without a `confirm` hook nothing is confirmed, so
 * nothing is deleted. Returns a script's stop.
 */
export async function removeNewSide(
  session: MoveSession,
  options: Pick<AbortRetargetOptions, "confirm">,
): Promise<RetargetResult | undefined> {
  const confirm = async (preview: DestroyPreview) => {
    const confirmed = (await options.confirm?.(preview)) === true;
    if (confirmed) await recordAbort(session);
    return confirmed;
  };
  return moveSide(session, "new").remove(session, confirm);
}

/** Progress of an abort: nothing done (no record yet), new side removed, secrets restored. */
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
 * A DNS switch that failed half-way may have left records pointing at the new side: a plan in
 * the `both` layout (DNS follows the old side) points them back first, approved by its hash.
 * Returns a stop for a non-interactive run.
 */
async function pointDnsBack(
  session: MoveSession,
  flags: readonly string[],
): Promise<RetargetResult | undefined> {
  const { deps, plan } = session;
  const move = moveOf(session);
  if (!managedDns(plan) || stepBefore(move.step, "deployed")) return undefined;
  const old = sideWords(move.from.target, "old");
  deps.reporter.step(`Checking that the DNS records of ${plan.dns.domain} point to ${old}`);
  const files = await useLayout(session, "both");
  const dns = dnsSwitchPlan(
    session,
    "old",
    "DNS restore",
    `Check the records in the Cloudflare dashboard (DNS → Records), then run \`${ABORT_COMMAND}\` again.`,
  );
  const input: InfraPlanInput = {
    action: "abort-dns",
    files,
    costDelta: null,
    check: dns.check,
    notes: [
      `A switch that failed half-way left some DNS records of ${plan.dns.domain} pointing at the new side; this points them back to ${old}, where the app runs.`,
      ...dns.notes,
    ],
  };
  const prepared = await prepareInfraPlan(session, input);
  if (prepared.kind === "pending") return pendingStop(session, prepared.planHash, flags);
  if (prepared.kind === "unchanged") return undefined;
  await recordAbort(session);
  const applied = await applyInfraPlan(session, input, prepared.planHash);
  await recordApply(session, { planHash: prepared.planHash, ...applied });
  deps.reporter.success(`The DNS records of ${plan.dns.domain} point to ${old} again.`);
  return undefined;
}

/**
 * The moves-only plan that renames the old cloud server back to `module.server` (only a cloud old
 * side has a module in the root). Returns a stop for a non-interactive run.
 */
async function renameBack(
  session: MoveSession,
  flags: readonly string[],
): Promise<RetargetResult | undefined> {
  const { deps } = session;
  const from = previousTarget(moveOf(session));
  const old = sideWords(from, "old");
  deps.reporter.step(`Renaming ${old} back in the infrastructure state`);
  // The layout renders the old server with its own WireGuard port (`retarget.from.member`).
  const files = await useLayout(session, "abort-rename");
  const network = networkBeforeMove(session.plan);
  const input: InfraPlanInput = {
    action: "abort-rename",
    files,
    deployPlan: { ...session.plan, target: from, ...(network !== undefined ? { network } : {}) },
    check: planBounded({
      lead: "The rename-back plan would do more than rename resources in the infrastructure state, so OpsCrew stopped. Nothing was changed.",
      move: (m) =>
        m.from.startsWith("module.server_previous.") && m.to.startsWith("module.server."),
      hint: `The infrastructure no longer matches what OpsCrew applied. Check the servers in your provider consoles (\`opscrew drift\` works again once the move is cleared), then run \`${ABORT_COMMAND}\` again.`,
    }),
    notes: [
      `This only renames ${old} from module.server_previous back to module.server in OpsCrew's infrastructure state. Nothing changes in your cloud.`,
    ],
  };
  const prepared = await prepareInfraPlan(session, input);
  if (prepared.kind === "pending") return pendingStop(session, prepared.planHash, flags);
  if (prepared.kind === "ready") {
    await recordAbort(session);
    const applied = await applyInfraPlan(session, input, prepared.planHash);
    await recordApply(session, { planHash: prepared.planHash, ...applied });
  } else {
    deps.reporter.info("The infrastructure state already uses the original names.");
  }
  return undefined;
}

/** The old side's monthly cost again: a cloud server's priced anew, nothing for the user's own. */
async function oldCost(session: MoveSession): Promise<CostEstimate | undefined> {
  const { deps, plan } = session;
  const target = moveOf(session).from.target;
  if (isCloudProvider(target.provider)) {
    const from = previousTarget(moveOf(session));
    const cost = await previousCost(session, from);
    if (cost === undefined) {
      deps.reporter.warn(
        `OpsCrew could not price ${sideWords(from, "old")} again (${from.serverType} is no longer listed), so opscrew/plan.yaml keeps the new side's cost. Run \`opscrew design\` to refresh it.`,
      );
    }
    return cost;
  }
  return noSideCost(
    target.provider === "own" ? "own" : "portainer",
    plan.cost.monthly.currency,
    deps.clock.now().toISOString(),
  );
}

/**
 * Once the plan is restored: whether the app answers on the old side, in words. The old side is
 * the plan's target again, reached as provision reaches it: a cloud server at `oldAddress`, the
 * user's own server or Portainer through its restored connection (so a rerun after an interrupted
 * abort checks the same way). A check that cannot run says the same as an app that does not
 * answer. Only a cloud server's address is said; never that of the user's own server or Portainer.
 */
export async function reportAborted(
  session: MoveSession,
  oldAddress: ServerAddress | undefined,
): Promise<void> {
  const { deps, plan } = session;
  const { target } = plan;
  const app = plan.app.name;
  const words = sideWords(target, "old");
  const cloud = isCloudProvider(target.provider);
  const healthy = cloud
    ? oldAddress !== undefined &&
      (await isAppHealthy(
        remoteFor(deps, session.services, session.deployKey.privateKeyFile, oldAddress.ipv4),
        plan.app.port,
        plan.app.healthPath,
        edgeProxy(plan),
        app,
      ).catch(() => false))
    : // `new` is the plan's target: with the move cleared, that is the old side.
      await moveSide(session, "new")
        .healthy(session)
        .catch(() => false);
  // Never the server's address (SC-2303): the user knows their server by its words.
  if (healthy) {
    deps.reporter.success(`The move is aborted; ${app} runs on ${words}.`);
    return;
  }
  const look =
    target.provider === "portainer"
      ? "Check its containers and their logs in your Portainer."
      : cloud
        ? `Check it over SSH as deploy, with the project's deploy key: \`cd ${appDir(plan)} && docker compose ps\`.`
        : `Check it over your SSH login to that server with \`cd ${appDir(plan)} && docker compose ps\`.`;
  deps.reporter.warn(
    `The move is aborted, but the app on ${words} does not answer its health check. ${look}`,
  );
}

async function abort(session: MoveSession, options: AbortRetargetOptions): Promise<RetargetResult> {
  const { deps } = session;
  const app = session.plan.app.name;
  const flags = ["--confirm", app];
  const move = moveOf(session);
  const from = move.from.target;
  const to = session.plan.target;
  // Both buckets' keys when the move takes the bucket along, before anything is changed.
  const keys = await movingBucketKeys(session);

  // 1. DNS back to the old side, then the new side (it can only exist once the rename was
  // recorded).
  if (abortProgress(session) < ABORT_PROGRESS["new-removed"]) {
    // The servers that stay link to the old app server as before, without the new one (it can
    // only have joined from step `created` on).
    if (!stepBefore(move.step, "created")) {
      const networkStop = await undoMoveNetwork(session, () => recordAbort(session));
      if (networkStop !== undefined) return networkStop;
    }
    const dnsStop = await pointDnsBack(session, flags);
    if (dnsStop !== undefined) return dnsStop;
    if (move.step !== "started") {
      const stop = await removeNewSide(session, options);
      if (stop !== undefined) return stop;
    }
    await forgetHostKeys(deps, [session.servers.next?.ipv4, session.servers.next?.ipv6]);
    await recordAbortStep(session, "new-removed", "the new side is removed");
  }

  // 1b. The new bucket of a move that takes the bucket along, after its own typed name (its plan
  // finds nothing to delete once it is gone).
  if (keys !== undefined) {
    const bucketStop = await removeNewBucket(session, keys, () => recordAbort(session));
    if (bucketStop !== undefined) return bucketStop;
  }

  // 2. The deploy secrets (they may point to the new side from the deploy step on).
  if (abortProgress(session) < ABORT_PROGRESS["secrets-restored"]) {
    if (!stepBefore(move.step, "created")) {
      await recordAbort(session);
      await storeDeploySecrets(session, "old");
    }
    await recordAbortStep(session, "secrets-restored", "the deploy secrets point to the old side");
  }

  // 3. A cloud old server's rename back to `module.server`.
  if (isCloudProvider(from.provider)) {
    const stop = await renameBack(session, flags);
    if (stop !== undefined) return stop;
  }
  // The bucket being left is the app's bucket again in its root's state.
  if (keys !== undefined) {
    const bucketStop = await renameBucketBack(session, keys);
    if (bucketStop !== undefined) return bucketStop;
  }

  // 4. The old side's connection back in its usual slot, the plan as before the move, and the
  // original files; the deploy workflow too when the move changed it (asked while the old side's
  // login is still set aside).
  const workflowMoved = await workflowChanged(session);
  await restoreOldConnection(deps.paths, { from: from.provider, to: to.provider });
  const cost = await oldCost(session);
  const { retarget: _aborted, ...rest } = session.plan;
  // The old side's deploy settings and image build, as recorded when the move started.
  const { build: _moved, ...unbuilt } = rest.app;
  const restored: DeployPlan = {
    ...rest,
    app: move.from.build === undefined ? unbuilt : { ...unbuilt, build: move.from.build },
    target: oldSideTarget(move),
    deploy: move.from.deploy,
    ...(cost !== undefined ? { cost } : {}),
    ...(move.from.objectStorage !== undefined
      ? { storage: { ...rest.storage, objectStorage: move.from.objectStorage } }
      : {}),
    // The old app server's member of the private network is `app` again.
    ...(rest.network !== undefined ? { network: networkBeforeMove(session.plan) } : {}),
  };
  await writeFinalFiles(session, restored, layoutOf(session, "both"), "infra");
  if (keys !== undefined) await writeStorageFiles(session, restored);
  const oldAddress = session.servers.from;
  await endMoveKey(deps, move, "aborted");
  await savePlan(session, restored);
  await clearPending(deps);
  // A run killed while the engine ran may have left the key of the bucket being left there.
  await rm(previousBucketKeyFile(deps.paths), { force: true });
  await endMoveServers(deps, oldAddress);
  const place = placeWords(from);
  await deps.state.markPhase("retarget", "skipped", `move to ${placeWords(to)} aborted`);
  await auditStep(session, "aborted", `the deployment stays on ${from.provider}`);
  // The scheduled check watches the app again, when the maintenance window paused it.
  await resumeCheck(deps, session.github, restored, {
    command: "opscrew provision",
    phase: "retarget",
  });

  await reportAborted(session, oldAddress);
  // A deploy workflow the move merged for the new side goes back to the old side's.
  const workflow = workflowMoved ? await restoreWorkflow(session, restored) : undefined;
  return {
    step: "aborted",
    done: true,
    next: [
      ...(workflow === undefined
        ? [`${app} stays on ${place}; pushes to ${restored.cicd.branch} deploy there again.`]
        : [workflow]),
      `To move later, run \`${RUN_COMMAND} --to ${to.provider}\` again.`,
    ],
  };
}

/**
 * The old side's deploy workflow back on GitHub, after a move whose new side has another one (its
 * pull request may have put that one there): a pull request of its own. Returns what remains to do
 * (merge it, or commit it by hand when the pull request could not be opened), or `undefined` when
 * GitHub has the old one.
 */
async function restoreWorkflow(
  session: MoveSession,
  restored: DeployPlan,
): Promise<string | undefined> {
  const { deps } = session;
  const path = restored.cicd.workflowPath;
  const byHand = `Commit ${path} as it is in this folder and merge it into ${restored.cicd.branch}, so pushes deploy to ${placeWords(restored.target)} again.`;
  try {
    const proposal = await proposeWorkflow(session, restored);
    if (proposal.kind === "merged") return undefined;
    return proposal.kind === "proposed"
      ? `${proposal.merge}: it puts the deploy workflow for ${placeWords(restored.target)} back, so pushes deploy there again.`
      : `${proposal.why.join(" ")} ${byHand}`;
  } catch (error) {
    deps.reporter.warn(
      deps.redactor.redact(
        `The move is aborted, but OpsCrew could not propose the deploy workflow back: ${reasonOf(error)}.`,
      ),
    );
    return byHand;
  }
}

/**
 * `opscrew retarget --abort` (only before the switch): starts the old app again when OpsCrew
 * stopped it; removes the new side when it exists, after the typed app name (a cloud server; only
 * the app on the user's own server or in their Portainer, never the server or the environment);
 * points the deploy secrets back to the old side; renames an old cloud server back with a
 * moves-only plan; puts the old side's connection back; restores the plan's target and cost, the
 * original files, and forgets the new host key. Each step is recorded in `retarget.abort.step`,
 * so an interrupted abort continues.
 */
export async function abortRetarget(
  deps: PhaseDeps,
  options: AbortRetargetOptions = {},
): Promise<RetargetResult> {
  let plan = await readArtifact("plan", deps.paths.files.plan);
  const move = plan.retarget;
  if (move === undefined) throw noMove("abort");
  // A site's move between site hosts is undone in steps of its own (plan.md "6.").
  if (isServerlessTarget(plan.target)) return abortSiteMove(deps, plan, options);
  if (move.step === "switched") {
    const from = move.from.target;
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `Traffic already goes to ${sideWords(plan.target, "new")}, so the move can no longer be aborted. Nothing was changed.`,
      {
        hint: `To go back to ${placeWords(from)}, finish this move with \`${FINISH_COMMAND}\` and then move again with \`${RUN_COMMAND} --to ${from.provider}\`.`,
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
      providers: cloudProviders({ plan }),
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
