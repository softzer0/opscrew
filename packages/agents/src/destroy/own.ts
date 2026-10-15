import { readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  applyHostPlan,
  type HostFacts,
  type HostPlan,
  HostPlanSchema,
  hostPlanHash,
  inspectHost,
  PORTAINER_PROJECT,
  planTeardown,
  planUndo,
} from "@opscrew/connector-ssh-host";
import type { ApprovalRecord, PlanSummary, RemoteExec, ResourceChange } from "@opscrew/contracts";
import { isUserFacingError, OpsCrewError, writeFileAtomic } from "@opscrew/core";
import { engineLabel } from "@opscrew/iac-engine";
import { DEPLOY_SECRETS, TUNNEL_DEPLOY_SECRETS, usesTunnel } from "@opscrew/iac-templates";
import { type DeployPlan, writeArtifact } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import {
  checkProvider,
  connectOwnServer,
  describeHostPlan,
  type HostAdapterApi,
  hostPlanFile,
  type OwnServerSession,
  ownEngineEnv,
  ownServerLoginCheck,
  ownTarget,
} from "../provision";
import { withoutOwnServer } from "../secure/own";
import { hasDeployment, recordServerAddress } from "../shared";
import {
  deletesTunnel,
  requireTunnelClosed,
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
import {
  applyApprovedPlan,
  type DeletionSession,
  discardPlan,
  previewDeletion,
  savePlan,
} from "./deletion";
import { destroyConfirmPrompt } from "./texts";
import type { DestroyOptions, DestroyPreview, DestroyResult } from "./types";

/** Said wherever the teardown of a server the user owns is described (FR-912, FR-913). */
const SERVER_STAYS =
  "Your server itself stays: OpsCrew never deletes, rebuilds or reinstalls it, and takes no snapshot of it. Backups are your responsibility.";

/** What the teardown on the user's server needs once connected. */
interface OwnHost {
  session: OwnServerSession;
  adapter: HostAdapterApi;
  verifyLogin: () => Promise<boolean>;
}

async function nonEmpty(file: string): Promise<boolean> {
  try {
    return (await stat(file)).size > 0;
  } catch {
    return false;
  }
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/**
 * Stops before anything changes when the server belongs to another OpsCrew app (its marker, or
 * its host record when the marker is gone): OpsCrew removes only what it set up for this app.
 */
function requireOwnApp(plan: DeployPlan, projectId: string, facts: HostFacts): void {
  const owner =
    facts.marker ??
    (facts.record === null ? null : { app: facts.record.app, projectId: facts.record.projectId });
  if (owner === null || owner.app === "") return;
  const same =
    owner.app === plan.app.name && (owner.projectId === "" || owner.projectId === projectId);
  if (same) return;
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    owner.app === plan.app.name
      ? `Your server runs an OpsCrew app named "${owner.app}" from another project, so OpsCrew removes nothing from it. Nothing was changed.`
      : `Your server runs the OpsCrew app "${owner.app}", not "${plan.app.name}", so OpsCrew removes nothing from it. Nothing was changed.`,
    {
      hint: "Run `opscrew destroy` in the project of that app, or check with `opscrew interview` that this project points at the right server.",
    },
  );
}

/** Stops (`PHASE_PRECONDITION`, nothing changed) when a teardown or undo plan cannot run. */
function requireNoHostBlockers(plan: HostPlan, what: string, already = ""): void {
  const blocked = plan.steps.filter((step) => step.state === "blocked");
  if (plan.findings.length === 0 && blocked.length === 0) return;
  const reasons =
    plan.findings.length > 0
      ? plan.findings.map((finding) => finding.message)
      : blocked.map((step) => `${step.title}: ${step.reason ?? "blocked"}`);
  const hints = [...new Set(plan.findings.map((finding) => finding.hint))];
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    `OpsCrew cannot ${what}, so it changed nothing on your server${already}:\n${reasons.map((reason) => `  - ${reason}`).join("\n")}`,
    {
      hint:
        hints.length > 0
          ? `${hints.join(" ")} Then run \`${COMMAND}\` again.`
          : `Fix what blocks these steps on the server, then run \`${COMMAND}\` again.`,
    },
  );
}

/** Cloudflare is the only provider in an own server's infrastructure; anything else stops. */
function notCloudflare(changes: readonly ResourceChange[]): string[] {
  return changes
    .filter((change) => !change.type.startsWith("cloudflare_"))
    .map((change) => change.address);
}

function cloudflareOnly(changes: readonly ResourceChange[], note: string): void {
  const others = notCloudflare(changes);
  if (others.length === 0) return;
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    [
      `The teardown plan would delete resources other than the app's Cloudflare DNS records, tunnel and Access, so OpsCrew stopped. ${note}`,
      ...others.map((address) => `  ${address}`),
    ].join("\n"),
    {
      hint: "Run `opscrew drift` to see what changed in the infrastructure code, then run `opscrew destroy` again.",
    },
  );
}

/** What the Cloudflare part deletes, in words: DNS records, or the tunnel with its records and Access. */
function cloudflareWhat(plan: DeployPlan): string {
  return usesTunnel(plan)
    ? "Cloudflare Tunnel, its DNS records and Access"
    : "DNS records on Cloudflare";
}

/** The Cloudflare part of the teardown, planned and approved but not applied yet. */
interface CloudflareRemoval {
  summary: PlanSummary;
  approval: ApprovalRecord;
  /** The plan deletes the app's Cloudflare Tunnel: it is applied after the app is off the server. */
  tunnel: boolean;
}

/** Why the tunnel goes last, said in the approval and the summary. */
const TUNNEL_AFTER_SERVER =
  "Cloudflare deletes a tunnel only after its connector on your server has stopped,";

/** Said when the app is off the server and its Cloudflare resources are not deleted yet. */
const SERVER_DONE_CLOUDFLARE_LEFT =
  "The app is removed from your server; its Cloudflare resources are still there.";

/**
 * The Cloudflare part of the teardown, up to its approval: a destroy plan that may only delete
 * Cloudflare resources the user confirmed, approved with `allowDestroy` and the typed app name.
 * `undefined` (its plan file deleted) when nothing is left to delete; on any stop the plan file is
 * deleted too. {@link applyCloudflareRemoval} applies it and always deletes the plan file.
 */
async function approveCloudflareRemoval(
  session: DeletionSession,
  plan: DeployPlan,
  confirmed: ReadonlySet<string>,
  hostChanges: boolean,
): Promise<CloudflareRemoval | undefined> {
  const { deps } = session;
  const name = plan.app.name;
  deps.reporter.step(`Planning the removal of the app's ${cloudflareWhat(plan)}`);
  const summary = await savePlan(session, "destroy", { destroy: true });
  try {
    if (summary.changes.length === 0) {
      deps.reporter.info("Nothing is left to delete on Cloudflare.");
      await discardPlan(summary);
      return undefined;
    }
    const problems = deletionPlanProblems(summary.changes, { confirmed });
    if (problems.notDeletes.length > 0) {
      throw new OpsCrewError(
        "PHASE_PRECONDITION",
        [
          "The teardown plan would do more than delete, so OpsCrew stopped. Nothing was changed.",
          ...problems.notDeletes.map((p) => `  ${p}`),
        ].join("\n"),
        { hint: "Run `opscrew drift` to see what changed, then run `opscrew destroy` again." },
      );
    }
    if (problems.unconfirmed.length > 0) {
      throw new OpsCrewError(
        "PHASE_PRECONDITION",
        [
          "The teardown plan now deletes resources that were not in the list you confirmed, so OpsCrew stopped. Nothing was deleted.",
          ...problems.unconfirmed.map((address) => `  ${address}`),
        ].join("\n"),
        { hint: "Run `opscrew destroy` again to see the current list and confirm it." },
      );
    }
    cloudflareOnly(summary.changes, "Nothing was deleted.");
    const tunnel = deletesTunnel(summary.changes);
    const count = summary.changes.length;
    const approval = await deps.approvals.request({
      kind: "iac-apply",
      title: `Delete the ${cloudflareWhat(plan)} of ${name} (${plural(count, "resource")} to delete)`,
      details: [
        `${engineLabel(summary.engine.name)} ${summary.engine.version} destroy plan:`,
        ...describeChanges(summary.changes),
        !tunnel
          ? "Your server is not part of this plan; the app is removed from it in the next step."
          : hostChanges
            ? `Your server is not part of this plan. ${TUNNEL_AFTER_SERVER} so OpsCrew removes the app from your server first (the next approval) and applies this plan after that.`
            : `Your server is not part of this plan. ${TUNNEL_AFTER_SERVER} so OpsCrew applies this plan once Cloudflare reports no active connections for the tunnel.`,
        SERVER_STAYS,
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
 * Applies the approved Cloudflare part of the teardown and deletes its plan file. A plan that
 * deletes the tunnel runs after the app is off the server, and only once Cloudflare reports no
 * active connections for the tunnel (read-only polls, up to 3 minutes); if they stay open it stops
 * before the apply, and Cloudflare's error 1022 during the apply becomes the same plain message.
 */
async function applyCloudflareRemoval(
  session: DeletionSession,
  plan: DeployPlan,
  removal: CloudflareRemoval,
  sleep: ((ms: number) => Promise<void>) | undefined,
): Promise<ResourceChange[]> {
  const { deps } = session;
  const { summary } = removal;
  try {
    const engine = tunnelSafeEngine(session.engine);
    if (removal.tunnel) {
      await requireTunnelClosed(deps, summary, {
        command: COMMAND,
        already: SERVER_DONE_CLOUDFLARE_LEFT,
        ...(sleep !== undefined ? { options: { sleep } } : {}),
      });
    }
    deps.reporter.step(`Deleting the ${cloudflareWhat(plan)}`);
    try {
      await applyApprovedPlan(removal.tunnel ? { ...session, engine } : session, summary, {
        allowDestroy: true,
        what: "deleting the Cloudflare resources",
        hint: removal.tunnel
          ? `${SERVER_DONE_CLOUDFLARE_LEFT} Fix the cause shown above, then run \`opscrew destroy\` again to finish; it continues with what is left.`
          : "Fix the cause shown above, then run `opscrew destroy` again; it continues with what is left.",
      });
    } catch (error) {
      if (!engine.refusedBusyTunnel) throw error;
      throw tunnelBusyError({
        command: COMMAND,
        reason: "refused",
        already: SERVER_DONE_CLOUDFLARE_LEFT,
        cause: error,
      });
    }
    deps.reporter.success(`Deleted ${plural(summary.changes.length, "Cloudflare resource")}.`);
    return summary.changes;
  } finally {
    await discardPlan(summary);
  }
}

/**
 * Saves a teardown or undo host plan as `.opscrew/plans/host-<hash>.json`, asks for its own
 * `host-apply` approval by that hash, checks the approval, and applies it through the host adapter
 * (which refuses any other plan and calls `verifyLogin` around SSH and firewall changes). Every
 * step is audited by the plan's hash, never with the server's address.
 */
async function applyHostPlanApproved(
  deps: PhaseDeps,
  host: OwnHost,
  plan: HostPlan,
  request: {
    title: string;
    intro: readonly string[];
    allowDestroy: boolean;
    confirmPhrase?: string;
    refused: string;
    /** Added to the hint when the apply fails, saying what already happened before it. */
    afterFailure?: string;
  },
): Promise<{ hash: string; approval: ApprovalRecord; applied: string[] }> {
  const hash = hostPlanHash(plan);
  await writeFileAtomic(hostPlanFile(deps.paths, hash), `${JSON.stringify(plan, null, 2)}\n`);
  const details = [...request.intro, describeHostPlan(plan, hash)].join("\n");
  deps.reporter.info(details);
  const approval = await deps.approvals.request({
    kind: "host-apply",
    title: request.title,
    details,
    planHash: hash,
    ...(request.allowDestroy ? { allowDestroy: true } : {}),
    ...(request.confirmPhrase !== undefined ? { confirmPhrase: request.confirmPhrase } : {}),
  });
  if (!approval.approved) {
    throw new OpsCrewError(
      "APPROVAL_REFUSED",
      `${request.refused}${approval.reason ? ` (${approval.reason})` : ""}`,
      { hint: `Run \`${COMMAND}\` again when you are ready; it shows the plan again.` },
    );
  }
  await deps.approvals.assertApprovedHostPlan(hash, { allowDestroy: request.allowDestroy });
  const changes = plan.steps.filter((step) => step.state === "change").map((step) => step.id);
  await deps.audit.append({
    kind: "remote-exec",
    actor: "opscrew",
    action: `host ${plan.purpose} started`,
    phase: "provision",
    target: hash,
    decision: "approved",
    detail: `steps to change: ${changes.join(", ")}`,
  });
  let applied: string[];
  try {
    const result = await host.adapter.apply(host.session.remote, plan, {
      approvedHash: hash,
      verifyLogin: host.verifyLogin,
      ...(/^[0-9A-Za-z.+-]{1,64}$/.test(deps.version) ? { version: deps.version } : {}),
      now: () => deps.clock.now(),
    });
    applied = result.applied;
  } catch (error) {
    await deps.audit.append({
      kind: "remote-exec",
      actor: "opscrew",
      action: `host ${plan.purpose} failed`,
      phase: "provision",
      target: hash,
      decision: "refused",
      detail:
        "/etc/opscrew/host.json on the server lists what OpsCrew changed; the next run shows what is left",
    });
    if (request.afterFailure === undefined) throw error;
    // Say what already happened (redacted, and never the server's address).
    const say = (text: string) =>
      withoutOwnServer(deps.redactor.redact(text), ownServerNames(host.session));
    const facing = isUserFacingError(error);
    const message = facing
      ? error.message
      : `Changing your server stopped: ${error instanceof Error ? error.message : String(error)}`;
    const earlier = facing ? error.hint : undefined;
    throw new OpsCrewError(
      error instanceof OpsCrewError ? error.code : "COMMAND_FAILED",
      say(message),
      {
        hint: say(earlier ? `${earlier} ${request.afterFailure}` : request.afterFailure),
        cause: error,
      },
    );
  }
  for (const id of applied) {
    const step = plan.steps.find((item) => item.id === id);
    await deps.audit.append({
      kind: "remote-exec",
      actor: "opscrew",
      action: `host ${plan.purpose} step ${id}`,
      phase: "provision",
      target: hash,
      decision: "approved",
      ...(step !== undefined ? { detail: step.title } : {}),
    });
  }
  return { hash, approval: approval as ApprovalRecord, applied };
}

/**
 * The purpose (`setup`, `teardown` or `undo`) of the host plan saved as
 * `.opscrew/plans/host-<hash>.json`, or `undefined` when no valid plan with exactly that hash is
 * there. Lets an approval handler tell the undo host plan from the teardown, which ask for the same
 * typed app name but are approved separately.
 */
export async function savedHostPlanPurpose(
  paths: Pick<PhaseDeps["paths"], "files">,
  hash: string | undefined,
): Promise<HostPlan["purpose"] | undefined> {
  if (hash === undefined || !/^[0-9a-f]{64}$/.test(hash)) return undefined;
  try {
    const parsed = HostPlanSchema.safeParse(
      JSON.parse(await readFile(hostPlanFile(paths, hash), "utf8")),
    );
    if (!parsed.success || hostPlanHash(parsed.data) !== hash) return undefined;
    return parsed.data.purpose;
  } catch {
    return undefined;
  }
}

/** The server's address and host names as OpsCrew knows them (kept out of errors). */
function ownServerNames(session: Pick<OwnServerSession, "connection">): string[] {
  const { host, publicIpv4, publicIpv6 } = session.connection;
  return [host, publicIpv4, publicIpv6].filter(
    (name): name is string => name !== undefined && name !== "",
  );
}

/** True when app data is on the server: files in /srv/data or a Docker volume of the app. */
function hasAppData(facts: HostFacts, app: string): boolean {
  const data = facts.dirs.find((dir) => dir.path === "/srv/data");
  return (data?.entries ?? 0) > 0 || facts.volumeProjects.includes(app);
}

/** What is deleted with `deleteData`, for the warning shown before the typed confirmation. */
function dataLoss(plan: DeployPlan, facts: HostFacts): string {
  const lost: string[] = [];
  if (plan.services.postgres) lost.push("the PostgreSQL database");
  if (plan.services.redis) lost.push("the Redis data");
  lost.push("everything the app stored in /srv/data and in its Docker volumes");
  if (facts.portainer.dataVolume) lost.push("Portainer's data");
  const list =
    lost.length <= 1 ? lost.join("") : `${lost.slice(0, -1).join(", ")} and ${lost.at(-1)}`;
  return `Removing the app also deletes its data on your server: ${list}. OpsCrew takes no snapshot of your own server, so this cannot be undone unless you have your own backup.`;
}

/** `docker volume rm` for every volume of the Compose project `project`. */
function volumeRm(project: string): string {
  return `\`docker volume rm $(docker volume ls -q --filter label=com.docker.compose.project=${project})\``;
}

/**
 * Exactly which data stays on the server after a teardown without `deleteData` (the data
 * directory, the app's Compose volumes, Portainer's volumes) and the commands that remove it, or
 * `undefined` when there is none.
 */
function keptData(facts: HostFacts, app: string): string | undefined {
  const parts: string[] = [];
  const commands: string[] = [];
  if ((facts.dirs.find((dir) => dir.path === "/srv/data")?.entries ?? 0) > 0) {
    parts.push("the directory /srv/data");
    commands.push("`rm -rf /srv/data`");
  }
  if (facts.volumeProjects.includes(app)) {
    parts.push(`the Docker volumes of the Compose project "${app}"`);
    commands.push(volumeRm(app));
  }
  if (facts.portainer.dataVolume || facts.volumeProjects.includes(PORTAINER_PROJECT)) {
    parts.push(
      `Portainer's data (the Docker volumes of the Compose project "${PORTAINER_PROJECT}")`,
    );
    commands.push(volumeRm(PORTAINER_PROJECT));
  }
  if (parts.length === 0) return undefined;
  return `The app's data stays on your server: ${parts.join(", ")}. OpsCrew took no snapshot. To remove it yourself when you no longer need it, run as root on the server: ${commands.join(" and ")}.`;
}

/**
 * Refuses `deleteData` when the app's data is on the server but no teardown would delete it: the
 * app was removed before (`removedBefore`), or nothing of it is left for the teardown to remove
 * (OpsCrew deletes an app's data only together with the app). Says which data stays and how to
 * remove it by hand (`kept`, see {@link keptData}). Nothing has changed when it is thrown.
 */
function dataNotDeletable(name: string, kept: string, removedBefore: boolean): OpsCrewError {
  return new OpsCrewError(
    "PHASE_PRECONDITION",
    removedBefore
      ? `OpsCrew cannot delete the app's data: ${name} was removed from your server before (opscrew/plan.yaml records when), and OpsCrew deletes an app's data only in the teardown that removes the app, so a new \`opscrew destroy\` cannot delete it. Nothing was changed.`
      : `OpsCrew cannot delete the app's data: nothing of ${name} is left on your server for the teardown to remove (no containers, no runtime files), and OpsCrew deletes an app's data only together with the app. Nothing was changed.`,
    {
      hint: `${kept} ${
        removedBefore
          ? "Then run `opscrew destroy --undo-host` without `--delete-data` to undo OpsCrew's host changes."
          : "Then run `opscrew destroy` again without `--delete-data`."
      }`,
    },
  );
}

/** What still exists after the teardown of a server the user owns, in plain English. */
function remainingOnOwnServer(input: {
  plan: DeployPlan;
  github: GitHubTarget;
  secretsRemoved: readonly string[];
  secretNames: readonly string[];
  /** What data stays on the server and how to remove it (see {@link keptData}). */
  keptData: string | undefined;
  undone: boolean;
  removedApp: boolean;
}): string[] {
  const { plan, github } = input;
  const items = [
    "Your server itself: OpsCrew never deletes, rebuilds or reinstalls it, and took no snapshot. Backups of anything on it are your responsibility.",
  ];
  items.push(
    input.undone
      ? "Docker stays installed on your server, because other software may use it; remove it yourself with apt if you no longer need it."
      : "OpsCrew's host setup on your server (Docker, the deploy user, SSH hardening, the firewall rules, fail2ban and automatic updates). `opscrew destroy --undo-host` reverses OpsCrew's changes and leaves Docker installed.",
  );
  if (input.keptData !== undefined) items.push(input.keptData);
  if (!input.removedApp) return items;
  if (input.secretsRemoved.length === 0 && github.skipReason) {
    items.push(
      `The deploy secrets in GitHub Actions (${[...input.secretNames].sort().join(", ")}): OpsCrew did not remove them because ${github.skipReason}. Delete them at ${secretsPage(github)}.`,
    );
  }
  const image =
    github.owner && github.repo
      ? `ghcr.io/${github.owner}/${github.repo}`.toLowerCase()
      : "ghcr.io/<owner>/<repo>";
  items.push(
    `The app's container images in GitHub's container registry (${image}). Delete them in the package settings on GitHub if you no longer need them.`,
    `The deployment files in the repository (opscrew/ and ${plan.cicd.workflowPath}). Pushes still build an image, but the deploy step fails until \`opscrew provision\` prepares your server again from these files.`,
    "How OpsCrew reaches your server (.opscrew/server.json) with its confirmed host key, and the project's SSH deploy key on this computer, kept so a new deployment can reuse them.",
  );
  return items;
}

/**
 * `opscrew destroy` for a server the user owns (FR-912). It never deletes, rebuilds, reinstalls or
 * snapshots the server. In order, each step only after the one before succeeded: preconditions →
 * credentials (the recorded SSH login; Cloudflare when the plan uses it; GitHub optional) →
 * connect with the pinned host key and inspect the server read-only (a server of another OpsCrew
 * app stops everything) → the Cloudflare destroy preview and the teardown host plan, both checked
 * before anything changes, shown, and confirmed once with the typed app name → the Cloudflare
 * destroy plan (`iac-apply`, `allowDestroy` + typed app name) → the teardown host plan
 * (`host-apply`, `allowDestroy` + typed app name: the app's containers, runtime files, the tunnel
 * connector, Portainer and the marker; the app's data only with `deleteData`). When the Cloudflare
 * plan deletes the tunnel, both are approved first, then the teardown is applied, then OpsCrew
 * waits until Cloudflare reports no active connections for the tunnel (it refuses to delete one
 * that has them) and only then applies the Cloudflare plan → the deploy secrets
 * (tunnel ones included) and OpsCrew's local record of the deployment. With `undoHost`, the undo
 * host plan follows as a separate `host-apply` approval; it also runs alone after an earlier
 * destroy. A refusal or failure leaves everything after it untouched; running it again continues.
 */
export async function destroyOwnServer(
  deps: PhaseDeps,
  plan: DeployPlan,
  options: DestroyOptions,
): Promise<DestroyResult> {
  const services = options.services ?? {};
  const own = services.own ?? {};
  const name = plan.app.name;
  const deleteData = options.deleteData === true;
  const statePath = join(deps.paths.files.tfstateDir, "prod.tfstate");
  const hasState = await nonEmpty(statePath);
  // A finished teardown records `destroyedAt`; an interrupted one does not, so it continues.
  const removeApp = hasDeployment(plan) || (hasState && plan.deployment.destroyedAt === undefined);
  if (!removeApp && options.undoHost !== true) throw nothingDeployed(plan);
  const dir = join(deps.paths.root, plan.infra.dir);

  // 1. Preconditions: the state of the Cloudflare resources (when the plan has any) and the
  // infrastructure code that matches it. Without the state OpsCrew cannot remove the DNS records or
  // the tunnel, so it changes nothing, not even on the server.
  const managesCloudflare = plan.dns.provider === "cloudflare" || usesTunnel(plan);
  if (removeApp && managesCloudflare && !hasState) throw stateNotHere(plan);
  if (removeApp && hasState) {
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
  const cloudflare = removeApp && hasState && plan.dns.provider === "cloudflare";
  deps.reporter.step(
    `Checking the login to your server${cloudflare ? ", your Cloudflare access" : ""}${removeApp ? " and GitHub access" : ""}`,
  );
  await checkProvider(deps, "own", services);
  if (cloudflare) await checkCloudflare(deps, plan, services);
  const github: GitHubTarget = removeApp ? await resolveGitHub(deps, services) : {};
  if (removeApp && github.skipReason) {
    deps.reporter.warn(
      `OpsCrew cannot remove the deploy secrets from GitHub Actions: ${github.skipReason}. The teardown continues; delete them yourself afterwards at ${secretsPage(github)}.`,
    );
  }

  // 3. Connect (pinned host key) and inspect (read-only); never another app's server
  deps.reporter.step("Connecting to your server");
  const session = await connectOwnServer(deps, {
    ...(options.hostKey !== undefined ? { hostKey: options.hostKey } : {}),
    ...(own.remote !== undefined ? { remote: own.remote } : {}),
    ...(own.homeDir !== undefined ? { homeDir: own.homeDir } : {}),
  });
  const adapter: HostAdapterApi = {
    inspect: (remote: RemoteExec) =>
      own.host?.inspect ? own.host.inspect(remote) : inspectHost(remote),
    apply: (remote, hostPlan, applyOptions) =>
      own.host?.apply
        ? own.host.apply(remote, hostPlan, applyOptions)
        : applyHostPlan(remote, hostPlan, applyOptions),
  };
  const host: OwnHost = {
    session,
    adapter,
    verifyLogin:
      own.verifyLogin ??
      ownServerLoginCheck(deps, session, {
        deployKeyFile: deps.paths.files.deployKey,
        ...(own.homeDir !== undefined ? { homeDir: own.homeDir } : {}),
      }),
  };
  const inspect = async () => {
    deps.reporter.step("Inspecting your server (read-only)");
    const found = await adapter.inspect(session.remote);
    await deps.audit.append({
      kind: "remote-exec",
      actor: "opscrew",
      action: "inspect host (read-only)",
      phase: "provision",
      target: "own server",
      decision: "allow",
      detail: "destroy",
    });
    return found;
  };
  const facts = await inspect();
  requireOwnApp(plan, deps.paths.projectId, facts);

  // 4. What the teardown removes: checked before anything changes, shown, confirmed once
  let iac: DeletionSession | undefined;
  let resources: ResourceChange[] = [];
  let confirmed: ReadonlySet<string> = new Set();
  if (removeApp && hasState) {
    const { engine, env } = await setupEngine(deps, plan, options, statePath);
    // The server's address reaches the engine only as TF_VAR_* (FR-902).
    await ownEngineEnv(deps, { target: ownTarget(plan) }, env, () =>
      engine.output(dir, { env }).catch(() => undefined),
    );
    iac = {
      deps,
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
    deps.reporter.step(`Planning the removal of the app's ${cloudflareWhat(plan)}`);
    const preview = await previewDeletion(iac, { suffix: "destroy-preview", destroy: true });
    cloudflareOnly(preview.changes, "Nothing was changed.");
    resources = preview.changes;
    confirmed = preview.addresses;
  }
  // Without the marker (deleted on the server) the record or the plan names the app (T931).
  const teardown = removeApp ? planTeardown(facts, { deleteData, app: name }) : undefined;
  if (teardown !== undefined) requireNoHostBlockers(teardown, `remove ${name} from your server`);
  const hostSteps = (teardown?.steps ?? []).filter((step) => step.state === "change");
  // The teardown deletes the app's data (with `deleteData`) in its step that removes the app.
  const deletesData =
    deleteData &&
    (teardown?.steps ?? []).some((step) => step.id === "runtime-dirs" && step.state === "change");
  const kept = keptData(facts, name);
  if (deleteData && kept !== undefined) {
    // Never a `--delete-data` that silently keeps the data (Constitution IX).
    if (!removeApp) throw dataNotDeletable(name, kept, true);
    if (hasAppData(facts, name) && !deletesData) throw dataNotDeletable(name, kept, false);
  } else if (deleteData && !removeApp) {
    deps.reporter.info(
      "None of the app's data is left on your server, so `--delete-data` has nothing to delete.",
    );
  }
  const dataWarning = deleteData && hasAppData(facts, name) ? dataLoss(plan, facts) : undefined;
  if (removeApp) {
    // Cloudflare deletes a tunnel only once its connector is gone: then the server goes first.
    const serverFirst = deletesTunnel(resources) && hostSteps.length > 0;
    const cloudflareLines =
      resources.length > 0
        ? [
            serverFirst
              ? `and then deletes these Cloudflare resources (${TUNNEL_AFTER_SERVER} so they go last):`
              : "The teardown deletes these Cloudflare resources:",
            ...describeChanges(resources),
          ]
        : [];
    const hostLines =
      hostSteps.length > 0
        ? [
            serverFirst
              ? "The teardown removes from your server:"
              : "and removes from your server:",
            ...hostSteps.map((step) => `  - ${step.title}`),
          ]
        : [];
    deps.reporter.info(
      [
        ...(serverFirst ? [...hostLines, ...cloudflareLines] : [...cloudflareLines, ...hostLines]),
        ...(resources.length === 0 && hostSteps.length === 0
          ? [
              "Nothing of the app is left on Cloudflare or your server; OpsCrew finishes the cleanup.",
            ]
          : []),
        SERVER_STAYS,
      ].join("\n"),
    );
    if (dataWarning !== undefined) deps.reporter.warn(dataWarning);
    else if (hasAppData(facts, name)) {
      // `--delete-data` works only while the teardown still removes the app's runtime (its marker
      // is there); after that OpsCrew no longer knows the data as the app's.
      const canDelete =
        plan.deployment.destroyedAt === undefined &&
        (teardown?.steps ?? []).some((step) => step.id === "runtime-dirs");
      deps.reporter.info(
        canDelete
          ? "The app's data on your server (/srv/data and its Docker volumes) is kept. To delete the data as well, cancel now and run `opscrew destroy --delete-data`."
          : "The app's data on your server (/srv/data and its Docker volumes) is kept.",
      );
    }
    if (options.confirm !== undefined && (resources.length > 0 || hostSteps.length > 0)) {
      const preview: DestroyPreview = {
        name,
        confirmPrompt: destroyConfirmPrompt(name, "own"),
        provider: "own",
        deleteProtection: false,
        resources,
        snapshot: false,
        ...(dataWarning !== undefined ? { dataWarning } : {}),
        hostSteps: hostSteps.map((step) => step.title),
      };
      const ok = await options.confirm(preview);
      await deps.audit.append({
        kind: "approval",
        actor: "user",
        action: "destroy-confirm",
        phase: "provision",
        target: name,
        decision: ok ? "approved" : "refused",
        detail: `typed confirmation for deleting ${plural(resources.length, "resource")} and ${plural(hostSteps.length, "change")} on your server`,
      });
      if (!ok) {
        throw new OpsCrewError(
          "APPROVAL_REFUSED",
          "The app name was not confirmed, so nothing was deleted and nothing was changed.",
          { hint: `Run \`${COMMAND}\` again and type ${name} when asked.` },
        );
      }
    }
  }

  // 5–6. The Cloudflare resources (DNS records, tunnel, Access) and the app on the server (teardown
  // host plan). Both are approved before anything changes. Cloudflare first, unless its plan
  // deletes the tunnel: Cloudflare refuses that while the connector on the server still runs, so
  // then the server goes first and the Cloudflare plan follows once the tunnel has no connections.
  let destroyed: ResourceChange[] = [];
  let removal: CloudflareRemoval | undefined;
  if (iac !== undefined && resources.length > 0) {
    removal = await approveCloudflareRemoval(iac, plan, confirmed, hostSteps.length > 0);
  }
  const iacApproval = removal?.approval;
  const hostPlans: { teardown?: string; undo?: string } = {};
  let teardownApproval: ApprovalRecord | undefined;
  try {
    if (iac !== undefined && removal !== undefined && !removal.tunnel) {
      destroyed = await applyCloudflareRemoval(iac, plan, removal, services.sleep);
    }
    if (teardown !== undefined && hostSteps.length > 0) {
      const serverFirst = removal?.tunnel === true;
      const already = serverFirst
        ? " and nothing in Cloudflare was deleted"
        : destroyed.length > 0
          ? ". The app's Cloudflare resources are deleted already"
          : "";
      const afterFailure = serverFirst
        ? "Nothing in Cloudflare was deleted yet (the tunnel goes only after the app is off your server). Run `opscrew destroy` again to finish."
        : destroyed.length > 0
          ? "The app's Cloudflare resources are deleted already; the app is still on your server. Run `opscrew destroy` again to finish."
          : undefined;
      const result = await applyHostPlanApproved(deps, host, teardown, {
        title: `Remove ${name} from your server (${plural(hostSteps.length, "change")})`,
        intro: [
          deleteData
            ? `This removes ${name} from your server, including its data.`
            : `This removes ${name} from your server; its data in /srv/data and its Docker volumes stay.`,
          ...(dataWarning !== undefined ? [dataWarning] : []),
          ...(serverFirst
            ? [
                `${TUNNEL_AFTER_SERVER} so this goes first; the approved Cloudflare plan follows once Cloudflare reports no active connections for the tunnel.`,
              ]
            : []),
          SERVER_STAYS,
        ],
        allowDestroy: true,
        confirmPhrase: name,
        refused: `The removal of ${name} from your server was not approved, so nothing on your server was changed${already}.`,
        ...(afterFailure !== undefined ? { afterFailure } : {}),
      });
      hostPlans.teardown = result.hash;
      teardownApproval = result.approval;
      deps.reporter.success(
        `Removed ${name} from your server (${plural(result.applied.length, "change")}).`,
      );
    }
    if (iac !== undefined && removal?.tunnel === true) {
      destroyed = await applyCloudflareRemoval(iac, plan, removal, services.sleep);
    }
  } finally {
    // Never left behind for a later apply (applyCloudflareRemoval deletes it, too).
    if (removal !== undefined) await discardPlan(removal.summary);
  }

  // 7. Deploy secrets (tunnel ones included) and OpsCrew's record of the deployment
  const secretNames = [...Object.values(DEPLOY_SECRETS), ...Object.values(TUNNEL_DEPLOY_SECRETS)];
  let secretsRemoved: string[] = [];
  let current = plan;
  if (removeApp) {
    secretsRemoved = await removeDeploySecrets(deps, github, {
      names: secretNames,
      done: "The app is removed from your server and Cloudflare.",
      reach: "your server",
    });
    const at = deps.clock.now().toISOString();
    current = destroyedPlan(plan, at, [
      { record: iacApproval, kind: "iac-apply" },
      { record: teardownApproval, kind: "host-apply" },
    ]);
    await writeArtifact("plan", deps.paths.files.plan, current);
    // The address DNS pointed at; the login and the confirmed host key stay (the server stays).
    await recordServerAddress(deps.paths, undefined);
    await rm(join(deps.paths.projectHomeDir, "deploy_secrets.json"), { force: true });
    await deps.state.markPhase("provision", "skipped", "app removed from your server");
    await deps.audit.append({
      kind: "phase",
      actor: "opscrew",
      action: "destroy",
      phase: "provision",
      target: name,
      detail: `app removed: ${plural(destroyed.length, "Cloudflare resource")} deleted, ${plural(hostSteps.length, "change")} on the server, ${plural(secretsRemoved.length, "deploy secret")} removed${deleteData ? ", app data deleted" : ", app data kept"}; the server itself stays`,
    });
    deps.reporter.success(
      `${name} is removed. Your server stays as it is otherwise; opscrew/plan.yaml records when.`,
    );
  }

  // 8. --undo-host: reverse OpsCrew's own host changes, as a separate approved plan
  let undone = false;
  if (options.undoHost === true) {
    const after = removeApp && hostSteps.length > 0 ? await inspect() : facts;
    requireOwnApp(plan, deps.paths.projectId, after);
    const undo = planUndo(after);
    requireNoHostBlockers(
      undo,
      "undo its changes to your server",
      removeApp ? ` (the app itself is removed already)` : "",
    );
    const undoSteps = undo.steps.filter((step) => step.state === "change");
    if (undoSteps.length === 0) {
      // An undo removes OpsCrew's record last, so a missing record usually means it ran before.
      deps.reporter.info(
        after.record === null
          ? "OpsCrew's record of its changes (/etc/opscrew/host.json) is not on your server, so there is nothing for OpsCrew to undo."
          : "OpsCrew's changes to your server are undone already.",
      );
      undone = true;
    } else {
      // The undo deletes what OpsCrew created (the deploy user and its home directory, packages
      // it installed): a destroy, so it needs allowDestroy and the typed app name (Constitution I).
      const deletesDeployUser = undoSteps.some((step) => step.id === "deploy-user");
      const result = await applyHostPlanApproved(deps, host, undo, {
        title: `Undo OpsCrew's changes to your server (${plural(undoSteps.length, "change")})`,
        intro: [
          "This reverses what OpsCrew changed on your server, from its record in /etc/opscrew/host.json, and leaves alone anything OpsCrew did not install. Docker stays installed (other software may use it).",
          ...(deletesDeployUser
            ? [
                "It deletes the deploy user OpsCrew created and its home directory with everything in it; this cannot be undone.",
              ]
            : []),
          `SSH and firewall changes are undone under a safety switch: the server puts them back on its own unless new logins as deploy and as ${session.connection.user} still work afterwards.`,
          SERVER_STAYS,
        ],
        allowDestroy: true,
        confirmPhrase: name,
        refused: removeApp
          ? `Undoing OpsCrew's changes to your server was not approved. ${name} is removed; OpsCrew's host setup stays.`
          : "Undoing OpsCrew's changes to your server was not approved, so nothing on your server was changed.",
      });
      hostPlans.undo = result.hash;
      current = {
        ...current,
        approvals: [
          ...current.approvals,
          {
            planHash: result.hash,
            approver: result.approval.approver,
            at: result.approval.decidedAt,
            kind: "host-apply",
          },
        ],
      };
      await writeArtifact("plan", deps.paths.files.plan, current);
      undone = true;
      deps.reporter.success(
        `Undid OpsCrew's changes to your server (${plural(result.applied.length, "change")}).`,
      );
    }
  }

  // 9. What remains
  const remaining = remainingOnOwnServer({
    plan,
    github,
    secretsRemoved,
    secretNames,
    // Read before the teardown, which deletes it only with `deleteData` and only when it ran.
    keptData: deletesData && hostPlans.teardown !== undefined ? undefined : kept,
    undone,
    removedApp: removeApp,
  });
  deps.reporter.info(["What remains:", ...remaining.map((item) => `  - ${item}`)].join("\n"));
  return {
    destroyed,
    secretsRemoved,
    remaining,
    ...(hostPlans.teardown !== undefined || hostPlans.undo !== undefined ? { hostPlans } : {}),
  };
}
