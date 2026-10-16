import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  applyStackPlan,
  type CreatedRecord,
  DEPLOY_BRANCH,
  type PortainerClient,
  planStackTeardown,
  StackApplyError,
  type StackPlan,
  stackPlanHash,
} from "@opscrew/connector-portainer";
import type { ApprovalRecord, ResourceChange } from "@opscrew/contracts";
import { isUserFacingError, listText, OpsCrewError, plural, writeFileAtomic } from "@opscrew/core";
import { DEPLOY_SECRETS, PORTAINER_DEPLOY_SECRETS, portainerTarget } from "@opscrew/iac-templates";
import { type DeployPlan, writeArtifact } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { PORTAINER_BACKUPS_NOTE, PORTAINER_HOST_NOTE } from "../design/portainer";
import { stateContents } from "../drift/infra";
import { portainerCloudflare } from "../provision/credentials";
import {
  portainerContainerUrl,
  portainerValueKeyFile,
  portainerWebhookFile,
  requirePortainerConnection,
  requirePortainerToken,
  stackPlanFile,
} from "../provision/portainer";
import {
  chooseEngine,
  hasDeployment,
  hasState,
  hidePortainerAddress,
  inspectRecordedPortainer,
  type PortainerConnection,
  readPortainerConnection,
  recordPortainerConnection,
  stateFile,
} from "../shared";
import {
  applyCloudflareRemoval,
  approveCloudflareRemoval,
  type CloudflareRemoval,
  type CloudflareRemovalWords,
  COMMAND,
  checkCloudflare,
  containerImagesLeft,
  deploySecretsLeft,
  destroyedPlan,
  type GitHubTarget,
  nothingDeployed,
  previewCloudflareRemoval,
  removeDeploySecrets,
  requireInfraCode,
  resolveGitHub,
  secretsPage,
  setupEngine,
  stateNotHere,
  stoppedPartWay,
  teardownScope,
  teardownSummary,
} from "./common";
import { confirmDeletion, type DeletionSession, deletionSession, discardPlan } from "./deletion";
import { destroyConfirmPrompt } from "./texts";
import type { DestroyOptions, DestroyResult } from "./types";

/** Said wherever the teardown in the user's Portainer is described (FR-1014, FR-1015). */
const PORTAINER_STAYS = `Portainer itself, its settings and every stack, volume and registry entry OpsCrew did not create stay as they are: OpsCrew removes only what its record lists for this app. ${PORTAINER_HOST_NOTE} ${PORTAINER_BACKUPS_NOTE}`;

/** Why the tunnel goes last, said in the approval and the summary. */
const TUNNEL_AFTER_STACKS =
  "Cloudflare deletes a tunnel only after its connector has stopped, and the connector runs in your Portainer,";

/** How the Cloudflare part of the teardown is worded in the user's Portainer. */
const WORDS: CloudflareRemovalWords = {
  what: "Cloudflare Tunnel, DNS records and Access",
  place: "your Portainer",
  tunnelAfter: TUNNEL_AFTER_STACKS,
  stays: PORTAINER_STAYS,
};

/** The deploy secrets a Portainer setup stores (in redeploy mode `cloudflare`, the webhook's too). */
const SECRET_NAMES = [DEPLOY_SECRETS.buildEnv, ...Object.values(PORTAINER_DEPLOY_SECRETS)];

/** Stops (`PHASE_PRECONDITION`, nothing changed) when the teardown plan cannot run. */
function requireNoStackBlockers(plan: StackPlan, name: string): void {
  const blocked = plan.changes.filter((change) => change.state === "blocked");
  if (plan.findings.length === 0 && blocked.length === 0) return;
  const reasons = [
    ...plan.findings.map((finding) => finding.message),
    ...blocked.map((change) => `${change.title}: ${change.reason ?? "blocked"}`),
  ];
  const hints = [...new Set(plan.findings.map((finding) => finding.hint))];
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    `OpsCrew cannot remove ${name} from your Portainer, so it changed nothing:\n${reasons.map((reason) => `  - ${reason}`).join("\n")}`,
    {
      hint:
        hints.length > 0
          ? `${hints.join(" ")} Then run \`${COMMAND}\` again.`
          : `Fix what blocks these changes in Portainer, then run \`${COMMAND}\` again.`,
    },
  );
}

/** Writes what OpsCrew still has in Portainer to `.opscrew/server.json`. */
async function recordCreated(
  deps: Pick<PhaseDeps, "paths">,
  connection: PortainerConnection,
  created: CreatedRecord,
): Promise<PortainerConnection> {
  const next: PortainerConnection = {
    ...connection,
    created: {
      stacks: created.stacks.map((stack) => ({ ...stack })),
      ...(created.registryId !== undefined ? { registryId: created.registryId } : {}),
      volumes: [...created.volumes],
    },
  };
  await recordPortainerConnection(deps.paths, next);
  return next;
}

/**
 * Once OpsCrew's stacks are gone: the app stack's webhook, the value key and the saved stack plans
 * (`.opscrew/plans/stack-*.json`) are of no use any more, so they leave this computer.
 */
async function forgetLocalStackFiles(deps: PhaseDeps): Promise<void> {
  await rm(portainerWebhookFile(deps.paths), { force: true });
  await rm(portainerValueKeyFile(deps.paths), { force: true });
  const plans = await readdir(deps.paths.files.plansDir).catch(() => [] as string[]);
  for (const file of plans) {
    if (/^stack-[0-9a-f]{64}\.json$/.test(file)) {
      await rm(join(deps.paths.files.plansDir, file), { force: true });
    }
  }
}

/**
 * The stack teardown plan in plain English, shown before its `stack-apply` approval: every
 * change, its state and reason, then the hash. A teardown sends no value or token.
 */
function describeTeardown(plan: StackPlan, hash: string, environment?: string): string {
  const count = (state: string) => plan.changes.filter((change) => change.state === state).length;
  const where = environment === undefined ? "" : ` (environment "${environment}")`;
  const lines = [
    `Stack teardown plan for your Portainer${where}: ${count("change")} to change, ${count("in-place")} already gone.`,
  ];
  for (const change of plan.changes) {
    lines.push(`  ${change.state === "change" ? "-" : "✓"} ${change.title}`);
    if (change.reason !== undefined) lines.push(`      ${change.reason}`);
  }
  lines.push(
    "Removing sends no value or token to Portainer. OpsCrew changes no other stack and never Portainer's own settings.",
    `Stack plan hash: ${hash}`,
  );
  return lines.join("\n");
}

/** The stack teardown plan, approved by its hash but not applied yet. */
interface ApprovedTeardown {
  plan: StackPlan;
  hash: string;
  approval: ApprovalRecord;
}

/**
 * The stack teardown plan, saved as `.opscrew/plans/stack-<hash>.json`, shown, approved as
 * `stack-apply` by its hash with `allowDestroy` and the typed app name, and checked. Nothing is
 * changed here: {@link applyTeardown} applies it.
 */
async function approveTeardown(
  deps: PhaseDeps,
  input: {
    plan: StackPlan;
    environment: string | undefined;
    name: string;
    intro: readonly string[];
    refused: string;
  },
): Promise<ApprovedTeardown> {
  const { plan, name } = input;
  const hash = stackPlanHash(plan);
  await writeFileAtomic(stackPlanFile(deps.paths, hash), `${JSON.stringify(plan, null, 2)}\n`, {
    mode: 0o600,
  });
  const details = [...input.intro, describeTeardown(plan, hash, input.environment)].join("\n");
  deps.reporter.info(details);
  const work = plan.changes.filter((change) => change.state === "change");
  const approval = await deps.approvals.request({
    kind: "stack-apply",
    title: `Remove ${name} from your Portainer (${plural(work.length, "change")})`,
    details,
    planHash: hash,
    allowDestroy: true,
    confirmPhrase: name,
  });
  if (!approval.approved) {
    throw new OpsCrewError(
      "APPROVAL_REFUSED",
      `${input.refused}${approval.reason ? ` (${approval.reason})` : ""}`,
      { hint: `Run \`${COMMAND}\` again when you are ready; it shows the plan again.` },
    );
  }
  await deps.approvals.assertApprovedStackPlan(hash, { allowDestroy: true });
  return { plan, hash, approval };
}

/**
 * Applies the approved stack teardown through the Portainer adapter (which refuses any other
 * plan; its approval is checked again first). What OpsCrew still has afterwards is recorded, also
 * when the apply stopped part-way. Audited by the plan's hash only.
 */
async function applyTeardown(
  deps: PhaseDeps,
  approved: ApprovedTeardown,
  input: {
    client: PortainerClient;
    connection: PortainerConnection;
    name: string;
    afterFailure: string;
    wait?: Parameters<typeof applyStackPlan>[2]["wait"];
  },
): Promise<{ applied: string[]; connection: PortainerConnection }> {
  const { plan, hash } = approved;
  const { name } = input;
  const work = plan.changes.filter((change) => change.state === "change");
  await deps.approvals.assertApprovedStackPlan(hash, { allowDestroy: true });
  await deps.audit.append({
    kind: "provider-call",
    actor: "opscrew",
    action: "stack teardown started",
    phase: "provision",
    target: hash,
    decision: "approved",
    detail: `changes: ${work.map((change) => change.id).join(", ")}`,
  });
  deps.reporter.step(`Removing ${name} from your Portainer (${plural(work.length, "change")})`);
  let connection = input.connection;
  let result: Awaited<ReturnType<typeof applyStackPlan>>;
  try {
    // A teardown sends no value: nothing but names and ids leaves this computer.
    result = await applyStackPlan(input.client, plan, {
      approvedHash: hash,
      secrets: { env: {} },
      ...(input.wait !== undefined ? { wait: input.wait } : {}),
    });
  } catch (error) {
    if (error instanceof StackApplyError) {
      // What is left is still OpsCrew's: record it before the error is shown.
      connection = await recordCreated(deps, connection, error.record);
      await deps.audit.append({
        kind: "provider-call",
        actor: "opscrew",
        action: "stack teardown failed",
        phase: "provision",
        target: hash,
        decision: "refused",
        detail: `changes applied before the failure: ${error.applied.length > 0 ? error.applied.join(", ") : "none"}`,
      });
    }
    throw stoppedPartWay(error, {
      place: "your Portainer",
      afterFailure: input.afterFailure,
      say: deps.redactor.redact,
    });
  }
  connection = await recordCreated(deps, connection, result.record);
  for (const id of result.applied) {
    const change = plan.changes.find((item) => item.id === id);
    await deps.audit.append({
      kind: "provider-call",
      actor: "opscrew",
      action: `stack teardown ${id}`,
      phase: "provision",
      target: hash,
      decision: "approved",
      ...(change !== undefined ? { detail: change.title } : {}),
    });
  }
  return { applied: result.applied, connection };
}

/** True when OpsCrew can delete the deploy branch: a GitHub client with `deleteBranch` and the repository. */
function canDeleteBranch(github: GitHubTarget): boolean {
  return github.api?.deleteBranch !== undefined && Boolean(github.owner && github.repo);
}

/**
 * Once the app's stack is gone: deletes the deploy branch, which holds the stack's file, so a later
 * setup never starts from it (covered by the destroy approval; a branch already gone is fine).
 * `true` when the branch is gone afterwards. A GitHub that cannot be reached or refuses is no reason
 * to stop the teardown: the warning says how to finish (and a later `opscrew provision` replaces
 * the branch's file before it creates the app's stack anyway).
 */
async function deleteDeployBranch(deps: PhaseDeps, github: GitHubTarget): Promise<boolean> {
  const { api, owner, repo } = github;
  // Without the call (or the repository) the branch stays and is listed under what remains.
  if (api?.deleteBranch === undefined || !owner || !repo) return false;
  const where = `${owner}/${repo}`;
  try {
    const result = await api.deleteBranch(owner, repo, DEPLOY_BRANCH);
    await deps.audit.append({
      kind: "git",
      actor: "opscrew",
      action: "delete branch",
      phase: "provision",
      target: `${where}:${DEPLOY_BRANCH}`,
      decision: "approved",
      detail: result === "deleted" ? "deleted" : "already gone",
    });
    if (result === "deleted") {
      deps.reporter.success(`Deleted the branch ${DEPLOY_BRANCH} of ${where}.`);
    } else {
      deps.reporter.info(`The branch ${DEPLOY_BRANCH} of ${where} is already gone.`);
    }
    return true;
  } catch (error) {
    const reason = isUserFacingError(error) ? error.message : "unexpected error";
    deps.reporter.warn(
      deps.redactor.redact(
        `The app is removed from your Portainer, but deleting the branch ${DEPLOY_BRANCH} of ${where} failed: ${reason} To finish, delete it on GitHub (or with \`git push origin --delete ${DEPLOY_BRANCH}\`); a later \`opscrew provision\` replaces its file with a placeholder before it creates the app's stack anyway.`,
      ),
    );
    return false;
  }
}

/** What still exists after the teardown in the user's Portainer, in plain English. */
function remainingInPortainer(input: {
  plan: DeployPlan;
  github: GitHubTarget;
  secretsRemoved: readonly string[];
  keptVolumes: readonly string[];
  removedApp: boolean;
  branchDeleted: boolean;
  /** This run approved nothing, so OpsCrew did not delete the branch (it never does unapproved). */
  branchUnapproved: boolean;
}): string[] {
  const { plan, github } = input;
  const items = [
    "Your Portainer itself, its settings and every stack, volume and registry entry OpsCrew did not create: OpsCrew never changes them.",
    `${PORTAINER_HOST_NOTE} ${PORTAINER_BACKUPS_NOTE}`,
  ];
  if (input.keptVolumes.length > 0) {
    items.push(
      `The app's data in your Portainer: the volume${input.keptVolumes.length === 1 ? "" : "s"} ${listText(input.keptVolumes)}. OpsCrew took no backup. To delete ${input.keptVolumes.length === 1 ? "it" : "them"} when you no longer need ${input.keptVolumes.length === 1 ? "it" : "them"}, run \`opscrew destroy --delete-data\` (you type ${plan.app.name} to confirm), or remove ${input.keptVolumes.length === 1 ? "it" : "them"} in Portainer (Volumes).`,
    );
  }
  if (!input.removedApp) return items;
  items.push(...deploySecretsLeft(github, { names: SECRET_NAMES, removed: input.secretsRemoved }));
  const repo = github.owner && github.repo ? `${github.owner}/${github.repo}` : "<owner>/<repo>";
  if (!input.branchDeleted) {
    items.push(
      input.branchUnapproved
        ? `The opscrew-deploy branch of ${repo}, which holds the app's stack file: OpsCrew deletes it only together with a teardown you approve, and this run had nothing to approve (the app's stacks were already gone). Delete it on GitHub (or with \`git push origin --delete opscrew-deploy\`); a later \`opscrew provision\` replaces its file with a placeholder before it creates the app's stack anyway.`
        : `The opscrew-deploy branch of ${repo}, which holds the app's stack file. Delete it on GitHub (or with \`git push origin --delete opscrew-deploy\`) if you no longer need it.`,
    );
  }
  items.push(
    containerImagesLeft(github),
    `The deployment files in the repository (opscrew/ and ${plan.cicd.workflowPath}). Pushes still build an image, but the deploy fails until \`opscrew provision\` sets up the app's stacks again from these files.`,
    "How OpsCrew reaches your Portainer (.opscrew/server.json) with its confirmed certificate, kept so a new deployment can reuse it.",
  );
  return items;
}

/**
 * `opscrew destroy` for the user's Portainer (FR-1014). It never touches Portainer itself, its
 * settings or anything OpsCrew's record does not list. In order, each step only after the one
 * before succeeded: preconditions (the record of what OpsCrew created; the state when the plan has
 * Cloudflare resources) → credentials (`PORTAINER_API_KEY`; Cloudflare when the state has
 * resources; GitHub optional) → connect with the pinned certificate and inspect read-only → the
 * Cloudflare destroy preview and the stack teardown plan, both checked before anything changes,
 * shown and confirmed once with the typed app name → the Cloudflare destroy plan (`iac-apply`,
 * `allowDestroy` + typed app name) → the stack teardown plan (`stack-apply` by its hash,
 * `allowDestroy` + typed app name): the updater or connector stack first, then (with `deleteData`)
 * the recorded volumes, the app stack and the registry entry OpsCrew added → once the stacks are
 * gone, the webhook, the value key and the saved stack plans leave this computer → the Cloudflare
 * plan, once Cloudflare reports no active connections for a tunnel it deletes → the deploy secrets
 * and OpsCrew's record of the deployment. The app's volumes are deleted only with `deleteData`; a
 * later `--delete-data` run deletes the volumes an earlier teardown kept. A refusal or failure
 * leaves everything after it untouched; running it again continues.
 */
export async function destroyPortainer(
  deps: PhaseDeps,
  plan: DeployPlan,
  options: DestroyOptions,
): Promise<DestroyResult> {
  const services = options.services ?? {};
  const portainerServices = services.portainer ?? {};
  const name = plan.app.name;
  const deleteData = options.deleteData === true;
  // A state an earlier removal emptied (provision removes what a former setup created in
  // Cloudflare) holds nothing to delete, encrypted or not; one the engine cannot list still counts.
  const stateHere =
    (await hasState(deps.paths)) &&
    (await stateContents(deps, stateFile(deps.paths), () =>
      chooseEngine(deps, options.engine ?? plan.infra.engine, services.engine),
    )) !== "nothing";
  const scope = teardownScope(deps, plan, "portainer");

  // 1. Preconditions: OpsCrew's record of what it created in Portainer, and the state of the
  // Cloudflare resources when the plan has any (without it they cannot be removed).
  const recorded = await readPortainerConnection(deps.paths);
  if (recorded === undefined) {
    if (!hasDeployment(plan)) throw nothingDeployed(plan);
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      "OpsCrew's record of what it created in your Portainer is not on this computer, so it cannot tell what to remove. Nothing was changed.",
      {
        hint: "Run `opscrew destroy` on the computer that ran `opscrew provision` (its .opscrew/server.json lists the stacks OpsCrew created).",
      },
    );
  }
  let connection = await requirePortainerConnection(deps, plan);
  const record = connection.created;
  const recordedStacks = record.stacks.length > 0 || record.registryId !== undefined;
  // A finished teardown records `destroyedAt`; an interrupted one does not, so it continues.
  const removeApp =
    hasDeployment(plan) ||
    recordedStacks ||
    (stateHere && plan.deployment.destroyedAt === undefined);
  const dataOnly = !removeApp && deleteData && record.volumes.length > 0;
  if (!removeApp && !dataOnly) throw nothingDeployed(plan);
  const root = portainerCloudflare(plan) ?? { appTunnel: false, webhook: false };
  if (removeApp && (root.appTunnel || root.webhook) && !stateHere) throw stateNotHere(plan);
  const cloudflareState = removeApp && stateHere;
  if (cloudflareState) {
    await requireInfraCode(deps, plan, "the removal of the app's Cloudflare resources");
  }

  // 2. Credentials
  const cloudflare = cloudflareState && plan.dns.provider === "cloudflare";
  deps.reporter.step(
    `Checking your Portainer${cloudflare ? ", Cloudflare" : ""}${removeApp ? " and GitHub" : ""} access`,
  );
  const token = requirePortainerToken(deps);
  if (cloudflare) await checkCloudflare(deps, plan, services);
  const github: GitHubTarget = removeApp ? await resolveGitHub(deps, services) : {};
  if (removeApp && github.skipReason) {
    deps.reporter.warn(
      `OpsCrew cannot remove the deploy secrets from GitHub Actions: ${github.skipReason}. The teardown continues; delete them yourself afterwards at ${secretsPage(github)}.`,
    );
  }

  // 3. Connect (pinned certificate) and inspect (read-only)
  const { client, facts } = await inspectRecordedPortainer(deps, {
    plan,
    target: portainerTarget(plan.target),
    connection,
    token,
    client: portainerServices.client,
    step: "Inspecting your Portainer (read-only)",
    phase: "provision",
    detail: "destroy",
  });

  // 4. What the teardown removes: checked before anything changes, shown, confirmed once
  const teardown = planStackTeardown(facts, record, { deleteData, app: name });
  requireNoStackBlockers(teardown, name);
  const stackWork = teardown.changes.filter((change) => change.state === "change");
  let session: DeletionSession | undefined;
  let resources: ResourceChange[] = [];
  let confirmed: ReadonlySet<string> = new Set();
  if (cloudflareState) {
    const setup = await setupEngine(deps, plan, options);
    // Portainer's address reaches the engine only as a sensitive variable, never in a file.
    const origin = portainerContainerUrl(connection.url);
    hidePortainerAddress(deps.redactor, origin);
    setup.env.TF_VAR_portainer_origin = origin;
    session = deletionSession(scope, { ...setup, dir: join(deps.paths.root, plan.infra.dir) });
    ({ resources, confirmed } = await previewCloudflareRemoval(session, WORDS));
  }
  const volumes = teardown.changes.find((change) => change.id === "volumes");
  const deletesData = volumes?.state === "change";
  const dataNames =
    deletesData && Array.isArray(volumes?.params.names) ? [...volumes.params.names] : [];
  const dataWarning = deletesData
    ? `Removing the app also deletes its data in your Portainer: the volume${dataNames.length === 1 ? "" : "s"} ${listText(dataNames)}${plan.services.postgres ? " (with the PostgreSQL database)" : ""}. OpsCrew takes no backup of your Portainer host, so this cannot be undone unless you have your own backup.`
    : undefined;
  if (deleteData && !deletesData) {
    deps.reporter.info(
      "OpsCrew recorded no data volumes of this app in your Portainer, so `--delete-data` has nothing to delete.",
    );
  }
  // Said where the user confirms and in the approval that covers it (the teardown's, or the
  // Cloudflare removal's when nothing changes in Portainer).
  const branchNote =
    removeApp && canDeleteBranch(github)
      ? `Once the app's stack is gone, OpsCrew also deletes the branch ${DEPLOY_BRANCH} of ${github.owner}/${github.repo}, which holds the stack's file.`
      : undefined;
  const stackTitles = stackWork.map((change) => change.title);
  deps.reporter.info(
    teardownSummary({
      resources,
      removed: stackTitles,
      words: WORDS,
      notes: branchNote !== undefined ? [branchNote] : [],
    }),
  );
  if (dataWarning !== undefined) deps.reporter.warn(dataWarning);
  else if (!deleteData && record.volumes.length > 0) {
    deps.reporter.info(
      `The app's data in your Portainer (the volume${record.volumes.length === 1 ? "" : "s"} ${listText(record.volumes)}) is kept. To delete it as well, cancel now and run \`opscrew destroy --delete-data\`.`,
    );
  }
  await confirmDeletion(
    scope,
    {
      name,
      confirmPrompt: destroyConfirmPrompt(name, "portainer"),
      provider: "portainer",
      deleteProtection: false,
      resources,
      snapshot: false,
      ...(dataWarning !== undefined ? { dataWarning } : {}),
      stackChanges: stackTitles,
    },
    options.confirm,
  );

  // 5–6. The Cloudflare resources (tunnel, DNS records, Access) and the app's stacks in Portainer.
  // Both are approved before anything changes. The stacks go first when the Cloudflare plan deletes
  // a tunnel (its connector runs in Portainer); that plan follows once the tunnel has no connections.
  let destroyed: ResourceChange[] = [];
  let removal: CloudflareRemoval | undefined;
  if (session !== undefined && resources.length > 0) {
    removal = await approveCloudflareRemoval(session, {
      confirmed,
      appChanges: stackWork.length > 0,
      words: WORDS,
      notes: stackWork.length === 0 && branchNote !== undefined ? [branchNote] : [],
    });
  }
  let stackApproval: ApprovalRecord | undefined;
  let stackHash: string | undefined;
  try {
    const tunnelFirst = removal?.tunnel === true;
    // The stack teardown is approved too before anything changes, whichever goes first.
    const approved =
      stackWork.length > 0
        ? await approveTeardown(deps, {
            plan: teardown,
            environment: facts.environment?.name,
            name,
            intro: [
              deleteData
                ? `This removes ${name} from your Portainer, including its data.`
                : `This removes ${name} from your Portainer; its data volumes stay.`,
              ...(dataWarning !== undefined ? [dataWarning] : []),
              ...(tunnelFirst
                ? [
                    `${TUNNEL_AFTER_STACKS} so this goes first; the approved Cloudflare plan follows once Cloudflare reports no active connections for the tunnel.`,
                  ]
                : []),
              ...(branchNote !== undefined ? [branchNote] : []),
              PORTAINER_STAYS,
            ],
            refused: `The removal of ${name} from your Portainer was not approved, so nothing in your Portainer was changed and nothing in Cloudflare was deleted.`,
          })
        : undefined;
    if (session !== undefined && removal !== undefined && !removal.tunnel) {
      destroyed = await applyCloudflareRemoval(session, removal, services.sleep);
    }
    if (approved !== undefined) {
      const afterFailure = tunnelFirst
        ? "Nothing in Cloudflare was deleted yet (the tunnel goes only after the app's stacks). Run `opscrew destroy` again to finish; it continues with what is left."
        : destroyed.length > 0
          ? "The app's Cloudflare resources are deleted already. Run `opscrew destroy` again to finish; it continues with what is left."
          : "Run `opscrew destroy` again to finish; it continues with what is left.";
      const result = await applyTeardown(deps, approved, {
        client,
        connection,
        name,
        afterFailure,
        ...(portainerServices.wait !== undefined ? { wait: portainerServices.wait } : {}),
      });
      connection = result.connection;
      stackApproval = approved.approval;
      stackHash = approved.hash;
      deps.reporter.success(
        `Removed ${name} from your Portainer (${plural(result.applied.length, "change")}).`,
      );
    } else if (teardown.changes.some((change) => change.params.action === "forget")) {
      // Only what Portainer no longer has: forget it, nothing to change there.
      connection = await recordCreated(deps, connection, {
        stacks: [],
        volumes: [...record.volumes],
      });
    }
    if (connection.created.stacks.length === 0) await forgetLocalStackFiles(deps);
    if (session !== undefined && removal?.tunnel === true) {
      destroyed = await applyCloudflareRemoval(session, removal, services.sleep);
    }
  } finally {
    // Never left behind for a later apply (applyCloudflareRemoval deletes it, too).
    if (removal !== undefined) await discardPlan(removal.summary);
  }

  // The deploy branch holds the app stack's file: once the stack is gone, the branch goes too, but
  // only under an approval of this run (the teardown's or the Cloudflare removal's), never without.
  const approvedNow = stackApproval !== undefined || removal !== undefined;
  const stackGone = !connection.created.stacks.some((stack) => stack.role === "app");
  const branchDeleted =
    removeApp && stackGone && approvedNow ? await deleteDeployBranch(deps, github) : false;
  const branchUnapproved = removeApp && stackGone && !approvedNow && canDeleteBranch(github);

  // 7. Deploy secrets and OpsCrew's record of the deployment
  let secretsRemoved: string[] = [];
  if (removeApp) {
    secretsRemoved = await removeDeploySecrets(deps, github, {
      names: SECRET_NAMES,
      done: "The app is removed from your Portainer and Cloudflare.",
      reach: "your Portainer",
    });
    const at = deps.clock.now().toISOString();
    await writeArtifact(
      "plan",
      deps.paths.files.plan,
      destroyedPlan(plan, at, [removal?.approval, stackApproval]),
    );
    await rm(deps.paths.files.deploySecrets, { force: true });
    await deps.state.markPhase("provision", "skipped", "app removed from your Portainer");
  }
  await deps.audit.append({
    kind: "phase",
    actor: "opscrew",
    action: "destroy",
    phase: "provision",
    target: name,
    detail: `${removeApp ? "app removed" : "data removed"}: ${plural(destroyed.length, "Cloudflare resource")} deleted, ${plural(stackWork.length, "change")} in Portainer, ${plural(secretsRemoved.length, "deploy secret")} removed${deletesData ? ", app data deleted" : ", app data kept"}; Portainer itself stays`,
  });
  deps.reporter.success(
    removeApp
      ? `${name} is removed. Your Portainer and its other stacks stay as they are; opscrew/plan.yaml records when.`
      : `The data of ${name} is removed from your Portainer.`,
  );

  // 8. What remains
  const remaining = remainingInPortainer({
    plan,
    github,
    secretsRemoved,
    keptVolumes: connection.created.volumes,
    removedApp: removeApp,
    branchDeleted,
    branchUnapproved,
  });
  deps.reporter.info(["What remains:", ...remaining.map((item) => `  - ${item}`)].join("\n"));
  return {
    destroyed,
    secretsRemoved,
    remaining,
    ...(stackHash !== undefined ? { stackPlan: stackHash } : {}),
  };
}
