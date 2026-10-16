import { randomBytes as nodeRandomBytes, randomUUID as nodeRandomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join, posix } from "node:path";
import type { GitClient } from "@opscrew/connector-github";
import {
  type ApplySecrets,
  applyStackPlan,
  type CreatedRecord,
  DEPLOY_BRANCH,
  DEPLOY_COMPOSE_FILE,
  type DesiredStacks,
  type DesiredValueFingerprints,
  inspectCertificate,
  inspectPortainer,
  normalizeCertFingerprint,
  opscrewNames,
  opscrewStackNames,
  PortainerCertificateError,
  type PortainerClient,
  type PortainerFacts,
  planStacks,
  portainerClient,
  StackApplyError,
  type StackChange,
  type StackPlan,
  stackPlanHash,
  valueFingerprints,
} from "@opscrew/connector-portainer";
import type {
  ApprovalRecord,
  FetchLike,
  IacEngine,
  PhaseName,
  ResourceChange,
} from "@opscrew/contracts";
import {
  isUserFacingError,
  OpsCrewError,
  type ProjectPaths,
  toPosixRelative,
  writeFileAtomic,
} from "@opscrew/core";
import { engineLabel, selectEngine, tofuEncryptionEnv } from "@opscrew/iac-engine";
import {
  PORTAINER_STACK_VARIABLES,
  portainerStackEnvKeys,
  portainerStackVolumes,
  portainerTarget,
  portainerWebhookHostname,
  type RenderedFile,
  renderPlaceholderStack,
  renderPortainerConnectorStack,
  renderUpdaterStack,
  siteHosts,
} from "@opscrew/iac-templates";
import {
  type DeployPlan,
  DeployPlanSchema,
  type PortainerDeployTarget,
  type PortainerWeb,
  type Requirements,
  writeArtifact,
} from "@opscrew/plan-schema";
import { z } from "zod";
import type { PhaseDeps } from "../context";
import { PORTAINER_BACKUPS_NOTE, PORTAINER_HOST_NOTE } from "../design/portainer";
import { DNS_OVER_HTTPS_URL } from "../domain/connect-dns";
import { stateContents } from "../drift/infra";
import { hidePortainerAddress } from "../interview/portainer-access";
import { PORTAINER_TOKEN_VAR } from "../providers";
import {
  type AppEnvironment,
  describeDiff,
  diffRenderedFiles,
  ensureSecretFile,
  ensureStatePassphrase,
  hostListKind,
  infrastructureOutputs,
  PlanRefusedError,
  type PortainerConnection,
  parseDotenv,
  readPortainerConnection,
  readSecretFile,
  recordPortainerConnection,
  type SecretFile,
  STATE_FILE,
  writeRenderedFiles,
} from "../shared";
import { connectorFirst, deletesTunnel } from "../shared/tunnel-connections";
import {
  type CloudflareSetup,
  cloudflareTokenMissing,
  type GitHubSetup,
  portainerCloudflare,
  setupCloudflare,
  setupGitHub,
} from "./credentials";
import { type PlanAndApplyResult, planAndApply } from "./plan-apply";
import {
  chooseDeployBranch,
  localDeployBranch,
  portainerDnsRecordNote,
  publishDeploySetup,
} from "./publish";
import { committedTfvars, deploymentFiles, deploymentRenderContext } from "./render";
import {
  buildAppEnvironment,
  deploySecretsStoredFor,
  PORTAINER_SECRETS_RECORD,
  portainerDeploySecrets,
  setDeploySecrets,
} from "./secrets";
import type { ProvisionOptions, ProvisionResult, SavedPlan } from "./types";
import { cloudflareZeroTrust, createZeroTrustOrganization } from "./zero-trust";

/** The read-only token for a private repository, which Portainer fetches the deploy branch with. */
export const REPOSITORY_TOKEN_VAR = "OPSCREW_REPO_READ_TOKEN";
/** The classic token with only `read:packages` for the registry entry of a private image. */
export const REGISTRY_TOKEN_VAR = "OPSCREW_GHCR_READ_TOKEN";

/** Hosts that mean "this computer": inside a container they are the container itself. */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `~/.opscrew/projects/<id>/portainer-env.key` (0600): the key of the values' fingerprints. */
export function portainerValueKeyFile(paths: Pick<ProjectPaths, "projectHomeDir">): string {
  return join(paths.projectHomeDir, "portainer-env.key");
}

/** `~/.opscrew/projects/<id>/portainer-webhook` (0600): the app stack's webhook id, a secret. */
export function portainerWebhookFile(paths: Pick<ProjectPaths, "projectHomeDir">): string {
  return join(paths.projectHomeDir, "portainer-webhook");
}

/** `.opscrew/plans/stack-<hash>.json`: the stack plan the hash names, kept for review and audit. */
export function stackPlanFile(paths: Pick<ProjectPaths, "files">, hash: string): string {
  return join(paths.files.plansDir, `stack-${hash}.json`);
}

/**
 * The value key: 32 random bytes in {@link portainerValueKeyFile}, created once (mode 0600). With it
 * OpsCrew compares the values in Portainer with this computer's as keyed fingerprints, so a changed
 * secret shows by its name only and a plan is bound to the values it sends. A damaged file stops
 * instead of being replaced silently.
 */
export async function ensurePortainerValueKey(
  deps: Pick<PhaseDeps, "paths">,
  randomBytes: (size: number) => Uint8Array = nodeRandomBytes,
): Promise<Uint8Array> {
  const file = portainerValueKeyFile(deps.paths);
  const key = await ensureSecretFile(
    {
      file,
      valid: (text) => {
        const bytes = Buffer.from(text, "base64");
        return bytes.length === 32 && bytes.toString("base64") === text;
      },
      damaged: {
        message: `OpsCrew's value key for your Portainer (${file}) is damaged, so it cannot compare the values in Portainer with this computer's. Nothing was changed.`,
        hint: "Delete the file and run `opscrew provision` again: OpsCrew makes a new key and then sends every value to Portainer once more (you approve that plan as usual).",
      },
    },
    () => Buffer.from(randomBytes(32)).toString("base64"),
  );
  return new Uint8Array(Buffer.from(key, "base64"));
}

/**
 * The app stack's webhook id from {@link portainerWebhookFile}, made once (a random UUID, mode
 * 0600). It alone lets anyone ask Portainer to redeploy the app, so it is never printed, planned,
 * audited or committed. `undefined` when it does not exist and `create` is false.
 */
export async function portainerWebhookId(
  deps: Pick<PhaseDeps, "paths" | "redactor">,
  options: { create: boolean; randomUUID?: () => string },
): Promise<string | undefined> {
  const file = portainerWebhookFile(deps.paths);
  const secret: SecretFile = {
    file,
    valid: (text) => UUID.test(text),
    damaged: {
      message: `OpsCrew's record of the app stack's webhook (${file}) is damaged. Nothing was changed.`,
      hint: "Delete the file and run `opscrew provision` again: OpsCrew makes a new webhook and sets it on the app's stack (you approve that plan as usual).",
    },
  };
  const id = options.create
    ? await ensureSecretFile(secret, () => (options.randomUUID ?? nodeRandomUUID)().toLowerCase())
    : await readSecretFile(secret);
  if (id !== undefined) deps.redactor.addLiteral(id, "portainer-webhook");
  return id;
}

/**
 * Portainer's address as a container on the Portainer host reaches it: the user's address, with
 * `localhost` (Portainer on the same computer) replaced by `host.docker.internal`, which the
 * updater and the Cloudflare connector map to the host. Never printed.
 */
export function portainerContainerUrl(url: string): string {
  const parsed = new URL(url);
  if (LOOPBACK.has(parsed.hostname)) parsed.hostname = "host.docker.internal";
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
}

/**
 * How OpsCrew reaches the user's Portainer, from `.opscrew/server.json`, checked against the plan:
 * the interview must have recorded it, for the environment the plan names.
 */
export async function requirePortainerConnection(
  deps: Pick<PhaseDeps, "paths" | "redactor">,
  plan: Pick<DeployPlan, "target">,
): Promise<PortainerConnection> {
  const target = portainerTarget(plan.target);
  const connection = await readPortainerConnection(deps.paths);
  if (connection === undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      "OpsCrew does not know how to reach your Portainer on this computer, so it changed nothing.",
      {
        hint: "Run `opscrew interview` and answer the Portainer questions (its address and the environment), then run `opscrew provision` again.",
      },
    );
  }
  if (connection.environmentId !== target.environmentId) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `opscrew/plan.yaml deploys to Portainer environment ${target.environmentId}, but the interview on this computer chose environment ${connection.environmentId} (${connection.environmentName}). Nothing was changed.`,
      {
        hint: "Run `opscrew design` again so the plan uses the environment you chose, then run `opscrew provision` again.",
      },
    );
  }
  // Portainer's address (and its host name) is never printed.
  hidePortainerAddress(deps.redactor, connection.url);
  return connection;
}

/** `PORTAINER_API_KEY`, registered with the redactor; stops plainly when it is not set. */
export function requirePortainerToken(deps: Pick<PhaseDeps, "env" | "redactor">): string {
  const token = deps.env[PORTAINER_TOKEN_VAR]?.trim();
  if (token === undefined || token === "") {
    throw new OpsCrewError(
      "CREDENTIALS_MISSING",
      `No Portainer access token found: set ${PORTAINER_TOKEN_VAR}. Nothing was changed.`,
      {
        hint: `In Portainer, open your user menu → My account → Access tokens and add a token (for an administrator, or for a user who may manage stacks on the environment), then set ${PORTAINER_TOKEN_VAR} to it. OpsCrew reads it only from this environment variable and never saves it.`,
      },
    );
  }
  deps.redactor.addLiteral(token, PORTAINER_TOKEN_VAR);
  return token;
}

/** Stops on blocking findings of the inspection or an environment of another architecture. */
function requireUsableFacts(facts: PortainerFacts, target: PortainerDeployTarget): void {
  if (facts.findings.length > 0) throw portainerBlocked(facts.findings, []);
  const arch = facts.environment?.arch;
  if (arch !== undefined && arch !== target.arch) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `opscrew/plan.yaml builds the app for ${target.arch}, but your Portainer environment runs on ${arch}. Nothing was changed.`,
      {
        hint: `Run \`opscrew design\` again so OpsCrew builds the image for ${arch}, then run \`opscrew provision\` again.`,
      },
    );
  }
}

/** The plain stop for findings and blocked changes: what was found and what to do. */
function portainerBlocked(
  findings: readonly { message: string; hint: string; code?: string }[],
  blocked: readonly StackChange[],
): OpsCrewError {
  const reasons =
    findings.length > 0
      ? findings.map((finding) => finding.message)
      : blocked.map((change) => `${change.title}: ${change.reason ?? "blocked"}`);
  const hints = [...new Set(findings.map((finding) => finding.hint))];
  if (findings.some((finding) => finding.code === "registry-missing")) {
    hints.push(
      "If you made the image public, run `opscrew provision --public-image`: OpsCrew cannot see a package's visibility before the first build.",
    );
  }
  return new OpsCrewError(
    "PHASE_PRECONDITION",
    `OpsCrew cannot deploy to your Portainer yet, so it changed nothing:\n${reasons.map((reason) => `  - ${reason}`).join("\n")}`,
    {
      hint:
        hints.length > 0
          ? hints.join(" ")
          : "Fix what blocks these changes in Portainer, then run `opscrew provision` again.",
    },
  );
}

/** Stops on a stack plan with findings or blocked changes. */
function requireNoStackBlockers(plan: StackPlan): void {
  const blocked = plan.changes.filter((change) => change.state === "blocked");
  if (plan.findings.length > 0 || blocked.length > 0)
    throw portainerBlocked(plan.findings, blocked);
}

/**
 * Plain-English stack plan shown before the `stack-apply` approval: every change, its state and
 * reason, the findings, then the hash. No value, token, webhook or Portainer address.
 */
export function describeStackPlan(plan: StackPlan, hash: string, environment?: string): string {
  const count = (state: string) => plan.changes.filter((change) => change.state === state).length;
  const blocked = count("blocked");
  const where = environment === undefined ? "" : ` (environment "${environment}")`;
  const lines = [
    `Stack plan for your Portainer${where}: ${count("change")} to change, ${count("in-place")} already in place${blocked > 0 ? `, ${blocked} blocked` : ""}.`,
  ];
  for (const change of plan.changes) {
    if (change.state === "in-place") {
      lines.push(`  ✓ ${change.title} (already in place)`);
      continue;
    }
    lines.push(`  ${change.state === "change" ? "~" : "✗"} ${change.title}`);
    if (change.reason !== undefined) lines.push(`      ${change.reason}`);
  }
  for (const finding of plan.findings) {
    lines.push(`  ! ${finding.message}`, `      ${finding.hint}`);
  }
  lines.push(
    "OpsCrew sends the values of the app's variables, the webhook and the tokens only when it applies this plan; they are never shown or saved in a plan. It changes no other stack and never Portainer's own settings.",
    `Stack plan hash: ${hash}`,
  );
  return lines.join("\n");
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

/** Actions of a change that send the app stack's values (and the repository token). */
const SENDS_VALUES = new Set(["create", "update", "redeploy"]);

/** Whether the plan's changes send the repository token or the registry token. */
function sentTokens(plan: StackPlan): { repository: boolean; registry: boolean } {
  const changed = plan.changes.filter((change) => change.state === "change");
  return {
    repository: changed.some(
      (change) =>
        change.id === "app-stack" &&
        SENDS_VALUES.has(String(change.params.action)) &&
        change.params.repositoryAuthentication === true,
    ),
    registry: changed.some(
      (change) =>
        change.id === "registry" &&
        (change.params.action === "create" || change.params.action === "update"),
    ),
  };
}

const REPOSITORY_TOKEN_HINT = `Create a fine-grained token at https://github.com/settings/personal-access-tokens/new for only this repository with Contents: Read-only, set ${REPOSITORY_TOKEN_VAR} to it and run the command again. OpsCrew sends it only to your Portainer (for this stack) and never saves it.`;
const REGISTRY_TOKEN_HINT = `Create a classic token with only the read:packages scope at https://github.com/settings/tokens/new?scopes=read:packages, set ${REGISTRY_TOKEN_VAR} to it and run the command again (OpsCrew sends it only to your Portainer's registry entry and never saves it). If you made the image public on GitHub, run \`opscrew provision --public-image\` instead.`;

/** Stops plainly when a change sends a token that is not set (nothing in Portainer changed). */
function requireTokens(
  sends: { repository: boolean; registry: boolean },
  present: { repository: boolean; registry: boolean },
): void {
  if (sends.repository && !present.repository) {
    throw new OpsCrewError(
      "CREDENTIALS_MISSING",
      `Your repository is private, so Portainer needs a read-only token to fetch the ${DEPLOY_BRANCH} branch, and ${REPOSITORY_TOKEN_VAR} is not set. Nothing in Portainer was changed.`,
      { hint: REPOSITORY_TOKEN_HINT },
    );
  }
  if (sends.registry && !present.registry) {
    throw new OpsCrewError(
      "CREDENTIALS_MISSING",
      `The app's image on GitHub Container Registry is private, so Portainer needs a registry entry with a read-only token, and ${REGISTRY_TOKEN_VAR} is not set. Nothing in Portainer was changed.`,
      { hint: REGISTRY_TOKEN_HINT },
    );
  }
}

/** The stack step's outcome: the plan shown, and whether it was applied. */
export interface StackStepResult {
  plan: StackPlan;
  hash: string;
  applied: boolean;
  approval?: ApprovalRecord;
}

/** What {@link provisionPortainer} gets from the shared provision flow. */
export interface PortainerFlowInput {
  plan: DeployPlan;
  requirements: Requirements | undefined;
  git: GitClient;
  phase: Extract<PhaseName, "provision" | "dns">;
  /** The saved infrastructure plan the `--approve` hashes name (applied instead of planning). */
  approveHash?: string;
  /** The saved removal plan of an earlier Cloudflare setup the `--approve` hashes name. */
  approveRemovalHash?: string;
  /** Notes for the infrastructure approval, and the step that saves `opscrew dns`'s plan change. */
  extras?: { approvalNotes?: readonly string[]; ready?: () => Promise<void> };
}

function stringOutput(outputs: Record<string, unknown>, name: string): string | undefined {
  const value = outputs[name];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** True when the infrastructure plan creates or replaces a Cloudflare Tunnel (a new token). */
function makesTunnel(changes: readonly Pick<ResourceChange, "type" | "action">[]): boolean {
  return changes.some(
    (change) =>
      change.type === "cloudflare_zero_trust_tunnel_cloudflared" &&
      (change.action === "create" || change.action === "replace"),
  );
}

/** An approval as `opscrew/plan.yaml` keeps it (informational; the approval store is authoritative). */
function planApproval(record: ApprovalRecord, kind: "iac-apply" | "stack-apply") {
  return {
    planHash: record.planHash as string,
    approver: record.approver,
    at: record.decidedAt,
    kind,
  };
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
  const { git, phase } = input;
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
  const commits = !(
    options.planOnly &&
    input.approveHash === undefined &&
    input.approveRemovalHash === undefined
  );
  const deployBranch = !commits
    ? undefined
    : options.push !== false
      ? await chooseDeployBranch(deps, git, github, plan, phase)
      : { branch: await localDeployBranch(git, plan, phase) };
  await input.extras?.ready?.();
  const zoneLearned = cloudflare !== undefined && plan.dns.zone !== cloudflare.zoneName;
  if (cloudflare !== undefined && zoneLearned) {
    plan = { ...plan, dns: { ...plan.dns, zone: cloudflare.zoneName } };
    requireValidWithZone(deps, plan, command);
  }
  // Without a Cloudflare root, an earlier setup's Cloudflare resources in the state are removed
  // later in this run; that needs the Cloudflare token, so its absence stops here.
  let engine: IacEngine | undefined;
  const dir = join(root, plan.infra.dir);
  const engineEnv: Record<string, string | undefined> = { ...deps.env };
  delete engineEnv.TF_VAR_portainer_origin;
  // An earlier setup counts only while the state holds managed resources (a removal leaves an
  // empty state, encrypted or not); outputs alone are no infrastructure.
  let removal = false;
  if (!hasRoot) {
    const statePath = join(deps.paths.files.tfstateDir, STATE_FILE);
    const contents = await stateContents(deps, statePath, async () => {
      engine ??= await portainerEngine(deps, options, plan, engineEnv);
      return engine;
    });
    if (contents === "unknown") {
      // A state the engine cannot list: its outputs, if it can read them (an apply writes them).
      engine ??= await portainerEngine(deps, options, plan, engineEnv);
      const iacEngine = engine;
      const held = await infrastructureOutputs(deps, plan, {
        engine: async () => iacEngine,
        engineEnv,
      });
      removal = held !== undefined && Object.keys(held).length > 0;
    } else {
      removal = contents === "resources";
    }
    if (removal && !deps.env.CLOUDFLARE_API_TOKEN?.trim()) throw cloudflareTokenMissing(deps);
  }

  // 2. Connect with the pinned certificate, inspect read-only, stop on what blocks the deploy.
  const valueKey = await ensurePortainerValueKey(deps, portainerServices.randomBytes);
  const makeClient = portainerServices.client ?? portainerClient;
  const client: PortainerClient = makeClient(
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
  const routeChanges = removal || switchesWebRoute(facts, target, plan.app.name, connection);

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
  const placeholderBranch = {
    started: false,
    async start(cloudflareApplied: boolean): Promise<void> {
      if (this.started) return;
      await startDeployBranch(deps, { git, github, plan, phase, cloudflareApplied });
      this.started = true;
    },
  };

  // 3. Render and write the files (skipped when applying a saved plan: --plan-only wrote them).
  const access = cloudflareRoot.webhook
    ? {
        createZeroTrustOrganization: await createZeroTrustOrganization({
          api: portainerServices.zeroTrust ?? cloudflareZeroTrust(deps),
          accountId: (cloudflare as CloudflareSetup).accountId as string,
          zone: (cloudflare as CloudflareSetup).zoneName,
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
  if (input.approveHash === undefined && input.approveRemovalHash === undefined) {
    await writeFiles(deps, root, files);
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
  const values = async (outputs: Record<string, unknown>): Promise<StackValues> => {
    const env = await appEnvironment();
    const out: Record<string, string> = {};
    for (const key of keys.app) out[key] = env.values.app[key] ?? "";
    const db = parseDotenv(env.dbEnv ?? "");
    const opscrew: Record<string, string | undefined> = {
      [PORTAINER_STACK_VARIABLES.dbUser]: db.get("POSTGRES_USER"),
      [PORTAINER_STACK_VARIABLES.dbName]: db.get("POSTGRES_DB"),
      [PORTAINER_STACK_VARIABLES.dbPassword]: db.get("POSTGRES_PASSWORD"),
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
    // Host lists hold the domain, which OpsCrew's own messages show as usual.
    for (const [name, value] of Object.entries({ ...result.env, ...result.updaterEnv })) {
      if (value.length >= 8 && hostListKind(name) === undefined) {
        deps.redactor.addLiteral(value, name);
      }
    }
    return result;
  };
  const fingerprints = (stack: StackValues): DesiredValueFingerprints => {
    const tokens = valueFingerprints(valueKey, {
      repositoryToken: stack.repositoryToken ?? "",
      registryToken: stack.registryToken ?? "",
    });
    return {
      app: valueFingerprints(valueKey, stack.env),
      webhook: valueFingerprints(valueKey, { webhook: stack.webhookId }).webhook as string,
      ...(updater
        ? { updater: valueFingerprints(valueKey, stack.updaterEnv ?? {}) }
        : { connector: valueFingerprints(valueKey, { TUNNEL_TOKEN: stack.tunnelToken ?? "" }) }),
      repositoryToken: tokens.repositoryToken as string,
      registryToken: tokens.registryToken as string,
    };
  };

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
      title: `Apply the stack plan to your Portainer (${work.length} change${work.length === 1 ? "" : "s"})`,
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
      `Changing your Portainer (${work.length} change${work.length === 1 ? "" : "s"}; a stack's first deploy can take a few minutes)`,
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
      `Changed your Portainer (${result.applied.length} change${result.applied.length === 1 ? "" : "s"} applied).`,
    );
    return { plan: stackPlan, hash, applied: result.applied.length > 0, approval };
  };

  // 4. The infrastructure (Cloudflare only): plan → policies → iac-apply approval → apply. A plan
  // that deletes a tunnel whose connector runs in Portainer is applied after the stack change
  // that stops the connector (its own stack-apply approval) and Cloudflare reports it closed.
  // Without a Cloudflare root (web mode proxy or caddy with the updater), what an earlier setup
  // created in Cloudflare is removed: a removal plan (`plan -destroy`) of the configuration still
  // committed, then its files leave the repository.
  const approvals: { planHash: string; approver: string; at: string; kind: string }[] = [];
  let iac: PlanAndApplyResult = { applied: false, outputs: {} };
  const firstChange: { result?: StackStepResult } = {};
  if (hasRoot || removal) {
    engine ??= await portainerEngine(deps, options, plan, engineEnv);
    // The earlier configuration may declare it too, so a removal gets it as well.
    if (cloudflareRoot.webhook || removal) {
      // Portainer's address reaches the engine only as a sensitive variable, never in a file.
      const origin = portainerContainerUrl(connection.url);
      hidePortainerAddress(deps.redactor, origin);
      engineEnv.TF_VAR_portainer_origin = origin;
    }
    const iacEngine = engine;
    const currentOutputs = () => iacEngine.output(dir, { env: engineEnv }).catch(() => ({}));
    const first = connectorFirst(deps, {
      command,
      app: plan.app.name,
      where: "in your Portainer",
      hostChange: async () => {
        // The stack change that goes first may create the app stack: its branch must start first.
        if (createsAppStack) await placeholderBranch.start(false);
        const early = await stackStep(await currentOutputs(), false);
        firstChange.result = early;
        return {
          hash: early.hash,
          applied: early.applied,
          ...(early.approval !== undefined ? { approval: early.approval } : {}),
        };
      },
      hostHash: () => shownHash,
      done: "The change in your Portainer is applied (the Cloudflare Tunnel's connector is stopped); the Cloudflare Tunnel this plan deletes is still there.",
      ...(services.sleep !== undefined ? { sleep: services.sleep } : {}),
      ...(input.extras?.approvalNotes ? { notes: input.extras.approvalNotes } : {}),
    });
    const approvePlanHash = removal ? input.approveRemovalHash : input.approveHash;
    try {
      iac = await planAndApply(deps, {
        engine,
        dir,
        env: engineEnv,
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
    if (iac.approval) approvals.push(planApproval(iac.approval, "iac-apply"));
    const early = firstChange.result;
    if (early?.approval) approvals.push(planApproval(early.approval, "stack-apply"));
  }

  if (!commits) {
    const changes = iac.plan?.changes ?? [];
    if (removal && changes.length > 0) {
      deps.reporter.info(
        `Applying this removal also takes the Cloudflare configuration it removes out of the repository (${plan.infra.dir}/ and its modules), after its own approval.`,
      );
    }
    let stackHash: string | undefined;
    const outputs =
      engine === undefined
        ? {}
        : Object.keys(iac.outputs).length > 0
          ? iac.outputs
          : await engine.output(dir, { env: engineEnv }).catch(() => ({}));
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
    if (tokensKnown && !makesTunnel(changes)) {
      stackHash = (await stackStep(outputs, true)).hash;
    } else {
      deps.reporter.info(
        "The stack plan for your Portainer follows once this infrastructure plan is applied, because it needs the Cloudflare Tunnel's token. Applying it shows the stack plan and asks for its approval separately (in scripts: run with `--approve` and this hash, then again with `--approve` and the stack plan's hash).",
      );
    }
    if (changes.length > 0 && deletesTunnel(changes) && stackHash !== undefined) {
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
    if (zoneLearned) await writeArtifact("plan", deps.paths.files.plan, plan);
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
  const now = deps.clock.now().toISOString();
  const outputs =
    engine === undefined
      ? {}
      : Object.keys(iac.outputs).length > 0
        ? iac.outputs
        : await engine.output(dir, { env: engineEnv }).catch(() => ({}));
  const url = plan.dns.domain !== undefined ? `https://${plan.dns.domain}` : undefined;
  const { destroyedAt: _destroyedAt, url: _url, ...previousDeployment } = plan.deployment;
  const before = plan;
  const record = (stackApplied: boolean): DeployPlan => ({
    ...before,
    updatedAt: now,
    approvals: [...before.approvals, ...approvals],
    deployment: {
      ...previousDeployment,
      ...(url !== undefined ? { url } : {}),
      ...(iac.planHash && iac.applied ? { lastPlanHash: iac.planHash } : {}),
      ...(iac.applied || stackApplied ? { lastApplyAt: now } : {}),
    },
  });
  const earlyApplied = firstChange.result?.applied === true;
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
  if (createsAppStack) await placeholderBranch.start(iac.applied);

  // 7. The stack plan → stack-apply approval → apply → record.
  const stack = await stackStep(outputs, false);
  if (stack.approval) approvals.push(planApproval(stack.approval, "stack-apply"));
  const stackApplied = stack.applied || earlyApplied;
  plan = record(stackApplied);
  await writeArtifact("plan", deps.paths.files.plan, plan);

  // 8. The deploy secrets: the build's values, and the webhook through Cloudflare Access.
  let secretsStored = false;
  const where = { host: PORTAINER_SECRETS_RECORD, owner: github.owner, repo: github.repo };
  if (options.secrets !== false) {
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
    secretsStored = true;
  } else {
    secretsStored = await deploySecretsStoredFor(deps, where);
    if (!secretsStored) {
      deps.reporter.warn(
        "The deploy secrets are not stored in GitHub Actions for this app yet, so a deploy would fail. Before merging the pull request, run `opscrew provision` in a terminal in the project directory to store them.",
      );
    }
  }

  // 9. Commit, push and open the pull request.
  plan = { ...plan, deployment: { ...plan.deployment, lastCompletedPhase: "provision" } };
  await writeArtifact("plan", deps.paths.files.plan, plan);
  const published = await publishDeploySetup(deps, {
    git,
    github,
    plan,
    paths: [
      ...files.map((f) => f.path),
      ...removedFiles,
      toPosixRelative(root, deps.paths.files.plan),
    ],
    push: options.push !== false,
    secretsStored,
    phase,
    ...(deployBranch === undefined ? {} : { branch: deployBranch }),
  });
  const dns = portainerDnsRecordNote(plan);
  if (dns !== undefined) deps.reporter.info(dns);
  if (routeChanges) deps.reporter.warn(ROUTE_CHANGE_NOTE);
  deps.reporter.info(`${PORTAINER_HOST_NOTE} ${PORTAINER_BACKUPS_NOTE}`);
  if (secretsStored) {
    deps.reporter.info(
      published.prUrl
        ? `Merging ${published.prUrl} deploys the app.`
        : `Merging ${published.branch} into ${plan.cicd.branch} deploys the app.`,
    );
  }
  return {
    ...(iac.planHash ? { planHash: iac.planHash } : {}),
    applied: iac.applied,
    stackPlanHash: stack.hash,
    stackApplied,
    outputs: publicOutputs(outputs),
    branch: published.branch,
    ...(published.prUrl ? { prUrl: published.prUrl } : {}),
  };
}

/** Said when this run changes how visitors reach an app that already runs in Portainer. */
export const ROUTE_CHANGE_NOTE =
  "Visitors cannot reach the site on its new route until you merge the deploy pull request (the deploy workflow then writes the new stack file to the opscrew-deploy branch, which Portainer deploys) and your DNS or reverse proxy points at the new route.";

/**
 * True when the app's stack already exists (OpsCrew's record lists it) and this plan serves it
 * another way than it was last set up: by the recorded route (`appliedWeb`: the web mode, and the
 * port for `proxy`), else, for a record from before it was kept, by what Portainer shows (the
 * stack has the app tunnel's token and the plan no tunnel, or the other way round; for
 * administrators, who see the published ports, Caddy's 80 and 443 or the proxy's port missing).
 */
export function switchesWebRoute(
  facts: PortainerFacts,
  target: PortainerDeployTarget,
  app: string,
  connection: PortainerConnection,
): boolean {
  const recorded = connection.created.stacks.find((stack) => stack.role === "app");
  if (recorded === undefined) return false;
  if (connection.appliedWeb !== undefined) return !sameWeb(connection.appliedWeb, target.web);
  const stack = facts.stacks.find((item) => item.id === recorded.id);
  if (stack === undefined) return false;
  const wasTunnel = stack.envKeys.includes(PORTAINER_STACK_VARIABLES.tunnelToken);
  const isTunnel = target.web.mode === "tunnel";
  if (wasTunnel !== isTunnel) return true;
  if (target.web.mode === "tunnel" || facts.publishedPorts === undefined) return false;
  const project = opscrewNames(app).app;
  const ports = new Set(
    facts.publishedPorts
      .filter((item) => item.project?.toLowerCase() === project)
      .map((item) => item.port),
  );
  if (ports.size === 0) return false;
  return target.web.mode === "caddy"
    ? !(ports.has(80) && ports.has(443))
    : !ports.has(target.web.port);
}

/** The same web route: the same mode, and for `proxy` the same port. */
function sameWeb(a: PortainerWeb, b: PortainerWeb): boolean {
  if (a.mode !== b.mode) return false;
  return a.mode !== "proxy" || (b.mode === "proxy" && a.port === b.port);
}

/** True when the record lists the app's stack. */
function hasAppStack(created: Pick<CreatedRecord, "stacks">): boolean {
  return created.stacks.some((stack) => stack.role === "app");
}

/** What is done when the deploy secrets cannot be stored: the stacks are already set up. */
const STACKS_SET_UP =
  "The app's stacks are set up in your Portainer; only the deploy secrets are not stored yet.";

/** Sensitive root-module outputs of a Portainer root: never returned or printed. */
const SENSITIVE_OUTPUTS = new Set([
  "tunnel_token",
  "portainer_tunnel_token",
  "deploy_service_token_client_id",
  "deploy_service_token_client_secret",
]);

function publicOutputs(outputs: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(outputs).filter(([name]) => !SENSITIVE_OUTPUTS.has(name)),
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

/** Stops when asked to replace a token there is none of, before anything changes. */
function requireReplaceable(
  options: ProvisionOptions,
  repositoryPrivate: boolean,
  imagePrivate: boolean,
): void {
  if (options.replaceTokens?.repository === true && !repositoryPrivate) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      "Your repository is public, so Portainer fetches it without a token and there is no repository token to replace. Nothing was changed.",
      { hint: "Run the command without replacing the repository token." },
    );
  }
  if (options.replaceTokens?.registry === true && !imagePrivate) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      "The app's image is public, so Portainer pulls it without a registry entry and there is no registry token to replace. Nothing was changed.",
      { hint: "Run the command without replacing the registry token." },
    );
  }
}

/**
 * Records in `server.json` → `portainer` what OpsCrew created in Portainer (`created`), the
 * image's visibility the stacks were set up with (`publicImage`) and the web route of the app's
 * stack (`appliedWeb`); unchanged fields stay.
 */
async function recordConnection(
  deps: Pick<PhaseDeps, "paths">,
  connection: PortainerConnection,
  update: { created?: CreatedRecord; publicImage?: boolean; appliedWeb?: PortainerWeb },
): Promise<PortainerConnection> {
  const { created, publicImage, appliedWeb } = update;
  const next: PortainerConnection = {
    ...connection,
    ...(created !== undefined
      ? {
          created: {
            stacks: created.stacks.map((stack) => ({ ...stack })),
            ...(created.registryId !== undefined ? { registryId: created.registryId } : {}),
            volumes: [...created.volumes],
          },
        }
      : {}),
    ...(publicImage !== undefined ? { publicImage } : {}),
    ...(appliedWeb !== undefined ? { appliedWeb: { ...appliedWeb } } : {}),
  };
  const same =
    created === undefined &&
    (publicImage === undefined || connection.publicImage === publicImage) &&
    (appliedWeb === undefined ||
      (connection.appliedWeb !== undefined && sameWeb(connection.appliedWeb, appliedWeb)));
  if (!same) await recordPortainerConnection(deps.paths, next);
  return next;
}

/** True when GitHub has the deploy branch (read through git, which reaches the repository). */
async function deployBranchExists(git: GitClient): Promise<boolean> {
  try {
    return (await git.remoteBranchSha(DEPLOY_BRANCH)) !== undefined;
  } catch (error) {
    if (!isUserFacingError(error)) throw error;
    throw new OpsCrewError(
      "PROVIDER_ERROR",
      `OpsCrew could not check GitHub for the ${DEPLOY_BRANCH} branch, which Portainer deploys the app from. Nothing in Portainer was changed.`,
      {
        hint: "Check that this computer can reach GitHub (`git ls-remote origin`), then try again.",
      },
    );
  }
}

/**
 * The only branch the Portainer flows create, replace or delete: `opscrew-deploy`
 * (`refs/heads/opscrew-deploy`). Any other name is refused before GitHub is called.
 */
export function requireDeployBranch(branch: string): typeof DEPLOY_BRANCH {
  if (branch !== DEPLOY_BRANCH) {
    throw new OpsCrewError(
      "INTERNAL",
      `OpsCrew changes only the branch ${DEPLOY_BRANCH} of the app's repository here, never ${JSON.stringify(branch)}.`,
      { hint: "This is a bug in OpsCrew: please report it with the command you ran." },
    );
  }
  return DEPLOY_BRANCH;
}

/**
 * Where the deploy branch stands: `absent`, holding exactly the placeholder (`placeholder`: one
 * commit without parents and only its file, read through the GitHub client; without that read an
 * existing branch counts as `other`), or holding anything else (`other`).
 */
async function deployBranchState(
  git: GitClient,
  github: GitHubSetup,
  plan: DeployPlan,
): Promise<"absent" | "placeholder" | "other"> {
  if (!(await deployBranchExists(git))) return "absent";
  const { api } = github;
  if (api.branchHoldsOnly === undefined) return "other";
  const placeholder = renderPlaceholderStack(plan);
  const only = await api.branchHoldsOnly(
    github.owner,
    github.repo,
    requireDeployBranch(DEPLOY_BRANCH),
    { path: placeholder.path, content: placeholder.content },
  );
  return only ? "placeholder" : "other";
}

/**
 * Starts the deploy branch with the placeholder stack file before the app's stack is created
 * (research R11): Portainer deploys a Git stack as soon as it is created, before the first image
 * exists. A missing branch is created; one that exists already (left by an earlier deployment,
 * perhaps of another setup, whose stack file Portainer would otherwise deploy as it is) is pointed
 * at a new commit holding only the placeholder (the ref is force-updated; its earlier commits leave
 * the branch). Either way behind its own `git-push` approval, and only for `refs/heads/opscrew-deploy`.
 */
async function startDeployBranch(
  deps: PhaseDeps,
  input: {
    git: GitClient;
    github: GitHubSetup;
    plan: DeployPlan;
    phase: Extract<PhaseName, "provision" | "dns">;
    /** The Cloudflare plan was applied in this run (said when the user refuses). */
    cloudflareApplied: boolean;
  },
): Promise<void> {
  const { github, plan } = input;
  const { api } = github;
  const state = await deployBranchState(input.git, github, plan);
  if (state === "placeholder") {
    // An earlier run of this setup already started it (for example its stack-apply was refused).
    deps.reporter.info(
      `The branch ${DEPLOY_BRANCH} already holds only the placeholder ${DEPLOY_COMPOSE_FILE}; it stays as it is.`,
    );
    return;
  }
  const replace = state === "other";
  const placeholder = renderPlaceholderStack(plan);
  const repo = `${github.owner}/${github.repo}`;
  const nothingYet = input.cloudflareApplied
    ? "The Cloudflare changes are applied; nothing in Portainer was changed."
    : "Nothing in Portainer was changed.";
  const approval = await deps.approvals.request({
    kind: "git-push",
    title: replace
      ? `Replace the branch ${DEPLOY_BRANCH} in ${repo} with a placeholder ${DEPLOY_COMPOSE_FILE}`
      : `Create the branch ${DEPLOY_BRANCH} in ${repo} with a placeholder ${DEPLOY_COMPOSE_FILE}`,
    details: [
      replace
        ? `Portainer builds the app's stack from the ${DEPLOY_BRANCH} branch, which still holds the stack file of an earlier deployment (perhaps of another setup), and the stack is created anew. So that Portainer does not start that file, OpsCrew points the branch at a new commit holding only this placeholder (its earlier commits leave the branch), which runs one small container that only sleeps (no ports, no secrets) until the deploy workflow's next run writes the app:`
        : `Portainer builds the app's stack from the ${DEPLOY_BRANCH} branch. Until the deploy workflow's first run writes the app there, the branch holds only this placeholder, which runs one small container that only sleeps (no ports, no secrets):`,
      "",
      placeholder.content,
    ].join("\n"),
  });
  if (!approval.approved) {
    throw new OpsCrewError(
      "APPROVAL_REFUSED",
      replace
        ? `The ${DEPLOY_BRANCH} branch was not replaced, so OpsCrew does not create the app's stack in Portainer from its earlier file. ${nothingYet}`
        : `The ${DEPLOY_BRANCH} branch was not created, so OpsCrew cannot create the app's stack in Portainer. ${nothingYet}`,
      { hint: `Run \`opscrew ${input.phase}\` again when you are ready; it continues from here.` },
    );
  }
  const change = {
    owner: github.owner,
    repo: github.repo,
    branch: requireDeployBranch(DEPLOY_BRANCH),
    path: placeholder.path,
    content: placeholder.content,
    message: "OpsCrew: placeholder until the first deploy",
  };
  let detail: string;
  if (replace) {
    if (api.replaceOrphanBranch === undefined) {
      throw new OpsCrewError("INTERNAL", "The GitHub client cannot replace a branch.");
    }
    const replaced = await api.replaceOrphanBranch(change);
    detail = `placeholder ${replaced.commit}, replacing ${replaced.previous}`;
  } else {
    if (api.createOrphanBranch === undefined) {
      throw new OpsCrewError("INTERNAL", "The GitHub client cannot create a branch.");
    }
    detail = `placeholder ${(await api.createOrphanBranch(change)).commit}`;
  }
  await deps.audit.append({
    kind: "git",
    actor: "opscrew",
    action: "push",
    phase: input.phase,
    target: `${repo}:${DEPLOY_BRANCH}`,
    decision: "approved",
    detail,
  });
  deps.reporter.success(
    replace
      ? `Replaced the branch ${DEPLOY_BRANCH} with a placeholder ${DEPLOY_COMPOSE_FILE}; the deploy workflow's next run writes the app there.`
      : `Created the branch ${DEPLOY_BRANCH} with a placeholder ${DEPLOY_COMPOSE_FILE}.`,
  );
}

/** DNS record types that point a host name at a server, by their type code. */
const ADDRESS_RECORD_TYPES = [
  ["A", 1],
  ["AAAA", 28],
  ["CNAME", 5],
] as const;
const ADDRESS_TYPE_CODES = new Set<number>(ADDRESS_RECORD_TYPES.map(([, code]) => code));
/** NOERROR and NXDOMAIN; any other status (SERVFAIL, REFUSED …) is a failed lookup. */
const DNS_NOERROR = 0;
const DNS_NXDOMAIN = 3;
const DNS_LOOKUP_TIMEOUT_MS = 15_000;

const DnsJsonResponse = z.looseObject({
  Status: z.number().int(),
  Answer: z
    .array(z.looseObject({ name: z.string(), type: z.number().int(), data: z.string() }))
    .nullish(),
});

function hostName(name: string): string {
  return name.trim().toLowerCase().replace(/\.$/, "");
}

/** What a public resolver says about a host name's A, AAAA and CNAME records right now. */
export type AddressRecordLookup =
  | { state: "found" }
  | { state: "missing" }
  | { state: "unknown"; problem: string };

/**
 * Whether `host` has an A, AAAA or CNAME record, asked read-only of Cloudflare's public resolver
 * over DNS over HTTPS (`application/dns-json`), one type after the other. NXDOMAIN means no record
 * of any type. A failed or unreadable lookup is `unknown`, never taken as an answer.
 */
export async function lookupAddressRecord(
  fetch: FetchLike,
  host: string,
): Promise<AddressRecordLookup> {
  const name = hostName(host);
  for (const [type] of ADDRESS_RECORD_TYPES) {
    const url = `${DNS_OVER_HTTPS_URL}?${new URLSearchParams({ name, type })}`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers: { accept: "application/dns-json" },
        signal: AbortSignal.timeout(DNS_LOOKUP_TIMEOUT_MS),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { state: "unknown", problem: `the request failed: ${reason}` };
    }
    if (!response.ok) return { state: "unknown", problem: `HTTP ${response.status}` };
    const parsed = DnsJsonResponse.safeParse(await response.json().catch(() => undefined));
    if (!parsed.success) return { state: "unknown", problem: "an unexpected answer" };
    const { Status, Answer } = parsed.data;
    if (Status === DNS_NXDOMAIN) return { state: "missing" };
    if (Status !== DNS_NOERROR) {
      return { state: "unknown", problem: `the resolver answered with DNS status ${Status}` };
    }
    const found = (Answer ?? []).some(
      (answer) => ADDRESS_TYPE_CODES.has(answer.type) && hostName(answer.name) === name,
    );
    if (found) return { state: "found" };
  }
  return { state: "missing" };
}

const DeletedRecordJson = z.looseObject({
  type: z.literal("cloudflare_dns_record"),
  change: z.looseObject({
    actions: z.array(z.string()),
    before: z.looseObject({ name: z.string().optional() }).nullish(),
  }),
});

/**
 * The site's host names whose DNS records the Cloudflare plan deletes (the Cloudflare Tunnel's
 * routes): by the host name their addresses are keyed with (`…route["shop.example.com"]`), or by
 * the record's name in the plan JSON. Right after such a deletion a public resolver may still
 * answer from its cache, so these names count as without a record.
 */
function deletedRecordHosts(
  saved: Pick<SavedPlan, "changes" | "planJson"> | undefined,
  hosts: readonly string[],
  zone: string | undefined,
): string[] {
  if (saved === undefined) return [];
  const names = new Set<string>();
  const apex = zone === undefined ? undefined : hostName(zone);
  // A record's name is its full host name, or one relative to the zone (`@` for the apex).
  const add = (name: string) => {
    const host = hostName(name);
    if (host === "@") {
      if (apex !== undefined) names.add(apex);
      return;
    }
    names.add(host);
    if (apex !== undefined && host !== apex && !host.endsWith(`.${apex}`)) {
      names.add(`${host}.${apex}`);
    }
  };
  for (const change of saved.changes) {
    if (change.type !== "cloudflare_dns_record" || change.action !== "delete") continue;
    const key = /\["([^"]+)"\]$/.exec(change.address)?.[1];
    if (key !== undefined) add(key);
  }
  const list = (saved.planJson as { resource_changes?: unknown } | null | undefined)
    ?.resource_changes;
  for (const entry of Array.isArray(list) ? list : []) {
    const parsed = DeletedRecordJson.safeParse(entry);
    if (!parsed.success) continue;
    const { actions, before } = parsed.data.change;
    if (!actions.includes("delete") || actions.includes("create")) continue;
    if (before?.name !== undefined) add(before.name);
  }
  return hosts.filter((host) => names.has(hostName(host)));
}

const RECORD_TO_CREATE =
  "an A record (and AAAA for IPv6) for {hosts} to your Portainer host's public address, or a CNAME to its dynamic-DNS name";

/**
 * Said by `--plan-only` in web mode `caddy`: the record must exist before Caddy starts, and when
 * the plan deletes the Cloudflare Tunnel's records there, the user creates it once it is applied.
 */
function caddyRecordNote(
  plan: DeployPlan,
  command: string,
  deleted: readonly string[],
): string | undefined {
  const hosts = siteHosts(plan);
  if (hosts.length === 0) return undefined;
  const one = hosts.length === 1;
  const note = [
    `Before Caddy starts, ${hosts.join(" and ")} must have a DNS record that points at your Portainer host (an A record, and AAAA for IPv6, to its public address, or a CNAME to its dynamic-DNS name): applying checks ${one ? "it" : "them"} through a public resolver and stops before ${deleted.length > 0 ? "Caddy can start" : "the app's stack changes"} until ${one ? "it resolves" : "they resolve"}, so Caddy gets ${one ? "its certificate" : "their certificates"} at once.`,
  ];
  if (deleted.length > 0) {
    note.push(
      `This plan deletes the Cloudflare Tunnel's record${deleted.length === 1 ? "" : "s"} for ${deleted.join(" and ")}, so create yours once it is applied; the next \`${command}\` then continues.`,
    );
  }
  return note.join(" ");
}

/**
 * Web mode `caddy`: stops unless every host of the site has an A, AAAA or CNAME record that a
 * public resolver sees (`deleted` hosts lost theirs in this run and count as without one), before
 * anything starts Caddy. `done` says what this run already applied.
 */
async function requireCaddyRecords(
  deps: Pick<PhaseDeps, "fetch" | "reporter" | "redactor">,
  input: { plan: DeployPlan; command: string; deleted: readonly string[]; done: string },
): Promise<void> {
  const hosts = siteHosts(input.plan);
  if (hosts.length === 0) return;
  const { command, deleted, done } = input;
  deps.reporter.step(
    `Checking that ${hosts.join(" and ")} ${hosts.length === 1 ? "has a DNS record" : "have DNS records"} before Caddy starts (a public resolver, read-only)`,
  );
  const missing: string[] = [];
  for (const host of hosts) {
    if (deleted.includes(host)) {
      missing.push(host);
      continue;
    }
    const lookup = await lookupAddressRecord(deps.fetch, host);
    if (lookup.state === "found") continue;
    if (lookup.state === "missing") {
      missing.push(host);
      continue;
    }
    throw new OpsCrewError(
      "PROVIDER_ERROR",
      deps.redactor.redact(
        `OpsCrew could not check through a public resolver whether ${host} has a DNS record (${lookup.problem}), so it stopped here, before Caddy can start. ${done}`,
      ),
      {
        hint: `Check that this computer can reach ${DNS_OVER_HTTPS_URL}, then run \`${command}\` again: it continues from there.`,
      },
    );
  }
  if (missing.length === 0) {
    deps.reporter.success(
      `${hosts.join(" and ")} ${hosts.length === 1 ? "has a DNS record" : "have DNS records"}; Caddy can get ${hosts.length === 1 ? "its certificate" : "their certificates"}.`,
    );
    return;
  }
  const one = missing.length === 1;
  const names = missing.join(" and ");
  const why = missing.some((host) => deleted.includes(host))
    ? ` (the Cloudflare changes above deleted the Cloudflare Tunnel's record${one ? "" : "s"} there)`
    : " (a public resolver finds no A, AAAA or CNAME record)";
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    `${names} ${one ? "has" : "have"} no DNS record that points at your Portainer host yet${why}. Caddy asks Let's Encrypt for ${one ? "its certificate" : "their certificates"} as soon as it starts; without the record that request fails, and the failure can stay cached for up to 30 minutes. So OpsCrew stopped here, before Caddy can start. ${done}`,
    {
      hint: `Create ${RECORD_TO_CREATE.replace("{hosts}", names)}, then run \`${command}\` again: it continues from there. A new record can take a few minutes to show in public resolvers.`,
    },
  );
}

/** The committed Cloudflare configuration of a Portainer root: its directory and the modules. */
function staleRootDirs(plan: DeployPlan): [string, string] {
  const dir = plan.infra.dir.replace(/\\/g, "/").replace(/\/+$/, "");
  return [dir, `${posix.dirname(dir)}/modules`];
}

/**
 * Files of the earlier Cloudflare configuration that are deleted in the working copy but still
 * committed: an earlier run removed them (after its approval) and stopped before its commit.
 */
async function uncommittedRemovals(deps: PhaseDeps, plan: DeployPlan): Promise<string[]> {
  const listed = await deps.runner.run("git", [
    "-C",
    deps.paths.root,
    "ls-files",
    "--deleted",
    "--",
    ...staleRootDirs(plan),
  ]);
  if (listed.exitCode !== 0) return [];
  return listed.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/**
 * After the removal of an earlier Cloudflare setup: takes its committed configuration (the root
 * module under `plan.infra.dir` and the vendored modules beside it) out of the repository, after a
 * `repo-write` approval that lists the files. Returns the removed paths (relative, for the commit).
 */
async function removeStaleRoot(deps: PhaseDeps, plan: DeployPlan): Promise<string[]> {
  const [dir, modules] = staleRootDirs(plan);
  const listed = await deps.runner.run("git", [
    "-C",
    deps.paths.root,
    "ls-files",
    "--",
    dir,
    modules,
  ]);
  const paths = listed.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (listed.exitCode !== 0 || paths.length === 0) return [];
  const approval = await deps.approvals.request({
    kind: "repo-write",
    title: `Remove the Cloudflare configuration this setup no longer uses from the repository (${paths.length} file${paths.length === 1 ? "" : "s"})`,
    details: paths.map((path) => `  removed  ${path}`).join("\n"),
  });
  if (!approval.approved) {
    deps.reporter.warn(
      `The Cloudflare configuration under ${dir}/ stays in the repository although nothing in Cloudflare uses it any more; remove it yourself when you are ready.`,
    );
    return [];
  }
  for (const path of paths) await rm(join(deps.paths.root, path), { force: true });
  deps.reporter.success(
    `Removed ${paths.length} file${paths.length === 1 ? "" : "s"} of the earlier Cloudflare configuration.`,
  );
  return paths;
}

/** Writes the rendered files after a `repo-write` approval that lists them (only what changed). */
async function writeFiles(
  deps: PhaseDeps,
  root: string,
  files: readonly RenderedFile[],
): Promise<void> {
  const diff = await diffRenderedFiles(root, files);
  const toWrite = [...diff.created, ...diff.changed];
  if (toWrite.length === 0) return;
  const approval = await deps.approvals.request({
    kind: "repo-write",
    title: `Write the deployment files to the repository (${describeDiff(diff)})`,
    details: [
      ...diff.created.map((f) => `  new      ${f.path}`),
      ...diff.changed.map((f) => `  changed  ${f.path}`),
    ].join("\n"),
  });
  if (!approval.approved) {
    throw new OpsCrewError("APPROVAL_REFUSED", "Nothing was written and nothing was created.");
  }
  await writeRenderedFiles(root, toWrite);
  deps.reporter.success(`Wrote ${describeDiff(diff)}.`);
}

/** The IaC engine with the project's state encryption (OpenTofu), as for every target. */
async function portainerEngine(
  deps: PhaseDeps,
  options: ProvisionOptions,
  plan: DeployPlan,
  engineEnv: Record<string, string | undefined>,
): Promise<IacEngine> {
  const preference = options.engine ?? plan.infra.engine;
  const engine = options.services?.engine
    ? await options.services.engine(preference)
    : await selectEngine(preference, {
        runner: deps.runner,
        env: deps.env,
        redactor: deps.redactor,
        now: () => deps.clock.now(),
      });
  deps.reporter.info(`Using ${engineLabel(engine.info.name)} ${engine.info.version}.`);
  if (plan.infra.stateEncryption) {
    if (engine.info.name === "tofu") {
      const passphrase = await ensureStatePassphrase(deps.paths);
      deps.redactor.addLiteral(passphrase, "state-passphrase");
      engineEnv.TF_ENCRYPTION = tofuEncryptionEnv(passphrase);
    } else {
      deps.reporter.warn(
        "Terraform cannot encrypt its state; .opscrew/tfstate stays unencrypted on this computer. Keep it private (it is git-ignored).",
      );
    }
  }
  return engine;
}

/** Stops when the plan is not valid in the Cloudflare zone just learned (nothing changed yet). */
function requireValidWithZone(deps: PhaseDeps, plan: DeployPlan, command: string): void {
  const parsed = DeployPlanSchema.safeParse(plan);
  if (parsed.success) return;
  const issue = parsed.error.issues[0];
  const field = issue?.path.join(".") || "plan";
  throw new OpsCrewError(
    "ARTIFACT_INVALID",
    deps.redactor.redact(
      `opscrew/plan.yaml cannot be provisioned in the Cloudflare zone ${plan.dns.zone}: ${field} ${issue?.message ?? "is not valid"}. Nothing was changed.`,
    ),
    { hint: `Fix the field shown above in opscrew/plan.yaml, then run \`${command}\` again.` },
  );
}
