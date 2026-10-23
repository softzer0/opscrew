/**
 * GitHub's runner API as the runner tests answer it: the repository's visibility and fork-PR
 * policy, runner tokens made at test time, and the registrations. Nothing reaches GitHub.
 */
import type { ForkPrApprovalPolicy, RunnerInfo } from "@opscrew/connector-github";
import { fakeSecret } from "@opscrew/core/testing";
import type { RunnerGitHubApi } from "../runners/github";

/** A fake of {@link RunnerGitHubApi} that records every call. */
export class FakeRunnerGitHub implements RunnerGitHubApi {
  visibility: "public" | "private" | "internal" = "private";
  policy: ForkPrApprovalPolicy = "first_time_contributors";
  runners: RunnerInfo[] = [];
  /** Every call, as `<method> <owner>/<repo>[ <argument>]`. */
  readonly calls: string[] = [];
  /** Every token handed out, in order. */
  readonly tokens: string[] = [];

  private token(kind: string): string {
    const token = fakeSecret("hcloud-token", `runner-${kind}-${this.tokens.length}`);
    this.tokens.push(token);
    return token;
  }

  async runnerRegistrationToken(owner: string, repo: string): Promise<string> {
    this.calls.push(`registration-token ${owner}/${repo}`);
    return this.token("registration");
  }
  async runnerRemoveToken(owner: string, repo: string): Promise<string> {
    this.calls.push(`remove-token ${owner}/${repo}`);
    return this.token("remove");
  }
  async listRunners(owner: string, repo: string): Promise<RunnerInfo[]> {
    this.calls.push(`list ${owner}/${repo}`);
    return this.runners;
  }
  async deleteRunner(owner: string, repo: string, id: number): Promise<void> {
    this.calls.push(`delete ${owner}/${repo} ${id}`);
    this.runners = this.runners.filter((runner) => runner.id !== id);
  }
  async repositoryVisibility(owner: string, repo: string) {
    this.calls.push(`visibility ${owner}/${repo}`);
    return this.visibility;
  }
  async forkPrApprovalPolicy(owner: string, repo: string): Promise<ForkPrApprovalPolicy> {
    this.calls.push(`fork-pr-policy ${owner}/${repo}`);
    return this.policy;
  }
  async setForkPrApprovalPolicy(
    owner: string,
    repo: string,
    policy: ForkPrApprovalPolicy,
  ): Promise<void> {
    this.calls.push(`set-fork-pr-policy ${owner}/${repo} ${policy}`);
    this.policy = policy;
  }
}

/** A runner GitHub lists with the label `label`. */
export function listedRunner(
  id: number,
  name: string,
  label: string,
  o: { status?: "online" | "offline"; version?: string } = {},
): RunnerInfo {
  return {
    id,
    name,
    status: o.status ?? "online",
    labels: ["self-hosted", "Linux", "X64", label],
    ...(o.version !== undefined ? { version: o.version } : { version: "2.338.0" }),
  };
}
