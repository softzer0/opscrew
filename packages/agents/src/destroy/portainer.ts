import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  applyStackPlan,
  type CreatedRecord,
  inspectPortainer,
  opscrewStackNames,
  type PortainerClient,
  planStackTeardown,
  portainerClient,
  StackApplyError,
  type StackPlan,
  stackPlanHash,
} from "@opscrew/connector-portainer";
import type { ApprovalRecord, PlanSummary, ResourceChange } from "@opscrew/contracts";
import { isUserFacingError, OpsCrewError, writeFileAtomic } from "@opscrew/core";
import { engineLabel } from "@opscrew/iac-engine";
import { DEPLOY_SECRETS, PORTAINER_DEPLOY_SECRETS } from "@opscrew/iac-templates";
import { type DeployPlan, writeArtifact } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { PORTAINER_BACKUPS_NOTE, PORTAINER_HOST_NOTE } from "../design/portainer";
import { stateHoldsNothing } from "../drift/infra";
import { hidePortainerAddress } from "../interview/portainer-access";
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
  hasDeployment,
  type PortainerConnection,
  readPortainerConnection,
  recordPortainerConnection,
} from "../shared";
import {
  deletesTunnel,
  requireTunnelClosed,
  TUNNEL_RESOURCE_TYPE,
  tunnelBusyError,
  tunnelSafeEngine,
} from "../shared/tunnel-connections";
import { deletionPlanProblems, describeChanges } from "./checks";
import {
  COMMAND,
  checkCloudflare,
  destroyedPlan,
  type GitHubTarget,
  nothingDeployed,
  removeDeploySecrets,
  resolveGitHub,
  secretsPage,
  setupEngine,
  stateNotHere,
} from "./common";
import { applyApprovedPlan, type DeletionSession, discardPlan, savePlan } from "./deletion";
import { destroyConfirmPrompt } from "./texts";
import type { DestroyOptions, DestroyPreview, DestroyResult } from "./types";

/** Said wherever the teardown in the user's Portainer is described (FR-1014, FR-1015). */
export const PORTAINER_STAYS = `Portainer itself, its settings and every stack, volume and registry entry OpsCrew did not create stay as they are: OpsCrew removes only what its record lists for this app. ${PORTAINER_HOST_NOTE} ${PORTAINER_BACKUPS_NOTE}`;

/** Why the tunnel goes last, said in the approval and the summary. */
const TUNNEL_AFTER_STACKS =
  "Cloudflare deletes a tunnel only after its connector has stopped, and the connector runs in your Portainer,";

/** Said when the app is out of Portainer and its Cloudflare resources are not deleted yet. */
const STACKS_DONE_CLOUDFLARE_LEFT =
  "The app is removed from your Portainer; its Cloudflare resources are still there.";

/** The deploy secrets a Portainer setup stores (in redeploy mode `cloudflare`, the webhook's too). */
const SECRET_NAMES = [DEPLOY_SECRETS.buildEnv, ...Object.values(PORTAINER_DEPLOY_SECRETS)];

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

async function nonEmpty(file: string): Promise<boolean> {
  try {
    return (await stat(file)).size > 0;
  } catch {
    return false;
  }
}

function list(items: readonly string[]): string {
  return items.length <= 1
    ? items.join("")
    : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

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

/** Cloudflare is the only provider of a Portainer root: anything else stops. */
function cloudflareOnly(changes: readonly ResourceChange[], note: string): void {
  const others = changes
    .filter((change) => !change.type.startsWith("cloudflare_"))
    .map((change) => change.address);
  if (others.length === 0) return;
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    [
      `The teardown plan would delete resources other than the app's Cloudflare Tunnel, DNS records and Access, so OpsCrew stopped. ${note}`,
      ...others.map((address) => `  ${address}`),
    ].join("\n"),
    {
      hint: "Run `opscrew drift` to see what changed in the infrastructure code, then run `opscrew destroy` again.",
    },
  );
}

/** The Cloudflare part of the teardown, planned and approved but not applied yet. */
interface CloudflareRemoval {
  summary: PlanSummary;
  approval: ApprovalRecord;
  tunnel: boolean;
}

/**
 * The Cloudflare part of the teardown, up to its approval: a destroy plan that may only delete
 * Cloudflare resources the user confirmed, approved with `allowDestroy` and the typed app name.
 * `undefined` (its plan file deleted) when nothing is left to delete; on any stop the plan file is
 * deleted too.
 */
async function approveCloudflareRemoval(
  session: DeletionSession,
  plan: DeployPlan,
  confirmed: ReadonlySet<string>,
  stackChanges: boolean,
): Promise<CloudflareRemoval | undefined> {
  const { deps } = session;
  const name = plan.app.name;
  deps.reporter.step("Planning the removal of the app's Cloudflare Tunnel, DNS records and Access");
  const summary = await savePlan(session, "destroy", { destroy: true });
  try {
    if (summary.changes.length === 0) {
      deps.reporter.info("Nothing is left to delete on Cloudflare.");
      await discardPlan(summary);
      return undefined;
    }
    const problems = deletionPlanProblems(summary.changes, { confirmed });
    if (problems.notDeletes.length > 0 || problems.unconfirmed.length > 0) {
      throw new OpsCrewError(
        "PHASE_PRECONDITION",
        [
          problems.notDeletes.length > 0
            ? "The teardown plan would do more than delete, so OpsCrew stopped. Nothing was changed."
            : "The teardown plan now deletes resources that were not in the list you confirmed, so OpsCrew stopped. Nothing was deleted.",
          ...[...problems.notDeletes, ...problems.unconfirmed].map((item) => `  ${item}`),
        ].join("\n"),
        { hint: "Run `opscrew drift` to see what changed, then run `opscrew destroy` again." },
      );
    }
    cloudflareOnly(summary.changes, "Nothing was deleted.");
    const tunnel = deletesTunnel(summary.changes);
    const count = summary.changes.length;
    const approval = await deps.approvals.request({
      kind: "iac-apply",
      title: `Delete the Cloudflare Tunnel, DNS records and Access of ${name} (${plural(count, "resource")} to delete)`,
      details: [
        `${engineLabel(summary.engine.name)} ${summary.engine.version} destroy plan:`,
        ...describeChanges(summary.changes),
        !tunnel
          ? "Your Portainer is not part of this plan; the app is removed from it in the next step."
          : stackChanges
            ? `Your Portainer is not part of this plan. ${TUNNEL_AFTER_STACKS} so OpsCrew removes the app's stacks first (the next approval) and applies this plan once Cloudflare reports no active connections for the tunnel.`
            : `Your Portainer is not part of this plan. ${TUNNEL_AFTER_STACKS} so OpsCrew applies this plan once Cloudflare reports no active connections for the tunnel.`,
        PORTAINER_STAYS,
        `Plan hash: ${summary.planHash}`,
      ].join("\n"),
      planHash: summary.planHash,
      allowDestroy: true,
      confirmPhrase: name,
    });
    if (!approval.approved) {
      throw new OpsCrewError(
        "APPROVAL_REFUSED",
        `The teardown was not approved${approval.reason ? ` (${approval.reason})` : ""}. Nothing was deleted.`,
        { hint: `Run \`opscrew destroy\` again and type ${name} when you are ready.` },
      );
    }
    await deps.approvals.assertApprovedPlan(summary.planHash, { allowDestroy: true });
    return { summary, approval: approval as ApprovalRecord, tunnel };
  } catch (error) {
    await discardPlan(summary);
    throw error;
  }
}

/**
 * The plan JSON's `resource_changes` entries that delete a Cloudflare Tunnel, each one on its own
 * (`requireTunnelClosed` reads the tunnel's id and account from such an entry).
 */
function tunnelDeleteEntries(planJson: unknown): unknown[] {
  const list = (planJson as { resource_changes?: unknown } | null)?.resource_changes;
  if (!Array.isArray(list)) return [];
  return list.filter((entry) => {
    const change = entry as { type?: unknown; change?: { actions?: unknown } } | null;
    const actions = change?.change?.actions;
    return (
      change?.type === TUNNEL_RESOURCE_TYPE && Array.isArray(actions) && actions.includes("delete")
    );
  });
}

/**
 * Applies the approved Cloudflare part of the teardown and deletes its plan file. A plan that
 * deletes a tunnel runs after the app's stacks (and with them the connectors) are gone, and only
 * once Cloudflare reports no active connections for it; Cloudflare's error 1022 during the apply
 * becomes the same plain message.
 */
async function applyCloudflareRemoval(
  session: DeletionSession,
  removal: CloudflareRemoval,
  sleep: ((ms: number) => Promise<void>) | undefined,
): Promise<ResourceChange[]> {
  const { deps } = session;
  const { summary } = removal;
  try {
    const engine = tunnelSafeEngine(session.engine);
    // Every tunnel the plan deletes (the app's and the one in front of Portainer's webhook) must
    // report no active connections first, one after the other.
    for (const entry of tunnelDeleteEntries(summary.planJson)) {
      await requireTunnelClosed(
        deps,
        { planJson: { resource_changes: [entry] } },
        {
          command: COMMAND,
          already: STACKS_DONE_CLOUDFLARE_LEFT,
          ...(sleep !== undefined ? { options: { sleep } } : {}),
        },
      );
    }
    deps.reporter.step("Deleting the app's Cloudflare Tunnel, DNS records and Access");
    try {
      await applyApprovedPlan(removal.tunnel ? { ...session, engine } : session, summary, {
        allowDestroy: true,
        what: "deleting the Cloudflare resources",
        hint: `${STACKS_DONE_CLOUDFLARE_LEFT} Fix the cause shown above, then run \`opscrew destroy\` again to finish; it continues with what is left.`,
      });
    } catch (error) {
      if (!engine.refusedBusyTunnel) throw error;
      throw tunnelBusyError({
        command: COMMAND,
        reason: "refused",
        already: STACKS_DONE_CLOUDFLARE_LEFT,
        cause: error,
      });
    }
    deps.reporter.success(`Deleted ${plural(summary.changes.length, "Cloudflare resource")}.`);
    return summary.changes;
  } finally {
    await discardPlan(summary);
  }
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

/** Stops with what is known when a part of the teardown in Portainer failed (never an address). */
function stackApplyStopped(
  deps: PhaseDeps,
  error: unknown,
  afterFailure: string | undefined,
): unknown {
  if (afterFailure === undefined) return error;
  const facing = isUserFacingError(error);
  const message = facing
    ? error.message
    : `Changing your Portainer stopped: ${error instanceof Error ? error.message : String(error)}`;
  const hint = facing && error.hint ? `${error.hint} ${afterFailure}` : afterFailure;
  return new OpsCrewError(
    error instanceof OpsCrewError ? error.code : "COMMAND_FAILED",
    deps.redactor.redact(message),
    { hint: deps.redactor.redact(hint), cause: error },
  );
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
  return { plan, hash, approval: approval as ApprovalRecord };
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
    afterFailure?: string;
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
    throw stackApplyStopped(deps, error, input.afterFailure);
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

/** What still exists after the teardown in the user's Portainer, in plain English. */
function remainingInPortainer(input: {
  plan: DeployPlan;
  github: GitHubTarget;
  secretsRemoved: readonly string[];
  keptVolumes: readonly string[];
  removedApp: boolean;
}): string[] {
  const { plan, github } = input;
  const items = [
    "Your Portainer itself, its settings and every stack, volume and registry entry OpsCrew did not create: OpsCrew never changes them.",
    `${PORTAINER_HOST_NOTE} ${PORTAINER_BACKUPS_NOTE}`,
  ];
  if (input.keptVolumes.length > 0) {
    items.push(
      `The app's data in your Portainer: the volume${input.keptVolumes.length === 1 ? "" : "s"} ${list(input.keptVolumes)}. OpsCrew took no backup. To delete ${input.keptVolumes.length === 1 ? "it" : "them"} when you no longer need ${input.keptVolumes.length === 1 ? "it" : "them"}, run \`opscrew destroy --delete-data\` (you type ${plan.app.name} to confirm), or remove ${input.keptVolumes.length === 1 ? "it" : "them"} in Portainer (Volumes).`,
    );
  }
  if (!input.removedApp) return items;
  if (input.secretsRemoved.length === 0 && github.skipReason) {
    items.push(
      `The deploy secrets in GitHub Actions (${[...SECRET_NAMES].sort().join(", ")}): OpsCrew did not remove them because ${github.skipReason}. Delete them at ${secretsPage(github)}.`,
    );
  }
  const repo = github.owner && github.repo ? `${github.owner}/${github.repo}` : "<owner>/<repo>";
  items.push(
    `The opscrew-deploy branch of ${repo}, which holds the app's stack file. Delete it on GitHub (or with \`git push origin --delete opscrew-deploy\`) if you no longer need it.`,
    `The app's container images in GitHub's container registry (ghcr.io/${repo.toLowerCase()}). Delete them in the package settings on GitHub if you no longer need them.`,
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
  const statePath = join(deps.paths.files.tfstateDir, "prod.tfstate");
  // A state an earlier removal emptied (provision removes what a former setup created in
  // Cloudflare) holds nothing to delete.
  const hasState = (await nonEmpty(statePath)) && !(await stateHoldsNothing(statePath));
  const dir = join(deps.paths.root, plan.infra.dir);

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
    (hasState && plan.deployment.destroyedAt === undefined);
  const dataOnly = !removeApp && deleteData && record.volumes.length > 0;
  if (!removeApp && !dataOnly) throw nothingDeployed(plan);
  const root = portainerCloudflare(plan) ?? { appTunnel: false, webhook: false };
  if (removeApp && (root.appTunnel || root.webhook) && !hasState) throw stateNotHere(plan);
  const cloudflareState = removeApp && hasState;
  if (cloudflareState) {
    try {
      await readdir(dir);
    } catch {
      throw new OpsCrewError(
        "PHASE_PRECONDITION",
        `The infrastructure code (${plan.infra.dir}) is missing, so OpsCrew cannot plan the removal of the app's Cloudflare resources. Nothing was changed.`,
        {
          hint: `Check out the branch that contains ${plan.infra.dir} (OpsCrew added it with the pull request \`opscrew provision\` opened), then run \`opscrew destroy\` again.`,
        },
      );
    }
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
  const makeClient = portainerServices.client ?? portainerClient;
  const client = makeClient(
    {
      url: connection.url,
      ...(connection.certFingerprint !== undefined
        ? { certFingerprint: connection.certFingerprint }
        : {}),
    },
    token,
    { redactor: deps.redactor },
  );
  const target = plan.target.provider === "portainer" ? plan.target : undefined;
  deps.reporter.step("Inspecting your Portainer (read-only)");
  const facts = await inspectPortainer(client, {
    environmentId: target?.environmentId ?? connection.environmentId,
    names: opscrewStackNames(name),
  });
  await deps.audit.append({
    kind: "provider-call",
    actor: "opscrew",
    action: "inspect Portainer (read-only)",
    phase: "provision",
    target: `portainer environment ${connection.environmentId}`,
    decision: "allow",
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
    const { engine, env } = await setupEngine(deps, plan, options, statePath);
    // Portainer's address reaches the engine only as a sensitive variable, never in a file.
    const origin = portainerContainerUrl(connection.url);
    hidePortainerAddress(deps.redactor, origin);
    env.TF_VAR_portainer_origin = origin;
    session = {
      deps,
      // A Portainer root holds no server; "own" names none either (the checks look for one).
      provider: "own",
      app: name,
      command: COMMAND,
      what: "teardown",
      phase: "provision",
      engine,
      env,
      dir,
      stamp: deps.clock.now().toISOString().replace(/[:.]/g, "-"),
    };
    deps.reporter.step(
      "Planning the removal of the app's Cloudflare resources to see what it deletes",
    );
    const preview = await savePlan(session, "destroy-preview", { destroy: true });
    await discardPlan(preview);
    cloudflareOnly(preview.changes, "Nothing was changed.");
    resources = preview.changes;
    confirmed = new Set(preview.changes.map((change) => change.address));
  }
  const volumes = teardown.changes.find((change) => change.id === "volumes");
  const deletesData = volumes?.state === "change";
  const dataNames =
    deletesData && Array.isArray(volumes?.params.names) ? [...volumes.params.names] : [];
  const dataWarning = deletesData
    ? `Removing the app also deletes its data in your Portainer: the volume${dataNames.length === 1 ? "" : "s"} ${list(dataNames)}${plan.services.postgres ? " (with the PostgreSQL database)" : ""}. OpsCrew takes no backup of your Portainer host, so this cannot be undone unless you have your own backup.`
    : undefined;
  if (deleteData && !deletesData) {
    deps.reporter.info(
      "OpsCrew recorded no data volumes of this app in your Portainer, so `--delete-data` has nothing to delete.",
    );
  }
  const stacksFirst = deletesTunnel(resources) && stackWork.length > 0;
  const cloudflareLines =
    resources.length > 0
      ? [
          stacksFirst
            ? `and then deletes these Cloudflare resources (${TUNNEL_AFTER_STACKS} so they go last):`
            : "The teardown deletes these Cloudflare resources:",
          ...describeChanges(resources),
        ]
      : [];
  const stackLines =
    stackWork.length > 0
      ? [
          stacksFirst
            ? "The teardown removes from your Portainer:"
            : "and removes from your Portainer:",
          ...stackWork.map((change) => `  - ${change.title}`),
        ]
      : [];
  deps.reporter.info(
    [
      ...(stacksFirst || resources.length === 0
        ? [...stackLines, ...cloudflareLines]
        : [...cloudflareLines, ...stackLines]),
      ...(resources.length === 0 && stackWork.length === 0
        ? [
            "Nothing of the app is left in your Portainer or on Cloudflare; OpsCrew finishes the cleanup.",
          ]
        : []),
      PORTAINER_STAYS,
    ]
      .join("\n")
      .replace(/^and removes/, "The teardown removes"),
  );
  if (dataWarning !== undefined) deps.reporter.warn(dataWarning);
  else if (!deleteData && record.volumes.length > 0) {
    deps.reporter.info(
      `The app's data in your Portainer (the volume${record.volumes.length === 1 ? "" : "s"} ${list(record.volumes)}) is kept. To delete it as well, cancel now and run \`opscrew destroy --delete-data\`.`,
    );
  }
  if (options.confirm !== undefined && (resources.length > 0 || stackWork.length > 0)) {
    const preview: DestroyPreview = {
      name,
      confirmPrompt: destroyConfirmPrompt(name, "portainer"),
      provider: "portainer",
      deleteProtection: false,
      resources,
      snapshot: false,
      ...(dataWarning !== undefined ? { dataWarning } : {}),
      stackChanges: stackWork.map((change) => change.title),
    };
    const ok = await options.confirm(preview);
    await deps.audit.append({
      kind: "approval",
      actor: "user",
      action: "destroy-confirm",
      phase: "provision",
      target: name,
      decision: ok ? "approved" : "refused",
      detail: `typed confirmation for deleting ${plural(resources.length, "resource")} and ${plural(stackWork.length, "change")} in your Portainer`,
    });
    if (!ok) {
      throw new OpsCrewError(
        "APPROVAL_REFUSED",
        "The app name was not confirmed, so nothing was deleted and nothing was changed.",
        { hint: `Run \`${COMMAND}\` again and type ${name} when asked.` },
      );
    }
  }

  // 5–6. The Cloudflare resources (tunnel, DNS records, Access) and the app's stacks in Portainer.
  // Both are approved before anything changes. The stacks go first when the Cloudflare plan deletes
  // a tunnel (its connector runs in Portainer); that plan follows once the tunnel has no connections.
  let destroyed: ResourceChange[] = [];
  let removal: CloudflareRemoval | undefined;
  if (session !== undefined && resources.length > 0) {
    removal = await approveCloudflareRemoval(session, plan, confirmed, stackWork.length > 0);
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
      destroyedPlan(plan, at, [
        { record: removal?.approval, kind: "iac-apply" },
        { record: stackApproval, kind: "stack-apply" },
      ]),
    );
    await rm(join(deps.paths.projectHomeDir, "deploy_secrets.json"), { force: true });
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
  });
  deps.reporter.info(["What remains:", ...remaining.map((item) => `  - ${item}`)].join("\n"));
  return {
    destroyed,
    secretsRemoved,
    remaining,
    ...(stackHash !== undefined ? { stackPlan: stackHash } : {}),
  };
}
