import { access, rm, rmdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { GitClient } from "@opscrew/connector-github";
import type {
  ApprovalRecord,
  AuditInput,
  IacEngine,
  RemoteExec,
  VpsProviderId,
} from "@opscrew/contracts";
import { OpsCrewError, tfstateFile, toPosixRelative } from "@opscrew/core";
import type { EnginePreference } from "@opscrew/iac-engine";
import {
  type InfraLayout,
  type MoveLayoutName,
  moveLayout,
  type RenderedFile,
  renderDeployment,
} from "@opscrew/iac-templates";
import {
  type DeployPlan,
  type Requirements,
  type Retarget,
  writeArtifact,
} from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { builderBranch } from "../environments/branches";
import { providerProfile } from "../providers";
import {
  type CloudflareSetup,
  checkProvider,
  committedTfvars,
  deploymentRenderContext,
  type GitHubSetup,
  type OwnRenderInput,
  ownRenderFromTfvars,
  readRequirements,
  setupCloudflare,
  setupGitHub,
} from "../provision";
import { recordedEdge, withCloudflareZone } from "../provision/render";
import { planWhere } from "../runners/words";
import {
  approvalEntry,
  confirmChangedHostKey,
  type DeployKey,
  deployKeyMissing,
  diffRenderedFiles,
  ensureDeployKey,
  existingStateEngine,
  githubClientFromToken,
  hasState,
  infrastructureOutputs,
  pinHostKey,
  providerConsole,
  readOutputsAfterInit,
  requireGitRepo,
  type ServerAddress,
  SshRemoteExec,
  stateCopyPaths,
  stateNotHere,
  writeRenderedFiles,
} from "../shared";
import { previousTarget } from "./layouts";
import { loadMoveServers, type MoveServers, recordMoveServers, unknownNewServer } from "./servers";
import type { RetargetGitHubApi, RetargetServices } from "./types";

/** Everything the steps of one run share: credentials checked, engine ready, files rendered. */
export interface MoveSession {
  deps: PhaseDeps;
  services: RetargetServices;
  /** The plan as last written to `opscrew/plan.yaml`. */
  plan: DeployPlan;
  requirements: Requirements | undefined;
  git: GitClient;
  github: GitHubSetup;
  githubApi: RetargetGitHubApi;
  cloudflare: CloudflareSetup | undefined;
  engine: IacEngine;
  /** Engine environment: provider tokens and `TF_ENCRYPTION`. Never logged. */
  env: Record<string, string | undefined>;
  deployKey: DeployKey;
  /** Absolute root module directory. */
  dir: string;
  /** The command that continues after a stop (`opscrew retarget`, `… --finish`, `… --abort`). */
  command: string;
  /** `--approve <hash>` until a step used it. */
  approve: string | undefined;
  /** The servers' addresses, from OpsCrew's local state (never from `opscrew/plan.yaml`). */
  servers: MoveServers;
  /**
   * The render inputs of the committed `terraform.tfvars.json` (the one-time PIN login's id with
   * Portainer on a subdomain): the move renders with them, as the last provision did.
   */
  committedRender: OwnRenderInput;
  /** A promoted plan's builder's branch (`builderBranch`), which its workflow checks. */
  builderBranch: string | undefined;
  /**
   * The app's site as the last provision left it (its origin TLS and additions) and the origin TLS
   * values: the new server gets the same certificates, with the same deploy secret.
   */
  site: Awaited<ReturnType<typeof recordedEdge>>;
}

/**
 * What reaching the servers and recording the move needs, without credentials or engine: enough
 * to start the old app again before anything else is checked.
 */
export type MoveBase = Pick<
  MoveSession,
  "deps" | "plan" | "services" | "deployKey" | "servers" | "command"
>;

/**
 * The {@link MoveBase} of a recorded move, before its session opens (no provider token needed):
 * the deploy key, and the servers from the local record, else from the infrastructure state.
 */
export async function moveBase(
  deps: PhaseDeps,
  plan: DeployPlan,
  input: { command: string; services: RetargetServices; engine?: EnginePreference },
): Promise<MoveBase> {
  const { command, services } = input;
  return {
    deps,
    plan,
    services,
    command,
    deployKey: await readDeployKey(deps, command),
    servers: await loadMoveServers(deps, plan, command, () =>
      infrastructureOutputs(deps, plan, {
        ...(services.engine ? { engine: services.engine } : {}),
        ...(input.engine !== undefined ? { preference: input.engine } : {}),
      }),
    ),
  };
}

/** Stops unless the infrastructure state is on this computer. */
export async function requireState(deps: PhaseDeps, plan: DeployPlan): Promise<void> {
  if (await hasState(deps.paths)) return;
  const { folder, passphrase } = stateCopyPaths(plan);
  const { flag } = await planWhere(deps.paths.root, plan);
  throw stateNotHere(
    plan,
    "move the deployment",
    `Run OpsCrew on the computer that ran \`opscrew provision${flag}\`, or copy its ${folder} folder (and, with OpenTofu, the state passphrase from ${passphrase}) here, then try again.`,
  );
}

/** The project's deploy key; stops when it is not on this computer (it is never created here). */
async function readDeployKey(deps: PhaseDeps, command: string): Promise<DeployKey> {
  try {
    await access(deps.paths.files.deployKey);
    await access(deps.paths.files.deployKeyPub);
  } catch {
    throw deployKeyMissing(
      deps.paths,
      "cannot reach the servers. Nothing was changed.",
      `then run \`${command}\` again.`,
    );
  }
  return ensureDeployKey(deps.paths, deps.redactor);
}

/** The remote shell for `host`: the injected one, else SSH with the deploy key and pinned keys. */
export function remoteFor(
  deps: PhaseDeps,
  services: RetargetServices,
  keyFile: string,
  host: string,
): RemoteExec {
  return (
    services.remote?.(host) ??
    new SshRemoteExec({
      host,
      keyFile,
      knownHostsFile: deps.paths.files.knownHosts,
      runner: deps.runner,
    })
  );
}

/** The injected sleep and monotonic clock for wait loops, when given. */
export function waitsOf(services: RetargetServices): {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
} {
  return {
    ...(services.sleep ? { sleep: services.sleep } : {}),
    ...(services.now ? { now: services.now } : {}),
  };
}

/** The GitHub API: the injected one, else a client from the user's token (`null`: none found). */
async function githubApiOf(
  deps: PhaseDeps,
  services: RetargetServices,
): Promise<RetargetGitHubApi | null> {
  if (services.github !== undefined) return services.github;
  return (await githubClientFromToken(deps)) ?? null;
}

export interface OpenSessionInput {
  command: string;
  /** Providers whose tokens must work: both servers' providers. */
  providers: readonly VpsProviderId[];
  engine?: EnginePreference;
  approvePlanHash?: string;
  services: RetargetServices;
  /** The servers when the caller knows them (a new move, or read before the session opened). */
  servers?: MoveServers;
  /**
   * `--finish`: the old server's address may be unknown (it may already be deleted); the finish
   * stops itself when there is still something of it to delete.
   */
  oldServerOptional?: boolean;
}

/**
 * Checks everything a move needs before any change (state, both providers' tokens, Cloudflare
 * when the plan uses it, GitHub, deploy key, state passphrase) and prepares the engine.
 */
export async function openSession(
  deps: PhaseDeps,
  plan: DeployPlan,
  input: OpenSessionInput,
): Promise<MoveSession> {
  const { services, command } = input;
  await requireState(deps, plan);
  const git = await requireGitRepo(deps);
  const providers = [...new Set(input.providers)];
  const names = providers.map((id) => providerProfile(id).displayName);
  const usesCloudflare = plan.dns.provider === "cloudflare";
  deps.reporter.step(
    `Checking your ${[...names, ...(usesCloudflare ? ["Cloudflare"] : [])].join(", ")} and GitHub access`,
  );
  for (const id of providers) {
    const check = services.providers?.[id];
    await checkProvider(deps, id, check ? { provider: check } : {});
  }
  const cloudflare = await setupCloudflare(deps, plan, services);
  const githubApi = await githubApiOf(deps, services);
  // Stops with CREDENTIALS_MISSING when there is no token, so the API exists after it.
  const github = await setupGitHub(deps, git, { github: githubApi });
  if (githubApi === null) {
    throw new OpsCrewError("INTERNAL", "The GitHub API is not available.", {
      hint: "This is a bug in OpsCrew; please report it.",
    });
  }
  const deployKey = await readDeployKey(deps, command);

  const { engine, env } = await existingStateEngine(deps, plan, {
    ...(input.engine !== undefined ? { engine: input.engine } : {}),
    services,
    command,
  });
  const dir = join(deps.paths.root, plan.infra.dir);
  // Read only when the local record lacks an address; `init` first where the state was copied.
  const servers =
    input.servers ??
    (await loadMoveServers(
      deps,
      plan,
      command,
      () => readOutputsAfterInit(engine, dir, tfstateFile(deps.paths), env),
      { oldServerOptional: input.oldServerOptional === true },
    ));
  return {
    deps,
    services,
    plan,
    requirements: await readRequirements(deps),
    git,
    github,
    githubApi,
    cloudflare,
    engine,
    env,
    deployKey,
    dir,
    command,
    approve: input.approvePlanHash?.trim() || undefined,
    servers,
    committedRender: ownRenderFromTfvars(await committedTfvars(deps.paths.root, plan)),
    builderBranch: await builderBranch(deps.paths, plan),
    site: await recordedEdge(deps, withCloudflareZone(plan, cloudflare)),
  };
}

/** Records the new server's address (local state and session) once it is created. */
export async function recordNewServer(
  session: Pick<MoveSession, "deps" | "servers">,
  next: ServerAddress,
): Promise<void> {
  session.servers = { ...session.servers, next };
  await recordMoveServers(session.deps, session.servers);
}

/**
 * The new server's address; stops with `PHASE_PRECONDITION` when it is unknown on this computer
 * (neither in the local state nor in the infrastructure state's outputs), never guessing.
 */
export function newServer(session: Pick<MoveSession, "servers" | "command">): ServerAddress {
  const next = session.servers.next;
  if (next === undefined) throw unknownNewServer(session.command);
  return next;
}

/** Every file of the deployment for `plan` (default: the session's) in `layout` (none: final). */
export async function renderFiles(
  session: MoveSession,
  layout?: InfraLayout,
  movePlan: DeployPlan = session.plan,
): Promise<RenderedFile[]> {
  const plan = withCloudflareZone(movePlan, session.cloudflare);
  const ctx = await deploymentRenderContext(session.deps, {
    plan,
    requirements: session.requirements,
    github: { owner: session.github.owner, repo: session.github.repo },
    deployPublicKey: session.deployKey.publicKeyOpenSsh,
    cloudflare: session.cloudflare,
    own: session.committedRender,
    edge: session.site.edge,
    builderBranch: session.builderBranch,
  });
  return renderDeployment(plan, layout ? { ...ctx, layout } : ctx);
}

/** The move's layout `name`, from the old server (`plan.retarget.from`) to the new one (`plan.target`). */
export function layoutOf(session: Pick<MoveSession, "plan">, name: MoveLayoutName): InfraLayout {
  return moveLayout(name, previousTarget(moveOf(session)), session.plan.target);
}

/**
 * Writes the infrastructure files of the move's layout `name` into the working tree and
 * initialises the engine again (a new module call or provider needs `init` before any plan or
 * output).
 */
export async function useLayout(
  session: MoveSession,
  name: MoveLayoutName,
): Promise<RenderedFile[]> {
  const { deps } = session;
  const files = (await renderFiles(session, layoutOf(session, name))).filter(
    (file) => file.kind === "infra",
  );
  const diff = await diffRenderedFiles(deps.paths.root, files);
  const toWrite = [...diff.created, ...diff.changed];
  if (toWrite.length > 0) {
    await writeRenderedFiles(deps.paths.root, toWrite);
    deps.reporter.info(
      `Updated the move's transitional infrastructure files in ${session.plan.infra.dir} (${name}); the final files are published when the move is finished.`,
    );
  }
  await session.engine.init(session.dir, {
    env: session.env,
    backendConfig: { path: tfstateFile(deps.paths) },
  });
  return files;
}

/**
 * Writes the deployment's files without a move layout (the final files after a finish, the
 * original ones after an abort) and deletes the vendored module files only `transitional` used.
 * Returns the written files and the removed paths (repository-relative).
 */
export async function writeFinalFiles(
  session: MoveSession,
  plan: DeployPlan,
  transitional: InfraLayout,
  kinds: "infra" | "all",
): Promise<{ files: RenderedFile[]; removed: string[] }> {
  const { deps } = session;
  const rendered = await renderFiles(session, undefined, plan);
  const files = kinds === "all" ? rendered : rendered.filter((file) => file.kind === "infra");
  await writeRenderedFiles(deps.paths.root, files);
  const kept = new Set(rendered.map((file) => file.path));
  const stale = (await renderFiles(session, transitional, plan))
    .filter((file) => file.kind === "infra" && !kept.has(file.path))
    .map((file) => file.path);
  const dirs = new Set<string>();
  for (const path of stale) {
    await rm(join(deps.paths.root, path), { force: true });
    dirs.add(dirname(path));
  }
  // Deepest first; a directory that still holds other files stays.
  for (const dir of [...dirs].sort((a, b) => b.length - a.length)) {
    await rmdir(join(deps.paths.root, dir)).catch(() => undefined);
  }
  return { files, removed: stale };
}

/** The repository-relative path of `opscrew/plan.yaml`. */
export function planFilePath(session: MoveSession): string {
  return toPosixRelative(session.deps.paths.root, session.deps.paths.files.plan);
}

/** Writes `plan` (atomically) and keeps it as the session's plan. */
export async function savePlan(
  session: Pick<MoveSession, "deps" | "plan">,
  plan: DeployPlan,
): Promise<DeployPlan> {
  const next = { ...plan, updatedAt: session.deps.clock.now().toISOString() };
  await writeArtifact("plan", session.deps.paths.files.plan, next);
  session.plan = next;
  return next;
}

/** Writes the move record (and optional other plan changes) to `opscrew/plan.yaml`. */
export async function saveMove(
  session: Pick<MoveSession, "deps" | "plan">,
  retarget: Retarget,
  extra: Partial<Omit<DeployPlan, "retarget">> = {},
): Promise<DeployPlan> {
  return savePlan(session, { ...session.plan, ...extra, retarget });
}

/** The current move record; throws when the plan has none (a bug: callers check first). */
export function moveOf(session: Pick<MoveSession, "plan">): Retarget {
  const move = session.plan.retarget;
  if (move === undefined) {
    throw new OpsCrewError("INTERNAL", "No move is recorded in opscrew/plan.yaml.", {
      hint: "This is a bug in OpsCrew; please report it.",
    });
  }
  return move;
}

/**
 * The plan after an applied infrastructure plan: the approval copied into `approvals` and the
 * apply recorded in `deployment` (`lastPlanHash`, `lastApplyAt`).
 */
export function withApply(
  plan: DeployPlan,
  applied: { planHash: string; approval?: ApprovalRecord },
  at: string,
): Pick<DeployPlan, "approvals" | "deployment"> {
  const { approval } = applied;
  return {
    approvals: approval ? [...plan.approvals, approvalEntry(approval)] : plan.approvals,
    deployment: { ...plan.deployment, lastPlanHash: applied.planHash, lastApplyAt: at },
  };
}

/** Says so when `--approve <hash>` named no plan this run used. */
export function warnUnusedApproval(session: Pick<MoveSession, "deps" | "approve">): void {
  if (session.approve === undefined) return;
  session.deps.reporter.warn(
    `OpsCrew did not use --approve ${session.approve}: it is not the plan this step waits for. Use the hash shown with the current plan.`,
  );
}

/** Records an applied plan (approval copy, last apply) in `opscrew/plan.yaml` right away. */
export async function recordApply(
  session: Pick<MoveSession, "deps" | "plan">,
  applied: { planHash: string; approval?: ApprovalRecord },
): Promise<void> {
  const at = session.deps.clock.now().toISOString();
  await savePlan(session, { ...session.plan, ...withApply(session.plan, applied, at) });
}

/** Appends a `retarget` audit entry (text is redacted by the audit log). */
export async function auditMove(
  session: Pick<MoveSession, "deps" | "plan">,
  entry: Omit<AuditInput, "phase" | "actor"> & { actor?: AuditInput["actor"] },
): Promise<void> {
  await session.deps.audit.append({
    actor: "opscrew",
    target: session.plan.app.name,
    ...entry,
    phase: "retarget",
  });
}

/** Records a completed step in the audit log (after `opscrew/plan.yaml` says so). */
export async function auditStep(
  session: Pick<MoveSession, "deps" | "plan">,
  step: string,
  detail: string,
): Promise<void> {
  await auditMove(session, { kind: "phase", action: `retarget ${step}`, detail });
}

/**
 * Pins (or checks) the SSH host key of `host` in OpsCrew's known_hosts; a changed key is only
 * trusted after a `remote-exec` approval. Returns the known_hosts lines for the deploy secret.
 */
export async function pinHost(session: MoveSession, host: string, provider: VpsProviderId) {
  const { deps } = session;
  return pinHostKey({
    host,
    console: providerConsole(providerProfile(provider)),
    knownHostsFile: deps.paths.files.knownHosts,
    runner: deps.runner,
    confirmChangedKey: confirmChangedHostKey(deps),
  });
}
