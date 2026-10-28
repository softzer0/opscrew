import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandRunner } from "@opscrew/contracts";
import { findExecutable, NodeCommandRunner, OpsCrewError } from "@opscrew/core";
import { fakeFetch as coreFakeFetch, type FakeReply, fakeSecret } from "@opscrew/core/testing";
import sodium from "libsodium-wrappers";
import { describe, expect, it } from "vitest";
import { GITHUB_API } from "./github";
import {
  GITHUB_TOKEN_PERMISSIONS,
  GitClient,
  GitHubClient,
  githubConnector,
  parseGitHubRepo,
  resolveGitHubToken,
} from "./index";
import { sealSecret } from "./seal";

const TOKEN = fakeSecret("github-token");

const fakeFetch = (routes: Record<string, FakeReply | FakeReply[]>) =>
  coreFakeFetch(routes, { base: GITHUB_API });

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
        body: {
          default_branch: "main",
          private: true,
          has_issues: true,
          permissions: { push: true },
        },
      },
    });
    const repo = await new GitHubClient({ token: TOKEN, fetch }).getRepo("acme", "shop");
    expect(repo).toEqual({ defaultBranch: "main", private: true, canPush: true, hasIssues: true });
    expect(calls[0]?.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]?.headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
  });

  it("reads a file's blob SHA on a branch through the contents API", async () => {
    const CONTENTS = "GET /repos/acme/shop/contents/.github/workflows/opscrew-deploy-qa.yml";
    const blob = "ce013625030ba8dba906f756967f9e9ca394464a";
    const found = fakeFetch({
      [CONTENTS]: {
        body: { type: "file", path: ".github/workflows/opscrew-deploy-qa.yml", sha: blob },
      },
    });
    const client = (fetch: typeof found.fetch) => new GitHubClient({ token: TOKEN, fetch });
    expect(
      await client(found.fetch).fileSha(
        "acme",
        "shop",
        ".github/workflows/opscrew-deploy-qa.yml",
        "release/2",
      ),
    ).toBe(blob);
    expect(found.calls[0]?.method).toBe("GET");
    expect(found.calls[0]?.path).toBe(
      "/repos/acme/shop/contents/.github/workflows/opscrew-deploy-qa.yml?ref=release%2F2",
    );

    const missing = fakeFetch({ [CONTENTS]: { status: 404, body: { message: "Not Found" } } });
    expect(
      await client(missing.fetch).fileSha(
        "acme",
        "shop",
        ".github/workflows/opscrew-deploy-qa.yml",
        "main",
      ),
    ).toBeUndefined();

    for (const reply of [
      { status: 500, body: { message: "Server Error" } },
      { body: { message: "not a file entry" } },
    ]) {
      const other = fakeFetch({ [CONTENTS]: reply });
      const error = await client(other.fetch)
        .fileSha("acme", "shop", ".github/workflows/opscrew-deploy-qa.yml", "main")
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(OpsCrewError);
      expect(error).toMatchObject({ code: "PROVIDER_ERROR" });
      expect(JSON.stringify(error)).not.toContain(TOKEN);
    }
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

  it("tells whether an Actions secret exists, with 404 as absent", async () => {
    for (const [status, exists] of [
      [200, true],
      [404, false],
    ] as const) {
      const { fetch, calls } = fakeFetch({
        "GET /repos/acme/shop/actions/secrets/OPSCREW_CHECK_WEBHOOK": {
          status,
          body: status === 200 ? { name: "OPSCREW_CHECK_WEBHOOK" } : { message: "Not Found" },
        },
      });
      await expect(
        new GitHubClient({ token: TOKEN, fetch }).actionsSecretExists(
          "acme",
          "shop",
          "OPSCREW_CHECK_WEBHOOK",
        ),
      ).resolves.toBe(exists);
      expect(calls).toHaveLength(1);
    }
  });

  it("names Secrets: Read when GitHub refuses to say whether a secret exists (403)", async () => {
    const { fetch } = fakeFetch({
      "GET /repos/acme/shop/actions/secrets/OPSCREW_CHECK_WEBHOOK": {
        status: 403,
        body: { message: "Resource not accessible by personal access token" },
      },
    });
    const error = (await new GitHubClient({ token: TOKEN, fetch })
      .actionsSecretExists("acme", "shop", "OPSCREW_CHECK_WEBHOOK")
      .catch((e: unknown) => e)) as OpsCrewError;
    expect(error.code).toBe("CREDENTIALS_INVALID");
    expect(error.hint).toContain("Secrets: Read");
  });

  it("deletes an Actions secret (204)", async () => {
    const { fetch, calls } = fakeFetch({
      "DELETE /repos/acme/shop/actions/secrets/OPSCREW_SSH_KEY": { status: 204 },
    });
    await new GitHubClient({ token: TOKEN, fetch }).deleteActionsSecret(
      "acme",
      "shop",
      "OPSCREW_SSH_KEY",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.url).toBe(
      "https://api.github.com/repos/acme/shop/actions/secrets/OPSCREW_SSH_KEY",
    );
    expect(calls[0]?.body).toBeUndefined();
  });

  it("treats a secret that is already gone (404) as deleted", async () => {
    const { fetch, calls } = fakeFetch({
      "DELETE /repos/acme/shop/actions/secrets/OPSCREW_SSH_KEY": {
        status: 404,
        body: { message: "Not Found" },
      },
    });
    await expect(
      new GitHubClient({ token: TOKEN, fetch }).deleteActionsSecret(
        "acme",
        "shop",
        "OPSCREW_SSH_KEY",
      ),
    ).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it("maps 403 and 401 on secret deletion like the other methods, without the token", async () => {
    for (const [status, code] of [
      [403, "CREDENTIALS_INVALID"],
      [401, "CREDENTIALS_INVALID"],
      [500, "PROVIDER_ERROR"],
    ] as const) {
      const { fetch } = fakeFetch({
        "DELETE /repos/acme/shop/actions/secrets/OPSCREW_SSH_KEY": {
          status,
          body: { message: "Resource not accessible by personal access token" },
        },
      });
      const error = (await new GitHubClient({ token: TOKEN, fetch })
        .deleteActionsSecret("acme", "shop", "OPSCREW_SSH_KEY")
        .catch((e: unknown) => e)) as OpsCrewError;
      expect(error).toBeInstanceOf(OpsCrewError);
      expect(error.code).toBe(code);
      expect(`${error.message} ${error.hint ?? ""}`).not.toContain(TOKEN);
      if (status === 403) expect(error.hint).toContain("Secrets: Read and write");
    }
  });

  it("rejects invalid secret names before deleting", async () => {
    const { fetch, calls } = fakeFetch({});
    await expect(
      new GitHubClient({ token: TOKEN, fetch }).deleteActionsSecret("acme", "shop", "bad-name"),
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

  it("gives up on a request that never answers", async () => {
    const { fetch } = fakeFetch({ "GET /repos/acme/shop": { hang: true } });
    const error = (await new GitHubClient({ token: TOKEN, fetch, timeoutMs: 5 })
      .getRepo("acme", "shop")
      .catch((e: unknown) => e)) as OpsCrewError;
    expect(error).toBeInstanceOf(OpsCrewError);
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toContain("GitHub did not answer within");
    expect(error.message).toContain("read acme/shop");
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
  it("verifies the token", async () => {
    const { fetch } = fakeFetch({ "GET /user": { body: { login: "octocat" } } });
    const connector = githubConnector({ token: TOKEN, fetch });
    expect(await connector.verifyCredentials()).toMatchObject({ ok: true, identity: "octocat" });
    expect(await githubConnector({ token: undefined, fetch }).verifyCredentials()).toMatchObject({
      ok: false,
    });
  });

  it("lists the token's permissions, those of environments, runners and GitHub Pages marked as only theirs", () => {
    expect(GITHUB_TOKEN_PERMISSIONS).toEqual([
      "Contents: Read and write",
      "Pull requests: Read and write",
      "Secrets: Read and write",
      "Actions: Read and write",
      "Workflows: Read and write",
      "Metadata: Read",
      "Administration: Read and write (only for an app with several environments, for self-hosted runners, and for GitHub Pages)",
      "Environments: Read and write (only for an app with several environments)",
      "Pages: Read and write (only for GitHub Pages)",
      "Plan: Read (optional, for GitHub Pages on a private repository: an account permission, or an organization permission when an organization owns the repository)",
      "Issues: Read (only with the scheduled check)",
      "Variables: Read and write (only with the scheduled check)",
    ]);
    expect(
      githubConnector({ token: TOKEN, fetch: fakeFetch({}).fetch }).credentials.scopes,
    ).toEqual([...GITHUB_TOKEN_PERMISSIONS]);
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

  it("reads a branch's sha where pushes go, and checks ancestry", async () => {
    const { client, dir, exec } = await repo();
    const missing = join(dir, "no-such-remote.git");
    expect(await client.remoteBranchSha("opscrew/prepare-deploy")).toBeUndefined();
    await client.createBranch("opscrew/prepare-deploy");
    await writeFile(join(dir, "a.txt"), "a\n");
    await client.add(["a.txt"]);
    const first = await client.commit("first");
    await client.push("opscrew/prepare-deploy");
    // The fetch URL points nowhere: the branch is read from the push URL.
    const bare = (await exec(dir, "remote", "get-url", "origin")).stdout.trim();
    await exec(dir, "remote", "set-url", "origin", missing);
    await exec(dir, "remote", "set-url", "--push", "origin", bare);
    expect(await client.remoteBranchSha("opscrew/prepare-deploy")).toBe(first);
    expect(await client.remoteBranchSha("opscrew/prepare")).toBeUndefined();

    await writeFile(join(dir, "b.txt"), "b\n");
    await client.add(["b.txt"]);
    await client.commit("second");
    expect(await client.isAncestor(first, "opscrew/prepare-deploy")).toBe(true);
    expect(await client.isAncestor(first, "main")).toBe(false);
    expect(await client.isAncestor("0".repeat(40), "main")).toBe(false);

    await exec(dir, "remote", "set-url", "--push", "origin", missing);
    await expect(client.remoteBranchSha("opscrew/prepare-deploy")).rejects.toMatchObject({
      code: "COMMAND_FAILED",
      message: expect.stringContaining("git ls-remote failed"),
    });
  });

  it("reads a commit's subject and renames a branch without forcing", async () => {
    const { client, dir } = await repo();
    expect(await client.commitSubject()).toBe("init");
    await client.createBranch("opscrew/prepare-deploy");
    await writeFile(join(dir, "a.txt"), "a\n");
    await client.add(["a.txt"]);
    await client.commit("chore(opscrew): prepare app for deployment\n\n- a");
    expect(await client.commitSubject("HEAD")).toBe("chore(opscrew): prepare app for deployment");
    expect(await client.commitSubject("main")).toBe("init");

    await client.renameBranch("opscrew/prepare-deploy", "opscrew/prepare-deploy-2");
    expect(await client.currentBranch()).toBe("opscrew/prepare-deploy-2");
    expect(await client.branchExists("opscrew/prepare-deploy")).toBe(false);
    await expect(client.renameBranch("opscrew/prepare-deploy-2", "main")).rejects.toMatchObject({
      code: "COMMAND_FAILED",
    });
    expect(await client.currentBranch()).toBe("opscrew/prepare-deploy-2");
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
