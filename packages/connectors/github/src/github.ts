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
const RunsSchema = z.looseObject({
  workflow_runs: z.array(
    z.looseObject({
      id: z.number(),
      status: z.string(),
      conclusion: z.string().nullable(),
      html_url: z.string(),
      head_sha: z.string(),
      created_at: z.string(),
    }),
  ),
});

const SECRET_NAME = /^[A-Z_][A-Z0-9_]*$/;

/** Minimal GitHub REST client for what OpsCrew needs. The token never appears in errors. */
export class GitHubClient {
  readonly #token: string;
  readonly #fetch: FetchLike;
  readonly #baseUrl: string;
  readonly #userAgent: string;

  constructor(options: GitHubClientOptions) {
    this.#token = options.token;
    this.#fetch = options.fetch;
    this.#baseUrl = (options.baseUrl ?? GITHUB_API).replace(/\/$/, "");
    this.#userAgent = `opscrew/${options.version ?? "0.1.0"}`;
  }

  async #request(
    method: string,
    path: string,
    what: string,
    body?: unknown,
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
    if (response.status >= 400) {
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
    if (!SECRET_NAME.test(name)) {
      throw new OpsCrewError("INVALID_INPUT", `"${name}" is not a valid GitHub secret name.`);
    }
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

  async listWorkflowRuns(
    owner: string,
    repo: string,
    options: { workflowFile: string; branch?: string; perPage?: number },
  ): Promise<WorkflowRun[]> {
    const what = "list workflow runs";
    const query = new URLSearchParams({ per_page: String(options.perPage ?? 5) });
    if (options.branch) query.set("branch", options.branch);
    const file = options.workflowFile.split("/").pop() ?? options.workflowFile;
    const { json } = await this.#request(
      "GET",
      `/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(file)}/runs?${query}`,
      what,
    );
    return this.#parse(RunsSchema, json, what).workflow_runs.map((run) => ({
      id: run.id,
      status: run.status,
      conclusion: run.conclusion,
      htmlUrl: run.html_url,
      headSha: run.head_sha,
      createdAt: run.created_at,
    }));
  }

  /** The authenticated user's login (used to verify the token). */
  async whoAmI(): Promise<string> {
    const what = "read your GitHub account";
    const { json } = await this.#request("GET", "/user", what);
    return this.#parse(z.looseObject({ login: z.string() }), json, what).login;
  }
}
