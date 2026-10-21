import { join } from "node:path";
import type { SharedPlan } from "@opscrew/connector-cloudflare";
import type { GitClient } from "@opscrew/connector-github";
import {
  type ApplySecrets,
  DEPLOY_BRANCH,
  DEPLOY_COMPOSE_FILE,
  type DesiredStacks,
  type DesiredValueFingerprints,
  inspectCertificate,
  type PortainerFacts,
  planStacks,
  stackPlanHash,
  valueFingerprint,
  valueFingerprints,
} from "@opscrew/connector-portainer";
import { OpsCrewError, plural, writeFileAtomic } from "@opscrew/core";
import {
  PORTAINER_STACK_VARIABLES,
  portainerSecretVariables,
  portainerStackEnvKeys,
  portainerTarget,
  portainerWebhookHostname,
  type RuntimeContext,
  renderStorage,
  siteHosts,
} from "@opscrew/iac-templates";
import type { DeployPlan, Requirements } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { PORTAINER_NOTES } from "../design/portainer";
import {
  type AppEnvironment,
  applyStackPlanAudited,
  approvalEntry,
  approveAndWriteRenderedFiles,
  committedStackPins,
  desiredStacks,
  infrastructureOutputs,
  inspectAudited,
  type PlanApproval,
  PlanRefusedError,
  type ProjectEngine,
  pinnedPublicKey,
  portainerClientFor,
  stateContents,
  stateFile,
  stringOutput,
  writePlanIfChanged,
} from "../shared";
import { connectorFirst, tunnelChange } from "../shared/tunnel-connections";
import { portainerAdditionsNote } from "./additions";
import { caddyRecordNote, deletedRecordHosts, requireCaddyRecords } from "./caddy-records";
import {
  cloudflareTokenMissing,
  portainerCloudflare,
  setupCloudflare,
  setupGitHub,
} from "./credentials";
import { deploySetupDependabot } from "./dependabot";
import { deployBranchState, startDeployBranch } from "./deploy-branch";
import {
  keepCertificateRequest,
  originTlsApply,
  originTlsNotes,
  portainerOriginTls,
  stackOriginTls,
} from "./origin-tls";
import { type PlanAndApplyResult, planAndApply } from "./plan-apply";
import {
  ensurePortainerValueKey,
  portainerContainerUrl,
  portainerWebhookId,
  REGISTRY_TOKEN_VAR,
  REPOSITORY_TOKEN_VAR,
  requirePortainerConnection,
  requirePortainerToken,
  setPortainerOrigin,
  stackPlanFile,
} from "./portainer";
import { portainerDnsRecordNote } from "./publish";
import { deploymentFiles, deploymentRenderContext, recordedEdge } from "./render";
import {
  buildAppEnvironment,
  PORTAINER_SECRETS_RECORD,
  portainerDeploySecrets,
  setDeploySecrets,
} from "./secrets";
import { applySharedCloudflare, planSharedCloudflare } from "./shared-cloudflare";
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
import {
  applyStorage,
  providerBucket,
  requireR2Cloudflare,
  requireStorageKey,
  storageLogin,
} from "./storage";
import type { ProvisionOptions, ProvisionResult } from "./types";

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

/** Said with the stack plan when this run's Cloudflare apply changed the stack Caddy's origin TLS. */
const ORIGIN_STACK_NOTE =
  "The Cloudflare plan applied in this run changed the origin protection of the stack's Caddy (its certificates), so the stack plan for your Portainer changed with it and needs its own approval (in scripts: run again with `--approve` and the stack plan's hash).";

/**
 * What of the app's site reaches its stack plan: the hostnames the stack's Caddy serves with
 * origin TLS and the origin certificate (public); `""` without origin TLS.
 */
function stackOrigin({ edge, values }: Awaited<ReturnType<typeof recordedEdge>>): string {
  const hostnames = edge.originTls?.hostnames;
  return hostnames === undefined ? "" : `${hostnames.join(" ")}\n${values.ORIGIN_TLS_CERT ?? ""}`;
}

/**
 * True when applying the Cloudflare plan changes the stack Caddy's origin TLS, and so its stack
 * plan: a new origin certificate, or the client certificate turned on for a hostname the site
 * does not serve with origin TLS yet (`serving`).
 */
function bringsOriginTls(plan: Pick<SharedPlan, "changes">, serving: readonly string[]): boolean {
  return plan.changes.some(
    (change) =>
      change.kind === "create-origin-certificate" ||
      (change.kind === "enable-client-certificate" &&
        change.hostnames.some((hostname) => !serving.includes(hostname))),
  );
}

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
 * the steps for a limited token without a registry entry) → with a Cloudflare root, the
 * Cloudflare plan of OpsCrew's shared rule and Zero Trust organization, its `cloudflare-apply`
 * approval by its hash and apply → render and write the files → the app's bucket at a provider
 * (the `storage` root: its own plan and `iac-apply` approval; R2's key comes after it) → the
 * infrastructure plan
 * (Cloudflare only), its policies, `iac-apply` approval and apply, when the plan has a
 * Cloudflare root → the `opscrew-deploy` branch with a placeholder (`git-push`
 * approval) when the app stack is new → the stack plan, bound to the values it sends by their
 * keyed fingerprints → `stack-apply` approval by its hash (`--yes` never grants it) → apply with
 * the secrets → record what OpsCrew created in `.opscrew/server.json` (also when the apply stopped
 * part-way) → the deploy secrets → the deploy pull request. No secret or Portainer address reaches
 * a plan, the output, the audit log, a file in the repository or the pull request.
 *
 * `--plan-only` shows the plans and their hashes and changes nothing (the stack plan follows the
 * infrastructure apply when it needs a tunnel's token that does not exist yet, and the Cloudflare
 * apply when its Caddy needs the origin certificate that plan creates); `--approve` names
 * the infrastructure plan's hash, the Cloudflare plan's and the stack plan's (the approval handler
 * grants the latter two). The stack plan is made after the Cloudflare apply, with the stack Caddy's
 * origin TLS as Cloudflare then has it, as in a single run: when that apply changed it, the stack
 * plan has a new hash, which the hash shown before does not approve, so a script stops at it
 * before anything in Portainer changes.
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
  const cloudflareRoot = portainerCloudflare(plan) ?? {
    appTunnel: false,
    webhook: false,
    originTls: false,
  };
  const hasRoot = cloudflareRoot.appTunnel || cloudflareRoot.webhook;
  // The app's bucket at a provider: an R2 bucket needs the plan's Cloudflare account.
  const bucket = providerBucket(plan);
  const usesCloudflare = hasRoot || cloudflareRoot.originTls || bucket?.provider === "r2";
  // The stack's variables, before anything else: an app variable a stack cannot hold, or a
  // service that needs a setting of the Docker host, stops here.
  portainerStackEnvKeys(plan);

  // 1. Preconditions: Portainer's token and connection, GitHub, Cloudflare when the plan has a
  // tunnel or an R2 bucket.
  deps.reporter.step(
    usesCloudflare
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
  const account = usesCloudflare ? await setupCloudflare(deps, plan, services) : undefined;
  if (hasRoot && account === undefined) {
    throw new OpsCrewError("PHASE_PRECONDITION", "This plan needs a domain on Cloudflare.", {
      hint: "Run `opscrew interview` and `opscrew design` again.",
    });
  }
  requireR2Cloudflare(plan, account);
  // What the Cloudflare root and OpsCrew's shared Cloudflare plan work with: only a plan with a
  // tunnel, or with the stack Caddy's origin TLS, has them (an R2 bucket alone needs only the
  // account).
  const cloudflare = hasRoot || cloudflareRoot.originTls ? account : undefined;
  // A Hetzner or Spaces bucket is created with the user's key, so it is needed now (R2's comes
  // after its bucket, as a token limited to it).
  const storageKey =
    bucket !== undefined && bucket.provider !== "r2"
      ? await requireStorageKey(deps, plan, services, { command })
      : undefined;
  // 2. Connect with the pinned certificate, inspect read-only, stop on what blocks the deploy.
  const valueKey = await ensurePortainerValueKey(deps, portainerServices.randomBytes);
  const client = portainerClientFor(deps, {
    connection,
    token,
    client: portainerServices.client,
    valueKey,
  });
  const inspect = async (detail?: string): Promise<PortainerFacts> => {
    const facts = await inspectAudited(deps, client, {
      plan,
      target,
      step: "Inspecting your Portainer (read-only)",
      phase,
      ...(detail !== undefined ? { detail } : {}),
    });
    requireUsableFacts(facts, target);
    return facts;
  };
  let facts = await inspect();
  // The app's own additions: a Portainer stack has none yet (said when there is a file).
  await portainerAdditionsNote(deps);
  // The stack Caddy's origin TLS, planned against what the stack serves now (its file and the
  // fingerprint of its values in Portainer).
  const tls =
    cloudflare === undefined
      ? undefined
      : await stackOriginTls(deps, { plan, cloudflare, connection, facts, valueKey });
  // OpsCrew's shared Cloudflare change (also the removal of this app's hostnames from a zone it
  // no longer uses, for example after leaving web mode tunnel), with the stack Caddy's origin TLS
  // and the zone's minimum TLS, planned read-only now and applied before the infrastructure plan.
  const shared = await planSharedCloudflare(deps, {
    services,
    plan,
    cloudflare,
    command,
    tls: { ...(tls !== undefined ? { tls: tls.desired } : {}), minTls: true },
    ...(tls !== undefined ? { notes: originTlsNotes(tls, undefined) } : {}),
  });
  if (tls !== undefined && shared?.main !== undefined) {
    await keepCertificateRequest(deps, tls, shared.main.plan);
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

  // Visitors lose the current route when the earlier setup's Cloudflare resources go, or the app
  // is served another way than now: said once this run is done.
  const routeChanges = removal || switchesWebRoute(target, connection);

  const updater = target.redeploy === "updater";
  // The user's word on the image's visibility, as given now or recorded by an earlier run.
  const publicImage = options.publicImage ?? connection.publicImage ?? false;
  const imagePrivate = !publicImage;
  const committed = await committedStackPins(root);
  /** The stack Caddy's origin TLS as rendered (known once the Cloudflare change is applied). */
  let siteOrigin: RuntimeContext["originTls"];
  const desired = (fingerprints?: DesiredValueFingerprints): DesiredStacks =>
    desiredStacks(plan, {
      connection,
      github,
      committed,
      repositoryPrivate: repository.private,
      imagePrivate,
      ...(fingerprints !== undefined ? { fingerprints } : {}),
      ...(options.replaceTokens !== undefined ? { replaceTokens: options.replaceTokens } : {}),
      ...(siteOrigin !== undefined ? { originTls: siteOrigin } : {}),
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

  // 3. OpsCrew's shared Cloudflare change (its rule in the zone, the account's Zero Trust
  // organization for the webhook's Access) before anything else changes: shown, approved by its
  // hash, applied and recorded. In a run that applies plans shown before (`--approve`), the stack
  // Caddy's origin TLS before this apply: when the apply changes it, the stack plan differs from
  // the one shown, and its new hash needs an approval of its own.
  const originBefore =
    (options.approveHashes ?? []).length > 0
      ? stackOrigin(await recordedEdge(deps, plan))
      : undefined;
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

  // 3b. Render and write the files, with the stack Caddy's origin TLS as Cloudflare now has it.
  // Applying a saved plan keeps the infrastructure code the --plan-only run wrote, which that plan
  // was made from; the other files are in no hashed plan, so the stack template and the workflow
  // are those of the stack plan this run shows. Dependabot's configuration comes with the workflow
  // and the stack template it watches (FR-1221); the template is committed in `opscrew/runtime` on
  // the default branch, which is the only branch Dependabot reads, so its Compose entry applies
  // here too.
  const writes = saved.apply === undefined && saved.removal === undefined;
  const dependabot = await deploySetupDependabot(deps, plan, { writes });
  const site = await recordedEdge(deps, plan);
  const originChanged = originBefore !== undefined && originBefore !== stackOrigin(site);
  const ctx = deploymentRenderContext(deps, {
    plan,
    requirements: input.requirements,
    github,
    // A Portainer target has no SSH deploy: its files never use the deploy key.
    deployPublicKey: "",
    cloudflare: account,
    // The stack Caddy's origin TLS as Cloudflare now has it (none without the permissions).
    edge: site.edge,
  });
  siteOrigin = ctx.originTls;
  // The stack's variables with the origin TLS bundle, when its Caddy serves the certificate.
  const stackKeys = portainerStackEnvKeys(plan, ctx);
  const originBundle = ctx.originTls === undefined ? undefined : portainerOriginTls(site.values);
  if (originBundle !== undefined) deps.redactor.addLiteral(originBundle, "origin-tls");
  const files = [
    ...deploymentFiles(plan, ctx),
    ...(dependabot?.action === "write" ? [dependabot.file] : []),
  ];
  // A refusal names the Cloudflare plans this run applied (each one's approval is this run's).
  const cloudflareApplied = (sharedResult?.approvals ?? []).map(
    (approval) => `Cloudflare plan ${approval.planHash}`,
  );
  await approveAndWriteRenderedFiles(
    deps,
    root,
    writes ? files : files.filter((file) => file.kind !== "infra"),
    cloudflareApplied.length === 0
      ? {}
      : {
          refused: `OpsCrew applied the Cloudflare changes you approved (${cloudflareApplied.join("; ")}); it wrote no files and changed nothing in your Portainer. Run \`${command}\` again to continue from there.`,
        },
  );

  // 3c. The app's bucket (the `storage` root): its own plan, approved by its hash, before the
  // infrastructure plan and the stacks (the app's stack gets its key).
  const storage =
    bucket === undefined
      ? undefined
      : await engineSetup().then(({ engine, env }) =>
          applyStorage(deps, {
            engine,
            env,
            plan,
            files: renderStorage(plan, ctx),
            key: storageKey,
            ...(saved.storage !== undefined ? { approvePlanHash: saved.storage } : {}),
            ...(options.planOnly ? { planOnly: true } : {}),
            command,
            phase,
            ...(services.sleep !== undefined ? { sleep: services.sleep } : {}),
          }),
        );
  const storagePlanHash =
    storage?.plan !== undefined && storage.plan.changes.length > 0 ? storage.planHash : undefined;
  const storageHash = storagePlanHash !== undefined ? { storagePlanHash } : {};
  // In --plan-only, a bucket still to create has no key yet for the app's stack (R2's comes after it).
  const bucketPending = storage !== undefined && !storage.applied && storagePlanHash !== undefined;

  // The app's values (with the bucket's key), the webhook and the certificate's key, read once and
  // only when needed.
  let environment: AppEnvironment | undefined;
  const appEnvironment = async () => {
    if (environment === undefined) {
      const key =
        bucket === undefined
          ? undefined
          : (storageKey ??
            (await requireStorageKey(deps, plan, services, {
              command,
              already: `The bucket ${bucket.bucket} exists; nothing in your Portainer was changed.`,
            })));
      environment = await buildAppEnvironment(deps, plan, services, undefined, {
        portainer: true,
        ...(key === undefined ? {} : { storage: storageLogin(plan, key, account) }),
      });
    }
    return environment;
  };
  let pin: string | undefined;
  const publicKeyPin = async (): Promise<string> => {
    pin ??= await pinnedPublicKey(
      deps,
      connection,
      portainerServices.inspectCertificate ?? inspectCertificate,
    );
    return pin;
  };
  // Every value is registered with the redactor where it is made (the app's environment, the
  // outputs, the webhook, the certificate's key and the tokens).
  const values = async (outputs: Record<string, unknown>): Promise<StackValues> => {
    const env = await appEnvironment();
    const out: Record<string, string> = {};
    for (const key of stackKeys.app) out[key] = env.values.app[key] ?? "";
    const opscrew: Record<string, string | undefined> = {
      [PORTAINER_STACK_VARIABLES.dbUser]: env.values.db?.user,
      [PORTAINER_STACK_VARIABLES.dbName]: env.values.db?.name,
      [PORTAINER_STACK_VARIABLES.tunnelToken]:
        target.web.mode === "tunnel" ? requiredOutput(deps, outputs, "tunnel_token") : undefined,
      [PORTAINER_STACK_VARIABLES.originTls]: originBundle,
    };
    // Each service's generated secrets (Postgres's password among them), as the stack's variables.
    for (const { service, secret, variable } of portainerSecretVariables(plan)) {
      opscrew[variable] = env.values.services[service]?.[secret];
    }
    for (const key of stackKeys.opscrew) out[key] = opscrew[key] ?? "";
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
    if (originChanged) deps.reporter.info(ORIGIN_STACK_NOTE);
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
    stale = true;
    const result = await applyStackPlanAudited(deps, {
      client,
      plan: stackPlan,
      hash,
      options: {
        secrets,
        valueKey,
        ...(portainerServices.wait !== undefined ? { wait: portainerServices.wait } : {}),
      },
      phase,
      // What OpsCrew created is recorded (with the route of an app stack it holds), also after a
      // failure part-way; the image's visibility once the apply is done.
      record: async (created, finished) => {
        connection = await recordConnection(deps, connection, {
          created,
          ...(finished ? { publicImage } : {}),
          ...(hasAppStack(created) ? { appliedWeb: target.web } : {}),
        });
      },
    });
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
  const approvals: PlanApproval[] = (sharedResult?.approvals ?? []).map(approvalEntry);
  if (storage?.approval) approvals.push(approvalEntry(storage.approval));
  let iac: PlanAndApplyResult = { applied: false, outputs: {} };
  let early: StackStepResult | undefined;
  if (hasRoot || removal) {
    const { engine, env } = await engineSetup();
    // The earlier configuration may declare it too, so a removal gets it as well.
    if (cloudflareRoot.webhook || removal) {
      setPortainerOrigin(deps.redactor, env, connection.url);
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
    let originFollows = false;
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
    if (bucketPending) {
      deps.reporter.info(
        "The stack plan for your Portainer follows once the app's bucket exists, because the app's stack gets the bucket's key. Applying the bucket's plan shows the stack plan and asks for its approval separately (in scripts: run with `--approve` and the hashes shown, then again with `--approve` and the stack plan's hash).",
      );
    } else if (!tokensKnown || tunnelChange(changes, "create", "replace")) {
      deps.reporter.info(
        "The stack plan for your Portainer follows once this infrastructure plan is applied, because it needs the Cloudflare Tunnel's token. Applying it shows the stack plan and asks for its approval separately (in scripts: run with `--approve` and this hash, then again with `--approve` and the stack plan's hash).",
      );
    } else if (
      shared?.main !== undefined &&
      bringsOriginTls(shared.main.plan, ctx.originTls?.hostnames ?? [])
    ) {
      originFollows = true;
      deps.reporter.info(
        "The stack plan for your Portainer follows once this Cloudflare plan is applied, because the stack's Caddy needs the origin certificate it creates. Applying it shows the stack plan and asks for its approval separately (in scripts: run with `--approve` and this hash, then again with `--approve` and the stack plan's hash).",
      );
    } else {
      stackHash = (await stackStep(outputs, true)).hash;
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
    if (learned.zoneLearned) await writePlanIfChanged(deps, plan);
    return {
      ...(iac.planHash ? { planHash: iac.planHash } : {}),
      ...cloudflareHash,
      ...storageHash,
      ...(stackHash !== undefined ? { stackPlanHash: stackHash } : {}),
      ...(originFollows ? { stackFollowsOriginTls: true as const } : {}),
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
  await writePlanIfChanged(deps, plan);

  // 5b. Caddy asks Let's Encrypt for its certificates as soon as it starts, and a failed request
  // stays cached: in web mode caddy the domain's records must resolve publicly before the deploy
  // branch, the stack change and the deploy pull request (after the Cloudflare changes, which may
  // delete the Cloudflare Tunnel's records at those names).
  if (target.web.mode === "caddy") {
    const done: string[] = [];
    if (sharedResult?.applied)
      done.push("The Cloudflare plan of OpsCrew's shared rules is applied.");
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
  await writePlanIfChanged(deps, plan);

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
    dependabot,
    ...(options.recovery !== undefined ? { recovery: options.recovery } : {}),
  });
  plan = published.plan;
  const dns = portainerDnsRecordNote(plan);
  if (dns !== undefined) deps.reporter.info(dns);
  if (routeChanges) deps.reporter.warn(ROUTE_CHANGE_NOTE);
  deps.reporter.info(PORTAINER_NOTES);
  const merge = mergeDeploysNote(plan, published.published, options.secrets !== false);
  if (secretsStored && merge !== undefined) deps.reporter.info(merge);
  return {
    ...(iac.planHash ? { planHash: iac.planHash } : {}),
    ...cloudflareHash,
    ...storageHash,
    applied: iac.applied,
    stackPlanHash: stack.hash,
    stackApplied,
    outputs: publicOutputs(outputs),
    branch: published.published.branch,
    ...(published.published.prUrl ? { prUrl: published.published.prUrl } : {}),
    published: published.published.published,
    pushed: published.published.pushed,
  };
}
