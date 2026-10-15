import type { FetchLike } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { z } from "zod";
import { sealSecret } from "./seal";

export const GITHUB_API = "https://api.github.com";

export const GITHUB_TOKEN_PERMISSIONS = [
  "Contents: Read and write",
  "Pull requests: Read and write",
  "Secrets: Read and write",
  "Actions: Read and write",
  "Workflows: Read and write",
  "Metadata: Read",
] as const;

export interface GitHubClientOptions {
  token: string;
  fetch: FetchLike;
  baseUrl?: string;
  version?: string;
  /** Waits between polls (default: `setTimeout`); injected by tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Monotonic milliseconds for wait loops (default: `Date.now`); injected by tests. */
  now?: () => number;
}

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
const ShaSchema = z.looseObject({ sha: z.string().regex(/^[0-9a-f]{40,64}$/) });

/** An owner or repository name as GitHub allows it (no `/`, never `.` or `..`). */
const REPO_PART = /^(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/;
/** A branch name git accepts that cannot be read as an option or a path trick. */
const BRANCH_NAME = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*\.lock$)[A-Za-z0-9._/-]{1,200}(?<!\/)$/;
/** One file at the root of the tree. */
const ROOT_FILE = /^(?!\.\.?$)[A-Za-z0-9._-]{1,200}$/;

/** Input of {@link GitHubClient.createOrphanBranch}. */
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
const DispatchSchema = z.looseObject({ workflow_run_id: z.number().optional() }).optional();

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

/** `since` rounded down to whole seconds: GitHub's `created_at` has no milliseconds. */
function floorToSecond(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    throw new OpsCrewError("INVALID_INPUT", `"${iso}" is not a valid ISO time.`, {
      hint: "Pass the time just before the dispatch, for example new Date().toISOString().",
    });
  }
  return Math.floor(ms / 1000) * 1000;
}

const DEFAULT_RUN_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_RUN_POLL_MS = 5_000;
/** How far this computer's clock may run ahead of GitHub's when finding a dispatched run. */
const CLOCK_SKEW_ALLOWANCE_MS = 2 * 60_000;

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

  constructor(options: GitHubClientOptions) {
    this.#token = options.token;
    this.#fetch = options.fetch;
    this.#baseUrl = (options.baseUrl ?? GITHUB_API).replace(/\/$/, "");
    this.#userAgent = `opscrew/${options.version ?? "0.1.0"}`;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#now = options.now ?? Date.now;
  }

  async #request(
    method: string,
    path: string,
    what: string,
    body?: unknown,
    okStatuses: readonly number[] = [],
  ): Promise<{ status: number; json: unknown }> {
    let response: Response;
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
      });
    } catch (error) {
      throw new OpsCrewError("PROVIDER_ERROR", `Could not reach GitHub to ${what}.`, {
        hint: "Check your internet connection and try again.",
        cause: error,
      });
    }
    const text = await response.text();
    let json: unknown;
    try {
      json = text.length > 0 ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    if (response.status >= 400 && !okStatuses.includes(response.status)) {
      const message =
        typeof json === "object" && json !== null && "message" in json
          ? String((json as { message: unknown }).message)
          : `HTTP ${response.status}`;
      if (response.status === 401) {
        throw new OpsCrewError(
          "CREDENTIALS_INVALID",
          `GitHub rejected the token while trying to ${what}.`,
          {
            hint: "Create a fine-grained token at https://github.com/settings/personal-access-tokens/new and set GITHUB_TOKEN, or run `gh auth login`.",
          },
        );
      }
      if (response.status === 403 || response.status === 404) {
        throw new OpsCrewError("CREDENTIALS_INVALID", `GitHub refused to ${what} (${message}).`, {
          hint: `The token needs access to this repository with: ${GITHUB_TOKEN_PERMISSIONS.join(", ")}.`,
        });
      }
      throw new OpsCrewError("PROVIDER_ERROR", `GitHub could not ${what}: ${message}.`);
    }
    return { status: response.status, json };
  }

  #parse<T>(schema: z.ZodType<T>, json: unknown, what: string): T {
    const parsed = schema.safeParse(json);
    if (!parsed.success)
      throw new OpsCrewError(
        "PROVIDER_ERROR",
        `GitHub returned an unexpected answer when trying to ${what}.`,
      );
    return parsed.data;
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
   * Creates `branch` holding only one file and no history (an orphan branch) through GitHub's Git
   * Data API: a blob, a tree with only that file, a commit without parents, then the branch's ref.
   * Refuses with `PHASE_PRECONDITION` when the branch exists (checked first, and again by GitHub
   * when the ref is created), so it never moves or overwrites a branch. Needs Contents: Read and
   * write on the repository.
   */
  async createOrphanBranch(input: OrphanBranchInput): Promise<{ commit: string }> {
    const { owner, repo, branch, path } = input;
    if (
      !REPO_PART.test(owner) ||
      !REPO_PART.test(repo) ||
      !BRANCH_NAME.test(branch) ||
      !ROOT_FILE.test(path) ||
      typeof input.content !== "string" ||
      typeof input.message !== "string" ||
      input.message.trim() === ""
    ) {
      throw new OpsCrewError(
        "INVALID_INPUT",
        "A new branch needs a repository, a branch name, one file name at the root and a commit message.",
      );
    }
    const base = `/repos/${owner}/${repo}/git`;
    const exists = () =>
      new OpsCrewError(
        "PHASE_PRECONDITION",
        `The branch ${branch} already exists in ${owner}/${repo}, so OpsCrew did not create it again.`,
        { hint: `OpsCrew creates ${branch} only when it is missing; it never overwrites it.` },
      );
    const ref = await this.#request(
      "GET",
      `${base}/ref/heads/${branch.split("/").map(encodeURIComponent).join("/")}`,
      `check whether the branch ${branch} exists`,
      undefined,
      [404],
    );
    if (ref.status !== 404) throw exists();

    const what = `create the branch ${branch}`;
    const blob = await this.#request("POST", `${base}/blobs`, what, {
      content: input.content,
      encoding: "utf-8",
    });
    const blobSha = this.#parse(ShaSchema, blob.json, what).sha;
    const tree = await this.#request("POST", `${base}/trees`, what, {
      tree: [{ path, mode: "100644", type: "blob", sha: blobSha }],
    });
    const treeSha = this.#parse(ShaSchema, tree.json, what).sha;
    const commit = await this.#request("POST", `${base}/commits`, what, {
      message: input.message,
      tree: treeSha,
      parents: [],
    });
    const commitSha = this.#parse(ShaSchema, commit.json, what).sha;
    const created = await this.#request(
      "POST",
      `${base}/refs`,
      what,
      { ref: `refs/heads/${branch}`, sha: commitSha },
      [422],
    );
    if (created.status === 422) throw exists();
    return { commit: commitSha };
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
        title: input.title,
        head: input.head,
        base: input.base,
        body: input.body,
      },
    );
    const pull = this.#parse(PullSchema, json, what);
    return { number: pull.number, url: pull.html_url };
  }

  async getActionsPublicKey(owner: string, repo: string): Promise<{ keyId: string; key: string }> {
    const what = "read the repository's Actions secrets key";
    const { json } = await this.#request(
      "GET",
      `/repos/${owner}/${repo}/actions/secrets/public-key`,
      what,
    );
    const key = this.#parse(PublicKeySchema, json, what);
    return { keyId: key.key_id, key: key.key };
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
    const encrypted = await sealSecret(key.key, value);
    await this.#request(
      "PUT",
      `/repos/${owner}/${repo}/actions/secrets/${name}`,
      `store the secret ${name}`,
      {
        encrypted_value: encrypted,
        key_id: key.keyId,
      },
    );
  }

  /** Deletes an Actions secret. A secret that does not exist (404) counts as deleted. */
  async deleteActionsSecret(owner: string, repo: string, name: string): Promise<void> {
    assertSecretName(name);
    await this.#request(
      "DELETE",
      `/repos/${owner}/${repo}/actions/secrets/${name}`,
      `delete the secret ${name}`,
      undefined,
      [404],
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

  /**
   * Starts a `workflow_dispatch` run of `workflowFile` on `ref`. Returns the run id when GitHub
   * sends it (200 with `workflow_run_id`); an empty object for the older 204 answer.
   */
  async dispatchWorkflow(
    owner: string,
    repo: string,
    workflowFile: string,
    ref: string,
  ): Promise<{ runId?: number }> {
    const what = `start the workflow ${workflowFile} on ${ref}`;
    const { status, json } = await this.#request(
      "POST",
      `/repos/${owner}/${repo}/actions/workflows/${workflowId(workflowFile)}/dispatches`,
      what,
      { ref },
    );
    if (status === 204) return {};
    const runId = this.#parse(DispatchSchema, json, what)?.workflow_run_id;
    return runId === undefined ? {} : { runId };
  }

  /**
   * Waits for a dispatched run to complete: the run `runId` when given, else the newest
   * `workflow_dispatch` run on `ref` created at or after `since` minus two minutes (allowance for
   * a local clock ahead of GitHub's; it may take a few polls to appear). Throws a plain
   * `PROVIDER_ERROR` naming the run link on timeout.
   */
  async waitForWorkflowRun(
    owner: string,
    repo: string,
    options: {
      workflowFile: string;
      ref: string;
      runId?: number;
      /** ISO time just before the dispatch. */
      since: string;
      timeoutMs?: number;
      pollMs?: number;
    },
  ): Promise<{ id: number; conclusion: string | null; htmlUrl: string }> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
    const pollMs = options.pollMs ?? DEFAULT_RUN_POLL_MS;
    // `since` is this computer's time; GitHub stamps runs with its own clock, so a local clock
    // ahead of GitHub's would hide the dispatched run. Look a little earlier and take the newest.
    const sinceMs = floorToSecond(options.since) - CLOCK_SKEW_ALLOWANCE_MS;
    const createdSince = new Date(sinceMs).toISOString().replace(/\.\d{3}Z$/, "Z");
    const branch = options.ref.replace(/^refs\/heads\//, "");
    const deadline = this.#now() + timeoutMs;
    let runId = options.runId;
    let htmlUrl: string | undefined;
    for (;;) {
      let run: WorkflowRun | undefined;
      if (runId !== undefined) {
        run = await this.getWorkflowRun(owner, repo, runId);
      } else {
        const runs = await this.listWorkflowRuns(owner, repo, {
          workflowFile: options.workflowFile,
          branch,
          event: "workflow_dispatch",
          createdSince,
          perPage: 10,
        });
        run = runs
          .filter((r) => Date.parse(r.createdAt) >= sinceMs)
          .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id - a.id)[0];
        if (run) runId = run.id;
      }
      if (run) {
        htmlUrl = run.htmlUrl;
        if (run.status === "completed") {
          return { id: run.id, conclusion: run.conclusion, htmlUrl: run.htmlUrl };
        }
      }
      if (this.#now() >= deadline) break;
      await this.#sleep(Math.max(0, Math.min(pollMs, deadline - this.#now())));
    }
    const minutes = Math.max(1, Math.round(timeoutMs / 60_000));
    if (htmlUrl !== undefined) {
      throw new OpsCrewError(
        "PROVIDER_ERROR",
        `The ${options.workflowFile} run on ${branch} did not finish within ${minutes} minute${minutes === 1 ? "" : "s"}.`,
        { hint: `Follow it at ${htmlUrl}, then run the command again once it has finished.` },
      );
    }
    throw new OpsCrewError(
      "PROVIDER_ERROR",
      `GitHub did not show a run of ${options.workflowFile} on ${branch} within ${minutes} minute${minutes === 1 ? "" : "s"}.`,
      {
        hint: `Check the Actions tab of https://github.com/${owner}/${repo} for the run, then run the command again.`,
      },
    );
  }

  /** The authenticated user's login (used to verify the token). */
  async whoAmI(): Promise<string> {
    const what = "read your GitHub account";
    const { json } = await this.#request("GET", "/user", what);
    return this.#parse(z.looseObject({ login: z.string() }), json, what).login;
  }
}
