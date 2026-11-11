/**
 * The user's own tokens (plan.md 9., US6): each one's expiry where the provider gives it, else when
 * this computer first saw it; and replacing one with a new token the user set: checked as `init`
 * checks it, every copy OpsCrew made of it replaced, the date recorded, and the provider's page
 * named for deleting the old one. The old value is never needed, read or shown.
 */
import {
  CLOUDFLARE_TOKEN_PAGE,
  type CloudflareClient,
  cloudflareConnector,
} from "@opscrew/connector-cloudflare";
import { GitHubClient } from "@opscrew/connector-github";
import { canonicalJson, errorText, listText, OpsCrewError, sha256Hex } from "@opscrew/core";
import { CHECK_SECRETS, CLOUDFLARE_DEPLOY_SECRETS, deploySecretName } from "@opscrew/iac-templates";
import { type CloudProvider, type DeployPlan, isCloudProvider } from "@opscrew/plan-schema";
import { cloudProvider } from "@opscrew/providers";
import type { PhaseDeps } from "../context";
import { commandFlags } from "../environments/choice";
import { type InitCheckId, type InitServices, runInitChecks } from "../init";
import { providerProfile } from "../providers";
import { setupGitHub } from "../provision/credentials";
import { type RunProvisionOptions, runProvision } from "../provision/run";
import {
  deploySecretPlaces,
  type SecretPlace,
  secretsEnvironment,
  setSecretAt,
} from "../provision/secrets";
import type { GitHubApi, ProvisionResult } from "../provision/types";
import { requestApproval } from "../shared/approvals";
import { gitClient, githubClientFromToken } from "../shared/github";
import { readPortainerConnection } from "../shared/server-record";
import {
  credentialInventory,
  tokenNotSet,
  USER_TOKENS,
  type UserTokenEntry,
  userTokenValue,
} from "./inventory";
import { readCredentialsRecord, recordRotation, type UserTokenName } from "./record";
import { tokenFirstSeen, tokenSeenAt } from "./record-tokens";

/** What OpsCrew knows of one of the user's tokens; never its value. */
export interface TokenExpiry {
  name: UserTokenName;
  /** The variable OpsCrew reads it from (the first of them when none is set). */
  variable: string;
  /** When the provider says it expires (ISO 8601): Cloudflare's verify answer, GitHub's header. */
  expiresAt?: string;
  /** When this computer first saw it, by its fingerprint. */
  firstSeen?: string;
  /** Why the provider's answer could not be read, in plain words. */
  notRead?: string;
}

/** A copy OpsCrew made of a user's token: a GitHub secret, or Portainer's registry entry. */
export type TokenCopy = ({ kind: "github-secret" } & SecretPlace) | { kind: "portainer-registry" };

/** What {@link replaceToken} did. */
export interface ReplacedToken {
  name: UserTokenName;
  /** Every copy it replaced. */
  copies: TokenCopy[];
  /** The provider's page where the user deletes the old token. */
  deletePage: string;
}

/** {@link replaceToken}'s collaborators besides `deps` (tests replace them). */
export interface ReplaceTokenOptions {
  /** `init`'s check services (`which`, time budget, the Portainer client). */
  init?: InitServices;
  /** GitHub's API for the secrets (default: the client of the user's GitHub token). */
  github?: GitHubApi;
  /** The provision run that replaces Portainer's registry entry (default: `runProvision`). */
  provision?: (options: RunProvisionOptions) => Promise<ProvisionResult>;
}

/** How each of the user's tokens is named and where its expiry comes from. */
interface TokenWords {
  /** In plain words, after "the". */
  title: string;
  /** Whose answer gives its expiry. */
  expiry?: "cloudflare" | "github";
  /** Its copies live in each environment, so an environment's rotation leaves the others'. */
  perEnvironment?: true;
}

/** The words of the tokens that are not a cloud provider's (theirs: {@link tokenWords}). */
const TOKEN_WORDS: Readonly<Record<Exclude<UserTokenName, CloudProvider>, TokenWords>> = {
  cloudflare: { title: "Cloudflare token", expiry: "cloudflare" },
  github: { title: "GitHub token", expiry: "github" },
  "cloudflare-deploy": {
    title: "Cloudflare deploy token",
    expiry: "cloudflare",
    perEnvironment: true,
  },
  ghcr: { title: "GitHub Container Registry read token", expiry: "github", perEnvironment: true },
  ntfy: { title: "ntfy access token" },
};

/**
 * One of the user's tokens: its words, the variables it is read from and whether they are a set
 * (inventory's table).
 */
interface UserToken extends TokenWords, Pick<UserTokenEntry, "vars" | "all"> {}

/**
 * How the token `name` is named: a cloud provider's after the provider (`Hetzner Cloud token`, or
 * `Contabo credentials` for a set).
 */
function tokenWords(name: UserTokenName): TokenWords {
  if (!isCloudProvider(name)) return TOKEN_WORDS[name];
  const profile = providerProfile(name);
  return {
    title: `${profile.displayName} ${profile.tokenMode === "all" ? "credentials" : "token"}`,
  };
}

function userToken(name: UserTokenName): UserToken {
  const entry = USER_TOKENS.find((t) => t.name === name);
  return { ...tokenWords(name), vars: entry?.vars ?? [], ...(entry?.all ? { all: true } : {}) };
}

/**
 * The token's value and the variables it came from (as a list), once it is complete, each
 * variable's value registered with the redactor; else the variables still to set.
 */
function tokenValue(
  deps: Pick<PhaseDeps, "env" | "redactor">,
  token: UserToken,
): { variable: string; value: string } | { missing: readonly string[] } {
  const found = userTokenValue(deps.env, token);
  if ("missing" in found) return found;
  for (const part of found.parts) deps.redactor.addLiteral(part.value, part.variable);
  return { variable: listText(found.parts.map((part) => part.variable)), value: found.value };
}

/** The variables the token is read from, as named while it is not set: the first, or a set's. */
function tokenVariables(token: UserToken): string {
  return listText(token.all ? token.vars : token.vars.slice(0, 1));
}

/** The provider's page where the user deletes the token `name`. */
function deletePage(name: UserTokenName): string {
  if (isCloudProvider(name)) return cloudProvider(name).texts.rotate.deleteToken;
  switch (name) {
    case "cloudflare":
    case "cloudflare-deploy":
      return CLOUDFLARE_TOKEN_PAGE;
    case "github":
      return "https://github.com/settings/personal-access-tokens (a classic token: https://github.com/settings/tokens)";
    case "ghcr":
      return "https://github.com/settings/tokens";
    case "ntfy":
      return "your ntfy server's access tokens (Account → Access tokens; on ntfy.sh: https://ntfy.sh/account)";
  }
}

/** The page with its preposition: "at <address>", "in the console". */
function onPage(page: string): string {
  return `${page.startsWith("https://") ? "at" : "in"} ${page}`;
}

/**
 * The expiry the provider gives for the token `name` (its value `set`, or the variables still to
 * set; GitHub's through the GitHub CLI's login too), or why it gave none.
 */
async function readExpiry(
  deps: Pick<PhaseDeps, "env" | "runner" | "fetch" | "redactor" | "version">,
  name: UserTokenName,
  token: UserToken,
  set: ReturnType<typeof tokenValue>,
): Promise<Pick<TokenExpiry, "expiresAt" | "notRead">> {
  if (name === "github") {
    // The GitHub CLI's login counts too, as everywhere else.
    const client = await githubClientFromToken(deps);
    if (client === undefined) {
      return { notRead: "No GitHub token is set (GITHUB_TOKEN, GH_TOKEN or `gh auth login`)." };
    }
    const expiresAt = await client.tokenExpiry();
    return expiresAt === undefined ? {} : { expiresAt };
  }
  if ("missing" in set) return { notRead: tokenNotSet(set.missing) };
  const common = { fetch: deps.fetch, redactor: deps.redactor, version: deps.version };
  if (token.expiry === "cloudflare") {
    const client = cloudflareConnector({
      env: { CLOUDFLARE_API_TOKEN: set.value },
      ...common,
    }).client;
    // Cloudflare's own words name CLOUDFLARE_API_TOKEN, so the deploy token gets its own.
    const deploy =
      name === "cloudflare-deploy"
        ? `The Cloudflare deploy token in ${set.variable} could not be verified (Cloudflare refused it or did not answer).`
        : undefined;
    let check: Awaited<ReturnType<CloudflareClient["verifyToken"]>> | undefined;
    try {
      check = await client?.verifyToken();
    } catch (error) {
      if (deploy !== undefined) return { notRead: deploy };
      throw error;
    }
    if (check === undefined || !check.ok) {
      return {
        notRead: deploy ?? deps.redactor.redact(check?.message ?? "Cloudflare did not answer."),
      };
    }
    return check.expiresOn === undefined ? {} : { expiresAt: check.expiresOn };
  }
  if (token.expiry === "github") {
    const expiresAt = await new GitHubClient({ token: set.value, ...common }).tokenExpiry();
    return expiresAt === undefined ? {} : { expiresAt };
  }
  return {};
}

/**
 * Each of the user's tokens the environment of `deps.paths` uses (as `credentialInventory` lists
 * them), with its expiry where the provider gives it (Cloudflare's verify answer for the Cloudflare
 * and deploy tokens, GitHub's expiry header for the GitHub and GHCR tokens; Hetzner, DigitalOcean
 * and ntfy give none) and the date this computer first saw it (`tokenSeenAt`, recording nothing).
 * Read-only; a provider that does not answer is `notRead`, redacted. Values are registered with the
 * redactor and never returned.
 */
export async function tokenExpiries(
  deps: Pick<PhaseDeps, "paths" | "env" | "clock" | "runner" | "fetch" | "redactor" | "version">,
  plan: DeployPlan,
): Promise<TokenExpiry[]> {
  const tokens = (await credentialInventory(deps, plan)).filter((c) => c.kind === "user-token");
  return Promise.all(
    tokens.map(async (credential): Promise<TokenExpiry> => {
      const name = credential.name as UserTokenName;
      const token = userToken(name);
      const set = tokenValue(deps, token);
      const base = {
        name,
        variable: "missing" in set ? tokenVariables(token) : set.variable,
        ...(credential.date === undefined ? {} : { firstSeen: credential.date.at }),
      };
      try {
        return { ...base, ...(await readExpiry(deps, name, token, set)) };
      } catch (error) {
        return { ...base, notRead: deps.redactor.redact(errorText(error)) };
      }
    }),
  );
}

/**
 * The `init` checks that check the token `name` in `plan`'s environment. `init` only looks for the
 * GHCR and ntfy tokens being set (the GHCR one together with the repository token), which
 * {@link replaceToken} has already found.
 */
function initChecksOf(name: UserTokenName, plan: DeployPlan): InitCheckId[] {
  if (isCloudProvider(name)) return ["provider"];
  switch (name) {
    // The hosting check reads both Cloudflare tokens' Workers permission.
    case "cloudflare-deploy":
      return ["provider"];
    case "cloudflare":
      return plan.target.provider === "cloudflare-workers"
        ? ["cloudflare", "provider"]
        : ["cloudflare"];
    case "github":
      return ["github", "scheduled-check"];
    case "ghcr":
    case "ntfy":
      return [];
  }
}

/** The copies OpsCrew made of the token `name` for `plan`'s environment. */
async function tokenCopies(
  deps: Pick<PhaseDeps, "paths">,
  plan: DeployPlan,
  name: UserTokenName,
): Promise<TokenCopy[]> {
  switch (name) {
    case "cloudflare-deploy": {
      const secret = deploySecretName(plan, CLOUDFLARE_DEPLOY_SECRETS.apiToken);
      const place = deploySecretPlaces(plan, secretsEnvironment(plan)).find(
        (each) => each.name === secret,
      );
      return place === undefined ? [] : [{ kind: "github-secret", ...place }];
    }
    // One repository secret, which every environment's check run reads.
    case "ntfy":
      return [{ kind: "github-secret", name: CHECK_SECRETS.ntfyToken }];
    // A public image has no registry entry; this computer logs in for each pull and keeps none.
    case "ghcr":
      return plan.target.provider === "portainer" &&
        (await readPortainerConnection(deps.paths))?.publicImage !== true
        ? [{ kind: "portainer-registry" }]
        : [];
    default:
      return [];
  }
}

/**
 * True when `value` is a token `name` this computer already knows for the environment of
 * `deps.paths` (its fingerprint is recorded), unless another environment's last rotation of it put
 * this very token in place (its `rotatedAt` is the token's first-seen date: {@link replaceToken}
 * writes both with one clock reading) and this one was not rotated since.
 */
async function knownHere(
  deps: Pick<PhaseDeps, "paths">,
  name: UserTokenName,
  value: string,
): Promise<boolean> {
  const seen = await tokenSeenAt(deps, name, value);
  if (seen === undefined) return false;
  const environments = (await readCredentialsRecord(deps)).environments;
  const rotated = (env: string) => environments[env]?.[name]?.rotatedAt;
  const here = rotated(deps.paths.environment);
  const elsewhere = Object.keys(environments).some(
    (env) => env !== deps.paths.environment && rotated(env) === seen,
  );
  return !(elsewhere && (here === undefined || here < seen));
}

function copyText(copy: TokenCopy): string {
  if (copy.kind === "portainer-registry") {
    return "  Portainer's registry entry for ghcr.io, by provision's stack plan, which shows its own hash";
  }
  return copy.environment === undefined
    ? `  ${copy.name} (a repository secret)`
    : `  ${copy.name} (in the GitHub environment ${copy.environment})`;
}

/**
 * Replaces the user's token `name` in the environment of `deps.paths` with the new one set in the
 * variable OpsCrew reads it from: stops while it is unset or is the token this computer already
 * knows (its fingerprint is recorded), when the environment does not use it, or when it fails
 * `init`'s checks of it (the permissions OpsCrew needs); then shows every copy OpsCrew made of it
 * and replaces them: the GitHub secrets after one `github-secrets` approval bound to the hash of
 * the secrets, the repository and the new token's fingerprint (`--approve <hash>` in a script),
 * Portainer's registry entry through provision's stack plan (`replaceTokens.registry`, approved by
 * its own hash). Then it records the new token's first-seen date and the rotation, and names the
 * page to delete the old token on. The new value is registered with the redactor first; the old
 * value is never read.
 * @throws OpsCrewError `CREDENTIALS_MISSING`, `INVALID_INPUT` or `CREDENTIALS_INVALID` before
 * anything changes; `APPROVAL_REFUSED` when the approval is refused (nothing changed).
 */
export async function replaceToken(
  deps: PhaseDeps,
  plan: DeployPlan,
  name: UserTokenName,
  options: ReplaceTokenOptions = {},
): Promise<ReplacedToken> {
  const token = userToken(name);
  const { title } = token;
  // A set of credentials (every one of its variables needed) is spoken of in the plural.
  const many = token.all === true;
  const it = many ? "them" : "it";
  const { root, environment, app } = deps.paths;
  const again = `opscrew rotate ${name}${await commandFlags(root, environment, app)}`;
  const page = deletePage(name);
  const set = tokenValue(deps, token);
  const variable = "missing" in set ? tokenVariables(token) : set.variable;
  const setFirst = many
    ? `Make the new credentials ${onPage(page)}, set them in ${variable} first, then run \`${again}\` again.`
    : `Make the new token ${onPage(page)}, set the new token in ${variable} first, then run \`${again}\` again.`;
  if ("missing" in set) {
    throw new OpsCrewError(
      "CREDENTIALS_MISSING",
      `${listText(set.missing)} ${set.missing.length === 1 ? "is" : "are"} not set, so there ${many ? "are" : "is"} no new ${title} to put in place. Nothing was changed.`,
      { hint: setFirst },
    );
  }
  if (await knownHere(deps, name, set.value)) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `${variable} ${many ? "hold" : "holds"} the ${title} OpsCrew already knows, not ${many ? "new ones" : "a new one"}. Nothing was changed.`,
      { hint: setFirst },
    );
  }
  const inventory = await credentialInventory(deps, plan);
  if (!inventory.some((c) => c.kind === "user-token" && c.name === name)) {
    const article = many ? "" : /^[aeiou]/i.test(title) ? "an " : "a ";
    throw new OpsCrewError(
      "INVALID_INPUT",
      `The ${environment} environment does not use ${article}${title}, so there ${many ? "are" : "is"} none to replace. Nothing was changed.`,
      { hint: "Run `opscrew rotate` to list the credentials it has." },
    );
  }

  const ids = initChecksOf(name, plan);
  if (ids.length > 0) {
    deps.reporter.step(`Checking the new ${title} as \`opscrew init\` does`);
    const checks = await runInitChecks(deps, { services: options.init ?? {} });
    const failed = checks.find(
      (check) => ids.includes(check.id) && (check.status === "fail" || check.status === "warn"),
    );
    if (failed !== undefined) {
      throw new OpsCrewError(
        "CREDENTIALS_INVALID",
        `The new ${title} in ${variable} ${many ? "do" : "does"} not pass OpsCrew's check: ${failed.message} Nothing was changed.`,
        { hint: `${failed.fix ?? "Fix the token."} Then run \`${again}\` again.` },
      );
    }
  }

  const copies = await tokenCopies(deps, plan, name);
  deps.reporter.info(
    copies.length === 0
      ? `OpsCrew made no copy of the ${title}: it reads ${it} from ${variable} on this computer.`
      : [`The new ${title} replaces every copy OpsCrew made of it:`, ...copies.map(copyText)].join(
          "\n",
        ),
  );
  const secrets = copies.flatMap((copy) => (copy.kind === "github-secret" ? [copy] : []));
  if (secrets.length > 0) {
    const github = await setupGitHub(
      deps,
      gitClient(deps),
      options.github === undefined ? {} : { github: options.github },
    );
    const repo = `${github.owner}/${github.repo}`;
    const places = secrets.map(({ kind: _kind, ...place }) => place);
    const hash = sha256Hex(
      canonicalJson({
        environment,
        app,
        token: name,
        fingerprint: sha256Hex(set.value),
        repo,
        secrets: places,
      }),
    );
    await requestApproval(deps, {
      kind: "github-secrets",
      title: `Replace the ${title} in ${secrets.length} GitHub secret${secrets.length === 1 ? "" : "s"} of ${repo}`,
      details: [
        `The new ${title} from ${variable} replaces the old one in these secrets (names only; the value is encrypted on this computer before upload and never shown):`,
        ...secrets.map(copyText),
        `Hash: ${hash}`,
      ].join("\n"),
      hash,
      refused: { plan: `replacement of the ${title}`, unchanged: "Nothing was changed.", again },
    });
    for (const place of places) await setSecretAt(deps, github, place, set.value);
  }
  if (copies.some((copy) => copy.kind === "portainer-registry")) {
    deps.reporter.step(
      "Replacing the token of Portainer's registry entry through provision's stack plan",
    );
    const provision = options.provision ?? ((input) => runProvision(deps, input));
    await provision({ replaceTokens: { registry: true }, push: false, secrets: false });
  }

  // One clock reading for both: another environment knows this token as the one put in place now.
  const now = deps.clock.now();
  const at = { paths: deps.paths, clock: { now: () => now } };
  await tokenFirstSeen(at, name, set.value);
  await recordRotation(at, [name]);
  deps.reporter.success(
    copies.length === 0
      ? `The new ${title} passed OpsCrew's check; recorded today's date for ${it}.`
      : `Replaced the ${title} in ${copies.length === 1 ? "its copy" : `its ${copies.length} copies`}; recorded today's date for it.`,
  );
  // Another environment's copy of the old token stays until that environment's rotation.
  const when =
    token.perEnvironment === true && copies.length > 0
      ? ` once every other environment with a copy of it has the new one too (\`opscrew rotate ${name} --env <name>\`)`
      : `: OpsCrew no longer uses ${it}`;
  deps.reporter.info(`Delete the old ${title} ${onPage(page)}${when}.`);
  return { name, copies, deletePage: page };
}
