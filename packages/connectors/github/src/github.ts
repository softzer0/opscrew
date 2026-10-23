import { createHash } from "node:crypto";
import type { FetchLike } from "@opscrew/contracts";
import {
  CONNECTION_HINT,
  durationText,
  errorText,
  isRecord,
  OpsCrewError,
  parseAnswer,
  pollAction,
  Redactor,
  realSleep,
} from "@opscrew/core";
import { z } from "zod";
import {
  GhcrReader,
  type ImagePlatform,
  type ImageProvenance,
  type RegistryCredential,
} from "./ghcr";
import { sealSecret } from "./seal";

export const GITHUB_API = "https://api.github.com";

/**
 * The fine-grained permissions OpsCrew's calls need on the repository, as GitHub's token page names
 * them (shown by `opscrew init` and the guide). Actions also covers reading GitHub environments.
 * Administration (GitHub environments, runner registration, the fork-PR policy) and Environments
 * (environment secrets) are needed only for an app with several environments and for self-hosted
 * runners. `opscrew promote` reads GitHub's container registry with `OPSCREW_GHCR_READ_TOKEN` (a
 * classic token with `read:packages`) when it is set, since the registry may not accept a
 * fine-grained token.
 */
export const GITHUB_TOKEN_PERMISSIONS = [
  "Contents: Read and write",
  "Pull requests: Read and write",
  "Secrets: Read and write",
  "Actions: Read and write",
  "Workflows: Read and write",
  "Metadata: Read",
  "Administration: Read and write (only for an app with several environments, and for self-hosted runners)",
  "Environments: Read and write (only for an app with several environments)",
] as const;

export interface GitHubClientOptions {
  token: string;
  fetch: FetchLike;
  baseUrl?: string;
  version?: string;
  /** Waits between polls (default: `setTimeout`); injected by tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Epoch milliseconds for wait loops (default: `Date.now`); injected by tests. */
  now?: () => number;
  /** How long one request may take (default 30 seconds). */
  timeoutMs?: number;
  /**
   * Tokens GitHub hands out (runner tokens, GHCR's pull tokens) are registered here on receipt.
   * Pass the session's redactor; a private one is created when omitted.
   */
  redactor?: Redactor;
}

/** A user or team whose approval a job in a GitHub environment needs. */
export interface EnvironmentReviewer {
  type: "User" | "Team";
  id: number;
}

/** Which branches may deploy to a GitHub environment. */
export interface BranchPolicy {
  protectedBranches: boolean;
  customBranchPolicies: boolean;
}

/** Protection rules of a GitHub environment; a rule left out is not sent. */
export interface EnvironmentSettings {
  /** Minutes a job waits before it starts. */
  waitTimer?: number;
  preventSelfReview?: boolean;
  /** Up to six users or teams. */
  reviewers?: EnvironmentReviewer[];
  /** `null`: every branch may deploy. */
  branchPolicy?: BranchPolicy | null;
  /** Whether repository administrators may skip these rules (GitHub's default: yes). */
  canAdminsBypass?: boolean;
}

/** A GitHub environment with the rules GitHub shows for it. */
export interface EnvironmentView extends Required<EnvironmentSettings> {
  name: string;
}

/** What a repository's GitHub environments enforce, as read back from GitHub. */
export interface EnvironmentCapability {
  environments: boolean;
  branchPolicies: boolean;
  reviewers: boolean;
}

/** A self-hosted runner registered to a repository. */
export interface RunnerInfo {
  id: number;
  name: string;
  status: "online" | "offline";
  labels: string[];
  version?: string;
}

const FORK_PR_APPROVAL_POLICIES = [
  "first_time_contributors_new_to_github",
  "first_time_contributors",
  "all_external_contributors",
] as const;
/** Which outside contributors' pull requests need an approval before workflows run. */
export type ForkPrApprovalPolicy = (typeof FORK_PR_APPROVAL_POLICIES)[number];

/**
 * The source of a workflow run: its repository (`owner/repo`), the event that started it, the
 * repository its commit came from (a fork's, for a pull request from one), its branch, commit and
 * workflow file.
 */
export interface WorkflowRunSource {
  repository: string;
  /** `owner/repo` the head commit came from. */
  headRepository: string;
  /** What started the run: `push`, `pull_request`, `workflow_dispatch`… */
  event: string;
  headBranch: string;
  headSha: string;
  path: string;
}

/** Default time one request to GitHub may take before it counts as failed. */
const REQUEST_TIMEOUT_MS = 30_000;

export interface RepoInfo {
  defaultBranch: string;
  private: boolean;
  canPush: boolean;
}

export interface PullRequest {
  number: number;
  url: string;
}

export interface WorkflowRun {
  id: number;
  status: string;
  conclusion: string | null;
  htmlUrl: string;
  headSha: string;
  createdAt: string;
}

/** A file's entry in the contents API: just its git blob SHA. */
const ContentSchema = z.looseObject({ sha: z.string().regex(/^[0-9a-f]{40,64}$/) });
const RepoSchema = z.looseObject({
  default_branch: z.string(),
  private: z.boolean(),
  permissions: z.looseObject({ push: z.boolean().optional() }).optional(),
});
const PullSchema = z.looseObject({ number: z.number(), html_url: z.string() });
const PublicKeySchema = z.looseObject({ key_id: z.string(), key: z.string() });
const RunSchema = z.looseObject({
  id: z.number(),
  status: z.string(),
  conclusion: z.string().nullable(),
  html_url: z.string(),
  head_sha: z.string(),
  created_at: z.string(),
});
const RunsSchema = z.looseObject({ workflow_runs: z.array(RunSchema) });
const RunSourceSchema = z.looseObject({
  event: z.string(),
  head_repository: z.looseObject({ full_name: z.string() }),
  head_branch: z.string(),
  head_sha: z.string(),
  path: z.string(),
  repository: z.looseObject({ full_name: z.string() }),
});
const UserSchema = z.looseObject({ login: z.string(), id: z.number() });
const AccountSchema = z.looseObject({ id: z.number(), type: z.string() });
const BranchPoliciesSchema = z.looseObject({
  branch_policies: z.array(z.looseObject({ name: z.string() })),
});
const BranchPolicySchema = z.looseObject({
  protected_branches: z.boolean(),
  custom_branch_policies: z.boolean(),
});
const EnvironmentSchema = z.looseObject({
  name: z.string(),
  protection_rules: z
    .array(
      z.looseObject({
        type: z.string(),
        wait_timer: z.number().optional(),
        prevent_self_review: z.boolean().optional(),
        reviewers: z
          .array(
            z.looseObject({
              type: z.enum(["User", "Team"]),
              reviewer: z.looseObject({ id: z.number() }),
            }),
          )
          .optional(),
      }),
    )
    .optional(),
  deployment_branch_policy: BranchPolicySchema.nullable().optional(),
  can_admins_bypass: z.boolean().optional(),
});
const RunnerTokenSchema = z.looseObject({ token: z.string().min(1) });
const RunnersSchema = z.looseObject({
  runners: z.array(
    z.looseObject({
      id: z.number(),
      name: z.string(),
      status: z.enum(["online", "offline"]),
      labels: z.array(z.looseObject({ name: z.string() })),
      version: z.string().optional(),
    }),
  ),
});
const VisibilitySchema = z.looseObject({ visibility: z.enum(["public", "private", "internal"]) });
const ForkPrPolicySchema = z.looseObject({ approval_policy: z.enum(FORK_PR_APPROVAL_POLICIES) });

/** The fine-grained permission the environment, runner and fork-PR endpoints need. */
const ADMINISTRATION = "Administration: Read and write";
/** What reading the runners and the fork-PR policy needs. */
const ADMINISTRATION_READ = "Administration: Read";
/** GitHub's 403 for a token without admin rights that names no permission (an OAuth token's). */
const ADMIN_RIGHTS = /must have admin rights/i;
/** The fine-grained permission the environment secret endpoints need. */
const ENVIRONMENTS = "Environments: Read and write";

/** One permission of `x-accepted-github-permissions` as GitHub's token page names it. */
function permissionText(pair: string): string {
  const [name = "", level = ""] = pair.trim().split("=");
  const words = name
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
  const access = level === "write" ? "Read and write" : level === "read" ? "Read" : level;
  return `${words}: ${access}`;
}

/**
 * `x-accepted-github-permissions` in words: permissions joined by `,` are all needed, and sets
 * joined by `;` are alternatives (`administration=write` → `Administration: Read and write`).
 */
function acceptedPermissions(header: string): string {
  return header
    .split(";")
    .map((set) => set.split(",").map(permissionText).join(" and "))
    .join(", or ");
}

/** GitHub's 403 for a token without the fine-grained permission `needed`, in words. */
function missingPermission(what: string, json: unknown, needed: string): OpsCrewError {
  return new OpsCrewError(
    "CREDENTIALS_INVALID",
    `GitHub refused to ${what} (${messageOf(json, "HTTP 403")}).`,
    {
      hint: `Give the token ${needed} on this repository (https://github.com/settings/personal-access-tokens), then run the command again.`,
    },
  );
}

function toEnvironmentView(env: z.infer<typeof EnvironmentSchema>): EnvironmentView {
  const rules = env.protection_rules ?? [];
  const review = rules.find((rule) => rule.type === "required_reviewers");
  const branches = env.deployment_branch_policy;
  return {
    name: env.name,
    waitTimer: rules.find((rule) => rule.type === "wait_timer")?.wait_timer ?? 0,
    preventSelfReview: review?.prevent_self_review ?? false,
    reviewers: (review?.reviewers ?? []).map((r) => ({ type: r.type, id: r.reviewer.id })),
    branchPolicy: branches
      ? {
          protectedBranches: branches.protected_branches,
          customBranchPolicies: branches.custom_branch_policies,
        }
      : null,
    // GitHub's default when it shows no value.
    canAdminsBypass: env.can_admins_bypass ?? true,
  };
}

function environmentBody(settings: EnvironmentSettings): Record<string, unknown> {
  const { waitTimer, preventSelfReview, reviewers, branchPolicy, canAdminsBypass } = settings;
  return {
    ...(waitTimer === undefined ? {} : { wait_timer: waitTimer }),
    ...(canAdminsBypass === undefined ? {} : { can_admins_bypass: canAdminsBypass }),
    ...(preventSelfReview === undefined ? {} : { prevent_self_review: preventSelfReview }),
    ...(reviewers === undefined ? {} : { reviewers }),
    ...(branchPolicy === undefined
      ? {}
      : {
          deployment_branch_policy:
            branchPolicy === null
              ? null
              : {
                  protected_branches: branchPolicy.protectedBranches,
                  custom_branch_policies: branchPolicy.customBranchPolicies,
                },
        }),
  };
}

/** `/repos/{owner}/{repo}/environments/{name}`, the name encoded. */
function environmentPath(owner: string, repo: string, name: string): string {
  return `/repos/${owner}/${repo}/environments/${encodeURIComponent(name)}`;
}

/** How one {@link GitHubClient} request is sent and which answers are not errors. */
interface RequestOptions {
  body?: unknown;
  /** Statuses returned to the caller instead of thrown. */
  ok?: readonly number[];
  /** The fine-grained permission a 403 names when GitHub's answer names none. */
  permission?: string;
}
const ShaSchema = z.looseObject({ sha: z.string().regex(/^[0-9a-f]{40,64}$/) });
const RefSchema = z.looseObject({ object: ShaSchema });
const CommitSchema = z.looseObject({ tree: ShaSchema, parents: z.array(ShaSchema) });
const TreeSchema = z.looseObject({
  tree: z.array(
    z.looseObject({ path: z.string(), mode: z.string(), type: z.string(), sha: z.string() }),
  ),
  truncated: z.boolean().optional(),
});

/** The `message` of GitHub's error answer, or `fallback` when it has none. */
function messageOf(json: unknown, fallback: string): string {
  return isRecord(json) && "message" in json ? String(json.message) : fallback;
}

/** The git blob SHA-1 of a file's text, as GitHub names it in a tree. */
function gitBlobSha(content: string): string {
  const body = Buffer.from(content, "utf8");
  return createHash("sha1")
    .update(Buffer.concat([Buffer.from(`blob ${body.length}\0`, "utf8"), body]))
    .digest("hex");
}

/**
 * GitHub refused a change to a branch that still exists (HTTP 422): its own words, and what to do.
 * A branch protection rule or a ruleset on the branch is the usual cause.
 */
function refusedRef(
  json: unknown,
  what: string,
  branch: string,
  owner: string,
  repo: string,
): OpsCrewError {
  const said = messageOf(json, "HTTP 422");
  return new OpsCrewError(
    "PROVIDER_ERROR",
    `GitHub refused to ${what} in ${owner}/${repo}: ${said}.`,
    {
      hint: `A branch protection rule or a ruleset may cover ${branch}: allow OpsCrew to force-update and delete ${branch} (Settings → Branches or Rules of ${owner}/${repo}), or delete ${branch} yourself, then run the command again.`,
    },
  );
}

/** An owner or repository name as GitHub allows it (no `/`, never `.` or `..`). */
const REPO_PART = /^(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/;
/** A branch name git accepts that cannot be read as an option or a path trick. */
const BRANCH_NAME = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*\.lock$)[A-Za-z0-9._/-]{1,200}(?<!\/)$/;
/** One file at the root of the tree. */
const ROOT_FILE = /^(?!\.\.?$)[A-Za-z0-9._-]{1,200}$/;

/** True for an owner, repository and branch name that can safely go into an API path. */
function isBranchOf(owner: string, repo: string, branch: string): boolean {
  return REPO_PART.test(owner) && REPO_PART.test(repo) && BRANCH_NAME.test(branch);
}

/** Input of {@link GitHubClient.createOrphanBranch} and {@link GitHubClient.replaceOrphanBranch}. */
export interface OrphanBranchInput {
  owner: string;
  repo: string;
  /** The new branch, for example `opscrew-deploy`. */
  branch: string;
  /** The one file's name at the root, for example `compose.yaml`. */
  path: string;
  /** The file's text (UTF-8). */
  content: string;
  /** The commit message. */
  message: string;
}
/** GitHub's 200 answer to a dispatch ("Create a workflow dispatch event"). */
const DispatchSchema = z.looseObject({ workflow_run_id: z.number(), html_url: z.string() });

function toWorkflowRun(run: z.infer<typeof RunSchema>): WorkflowRun {
  return {
    id: run.id,
    status: run.status,
    conclusion: run.conclusion,
    htmlUrl: run.html_url,
    headSha: run.head_sha,
    createdAt: run.created_at,
  };
}

/** The workflow file name GitHub accepts as a workflow id (`.github/workflows/x.yml` → `x.yml`). */
function workflowId(workflowFile: string): string {
  return encodeURIComponent(workflowFile.split("/").pop() ?? workflowFile);
}

const DEFAULT_RUN_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_RUN_POLL_MS = 5_000;
/** How long a dispatched run may take to show up in GitHub's list (the spike saw 7 seconds). */
const DISPATCHED_RUN_TIMEOUT_MS = 2 * 60_000;

const SECRET_NAME = /^[A-Z_][A-Z0-9_]*$/;

function assertSecretName(name: string): void {
  if (!SECRET_NAME.test(name)) {
    throw new OpsCrewError("INVALID_INPUT", `"${name}" is not a valid GitHub secret name.`, {
      hint: "Use only upper-case letters, digits and underscores, not starting with a digit.",
    });
  }
}

/** Minimal GitHub REST client for what OpsCrew needs. The token never appears in errors. */
export class GitHubClient {
  readonly #token: string;
  readonly #fetch: FetchLike;
  readonly #baseUrl: string;
  readonly #userAgent: string;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;
  readonly #timeoutMs: number;
  readonly #redactor: Redactor;
  readonly #ghcr: GhcrReader;

  constructor(options: GitHubClientOptions) {
    this.#token = options.token;
    this.#fetch = options.fetch;
    this.#baseUrl = (options.baseUrl ?? GITHUB_API).replace(/\/$/, "");
    this.#userAgent = `opscrew/${options.version ?? "0.1.0"}`;
    this.#sleep = options.sleep ?? realSleep;
    this.#now = options.now ?? Date.now;
    this.#timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
    this.#redactor = options.redactor ?? new Redactor();
    this.#ghcr = new GhcrReader({
      fetch: options.fetch,
      credentials: async () => ({ username: await this.whoAmI(), token: this.#token }),
      redactor: this.#redactor,
      timeoutMs: this.#timeoutMs,
    });
  }

  async #request(
    method: string,
    path: string,
    what: string,
    options: RequestOptions = {},
  ): Promise<{ status: number; json: unknown; headers: Headers }> {
    const { body, ok = [], permission } = options;
    const signal = AbortSignal.timeout(this.#timeoutMs);
    let response: Response;
    let text: string;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${this.#token}`,
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": this.#userAgent,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal,
      });
      text = await response.text();
    } catch (error) {
      throw new OpsCrewError(
        "PROVIDER_ERROR",
        signal.aborted
          ? `GitHub did not answer within ${durationText(this.#timeoutMs)} when trying to ${what}.`
          : `Could not reach GitHub to ${what}.`,
        { hint: CONNECTION_HINT, cause: error },
      );
    }
    let json: unknown;
    try {
      json = text.length > 0 ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    if (response.status >= 400 && !ok.includes(response.status)) {
      const message = messageOf(json, `HTTP ${response.status}`);
      if (response.status === 401) {
        throw new OpsCrewError(
          "CREDENTIALS_INVALID",
          `GitHub rejected the token while trying to ${what}.`,
          {
            hint: "Create a fine-grained token at https://github.com/settings/personal-access-tokens/new and set GITHUB_TOKEN, or run `gh auth login`.",
          },
        );
      }
      const accepted = response.headers.get("x-accepted-github-permissions");
      if (response.status === 403 && accepted) {
        throw missingPermission(what, json, acceptedPermissions(accepted));
      }
      if (response.status === 403 && permission) throw missingPermission(what, json, permission);
      if (response.status === 403 || response.status === 404) {
        throw new OpsCrewError("CREDENTIALS_INVALID", `GitHub refused to ${what} (${message}).`, {
          hint: `The token needs access to this repository with: ${GITHUB_TOKEN_PERMISSIONS.join(", ")}.`,
        });
      }
      throw new OpsCrewError("PROVIDER_ERROR", `GitHub could not ${what}: ${message}.`);
    }
    return { status: response.status, json, headers: response.headers };
  }

  #parse<T>(schema: z.ZodType<T>, json: unknown, what: string): T {
    return parseAnswer(schema, json, "GitHub", what);
  }

  async getRepo(owner: string, repo: string): Promise<RepoInfo> {
    const what = `read ${owner}/${repo}`;
    const { json } = await this.#request("GET", `/repos/${owner}/${repo}`, what);
    const data = this.#parse(RepoSchema, json, what);
    return {
      defaultBranch: data.default_branch,
      private: data.private,
      canPush: data.permissions?.push ?? false,
    };
  }

  /**
   * The git blob SHA of `path` (repository-relative, `/`-separated) on `ref`, from
   * `GET /repos/{owner}/{repo}/contents/{path}?ref={ref}`; `undefined` when GitHub answers 404.
   */
  async fileSha(
    owner: string,
    repo: string,
    path: string,
    ref: string,
  ): Promise<string | undefined> {
    const what = `read ${path} on ${ref}`;
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    const query = new URLSearchParams({ ref });
    const { status, json } = await this.#request(
      "GET",
      `/repos/${owner}/${repo}/contents/${encoded}?${query}`,
      what,
      { ok: [404] },
    );
    if (status === 404) return undefined;
    return this.#parse(ContentSchema, json, what).sha;
  }

  /** Refuses input that is not a repository, a branch, one root file and a message. */
  #checkOrphanInput(input: OrphanBranchInput): void {
    if (
      !isBranchOf(input.owner, input.repo, input.branch) ||
      !ROOT_FILE.test(input.path) ||
      input.message.trim() === ""
    ) {
      throw new OpsCrewError(
        "INVALID_INPUT",
        "A branch with one file needs a repository, a branch name, one file name at the root and a commit message.",
      );
    }
  }

  /** The branch's ref path below `/repos/{owner}/{repo}/git/` (each segment encoded). */
  static #refPath(prefix: "ref" | "refs", branch: string): string {
    return `${prefix}/heads/${branch.split("/").map(encodeURIComponent).join("/")}`;
  }

  /** The commit the branch points to, or `undefined` when GitHub has no such branch. */
  async #branchHead(owner: string, repo: string, branch: string): Promise<string | undefined> {
    const what = `check whether the branch ${branch} exists`;
    const ref = await this.#request(
      "GET",
      `/repos/${owner}/${repo}/git/${GitHubClient.#refPath("ref", branch)}`,
      what,
      { ok: [404] },
    );
    if (ref.status === 404) return undefined;
    return this.#parse(RefSchema, ref.json, what).object.sha;
  }

  /** A new commit without parents whose tree holds only the input's one file. */
  async #orphanCommit(input: OrphanBranchInput, what: string): Promise<string> {
    const base = `/repos/${input.owner}/${input.repo}/git`;
    const blob = await this.#request("POST", `${base}/blobs`, what, {
      body: { content: input.content, encoding: "utf-8" },
    });
    const blobSha = this.#parse(ShaSchema, blob.json, what).sha;
    const tree = await this.#request("POST", `${base}/trees`, what, {
      body: { tree: [{ path: input.path, mode: "100644", type: "blob", sha: blobSha }] },
    });
    const treeSha = this.#parse(ShaSchema, tree.json, what).sha;
    const commit = await this.#request("POST", `${base}/commits`, what, {
      body: { message: input.message, tree: treeSha, parents: [] },
    });
    return this.#parse(ShaSchema, commit.json, what).sha;
  }

  /**
   * Creates `branch` holding only one file and no history (an orphan branch) through GitHub's Git
   * Data API: a blob, a tree with only that file, a commit without parents, then the branch's ref.
   * Refuses with `PHASE_PRECONDITION` when the branch exists (checked first, and again by GitHub
   * when the ref is created), so it never moves or overwrites a branch. Needs Contents: Read and
   * write on the repository.
   */
  async createOrphanBranch(input: OrphanBranchInput): Promise<{ commit: string }> {
    this.#checkOrphanInput(input);
    const { owner, repo, branch } = input;
    const exists = () =>
      new OpsCrewError(
        "PHASE_PRECONDITION",
        `The branch ${branch} already exists in ${owner}/${repo}, so OpsCrew did not create it again.`,
        { hint: `OpsCrew creates ${branch} only when it is missing; it never overwrites it.` },
      );
    if ((await this.#branchHead(owner, repo, branch)) !== undefined) throw exists();
    const what = `create the branch ${branch}`;
    const commit = await this.#orphanCommit(input, what);
    const created = await this.#request("POST", `/repos/${owner}/${repo}/git/refs`, what, {
      body: { ref: `refs/heads/${branch}`, sha: commit },
      ok: [422],
    });
    if (created.status === 422) {
      // Someone created it meanwhile, or GitHub refused to (a ruleset may forbid it).
      if ((await this.#branchHead(owner, repo, branch)) !== undefined) throw exists();
      throw refusedRef(created.json, `create the branch ${branch}`, branch, owner, repo);
    }
    return { commit };
  }

  /**
   * Points the existing `branch` at a new commit without parents that holds only one file (its
   * earlier history is no longer on the branch), through GitHub's Git Data API: a blob, a tree, a
   * commit, then a forced update of the branch's ref. Refuses with `PHASE_PRECONDITION` when the
   * branch does not exist (use {@link createOrphanBranch}). Returns the new commit and the one the
   * branch pointed to before. Needs Contents: Read and write on the repository.
   */
  async replaceOrphanBranch(
    input: OrphanBranchInput,
  ): Promise<{ commit: string; previous: string }> {
    this.#checkOrphanInput(input);
    const { owner, repo, branch } = input;
    const missing = () =>
      new OpsCrewError(
        "PHASE_PRECONDITION",
        `The branch ${branch} does not exist in ${owner}/${repo}, so OpsCrew has nothing to replace.`,
        { hint: `Create ${branch} instead; OpsCrew replaces only a branch that exists.` },
      );
    const previous = await this.#branchHead(owner, repo, branch);
    if (previous === undefined) throw missing();
    const what = `replace the branch ${branch}`;
    const commit = await this.#orphanCommit(input, what);
    const updated = await this.#request(
      "PATCH",
      `/repos/${owner}/${repo}/git/${GitHubClient.#refPath("refs", branch)}`,
      what,
      { body: { sha: commit, force: true }, ok: [422] },
    );
    if (updated.status === 422) {
      // Gone meanwhile, or still there and GitHub refused the forced update.
      if ((await this.#branchHead(owner, repo, branch)) === undefined) throw missing();
      throw refusedRef(updated.json, `force-update the branch ${branch}`, branch, owner, repo);
    }
    return { commit, previous };
  }

  /**
   * Deletes `branch` (its ref) from the repository. `"absent"` when GitHub has no such branch, also
   * when it goes between the check and the delete. Needs Contents: Read and write.
   */
  async deleteBranch(owner: string, repo: string, branch: string): Promise<"deleted" | "absent"> {
    if (!isBranchOf(owner, repo, branch)) {
      throw new OpsCrewError(
        "INVALID_INPUT",
        "Deleting a branch needs a repository and a branch name.",
      );
    }
    if ((await this.#branchHead(owner, repo, branch)) === undefined) return "absent";
    const deleted = await this.#request(
      "DELETE",
      `/repos/${owner}/${repo}/git/${GitHubClient.#refPath("refs", branch)}`,
      `delete the branch ${branch}`,
      { ok: [422] },
    );
    if (deleted.status !== 422) return "deleted";
    // Gone meanwhile, or still there and GitHub refused to delete it.
    if ((await this.#branchHead(owner, repo, branch)) === undefined) return "absent";
    throw refusedRef(deleted.json, `delete the branch ${branch}`, branch, owner, repo);
  }

  /**
   * True when `branch` holds exactly one commit without parents whose tree is only the file `path`
   * with `content` (a regular file, compared by its git blob SHA): the branch already is what
   * {@link createOrphanBranch} or {@link replaceOrphanBranch} would make of it. `false` when it
   * holds anything else or does not exist. Read-only.
   */
  async branchHoldsOnly(
    owner: string,
    repo: string,
    branch: string,
    file: { path: string; content: string },
  ): Promise<boolean> {
    if (!isBranchOf(owner, repo, branch) || !ROOT_FILE.test(file.path)) {
      throw new OpsCrewError(
        "INVALID_INPUT",
        "Reading a branch needs a repository, a branch name and one file name at the root.",
      );
    }
    const head = await this.#branchHead(owner, repo, branch);
    if (head === undefined) return false;
    const base = `/repos/${owner}/${repo}/git`;
    const what = `read the branch ${branch}`;
    const commit = this.#parse(
      CommitSchema,
      (await this.#request("GET", `${base}/commits/${head}`, what)).json,
      what,
    );
    if (commit.parents.length > 0) return false;
    const tree = this.#parse(
      TreeSchema,
      (await this.#request("GET", `${base}/trees/${commit.tree.sha}`, what)).json,
      what,
    );
    const [only, ...more] = tree.tree;
    return (
      tree.truncated !== true &&
      more.length === 0 &&
      only !== undefined &&
      only.path === file.path &&
      only.type === "blob" &&
      only.mode === "100644" &&
      only.sha === gitBlobSha(file.content)
    );
  }

  async findOpenPullRequest(
    owner: string,
    repo: string,
    head: string,
  ): Promise<PullRequest | undefined> {
    const what = "look for an open pull request";
    const query = new URLSearchParams({ state: "open", head: `${owner}:${head}`, per_page: "1" });
    const { json } = await this.#request("GET", `/repos/${owner}/${repo}/pulls?${query}`, what);
    const first = this.#parse(z.array(PullSchema), json, what)[0];
    return first ? { number: first.number, url: first.html_url } : undefined;
  }

  async createPullRequest(input: {
    owner: string;
    repo: string;
    head: string;
    base: string;
    title: string;
    body: string;
  }): Promise<PullRequest> {
    const what = "open a pull request";
    const { json } = await this.#request(
      "POST",
      `/repos/${input.owner}/${input.repo}/pulls`,
      what,
      {
        body: { title: input.title, head: input.head, base: input.base, body: input.body },
      },
    );
    const pull = this.#parse(PullSchema, json, what);
    return { number: pull.number, url: pull.html_url };
  }

  /** The sealing key of the secrets below `secretsPath` (`…/actions/secrets` and the like). */
  async #publicKey(
    secretsPath: string,
    what: string,
    permission?: string,
  ): Promise<{ keyId: string; key: string }> {
    const { json } = await this.#request("GET", `${secretsPath}/public-key`, what, {
      ...(permission ? { permission } : {}),
    });
    const key = this.#parse(PublicKeySchema, json, what);
    return { keyId: key.key_id, key: key.key };
  }

  /** Seals `value` locally to `key` and stores it as the secret `name` below `secretsPath`. */
  async #putSecret(
    secretsPath: string,
    name: string,
    value: string,
    key: { keyId: string; key: string },
    permission?: string,
  ): Promise<void> {
    const encrypted = await sealSecret(key.key, value);
    await this.#request("PUT", `${secretsPath}/${name}`, `store the secret ${name}`, {
      body: { encrypted_value: encrypted, key_id: key.keyId },
      ...(permission ? { permission } : {}),
    });
  }

  async getActionsPublicKey(owner: string, repo: string): Promise<{ keyId: string; key: string }> {
    return this.#publicKey(
      `/repos/${owner}/${repo}/actions/secrets`,
      "read the repository's Actions secrets key",
    );
  }

  /** Creates or updates an Actions secret. The value is sealed locally; GitHub never sees plaintext. */
  async setActionsSecret(
    owner: string,
    repo: string,
    name: string,
    value: string,
    publicKey?: { keyId: string; key: string },
  ): Promise<void> {
    assertSecretName(name);
    const key = publicKey ?? (await this.getActionsPublicKey(owner, repo));
    await this.#putSecret(`/repos/${owner}/${repo}/actions/secrets`, name, value, key);
  }

  /** Deletes an Actions secret. A secret that does not exist (404) counts as deleted. */
  async deleteActionsSecret(owner: string, repo: string, name: string): Promise<void> {
    assertSecretName(name);
    await this.#request(
      "DELETE",
      `/repos/${owner}/${repo}/actions/secrets/${name}`,
      `delete the secret ${name}`,
      { ok: [404] },
    );
  }

  /** The sealing key of the GitHub environment `env`'s secrets. Needs Environments. */
  async environmentPublicKey(
    owner: string,
    repo: string,
    env: string,
  ): Promise<{ keyId: string; key: string }> {
    return this.#publicKey(
      `${environmentPath(owner, repo, env)}/secrets`,
      `read the secrets key of the environment ${env}`,
      ENVIRONMENTS,
    );
  }

  /**
   * Creates or updates a secret of the GitHub environment `env`. The value is sealed locally;
   * GitHub never sees plaintext. Needs Environments: Read and write.
   */
  async setEnvironmentSecret(
    owner: string,
    repo: string,
    env: string,
    name: string,
    value: string,
    publicKey?: { keyId: string; key: string },
  ): Promise<void> {
    assertSecretName(name);
    const key = publicKey ?? (await this.environmentPublicKey(owner, repo, env));
    const secrets = `${environmentPath(owner, repo, env)}/secrets`;
    await this.#putSecret(secrets, name, value, key, ENVIRONMENTS);
  }

  /** Deletes a secret of the GitHub environment `env`; a missing one (404) counts as deleted. */
  async deleteEnvironmentSecret(
    owner: string,
    repo: string,
    env: string,
    name: string,
  ): Promise<void> {
    assertSecretName(name);
    await this.#request(
      "DELETE",
      `${environmentPath(owner, repo, env)}/secrets/${name}`,
      `delete the secret ${name} of the environment ${env}`,
      { ok: [404], permission: ENVIRONMENTS },
    );
  }

  /** The GitHub environment `name` with its rules. Needs Administration: Read and write. */
  async putEnvironment(
    owner: string,
    repo: string,
    name: string,
    settings: EnvironmentSettings,
  ): Promise<EnvironmentView> {
    const what = `create or update the environment ${name}`;
    const { json } = await this.#request("PUT", environmentPath(owner, repo, name), what, {
      body: environmentBody(settings),
      permission: ADMINISTRATION,
    });
    return toEnvironmentView(this.#parse(EnvironmentSchema, json, what));
  }

  /** The GitHub environment `name` as GitHub shows it; `undefined` when there is none (404). */
  async getEnvironment(
    owner: string,
    repo: string,
    name: string,
  ): Promise<EnvironmentView | undefined> {
    const what = `read the environment ${name}`;
    const { status, json } = await this.#request("GET", environmentPath(owner, repo, name), what, {
      ok: [404],
    });
    if (status === 404) return undefined;
    return toEnvironmentView(this.#parse(EnvironmentSchema, json, what));
  }

  /**
   * Lets jobs on `branch` deploy to the GitHub environment `env`, whose branch policy must be
   * custom branch policies (`putEnvironment` first). For a name GitHub already has, it answers
   * 303 to that policy, which fetch follows. Needs Administration: Read and write.
   */
  async addDeploymentBranch(
    owner: string,
    repo: string,
    env: string,
    branch: string,
  ): Promise<void> {
    await this.#request(
      "POST",
      `${environmentPath(owner, repo, env)}/deployment-branch-policies`,
      `let ${branch} deploy to the environment ${env}`,
      { body: { name: branch, type: "branch" }, permission: ADMINISTRATION },
    );
  }

  /**
   * The names of the custom branch policies of the GitHub environment `env` (up to 100): the
   * branches allowed to deploy to it when its branch policy is custom. Needs Administration.
   */
  async listDeploymentBranches(owner: string, repo: string, env: string): Promise<string[]> {
    const what = `read which branches may deploy to the environment ${env}`;
    const { json } = await this.#request(
      "GET",
      `${environmentPath(owner, repo, env)}/deployment-branch-policies?per_page=100`,
      what,
      { permission: ADMINISTRATION_READ },
    );
    return this.#parse(BranchPoliciesSchema, json, what).branch_policies.map((p) => p.name);
  }

  /** Deletes the GitHub environment `name` with its secrets; a missing one (404) counts as deleted. */
  async deleteEnvironment(owner: string, repo: string, name: string): Promise<void> {
    await this.#request(
      "DELETE",
      environmentPath(owner, repo, name),
      `delete the environment ${name}`,
      { ok: [404], permission: ADMINISTRATION },
    );
  }

  /**
   * What this repository's GitHub environments enforce, checked on the throwaway environment
   * `probe`, a fresh name (`opscrew-probe-<8 random hex>`), in steps: created with custom branch
   * policies and `branch` (the default branch) added, then given the user as reviewer and a wait
   * timer, read back, and deleted again (also after a failure). A step GitHub refuses marks only
   * its own capability as missing; when GitHub refuses the branch policy, a plain environment is
   * tried, and when it refuses that too without naming a missing permission, nothing is enforced.
   * A 403 that names one (or says admin rights are needed) stops with it. No other environment is
   * touched, and a `probe` that already exists is refused before any change. The check is a
   * `github-settings` change the caller shows first, naming `probe`.
   */
  async environmentCapability(
    owner: string,
    repo: string,
    probe: string,
    branch: string,
  ): Promise<EnvironmentCapability> {
    if ((await this.getEnvironment(owner, repo, probe)) !== undefined) {
      throw new OpsCrewError(
        "PHASE_PRECONDITION",
        `The GitHub environment ${probe} already exists in ${owner}/${repo}, and OpsCrew checks what GitHub enforces only on an environment it creates for the check, so it changed nothing.`,
        { hint: "Run the command again; the check picks another name." },
      );
    }
    const me = await this.#me(UserSchema);
    // The probe may exist unless GitHub answered every PUT sent with a 403, which creates nothing;
    // a validation error may (a Free private repository creates it without the rules).
    let sent = 0;
    let forbidden = 0;
    const put = async (settings: EnvironmentSettings): Promise<boolean> => {
      sent++;
      const answer = await this.#tryPutEnvironment(owner, repo, probe, settings);
      if (answer.status === 403) forbidden++;
      if (answer.refusal) throw answer.refusal;
      return answer.status < 400;
    };
    try {
      // GitHub merges a PUT, so each step keeps what the one before set.
      const custom = await put({
        branchPolicy: { protectedBranches: false, customBranchPolicies: true },
      });
      if (!custom && !(await put({}))) {
        return { environments: false, branchPolicies: false, reviewers: false };
      }
      const branchAdded =
        custom && (await this.#tryAddDeploymentBranch(owner, repo, probe, branch));
      await put({ waitTimer: 1, reviewers: [{ type: "User", id: me.id }] });
      const after = await this.getEnvironment(owner, repo, probe);
      return {
        environments: after !== undefined,
        branchPolicies: branchAdded && after?.branchPolicy?.customBranchPolicies === true,
        reviewers: after?.reviewers.some((r) => r.type === "User" && r.id === me.id) ?? false,
      };
    } finally {
      if (sent > forbidden) await this.#deleteProbe(owner, repo, probe);
    }
  }

  /** {@link addDeploymentBranch}, false where GitHub has no branch policies (404) or refuses it (422). */
  async #tryAddDeploymentBranch(
    owner: string,
    repo: string,
    env: string,
    branch: string,
  ): Promise<boolean> {
    const { status } = await this.#request(
      "POST",
      `${environmentPath(owner, repo, env)}/deployment-branch-policies`,
      `let ${branch} deploy to the environment ${env}`,
      { body: { name: branch, type: "branch" }, ok: [404, 422], permission: ADMINISTRATION },
    );
    return status < 400;
  }

  /**
   * `PUT` of an environment, with GitHub's status; a validation error (422) or a 403 is not
   * thrown. A 403 naming a missing permission (or admin rights) comes back as `refusal`.
   */
  async #tryPutEnvironment(
    owner: string,
    repo: string,
    name: string,
    settings: EnvironmentSettings,
  ): Promise<{ status: number; refusal?: OpsCrewError }> {
    const what = `create the environment ${name}`;
    const { status, json, headers } = await this.#request(
      "PUT",
      environmentPath(owner, repo, name),
      what,
      { body: environmentBody(settings), ok: [403, 422] },
    );
    const accepted = headers.get("x-accepted-github-permissions");
    if (status === 403 && accepted) {
      return { status, refusal: missingPermission(what, json, acceptedPermissions(accepted)) };
    }
    if (status === 403 && ADMIN_RIGHTS.test(messageOf(json, ""))) {
      return { status, refusal: missingPermission(what, json, ADMINISTRATION) };
    }
    return { status };
  }

  /** Deletes the capability check's throwaway environment; says what to delete if it cannot. */
  async #deleteProbe(owner: string, repo: string, probe: string): Promise<void> {
    try {
      await this.deleteEnvironment(owner, repo, probe);
    } catch (error) {
      throw new OpsCrewError(
        error instanceof OpsCrewError ? error.code : "PROVIDER_ERROR",
        `OpsCrew created the throwaway environment ${probe} to check what GitHub enforces, but could not delete it again (${errorText(error)}).`,
        { hint: `Delete ${probe} in Settings → Environments of ${owner}/${repo}.`, cause: error },
      );
    }
  }

  /** A token GitHub issues for runners (one hour), registered with the redactor on receipt. */
  async #runnerToken(
    owner: string,
    repo: string,
    kind: "registration" | "remove",
  ): Promise<string> {
    const what = `get a runner ${kind} token`;
    const { json } = await this.#request(
      "POST",
      `/repos/${owner}/${repo}/actions/runners/${kind}-token`,
      what,
      { permission: ADMINISTRATION },
    );
    const { token } = this.#parse(RunnerTokenSchema, json, what);
    this.#redactor.addLiteral(token, `github-runner-${kind}-token`);
    return token;
  }

  /** A token to register a self-hosted runner (`config.sh --token`), valid for one hour. */
  async runnerRegistrationToken(owner: string, repo: string): Promise<string> {
    return this.#runnerToken(owner, repo, "registration");
  }

  /** A token to remove a self-hosted runner (`config.sh remove --token`), valid for one hour. */
  async runnerRemoveToken(owner: string, repo: string): Promise<string> {
    return this.#runnerToken(owner, repo, "remove");
  }

  /** The repository's self-hosted runners (up to 100). Needs Administration. */
  async listRunners(owner: string, repo: string): Promise<RunnerInfo[]> {
    const what = "list the repository's self-hosted runners";
    const { json } = await this.#request(
      "GET",
      `/repos/${owner}/${repo}/actions/runners?per_page=100`,
      what,
      { permission: ADMINISTRATION_READ },
    );
    return this.#parse(RunnersSchema, json, what).runners.map((runner) => ({
      id: runner.id,
      name: runner.name,
      status: runner.status,
      labels: runner.labels.map((label) => label.name),
      ...(runner.version === undefined ? {} : { version: runner.version }),
    }));
  }

  /** Removes a self-hosted runner from the repository; a missing one (404) counts as removed. */
  async deleteRunner(owner: string, repo: string, id: number): Promise<void> {
    await this.#request(
      "DELETE",
      `/repos/${owner}/${repo}/actions/runners/${id}`,
      `remove the self-hosted runner ${id}`,
      { ok: [404], permission: ADMINISTRATION },
    );
  }

  async repositoryVisibility(
    owner: string,
    repo: string,
  ): Promise<"public" | "private" | "internal"> {
    const what = `read whether ${owner}/${repo} is public`;
    const { json } = await this.#request("GET", `/repos/${owner}/${repo}`, what);
    return this.#parse(VisibilitySchema, json, what).visibility;
  }

  /** Which outside contributors' pull requests need an approval before workflows run. */
  async forkPrApprovalPolicy(owner: string, repo: string): Promise<ForkPrApprovalPolicy> {
    const what = "read the approval policy for pull requests from forks";
    const { json } = await this.#request(
      "GET",
      `/repos/${owner}/${repo}/actions/permissions/fork-pr-contributor-approval`,
      what,
      { permission: ADMINISTRATION_READ },
    );
    return this.#parse(ForkPrPolicySchema, json, what).approval_policy;
  }

  /** Sets the fork-PR approval policy: a `github-settings` change the caller shows first. */
  async setForkPrApprovalPolicy(
    owner: string,
    repo: string,
    policy: ForkPrApprovalPolicy,
  ): Promise<void> {
    await this.#request(
      "PUT",
      `/repos/${owner}/${repo}/actions/permissions/fork-pr-contributor-approval`,
      "set the approval policy for pull requests from forks",
      { body: { approval_policy: policy }, permission: ADMINISTRATION },
    );
  }

  /**
   * Lists recent runs of a workflow, newest first. `event` and `createdSince` (ISO time) narrow
   * the list to runs of that trigger created at or after that time.
   */
  async listWorkflowRuns(
    owner: string,
    repo: string,
    options: {
      workflowFile: string;
      branch?: string;
      perPage?: number;
      event?: string;
      createdSince?: string;
    },
  ): Promise<WorkflowRun[]> {
    const what = "list workflow runs";
    const query = new URLSearchParams({ per_page: String(options.perPage ?? 5) });
    if (options.branch) query.set("branch", options.branch);
    if (options.event) query.set("event", options.event);
    if (options.createdSince) query.set("created", `>=${options.createdSince}`);
    const { json } = await this.#request(
      "GET",
      `/repos/${owner}/${repo}/actions/workflows/${workflowId(options.workflowFile)}/runs?${query}`,
      what,
    );
    return this.#parse(RunsSchema, json, what).workflow_runs.map(toWorkflowRun);
  }

  /** Reads one workflow run. */
  async getWorkflowRun(owner: string, repo: string, runId: number): Promise<WorkflowRun> {
    const what = `read workflow run ${runId}`;
    const { json } = await this.#request(
      "GET",
      `/repos/${owner}/${repo}/actions/runs/${runId}`,
      what,
    );
    return toWorkflowRun(this.#parse(RunSchema, json, what));
  }

  /** Where a workflow run came from; `undefined` when GitHub has no such run (404). */
  async workflowRun(
    owner: string,
    repo: string,
    runId: number,
  ): Promise<WorkflowRunSource | undefined> {
    const what = `read workflow run ${runId}`;
    const { status, json } = await this.#request(
      "GET",
      `/repos/${owner}/${repo}/actions/runs/${runId}`,
      what,
      { ok: [404] },
    );
    if (status === 404) return undefined;
    const run = this.#parse(RunSourceSchema, json, what);
    return {
      repository: run.repository.full_name,
      headRepository: run.head_repository.full_name,
      event: run.event,
      headBranch: run.head_branch,
      headSha: run.head_sha,
      path: run.path,
    };
  }

  /**
   * Starts a `workflow_dispatch` run of `workflowFile` on `ref` with `inputs`, and returns the run
   * it started: the one GitHub's 200 answer names (`workflow_run_id`, `html_url`). After the older
   * 204 answer, it is the first dispatch run of that file on that branch created since the
   * dispatch by GitHub's clock (the answer's `Date`), polled until it shows up. `onAccepted` runs
   * as soon as GitHub has accepted the dispatch, before any wait, so a caller can record it.
   * GitHub's 404 or 422 (no such workflow on the default branch, no `workflow_dispatch` trigger for
   * these inputs) is `PHASE_PRECONDITION`.
   */
  async dispatchWorkflow(
    owner: string,
    repo: string,
    workflowFile: string,
    ref: string,
    inputs: Record<string, string> = {},
    onAccepted?: () => Promise<void>,
  ): Promise<{ runId: number; url: string }> {
    const what = `start the workflow ${workflowFile} on ${ref}`;
    const { status, json, headers } = await this.#request(
      "POST",
      `/repos/${owner}/${repo}/actions/workflows/${workflowId(workflowFile)}/dispatches`,
      what,
      { body: { ref, inputs }, ok: [404, 422] },
    );
    // 404: GitHub knows no such workflow (its file is not on the default branch); 422: the file on
    // `ref` has no `workflow_dispatch` trigger taking these inputs, or there is no such ref.
    if (status === 404 || status === 422) {
      throw new OpsCrewError(
        "PHASE_PRECONDITION",
        `GitHub cannot ${what}: ${messageOf(json, `HTTP ${status}`)}.`,
        {
          hint: `GitHub starts a workflow by hand only when its file is on the default branch, with a workflow_dispatch trigger that takes the inputs given. Check ${workflowFile} on ${ref}, then try again.`,
        },
      );
    }
    await onAccepted?.();
    if (status !== 204) {
      const named = this.#parse(DispatchSchema, json, what);
      return { runId: named.workflow_run_id, url: named.html_url };
    }
    // GitHub's `Date` has whole seconds, and so has a run's `created_at`: a second of allowance.
    const answered = Date.parse(headers.get("date") ?? "");
    const sinceMs = (Number.isNaN(answered) ? this.#now() : answered) - 1000;
    const branch = ref.replace(/^refs\/heads\//, "");
    const run = await pollAction<WorkflowRun | undefined>({
      // The oldest dispatch run of the file on the branch since the dispatch.
      read: async () => {
        const runs = await this.listWorkflowRuns(owner, repo, {
          workflowFile,
          branch,
          event: "workflow_dispatch",
          createdSince: new Date(sinceMs).toISOString().replace(/\.\d{3}Z$/, "Z"),
          perPage: 10,
        });
        return runs
          .filter((r) => Date.parse(r.createdAt) >= sinceMs)
          .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id - b.id)[0];
      },
      finished: (run) => run !== undefined,
      timedOut: () =>
        new OpsCrewError(
          "PROVIDER_ERROR",
          `GitHub accepted the dispatch of ${workflowFile} on ${branch} but showed no run of it within ${durationText(DISPATCHED_RUN_TIMEOUT_MS)}; look in https://github.com/${owner}/${repo}/actions.`,
        ),
      timeoutMs: DISPATCHED_RUN_TIMEOUT_MS,
      intervalMs: DEFAULT_RUN_POLL_MS,
      sleep: this.#sleep,
      now: this.#now,
    });
    // `finished` is true only once a run was found.
    const { id, htmlUrl } = run as WorkflowRun;
    return { runId: id, url: htmlUrl };
  }

  /**
   * Waits for the dispatched run `runId` to complete. Throws a plain `PROVIDER_ERROR` naming the
   * run link on timeout. With `onWaiting`, a run that waits for a required reviewer of its
   * environment (status `waiting`) is reported once through it, and a run still waiting when the
   * time is up is returned with status `waiting` instead of timing out: a review may take any
   * time. When a run stops waiting, its time starts again.
   */
  async waitForWorkflowRun(
    owner: string,
    repo: string,
    options: {
      workflowFile: string;
      ref: string;
      runId: number;
      timeoutMs?: number;
      pollMs?: number;
      /** Called once, with the run's link, when the run waits for a required reviewer. */
      onWaiting?: (htmlUrl: string) => Promise<void> | void;
    },
  ): Promise<{
    id: number;
    status: "completed" | "waiting";
    conclusion: string | null;
    htmlUrl: string;
  }> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
    const pollMs = options.pollMs ?? DEFAULT_RUN_POLL_MS;
    const { onWaiting } = options;
    let deadline = this.#now() + timeoutMs;
    let reported = false;
    // Whether the run waited for a reviewer at the last read.
    let waited = false;
    for (;;) {
      const run = await this.getWorkflowRun(owner, repo, options.runId);
      if (run.status === "completed") {
        return {
          id: run.id,
          status: "completed",
          conclusion: run.conclusion,
          htmlUrl: run.htmlUrl,
        };
      }
      if (run.status === "waiting") {
        waited = true;
        if (onWaiting !== undefined && !reported) {
          reported = true;
          await onWaiting(run.htmlUrl);
        }
      } else if (waited) {
        // The review is done: the run gets its whole time from here.
        waited = false;
        deadline = this.#now() + timeoutMs;
      }
      const left = deadline - this.#now();
      if (left > 0) {
        await this.#sleep(Math.min(pollMs, left));
        continue;
      }
      // A run still waiting for its reviewer is returned, not a timeout.
      if (onWaiting !== undefined && run.status === "waiting") {
        return { id: run.id, status: "waiting", conclusion: null, htmlUrl: run.htmlUrl };
      }
      const branch = options.ref.replace(/^refs\/heads\//, "");
      throw new OpsCrewError(
        "PROVIDER_ERROR",
        `The ${options.workflowFile} run on ${branch} did not finish within ${durationText(timeoutMs)}.`,
        { hint: `Follow it at ${run.htmlUrl}, then run the command again once it has finished.` },
      );
    }
  }

  /** The authenticated user's login (used to verify the token). */
  async whoAmI(): Promise<string> {
    return (await this.#me(z.looseObject({ login: z.string() }))).login;
  }

  /** The GitHub account `login` (a user or an organization): its id and type (`User`, `Organization`). */
  async account(login: string): Promise<{ id: number; type: string }> {
    const what = `read the GitHub account ${login}`;
    const { json } = await this.#request("GET", `/users/${encodeURIComponent(login)}`, what);
    const { id, type } = this.#parse(AccountSchema, json, what);
    return { id, type };
  }

  /** The authenticated user, read with `schema`. */
  async #me<T>(schema: z.ZodType<T>): Promise<T> {
    const what = "read your GitHub account";
    const { json } = await this.#request("GET", "/user", what);
    return this.#parse(schema, json, what);
  }

  /**
   * The digest the GHCR tag `ghcr.io/<owner>/<image>:<tag>` points to (its image index), read
   * with `credential` (for example a classic `read:packages` token), else the client's token;
   * `undefined` when GHCR has no such tag.
   */
  async taggedDigest(
    owner: string,
    image: string,
    tag: string,
    credential?: RegistryCredential,
  ): Promise<string | undefined> {
    return this.#ghcr.taggedDigest(owner, image, tag, credential);
  }

  /**
   * The build an image names in its SLSA v1 provenance, read from GHCR with `credential`, else
   * the client's token: the image index `digest`, its attestation manifest and the in-toto
   * statement. `undefined` when GHCR has no such digest or the image carries no SLSA v1 provenance.
   */
  async imageProvenance(
    owner: string,
    image: string,
    digest: string,
    credential?: RegistryCredential,
  ): Promise<ImageProvenance | undefined> {
    return this.#ghcr.imageProvenance(owner, image, digest, credential);
  }

  /**
   * The platforms (CPU and operating system) of the image `digest` on GHCR, read with
   * `credential`, else the client's token: each of an index's images, or a single manifest's.
   * `undefined` when GHCR has no such digest.
   */
  async imagePlatforms(
    owner: string,
    image: string,
    digest: string,
    credential?: RegistryCredential,
  ): Promise<ImagePlatform[] | undefined> {
    return this.#ghcr.imagePlatforms(owner, image, digest, credential);
  }
}
