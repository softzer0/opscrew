import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandRunner, FetchLike } from "@opscrew/contracts";
import { findExecutable, NodeCommandRunner } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import sodium from "libsodium-wrappers";
import { describe, expect, it } from "vitest";
import {
  GitClient,
  GitHubClient,
  githubConnector,
  parseGitHubRepo,
  resolveGitHubToken,
  sealSecret,
} from "./index";

const TOKEN = fakeSecret("github-token");

type Recorded = { method: string; url: string; headers: Record<string, string>; body?: unknown };

function fakeFetch(routes: Record<string, { status?: number; body?: unknown }>) {
  const calls: Recorded[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({
      method,
      url,
      headers: (init?.headers ?? {}) as Record<string, string>,
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
    });
    const path = url.replace("https://api.github.com", "");
    const key = Object.keys(routes).find((k) => `${method} ${path}`.startsWith(k));
    if (!key) throw new Error(`unrouted ${method} ${path}`);
    const route = routes[key] as { status?: number; body?: unknown };
    return new Response(route.body === undefined ? "" : JSON.stringify(route.body), {
      status: route.status ?? 200,
    });
  };
  return { fetch, calls };
}

describe("parseGitHubRepo", () => {
  it("handles https, ssh and scp-like remotes", () => {
    expect(parseGitHubRepo("https://github.com/Acme/Shop.git")).toEqual({
      owner: "Acme",
      repo: "Shop",
    });
    expect(parseGitHubRepo("git@github.com:acme/shop.git")).toEqual({
      owner: "acme",
      repo: "shop",
    });
    expect(parseGitHubRepo("ssh://git@github.com/acme/shop")).toEqual({
      owner: "acme",
      repo: "shop",
    });
    expect(parseGitHubRepo("https://gitlab.com/acme/shop.git")).toBeUndefined();
  });
});

describe("GitHubClient", () => {
  it("reads repository info with the right headers", async () => {
    const { fetch, calls } = fakeFetch({
      "GET /repos/acme/shop": {
        body: { default_branch: "main", private: true, permissions: { push: true } },
      },
    });
    const repo = await new GitHubClient({ token: TOKEN, fetch }).getRepo("acme", "shop");
    expect(repo).toEqual({ defaultBranch: "main", private: true, canPush: true });
    expect(calls[0]?.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]?.headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
  });

  it("finds and opens pull requests", async () => {
    const { fetch, calls } = fakeFetch({
      "GET /repos/acme/shop/pulls?": { body: [] },
      "POST /repos/acme/shop/pulls": {
        status: 201,
        body: { number: 7, html_url: "https://github.com/acme/shop/pull/7" },
      },
    });
    const client = new GitHubClient({ token: TOKEN, fetch });
    expect(
      await client.findOpenPullRequest("acme", "shop", "opscrew/deploy-setup"),
    ).toBeUndefined();
    expect(calls[0]?.url).toContain("head=acme%3Aopscrew%2Fdeploy-setup");
    const pr = await client.createPullRequest({
      owner: "acme",
      repo: "shop",
      head: "opscrew/deploy-setup",
      base: "main",
      title: "t",
      body: "b",
    });
    expect(pr).toEqual({ number: 7, url: "https://github.com/acme/shop/pull/7" });
    expect(calls[1]?.body).toEqual({
      title: "t",
      head: "opscrew/deploy-setup",
      base: "main",
      body: "b",
    });
  });

  it("seals secrets with the repository key so only GitHub can read them", async () => {
    await sodium.ready;
    const pair = sodium.crypto_box_keypair();
    const publicKey = sodium.to_base64(pair.publicKey, sodium.base64_variants.ORIGINAL);
    const value = fakeSecret("generic-password");
    const { fetch, calls } = fakeFetch({
      "GET /repos/acme/shop/actions/secrets/public-key": { body: { key_id: "k1", key: publicKey } },
      "PUT /repos/acme/shop/actions/secrets/OPSCREW_APP_ENV": { status: 201 },
    });
    await new GitHubClient({ token: TOKEN, fetch }).setActionsSecret(
      "acme",
      "shop",
      "OPSCREW_APP_ENV",
      value,
    );
    const put = calls.find((c) => c.method === "PUT");
    const body = put?.body as { encrypted_value: string; key_id: string };
    expect(body.key_id).toBe("k1");
    expect(JSON.stringify(calls)).not.toContain(value);
    const opened = sodium.crypto_box_seal_open(
      sodium.from_base64(body.encrypted_value, sodium.base64_variants.ORIGINAL),
      pair.publicKey,
      pair.privateKey,
    );
    expect(sodium.to_string(opened)).toBe(value);
  });

  it("rejects invalid secret names before calling GitHub", async () => {
    const { fetch, calls } = fakeFetch({});
    await expect(
      new GitHubClient({ token: TOKEN, fetch }).setActionsSecret("acme", "shop", "bad-name", "x"),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(calls).toHaveLength(0);
  });

  it("lists workflow runs for a branch", async () => {
    const { fetch, calls } = fakeFetch({
      "GET /repos/acme/shop/actions/workflows/opscrew-deploy.yml/runs": {
        body: {
          workflow_runs: [
            {
              id: 1,
              status: "completed",
              conclusion: "success",
              html_url: "u",
              head_sha: "abc",
              created_at: "2026-10-11T12:00:00Z",
            },
          ],
        },
      },
    });
    const runs = await new GitHubClient({ token: TOKEN, fetch }).listWorkflowRuns("acme", "shop", {
      workflowFile: ".github/workflows/opscrew-deploy.yml",
      branch: "main",
    });
    expect(runs[0]).toMatchObject({ id: 1, conclusion: "success", headSha: "abc" });
    expect(calls[0]?.url).toContain("branch=main");
  });

  it("maps errors without leaking the token", async () => {
    const { fetch } = fakeFetch({
      "GET /repos/acme/a": { status: 401, body: { message: "Bad credentials" } },
      "GET /repos/acme/b": {
        status: 403,
        body: { message: "Resource not accessible by integration" },
      },
      "GET /repos/acme/c": { status: 500, body: { message: "boom" } },
    });
    const client = new GitHubClient({ token: TOKEN, fetch });
    await expect(client.getRepo("acme", "a")).rejects.toMatchObject({
      code: "CREDENTIALS_INVALID",
    });
    await expect(client.getRepo("acme", "b")).rejects.toMatchObject({
      code: "CREDENTIALS_INVALID",
      hint: expect.stringContaining("Secrets: Read and write"),
    });
    const error = await client.getRepo("acme", "c").catch((e: Error) => e);
    expect(error).toMatchObject({ code: "PROVIDER_ERROR" });
    expect(JSON.stringify(error)).not.toContain(TOKEN);
  });

  it("produces sealed boxes in base64", async () => {
    await sodium.ready;
    const pair = sodium.crypto_box_keypair();
    const sealed = await sealSecret(
      sodium.to_base64(pair.publicKey, sodium.base64_variants.ORIGINAL),
      "hello",
    );
    expect(sealed).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });
});

describe("resolveGitHubToken", () => {
  const runner = (stdout: string, exitCode = 0): CommandRunner => ({
    run: async () => ({ exitCode, stdout, stderr: "" }),
  });

  it("prefers GITHUB_TOKEN, then GH_TOKEN", async () => {
    expect(await resolveGitHubToken({ GITHUB_TOKEN: "a", GH_TOKEN: "b" }, runner(""))).toBe("a");
    expect(await resolveGitHubToken({ GH_TOKEN: "b" }, runner(""))).toBe("b");
  });

  it.skipIf(!findExecutable("gh"))("falls back to the GitHub CLI", async () => {
    expect(await resolveGitHubToken({ PATH: process.env.PATH }, runner(`${TOKEN}\n`))).toBe(TOKEN);
    expect(await resolveGitHubToken({ PATH: process.env.PATH }, runner("", 1))).toBeUndefined();
  });
});

describe("githubConnector", () => {
  it("verifies the token and redacts tool output", async () => {
    const { fetch } = fakeFetch({ "GET /user": { body: { login: "octocat" } } });
    const connector = githubConnector({ token: TOKEN, fetch });
    expect(await connector.verifyCredentials()).toMatchObject({ ok: true, identity: "octocat" });
    expect(connector.tools().map((t) => t.name)).toEqual(["github_repo_info"]);
    expect(await githubConnector({ token: undefined, fetch }).verifyCredentials()).toMatchObject({
      ok: false,
    });
  });
});

const git = findExecutable("git");

describe.skipIf(!git)("GitClient (real temporary repositories)", () => {
  async function repo() {
    const runner = new NodeCommandRunner();
    const dir = await mkdtemp(join(tmpdir(), "opscrew-git-"));
    const bare = await mkdtemp(join(tmpdir(), "opscrew-bare-"));
    const exec = (cwd: string, ...args: string[]) =>
      runner.run(git as string, ["-C", cwd, ...args]);
    await exec(bare, "init", "--bare", "-b", "main");
    await exec(dir, "init", "-b", "main");
    await exec(dir, "config", "user.name", "OpsCrew Test");
    await exec(dir, "config", "user.email", "test@example.invalid");
    await exec(dir, "config", "commit.gpgsign", "false");
    await exec(dir, "remote", "add", "origin", bare);
    await writeFile(join(dir, "README.md"), "hello\n");
    await exec(dir, "add", "README.md");
    await exec(dir, "commit", "-m", "init");
    return { client: new GitClient({ cwd: dir, runner }), dir, bare, exec };
  }

  it("reports status, branches, commits and pushes", async () => {
    const { client, dir, bare, exec } = await repo();
    expect(await client.isRepo()).toBe(true);
    expect(await client.currentBranch()).toBe("main");
    expect(await client.isClean()).toBe(true);
    await writeFile(join(dir, "Dockerfile"), "FROM scratch\n");
    await writeFile(join(dir, "opscrew-notes.txt"), "x\n");
    expect((await client.status()).map((e) => e.path).sort()).toEqual([
      "Dockerfile",
      "opscrew-notes.txt",
    ]);
    expect(await client.isClean({ ignore: ["Dockerfile", "opscrew-notes.txt"] })).toBe(true);
    expect(await client.branchExists("opscrew/prepare-deploy")).toBe(false);
    await client.createBranch("opscrew/prepare-deploy");
    expect(await client.branchExists("opscrew/prepare-deploy")).toBe(true);
    await client.add(["Dockerfile"]);
    expect(await client.diffStat()).toContain("Dockerfile");
    const sha = await client.commit("chore(opscrew): add Dockerfile");
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    await client.push("opscrew/prepare-deploy", { setUpstream: true });
    const remote = await exec(bare, "rev-parse", "refs/heads/opscrew/prepare-deploy");
    expect(remote.stdout.trim()).toBe(sha);
    expect(await client.remoteUrl()).toBe(bare);
    expect(await client.defaultBranch()).toBe("main");
  });

  it("explains a missing git identity", async () => {
    const { client, dir, exec } = await repo();
    await exec(dir, "config", "--unset", "user.name");
    await exec(dir, "config", "--unset", "user.email");
    await writeFile(join(dir, "a.txt"), "a\n");
    await client.add(["a.txt"]);
    // Identity may still come from global config on a developer machine; only assert the mapping when git refuses.
    const result = await client.commit("x").catch((e: Error) => e);
    if (result instanceof Error) expect(result).toMatchObject({ code: "COMMAND_FAILED" });
  });

  it("is false outside a repository", async () => {
    const dir = await mkdtemp(join(tmpdir(), "opscrew-nogit-"));
    expect(await new GitClient({ cwd: dir, runner: new NodeCommandRunner() }).isRepo()).toBe(false);
  });
});
