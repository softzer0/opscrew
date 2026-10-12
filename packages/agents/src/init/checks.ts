import { CLOUDFLARE_TOKEN_PERMISSIONS, cloudflareConnector } from "@opscrew/connector-cloudflare";
import {
  GITHUB_TOKEN_PERMISSIONS,
  GitClient,
  GitHubClient,
  parseGitHubRepo,
  resolveGitHubToken,
} from "@opscrew/connector-github";
import type { CredentialRequirement, VpsProviderId } from "@opscrew/contracts";
import { findExecutable, isUserFacingError } from "@opscrew/core";
import { detectEngines, MIN_ENGINE_VERSION, versionAtLeast } from "@opscrew/iac-engine";
import { readArtifact } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import {
  type ProviderProfile,
  planProvider,
  providerFromTokens,
  providerProfile,
  requestedProvider,
  VPS_PROVIDERS,
  vpsConnector,
} from "../providers";
import { gitignoreCoversOpsCrew, OPSCREW_GITIGNORE_ENTRY, readGitignore } from "./gitignore";

/** Outcome of one check. Only required checks fail; optional ones warn. */
export type InitCheckStatus = "pass" | "warn" | "fail" | "skip";

/** Stable ids of the `opscrew init` checks, in checklist order. */
export type InitCheckId =
  | "node"
  | "git"
  | "repository"
  | "engine"
  | "ssh"
  /** The cloud provider token (Hetzner Cloud or DigitalOcean); was `hetzner` before 004. */
  | "provider"
  | "cloudflare"
  | "github"
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
}

export interface InitCheckOptions {
  /** No network: token checks only look for presence and say so. */
  offline?: boolean;
  services?: InitServices;
}

/** Oldest Node.js OpsCrew runs on. */
export const MIN_NODE_VERSION = "20.19.0";

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

const set = (env: Record<string, string | undefined>, name: string) =>
  (env[name] ?? "").trim() !== "";

function errorText(error: unknown): string {
  if (isUserFacingError(error)) return `${error.message}${error.hint ? ` ${error.hint}` : ""}`;
  return error instanceof Error ? error.message : String(error);
}

/** Whether the plan (or, before design, the requirements) puts the domain on Cloudflare. */
async function cloudflareUsage(
  deps: PhaseDeps,
): Promise<{ needed: boolean | undefined; domain?: string }> {
  try {
    const plan = await readArtifact("plan", deps.paths.files.plan);
    return plan.dns.provider === "cloudflare"
      ? { needed: true, ...(plan.dns.domain ? { domain: plan.dns.domain } : {}) }
      : { needed: false };
  } catch {
    // No usable plan yet: fall back to the interview answers.
  }
  try {
    const requirements = await readArtifact("requirements", deps.paths.files.requirements);
    return requirements.dnsProvider === "cloudflare"
      ? { needed: true, ...(requirements.domain ? { domain: requirements.domain } : {}) }
      : { needed: false };
  } catch {
    return { needed: undefined };
  }
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
 * provider's. Required checks (Node, git repository, engine, ssh, cloud provider and GitHub tokens,
 * Cloudflare when the plan uses it) fail; the rest only warn. Every message is redacted.
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
  for (const name of [...providerTokens, "CLOUDFLARE_API_TOKEN", "GITHUB_TOKEN", "GH_TOKEN"]) {
    const value = env[name]?.trim();
    if (value) deps.redactor.addLiteral(value, name);
  }

  const repoInfo = inspectRepository(deps, which);
  const choice = await providerChoice(deps);

  const checks = await Promise.all([
    guard("node", "Node.js", true, async () => checkNode(services.nodeVersion)),
    guard("git", "git", true, async () => checkGit((await repoInfo).git)),
    guard("repository", "GitHub repository", true, async () => checkRepository(await repoInfo)),
    guard("engine", "OpenTofu or Terraform", true, () => checkEngine(deps, which)),
    guard("ssh", "ssh and ssh-keyscan", true, async () => checkSsh(which)),
    guard("provider", providerTitle(choice), true, () =>
      withBudget(
        checkProviderToken(deps, offline, choice),
        budget,
        choice.provider ? providerProfile(choice.provider).displayName : "The cloud provider",
        true,
      ),
    ),
    guard("cloudflare", "Cloudflare token", false, async () => {
      const usage = await cloudflareUsage(deps);
      return withBudget(
        checkCloudflare(deps, offline, usage),
        budget,
        "Cloudflare",
        usage.needed === true,
      );
    }),
    guard("github", "GitHub token", true, async () => {
      const info = await repoInfo;
      return withBudget(checkGitHub(deps, offline, info), budget, "GitHub", true);
    }),
    guard("model", "Model credentials", false, () => checkModel(deps)),
    guard("scanners", "Optional scanners", false, async () => checkScanners(which)),
    guard("gitignore", ".opscrew/ in .gitignore", false, () => checkGitignore(deps)),
  ]);

  return checks.map((check) => ({
    ...check,
    message: deps.redactor.redact(check.message),
    ...(check.fix === undefined ? {} : { fix: deps.redactor.redact(check.fix) }),
  }));
}

type CheckResult = Omit<InitCheck, "id" | "title">;

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
  const client = new GitClient({
    cwd: deps.paths.root,
    runner: deps.runner,
    env: deps.env,
    git,
    redactor: deps.redactor,
  });
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
  provider?: VpsProviderId;
  /** The plan, the interview answers, or the only token that is set. */
  source: "plan" | "requirements" | "token" | "none";
}

/** The planned provider, else the requested one, else the provider whose token alone is set. */
async function providerChoice(deps: PhaseDeps): Promise<ProviderChoice> {
  try {
    const plan = await readArtifact("plan", deps.paths.files.plan);
    return { provider: planProvider(plan), source: "plan" };
  } catch {
    // No usable plan yet: fall back to the interview answers.
  }
  try {
    const requirements = await readArtifact("requirements", deps.paths.files.requirements);
    return { provider: requestedProvider(requirements), source: "requirements" };
  } catch {
    // No answers yet: fall back to the tokens.
  }
  const provider = providerFromTokens(deps.env);
  return provider ? { provider, source: "token" } : { source: "none" };
}

/** Title of the provider check: `Hetzner Cloud token`, `DigitalOcean token` or a neutral one. */
function providerTitle(choice: ProviderChoice): string {
  return choice.provider
    ? `${providerProfile(choice.provider).displayName} token`
    : "Cloud provider token";
}

/** The first token variable of a provider that is set. */
function tokenVarOf(env: Record<string, string | undefined>, profile: ProviderProfile) {
  return profile.tokenVars.find((name) => set(env, name));
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

const ONLY_ONE =
  "OpsCrew needs only one cloud provider token; `opscrew interview` asks where to run the app.";

/**
 * The cloud provider token check: the chosen provider's token (verified online unless `offline`;
 * the other provider's token is never checked), or before a choice either token.
 */
async function checkProviderToken(
  deps: PhaseDeps,
  offline: boolean,
  choice: ProviderChoice,
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
    return {
      status: "fail",
      message: `No cloud provider token is set (${VPS_PROVIDERS.map((id) => `${providerProfile(id).tokenVars[0]} for ${providerProfile(id).displayName}`).join(" or ")}).`,
      fix: `OpsCrew needs one. ${fixes.join(" ")}`,
    };
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
      fix: `Resolve this in the ${profile.displayName} control panel (${accountUrl(profile)}), then run \`opscrew init\` again.`,
    };
  }
  const needs =
    requirement.scopes.length === 1
      ? `${requirement.scopes[0]} permission`
      : `these scopes (${requirement.scopes.join(", ")})`;
  return {
    status: "fail",
    message: `${envVar} does not work: ${result.message}`,
    fix: `The token needs ${needs}. ${fix}`,
  };
}

/** Where the user fixes account problems (locked account, unverified email). */
function accountUrl(profile: ProviderProfile): string {
  return profile.id === "digitalocean" ? `${profile.consoleUrl}account` : profile.consoleUrl;
}

function lowerFirst(text: string): string {
  return `${text.charAt(0).toLowerCase()}${text.slice(1)}`;
}

function cloudflareFix(domain?: string): string {
  const zone = domain ? ` for the zone that holds ${domain}` : "";
  return `Create a token at https://dash.cloudflare.com/profile/api-tokens with ${CLOUDFLARE_TOKEN_PERMISSIONS.join(", ")}${zone}, then set CLOUDFLARE_API_TOKEN.`;
}

async function checkCloudflare(
  deps: PhaseDeps,
  offline: boolean,
  usage: { needed: boolean | undefined; domain?: string },
): Promise<CheckResult> {
  const { needed, domain } = usage;
  const problem = needed === true ? "fail" : "warn";
  if (!set(deps.env, "CLOUDFLARE_API_TOKEN")) {
    if (needed === true) {
      return {
        status: "fail",
        message: `CLOUDFLARE_API_TOKEN is not set, but the plan puts ${domain ?? "the domain"} on Cloudflare.`,
        fix: cloudflareFix(domain),
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
  if (offline) {
    return { status: "pass", message: `CLOUDFLARE_API_TOKEN is set (${OFFLINE_NOTE}).` };
  }
  const connector = cloudflareConnector({
    env: deps.env,
    fetch: deps.fetch,
    redactor: deps.redactor,
    version: deps.version,
  });
  const client = connector.client;
  if (!client) return { status: problem, message: "CLOUDFLARE_API_TOKEN is not set." };
  const verified = await connector.verifyCredentials();
  if (!verified.ok) {
    return {
      status: problem,
      message: `CLOUDFLARE_API_TOKEN does not work: ${verified.message}`,
      fix: cloudflareFix(domain),
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
      fix: cloudflareFix(domain),
    };
  }
  if (!zone) {
    return {
      status: problem,
      message: `CLOUDFLARE_API_TOKEN cannot see the zone of ${domain}: it is missing the "${CLOUDFLARE_TOKEN_PERMISSIONS[0]}" permission for that zone, or the domain is not on Cloudflare yet.`,
      fix: `Add the domain to Cloudflare if it is not there yet. ${cloudflareFix(domain)}`,
    };
  }
  return {
    status: "pass",
    message: `CLOUDFLARE_API_TOKEN works and can see the zone ${zone.name}.`,
  };
}

function githubFix(coordinates?: { owner: string; repo: string }): string {
  const repo = coordinates ? ` for ${coordinates.owner}/${coordinates.repo}` : "";
  return `Set GITHUB_TOKEN (or GH_TOKEN) to a fine-grained token${repo} with ${GITHUB_TOKEN_PERMISSIONS.join(", ")} (create one at https://github.com/settings/personal-access-tokens/new), or run \`gh auth login\`.`;
}

async function checkGitHub(
  deps: PhaseDeps,
  offline: boolean,
  info: RepoInfo,
): Promise<CheckResult> {
  const token = await resolveGitHubToken(deps.env, deps.runner);
  if (!token) {
    return {
      status: "fail",
      message:
        "No GitHub token: GITHUB_TOKEN and GH_TOKEN are not set and the GitHub CLI is not logged in.",
      fix: githubFix(info.coordinates),
    };
  }
  deps.redactor.addLiteral(token, "github-token");
  const source = set(deps.env, "GITHUB_TOKEN")
    ? "GITHUB_TOKEN"
    : set(deps.env, "GH_TOKEN")
      ? "GH_TOKEN"
      : "the GitHub CLI login";
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
  const client = new GitHubClient({ token, fetch: deps.fetch, version: deps.version });
  let canPush: boolean;
  try {
    canPush = (await client.getRepo(coordinates.owner, coordinates.repo)).canPush;
  } catch (error) {
    return {
      status: "fail",
      message: `The GitHub token from ${source} cannot read ${name}: ${errorText(error)}`,
      fix: githubFix(coordinates),
    };
  }
  if (!canPush) {
    return {
      status: "fail",
      message: `The GitHub token from ${source} cannot push to ${name}.`,
      fix: githubFix(coordinates),
    };
  }
  return { status: "pass", message: `The GitHub token from ${source} can push to ${name}.` };
}

async function checkModel(deps: PhaseDeps): Promise<CheckResult> {
  const env = deps.env;
  const fromEnv =
    set(env, "ANTHROPIC_API_KEY") ||
    set(env, "ANTHROPIC_AUTH_TOKEN") ||
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
  if (text !== undefined && gitignoreCoversOpsCrew(text)) {
    return { status: "pass", message: ".gitignore ignores .opscrew/." };
  }
  return {
    status: "warn",
    message: `${text === undefined ? "There is no .gitignore" : ".gitignore does not ignore .opscrew/"}, so OpsCrew's local state (saved plans, Terraform state) could be committed.`,
    fix: `Run \`opscrew init --fix\` to add ${OPSCREW_GITIGNORE_ENTRY} to .gitignore, or add it yourself.`,
  };
}
