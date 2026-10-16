import { join } from "node:path";
import type { GitClient } from "@opscrew/connector-github";
import {
  type ApplySecrets,
  applyStackPlan,
  DEPLOY_BRANCH,
  DEPLOY_COMPOSE_FILE,
  type DesiredStacks,
  type DesiredValueFingerprints,
  inspectCertificate,
  inspectPortainer,
  normalizeCertFingerprint,
  opscrewStackNames,
  PortainerCertificateError,
  type PortainerFacts,
  planStacks,
  portainerClient,
  StackApplyError,
  stackPlanHash,
  valueFingerprint,
  valueFingerprints,
} from "@opscrew/connector-portainer";
import { OpsCrewError, plural, writeFileAtomic } from "@opscrew/core";
import {
  PORTAINER_STACK_VARIABLES,
  portainerStackEnvKeys,
  portainerStackVolumes,
  portainerTarget,
  portainerWebhookHostname,
  renderPortainerConnectorStack,
  renderUpdaterStack,
  siteHosts,
} from "@opscrew/iac-templates";
import { type DeployPlan, type Requirements, writeArtifact } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { PORTAINER_BACKUPS_NOTE, PORTAINER_HOST_NOTE } from "../design/portainer";
import { stateContents } from "../drift/infra";
import { hidePortainerAddress } from "../interview/portainer-access";
import {
  type AppEnvironment,
  approvalEntry,
  approveAndWriteRenderedFiles,
  infrastructureOutputs,
  type PlanApproval,
  PlanRefusedError,
  type ProjectEngine,
  stateFile,
  stringOutput,
} from "../shared";
import { connectorFirst, tunnelChange } from "../shared/tunnel-connections";
import { caddyRecordNote, deletedRecordHosts, requireCaddyRecords } from "./caddy-records";
import {
  cloudflareTokenMissing,
  portainerCloudflare,
  setupCloudflare,
  setupGitHub,
} from "./credentials";
import { deployBranchState, startDeployBranch } from "./deploy-branch";
import { type PlanAndApplyResult, planAndApply } from "./plan-apply";
import {
  ensurePortainerValueKey,
  portainerContainerUrl,
  portainerWebhookId,
  REGISTRY_TOKEN_VAR,
  REPOSITORY_TOKEN_VAR,
  requirePortainerConnection,
  requirePortainerToken,
  stackPlanFile,
} from "./portainer";
import { portainerDnsRecordNote } from "./publish";
import { committedTfvars, deploymentFiles, deploymentRenderContext } from "./render";
import {
  buildAppEnvironment,
  PORTAINER_SECRETS_RECORD,
  portainerDeploySecrets,
  setDeploySecrets,
} from "./secrets";
import {
  describeStackPlan,
  hasAppStack,
  ROUTE_CHANGE_NOTE,
  recordConnection,
  requireNoStackBlockers,
  requireReplaceable,
  requireTokens,
  requireUsableFacts,
  type StackStepResult,
  sentTokens,
  switchesWebRoute,
} from "./stack-plan";
import { removeStaleRoot, uncommittedRemovals } from "./stale-root";
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
import type { ProvisionOptions, ProvisionResult } from "./types";
import { cloudflareZeroTrust, createZeroTrustOrganization } from "./zero-trust";

/** What {@link provisionPortainer} gets from the shared provision flow. */
export interface PortainerFlowInput {
  plan: DeployPlan;
  requirements: Requirements | undefined;
  git: GitClient;
  phase: ProvisionPhase;
  /** The saved infrastructure plans the `--approve` hashes name (applied instead of planning). */
  saved: SavedInfrastructureHashes;
  /** Notes for the infrastructure approval, and the step that saves `opscrew dns`'s plan change. */
  extras: { approvalNotes?: readonly string[]; ready?: () => Promise<void> };
}

/** The values a stack plan sends, by where they go (secrets: never printed). */
interface StackValues {
  env: Record<string, string>;
  webhookId: string;
  updaterEnv?: Record<string, string>;
  tunnelToken?: string;
  repositoryToken?: string;
  registryToken?: string;
}

/** What is done when the deploy secrets cannot be stored: the stacks are already set up. */
const STACKS_SET_UP =
  "The app's stacks are set up in your Portainer; only the deploy secrets are not stored yet.";

/**
 * A sensitive output the stacks or the deploy secrets need, registered with the redactor. `done`
 * says what is already changed when it is missing (default: nothing in Portainer).
 */
function requiredOutput(
  deps: Pick<PhaseDeps, "redactor">,
  outputs: Record<string, unknown>,
  name: string,
  done = "Nothing in Portainer was changed.",
): string {
  const value = stringOutput(outputs, name);
  if (value === undefined) {
    throw new OpsCrewError(
      "ENGINE_FAILED",
      `The infrastructure state has no ${name.replaceAll("_", " ")}, which your Portainer's stacks or the deploy workflow need. ${done}`,
      {
        hint: "Run `opscrew provision` again; it plans what is missing. If the tunnel was deleted in the Cloudflare dashboard, the next plan creates a new one.",
      },
    );
  }
  deps.redactor.addLiteral(value, name);
  return value;
}

/**
 * `opscrew provision` for the user's Portainer (plan.md §5): preconditions (Portainer's token and
 * connection, GitHub, Cloudflare when the plan has a tunnel) → connect with the pinned certificate
 * (a changed certificate stops plainly) → inspect read-only → stop on blocking findings (including
 * the steps for a limited token without a registry entry) → render and write the files → the
 * infrastructure plan (Cloudflare only), its policies, `iac-apply` approval and apply, when the
 * plan has a Cloudflare root → the `opscrew-deploy` branch with a placeholder (`git-push`
 * approval) when the app stack is new → the stack plan, bound to the values it sends by their
 * keyed fingerprints → `stack-apply` approval by its hash (`--yes` never grants it) → apply with
 * the secrets → record what OpsCrew created in `.opscrew/server.json` (also when the apply stopped
 * part-way) → the deploy secrets → the deploy pull request. No secret or Portainer address reaches
 * a plan, the output, the audit log, a file in the repository or the pull request.
 *
 * `--plan-only` shows both plans and their hashes and changes nothing (the stack plan follows the
 * infrastructure apply when it needs a tunnel's token that does not exist yet); `--approve` names
 * the infrastructure plan's hash and the stack plan's (the approval handler grants the latter).
 */
export async function provisionPortainer(
  deps: PhaseDeps,
  options: ProvisionOptions,
  input: PortainerFlowInput,
): Promise<ProvisionResult> {
  const services = options.services ?? {};
  const portainerServices = services.portainer ?? {};
  const { git, phase, saved } = input;
  const command = `opscrew ${phase}`;
  const root = deps.paths.root;
  let plan = input.plan;
  const target = portainerTarget(plan.target);
  const cloudflareRoot = portainerCloudflare(plan) ?? { appTunnel: false, webhook: false };
  const hasRoot = cloudflareRoot.appTunnel || cloudflareRoot.webhook;

  // 1. Preconditions: Portainer's token and connection, GitHub, Cloudflare when the plan has a tunnel.
  deps.reporter.step(
    hasRoot
      ? "Checking your Portainer, Cloudflare and GitHub access"
      : "Checking your Portainer and GitHub access",
  );
  let connection = await requirePortainerConnection(deps, plan);
  if (target.redeploy === "cloudflare" && new URL(connection.url).pathname !== "/") {
    // The tunnel's route sends Portainer's hostname to an origin without a path.
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      "Redeploys through Cloudflare reach Portainer's webhook through a Cloudflare Tunnel route, which cannot add a path, and the Portainer address OpsCrew has for this project includes one. Nothing was changed.",
      {
        hint: "Run `opscrew interview` and give Portainer's root address (for example its own port, https://<host>:9443, without a path), or choose the updater for redeploys; then run `opscrew design` and `opscrew provision` again.",
      },
    );
  }
  const token = requirePortainerToken(deps);
  const github = await setupGitHub(deps, git, services);
  const cloudflare = hasRoot ? await setupCloudflare(deps, plan, services) : undefined;
  if (hasRoot && cloudflare === undefined) {
    throw new OpsCrewError("PHASE_PRECONDITION", "This plan needs a domain on Cloudflare.", {
      hint: "Run `opscrew interview` and `opscrew design` again.",
    });
  }
  const repository = await github.api.getRepo(github.owner, github.repo);
  const commits = !(options.planOnly && saved.apply === undefined && saved.removal === undefined);
  const deployBranch = await deployBranchFor(deps, {
    git,
    github,
    plan,
    phase,
    commits,
    push: options.push !== false,
  });
  await input.extras.ready?.();
  const learned = withLearnedZone(deps, plan, cloudflare, command);
  plan = learned.plan;
  const dir = join(root, plan.infra.dir);
  // The engine, made when this run first needs it. Portainer's address reaches it only as set
  // below (`TF_VAR_portainer_origin`), never from this computer's environment.
  let setup: ProjectEngine | undefined;
  const engineSetup = async (): Promise<ProjectEngine> => {
    if (setup === undefined) {
      setup = await provisionEngine(deps, plan, options);
      delete setup.env.TF_VAR_portainer_origin;
    }
    return setup;
  };
  // Without a Cloudflare root, an earlier setup's Cloudflare resources in the state are removed
  // later in this run; that needs the Cloudflare token, so its absence stops here. An earlier
  // setup counts only while the state holds managed resources (a removal leaves an empty state,
  // encrypted or not); outputs alone are no infrastructure.
  let removal = false;
  if (!hasRoot) {
    const contents = await stateContents(
      deps,
      stateFile(deps.paths),
      async () => (await engineSetup()).engine,
    );
    if (contents === "unknown") {
      // A state the engine cannot list: its outputs, if it can read them (an apply writes them).
      const { engine, env } = await engineSetup();
      const held = await infrastructureOutputs(deps, plan, {
        engine: async () => engine,
        engineEnv: env,
      });
      removal = held !== undefined && Object.keys(held).length > 0;
    } else {
      removal = contents === "resources";
    }
    if (removal && !deps.env.CLOUDFLARE_API_TOKEN?.trim()) throw cloudflareTokenMissing(deps);
  }

  // 2. Connect with the pinned certificate, inspect read-only, stop on what blocks the deploy.
  const valueKey = await ensurePortainerValueKey(deps, portainerServices.randomBytes);
  const client = (portainerServices.client ?? portainerClient)(
    {
      url: connection.url,
      ...(connection.certFingerprint !== undefined
        ? { certFingerprint: connection.certFingerprint }
        : {}),
    },
    token,
    { redactor: deps.redactor, valueKey },
  );
  const names = opscrewStackNames(plan.app.name);
  const inspect = async (detail?: string): Promise<PortainerFacts> => {
    deps.reporter.step("Inspecting your Portainer (read-only)");
    const facts = await inspectPortainer(client, {
      environmentId: target.environmentId,
      names,
    });
    await deps.audit.append({
      kind: "provider-call",
      actor: "opscrew",
      action: "inspect Portainer (read-only)",
      phase,
      target: `portainer environment ${target.environmentId}`,
      decision: "allow",
      ...(detail !== undefined ? { detail } : {}),
    });
    requireUsableFacts(facts, target);
    return facts;
  };
  let facts = await inspect();
  // Visitors lose the current route when the earlier setup's Cloudflare resources go, or the app
  // is served another way than now: said once this run is done.
  const routeChanges = removal || switchesWebRoute(target, connection);

  const keys = portainerStackEnvKeys(plan);
  const envKeys = [...keys.app, ...keys.opscrew].sort();
  const updater = target.redeploy === "updater";
  const repositoryUrl = `https://github.com/${github.owner}/${github.repo}`;
  // The user's word on the image's visibility, as given now or recorded by an earlier run.
  const publicImage = options.publicImage ?? connection.publicImage ?? false;
  const imagePrivate = !publicImage;
  const desired = (fingerprints?: DesiredValueFingerprints): DesiredStacks => ({
    app: plan.app.name,
    environmentId: target.environmentId,
    repository: {
      url: repositoryUrl,
      branch: DEPLOY_BRANCH,
      composeFile: DEPLOY_COMPOSE_FILE,
      private: repository.private,
    },
    envKeys,
    registry: { url: "ghcr.io", private: imagePrivate, username: github.owner },
    redeploy: target.redeploy,
    ...(updater
      ? { updater: { compose: renderUpdaterStack(plan).content } }
      : { tunnelConnector: { compose: renderPortainerConnectorStack(plan).content } }),
    record: connection.created,
    ports:
      target.web.mode === "proxy"
        ? [target.web.port]
        : target.web.mode === "caddy"
          ? [80, 443]
          : [],
    volumes: portainerStackVolumes(plan),
    ...(fingerprints !== undefined ? { valueFingerprints: fingerprints } : {}),
    ...(fingerprints !== undefined && options.replaceTokens !== undefined
      ? { replaceTokens: options.replaceTokens }
      : {}),
  });
  // Without values: what blocks the deploy shows before anything is written or changed.
  const preliminary = planStacks(facts, desired());
  requireNoStackBlockers(preliminary);
  requireReplaceable(options, repository.private, imagePrivate);
  // A token the first changes send must be set before anything changes.
  const preliminaryTokens = sentTokens(preliminary);
  requireTokens(
    {
      repository: preliminaryTokens.repository || options.replaceTokens?.repository === true,
      registry: preliminaryTokens.registry || options.replaceTokens?.registry === true,
    },
    {
      repository: Boolean(deps.env[REPOSITORY_TOKEN_VAR]?.trim()),
      registry: Boolean(deps.env[REGISTRY_TOKEN_VAR]?.trim()),
    },
  );
  const createsAppStack = preliminary.changes.some(
    (change) =>
      change.id === "app-stack" && change.state === "change" && change.params.action === "create",
  );
  /** The deploy branch with the placeholder, started at most once in this run. */
  let branchStarted = false;
  const startPlaceholderBranch = async (cloudflareApplied: boolean): Promise<void> => {
    if (branchStarted) return;
    await startDeployBranch(deps, { git, github, plan, phase, cloudflareApplied });
    branchStarted = true;
  };

  // 3. Render and write the files (skipped when applying a saved plan: --plan-only wrote them).
  const access =
    cloudflareRoot.webhook && cloudflare?.accountId !== undefined
      ? {
          createZeroTrustOrganization: await createZeroTrustOrganization({
            api: services.zeroTrust ?? cloudflareZeroTrust(deps),
            accountId: cloudflare.accountId,
            zone: cloudflare.zoneName,
            previous: (await committedTfvars(root, plan))?.create_zero_trust_organization === true,
          }),
        }
      : undefined;
  const files = deploymentFiles(
    plan,
    deploymentRenderContext(deps, {
      plan,
      requirements: input.requirements,
      github,
      // A Portainer target has no SSH deploy: its files never use the deploy key.
      deployPublicKey: "",
      cloudflare,
      ...(access !== undefined ? { own: access } : {}),
    }),
  );
  if (saved.apply === undefined && saved.removal === undefined) {
    await approveAndWriteRenderedFiles(deps, root, files);
  }

  // The app's values, the webhook and the certificate's key, read once and only when needed.
  let environment: AppEnvironment | undefined;
  const appEnvironment = async () => {
    environment ??= await buildAppEnvironment(deps, plan, services, undefined, {
      portainer: true,
    });
    return environment;
  };
  let pin: string | undefined;
  const publicKeyPin = async (): Promise<string> => {
    if (pin !== undefined) return pin;
    if (new URL(connection.url).protocol !== "https:") {
      pin = "";
      return pin;
    }
    const pinned = normalizeCertFingerprint(connection.certFingerprint ?? "");
    const details = await (portainerServices.inspectCertificate ?? inspectCertificate)(
      connection.url,
    );
    const actual = normalizeCertFingerprint(details.fingerprint);
    if (pinned === undefined || actual === undefined || actual !== pinned) {
      throw new PortainerCertificateError(
        pinned ?? "no confirmed certificate",
        actual ?? "an unreadable fingerprint",
      );
    }
    pin = details.publicKeyPin;
    deps.redactor.addLiteral(pin, "portainer-key");
    return pin;
  };
  // Every value is registered with the redactor where it is made (the app's environment, the
  // outputs, the webhook, the certificate's key and the tokens).
  const values = async (outputs: Record<string, unknown>): Promise<StackValues> => {
    const env = await appEnvironment();
    const out: Record<string, string> = {};
    for (const key of keys.app) out[key] = env.values.app[key] ?? "";
    const opscrew: Record<string, string | undefined> = {
      [PORTAINER_STACK_VARIABLES.dbUser]: env.values.db?.user,
      [PORTAINER_STACK_VARIABLES.dbName]: env.values.db?.name,
      [PORTAINER_STACK_VARIABLES.dbPassword]: env.values.db?.password,
      [PORTAINER_STACK_VARIABLES.tunnelToken]:
        target.web.mode === "tunnel" ? requiredOutput(deps, outputs, "tunnel_token") : undefined,
    };
    for (const key of keys.opscrew) out[key] = opscrew[key] ?? "";
    const webhookId = (await portainerWebhookId(deps, {
      create: true,
      ...(portainerServices.randomUUID !== undefined
        ? { randomUUID: portainerServices.randomUUID }
        : {}),
    })) as string;
    const result: StackValues = { env: out, webhookId };
    if (updater) {
      result.updaterEnv = {
        PORTAINER_WEBHOOK_URL: `${portainerContainerUrl(connection.url)}/api/stacks/webhooks/${webhookId}`,
        PORTAINER_PINNED_KEY: await publicKeyPin(),
      };
    } else {
      result.tunnelToken = requiredOutput(deps, outputs, "portainer_tunnel_token");
    }
    const repositoryToken = deps.env[REPOSITORY_TOKEN_VAR]?.trim();
    if (repository.private && repositoryToken) {
      deps.redactor.addLiteral(repositoryToken, REPOSITORY_TOKEN_VAR);
      result.repositoryToken = repositoryToken;
    }
    const registryToken = deps.env[REGISTRY_TOKEN_VAR]?.trim();
    if (imagePrivate && registryToken) {
      deps.redactor.addLiteral(registryToken, REGISTRY_TOKEN_VAR);
      result.registryToken = registryToken;
    }
    return result;
  };
  const fingerprints = (stack: StackValues): DesiredValueFingerprints => ({
    app: valueFingerprints(valueKey, stack.env),
    webhook: valueFingerprint(valueKey, "webhook", stack.webhookId),
    ...(updater
      ? { updater: valueFingerprints(valueKey, stack.updaterEnv ?? {}) }
      : { connector: valueFingerprints(valueKey, { TUNNEL_TOKEN: stack.tunnelToken ?? "" }) }),
    repositoryToken: valueFingerprint(valueKey, "repositoryToken", stack.repositoryToken ?? ""),
    registryToken: valueFingerprint(valueKey, "registryToken", stack.registryToken ?? ""),
  });

  // The stack step: plan (bound to the values) → show and save → stop on blockers or missing
  // tokens → stack-apply approval by its hash → apply → record what OpsCrew created.
  let stale = false;
  let shownHash: string | undefined;
  const stackStep = async (
    outputs: Record<string, unknown>,
    planOnly: boolean,
  ): Promise<StackStepResult> => {
    if (stale) {
      facts = await inspect("after changing Portainer");
      stale = false;
    }
    const stack = await values(outputs);
    const stackPlan = planStacks(facts, desired(fingerprints(stack)));
    const hash = stackPlanHash(stackPlan);
    shownHash = hash;
    await writeFileAtomic(
      stackPlanFile(deps.paths, hash),
      `${JSON.stringify(stackPlan, null, 2)}\n`,
      { mode: 0o600 },
    );
    const details = describeStackPlan(stackPlan, hash, facts.environment?.name);
    deps.reporter.info(details);
    requireNoStackBlockers(stackPlan);
    const sends = sentTokens(stackPlan);
    requireTokens(sends, {
      repository: stack.repositoryToken !== undefined,
      registry: stack.registryToken !== undefined,
    });
    const work = stackPlan.changes.filter((change) => change.state === "change");
    if (work.length === 0) {
      deps.reporter.success("Your Portainer is already set up as planned; nothing in it changes.");
      if (!planOnly) {
        connection = await recordConnection(deps, connection, {
          publicImage,
          ...(hasAppStack(connection.created) ? { appliedWeb: target.web } : {}),
        });
      }
      return { plan: stackPlan, hash, applied: false };
    }
    if (planOnly) {
      deps.reporter.info(`Saved the stack plan (hash ${hash}); nothing in Portainer was changed.`);
      return { plan: stackPlan, hash, applied: false };
    }
    const approval = await deps.approvals.request({
      kind: "stack-apply",
      title: `Apply the stack plan to your Portainer (${plural(work.length, "change")})`,
      details,
      planHash: hash,
    });
    if (!approval.approved) {
      throw new PlanRefusedError({
        plan: "stack plan",
        ...(approval.reason ? { reason: approval.reason } : {}),
        unchanged: "Nothing in Portainer was changed.",
        hint: `To apply it later without prompts, run: ${command} --approve ${hash}`,
      });
    }
    await deps.approvals.assertApprovedStackPlan(hash);
    const secrets: ApplySecrets = {
      env: stack.env,
      webhookId: stack.webhookId,
      ...(stack.updaterEnv !== undefined ? { updaterEnv: stack.updaterEnv } : {}),
      ...(stack.tunnelToken !== undefined ? { tunnelToken: stack.tunnelToken } : {}),
      ...(sends.repository && stack.repositoryToken !== undefined
        ? { repositoryToken: stack.repositoryToken }
        : {}),
      ...(sends.registry && stack.registryToken !== undefined
        ? { registryToken: stack.registryToken }
        : {}),
    };
    deps.reporter.step(
      `Changing your Portainer (${plural(work.length, "change")}; a stack's first deploy can take a few minutes)`,
    );
    await deps.audit.append({
      kind: "provider-call",
      actor: "opscrew",
      action: "stack apply started",
      phase,
      target: hash,
      decision: "approved",
      detail: `changes: ${work.map((change) => change.id).join(", ")}`,
    });
    stale = true;
    let result: Awaited<ReturnType<typeof applyStackPlan>>;
    try {
      result = await applyStackPlan(client, stackPlan, {
        approvedHash: hash,
        secrets,
        valueKey,
        ...(portainerServices.wait !== undefined ? { wait: portainerServices.wait } : {}),
      });
    } catch (error) {
      if (error instanceof StackApplyError) {
        // What was created before the failure is OpsCrew's: record it before the error is shown.
        connection = await recordConnection(deps, connection, { created: error.record });
        await deps.audit.append({
          kind: "provider-call",
          actor: "opscrew",
          action: "stack apply failed",
          phase,
          target: hash,
          decision: "refused",
          detail: `changes applied before the failure: ${error.applied.length > 0 ? error.applied.join(", ") : "none"}`,
        });
      }
      throw error;
    }
    connection = await recordConnection(deps, connection, {
      created: result.record,
      publicImage,
      ...(hasAppStack(result.record) ? { appliedWeb: target.web } : {}),
    });
    for (const id of result.applied) {
      const change = stackPlan.changes.find((item) => item.id === id);
      await deps.audit.append({
        kind: "provider-call",
        actor: "opscrew",
        action: `stack change ${id}`,
        phase,
        target: hash,
        decision: "approved",
        ...(change !== undefined ? { detail: change.title } : {}),
      });
    }
    deps.reporter.success(
      `Changed your Portainer (${plural(result.applied.length, "change")} applied).`,
    );
    return { plan: stackPlan, hash, applied: result.applied.length > 0, approval };
  };

  // 4. The infrastructure (Cloudflare only): plan → policies → iac-apply approval → apply. A plan
  // that deletes a tunnel whose connector runs in Portainer is applied after the stack change
  // that stops the connector (its own stack-apply approval) and Cloudflare reports it closed.
  // Without a Cloudflare root (web mode proxy or caddy with the updater), what an earlier setup
  // created in Cloudflare is removed: a removal plan (`plan -destroy`) of the configuration still
  // committed, then its files leave the repository.
  const approvals: PlanApproval[] = [];
  let iac: PlanAndApplyResult = { applied: false, outputs: {} };
  let early: StackStepResult | undefined;
  if (hasRoot || removal) {
    const { engine, env } = await engineSetup();
    // The earlier configuration may declare it too, so a removal gets it as well.
    if (cloudflareRoot.webhook || removal) {
      // Portainer's address reaches the engine only as a sensitive variable, never in a file.
      const origin = portainerContainerUrl(connection.url);
      hidePortainerAddress(deps.redactor, origin);
      env.TF_VAR_portainer_origin = origin;
    }
    const first = connectorFirst(deps, {
      command,
      app: plan.app.name,
      where: "in your Portainer",
      hostChange: async () => {
        // The stack change that goes first may create the app stack: its branch must start first.
        if (createsAppStack) await startPlaceholderBranch(false);
        early = await stackStep(await engine.output(dir, { env }).catch(() => ({})), false);
        return {
          hash: early.hash,
          applied: early.applied,
          ...(early.approval !== undefined ? { approval: early.approval } : {}),
        };
      },
      hostHash: () => shownHash,
      done: "The change in your Portainer is applied (the Cloudflare Tunnel's connector is stopped); the Cloudflare Tunnel this plan deletes is still there.",
      ...(services.sleep !== undefined ? { sleep: services.sleep } : {}),
      ...(input.extras.approvalNotes ? { notes: input.extras.approvalNotes } : {}),
    });
    const approvePlanHash = removal ? saved.removal : saved.apply;
    try {
      iac = await planAndApply(deps, {
        engine,
        dir,
        env,
        deployPlan: plan,
        files: removal ? [] : files,
        command,
        phase,
        costDelta: null,
        ...(removal
          ? {
              destroy: true,
              approvalTitle:
                "Remove what an earlier setup of this app created in Cloudflare (its Cloudflare Tunnel, DNS records and Access), which this setup no longer uses",
            }
          : {}),
        ...first.hooks,
        ...(approvePlanHash !== undefined ? { approvePlanHash } : {}),
        ...(options.planOnly ? { planOnly: true } : {}),
      });
    } catch (error) {
      throw first.stopped(error);
    }
    if (iac.approval) approvals.push(approvalEntry(iac.approval));
    if (early?.approval) approvals.push(approvalEntry(early.approval));
  }
  // The root module's outputs now (none without an engine: no Cloudflare root).
  const outputs =
    setup === undefined ? {} : await currentOutputs(iac, setup.engine, dir, setup.env);

  if (!commits) {
    const changes = iac.plan?.changes ?? [];
    if (removal && changes.length > 0) {
      deps.reporter.info(
        `Applying this removal also takes the Cloudflare configuration it removes out of the repository (${plan.infra.dir}/ and its modules), after its own approval.`,
      );
    }
    let stackHash: string | undefined;
    const tokensKnown =
      (target.web.mode !== "tunnel" || stringOutput(outputs, "tunnel_token") !== undefined) &&
      (updater || stringOutput(outputs, "portainer_tunnel_token") !== undefined);
    if (createsAppStack) {
      const state = await deployBranchState(git, github, plan);
      if (state !== "placeholder") {
        deps.reporter.info(
          state === "other"
            ? `Applying replaces the branch ${DEPLOY_BRANCH} in ${github.owner}/${github.repo}, which holds the stack file of an earlier deployment, with a placeholder ${DEPLOY_COMPOSE_FILE} that only sleeps (after its own approval): Portainer deploys it until the deploy workflow's next run writes the app.`
            : `Applying creates the branch ${DEPLOY_BRANCH} in ${github.owner}/${github.repo} with a placeholder ${DEPLOY_COMPOSE_FILE} that only sleeps (after its own approval): Portainer deploys it until the first run of the deploy workflow writes the app.`,
        );
      }
    }
    if (tokensKnown && !tunnelChange(changes, "create", "replace")) {
      stackHash = (await stackStep(outputs, true)).hash;
    } else {
      deps.reporter.info(
        "The stack plan for your Portainer follows once this infrastructure plan is applied, because it needs the Cloudflare Tunnel's token. Applying it shows the stack plan and asks for its approval separately (in scripts: run with `--approve` and this hash, then again with `--approve` and the stack plan's hash).",
      );
    }
    if (changes.length > 0 && tunnelChange(changes, "delete") && stackHash !== undefined) {
      deps.reporter.info(
        `Approve both plans to apply them (\`${command} --approve ${iac.planHash} --approve ${stackHash}\`, typing ${plan.app.name} to confirm): the change in your Portainer goes first, because Cloudflare deletes a tunnel only after its connector has stopped.`,
      );
    }
    if (target.web.mode === "caddy") {
      const note = caddyRecordNote(
        plan,
        command,
        deletedRecordHosts(iac.plan, siteHosts(plan), plan.dns.zone),
      );
      if (note !== undefined) deps.reporter.info(note);
    }
    if (learned.zoneLearned) await writeArtifact("plan", deps.paths.files.plan, plan);
    return {
      ...(iac.planHash ? { planHash: iac.planHash } : {}),
      ...(stackHash !== undefined ? { stackPlanHash: stackHash } : {}),
      applied: false,
      outputs: {},
    };
  }

  // The configuration the removal applied is no longer used: its files leave the repository. A
  // run that removed them and stopped before its commit (for example at Caddy's DNS check below)
  // left their deletion in the working copy: it is committed now.
  const removedFiles =
    removal && iac.applied
      ? await removeStaleRoot(deps, plan)
      : !hasRoot
        ? await uncommittedRemovals(deps, plan)
        : [];

  // 5. Record the infrastructure apply in the plan (never Portainer's address).
  const record = deploymentRecord(deps, {
    plan,
    url: plan.dns.domain !== undefined ? `https://${plan.dns.domain}` : undefined,
    iac,
    approvals,
  });
  const earlyApplied = early?.applied === true;
  plan = record(earlyApplied);
  await writeArtifact("plan", deps.paths.files.plan, plan);

  // 5b. Caddy asks Let's Encrypt for its certificates as soon as it starts, and a failed request
  // stays cached: in web mode caddy the domain's records must resolve publicly before the deploy
  // branch, the stack change and the deploy pull request (after the Cloudflare changes, which may
  // delete the Cloudflare Tunnel's records at those names).
  if (target.web.mode === "caddy") {
    const done: string[] = [];
    if (iac.applied) {
      done.push(
        removal
          ? "The earlier setup's Cloudflare resources (its Cloudflare Tunnel, DNS records and Access) are removed."
          : "The Cloudflare changes are applied.",
      );
    }
    if (removedFiles.length > 0) {
      done.push(
        `The earlier Cloudflare configuration is removed from ${plan.infra.dir}/ in this working copy; the next run commits that with the deployment files.`,
      );
    }
    done.push(
      earlyApplied
        ? "The change in your Portainer that goes first is applied (it stopped the Cloudflare Tunnel's connector); nothing else in Portainer was changed."
        : "Nothing in Portainer was changed.",
    );
    await requireCaddyRecords(deps, {
      plan,
      command,
      deleted: iac.applied ? deletedRecordHosts(iac.plan, siteHosts(plan), plan.dns.zone) : [],
      done: done.join(" "),
    });
  }

  // 6. The deploy branch Portainer builds the app stack from, with a placeholder (research R11).
  if (createsAppStack) await startPlaceholderBranch(iac.applied);

  // 7. The stack plan → stack-apply approval → apply → record.
  const stack = await stackStep(outputs, false);
  if (stack.approval) approvals.push(approvalEntry(stack.approval));
  const stackApplied = stack.applied || earlyApplied;
  plan = record(stackApplied);
  await writeArtifact("plan", deps.paths.files.plan, plan);

  // 8. The deploy secrets: the build's values, and the webhook through Cloudflare Access.
  const secretsStored = await deploySecretsStep(deps, {
    store: options.secrets !== false,
    save: async () => {
      const env = await appEnvironment();
      const webhookId = (await portainerWebhookId(deps, { create: false })) as string;
      const hostname = portainerWebhookHostname(plan);
      const webhook =
        hostname === undefined
          ? undefined
          : {
              url: `https://${hostname}/api/stacks/webhooks/${webhookId}`,
              accessClientId: requiredOutput(
                deps,
                outputs,
                "deploy_service_token_client_id",
                STACKS_SET_UP,
              ),
              accessClientSecret: requiredOutput(
                deps,
                outputs,
                "deploy_service_token_client_secret",
                STACKS_SET_UP,
              ),
            };
      await setDeploySecrets(
        deps,
        github,
        portainerDeploySecrets({ environment: env, ...(webhook !== undefined ? { webhook } : {}) }),
        env.names,
        phase,
        {
          record: PORTAINER_SECRETS_RECORD,
          refusedState: "The app's stacks are set up in your Portainer.",
        },
      );
    },
    where: { host: PORTAINER_SECRETS_RECORD, owner: github.owner, repo: github.repo },
    noun: "app",
  });

  // 9. Commit, push and open the pull request.
  const published = await publishDeployment(deps, {
    git,
    github,
    plan,
    files: [...files.map((f) => f.path), ...removedFiles],
    push: options.push !== false,
    secretsStored,
    phase,
    branch: deployBranch,
  });
  plan = published.plan;
  const dns = portainerDnsRecordNote(plan);
  if (dns !== undefined) deps.reporter.info(dns);
  if (routeChanges) deps.reporter.warn(ROUTE_CHANGE_NOTE);
  deps.reporter.info(`${PORTAINER_HOST_NOTE} ${PORTAINER_BACKUPS_NOTE}`);
  if (secretsStored) deps.reporter.info(mergeDeploysNote(plan, published.published));
  return {
    ...(iac.planHash ? { planHash: iac.planHash } : {}),
    applied: iac.applied,
    stackPlanHash: stack.hash,
    stackApplied,
    outputs: publicOutputs(outputs),
    branch: published.published.branch,
    ...(published.published.prUrl ? { prUrl: published.published.prUrl } : {}),
  };
}
