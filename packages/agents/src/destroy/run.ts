import { join } from "node:path";
import type { ApprovalRecord, ResourceChange } from "@opscrew/contracts";
import { exists, lowerFirst, OpsCrewError, plural, tfstateFile } from "@opscrew/core";
import { cloudTarget, runnerLabel } from "@opscrew/iac-templates";
import { type DeployPlan, readArtifact } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { destroyLocalhost } from "../localhost/destroy";
import { planProvider, providerProfile } from "../providers";
import { checkProvider, providerBucket } from "../provision";
import {
  deleteRegistrations,
  planWhere,
  removeMachineRunners,
  runnerRepository,
  serverRunnerName,
} from "../runners";
import { describeChanges, hasDeployment, planStop, refusalReason, serverAddress } from "../shared";
import {
  deletedTunnels,
  requireTunnelClosed,
  tunnelBusyError,
  tunnelChange,
  tunnelSafeEngine,
  waitForTunnelToClose,
} from "../shared/tunnel-connections";
import {
  dataWarning,
  deletesServer,
  deletionPlanProblems,
  planHeading,
  serverData,
} from "./checks";
import {
  COMMAND,
  CONTINUES_WITH_LEFT,
  checkCloudflare,
  containerImagesLeft,
  type DeploymentFiles,
  DRIFT_THEN_DESTROY,
  deploymentFiles,
  deploySecretsLeft,
  type GitHubTarget,
  nothingDeployed,
  pauseCheckForTeardown,
  recordTeardown,
  removeDeploySecrets,
  requireInfraCode,
  resolveGitHub,
  setupEngine,
  teardownScope,
  teardownStateNotHere,
  typeNameHint,
} from "./common";
import {
  applyApprovedPlan,
  assertDeletionPlan,
  confirmDeletion,
  type DeletionSession,
  deletionSession,
  discardPlan,
  forgetHostKeys,
  liftProtection,
  previewDeletion,
  remainingAfterDeletion,
  removeSnapshotRecord,
  savePlan,
  snapshotKeptNote,
  snapshotWanted,
  takeSnapshotBeforeDelete,
} from "./deletion";
import { destroyOwnServer } from "./own";
import { destroyPortainer } from "./portainer";
import { destroyCloudflareWorkers, destroyGithubPages } from "./serverless";
import {
  applySharedRemoval,
  planSharedRemoval,
  removalDetails,
  zeroTrustLeft,
} from "./shared-rules";
import {
  type BucketDeleted,
  bucketDeletionWarning,
  bucketKept,
  bucketStays,
  bucketStillListed,
  deleteBucket,
  discardBucketDeletion,
  failIfBucketListed,
  planBucketDeletion,
} from "./storage";
import { type DestroyTexts, destroyConfirmPrompt, destroyTexts } from "./texts";
import type { DestroyOptions, DestroyResult } from "./types";

/**
 * Input variable that lifts the server's delete and rebuild protection (Hetzner root module, T303).
 * Providers without delete protection (DigitalOcean) have no such variable and get no `-var`.
 */
const PROTECTION_VARIABLE = "delete_protection";

/** Everything the plan and apply steps share. */
interface DestroyContext {
  /** Engine, root module and wording shared with the move's deletion steps. */
  session: DeletionSession;
  plan: DeployPlan;
  texts: DestroyTexts;
  /** `-var`s of every plan: delete protection off where the provider has it. */
  vars?: Readonly<Record<string, string>>;
  /** Delay between polls of the tunnel's connections (tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Deletes the server's runner registration at GitHub, right before the server is deleted. */
  unregisterRunner?: () => Promise<void>;
}

/**
 * 0. A move to another provider is in progress (`plan.retarget`): two servers may exist and the
 * state is transitional, so destroy refuses before any check or change.
 */
function moveInProgress(plan: DeployPlan): OpsCrewError {
  const to = providerProfile(planProvider(plan)).displayName;
  return new OpsCrewError(
    "PHASE_PRECONDITION",
    `A move to ${to} is in progress, so OpsCrew will not delete this deployment.`,
    {
      hint: "Run `opscrew retarget` to continue the move, `opscrew retarget --finish` to complete it once traffic reaches the new server, or `opscrew retarget --abort` to go back before the DNS switch. Then run `opscrew destroy` again if you still want to delete the deployment.",
    },
  );
}

/** 1. A deployment and its state must be on this computer, with its infrastructure code. */
async function requirePreconditions(deps: PhaseDeps, plan: DeployPlan) {
  if (!(await exists(tfstateFile(deps.paths)))) {
    if (!hasDeployment(plan)) throw nothingDeployed(plan);
    throw await teardownStateNotHere(deps.paths.root, plan);
  }
  await requireInfraCode(deps, plan, "the teardown");
}

/**
 * 7. The destroy plan, approved with `allowDestroy` and the typed server name, then applied.
 * Returns the deleted resources and the approval (none when nothing was left to delete).
 */
async function destroyInfrastructure(
  ctx: DestroyContext,
  snapshotId: string | undefined,
  protectionOff: boolean,
  confirmed: { addresses: ReadonlySet<string>; serverIds: readonly string[] },
): Promise<{
  destroyed: ResourceChange[];
  approval?: ApprovalRecord;
  /** The approval of the tunnel-only plan, when Cloudflare refused the tunnel at first. */
  tunnelApproval?: ApprovalRecord;
}> {
  const { session, plan, texts } = ctx;
  const { deps } = session;
  const name = plan.app.name;
  // Once this run lifted delete protection (Hetzner), every later stop says so and how to undo it.
  const lifted = protectionOff
    ? ` Delete protection on ${name} is already lifted, so the ${texts.noun} is not protected against deletion now.`
    : "";
  const hintAfterLift = (hint: string) =>
    protectionOff
      ? `Run \`opscrew provision\` to turn delete protection back on, or ${lowerFirst(hint)}`
      : hint;
  deps.reporter.step("Planning the teardown");
  const summary = await savePlan(session, "destroy", {
    ...(ctx.vars ? { vars: ctx.vars } : {}),
    destroy: true,
  });
  try {
    if (summary.changes.length === 0) {
      deps.reporter.info("Nothing is left to delete.");
      return { destroyed: [] };
    }
    // The whole root module is deleted (no prefix), but only what the user confirmed, and only the
    // server the snapshot was taken of (by the id the confirmed preview named).
    assertDeletionPlan(
      session,
      summary,
      { confirmed: confirmed.addresses, serverIds: confirmed.serverIds },
      (problem) =>
        problem === "unbounded"
          ? {
              note: `${protectionOff ? "Nothing was deleted." : "Nothing was changed."}${lifted}`,
              hint: hintAfterLift(DRIFT_THEN_DESTROY),
            }
          : problem === "unconfirmed"
            ? {
                note: `Nothing was deleted.${lifted}`,
                hint: hintAfterLift(
                  "Run `opscrew destroy` again to see the current list and confirm it.",
                ),
              }
            : {
                note: `Nothing was deleted.${lifted}${snapshotKeptNote(texts, snapshotId)}`,
                hint: hintAfterLift(
                  "Run `opscrew drift` to see what changed, then run `opscrew destroy` again to see the current list and confirm it.",
                ),
              },
    );
    const serverDeleted = deletesServer(summary.changes, session.provider);
    const warning = dataWarning(plan, serverDeleted);
    const unrecoverable =
      cloudTarget(plan.target).backups && texts.keptBackups
        ? `What is stored on the ${texts.noun} can only be recovered from the automatic backups ${texts.company} keeps for a while after this.`
        : `What is stored on the ${texts.noun} cannot be recovered after this.`;
    const snapshotLine =
      snapshotId !== undefined
        ? `Snapshot: ${texts.snapshotRef(snapshotId)} keeps a copy of the ${texts.noun} (${texts.snapshotBilled}; OpsCrew never deletes it).`
        : serverDeleted
          ? `Snapshot: none. ${unrecoverable}`
          : "Snapshot: none.";
    const providers =
      plan.dns.provider === "cloudflare"
        ? `${texts.displayName} and Cloudflare`
        : texts.displayName;
    const count = summary.changes.length;
    const approval = await deps.approvals.request({
      kind: "iac-apply",
      title: `Delete ${name} on ${providers} (${plural(count, "resource")} to delete)`,
      details: [
        planHeading(summary, "destroy plan"),
        ...describeChanges(summary.changes),
        ...(warning ? [warning] : []),
        snapshotLine,
        ...(tunnelChange(summary.changes, "delete") && !serverDeleted
          ? [
              "OpsCrew applies this plan once Cloudflare reports no active connections for the tunnel (Cloudflare deletes a tunnel only after its connector has stopped).",
            ]
          : []),
        `Plan hash: ${summary.planHash}`,
      ].join("\n"),
      planHash: summary.planHash,
      allowDestroy: true,
      confirmPhrase: name,
      costDelta: { amount: -plan.cost.monthly.amount, currency: plan.cost.monthly.currency },
    });
    if (!approval.approved) {
      throw new OpsCrewError(
        "APPROVAL_REFUSED",
        `The teardown was not approved${refusalReason(approval)}. Nothing was deleted.${lifted}${snapshotKeptNote(texts, snapshotId)}`,
        {
          hint: protectionOff
            ? `Run \`opscrew provision\` to turn delete protection back on, or run \`opscrew destroy\` again and type ${name} to delete the deployment.`
            : typeNameHint(name),
        },
      );
    }
    await deps.approvals.assertApprovedPlan(summary.planHash, { allowDestroy: true });
    // The server's runner goes with the server, so GitHub forgets it first.
    if (serverDeleted) await ctx.unregisterRunner?.();
    // Portainer's subdomain: its tunnel connector runs on the server. Deleted with the server, its
    // connections may outlast it and Cloudflare refuses the tunnel (1022); then this run waits
    // until Cloudflare reports no active connections and deletes the tunnel with a plan of its own
    // (see deleteTunnelLeft). A rerun that deletes only the tunnel waits first, too.
    const tunnel = tunnelChange(summary.changes, "delete");
    const tunnelLeft = `The ${texts.noun} is deleted; the Cloudflare Tunnel is still there.`;
    if (tunnel && !serverDeleted) {
      await requireTunnelClosed(deps, summary, {
        command: COMMAND,
        already: tunnelLeft,
        ...(ctx.sleep !== undefined ? { options: { sleep: ctx.sleep } } : {}),
      });
    }
    deps.reporter.step("Deleting the infrastructure (this usually takes a minute or two)");
    const engine = tunnelSafeEngine(session.engine);
    try {
      await applyApprovedPlan(tunnel ? { ...session, engine } : session, summary, {
        allowDestroy: true,
        what: "deleting the infrastructure",
        hint: CONTINUES_WITH_LEFT,
      });
    } catch (error) {
      if (!engine.refusedBusyTunnel || !(error instanceof OpsCrewError)) throw error;
      if (engine.onlyBusyTunnel && serverDeleted) {
        // The connector went with the server, but its connections outlasted it: wait, then show
        // and apply the plan for the tunnel that is left, in this same run.
        const tunnelApproval = await deleteTunnelLeft(ctx, summary, {
          refused: error,
          tunnelLeft,
          confirmed: confirmed.addresses,
          snapshotId,
        });
        deps.reporter.success(`Deleted ${plural(count, "resource")}.`);
        return {
          destroyed: summary.changes,
          approval,
          ...(tunnelApproval !== undefined ? { tunnelApproval } : {}),
        };
      }
      if (engine.onlyBusyTunnel) {
        throw tunnelBusyError({
          command: COMMAND,
          reason: "refused",
          already: tunnelLeft,
          cause: error,
        });
      }
      // Something else failed as well: its words stay, and the tunnel's refusal is explained.
      throw new OpsCrewError(error.code, error.message, {
        hint: `${error.hint ?? ""} Cloudflare also refused to delete the app's Cloudflare Tunnel because it still had active connections; that resolves itself within a few minutes.`.trim(),
        cause: error,
      });
    }
    deps.reporter.success(`Deleted ${plural(count, "resource")}.`);
    return { destroyed: summary.changes, approval };
  } finally {
    await discardPlan(summary);
  }
}

/**
 * 7b. The destroy plan deleted the server, but Cloudflare refused its tunnel (1022) because the
 * connector's connections outlasted the server. Waits (read-only, bounded) until Cloudflare
 * reports no active connections, then plans the deletion of what is left, shows it with its own
 * `iac-apply` approval (`allowDestroy` and the typed app name, as for the teardown; only deletes
 * of what the user confirmed) and applies it. Stops with the plain 1022 message (run it again in a
 * few minutes) when the connections do not close in time, and with a plain next step when that
 * plan is refused (then nothing more is deleted). Returns the approval (none when nothing was
 * left).
 */
async function deleteTunnelLeft(
  ctx: DestroyContext,
  first: { planJson: unknown },
  input: {
    refused: OpsCrewError;
    tunnelLeft: string;
    confirmed: ReadonlySet<string>;
    snapshotId: string | undefined;
  },
): Promise<ApprovalRecord | undefined> {
  const { session, plan, texts } = ctx;
  const { deps } = session;
  const name = plan.app.name;
  const busy = () =>
    tunnelBusyError({
      command: COMMAND,
      reason: "refused",
      already: input.tunnelLeft,
      cause: input.refused,
    });
  const tunnels = deletedTunnels(first.planJson);
  if (tunnels.length === 0) throw busy();
  deps.reporter.info(
    `The ${texts.noun} is deleted, but Cloudflare refused to delete the app's Cloudflare Tunnel while it still had active connections (they can outlast the ${texts.noun} for a few minutes). OpsCrew waits until they close, then shows the plan that deletes the tunnel.`,
  );
  for (const tunnel of tunnels) {
    const wait = await waitForTunnelToClose(
      deps,
      tunnel,
      ctx.sleep !== undefined ? { sleep: ctx.sleep } : {},
    );
    if (!wait.closed) throw busy();
  }

  deps.reporter.step("Planning the deletion of the Cloudflare Tunnel");
  const summary = await savePlan(session, "destroy-tunnel", {
    ...(ctx.vars ? { vars: ctx.vars } : {}),
    destroy: true,
  });
  try {
    if (summary.changes.length === 0) {
      deps.reporter.info("Nothing is left to delete.");
      return undefined;
    }
    // Only deletes of what the user confirmed, and no server.
    const servers = summary.changes.filter((change) => deletesServer([change], session.provider));
    const serverAddresses = new Set(servers.map((change) => change.address));
    const problems = deletionPlanProblems(summary.changes, { confirmed: input.confirmed });
    const outside = [
      ...problems.notDeletes,
      ...problems.unconfirmed
        .filter((address) => !serverAddresses.has(address))
        .map((address) => `delete ${address}`),
      ...servers.map(
        (change) =>
          `${change.action} ${change.address} (a ${texts.noun}: this plan may delete only what is left of the tunnel)`,
      ),
    ];
    if (outside.length > 0) {
      // With a server still in the plan, nothing is claimed about what the first apply deleted.
      const already = servers.length > 0 ? "" : ` ${input.tunnelLeft}`;
      throw planStop(
        `The plan for what is left would do more than delete what you confirmed, so OpsCrew stopped before applying it.${already}`,
        outside,
        "Run `opscrew drift` to see what changed, then run `opscrew destroy` again to see the current list and confirm it.",
      );
    }
    // Shown before the approval, which the typed name may already grant (the CLI).
    deps.reporter.info(
      [
        "The plan for what is left deletes these resources:",
        ...describeChanges(summary.changes),
      ].join("\n"),
    );
    const count = summary.changes.length;
    const approval = await deps.approvals.request({
      kind: "iac-apply",
      title: `Delete the Cloudflare Tunnel of ${name} (${plural(count, "resource")} to delete)`,
      details: [
        planHeading(summary, "destroy plan"),
        ...describeChanges(summary.changes),
        `The ${texts.noun} is deleted already; Cloudflare reports no active connections for the tunnel now, so this plan deletes what is left.`,
        `Plan hash: ${summary.planHash}`,
      ].join("\n"),
      planHash: summary.planHash,
      allowDestroy: true,
      confirmPhrase: name,
    });
    if (!approval.approved) {
      throw new OpsCrewError(
        "APPROVAL_REFUSED",
        `The deletion of the app's Cloudflare Tunnel was not approved${refusalReason(approval)}. ${input.tunnelLeft}${snapshotKeptNote(texts, input.snapshotId)}`,
        {
          hint: `Run \`opscrew destroy\` again and type ${name} when you are ready (in a script: \`opscrew destroy --confirm ${name}\`); it deletes what is left.`,
        },
      );
    }
    await deps.approvals.assertApprovedPlan(summary.planHash, { allowDestroy: true });
    deps.reporter.step("Deleting the Cloudflare Tunnel");
    const engine = tunnelSafeEngine(session.engine);
    try {
      await applyApprovedPlan({ ...session, engine }, summary, {
        allowDestroy: true,
        what: "deleting the Cloudflare Tunnel",
        hint: `${input.tunnelLeft} Fix the cause shown above, then run \`opscrew destroy\` again; it continues with what is left.`,
      });
    } catch (error) {
      if (engine.refusedBusyTunnel && engine.onlyBusyTunnel) throw busy();
      throw error;
    }
    return approval;
  } finally {
    await discardPlan(summary);
  }
}

/** 9. What still exists after the teardown, in plain English. */
function remainingAfterDestroy(input: {
  plan: DeployPlan;
  texts: DestroyTexts;
  snapshotId: string | undefined;
  github: GitHubTarget;
  secretsRemoved: readonly string[];
  /** `--delete-data`: the bucket goes with the app's data; otherwise it is said to stay. */
  bucketDeleted: boolean;
  files: DeploymentFiles;
}): string[] {
  const { plan, texts, github, files } = input;
  const bucket = input.bucketDeleted ? undefined : bucketKept(plan);
  return [
    ...remainingAfterDeletion({
      provider: planProvider(plan),
      app: plan.app.name,
      snapshotId: input.snapshotId,
      backups: cloudTarget(plan.target).backups,
    }),
    ...(bucket !== undefined ? [bucket] : []),
    ...deploySecretsLeft(github, { plan, removed: input.secretsRemoved }),
    containerImagesLeft(github, plan),
    ...zeroTrustLeft(plan),
    `The deployment files in the repository (${files.folder}/ and ${plan.cicd.workflowPath}). Pushes still build an image, but the deploy step fails until \`${files.provision}\` creates a new ${texts.noun} from these files.`,
    "The project's SSH deploy key on this computer, kept so a new deployment can reuse it.",
  ];
}

/**
 * `opscrew destroy`: tears a deployment down through the same plan → approval → apply path as
 * provisioning (constitution I). In order: preconditions → credentials (the planned provider;
 * Cloudflare when used; GitHub optional) → engine and `init` → a preview destroy plan (never
 * applied) and the typed confirmation → optional server snapshot → on providers with delete
 * protection (Hetzner), a protection-lifting plan that may only change the server's protection
 * (`iac-apply` approval) → the destroy plan (`iac-apply` approval with `allowDestroy` and the
 * server name typed to confirm) → removal of the GitHub deploy secrets (`github-secrets`
 * approval), the pinned host key and the server's address in OpsCrew's local state. A refusal or
 * failure at any step leaves everything after it untouched, and running it again continues where
 * it stopped.
 *
 * A server the user owns is never deleted, rebuilt or snapshotted: see `destroyOwnServer` (the
 * Cloudflare resources, then a teardown host plan, then optionally the undo host plan). The
 * server-less targets have their own flows: `destroyCloudflareWorkers` and `destroyGithubPages`.
 */
export async function runDestroy(
  deps: PhaseDeps,
  options: DestroyOptions = {},
): Promise<DestroyResult> {
  const services = options.services ?? {};
  const plan = await readArtifact("plan", deps.paths.files.plan);
  // 0. Never during a move: it has its own deletions (`opscrew retarget --finish` / `--abort`).
  if (plan.retarget !== undefined) throw moveInProgress(plan);
  if (plan.target.provider === "localhost") return destroyLocalhost(deps, plan, options);
  if (plan.target.provider === "cloudflare-workers") {
    return destroyCloudflareWorkers(deps, plan, options);
  }
  if (plan.target.provider === "github-pages") return destroyGithubPages(deps, plan, options);
  if (plan.target.provider === "own") return destroyOwnServer(deps, plan, options);
  if (plan.target.provider === "portainer") return destroyPortainer(deps, plan, options);
  const name = plan.app.name;
  const provider = planProvider(plan);
  const profile = providerProfile(provider);
  const texts = destroyTexts(provider);

  // 1. Preconditions
  await requirePreconditions(deps, plan);

  // 2. Credentials
  const usesCloudflare = plan.dns.provider === "cloudflare";
  deps.reporter.step(
    `Checking your ${profile.displayName}${usesCloudflare ? ", Cloudflare" : ""} and GitHub access`,
  );
  await checkProvider(deps, provider, services);
  await checkCloudflare(deps, plan, services);
  const github = await resolveGitHub(deps, services);
  // The server's runner: its registration is deleted through GitHub's API before the server, so
  // a missing token stops here, before anything is deleted.
  const runnerRepo =
    plan.environment?.runner === "server"
      ? await runnerRepository(deps, services.runnerGitHub)
      : undefined;

  // 3. Engine, state encryption, init
  const setup = await setupEngine(deps, plan, options);
  const { engine, env } = setup;
  const session = deletionSession(teardownScope(deps, plan, provider), {
    ...setup,
    dir: join(deps.paths.root, plan.infra.dir),
  });
  const vars = profile.deleteProtection ? { [PROTECTION_VARIABLE]: "false" } : undefined;
  const ctx: DestroyContext = {
    session,
    plan,
    texts,
    ...(vars ? { vars } : {}),
    ...(services.sleep ? { sleep: services.sleep } : {}),
  };

  // 4. Preview: what the teardown deletes (this plan is never applied). The server's address is
  // read now, while the state still has it (its host key is forgotten after the teardown).
  deps.reporter.step("Planning the teardown to see what it deletes");
  const preview = await previewDeletion(session, {
    suffix: "destroy-preview",
    ...(vars ? { vars } : {}),
    destroy: true,
  });
  const address = await serverAddress(deps, plan, {
    engine: async () => engine,
    engineEnv: env,
  });
  if (runnerRepo !== undefined && address === undefined) {
    // Without the address OpsCrew cannot tell this server's runner from another's: never by the
    // label alone, so none is deleted.
    deps.reporter.warn(
      `OpsCrew does not know the server's address on this computer, so it cannot tell which registration at GitHub is this server's runner and deletes none. Once the server is gone, remove the offline runner with the label ${runnerLabel(plan)} under the repository's Settings → Actions → Runners.`,
    );
  } else if (runnerRepo !== undefined && address !== undefined) {
    // This server's runner only: its exact name (from the login's host) and the environment's label.
    ctx.unregisterRunner = async () => {
      const deleted = await deleteRegistrations(deps, runnerRepo, plan, {
        phase: "provision",
        name: serverRunnerName(plan, address.ipv4),
      });
      if (deleted > 0) {
        deps.reporter.info(
          "Deleted the server's runner at GitHub; the runner itself goes with the server.",
        );
      }
    };
  }
  // This app's hostnames in OpsCrew's shared Cloudflare rules (read-only now; removed after the
  // infrastructure is deleted, so a run that stopped before that continues with them).
  const shared = await planSharedRemoval(deps, plan, services);
  const cloudflarePlan = removalDetails(shared);
  if (preview.changes.length === 0 && address === undefined && cloudflarePlan === undefined) {
    throw nothingDeployed(plan);
  }
  // With --delete-data, the app's bucket too (its own root and plan); without, it stays.
  const bucket =
    options.deleteData === true ? await planBucketDeletion(session, plan, setup) : undefined;
  // Which server that is, by the id the state records (names need not be unique).
  const { serverInState, serverIds } = preview;
  if (preview.changes.length > 0) {
    deps.reporter.info(
      ["The teardown deletes these resources:", ...describeChanges(preview.changes)].join("\n"),
    );
  } else {
    deps.reporter.info("The infrastructure is already deleted; OpsCrew finishes the cleanup.");
  }
  if (cloudflarePlan !== undefined) deps.reporter.info(cloudflarePlan);
  const warning = dataWarning(plan, serverInState);
  if (warning) deps.reporter.warn(warning);
  const kept = options.deleteData === true ? undefined : providerBucket(plan);
  if (bucket !== undefined) deps.reporter.warn(bucketDeletionWarning(bucket));
  else if (kept !== undefined) deps.reporter.info(bucketStays(kept));
  const data = {
    serverData: serverData(plan).length > 0,
    backups: cloudTarget(plan.target).backups,
  };
  const snapshotFirst = serverInState && snapshotWanted(options.snapshot, data);
  if (snapshotFirst) {
    deps.reporter.info(
      `A snapshot of the ${texts.noun} is taken first, so its data can be restored later (${texts.snapshotBilling}; \`--no-snapshot\` skips it).`,
    );
  }
  if (serverInState && !profile.deleteProtection) {
    // Said before the prompt: nothing else stands between the typed name and the deletion.
    deps.reporter.warn(
      `${profile.displayName} has no delete protection for ${texts.noun}s, so the only safeguard is OpsCrew's own confirmation: once you confirm with the name ${name}, the ${texts.noun} is deleted as soon as the destroy plan is applied.`,
    );
  }
  await confirmDeletion(
    session,
    {
      name,
      confirmPrompt: destroyConfirmPrompt(name, provider),
      provider,
      deleteProtection: profile.deleteProtection,
      resources: [...preview.changes, ...(bucket?.summary.changes ?? [])],
      snapshot: snapshotFirst,
      ...(warning ? { dataWarning: warning } : {}),
      ...(cloudflarePlan !== undefined ? { cloudflarePlan } : {}),
    },
    options.confirm,
  ).catch(async (error: unknown) => {
    if (bucket !== undefined) await discardBucketDeletion(bucket);
    throw error;
  });
  await pauseCheckForTeardown(deps, github, plan).catch(async (error: unknown) => {
    if (bucket !== undefined) await discardBucketDeletion(bucket);
    throw error;
  });

  // 4a. The environment's runner comes off its runner machine (`runner: host`) and any other
  // machine that has it, first and alone, with its own approval; a machine it cannot reach stops
  // the run before anything is deleted.
  const machines = await removeMachineRunners(deps, {
    plan,
    services,
    phase: "provision",
    command: `opscrew destroy${(await planWhere(deps.paths.root, plan)).flag}`,
  }).catch(async (error: unknown) => {
    if (bucket !== undefined) await discardBucketDeletion(bucket);
    throw error;
  });

  // 4b–7b. The app's bucket: R2's first, since Cloudflare refuses a bucket that holds files and then
  // nothing else is deleted yet; a Hetzner or Spaces bucket after the server, like its other data.
  // Its planned deletion never outlives this run.
  let bucketDeleted: BucketDeleted | undefined;
  let deleted: Awaited<ReturnType<typeof destroyInfrastructure>>;
  let snapshotId: string | undefined;
  let protection: Awaited<ReturnType<typeof liftProtection>>;
  try {
    if (bucket?.bucket.provider === "r2") bucketDeleted = await deleteBucket(bucket);

    // 5. Snapshot (inside the confirmed flow: after the typed name, before anything is deleted)
    snapshotId = await takeSnapshotBeforeDelete(session, {
      server: { inState: serverInState, ids: serverIds },
      choice: options.snapshot ?? "auto",
      data,
      purpose: "destroy",
      ...(services.servers ? { servers: services.servers } : {}),
      ...(services.sleep ? { sleep: services.sleep } : {}),
      ...(services.now ? { now: services.now } : {}),
    });

    // 6. Lift delete protection (only where the provider has it)
    protection = await liftProtection(session, {
      variable: PROTECTION_VARIABLE,
      serverInState,
      ...(snapshotId !== undefined ? { snapshotId } : {}),
      mismatchHint:
        "The infrastructure was probably changed outside OpsCrew, or its files no longer match what was applied. Run `opscrew drift` to see the differences and `opscrew provision` to bring everything back in line, then run `opscrew destroy` again.",
    });

    // 7. Destroy
    deleted = await destroyInfrastructure(ctx, snapshotId, protection.off, {
      addresses: preview.addresses,
      serverIds,
    });
    if (bucket !== undefined && bucket.bucket.provider !== "r2") {
      bucketDeleted = await deleteBucket(bucket, {
        ...(services.sleep ? { sleep: services.sleep } : {}),
      });
    }
  } finally {
    if (bucket !== undefined) await discardBucketDeletion(bucket);
  }
  const { destroyed, approval: destroyApproval, tunnelApproval } = deleted;

  // 7c. This app's hostnames leave OpsCrew's shared Cloudflare rules (`cloudflare-apply`)
  const sharedApproval = await applySharedRemoval(deps, plan, shared);

  // 8. Cleanup: deploy secrets, pinned host key, plan, stored-secrets record, phase state
  const secretsRemoved = await removeDeploySecrets(deps, github, {
    plan,
    done: "The infrastructure is deleted.",
    reach: "a server",
  });
  if ((await forgetHostKeys(deps, [address?.ipv4, address?.ipv6])) > 0) {
    deps.reporter.info(`Removed the ${texts.noun}'s SSH host key from OpsCrew's known_hosts.`);
  }
  const approvals = [
    ...machines.map((outcome) => outcome.approval),
    bucketDeleted?.approval,
    protection.approval,
    destroyApproval,
    tunnelApproval,
    sharedApproval,
  ];
  await recordTeardown(deps, plan, approvals, {
    summary: "infrastructure destroyed",
    forgetAddress: true,
  });
  await removeSnapshotRecord(deps, "destroy");
  await deps.audit.append({
    kind: "phase",
    actor: "opscrew",
    action: "destroy",
    phase: "provision",
    target: name,
    detail: `infrastructure destroyed: ${destroyed.length} resources deleted, ${secretsRemoved.length} deploy secrets removed${snapshotId !== undefined ? `, ${texts.snapshotRef(snapshotId)} kept` : ""}${bucket !== undefined ? (bucketDeleted?.stillListed ? ", the app's bucket still listed" : ", the app's bucket deleted") : ""}`,
  });
  deps.reporter.success(`${name} is torn down. opscrew/plan.yaml records when.`);

  // 9. What remains
  const remaining = remainingAfterDestroy({
    plan,
    texts,
    snapshotId,
    github,
    secretsRemoved,
    bucketDeleted: options.deleteData === true,
    files: await deploymentFiles(deps, plan),
  });
  remaining.push(...bucketStillListed(bucketDeleted));
  deps.reporter.info(["What remains:", ...remaining.map((item) => `  - ${item}`)].join("\n"));
  failIfBucketListed(bucketDeleted);
  return {
    ...(snapshotId !== undefined ? { snapshotId } : {}),
    destroyed,
    secretsRemoved,
    remaining,
  };
}
