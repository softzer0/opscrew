import { join, posix } from "node:path";
import type { GitClient } from "@opscrew/connector-github";
import { otherActiveApps } from "@opscrew/connector-ssh-host";
import type { IacEngine } from "@opscrew/contracts";
import { exists, isUserFacingError, listText, OpsCrewError } from "@opscrew/core";
import { EDGE_PROXIES, edgeProxy, renderStorage, usesTunnel } from "@opscrew/iac-templates";
import { type DeployPlan, readArtifact, writeArtifact } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { cloudConnectorRemoval } from "../portainer/run";
import { planProvider, providerProfile } from "../providers";
import { readRecord, readRepositoryCopy, requireOwnCopy } from "../secrets/store";
import {
  addressFromOutputs,
  approvalEntry,
  approveAndWriteRenderedFiles,
  committableUrl,
  continuesHint,
  ensureDeployKey,
  type HostPlanOutcome,
  hasDeployment,
  hidesServerAddress,
  infrastructureOutputs,
  type PlanApproval,
  readyNewServer,
  recordOwnServer,
  recordServerAddress,
  requireGitRepo,
  type ServerAddress,
  serverAddress,
  stringOutput,
  trackedFiles,
} from "../shared";
import { runPhase } from "../shared/phase-status";
import { connectorFirst, type HostChangeResult, tunnelChange } from "../shared/tunnel-connections";
import { checkAdditions } from "./additions";
import { checkProvider, setupCloudflare, setupGitHub } from "./credentials";
import { deploySetupDependabot } from "./dependabot";
import { requireNoMoveInProgress } from "./guard";
import {
  deployRenewedCertificate,
  edgeSwitch,
  keepCertificateRequest,
  originTlsApply,
  originTlsHostnames,
  originTlsNotes,
  originTlsSecret,
  planOriginTls,
  readEdgeOver,
  readServerEdge,
  renewsOriginCertificate,
  tlsWarnings,
} from "./origin-tls";
import {
  applyOwnHostPlan,
  type OwnServerRun,
  ownConnectorFirst,
  ownDeployTarget,
  ownEngineEnv,
  prepareOwnServer,
  removeOldAccessMode,
} from "./own";
import { findSavedPlan, planAndApply, REMOVAL_PLAN_SUFFIX } from "./plan-apply";
import { provisionPortainer } from "./portainer-flow";
import {
  committedTfvars,
  deploymentFiles,
  deploymentRenderContext,
  type OwnRenderInput,
  readRequirements,
  recordedEdge,
} from "./render";
import { buildAppEnvironment, deploySecrets, setDeploySecrets } from "./secrets";
import {
  applySharedCloudflare,
  cloudflarePlanHashes,
  planSharedCloudflare,
  readCloudflareRecord,
} from "./shared-cloudflare";
import {
  currentOutputs,
  deployBranchFor,
  deploymentRecord,
  deploySecretsStep,
  mergeDeploysNote,
  type ProvisionPhase,
  provisionEngine,
  publicOutputs,
  publishDeployment,
  type SavedInfrastructureHashes,
  withLearnedZone,
} from "./steps";
import {
  applyStorage,
  providerBucket,
  requireR2Cloudflare,
  requireStorageKey,
  STORAGE_PLAN_SUFFIX,
  storageLogin,
} from "./storage";
import type { ProvisionOptions, ProvisionResult, SavedPlan } from "./types";

/**
 * After a failed apply: the apply may have replaced the server before it stopped, so the address
 * in `.opscrew/server.json` is refreshed from the state's outputs. Best effort: when they cannot be
 * read (or name no server) the record stays as it was, and the apply's own error is what the user
 * sees either way.
 */
async function refreshServerAddress(
  deps: PhaseDeps,
  engine: IacEngine,
  dir: string,
  env: Record<string, string | undefined>,
): Promise<void> {
  try {
    const address = addressFromOutputs(await engine.output(dir, { env }));
    if (address !== undefined) await recordServerAddress(deps.paths, address);
  } catch {
    // Keep the record; the failed apply is reported.
  }
}

async function requireDockerfile(deps: PhaseDeps, git: GitClient, plan: DeployPlan) {
  // Buildpacks and Railpack build the image from the code: such an app has no Dockerfile.
  const builder = plan.app.build?.builder;
  if (builder === "buildpacks" || builder === "railpack") return;
  const dockerfile = join(plan.app.buildContext, plan.app.dockerfile).replace(/\\/g, "/");
  const tracked = await trackedFiles(deps, [dockerfile]);
  if (!(await exists(join(deps.paths.root, dockerfile))) || tracked.length === 0) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `${dockerfile} is not committed on ${await git.currentBranch()}, so GitHub Actions has nothing to build.`,
      {
        hint: "Run `opscrew adapt`, merge its pull request, check out the updated branch, then run `opscrew provision` again.",
      },
    );
  }
}

/** Extra inputs a phase passes to the shared flow. */
export interface PhaseFlowExtras {
  /** Plain-English warnings added to the infrastructure (`iac-apply`) approval details. */
  approvalNotes?: readonly string[];
  /**
   * The plan to deploy when the phase changed it in memory (`opscrew dns`); it is written to
   * `opscrew/plan.yaml` by {@link PhaseFlowExtras.ready}, after the branch checks passed.
   */
  plan?: DeployPlan;
  /**
   * Runs once the preconditions and branch checks passed, before anything is written or applied
   * (`opscrew dns` saves its plan change here, so a stop leaves the repository as it was).
   */
  ready?: () => Promise<void>;
  /**
   * Whether the server's address was public before this run (the deployment was served without
   * Cloudflare's proxy). Default: judged from the committed `terraform.tfvars.json`.
   */
  addressWasPublic?: boolean;
}

/**
 * Said once when a running deployment that was served without Cloudflare's proxy goes behind it:
 * the proxy hides the address from now on, but it may already be known.
 */
export const ADDRESS_MAY_BE_PUBLIC_NOTE =
  "The server's address may already be public: the app was served without Cloudflare's proxy, so earlier DNS records, the runbook or reports in the git history can show it. The proxy hides it from now on, but only a new server gets a fresh, private address (for example `opscrew retarget` to another provider, or `opscrew destroy` and `opscrew provision` again).";

/**
 * True when the committed `terraform.tfvars.json` (the files of the last run) has the domain
 * without Cloudflare's proxy, or no domain (served on the server's address); `false` when the file
 * is missing or unreadable (nothing is known).
 */
async function tfvarsShowPublicAddress(root: string, plan: DeployPlan): Promise<boolean> {
  const values = await committedTfvars(root, plan);
  return values !== undefined && !("proxied" in values && values.proxied === true);
}

/**
 * The saved infrastructure plans the `--approve` hashes name, apart from this run's Cloudflare
 * plans (`cloudflare`, granted by the approval handler). Servers OpsCrew creates have one
 * infrastructure plan, so the main plan is the first other hash that names a saved plan, else the
 * first other hash given (applying it then fails plainly). A server the user owns and
 * the user's Portainer have more (infrastructure, host or stack plan and, when an earlier setup
 * goes, its removal): the main plan is the hash whose saved plan exists, is not a removal and was
 * not applied yet (a script that names both hashes again after the infrastructure was applied
 * plans afresh, which finds nothing to change); a saved removal plan is kept apart and only ever
 * applied as the removal; the host or stack plan's hash is granted by the approval handler. On
 * every target, the saved plan of the `storage` root (the app's bucket) is kept apart as `storage`.
 */
async function savedInfrastructureHashes(
  deps: PhaseDeps,
  options: ProvisionOptions,
  plan: DeployPlan,
  cloudflare: readonly string[] = [],
): Promise<SavedInfrastructureHashes> {
  const found: SavedInfrastructureHashes = {};
  const others: string[] = [];
  const saved = new Map<string, SavedPlan>();
  for (const hash of (options.approveHashes ?? []).filter(
    (hash) => !cloudflare.includes(hash.toLowerCase()),
  )) {
    const savedPlan = await findSavedPlan(deps.paths.files.plansDir, hash);
    if (savedPlan !== undefined) saved.set(hash, savedPlan);
    // The `storage` root's saved plan (the app's bucket) is only ever applied as that root's, and
    // once it was applied a run that names it again plans the bucket afresh.
    if (savedPlan?.planFile.endsWith(STORAGE_PLAN_SUFFIX)) {
      if (savedPlan.appliedAt === undefined) found.storage ??= hash;
    } else others.push(hash);
  }
  if (plan.target.provider !== "own" && plan.target.provider !== "portainer") {
    // A Cloudflare plan an earlier run applied may be named too: the saved plan's hash wins.
    const apply = others.find((hash) => saved.has(hash)) ?? others[0];
    return apply === undefined ? found : { ...found, apply };
  }
  const applied = plan.deployment.lastPlanHash?.toLowerCase();
  for (const hash of others) {
    const savedPlan = saved.get(hash);
    if (hash.toLowerCase() === applied || savedPlan === undefined) continue;
    if (savedPlan.planFile.endsWith(REMOVAL_PLAN_SUFFIX)) found.removal ??= hash;
    else found.apply ??= hash;
  }
  return found;
}

/**
 * Provision and DNS share this flow: credentials (and the Cloudflare plan of OpsCrew's shared rules
 * and Zero Trust pieces, read-only: for the plan's Cloudflare zone, and for a zone the record
 * names that the app leaves) → engine, deploy key and state
 * encryption → the Cloudflare plan's approval by its hash, apply and `.opscrew/cloudflare.json` →
 * render (approved write) → plan, policies, approval, apply → record the deployment → wait for the
 * server and pin its host key → deploy secrets → commit, push and pull request.
 *
 * A server the user owns (`target.provider: own`) differs after the credentials: connect and
 * confirm its host key, inspect it read-only and stop on blocking findings before any change; the
 * address reaches the engine only as `TF_VAR_*`; a switch between public and tunnel mode first
 * removes the old records (an apply of its own); after the infrastructure apply the host plan is
 * saved, shown, approved by its hash and applied; then the address is recorded and the deploy
 * secrets (with the tunnel's service token) are stored.
 *
 * The user's Portainer (`target.provider: portainer`) leaves this flow after the repository checks
 * for {@link provisionPortainer}: no server, SSH or deploy key, and its changes in Portainer as a
 * stack plan approved by its hash (`stack-apply`).
 */
async function provisionFlow(
  deps: PhaseDeps,
  options: ProvisionOptions,
  phase: ProvisionPhase,
  extras: PhaseFlowExtras,
): Promise<ProvisionResult> {
  const services = options.services ?? {};
  const root = deps.paths.root;
  let plan = extras.plan ?? (await readArtifact("plan", deps.paths.files.plan));
  const requirements = await readRequirements(deps);
  const ownServer = plan.target.provider === "own";
  const command = `opscrew ${phase}`;

  // 1–2. Preconditions and credentials. A recovery copy another computer updated stops the run
  // before any plan or change (FR-1417).
  requireOwnCopy(await readRepositoryCopy(deps.paths), await readRecord(deps.paths));
  const git = await requireGitRepo(deps);
  await requireDockerfile(deps, git, plan);
  if (plan.target.provider === "portainer") {
    // The user's Portainer: no server, SSH or deploy key; stacks through Portainer's API.
    const saved = await savedInfrastructureHashes(deps, options, plan);
    return provisionPortainer(deps, options, { plan, requirements, git, phase, saved, extras });
  }
  const profile = providerProfile(planProvider(plan));
  deps.reporter.step(
    ownServer
      ? "Checking the login to your server, Cloudflare and GitHub access"
      : `Checking your ${profile.displayName}, Cloudflare and GitHub access`,
  );
  await checkProvider(deps, profile.id, services);
  const cloudflare = await setupCloudflare(deps, plan, services);
  const github = await setupGitHub(deps, git, services);
  // The app's bucket at a provider: R2 needs the plan's Cloudflare account, and a Hetzner or
  // Spaces bucket is created with the user's key, so it is needed now (R2's comes after its bucket).
  requireR2Cloudflare(plan, cloudflare);
  const bucket = providerBucket(plan);
  const storageKey =
    bucket !== undefined && bucket.provider !== "r2"
      ? await requireStorageKey(deps, plan, services, { command })
      : undefined;
  // The app's own additions to its site, checked before any change (FR-1443) against the site
  // this run means to deploy.
  const intended = originTlsHostnames(plan);
  await checkAdditions(
    deps,
    plan,
    deploymentRenderContext(deps, {
      plan,
      requirements,
      github,
      deployPublicKey: "",
      cloudflare,
      edge: {
        ...(intended.length > 0 ? { originTls: { hostnames: intended } } : {}),
        additions: true,
      },
    }),
    services,
  );
  // What the server runs now (read-only, over SSH as deploy): its proxy, and the app's origin
  // certificate and client-certificate requirement, which the origin TLS clean-up waits for.
  const served = await readServerEdge(deps, plan, services);
  const tls =
    cloudflare === undefined
      ? undefined
      : await planOriginTls(deps, {
          plan,
          record: await readCloudflareRecord(deps.paths).then((r) =>
            r?.zoneId === cloudflare.zoneId ? r : undefined,
          ),
          served: served?.served,
        });
  // A hostname leaving Cloudflare's proxy keeps its DNS record proxied for this run, while the
  // deploy gives the origin a public certificate (research R3); plan.yaml keeps the user's choice.
  const userProxied = plan.dns.proxied;
  const persisted = (p: DeployPlan): DeployPlan => ({
    ...p,
    dns: { ...p.dns, proxied: userProxied },
  });
  if (tls?.holdsProxy) plan = { ...plan, dns: { ...plan.dns, proxied: true } };
  // OpsCrew's shared Cloudflare change (also the removal of this app's hostnames from a zone it
  // no longer uses), with the app's origin TLS and the zone's minimum TLS, planned read-only now
  // (it stops on its findings) and applied before the infrastructure plan.
  const shared = await planSharedCloudflare(deps, {
    services,
    plan,
    cloudflare,
    command,
    tls: { ...(tls !== undefined ? { tls: tls.desired } : {}), minTls: true },
    ...(tls !== undefined
      ? {
          notes: originTlsNotes(tls, {
            workflow: posix.basename(plan.cicd.workflowPath),
            branch: plan.cicd.branch,
          }),
        }
      : {}),
  });
  if (tls !== undefined && shared?.main !== undefined) {
    await keepCertificateRequest(deps, tls, shared.main.plan);
  }
  // A server OpsCrew creates holds only this app, so a proxy switch there is planned and said.
  const edgeNotes: string[] = [];
  const switchNote = ownServer ? undefined : edgeSwitch(plan, served, []);
  if (switchNote !== undefined) edgeNotes.push(switchNote);
  // The saved infrastructure plans the `--approve` hashes name (applied instead of planning again).
  const saved = await savedInfrastructureHashes(deps, options, plan, cloudflarePlanHashes(shared));
  const approveHash = saved.apply;
  // `--plan-only` commits nothing.
  const commits = !(options.planOnly && approveHash === undefined);
  const deployBranch = await deployBranchFor(deps, {
    git,
    github,
    plan,
    phase,
    commits,
    push: options.push !== false,
  });
  await extras.ready?.();
  // The note's advice (a new server for a fresh address) is for servers OpsCrew creates.
  const addressWasPublic =
    !ownServer && (extras.addressWasPublic ?? (await tfvarsShowPublicAddress(root, plan)));
  if (addressWasPublic && hasDeployment(plan) && hidesServerAddress(plan)) {
    deps.reporter.warn(ADDRESS_MAY_BE_PUBLIC_NOTE);
  }
  const learned = withLearnedZone(deps, plan, cloudflare, command);
  plan = learned.plan;

  // 3. Engine, state encryption, deploy key
  const { engine, env: engineEnv } = await provisionEngine(deps, plan, options);
  const deployKey = await ensureDeployKey(deps.paths, deps.redactor);
  if (deployKey.created) deps.reporter.info("Created a dedicated SSH deploy key for this project.");
  const dir = join(root, plan.infra.dir);
  const approvals: PlanApproval[] = [];

  // 3b. A server the user owns: connect and confirm its host key, inspect it (read-only) and stop
  // on blocking findings before anything changes; its address reaches the engine only as TF_VAR_*.
  let ownRun: OwnServerRun | undefined;
  let ownRender: OwnRenderInput | undefined;
  /** The host plan applied before a mode switch's removal deleted the tunnel. */
  let earlyHost: HostChangeResult | undefined;
  if (ownServer) {
    ownRun = await prepareOwnServer(deps, {
      plan,
      options,
      services,
      deployPublicKey: deployKey.publicKeyOpenSsh,
      deployKeyFile: deployKey.privateKeyFile,
      phase,
      command,
    });
    // The server's proxy, which every OpsCrew app on it shares: another one is refused while other
    // apps are there, and planned with its interruption while this app is alone (FR-1440, FR-1444).
    const running = await readEdgeOver(deps, ownRun.session.remote, plan.app.name);
    const others = otherActiveApps(ownRun.facts.apps, plan.app.name).map((r) => r.app);
    const ownSwitch = edgeSwitch(plan, running, others);
    if (ownSwitch !== undefined) edgeNotes.push(ownSwitch);
    await ownEngineEnv(deps, ownRun, engineEnv, () =>
      infrastructureOutputs(deps, plan, { engine: async () => engine, engineEnv }),
    );
    // The port the deploy reaches: the login's in public mode, sshd's own in tunnel mode.
    ownRender = { sshPort: ownRun.sshPort };
    // Switching between public and tunnel mode: the old records go first, in an apply of their own.
    // Only a saved removal plan is applied as the removal (never the new setup's plan). When it
    // deletes the tunnel, the server's change (without the connector) goes before it.
    const removal = await removeOldAccessMode(deps, {
      engine,
      dir,
      env: engineEnv,
      plan,
      ...(saved.removal !== undefined ? { approvePlanHash: saved.removal } : {}),
      ...(options.planOnly ? { planOnly: true } : {}),
      phase,
      host: {
        run: ownRun,
        deployPublicKey: deployKey.publicKeyOpenSsh,
        ...(options.passwordLogins !== undefined ? { passwordLogins: options.passwordLogins } : {}),
        ...(services.sleep !== undefined ? { sleep: services.sleep } : {}),
      },
    });
    earlyHost = removal?.host;
    if (removal === undefined && saved.removal !== undefined) {
      throw new OpsCrewError(
        "PLAN_HASH_MISMATCH",
        `The plan ${saved.removal} you approved removes the current setup before a switch between public and tunnel mode, but no switch is pending, so OpsCrew did not apply it. Nothing was changed.`,
        { hint: `Run \`${command} --plan-only\`, review the plan and approve the new hash.` },
      );
    }
    if (removal !== undefined) {
      const pending = (removal.plan?.changes.length ?? 0) > 0 && !removal.applied;
      if (options.planOnly && pending) {
        // The new setup's Cloudflare plan is shown too; it is approved after the removal.
        for (const zone of [shared?.leave, shared?.main]) {
          if (zone !== undefined && zone.plan.changes.length > 0) deps.reporter.info(zone.details);
        }
        const first = removal.host;
        deps.reporter.info(
          first !== undefined
            ? `After this removal and the host plan are applied (\`${command} --approve ${removal.planHash} --approve ${first.hash}\`, typing the app name to confirm; the host plan goes first, because Cloudflare deletes the tunnel only after its connector on your server has stopped), run \`${command}\` again for the plan of the new setup.`
            : `After this removal is applied (\`${command} --approve ${removal.planHash}\`, typing the app name to confirm), run \`${command}\` again for the plan of the new setup.`,
        );
        return {
          ...(removal.planHash ? { planHash: removal.planHash } : {}),
          ...(first !== undefined ? { hostPlanHash: first.hash } : {}),
          applied: false,
          outputs: {},
        };
      }
      if (removal.approval) approvals.push(approvalEntry(removal.approval));
      if (removal.host?.approval) approvals.push(approvalEntry(removal.host.approval));
    }
  }

  // 3c. OpsCrew's shared Cloudflare change (its rules in the zone, the account's Zero Trust
  // organization and one-time PIN login) before the infrastructure plan of this setup (after a
  // mode switch's removal of the old one): shown, approved by its hash, applied and recorded. The
  // infrastructure takes the PIN login's id from it. Applying a saved plan renders nothing, so its
  // files keep the site the --plan-only run wrote (the next run brings a new origin TLS).
  const siteBefore =
    approveHash === undefined ? undefined : (await recordedEdge(deps, persisted(plan))).edge;
  const sharedResult =
    shared === undefined
      ? undefined
      : await applySharedCloudflare(deps, shared, {
          app: plan.app.name,
          planOnly: options.planOnly === true,
          command,
          phase,
          ...originTlsApply(deps, tls, services),
        });
  const cloudflareHash = sharedResult?.fields ?? {};
  if (sharedResult?.infrastructureWaits) return { ...cloudflareHash, applied: false, outputs: {} };
  for (const approval of sharedResult?.approvals ?? []) approvals.push(approvalEntry(approval));
  if (sharedResult?.oneTimePinId !== undefined) {
    ownRender = { ...ownRender, oneTimePinIdentityProviderId: sharedResult.oneTimePinId };
  }
  // The new origin certificate of a renewal reaches the server only with a deploy.
  const renewed =
    sharedResult?.applied === true &&
    shared?.main !== undefined &&
    renewsOriginCertificate(shared.main.plan);

  // 4. Render (skipped when applying a saved plan: its files were written by the --plan-only run)
  const knownServer =
    hidesServerAddress(plan) || ownServer
      ? undefined
      : await serverAddress(deps, plan, { engine: async () => engine, engineEnv });
  // The app's site: origin TLS as Cloudflare now has it (a missing permission keeps today's
  // site), and the user's additions.
  const after = await recordedEdge(deps, persisted(plan));
  const site = { edge: siteBefore ?? after.edge, values: after.values };
  const ctx = deploymentRenderContext(deps, {
    plan,
    requirements,
    github,
    deployPublicKey: deployKey.publicKeyOpenSsh,
    cloudflare,
    server: knownServer,
    ...(ownRender !== undefined ? { own: ownRender } : {}),
    edge: site.edge,
  });
  // Dependabot's configuration comes with the workflow and runtime files it watches (FR-1221).
  const dependabot = await deploySetupDependabot(deps, plan, { writes: approveHash === undefined });
  const files = [
    ...deploymentFiles(plan, ctx, site.values),
    ...(dependabot?.action === "write" ? [dependabot.file] : []),
  ];
  if (approveHash === undefined) await approveAndWriteRenderedFiles(deps, root, files);

  // 4b. The app's bucket (the `storage` root): its own plan, approved by its hash, before the
  // infrastructure plan.
  const storage =
    bucket === undefined
      ? undefined
      : await applyStorage(deps, {
          engine,
          env: engineEnv,
          plan,
          files: renderStorage(plan, ctx),
          key: storageKey,
          ...(saved.storage !== undefined ? { approvePlanHash: saved.storage } : {}),
          ...(options.planOnly ? { planOnly: true } : {}),
          command,
          phase,
          ...(services.sleep !== undefined ? { sleep: services.sleep } : {}),
        });
  if (storage?.approval) approvals.push(approvalEntry(storage.approval));
  const storagePlanHash =
    storage?.plan !== undefined && storage.plan.changes.length > 0 ? storage.planHash : undefined;
  const storageHash = storagePlanHash !== undefined ? { storagePlanHash } : {};

  // The server's proxy switch, said now and in the infrastructure approval; CAA records of the
  // user's next to OpsCrew's, and a client certificate near its end.
  for (const note of edgeNotes) deps.reporter.warn(note);
  const approvalNotes = [...(extras.approvalNotes ?? []), ...edgeNotes];
  for (const warning of tlsWarnings(plan, cloudflare, shared?.main?.plan, deps.clock)) {
    deps.reporter.warn(warning);
  }

  // 5. Plan → policies → approval → apply. A plan that deletes the tunnel (for example when
  // plan.yaml no longer has a Portainer subdomain) is applied only after the connector on the
  // server is removed (its own host-apply approval) and Cloudflare reports no active connections.
  // The connector removal's hash, once it is shown (the hint names it when the deletion stops).
  let cloudHostHash: string | undefined;
  const cloudConnector = (planOnly: boolean) =>
    cloudConnectorRemoval(deps, {
      plan,
      services,
      command,
      planOnly,
      shown: (hash) => {
        cloudHostHash = hash;
      },
    });
  const first = ownRun
    ? ownConnectorFirst(deps, {
        run: ownRun,
        plan,
        deployPublicKey: deployKey.publicKeyOpenSsh,
        ...(options.passwordLogins !== undefined ? { passwordLogins: options.passwordLogins } : {}),
        phase,
        ...(services.sleep !== undefined ? { sleep: services.sleep } : {}),
        done: "The change on your server is applied (its Cloudflare Tunnel connector is removed); the Cloudflare Tunnel this plan deletes is still there.",
        ...(approvalNotes.length > 0 ? { notes: approvalNotes } : {}),
      })
    : connectorFirst(deps, {
        command,
        app: plan.app.name,
        where: "on the server",
        hostChange: () => cloudConnector(false),
        hostHash: () => cloudHostHash,
        done: "The Cloudflare Tunnel connector is removed from the server; the Cloudflare Tunnel this plan deletes is still there.",
        ...(services.sleep !== undefined ? { sleep: services.sleep } : {}),
        ...(approvalNotes.length > 0 ? { notes: approvalNotes } : {}),
      });
  let applied: Awaited<ReturnType<typeof planAndApply>>;
  try {
    applied = await planAndApply(deps, {
      engine,
      dir,
      env: engineEnv,
      deployPlan: plan,
      files,
      command,
      phase,
      ...first.hooks,
      ...(approveHash !== undefined ? { approvePlanHash: approveHash } : {}),
      ...(options.planOnly ? { planOnly: true } : {}),
    });
  } catch (error) {
    if (!ownServer && isUserFacingError(error) && error.code === "ENGINE_FAILED") {
      await refreshServerAddress(deps, engine, dir, engineEnv);
    }
    throw first.stopped(error);
  }
  if (applied.approval) approvals.push(approvalEntry(applied.approval));
  if (first.host !== undefined) {
    earlyHost ??= first.host;
    if (first.host.approval) approvals.push(approvalEntry(first.host.approval));
  }
  if (options.planOnly && approveHash === undefined) {
    let hostPlanHash: string | undefined;
    const pending = (applied.plan?.changes.length ?? 0) > 0;
    if (!ownRun && pending && tunnelChange(applied.plan?.changes ?? [], "delete")) {
      // The connector's removal goes before this plan: show it now, so both can be approved.
      hostPlanHash = (await cloudConnector(true)).hash;
      deps.reporter.info(
        `Approve both plans to apply them (\`${command} --approve ${applied.planHash} --approve ${hostPlanHash}\`, typing ${plan.app.name} to confirm): the change on the server goes first, because Cloudflare deletes a tunnel only after its connector has stopped.`,
      );
    }
    if (ownRun) {
      // The host plan can be shown now unless it needs a tunnel the plan has yet to create.
      const outputs = await currentOutputs(applied, engine, dir, engineEnv);
      const tunnelKnown =
        !usesTunnel(plan) ||
        (stringOutput(outputs, "tunnel_id") !== undefined &&
          !tunnelChange(applied.plan?.changes ?? []));
      if (tunnelKnown) {
        const host = await applyOwnHostPlan(deps, ownRun, {
          plan,
          outputs,
          deployPublicKey: deployKey.publicKeyOpenSsh,
          ...(options.passwordLogins !== undefined
            ? { passwordLogins: options.passwordLogins }
            : {}),
          planOnly: true,
          phase,
          command,
        });
        hostPlanHash = host.hash;
      } else {
        deps.reporter.info(
          "The host plan for your server follows once this infrastructure plan is applied, because it needs the Cloudflare Tunnel's id. Applying it shows the host plan and asks for its approval separately (in scripts: run with `--approve` and this hash, then again with `--approve` and the host plan's hash).",
        );
      }
    }
    if (learned.zoneLearned) await writeArtifact("plan", deps.paths.files.plan, persisted(plan));
    return {
      ...(applied.planHash ? { planHash: applied.planHash } : {}),
      ...storageHash,
      ...cloudflareHash,
      ...(hostPlanHash !== undefined ? { hostPlanHash } : {}),
      applied: false,
      outputs: {},
    };
  }

  // 6. Record the deployment: the server's address in the local state (never in the repository),
  // the apply and the domain URL in the plan.
  let address: ServerAddress | undefined;
  if (ownRun) {
    // Right after the infrastructure apply, as for cloud servers: the DNS records now point at this
    // address (none in tunnel mode), and a later switch's removal plan needs it.
    address = ownRun.address;
    await recordServerAddress(deps.paths, address);
    const connection = ownRun.session.connection;
    if (
      address !== undefined &&
      (connection.publicIpv4 !== address.ipv4 || connection.publicIpv6 !== address.ipv6)
    ) {
      const { publicIpv4: _v4, publicIpv6: _v6, ...rest } = connection;
      await recordOwnServer(deps.paths, {
        ...rest,
        publicIpv4: address.ipv4,
        ...(address.ipv6 !== undefined ? { publicIpv6: address.ipv6 } : {}),
      });
    }
  } else {
    address =
      addressFromOutputs(applied.outputs) ??
      (await serverAddress(deps, plan, { engine: async () => engine, engineEnv }));
    if (address === undefined) {
      throw new OpsCrewError("ENGINE_FAILED", "The server's address is unknown after the apply.", {
        hint: "Run `opscrew provision` again; it reads the address from the infrastructure state.",
      });
    }
    await recordServerAddress(deps.paths, address);
  }
  // Without a domain the output is `http://<server IP>`, which is not committed.
  const outputUrl = stringOutput(applied.outputs, "url");
  const record = deploymentRecord(deps, {
    plan,
    url: outputUrl === undefined ? plan.deployment.url : committableUrl(outputUrl),
    iac: applied,
    approvals,
  });
  plan = record(false);
  await writeArtifact("plan", deps.paths.files.plan, persisted(plan));

  let secretsTarget: {
    host: string;
    knownHosts: string;
    tunnel?: { serviceTokenId: string; serviceTokenSecret: string };
  };
  let host: HostPlanOutcome | undefined;
  if (ownRun) {
    // 7 (own server). Host plan → policy → host-apply approval by its hash → apply.
    const outputs = await currentOutputs(applied, engine, dir, engineEnv);
    host = await applyOwnHostPlan(deps, ownRun, {
      plan,
      outputs,
      deployPublicKey: deployKey.publicKeyOpenSsh,
      ...(options.passwordLogins !== undefined ? { passwordLogins: options.passwordLogins } : {}),
      phase,
      command,
    });
    if (host.approval) approvals.push(approvalEntry(host.approval));
    // The server changed before the removal already when that deleted the tunnel.
    const hostApplied = host.applied || earlyHost?.applied === true;
    plan = record(hostApplied);
    await writeArtifact("plan", deps.paths.files.plan, persisted(plan));
    host = { ...host, applied: hostApplied };
    secretsTarget = ownDeployTarget(deps, ownRun, { plan, outputs });
  } else {
    const ipv4 = (address as ServerAddress).ipv4;
    // 7. Wait for the server and pin its SSH host key
    const pinned = await readyNewServer(deps, {
      host: ipv4,
      server: "server",
      profile,
      keyFile: deployKey.privateKeyFile,
      again: continuesHint(command),
      services,
    });
    secretsTarget = { host: ipv4, knownHosts: pinned.knownHostsLines };
  }

  // 8–9. Production environment and GitHub Actions secrets
  const secretsStored = await deploySecretsStep(deps, {
    store: options.secrets !== false,
    save: async () => {
      // R2's key is a token the user limits to the bucket, so it comes now that the bucket exists.
      const key =
        bucket === undefined
          ? undefined
          : (storageKey ??
            (await requireStorageKey(deps, plan, services, {
              command,
              already: `The bucket ${bucket.bucket} exists; the deploy secrets are not stored yet.`,
            })));
      // Without a domain, host lists (`ALLOWED_HOSTS`) hold the address recorded in local state.
      const environment = await buildAppEnvironment(
        deps,
        plan,
        services,
        address?.ipv4,
        key === undefined ? {} : { storage: storageLogin(plan, key, cloudflare) },
      );
      await setDeploySecrets(
        deps,
        github,
        deploySecrets({
          plan,
          host: secretsTarget.host,
          privateKey: deployKey.privateKeyOpenSsh,
          knownHosts: secretsTarget.knownHosts,
          environment,
          ...(secretsTarget.tunnel !== undefined ? { tunnel: secretsTarget.tunnel } : {}),
          ...(ctx.originTls !== undefined ? { originTls: originTlsSecret(site.values) } : {}),
        }),
        environment.names,
        phase,
      );
    },
    where: { host: secretsTarget.host, owner: github.owner, repo: github.repo },
    noun: "server",
  });

  // 10. Commit, push and open the pull request (with the user's additions, which the deploy
  // uploads, and the recovery copy when this computer's files changed).
  const published = await publishDeployment(deps, {
    git,
    github,
    plan: persisted(plan),
    files: [
      ...files.map((f) => f.path),
      ...(ctx.additions === true ? [EDGE_PROXIES[edgeProxy(plan)].additions] : []),
    ],
    push: options.push !== false,
    secretsStored,
    phase,
    branch: deployBranch,
    dependabot,
    ...(options.recovery !== undefined ? { recovery: options.recovery } : {}),
  });
  plan = published.plan;
  if (secretsStored) deps.reporter.info(mergeDeploysNote(plan, published.published));
  if (renewed && secretsStored && ctx.originTls !== undefined) {
    await deployRenewedCertificate(deps, github, plan, phase);
  }
  if (tls !== undefined && tls.leaving.length > 0) {
    deps.reporter.info(
      `${listText(tls.leaving)} left Cloudflare's proxy. Once the deploy has given the server ${tls.leaving.length === 1 ? "its" : "their"} public certificate, run \`${command}\` again: it turns Cloudflare's client certificate off for ${tls.leaving.length === 1 ? "it" : "them"}${tls.holdsProxy ? " and switches the DNS records to DNS only" : ""}.`,
    );
  }
  return {
    ...(applied.planHash ? { planHash: applied.planHash } : {}),
    ...storageHash,
    ...cloudflareHash,
    applied: applied.applied,
    ...(host !== undefined ? { hostPlanHash: host.hash, hostApplied: host.applied } : {}),
    outputs: publicOutputs(applied.outputs),
    branch: published.published.branch,
    ...(published.published.prUrl ? { prUrl: published.published.prUrl } : {}),
  };
}

/** Runs the shared flow and records the phase outcome (`ok`, or `failed` with the reason). */
export async function runPhaseFlow(
  deps: PhaseDeps,
  phase: ProvisionPhase,
  options: ProvisionOptions,
  extras: PhaseFlowExtras = {},
): Promise<ProvisionResult> {
  return runPhase(deps, phase, async () => {
    const result = await provisionFlow(deps, options, phase, extras);
    if (!(options.planOnly && (options.approveHashes ?? []).length === 0)) {
      await deps.state.markPhase(
        phase,
        "ok",
        result.prUrl ? `deployment files in ${result.prUrl}` : `applied: ${result.applied}`,
      );
    }
    return result;
  });
}

/**
 * `opscrew provision`: creates the hardened server on the plan's provider (Hetzner Cloud or
 * DigitalOcean, and Cloudflare DNS when planned) through
 * plan → policies → approval → apply, waits for it, stores the deploy secrets in GitHub Actions and
 * opens a pull request with the generated files. Safe to re-run: it plans only what is missing and
 * reuses the deploy key, state passphrase, pinned host key and generated passwords. Stops with
 * `PHASE_PRECONDITION` before doing anything while `opscrew retarget` is moving the deployment.
 *
 * On a server the user already owns (`target.provider: own`) it never creates or deletes the
 * server: it confirms and pins the host key (`hostKey` in scripts), inspects the server, plans
 * Cloudflare's records (or tunnel and Access) as infrastructure and the server's preparation as a
 * host plan, applies each only after an approval bound to its hash (two `--approve` hashes in
 * scripts), then stores the deploy secrets and opens the pull request.
 *
 * In a Portainer the user already runs (`target.provider: portainer`) it changes nothing on the
 * host: it inspects Portainer through its API with the pinned certificate, plans Cloudflare's
 * tunnels and Access (when the plan has them) as infrastructure and the stacks as a stack plan,
 * applies each only after an approval bound to its hash (`--yes` never grants a `stack-apply`),
 * records what it created in `.opscrew/server.json`, then stores the deploy secrets and opens the
 * pull request (see `provisionPortainer`).
 */
export async function runProvision(
  deps: PhaseDeps,
  options: ProvisionOptions = {},
): Promise<ProvisionResult> {
  // An unreadable plan is reported by the flow itself (and recorded as a failed phase).
  const plan = await readArtifact("plan", deps.paths.files.plan).catch(() => undefined);
  if (plan !== undefined) requireNoMoveInProgress(plan);
  return runPhaseFlow(deps, "provision", options);
}
