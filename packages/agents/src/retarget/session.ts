import { access, mkdir, readFile, rm, rmdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { GitClient, GitHubClient, resolveGitHubToken } from "@opscrew/connector-github";
import type {
  ApprovalRecord,
  AuditInput,
  IacEngine,
  RemoteExec,
  VpsProviderId,
} from "@opscrew/contracts";
import { isUserFacingError, OpsCrewError, toPosixRelative } from "@opscrew/core";
import {
  type EnginePreference,
  engineLabel,
  selectEngine,
  tofuEncryptionEnv,
} from "@opscrew/iac-engine";
import { type InfraLayout, type RenderedFile, renderDeployment } from "@opscrew/iac-templates";
import {
  type DeployPlan,
  type Requirements,
  type Retarget,
  writeArtifact,
} from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { providerProfile } from "../providers";
import {
  type CloudflareSetup,
  checkProvider,
  deploymentRenderContext,
  type GitHubSetup,
  readRequirements,
  setupCloudflare,
  setupGitHub,
} from "../provision";
import {
  type DeployKey,
  diffRenderedFiles,
  ensureDeployKey,
  pinHostKey,
  providerConsole,
  SshRemoteExec,
  writeRenderedFiles,
} from "../shared";
import type { MoveLayoutName } from "./layouts";
import type { RedactText } from "./server-ops";
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
  /** The local state file every engine call uses (`-backend-config=path=…`). */
  statePath: string;
  /** The command that continues after a stop (`opscrew retarget`, `… --finish`, `… --abort`). */
  command: string;
  /** `--approve <hash>` until a step used it. */
  approve: string | undefined;
}

/**
 * What reaching the servers and recording the move needs, without credentials or engine: enough
 * to start the old app again before anything else is checked.
 */
export type MoveBase = Pick<MoveSession, "deps" | "plan" | "services" | "deployKey">;

/** `.opscrew/tfstate/prod.tfstate`, as provision, destroy and drift use it. */
export function statePathOf(deps: Pick<PhaseDeps, "paths">): string {
  return join(deps.paths.files.tfstateDir, "prod.tfstate");
}

/** True when the infrastructure state file exists and is not empty. */
export async function stateExists(deps: Pick<PhaseDeps, "paths">): Promise<boolean> {
  try {
    return (await stat(statePathOf(deps))).size > 0;
  } catch {
    return false;
  }
}

/** Stops unless the infrastructure state is on this computer. */
export async function requireState(deps: PhaseDeps, plan: DeployPlan): Promise<void> {
  if (await stateExists(deps)) return;
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    `The infrastructure state of ${plan.app.name} is not on this computer (.opscrew/tfstate/prod.tfstate), so OpsCrew cannot move the deployment. Nothing was changed.`,
    {
      hint: "Run OpsCrew on the computer that ran `opscrew provision`, or copy its .opscrew/tfstate folder (and, with OpenTofu, the state passphrase from ~/.opscrew/projects/<project>/state_passphrase) here, then try again.",
    },
  );
}

/** The project's deploy key; stops when it is not on this computer (it is never created here). */
export async function readDeployKey(deps: PhaseDeps, command: string): Promise<DeployKey> {
  try {
    await access(deps.paths.files.deployKey);
    await access(deps.paths.files.deployKeyPub);
  } catch {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      "The project's SSH deploy key is not on this computer, so OpsCrew cannot reach the servers. Nothing was changed.",
      {
        hint: `Copy the deploy key files from the computer that ran \`opscrew provision\` to ${deps.paths.files.deployKey} and ${deps.paths.files.deployKeyPub}, then run \`${command}\` again.`,
      },
    );
  }
  const key = await ensureDeployKey(deps.paths);
  deps.redactor.addLiteral(key.privateKeyOpenSsh, "deploy-key");
  return key;
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

/** The redactor as server operations need it. */
export function redactWith(deps: PhaseDeps): { redact: RedactText } {
  return { redact: (text) => deps.redactor.redact(text) };
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

/** The OpenTofu state passphrase as `TF_ENCRYPTION`; read, never created (it decrypts the state). */
async function engineEnvironment(
  deps: PhaseDeps,
  plan: DeployPlan,
  engine: IacEngine,
  command: string,
): Promise<Record<string, string | undefined>> {
  const env: Record<string, string | undefined> = { ...deps.env };
  if (!plan.infra.stateEncryption) return env;
  if (engine.info.name !== "tofu") {
    deps.reporter.warn(
      `Terraform cannot read state that OpenTofu encrypted. If OpenTofu provisioned this deployment, run \`${command} --engine tofu\` instead.`,
    );
    return env;
  }
  const passphrase = (
    await readFile(deps.paths.files.statePassphrase, "utf8").catch(() => undefined)
  )?.trim();
  if (!passphrase) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      "The OpenTofu state is encrypted, but this computer does not have its passphrase. Nothing was changed.",
      {
        hint: `Copy the state passphrase file from the computer that ran \`opscrew provision\` to ${deps.paths.files.statePassphrase}, then run \`${command}\` again.`,
      },
    );
  }
  deps.redactor.addLiteral(passphrase, "state-passphrase");
  env.TF_ENCRYPTION = tofuEncryptionEnv(passphrase);
  return env;
}

/** The GitHub API: the injected one, else a client from the user's token (`null`: none found). */
async function githubApiOf(
  deps: PhaseDeps,
  services: RetargetServices,
): Promise<RetargetGitHubApi | null> {
  if (services.github !== undefined) return services.github;
  const token = await resolveGitHubToken(deps.env, deps.runner);
  if (!token) return null;
  deps.redactor.addLiteral(token, "github-token");
  return new GitHubClient({ token, fetch: deps.fetch, version: deps.version });
}

export interface OpenSessionInput {
  command: string;
  /** Providers whose tokens must work: both servers' providers. */
  providers: readonly VpsProviderId[];
  engine?: EnginePreference;
  approvePlanHash?: string;
  services: RetargetServices;
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
  const git = new GitClient({
    cwd: deps.paths.root,
    runner: deps.runner,
    env: deps.env,
    redactor: deps.redactor,
  });
  if (!(await git.isRepo())) {
    throw new OpsCrewError("PHASE_PRECONDITION", "This project is not a git repository.", {
      hint: "Run OpsCrew from a clone of your GitHub repository.",
    });
  }
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

  const preference = input.engine ?? plan.infra.engine;
  const engine = services.engine
    ? await services.engine(preference)
    : await selectEngine(preference, {
        runner: deps.runner,
        env: deps.env,
        redactor: deps.redactor,
        now: () => deps.clock.now(),
      });
  deps.reporter.info(`Using ${engineLabel(engine.info.name)} ${engine.info.version}.`);
  const env = await engineEnvironment(deps, plan, engine, command);
  await mkdir(deps.paths.files.plansDir, { recursive: true });
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
    dir: join(deps.paths.root, plan.infra.dir),
    statePath: statePathOf(deps),
    command,
    approve: input.approvePlanHash?.trim() || undefined,
  };
}

/** Every file of the deployment for `plan` (default: the session's) in `layout` (none: final). */
export function renderFiles(
  session: MoveSession,
  layout?: InfraLayout,
  plan: DeployPlan = session.plan,
): RenderedFile[] {
  const ctx = deploymentRenderContext(session.deps, {
    plan,
    requirements: session.requirements,
    github: { owner: session.github.owner, repo: session.github.repo },
    deployPublicKey: session.deployKey.publicKeyOpenSsh,
    cloudflare: session.cloudflare,
  });
  return renderDeployment(plan, layout ? { ...ctx, layout } : ctx);
}

/**
 * Writes the infrastructure files of a move layout into the working tree and initialises the
 * engine again (a new module call or provider needs `init` before any plan or output).
 */
export async function useLayout(
  session: MoveSession,
  name: MoveLayoutName,
  layout: InfraLayout,
): Promise<RenderedFile[]> {
  const { deps } = session;
  const files = renderFiles(session, layout).filter((file) => file.kind === "infra");
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
    backendConfig: { path: session.statePath },
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
  const rendered = renderFiles(session, undefined, plan);
  const files = kinds === "all" ? rendered : rendered.filter((file) => file.kind === "infra");
  await writeRenderedFiles(deps.paths.root, files);
  const kept = new Set(rendered.map((file) => file.path));
  const stale = renderFiles(session, transitional, plan)
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
    approvals: approval
      ? [
          ...plan.approvals,
          {
            planHash: approval.planHash ?? applied.planHash,
            approver: approval.approver,
            at: approval.decidedAt,
            kind: "iac-apply",
          },
        ]
      : plan.approvals,
    deployment: { ...plan.deployment, lastPlanHash: applied.planHash, lastApplyAt: at },
  };
}

/** Records a failed run of the `retarget` phase (the reason is redacted). */
export async function markFailed(deps: PhaseDeps, error: unknown): Promise<void> {
  const reason = isUserFacingError(error) ? error.message : "unexpected error";
  await deps.state
    .markPhase("retarget", "failed", deps.redactor.redact(reason))
    .catch(() => undefined);
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
    confirmChangedKey: async ({ host: changed, previous, current }) => {
      const decision = await deps.approvals.request({
        kind: "remote-exec",
        title: `Trust the new SSH host key of ${changed}`,
        details: [
          "The server's SSH host key is different from the one OpsCrew pinned earlier.",
          "Only accept this if you rebuilt or replaced the server yourself.",
          "Pinned:",
          ...previous.map((line) => `  ${line}`),
          "Now:",
          ...current.map((line) => `  ${line}`),
        ].join("\n"),
      });
      return decision.approved;
    },
  });
}
