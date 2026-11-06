import { access, rm, rmdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { cloudflareConnector } from "@opscrew/connector-cloudflare";
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
  isCloudProvider,
  type Requirements,
  type Retarget,
  writeArtifact,
} from "@opscrew/plan-schema";
import { renderedCheckKeyLine } from "../check/provision";
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
import { portainerCloudflare } from "../provision/credentials";
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
  readServerAddresses,
  requireGitRepo,
  type ServerAddress,
  SshRemoteExec,
  setAddressVariables,
  stateCopyPaths,
  stateNotHere,
  writeRenderedFiles,
} from "../shared";
import { oldSideTarget } from "./layouts";
import { loadMoveServers, type MoveServers, recordMoveServers, unknownNewServer } from "./servers";
import { managedDns, RUN_COMMAND } from "./texts";
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
  /**
   * A Portainer old side whose DNS records on Cloudflare are still the user's: their ids, which
   * the move's layouts adopt into `module "dns"` with `import` blocks.
   */
  adoptRecords?: UserRecords["ids"];
}

/** The app's DNS records on Cloudflare that are the user's, not OpsCrew's (a Portainer side). */
export interface UserRecords {
  /** Their Cloudflare ids: the domain's A record, its AAAA record and the `www.` CNAME. */
  ids: { a: string; aaaa?: string; www?: string };
  /** Where they point: the Portainer host's public address. */
  address: ServerAddress;
}

/**
 * The app's DNS records that are still the user's when the move's old side is a Portainer whose
 * web mode `caddy` has no `records` yet and OpsCrew manages the app's DNS on Cloudflare: read
 * through the Cloudflare connector (the domain's A and AAAA records, and `www.` when the plan
 * serves it). `undefined` for every other move. Stops before any change when the domain has no A
 * record (a CNAME to a dynamic-DNS name): the switch updates address records only.
 */
export async function userRecords(
  deps: PhaseDeps,
  plan: DeployPlan,
  services: Pick<RetargetServices, "cloudflare">,
): Promise<UserRecords | undefined> {
  const from = plan.retarget?.from.target;
  const domain = plan.dns.domain;
  if (from?.provider !== "portainer" || !managedDns(plan) || domain === undefined) return undefined;
  if (portainerCloudflare({ ...plan, target: from })?.records === true) return undefined;
  const api =
    services.cloudflare === undefined
      ? (cloudflareConnector(deps).client ?? null)
      : services.cloudflare;
  // Without a token the session stops when it checks Cloudflare.
  if (api === null) return undefined;
  const zone = await api.findZone(domain);
  if (!zone) return undefined;
  const first = async (name: string, type: string) =>
    (await api.listDnsRecords(zone.id, { name, type }))[0];
  const a = await first(domain, "A");
  if (a === undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `${domain} has no A record on Cloudflare pointing at your Portainer host, and a move switches the app's address records in place, so OpsCrew did not start it. Nothing was changed.`,
      {
        hint: `Point ${domain} at your Portainer host's public address with an A record (and AAAA for IPv6) instead of a CNAME, then run \`${RUN_COMMAND}\` again.`,
      },
    );
  }
  const aaaa = await first(domain, "AAAA");
  const www = plan.dns.www ? await first(`www.${domain}`, "CNAME") : undefined;
  return {
    ids: {
      a: a.id,
      ...(aaaa !== undefined ? { aaaa: aaaa.id } : {}),
      ...(www !== undefined ? { www: www.id } : {}),
    },
    address: { ipv4: a.content, ...(aaaa !== undefined ? { ipv6: aaaa.content } : {}) },
  };
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

/**
 * The deploy user's shell on `host`:`port`: the injected one, else SSH with the deploy key and
 * the pinned host keys.
 */
export function remoteFor(
  deps: Pick<PhaseDeps, "paths" | "runner">,
  services: RetargetServices,
  keyFile: string,
  host: string,
  port = 22,
): RemoteExec {
  return (
    services.remote?.(host) ??
    new SshRemoteExec({
      host,
      port,
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
 * True when the move's root module holds resources in the infrastructure state already: a cloud
 * side, or the app's DNS records OpsCrew manages for an old side that is the user's own server
 * or Portainer. A move between the user's own server and Portainer without them starts a state.
 */
function needsState(plan: DeployPlan): boolean {
  const from = moveOf({ plan }).from.target;
  if (isCloudProvider(from.provider) || isCloudProvider(plan.target.provider)) return true;
  if (!managedDns(plan)) return false;
  return (
    from.provider === "own" ||
    (from.provider === "portainer" &&
      portainerCloudflare({ ...plan, target: from })?.records === true)
  );
}

/**
 * The plan Cloudflare is checked for: the move's plan, with a Portainer side's target replaced by
 * the other side's (a server's), since a stack's plan reads Cloudflare only for a tunnel while the
 * move manages the app's records there.
 */
function cloudflarePlan(plan: DeployPlan): DeployPlan {
  if (plan.target.provider !== "portainer") return plan;
  return { ...plan, target: oldSideTarget(moveOf({ plan })) };
}

/**
 * Checks everything a move needs before any change (state where the move's root holds resources,
 * the cloud providers' tokens, Cloudflare when the plan uses it, GitHub, deploy key, state
 * passphrase) and prepares the engine. `plan` is the move's (`plan.retarget` set).
 */
export async function openSession(
  deps: PhaseDeps,
  plan: DeployPlan,
  input: OpenSessionInput,
): Promise<MoveSession> {
  const { services, command } = input;
  if (needsState(plan)) await requireState(deps, plan);
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
  const cloudflare = await setupCloudflare(deps, cloudflarePlan(plan), services);
  const adopted = await userRecords(deps, plan, services);
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
    ...(adopted !== undefined ? { adoptRecords: adopted.ids } : {}),
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
  /** For a plan on the user's own server: the login whose SSH port the deploy uses. */
  login: "own" | "fromOwn" = "own",
): Promise<RenderedFile[]> {
  const plan = withCloudflareZone(movePlan, session.cloudflare);
  // On the user's own server in public mode the deploy connects to its login's port.
  const recorded = await readServerAddresses(session.deps.paths);
  const ownLogin = login === "own" ? recorded.own : recorded.retarget?.fromOwn;
  const own =
    plan.target.provider === "own" && plan.target.access === "public" && ownLogin !== undefined
      ? { ...session.committedRender, sshPort: ownLogin.port }
      : session.committedRender;
  // The new server gets the scheduled check's key at its first boot, as from provision.
  const checkKeyLine = await renderedCheckKeyLine(
    session.deps,
    plan,
    `${session.github.owner}/${session.github.repo}`,
  );
  const ctx = await deploymentRenderContext(session.deps, {
    ...(checkKeyLine !== undefined ? { checkKeyLine } : {}),
    plan,
    requirements: session.requirements,
    github: { owner: session.github.owner, repo: session.github.repo },
    deployPublicKey: session.deployKey.publicKeyOpenSsh,
    cloudflare: session.cloudflare,
    own,
    edge: session.site.edge,
    builderBranch: session.builderBranch,
  });
  return renderDeployment(plan, {
    ...ctx,
    ...(layout !== undefined ? { layout } : {}),
    // A Portainer old side's records, adopted into the move's root while it renders a layout.
    ...(layout !== undefined && session.adoptRecords !== undefined
      ? { adoptRecords: session.adoptRecords }
      : {}),
  });
}

/**
 * After an applied plan that adopted a Portainer old side's records (`adoptRecords`): they are in
 * OpsCrew's state now, so the old target says so (`web.records: true`) and an abort restores it
 * that way; later layouts need no `import` blocks for them.
 */
export async function recordAdopted(session: MoveSession): Promise<void> {
  if (session.adoptRecords === undefined) return;
  const move = moveOf(session);
  const from = move.from.target;
  if (from.provider !== "portainer" || from.web.mode !== "caddy") return;
  await saveMove(session, {
    ...move,
    from: { ...move.from, target: { ...from, web: { ...from.web, records: true } } },
  });
  delete session.adoptRecords;
}

/** The move's layout `name`, from the old side (`plan.retarget.from`) to the new one (`plan.target`). */
export function layoutOf(session: Pick<MoveSession, "plan">, name: MoveLayoutName): InfraLayout {
  return moveLayout(name, oldSideTarget(moveOf(session)), session.plan.target);
}

/**
 * The address variables of the layout's sides that are the user's own server or Portainer (never
 * written to a file): `TF_VAR_server_ipv4`/`_ipv6` for the new side in the `server` slot and
 * `TF_VAR_previous_server_ipv4`/`_ipv6` for the old one, from OpsCrew's local state.
 */
function addressVariables(session: MoveSession, layout: InfraLayout): void {
  const slots = [
    { side: layout.server, prefix: "", address: session.servers.next },
    { side: layout.previous, prefix: "previous_", address: session.servers.from },
  ];
  for (const { side, prefix, address } of slots) {
    const addressed = side !== undefined && !isCloudProvider(side.provider);
    setAddressVariables(session.env, addressed ? address : undefined, prefix);
  }
}

/**
 * Writes the infrastructure files of the move's layout `name` into the working tree, sets the
 * address variables of its sides that are the user's own server or Portainer, and initialises the
 * engine again (a new module call or provider needs `init` before any plan or output).
 */
export async function useLayout(
  session: MoveSession,
  name: MoveLayoutName,
): Promise<RenderedFile[]> {
  const { deps } = session;
  const layout = layoutOf(session, name);
  addressVariables(session, layout);
  const files = (await renderFiles(session, layout)).filter((file) => file.kind === "infra");
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
