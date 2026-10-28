import {
  CLOUDFLARE_DEPLOY_TOKEN_PERMISSIONS,
  CLOUDFLARE_HOSTING_PERMISSIONS,
  CLOUDFLARE_REGISTRAR_PERMISSIONS,
  CLOUDFLARE_TOKEN_PAGE,
  CLOUDFLARE_TOKEN_PERMISSIONS,
  type CloudflareClient,
  cloudflareConnector,
  inspectShared,
  planShared,
  type SharedFinding,
} from "@opscrew/connector-cloudflare";
import {
  GITHUB_TOKEN_PERMISSIONS,
  type GitHubClient,
  parseGitHubRepo,
} from "@opscrew/connector-github";
import type {
  CredentialCheck,
  CredentialRequirement,
  RegistrarAccountCheck,
  VpsProviderId,
} from "@opscrew/contracts";
import {
  errorMessage,
  errorText,
  findExecutable,
  isUserFacingError,
  listText,
  lowerFirst,
} from "@opscrew/core";
import { detectEngines, MIN_ENGINE_VERSION, versionAtLeast } from "@opscrew/iac-engine";
import { CHECK_PAUSED_VARIABLE, usesTunnel } from "@opscrew/iac-templates";
import {
  type ArtifactKind,
  type ArtifactOf,
  type DeployPlan,
  isServerlessProvider,
  type Requirements,
  readArtifact,
  type ServerlessProvider,
} from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { PAGES_NOT_ALLOWED } from "../design/serverless";
import {
  hasEnv,
  OTHER_REGISTRAR_IDS,
  type OtherRegistrarId,
  REGISTRAR_ENV,
  REGISTRAR_NAMES,
  registrarFor,
  registrarLinks,
} from "../domain/registrars";
import {
  PORTAINER_TOKEN_VAR,
  type ProviderProfile,
  planProvider,
  providerFromTokens,
  providerProfile,
  requestedProvider,
  VPS_PROVIDERS,
  vpsConnector,
} from "../providers";
import { REGISTRY_TOKEN_VAR, REPOSITORY_TOKEN_VAR } from "../provision/portainer";
import { CLOUDFLARE_TUNNEL_PERMISSIONS, tunnelTokenPermissions } from "../provision/zero-trust";
import { gitClient, githubClientFromToken } from "../shared/github";
import { ownServerLogin, readOwnServerRecord, requireOwnServerKey } from "../shared/own-server";
import { serverlessName } from "../shared/vps-target";
import { type CheckResult, failFrom } from "./check-result";
import {
  describeGitignoreEntries,
  GITIGNORE_ENTRIES,
  missingGitignoreEntries,
  readGitignore,
} from "./gitignore";
import {
  checkPortainer,
  checkPortainerTokens,
  type InitPortainerClient,
  type PortainerRecord,
  readPortainerRecord,
} from "./portainer";

/** Outcome of one check. Only required checks fail; optional ones warn. */
export type InitCheckStatus = "pass" | "warn" | "fail" | "skip";

/** Stable ids of the `opscrew init` checks, in checklist order. */
export type InitCheckId =
  | "node"
  | "git"
  | "repository"
  | "engine"
  | "ssh"
  /**
   * The cloud provider token (Hetzner Cloud or DigitalOcean), the SSH login of the user's own
   * server, or the user's Portainer; was `hetzner` before 004.
   */
  | "provider"
  /** Optional, listed only for a Portainer target: the read-only GitHub tokens Portainer pulls with. */
  | "portainer-tokens"
  | "cloudflare"
  /** Optional: whether the Cloudflare token can buy domains through Cloudflare Registrar. */
  | "registrar"
  /** Optional, listed only when configured (even partly): registrar API access (feature 007). */
  | "porkbun"
  | "namecheap"
  | "godaddy"
  | "github"
  /** Listed only with the scheduled check on: the GitHub token's permissions it needs. */
  | "scheduled-check"
  | "model"
  | "scanners"
  | "gitignore";

/** One line of the `opscrew init` checklist. Never contains a token value. */
export interface InitCheck {
  id: InitCheckId;
  title: string;
  status: InitCheckStatus;
  /** What was found, in plain English. */
  message: string;
  /** What to do about a `fail` or `warn`: install command or URL, env var, token permissions. */
  fix?: string;
}

/** Collaborators `runInitChecks` uses besides `PhaseDeps` (all optional; tests replace them). */
export interface InitServices {
  /** PATH lookup (default: `findExecutable` over `deps.env`). */
  which?: (name: string) => string | undefined;
  /** Running Node.js version (default: `process.versions.node`). */
  nodeVersion?: string;
  /** Time budget of each network check in milliseconds (default 10 000). */
  timeoutMs?: number;
  /** Account check of a registrar other than Cloudflare (default: the adapter's `accountCheck`). */
  registrarCheck?: (id: OtherRegistrarId) => Promise<RegistrarAccountCheck>;
  /** The Portainer client of the Portainer check (default: the adapter's pinned `portainerClient`). */
  portainerClient?: InitPortainerClient;
}

export interface InitCheckOptions {
  /** No network: token checks only look for presence and say so. */
  offline?: boolean;
  services?: InitServices;
}

/** Oldest Node.js OpsCrew runs on. */
const MIN_NODE_VERSION = "20.19.0";

const NETWORK_TIMEOUT_MS = 10_000;

const OFFLINE_NOTE = "offline: only checked that it is set, not that it works";

const MODEL_HINT =
  "Set ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN), or route through a cloud provider by setting CLAUDE_CODE_USE_BEDROCK=1, CLAUDE_CODE_USE_VERTEX=1 or CLAUDE_CODE_USE_FOUNDRY=1 with that provider's credentials.";

const REMOTE_FIX =
  "Create the repository on GitHub, run `git remote add origin https://github.com/<owner>/<repo>.git`, push, then run `opscrew init` again.";

const SCANNERS = [
  { name: "gitleaks", url: "https://github.com/gitleaks/gitleaks#installing" },
  { name: "osv-scanner", url: "https://google.github.io/osv-scanner/installation/" },
  { name: "trivy", url: "https://trivy.dev/latest/getting-started/installation/" },
] as const;

/** True when no check failed (optional checks never fail, so warnings still pass). */
export function initPassed(checks: readonly InitCheck[]): boolean {
  return !checks.some((check) => check.status === "fail");
}

/** How the plan (or, before design, the requirements) uses Cloudflare. */
interface CloudflareUsage {
  needed: boolean | undefined;
  domain?: string;
  /** The plan serves something through a Cloudflare Tunnel with Access (more permissions). */
  tunnel?: boolean;
  /** The plan keeps the app's files in a bucket on Cloudflare R2 (one more permission). */
  r2?: boolean;
  /** The plan hosts the site on Cloudflare with `www`, redirected by a shared Single Redirect rule. */
  redirect?: boolean;
}

/** The plan and the interview answers, each when there is a usable one. */
interface ProjectArtifacts {
  plan?: DeployPlan;
  requirements?: Requirements;
}

/**
 * The artefact, or undefined when it is missing or invalid: init then checks what it can without
 * it. Any other error stops the run.
 */
async function readUsable<K extends ArtifactKind>(
  kind: K,
  file: string,
): Promise<ArtifactOf<K> | undefined> {
  try {
    return await readArtifact(kind, file);
  } catch (error) {
    const code = isUserFacingError(error) ? error.code : undefined;
    if (code === "ARTIFACT_MISSING" || code === "ARTIFACT_INVALID") return undefined;
    throw error;
  }
}

/** Whether the plan (or, before design, the requirements) puts the domain on Cloudflare. */
function cloudflareUsage({ plan, requirements }: ProjectArtifacts): CloudflareUsage {
  if (plan !== undefined) {
    return plan.dns.provider === "cloudflare"
      ? {
          needed: true,
          domain: plan.dns.domain,
          tunnel: usesTunnel(plan),
          r2: plan.storage?.objectStorage?.provider === "r2",
          redirect: plan.target.provider === "cloudflare-workers" && plan.dns.www,
        }
      : { needed: false };
  }
  if (requirements === undefined) return { needed: undefined };
  return requirements.dnsProvider === "cloudflare"
    ? { needed: true, domain: requirements.domain }
    : { needed: false };
}

interface RepoInfo {
  git?: string;
  isRepo: boolean;
  coordinates?: { owner: string; repo: string };
}

/**
 * Runs every `opscrew init` preflight check (FR-306) and returns the checklist. Network checks
 * (cloud provider, Cloudflare, GitHub) run in parallel with a time budget each; with `offline`
 * they only look for the tokens. The cloud provider check looks at the planned provider's token
 * (else the interview answer's, else whichever single token is set) and never at the other
 * provider's; a server the user already owns has no token, so the check looks at its recorded SSH
 * login and key instead (the `ssh` check covers the binaries). Required checks (Node, git repository, engine, ssh, the cloud provider token, the GitHub token
 * when the target deploys through GitHub Actions, Cloudflare when the plan uses it) fail; the rest
 * only warn. Every message is redacted.
 */
export async function runInitChecks(
  deps: PhaseDeps,
  options: InitCheckOptions = {},
): Promise<InitCheck[]> {
  const services = options.services ?? {};
  const offline = options.offline === true;
  const env = deps.env;
  const which = services.which ?? ((name: string) => findExecutable(name, env));
  const budget = services.timeoutMs ?? NETWORK_TIMEOUT_MS;

  const providerTokens = VPS_PROVIDERS.flatMap((id) => providerProfile(id).tokenVars);
  const registrarSecrets = OTHER_REGISTRAR_IDS.flatMap((id) => REGISTRAR_ENV[id]).filter(
    (name) => name !== "NAMECHEAP_API_USER",
  );
  for (const name of [
    ...providerTokens,
    "CLOUDFLARE_API_TOKEN",
    CLOUDFLARE_HOSTING.deployTokenVar,
    "GITHUB_TOKEN",
    "GH_TOKEN",
    PORTAINER_TOKEN_VAR,
    REGISTRY_TOKEN_VAR,
    REPOSITORY_TOKEN_VAR,
    ...registrarSecrets,
  ]) {
    const value = env[name]?.trim();
    if (value) deps.redactor.addLiteral(value, name);
  }

  const repoInfo = inspectRepository(deps, which);
  const github = githubLookup(deps, offline, repoInfo);
  const artifacts: ProjectArtifacts = {
    plan: await readUsable("plan", deps.paths.files.plan),
    requirements: await readUsable("requirements", deps.paths.files.requirements),
  };
  const choice = providerChoice(artifacts, env);
  const { provider, source } = choice;
  // Read before any check runs, so Portainer's address is registered with the redactor first.
  const portainer: PortainerRecord | undefined =
    choice.provider === "portainer" ? await readPortainerRecord(deps) : undefined;

  const cloudflare = cloudflareAccess(deps, offline);

  const checks = await Promise.all([
    guard("node", "Node.js", true, async () => checkNode(services.nodeVersion)),
    guard("git", "git", true, async () => checkGit((await repoInfo).git)),
    guard("repository", "GitHub repository", true, async () => checkRepository(await repoInfo)),
    guard("engine", "OpenTofu or Terraform", true, () => checkEngine(deps, which)),
    guard("ssh", "ssh and ssh-keyscan", true, async () =>
      portainer !== undefined
        ? {
            status: "skip",
            message:
              "Not needed: OpsCrew deploys to your Portainer through its API and never connects over SSH.",
          }
        : checkSsh(which),
    ),
    guard("provider", providerTitle(choice), true, () =>
      withBudget(
        isServerlessProvider(provider)
          ? checkServerlessTarget(deps, offline, provider, artifacts, cloudflare, github)
          : checkProviderToken(
              deps,
              offline,
              provider === undefined ? { source } : { provider, source },
              which,
              portainer,
              services.portainerClient,
            ),
        budget,
        providerService(choice),
        true,
      ),
    ),
    ...(portainer !== undefined
      ? [
          guard("portainer-tokens", "Read-only GitHub tokens for Portainer", false, () =>
            withBudget(
              github().then((lookup) =>
                checkPortainerTokens(deps, portainer, lookup.repo?.private),
              ),
              budget,
              "GitHub",
              false,
            ),
          ),
        ]
      : []),
    guard("cloudflare", "Cloudflare token", false, async () => {
      const usage = cloudflareUsage(artifacts);
      return withBudget(
        checkCloudflare(usage, cloudflare),
        budget,
        "Cloudflare",
        usage.needed === true,
      );
    }),
    guard("registrar", "Buying domains through Cloudflare (optional)", false, () =>
      withBudget(checkRegistrar(cloudflare), budget, "Cloudflare", false),
    ),
    ...OTHER_REGISTRAR_IDS.filter((id) => REGISTRAR_ENV[id].some((name) => hasEnv(env, name))).map(
      (id) =>
        guard(id, `${REGISTRAR_NAMES[id]} API access (optional)`, false, () =>
          withBudget(
            checkOtherRegistrar(deps, offline, id, services.registrarCheck),
            budget,
            REGISTRAR_NAMES[id],
            false,
          ),
        ),
    ),
    guard("github", "GitHub token", true, () =>
      withBudget(
        checkGitHub(offline, github, deploysThroughActions(artifacts)),
        budget,
        "GitHub",
        true,
      ),
    ),
    ...(artifacts.plan?.observability?.check?.enabled === true
      ? [
          guard("scheduled-check", "GitHub permissions for the scheduled check", true, () =>
            withBudget(checkScheduledCheck(github), budget, "GitHub", true),
          ),
        ]
      : []),
    guard("model", "Model credentials", false, () => checkModel(deps)),
    guard("scanners", "Optional scanners", false, async () => checkScanners(which)),
    guard("gitignore", ".opscrew/ and .terraform/ in .gitignore", false, () =>
      checkGitignore(deps),
    ),
  ]);

  return checks.map((check) => ({
    ...check,
    message: deps.redactor.redact(check.message),
    ...(check.fix === undefined ? {} : { fix: deps.redactor.redact(check.fix) }),
  }));
}

/** Runs one check; an unexpected error becomes a `fail` (required) or `warn` (optional). */
async function guard(
  id: InitCheckId,
  title: string,
  required: boolean,
  run: () => Promise<CheckResult>,
): Promise<InitCheck> {
  try {
    return { id, title, ...(await run()) };
  } catch (error) {
    return {
      id,
      title,
      status: required ? "fail" : "warn",
      message: `The check could not run: ${errorText(error)}`,
      fix: "Fix the problem above and run `opscrew init` again.",
    };
  }
}

/** Resolves `check`, or a timeout result once `ms` have passed. */
async function withBudget(
  check: Promise<CheckResult>,
  ms: number,
  service: string,
  required: boolean,
): Promise<CheckResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<CheckResult>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({
          status: required ? "fail" : "warn",
          message: `${service} did not answer within ${Math.round(ms / 1000)} s, so the token could not be checked.`,
          fix: "Check your internet connection and run `opscrew init` again, or run `opscrew init --offline` to check only that the tokens are set.",
        }),
      ms,
    );
    (timer as { unref?: () => void }).unref?.();
  });
  try {
    return await Promise.race([check, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function checkNode(version = process.versions.node): CheckResult {
  if (versionAtLeast(version, MIN_NODE_VERSION)) {
    return { status: "pass", message: `Node.js ${version}.` };
  }
  return {
    status: "fail",
    message: `Node.js ${version} is older than the minimum ${MIN_NODE_VERSION}.`,
    fix: "Install Node.js 20.19 or newer (22 LTS recommended) from https://nodejs.org/en/download, or with a version manager, for example `nvm install 22`.",
  };
}

async function inspectRepository(
  deps: PhaseDeps,
  which: (name: string) => string | undefined,
): Promise<RepoInfo> {
  const git = which("git");
  if (git === undefined) return { isRepo: false };
  const client = gitClient(deps, git);
  if (!(await client.isRepo())) return { git, isRepo: false };
  const remote = await client.remoteUrl("origin");
  const coordinates = remote ? parseGitHubRepo(remote) : undefined;
  return { git, isRepo: true, ...(coordinates ? { coordinates } : {}) };
}

function checkGit(git: string | undefined): CheckResult {
  if (git !== undefined) return { status: "pass", message: `git found at ${git}.` };
  return {
    status: "fail",
    message: "git is not installed (or not on PATH).",
    fix: "Install git from https://git-scm.com/downloads (macOS: `xcode-select --install`; Debian/Ubuntu: `sudo apt install git`), then run `opscrew init` again.",
  };
}

function checkRepository(info: RepoInfo): CheckResult {
  if (info.git === undefined) {
    return { status: "skip", message: "Not checked because git is not installed." };
  }
  if (!info.isRepo) {
    return {
      status: "fail",
      message: "This folder is not a git repository.",
      fix: `Run \`git init\` and commit your code. ${REMOTE_FIX}`,
    };
  }
  if (!info.coordinates) {
    return {
      status: "fail",
      message: "This repository has no GitHub remote named origin.",
      fix: REMOTE_FIX,
    };
  }
  return {
    status: "pass",
    message: `origin is github.com/${info.coordinates.owner}/${info.coordinates.repo}.`,
  };
}

async function checkEngine(
  deps: PhaseDeps,
  which: (name: string) => string | undefined,
): Promise<CheckResult> {
  const engines = await detectEngines({
    env: deps.env,
    runner: deps.runner,
    findExecutable: (name) => which(name),
  });
  const usable = engines.find((engine) => engine.supported);
  if (usable) {
    const label = usable.name === "tofu" ? "OpenTofu" : "Terraform";
    return { status: "pass", message: `${label} ${usable.version} at ${usable.binary}.` };
  }
  const problems = engines.flatMap((engine) => (engine.problem ? [engine.problem] : []));
  return {
    status: "fail",
    message:
      problems.length > 0
        ? `No usable OpenTofu or Terraform: ${problems.join(" ")}`
        : "Neither OpenTofu nor Terraform is installed (looked in OPSCREW_TOFU_BIN / OPSCREW_TERRAFORM_BIN and PATH).",
    fix: `Install OpenTofu ${MIN_ENGINE_VERSION} or newer (https://opentofu.org/docs/intro/install/, for example \`brew install opentofu\`) or Terraform (https://developer.hashicorp.com/terraform/install), or point OPSCREW_TOFU_BIN / OPSCREW_TERRAFORM_BIN at the program.`,
  };
}

function checkSsh(which: (name: string) => string | undefined): CheckResult {
  const missing = ["ssh", "ssh-keyscan"].filter((name) => which(name) === undefined);
  if (missing.length === 0) return { status: "pass", message: "ssh and ssh-keyscan found." };
  return {
    status: "fail",
    message: `${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} not installed (or not on PATH). OpsCrew needs them to pin the server's host key and deploy over SSH.`,
    fix: "Install the OpenSSH client: Windows: Settings → System → Optional features → OpenSSH Client; Debian/Ubuntu: `sudo apt install openssh-client`; macOS includes it.",
  };
}

/** Which provider's token the provider check looks at, and why. */
interface ProviderChoice {
  /** Undefined before a provider is chosen when zero or both tokens are set. */
  provider?: VpsProviderId | "portainer" | "localhost" | ServerlessProvider;
  /** The plan, the interview answers, or the only token that is set. */
  source: "plan" | "requirements" | "token" | "none";
}

/** A provider choice whose target has a server, a Portainer or this computer: not server-less. */
type ServerChoice = Omit<ProviderChoice, "provider"> & {
  provider?: Exclude<ProviderChoice["provider"], ServerlessProvider | undefined>;
};

/**
 * The planned target, else the requested one, else the provider whose token alone is set. A
 * Portainer target (`portainer`), the localhost target (`localhost`) and the server-less targets
 * are recognised in the plan and in the answers.
 */
function providerChoice(
  { plan, requirements }: ProjectArtifacts,
  env: Record<string, string | undefined>,
): ProviderChoice {
  if (plan !== undefined) {
    const { provider } = plan.target;
    return {
      provider:
        provider === "portainer" || provider === "localhost" || isServerlessProvider(provider)
          ? provider
          : planProvider(plan),
      source: "plan",
    };
  }
  if (requirements !== undefined) {
    const { provider } = requirements;
    return {
      provider:
        provider === "portainer" || provider === "localhost" || isServerlessProvider(provider)
          ? provider
          : requestedProvider(requirements),
      source: "requirements",
    };
  }
  const provider = providerFromTokens(env);
  return provider ? { provider, source: "token" } : { source: "none" };
}

/**
 * Title of the provider check: `Hetzner Cloud token`, `DigitalOcean token`, the SSH login of the
 * user's own server (it has no token), the user's Portainer, or a neutral one.
 */
function providerTitle(choice: ProviderChoice): string {
  if (choice.provider === "own") return "Your own server (SSH login)";
  if (choice.provider === "portainer") return "Your Portainer";
  if (choice.provider === "localhost") return "This computer";
  if (isServerlessProvider(choice.provider)) return serverlessName(choice.provider);
  return choice.provider
    ? `${providerProfile(choice.provider).displayName} token`
    : "Cloud provider token";
}

/** What the provider check's timeout message calls the service. */
function providerService(choice: ProviderChoice): string {
  if (choice.provider === "portainer") return "Your Portainer";
  if (choice.provider === "localhost") return "This computer";
  if (isServerlessProvider(choice.provider)) return serverlessName(choice.provider);
  return choice.provider ? providerProfile(choice.provider).displayName : "The cloud provider";
}

/**
 * A server the user already owns needs no API token: the check looks at the SSH login the
 * interview recorded (`.opscrew/server.json` → `own`) and the key file, and says how OpsCrew
 * connects and confirms the host key. It never connects (provision does) and never names the
 * server's address.
 */
async function checkOwnServerLogin(deps: PhaseDeps, choice: ServerChoice): Promise<CheckResult> {
  let connection: Awaited<ReturnType<typeof readOwnServerRecord>>;
  try {
    connection = await readOwnServerRecord(deps.paths);
  } catch (error) {
    if (!isUserFacingError(error)) throw error;
    return failFrom(error);
  }
  const deploysTo = choice.source === "plan" ? "The plan deploys" : "Your interview answers deploy";
  if (connection === undefined) {
    return {
      status: "fail",
      message: `${deploysTo} to a server you already have, but OpsCrew does not know how to reach it on this computer (no address, SSH port, user or key is recorded).`,
      fix: "Run `opscrew interview` and answer the questions about your server: its address, SSH port, user (root or a user with passwordless sudo) and your key file or `agent` for the SSH agent. No API token is needed, and OpsCrew never asks for a password or passphrase.",
    };
  }
  try {
    await requireOwnServerKey(connection, deps.env);
  } catch (error) {
    if (!isUserFacingError(error)) throw error;
    return failFrom(error);
  }
  const login = await vpsConnector("own", deps, {
    ownLogin: ownServerLogin(connection),
  }).verifyCredentials();
  const hostKey =
    connection.hostKey !== undefined
      ? ` Its SSH host key ${connection.hostKey} is pinned; a different key stops every command.`
      : " On the first connection OpsCrew shows the server's SSH host key fingerprint for you to confirm (in scripts, pass it with `--host-key SHA256:…`).";
  return { status: login.ok ? "pass" : "fail", message: `${login.message}${hostKey}` };
}

/** The first token variable of a provider that is set. */
function tokenVarOf(env: Record<string, string | undefined>, profile: ProviderProfile) {
  return profile.tokenVars.find((name) => hasEnv(env, name));
}

/** How to create the provider's token, naming the page, the variable and the scopes. */
function providerFix(profile: ProviderProfile, requirement: CredentialRequirement): string {
  if (profile.id === "hetzner") {
    return `Create a Read & Write API token in the Hetzner Cloud Console (${requirement.createUrl} → your project → Security → API tokens) and set it as HCLOUD_TOKEN.`;
  }
  return `Create a personal access token with custom scopes at ${requirement.createUrl}, select these scopes (${requirement.scopes.join(", ")}), and set ${profile.tokenVars[0]} to it.`;
}

/**
 * For providers whose API cannot list a token's scopes (DigitalOcean), the scopes OpsCrew needs,
 * so the user can compare them with the token's.
 */
function scopeNote(profile: ProviderProfile, requirement: CredentialRequirement): string {
  if (profile.id === "hetzner") return "";
  return ` ${profile.displayName} cannot report which scopes a token has, so make sure it has these (${requirement.scopes.join(", ")}).`;
}

const DOCKER_INSTALL =
  "Install Docker Desktop (Windows, macOS), Docker Engine (Linux) or Colima (macOS) and start it.";

const ONLY_ONE =
  "OpsCrew needs only one cloud provider token; `opscrew interview` asks where to run the app.";

/**
 * The cloud provider token check: the chosen provider's token (verified online unless `offline`;
 * the other provider's token is never checked), or before a choice either token. A server the
 * user owns and the user's Portainer have their own checks and no cloud provider token. Before a
 * choice, no token is only a note: this computer (localhost) and a server the user already has
 * need none. The localhost target needs Docker; before a choice, its absence is only noted. The
 * server-less targets have {@link checkServerlessTarget} instead.
 */
async function checkProviderToken(
  deps: PhaseDeps,
  offline: boolean,
  choice: ServerChoice,
  which: (name: string) => string | undefined,
  portainer: PortainerRecord | undefined,
  portainerClient: InitPortainerClient | undefined,
): Promise<CheckResult> {
  const env = deps.env;
  const { provider } = choice;
  if (provider === undefined) {
    const withToken = VPS_PROVIDERS.map(providerProfile).filter((p) => tokenVarOf(env, p));
    if (withToken.length > 1) {
      return {
        status: "pass",
        message: `${withToken.map((p) => tokenVarOf(env, p)).join(" and ")} are both set. ${ONLY_ONE} OpsCrew uses and checks only the chosen provider's token.`,
      };
    }
    const fixes = VPS_PROVIDERS.map((id) => {
      const profile = providerProfile(id);
      return `For ${profile.displayName}, ${lowerFirst(providerFix(profile, vpsConnector(id, deps).credentials))}`;
    });
    const docker = which("docker");
    return {
      status: "warn",
      message: `No cloud provider token is set (${VPS_PROVIDERS.map((id) => `${providerProfile(id).tokenVars[0]} for ${providerProfile(id).displayName}`).join(" or ")}). OpsCrew can deploy to this computer (localhost; ${docker === undefined ? "Docker is not installed" : `Docker found at ${docker}`}), to a server you already have, or to a cloud provider with its token.`,
      fix: `Choose where in \`opscrew interview\`. This computer and a server you already have need no token${docker === undefined ? `; this computer needs Docker: ${DOCKER_INSTALL}` : "."} For a cloud provider, set one token. ${fixes.join(" ")}`,
    };
  }
  if (provider === "own") return checkOwnServerLogin(deps, choice);
  if (provider === "localhost") {
    const docker = which("docker");
    if (docker === undefined) {
      return {
        status: "fail",
        message: `${choice.source === "plan" ? "The plan deploys" : "Your interview answers deploy"} to this computer (the localhost target), but Docker is not installed.`,
        fix: `${DOCKER_INSTALL} Then run \`opscrew init\` again.`,
      };
    }
    return {
      status: "pass",
      message: `Docker found at ${docker}. The app runs on this computer (the localhost target), with no token.`,
    };
  }
  if (provider === "portainer") {
    return checkPortainer(
      deps,
      offline,
      choice.source === "plan" ? "plan" : "requirements",
      portainer ?? (await readPortainerRecord(deps)),
      portainerClient,
    );
  }

  const profile = providerProfile(provider);
  const connector = vpsConnector(provider, deps);
  const requirement = connector.credentials;
  const fix = providerFix(profile, requirement);
  const envVar = tokenVarOf(env, profile);
  const unchosen = choice.source === "token" ? ` No provider is chosen yet. ${ONLY_ONE}` : "";
  if (envVar === undefined) {
    const others = VPS_PROVIDERS.filter((id) => id !== provider).flatMap((id) => {
      const other = tokenVarOf(env, providerProfile(id));
      return other ? [other] : [];
    });
    const why =
      others.length > 0
        ? ` (${choice.source === "plan" ? "the plan deploys" : "your interview answers deploy"} to ${profile.displayName}, so ${others.join(" and ")} is not used)`
        : "";
    return {
      status: "fail",
      message: `${profile.tokenVars[0]} is not set${why}.`,
      fix: `${fix}${scopeNote(profile, requirement)}`,
    };
  }
  if (offline) {
    return {
      status: "pass",
      message: `${envVar} is set (${OFFLINE_NOTE}).${scopeNote(profile, requirement)}${unchosen}`,
    };
  }
  const result = await connector.verifyCredentials();
  if (result.ok) {
    const identity = result.identity ? ` (${result.identity})` : "";
    const detail = /\bworks\.$/.test(result.message) ? "" : ` ${result.message}`;
    return {
      status: "pass",
      message: `${envVar} works${identity}.${detail}${scopeNote(profile, requirement)}${unchosen}`,
    };
  }
  if (result.identity !== undefined) {
    // The token was accepted, but the account itself is locked or not verified yet.
    return {
      status: "fail",
      message: `${envVar} was accepted, but the ${profile.displayName} account cannot be used yet. ${result.message}`,
      fix: `Resolve this on your ${profile.displayName} account page (${profile.accountUrl}), then run \`opscrew init\` again.`,
    };
  }
  // The fix already names the permission or scopes; the connector's message may name them too.
  return {
    status: "fail",
    message: `${envVar} does not work: ${result.message}`,
    fix,
  };
}

/** The permission OpsCrew's Cloudflare token needs to create the app's bucket on R2. */
const R2_PERMISSION = "Account → Workers R2 Storage → Edit";

function cloudflareFix(domain?: string, tunnel = false): string {
  const zone = domain ? ` for the zone that holds ${domain}` : "";
  const permissions = tunnel ? tunnelTokenPermissions() : CLOUDFLARE_TOKEN_PERMISSIONS.join(", ");
  return `Create a token at ${CLOUDFLARE_TOKEN_PAGE} with ${permissions}${zone}, plus ${R2_PERMISSION} only when the app's uploads use Cloudflare R2, then set CLOUDFLARE_API_TOKEN.`;
}

/**
 * Said with a working token: what else the token needs when the plan has a Cloudflare Tunnel, or
 * keeps the app's files on Cloudflare R2.
 */
function tunnelNote(usage: CloudflareUsage): string {
  return [
    ...(usage.tunnel === true
      ? [
          ` The Cloudflare Tunnel and Access also need ${CLOUDFLARE_TUNNEL_PERMISSIONS.join(", ")}; \`opscrew provision\` stops with the missing permission if one is not granted.`,
        ]
      : []),
    ...(usage.r2 === true
      ? [` The app's bucket on Cloudflare R2 also needs ${R2_PERMISSION}.`]
      : []),
  ].join("");
}

/**
 * What the Cloudflare checks share: no token, offline (token set, not checked), or online with
 * the client and one token verification, however many checks ask.
 */
type CloudflareAccess =
  | { state: "unset" }
  | { state: "offline" }
  | { state: "online"; client: CloudflareClient; verified: () => Promise<CredentialCheck> };

function cloudflareAccess(deps: PhaseDeps, offline: boolean): CloudflareAccess {
  const connector = cloudflareConnector(deps);
  const client = connector.client;
  if (client === undefined) return { state: "unset" };
  if (offline) return { state: "offline" };
  let verification: Promise<CredentialCheck> | undefined;
  return {
    state: "online",
    client,
    verified: () => {
      verification ??= connector.verifyCredentials();
      return verification;
    },
  };
}

async function checkCloudflare(
  usage: CloudflareUsage,
  access: CloudflareAccess,
): Promise<CheckResult> {
  const { needed, domain } = usage;
  const tunnel = usage.tunnel === true;
  const problem = needed === true ? "fail" : "warn";
  if (access.state === "unset") {
    if (needed === true) {
      return {
        status: "fail",
        message: `CLOUDFLARE_API_TOKEN is not set, but the plan puts ${domain ?? "the domain"} on Cloudflare.`,
        fix: cloudflareFix(domain, tunnel),
      };
    }
    if (needed === false) {
      return {
        status: "skip",
        message: "Not needed: the plan does not use Cloudflare for DNS.",
      };
    }
    return {
      status: "warn",
      message:
        "CLOUDFLARE_API_TOKEN is not set. It is optional, and only needed when your domain's DNS is on Cloudflare.",
      fix: cloudflareFix(),
    };
  }
  if (access.state === "offline") {
    return {
      status: "pass",
      message: `CLOUDFLARE_API_TOKEN is set (${OFFLINE_NOTE}).${tunnelNote(usage)}`,
    };
  }
  const { client } = access;
  const verified = await access.verified();
  if (!verified.ok) {
    return {
      status: problem,
      message: `CLOUDFLARE_API_TOKEN does not work: ${verified.message}`,
      fix: cloudflareFix(domain, tunnel),
    };
  }
  if (domain === undefined) return { status: "pass", message: "CLOUDFLARE_API_TOKEN works." };
  let zone: Awaited<ReturnType<typeof client.findZone>>;
  try {
    zone = await client.findZone(domain);
  } catch (error) {
    return {
      status: problem,
      message: `CLOUDFLARE_API_TOKEN works but could not look up the zone of ${domain}: ${errorText(error)}`,
      fix: cloudflareFix(domain, tunnel),
    };
  }
  if (!zone) {
    return {
      status: problem,
      message: `CLOUDFLARE_API_TOKEN cannot see the zone of ${domain}: it is missing the "${CLOUDFLARE_TOKEN_PERMISSIONS[0]}" permission for that zone, or the domain is not on Cloudflare yet.`,
      fix: `Add the domain to Cloudflare if it is not there yet. ${cloudflareFix(domain, tunnel)}`,
    };
  }
  // OpsCrew's shared rules: the token must read (and edit) both rulesets they live in.
  let denied: SharedFinding[];
  try {
    const facts = await inspectShared(client, {
      zoneId: zone.id,
      accountId: zone.accountId ?? "",
      access: false,
      ...(usage.redirect === true ? { redirect: true } : {}),
    });
    // Only a missing permission is the token's problem; provision stops on the other findings.
    denied = planShared(facts, { hostnames: {} }, undefined).findings.filter(
      (finding) => finding.code === "permission-missing",
    );
  } catch (error) {
    return {
      status: problem,
      message: `CLOUDFLARE_API_TOKEN works but could not read the rules of the zone ${zone.name}: ${errorText(error)}`,
      fix: cloudflareFix(domain, tunnel),
    };
  }
  if (denied.length > 0) {
    return {
      status: problem,
      message: `CLOUDFLARE_API_TOKEN can see the zone ${zone.name}, but OpsCrew cannot keep its shared rules there: ${denied.map((finding) => finding.message).join(" ")}`,
      fix: denied.map((finding) => finding.hint).join(" "),
    };
  }
  return {
    status: "pass",
    message: `CLOUDFLARE_API_TOKEN works and can see the zone ${zone.name}.${tunnelNote(usage)}`,
  };
}

/** Cloudflare's hosting: its profile, and the one permission its Workers need. */
const CLOUDFLARE_HOSTING = providerProfile("cloudflare-workers");
const WORKERS_PERMISSION = CLOUDFLARE_DEPLOY_TOKEN_PERMISSIONS[0];

/**
 * The provider check of a server-less target (FR-1610), in place of a server's token: Cloudflare's
 * hosting ({@link checkCloudflareHosting}) or GitHub Pages ({@link checkGithubPages}).
 */
async function checkServerlessTarget(
  deps: PhaseDeps,
  offline: boolean,
  provider: ServerlessProvider,
  { plan, requirements }: ProjectArtifacts,
  cloudflare: CloudflareAccess,
  github: () => Promise<GitHubLookup>,
): Promise<CheckResult> {
  if (provider === "github-pages") return checkGithubPages(offline, github);
  // Offline, the Cloudflare access says so (`state: "offline"`).
  return checkCloudflareHosting(deps, plan?.dns.domain ?? requirements?.domain, cloudflare);
}

/**
 * Cloudflare's hosting: OpsCrew's Cloudflare token (`CLOUDFLARE_API_TOKEN`), which creates the
 * Worker and its custom domains, and the deploy token (`OPSCREW_CLOUDFLARE_DEPLOY_TOKEN`), which
 * the deploy workflow uploads each version with, both hold Account → Workers Scripts → Edit for
 * the account of the domain's zone (`workersPermissions`, read-only). Offline, only that both are
 * set. Each failure names the token, the missing permission and the page to add it on.
 */
async function checkCloudflareHosting(
  deps: PhaseDeps,
  domain: string | undefined,
  access: CloudflareAccess,
): Promise<CheckResult> {
  const deployVar = CLOUDFLARE_HOSTING.deployTokenVar;
  const deployToken = deps.env[deployVar]?.trim();
  const account =
    domain === undefined ? "your domain's account" : `the account that holds ${domain}`;
  const deployFix = `Create a second token at ${CLOUDFLARE_TOKEN_PAGE} with only ${WORKERS_PERMISSION} for ${account}, and set ${deployVar} to it: \`opscrew provision\` stores it as a GitHub secret for the deploy workflow, which uploads each version with it.`;
  const mainFix = `Add ${CLOUDFLARE_HOSTING_PERMISSIONS.join(" and ")} to CLOUDFLARE_API_TOKEN at ${CLOUDFLARE_TOKEN_PAGE}.`;
  if (access.state === "unset") {
    return {
      status: "fail",
      message:
        "CLOUDFLARE_API_TOKEN is not set, and Cloudflare hosting creates the app's Worker and its custom domains with it.",
      fix: `${cloudflareFix(domain)} ${mainFix}`,
    };
  }
  if (deployToken === undefined || deployToken === "") {
    return {
      status: "fail",
      message: `${deployVar} is not set: the deploy workflow needs a token of its own that holds only ${WORKERS_PERMISSION}.`,
      fix: deployFix,
    };
  }
  if (access.state === "offline") {
    return {
      status: "pass",
      message: `CLOUDFLARE_API_TOKEN and ${deployVar} are set (${OFFLINE_NOTE}). Both need ${WORKERS_PERMISSION}.`,
    };
  }
  if (domain === undefined) {
    return {
      status: "fail",
      message:
        "Cloudflare hosting serves the site on your domain, and no domain is chosen yet, so the tokens' Workers permission cannot be checked.",
      fix: "Give a domain whose DNS is on Cloudflare in `opscrew interview`, then run `opscrew init` again.",
    };
  }
  const { client } = access;
  const deployClient = cloudflareConnector({
    env: { CLOUDFLARE_API_TOKEN: deployToken },
    fetch: deps.fetch,
    redactor: deps.redactor,
    version: deps.version,
  }).client;
  let missing: string[];
  let zoneName: string;
  try {
    const zone = await client.findZone(domain);
    if (zone?.accountId === undefined) {
      return {
        status: "fail",
        message: `CLOUDFLARE_API_TOKEN cannot see the zone of ${domain}, so the tokens' Workers permission cannot be checked.`,
        fix: `Add the domain to Cloudflare if it is not there yet. ${cloudflareFix(domain)}`,
      };
    }
    zoneName = zone.name;
    const main = await client.workersPermissions(zone.accountId);
    missing = main.missing.map((permission) => `CLOUDFLARE_API_TOKEN lacks ${permission}`);
    try {
      const deploy = await deployClient?.workersPermissions(zone.accountId);
      missing.push(
        ...(deploy?.missing ?? []).map((permission) => `${deployVar} lacks ${permission}`),
      );
    } catch (error) {
      return {
        status: "fail",
        message: `${deployVar} does not work: ${errorText(error)}`,
        fix: deployFix,
      };
    }
  } catch (error) {
    return {
      status: "fail",
      message: `CLOUDFLARE_API_TOKEN could not check its Workers permission: ${errorText(error)}`,
      fix: `${cloudflareFix(domain)} ${mainFix}`,
    };
  }
  if (missing.length > 0) {
    const fixes = [
      ...(missing.some((text) => text.startsWith("CLOUDFLARE_API_TOKEN")) ? [mainFix] : []),
      ...(missing.some((text) => text.startsWith(deployVar)) ? [deployFix] : []),
    ];
    return {
      status: "fail",
      message: `${missing.join("; ")} for the account that holds ${zoneName}.`,
      fix: fixes.join(" "),
    };
  }
  return {
    status: "pass",
    message: `CLOUDFLARE_API_TOKEN and ${deployVar} both hold ${WORKERS_PERMISSION} for the account that holds ${zoneName}.`,
  };
}

/**
 * GitHub Pages: the GitHub token reads the repository's Pages settings (`getPages`; a refusal
 * names the permission) and the repository's plan allows Pages (`pagesAllowed`: a private
 * repository on GitHub's free plan does not; without Plan: Read OpsCrew cannot tell, a warning).
 * Offline, only that a token is available. The write permissions GitHub checks only on a change.
 */
async function checkGithubPages(
  offline: boolean,
  github: () => Promise<GitHubLookup>,
): Promise<CheckResult> {
  const { info, source, client } = await github();
  const needs =
    "GitHub Pages needs the token's Pages and Administration permissions, both Read and write, on the repository";
  if (source === undefined) {
    return {
      status: "fail",
      message: `No GitHub token is set (GITHUB_TOKEN and GH_TOKEN are empty) and the GitHub CLI is not logged in; ${lowerFirst(needs)}.`,
      fix: githubFix(info.coordinates),
    };
  }
  if (offline) {
    return {
      status: "pass",
      message: `A GitHub token is available from ${source} (${OFFLINE_NOTE}). ${needs}.`,
    };
  }
  const coordinates = info.coordinates;
  if (coordinates === undefined || client === undefined) {
    return {
      status: "fail",
      message:
        "There is no GitHub origin, and GitHub Pages publishes the site from the repository on GitHub.",
      fix: REMOTE_FIX,
    };
  }
  const { owner, repo } = coordinates;
  const name = `${owner}/${repo}`;
  let allowed: Awaited<ReturnType<GitHubClient["pagesAllowed"]>>;
  try {
    await client.getPages(owner, repo);
    allowed = await client.pagesAllowed(owner, repo);
  } catch (error) {
    if (!isUserFacingError(error)) throw error;
    return failFrom(error);
  }
  if (allowed === "no") {
    return {
      status: "fail",
      message: `GitHub Pages is not available for ${name}: ${PAGES_NOT_ALLOWED.reason}.`,
      fix: PAGES_NOT_ALLOWED.fix,
    };
  }
  const writes =
    "Turning the site on and setting its domain also need Pages and Administration: Read and write, which GitHub checks only on a change: `opscrew provision` names a missing one before anything changes.";
  if (allowed === "unknown") {
    return {
      status: "warn",
      message: `The GitHub token from ${source} can read the GitHub Pages settings of ${name}, but OpsCrew cannot tell whether the owner's plan allows GitHub Pages for this private repository. ${writes}`,
      fix: "Give the token Plan: Read (an account permission, or an organization permission for an organization's repository) at https://github.com/settings/personal-access-tokens. Without it, `opscrew provision` stops at its first step with nothing changed if the plan has no GitHub Pages.",
    };
  }
  return {
    status: "pass",
    message: `The GitHub token from ${source} can read the GitHub Pages settings of ${name}, and GitHub allows Pages for it. ${writes}`,
  };
}

/** A probe name for the Registrar check; `domain-check` only reads, it buys nothing. */
const REGISTRAR_PROBE_DOMAIN = "opscrew-registrar-check.com";

/** Accounts the Registrar probe tries before giving up. */
const REGISTRAR_PROBE_ACCOUNTS = 3;

const REGISTRAR_FIX = `Buying domains is optional; to enable it add ${CLOUDFLARE_REGISTRAR_PERMISSIONS.join("; ")} to the token at ${CLOUDFLARE_TOKEN_PAGE}.`;

/** The permissions a purchase needs beyond the read the probe makes. */
const REGISTRAR_EDIT_PERMISSIONS = `${CLOUDFLARE_REGISTRAR_PERMISSIONS[0]} and ${CLOUDFLARE_REGISTRAR_PERMISSIONS[1]}, with the zone permissions covering all zones of the account`;

/** A refusal for missing permissions: Cloudflare answered 401 or 403. */
function isPermissionError(error: unknown): boolean {
  return isUserFacingError(error) && error.code === "CREDENTIALS_INVALID";
}

/**
 * Optional check (FR-607): whether the Cloudflare token can buy domains. Lists the accounts and
 * runs a read-only Registrar `domain-check` on a probe name; never fails init.
 */
async function checkRegistrar(access: CloudflareAccess): Promise<CheckResult> {
  if (access.state === "unset") {
    return {
      status: "skip",
      message:
        "Not checked: CLOUDFLARE_API_TOKEN is not set. Buying domains through Cloudflare is optional.",
    };
  }
  if (access.state === "offline") {
    return {
      status: "skip",
      message:
        "Offline: not checked whether CLOUDFLARE_API_TOKEN can buy domains (optional); run `opscrew init` without --offline to check.",
    };
  }
  const { client } = access;
  const verified = await access.verified();
  if (!verified.ok) {
    return {
      status: "skip",
      message:
        "Not checked because CLOUDFLARE_API_TOKEN does not work (see the Cloudflare token check).",
    };
  }
  const refused = (error: unknown): CheckResult =>
    isPermissionError(error)
      ? {
          status: "warn",
          message: `CLOUDFLARE_API_TOKEN cannot buy domains through Cloudflare: ${errorMessage(error)}`,
          fix: REGISTRAR_FIX,
        }
      : {
          status: "warn",
          message: `Could not check whether CLOUDFLARE_API_TOKEN can buy domains: ${errorText(error)}`,
          fix: "Buying domains is optional and nothing else depends on it; run `opscrew init` again to check once more.",
        };

  let accounts: Awaited<ReturnType<typeof client.listAccounts>>;
  try {
    accounts = await client.listAccounts();
  } catch (error) {
    return refused(error);
  }
  if (accounts.length === 0) {
    return {
      status: "warn",
      message:
        "CLOUDFLARE_API_TOKEN cannot buy domains through Cloudflare: it cannot see any Cloudflare account.",
      fix: REGISTRAR_FIX,
    };
  }
  let firstError: unknown;
  for (const account of accounts.slice(0, REGISTRAR_PROBE_ACCOUNTS)) {
    try {
      await client.domainCheck(account.id, [REGISTRAR_PROBE_DOMAIN]);
      const name = account.name ? ` (account ${account.name})` : "";
      // Only a read was checked: the edit permissions cannot be checked without buying.
      return {
        status: "pass",
        message: `CLOUDFLARE_API_TOKEN can use Cloudflare Registrar (read)${name}. Buying also needs ${REGISTRAR_EDIT_PERMISSIONS}; OpsCrew cannot check these without buying.`,
      };
    } catch (error) {
      firstError ??= error;
    }
  }
  return refused(firstError);
}

/** What a registrar's credentials are called in messages. */
const REGISTRAR_CREDENTIALS: Readonly<Record<OtherRegistrarId, string>> = {
  porkbun: "API keys are",
  namecheap: "API user and key are",
  godaddy: "API token is",
};

/**
 * Optional check (FR-707) of one registrar other than Cloudflare, listed when any of its variables
 * is set: names missing variables, says only that the credentials are set when offline, else runs
 * the adapter's `accountCheck` (Porkbun key scopes, Namecheap access and the IPv4 to whitelist,
 * GoDaddy access). Never fails init and never puts a credential value into the text.
 */
async function checkOtherRegistrar(
  deps: PhaseDeps,
  offline: boolean,
  id: OtherRegistrarId,
  registrarCheck: InitServices["registrarCheck"],
): Promise<CheckResult> {
  const name = REGISTRAR_NAMES[id];
  const vars = REGISTRAR_ENV[id];
  const api = registrarLinks(id, deps.env).api;
  const missing = vars.filter((variable) => !hasEnv(deps.env, variable));
  if (missing.length > 0) {
    return {
      status: "warn",
      message: `${name} is only partly set up, ${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} not set. Buying domains through ${name} is optional.`,
      fix: `Create API credentials at ${api} and set ${vars.join(" and ")}, or unset the others to not use ${name}.`,
    };
  }
  if (offline) {
    return {
      status: "pass",
      message: `${name} ${REGISTRAR_CREDENTIALS[id]} set; not checked offline (run \`opscrew init\` without --offline to check them).`,
    };
  }
  let result: RegistrarAccountCheck;
  try {
    if (registrarCheck) {
      result = await registrarCheck(id);
    } else {
      const registrar = registrarFor(id, deps);
      if (!registrar.accountCheck) {
        return {
          status: "pass",
          message: `${name} ${REGISTRAR_CREDENTIALS[id]} set; OpsCrew cannot check this account.`,
        };
      }
      result = await registrar.accountCheck();
    }
  } catch (error) {
    return {
      status: "warn",
      message: `Could not check the ${name} account. ${errorText(error)}`,
      fix: `Buying domains through ${name} is optional; check the API settings at ${api} and run \`opscrew init\` again.`,
    };
  }
  if (result.ok) {
    // The balance is added unless the message states it already (Namecheap's does).
    const balance = result.balance;
    const message =
      balance === undefined || /\bbalance\b/i.test(result.message)
        ? result.message
        : `${result.message.replace(/\.$/, "")} (balance ${balance.amount.toFixed(2)} ${balance.currency}).`;
    // Usable with a caveat (for example a Porkbun key without the purchase permission).
    return result.fix === undefined
      ? { status: "pass", message }
      : { status: "warn", message, fix: result.fix };
  }
  return {
    status: "warn",
    message: result.message,
    fix: result.fix ?? `Check the API settings at ${api}, then run \`opscrew init\` again.`,
  };
}

function githubFix(coordinates?: { owner: string; repo: string }): string {
  const repo = coordinates ? ` for ${coordinates.owner}/${coordinates.repo}` : "";
  return `Set GITHUB_TOKEN (or GH_TOKEN) to a fine-grained token${repo} with ${GITHUB_TOKEN_PERMISSIONS.join(", ")} (create one at https://github.com/settings/personal-access-tokens/new), or run \`gh auth login\`.`;
}

/** The GitHub token and, online with a GitHub origin, what GitHub says about the repository. */
interface GitHubLookup {
  info: RepoInfo;
  /**
   * Where the token came from: `GITHUB_TOKEN`, `GH_TOKEN` or the GitHub CLI login; `undefined`
   * when there is no token.
   */
  source?: string;
  /** The repository as GitHub reports it (read once, online only). */
  repo?: { canPush: boolean; private: boolean };
  /** Why the repository could not be read. */
  error?: unknown;
  /** The client with the token, online with a GitHub origin. */
  client?: GitHubClient;
}

/**
 * Resolves the GitHub token and reads the repository once, however many checks ask (the GitHub
 * check and, for a Portainer target, whether the repository is private).
 */
function githubLookup(
  deps: PhaseDeps,
  offline: boolean,
  repoInfo: Promise<RepoInfo>,
): () => Promise<GitHubLookup> {
  let lookup: Promise<GitHubLookup> | undefined;
  const run = async (): Promise<GitHubLookup> => {
    const info = await repoInfo;
    const client = await githubClientFromToken(deps);
    if (client === undefined) return { info };
    const source = hasEnv(deps.env, "GITHUB_TOKEN")
      ? "GITHUB_TOKEN"
      : hasEnv(deps.env, "GH_TOKEN")
        ? "GH_TOKEN"
        : "the GitHub CLI login";
    const coordinates = info.coordinates;
    if (offline || !coordinates) return { info, source };
    try {
      const repo = await client.getRepo(coordinates.owner, coordinates.repo);
      return { info, source, client, repo: { canPush: repo.canPush, private: repo.private } };
    } catch (error) {
      return { info, source, client, error };
    }
  };
  return () => {
    lookup ??= run();
    return lookup;
  };
}

/**
 * Whether the project's target deploys through GitHub Actions: every cloud, own server and
 * Portainer target, and localhost with the local runner. No target yet (no usable plan or
 * interview answers), or localhost without the local runner, does not.
 */
function deploysThroughActions({ plan, requirements }: ProjectArtifacts): boolean {
  if (plan !== undefined) {
    return plan.target.provider !== "localhost" || plan.environment?.runner === "local";
  }
  return requirements !== undefined && requirements.provider !== "localhost";
}

/**
 * The GitHub token. A missing one fails when the target deploys through GitHub Actions
 * (`required`); before a target, or for localhost without the local runner, it is a note. A token
 * that is set but rejected always fails.
 */
async function checkGitHub(
  offline: boolean,
  github: () => Promise<GitHubLookup>,
  required: boolean,
): Promise<CheckResult> {
  const { info, source, repo, error } = await github();
  if (source === undefined) {
    const missing =
      "No GitHub token is set (GITHUB_TOKEN and GH_TOKEN are empty) and the GitHub CLI is not logged in.";
    return required
      ? { status: "fail", message: missing, fix: githubFix(info.coordinates) }
      : {
          status: "warn",
          message: `${missing} It is needed for deploys through GitHub Actions, the local runner and the deploy-setup pull request.`,
          fix: githubFix(info.coordinates),
        };
  }
  if (offline) {
    return {
      status: "pass",
      message: `A GitHub token is available from ${source} (${OFFLINE_NOTE}).`,
    };
  }
  const coordinates = info.coordinates;
  if (!coordinates) {
    return {
      status: "warn",
      message: `A GitHub token is available from ${source}, but push access was not checked because there is no GitHub origin.`,
      fix: REMOTE_FIX,
    };
  }
  const name = `${coordinates.owner}/${coordinates.repo}`;
  if (repo === undefined) {
    return {
      status: "fail",
      message: `The GitHub token from ${source} cannot read ${name}: ${errorText(error)}`,
      fix: githubFix(coordinates),
    };
  }
  if (!repo.canPush) {
    return {
      status: "fail",
      message: `The GitHub token from ${source} cannot push to ${name}.`,
      fix: githubFix(coordinates),
    };
  }
  return { status: "pass", message: `The GitHub token from ${source} can push to ${name}.` };
}

/**
 * With the scheduled check on: whether the GitHub token has the permissions OpsCrew's side of the
 * check needs, each probed with a read (nothing changes): Issues (`status` reads the check's open
 * issues), Actions (its workflow's state) and Variables (pausing it while OpsCrew moves or tears
 * down an app; writing is checked only when it pauses). Names each missing one and where to add
 * it. Not checked offline or without a token that reads the repository (the GitHub check says
 * why).
 */
async function checkScheduledCheck(github: () => Promise<GitHubLookup>): Promise<CheckResult> {
  const { info, source, client, repo } = await github();
  const coordinates = info.coordinates;
  if (client === undefined || coordinates === undefined || repo === undefined) {
    return {
      status: "skip",
      message:
        source === undefined || coordinates === undefined
          ? "Not checked: the GitHub token check says what is missing."
          : "Not checked: run `opscrew init` online to check the token's Issues, Actions and Variables permissions.",
    };
  }
  const { owner, repo: name } = coordinates;
  const probes = [
    { permission: "Issues: Read", read: () => client.openIssues(owner, name, "opscrew-check") },
    {
      permission: "Actions: Read and write",
      read: () => client.checkWorkflowState(owner, name, "opscrew-check.yml"),
    },
    {
      permission: "Variables: Read and write",
      read: () => client.getRepoVariable(owner, name, CHECK_PAUSED_VARIABLE),
    },
  ];
  const missing: string[] = [];
  for (const probe of probes) {
    try {
      await probe.read();
    } catch (error) {
      if (!isPermissionError(error)) {
        return {
          status: "fail",
          message: `OpsCrew could not check the token's ${probe.permission} permission on ${owner}/${name}: ${errorText(error)}`,
          fix: "Run `opscrew init` again; if it keeps failing, check GitHub's status page.",
        };
      }
      missing.push(probe.permission);
    }
  }
  if (missing.length === 0) {
    return {
      status: "pass",
      message: `The GitHub token from ${source} can read the scheduled check's issues, its workflow's state and the repository's variables.`,
    };
  }
  return {
    status: "fail",
    message: `The GitHub token from ${source} lacks ${listText(missing)} on ${owner}/${name}, which the scheduled check needs: Issues for its open alerts in \`opscrew status\`, Actions for its workflow's state, Variables for pausing it while OpsCrew moves or tears down an app.`,
    fix: `Add ${listText(missing)} under the token's Repository permissions at https://github.com/settings/personal-access-tokens, then run \`opscrew init\` again. Or turn the check off with observability.check.enabled: false in the plan.`,
  };
}

async function checkModel(deps: PhaseDeps): Promise<CheckResult> {
  const env = deps.env;
  const fromEnv =
    hasEnv(env, "ANTHROPIC_API_KEY") ||
    hasEnv(env, "ANTHROPIC_AUTH_TOKEN") ||
    ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"].some(
      (name) => env[name] === "1",
    );
  const availability = deps.runtime ? await deps.runtime.isConfigured() : undefined;
  if (availability?.ok === true || (availability === undefined && fromEnv)) {
    return { status: "pass", message: "Model credentials found." };
  }
  return {
    status: "warn",
    message: `${availability?.reason ?? "No model credentials were found."} OpsCrew still runs its deterministic steps; AI summaries, suggestions and code changes are skipped.`,
    fix: availability?.hint ?? MODEL_HINT,
  };
}

function checkScanners(which: (name: string) => string | undefined): CheckResult {
  const missing = SCANNERS.filter((scanner) => which(scanner.name) === undefined);
  if (missing.length === 0) {
    return { status: "pass", message: "gitleaks, osv-scanner and trivy are installed." };
  }
  const names = missing.map((scanner) => scanner.name);
  return {
    status: "warn",
    message: `Optional: ${names.join(", ")} ${names.length > 1 ? "are" : "is"} not installed. \`opscrew scan\` uses its built-in rules without them.`,
    fix: `For deeper scans install them (\`brew install ${names.join(" ")}\` on macOS or Linux), or see ${missing.map((scanner) => scanner.url).join(", ")}.`,
  };
}

async function checkGitignore(deps: PhaseDeps): Promise<CheckResult> {
  const text = await readGitignore(deps.paths.root);
  const missing = missingGitignoreEntries(text);
  if (missing.length === 0) {
    return {
      status: "pass",
      message: `.gitignore ignores ${describeGitignoreEntries(GITIGNORE_ENTRIES)}.`,
    };
  }
  const what = [
    ...(missing.includes(".opscrew/")
      ? ["OpsCrew's local state (saved plans, Terraform state)"]
      : []),
    ...(missing.includes(".terraform/")
      ? ["the provider binaries OpenTofu or Terraform download under opscrew/infra/"]
      : []),
  ].join(" and ");
  const named = describeGitignoreEntries(missing);
  return {
    status: "warn",
    message: `${text === undefined ? "There is no .gitignore" : `.gitignore does not ignore ${named}`}, so ${what} could be committed.`,
    fix: `Run \`opscrew init --fix\` to add ${named} to .gitignore, or add ${missing.length > 1 ? "them" : "it"} yourself.`,
  };
}
