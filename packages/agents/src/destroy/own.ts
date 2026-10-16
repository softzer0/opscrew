import { readFile, rm } from "node:fs/promises";
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
import type { ApprovalRecord, RemoteExec, ResourceChange } from "@opscrew/contracts";
import { listText, OpsCrewError, plural, replaceNames, writeFileAtomic } from "@opscrew/core";
import { DEPLOY_SECRETS, TUNNEL_DEPLOY_SECRETS, usesTunnel } from "@opscrew/iac-templates";
import { type DeployPlan, writeArtifact } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import {
  checkProvider,
  connectOwnServer,
  type OwnServerSession,
  ownEngineEnv,
  ownServerLoginCheck,
  ownTarget,
} from "../provision";
import {
  approvalEntry,
  describeHostPlan,
  type HostAdapterApi,
  hasDeployment,
  hasState,
  hostPlanFile,
  recordServerAddress,
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

/** Said wherever the teardown of a server the user owns is described (FR-912, FR-913). */
const SERVER_STAYS =
  "Your server itself stays: OpsCrew never deletes, rebuilds or reinstalls it, and takes no snapshot of it. Backups are your responsibility.";

/** What the teardown on the user's server needs once connected. */
interface OwnHost {
  session: OwnServerSession;
  adapter: HostAdapterApi;
  verifyLogin: () => Promise<boolean>;
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

/**
 * Stops (`PHASE_PRECONDITION`, nothing changed) when a teardown or undo plan cannot run; the
 * findings of a plan made for `command` already say to run it again.
 */
function requireNoHostBlockers(plan: HostPlan, what: string, command: string, already = ""): void {
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
          ? hints.join(" ")
          : `Fix what blocks these steps on the server, then run \`${command}\` again.`,
    },
  );
}

/** Why the tunnel goes last, said in the approval and the summary. */
const TUNNEL_AFTER_SERVER =
  "Cloudflare deletes a tunnel only after its connector on your server has stopped,";

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
    /** What the user runs again after a failure: `opscrew destroy`, with `--undo-host` if given. */
    command: string;
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
      command: request.command,
      verifyLogin: host.verifyLogin,
      version: deps.version,
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
    throw stoppedPartWay(error, {
      place: "your server",
      afterFailure: request.afterFailure,
      say: (text) =>
        replaceNames(deps.redactor.redact(text), ownServerNames(host.session), "your server"),
    });
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
  return { hash, approval, applied };
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
  return `Removing the app also deletes its data on your server: ${listText(lost)}. OpsCrew takes no snapshot of your own server, so this cannot be undone unless you have your own backup.`;
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
  items.push(
    ...deploySecretsLeft(github, { names: input.secretNames, removed: input.secretsRemoved }),
    containerImagesLeft(github),
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
  // What the user runs again after a stop, in the findings and the hints of the host adapter.
  const command = options.undoHost === true ? `${COMMAND} --undo-host` : COMMAND;
  const stateHere = await hasState(deps.paths);
  // A finished teardown records `destroyedAt`; an interrupted one does not, so it continues.
  const removeApp = hasDeployment(plan) || (stateHere && plan.deployment.destroyedAt === undefined);
  if (!removeApp && options.undoHost !== true) throw nothingDeployed(plan);
  const scope = teardownScope(deps, plan, "own");
  const words: CloudflareRemovalWords = {
    what: usesTunnel(plan)
      ? "Cloudflare Tunnel, its DNS records and Access"
      : "DNS records on Cloudflare",
    place: "your server",
    tunnelAfter: TUNNEL_AFTER_SERVER,
    stays: SERVER_STAYS,
  };

  // 1. Preconditions: the state of the Cloudflare resources (when the plan has any) and the
  // infrastructure code that matches it. Without the state OpsCrew cannot remove the DNS records or
  // the tunnel, so it changes nothing, not even on the server.
  const managesCloudflare = plan.dns.provider === "cloudflare" || usesTunnel(plan);
  if (removeApp && managesCloudflare && !stateHere) throw stateNotHere(plan);
  if (removeApp && stateHere) {
    await requireInfraCode(deps, plan, "the removal of the app's Cloudflare resources");
  }

  // 2. Credentials
  const cloudflare = removeApp && stateHere && plan.dns.provider === "cloudflare";
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
  if (removeApp && stateHere) {
    const setup = await setupEngine(deps, plan, options);
    const dir = join(deps.paths.root, plan.infra.dir);
    // The server's address reaches the engine only as TF_VAR_* (FR-902).
    await ownEngineEnv(deps, { target: ownTarget(plan) }, setup.env, () =>
      setup.engine.output(dir, { env: setup.env }).catch(() => undefined),
    );
    iac = deletionSession(scope, { ...setup, dir });
    ({ resources, confirmed } = await previewCloudflareRemoval(iac, words));
  }
  // Without the marker (deleted on the server) the record or the plan names the app (T931).
  const teardown = removeApp ? planTeardown(facts, { deleteData, app: name }, command) : undefined;
  if (teardown !== undefined) {
    requireNoHostBlockers(teardown, `remove ${name} from your server`, command);
  }
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
    const removed = hostSteps.map((step) => step.title);
    deps.reporter.info(teardownSummary({ resources, removed, words }));
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
    await confirmDeletion(
      scope,
      {
        name,
        confirmPrompt: destroyConfirmPrompt(name, "own"),
        provider: "own",
        deleteProtection: false,
        resources,
        snapshot: false,
        ...(dataWarning !== undefined ? { dataWarning } : {}),
        hostSteps: removed,
      },
      options.confirm,
    );
  }

  // 5–6. The Cloudflare resources (DNS records, tunnel, Access) and the app on the server (teardown
  // host plan). Both are approved before anything changes. Cloudflare first, unless its plan
  // deletes the tunnel: Cloudflare refuses that while the connector on the server still runs, so
  // then the server goes first and the Cloudflare plan follows once the tunnel has no connections.
  let destroyed: ResourceChange[] = [];
  let removal: CloudflareRemoval | undefined;
  if (iac !== undefined && resources.length > 0) {
    removal = await approveCloudflareRemoval(iac, {
      confirmed,
      appChanges: hostSteps.length > 0,
      words,
    });
  }
  const iacApproval = removal?.approval;
  const hostPlans: { teardown?: string; undo?: string } = {};
  let teardownApproval: ApprovalRecord | undefined;
  try {
    if (iac !== undefined && removal !== undefined && !removal.tunnel) {
      destroyed = await applyCloudflareRemoval(iac, removal, services.sleep);
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
        command,
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
      destroyed = await applyCloudflareRemoval(iac, removal, services.sleep);
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
    current = destroyedPlan(plan, at, [iacApproval, teardownApproval]);
    await writeArtifact("plan", deps.paths.files.plan, current);
    // The address DNS pointed at; the login and the confirmed host key stay (the server stays).
    await recordServerAddress(deps.paths, undefined);
    await rm(deps.paths.files.deploySecrets, { force: true });
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
    const undo = planUndo(after, command);
    requireNoHostBlockers(
      undo,
      "undo its changes to your server",
      command,
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
        command,
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
      current = { ...current, approvals: [...current.approvals, approvalEntry(result.approval)] };
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
