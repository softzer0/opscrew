import { OpsCrewError, Redactor } from "@opscrew/core";
import { fakeFetch as coreFakeFetch, type FakeReply, fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { GITHUB_API } from "./github";
import { GitHubClient, githubConnector } from "./index";

const TOKEN = fakeSecret("github-token");
const RUNNERS = "/repos/acme/shop/actions/runners";
const FORK_PR = "/repos/acme/shop/actions/permissions/fork-pr-contributor-approval";
const NOT_FOUND: FakeReply = { status: 404, body: { message: "Not Found" } };
const NO_ADMIN: FakeReply = {
  status: 403,
  body: { message: "Resource not accessible by personal access token" },
  headers: { "x-accepted-github-permissions": "administration=write" },
};

const fakeFetch = (routes: Record<string, FakeReply | FakeReply[]>) =>
  coreFakeFetch(routes, { base: GITHUB_API });

async function failure(promise: Promise<unknown>): Promise<OpsCrewError> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(OpsCrewError);
  const opsError = error as OpsCrewError;
  expect(`${opsError.message} ${opsError.hint ?? ""} ${JSON.stringify(error)}`).not.toContain(
    TOKEN,
  );
  return opsError;
}

describe("runner tokens", () => {
  for (const [method, kind] of [
    ["runnerRegistrationToken", "registration-token"],
    ["runnerRemoveToken", "remove-token"],
  ] as const) {
    it(`${method} returns the token and registers it with the redactor first`, async () => {
      const runnerToken = fakeSecret("generic-password", kind);
      const { fetch, calls } = fakeFetch({
        [`POST ${RUNNERS}/${kind}`]: {
          status: 201,
          body: { token: runnerToken, expires_at: "2026-10-22T11:00:00Z" },
        },
      });
      const redactor = new Redactor();
      const client = new GitHubClient({ token: TOKEN, fetch, redactor });
      expect(await client[method]("acme", "shop")).toBe(runnerToken);
      expect(calls[0]).toMatchObject({ method: "POST", path: `${RUNNERS}/${kind}` });
      expect(redactor.redact(`config.sh --token ${runnerToken}`)).not.toContain(runnerToken);
    });
  }

  it("the connector's client registers runner tokens with the connector's redactor", async () => {
    const runnerToken = fakeSecret("generic-password", "connector");
    const { fetch } = fakeFetch({
      [`POST ${RUNNERS}/registration-token`]: { status: 201, body: { token: runnerToken } },
    });
    const redactor = new Redactor();
    const connector = githubConnector({ token: TOKEN, fetch, redactor });
    await connector.client?.runnerRegistrationToken("acme", "shop");
    expect(redactor.redact(runnerToken)).not.toContain(runnerToken);
  });

  it("names Administration on a 403, without the token", async () => {
    const { fetch } = fakeFetch({ [RUNNERS]: NO_ADMIN });
    const error = await failure(
      new GitHubClient({ token: TOKEN, fetch }).runnerRegistrationToken("acme", "shop"),
    );
    expect(error.code).toBe("CREDENTIALS_INVALID");
    expect(error.message).toContain("Resource not accessible by personal access token");
    expect(error.hint).toContain("Administration: Read and write");
  });

  it("refuses an answer without a token", async () => {
    const { fetch } = fakeFetch({ [`POST ${RUNNERS}/remove-token`]: { status: 201, body: {} } });
    const error = await failure(
      new GitHubClient({ token: TOKEN, fetch }).runnerRemoveToken("acme", "shop"),
    );
    expect(error.code).toBe("PROVIDER_ERROR");
  });
});

describe("listRunners and deleteRunner", () => {
  it("lists the repository's runners with their labels", async () => {
    const { fetch, calls } = fakeFetch({
      [`GET ${RUNNERS}`]: {
        body: {
          total_count: 2,
          runners: [
            {
              id: 23,
              name: "web-1-shop-staging",
              os: "Linux",
              status: "online",
              busy: false,
              labels: [
                { id: 1, name: "self-hosted", type: "read-only" },
                { id: 9, name: "opscrew-shop-staging", type: "custom" },
              ],
            },
            {
              id: 24,
              name: "laptop-shop-dev",
              os: "Windows",
              status: "offline",
              busy: false,
              labels: [],
              version: "2.338.0",
            },
          ],
        },
      },
    });
    expect(await new GitHubClient({ token: TOKEN, fetch }).listRunners("acme", "shop")).toEqual([
      {
        id: 23,
        name: "web-1-shop-staging",
        status: "online",
        labels: ["self-hosted", "opscrew-shop-staging"],
      },
      { id: 24, name: "laptop-shop-dev", status: "offline", labels: [], version: "2.338.0" },
    ]);
    expect(new URL(calls[0]?.url ?? "").searchParams.get("per_page")).toBe("100");
  });

  it("deletes a runner, and a missing one (404) counts as deleted", async () => {
    for (const reply of [{ status: 204 }, NOT_FOUND]) {
      const { fetch, calls } = fakeFetch({ [`DELETE ${RUNNERS}/23`]: reply });
      await expect(
        new GitHubClient({ token: TOKEN, fetch }).deleteRunner("acme", "shop", 23),
      ).resolves.toBeUndefined();
      expect(calls).toHaveLength(1);
    }
  });

  it("names Administration on a 403: Read for listing, Read and write for deleting", async () => {
    for (const [call, needed] of [
      [(c: GitHubClient) => c.listRunners("acme", "shop"), "Administration: Read on"],
      [(c: GitHubClient) => c.deleteRunner("acme", "shop", 23), "Administration: Read and write"],
    ] as const) {
      const { fetch } = fakeFetch({
        [RUNNERS]: { status: 403, body: { message: "Must have admin rights to Repository." } },
      });
      const error = await failure(call(new GitHubClient({ token: TOKEN, fetch })));
      expect(error.hint).toContain(needed);
    }
  });
});

describe("repositoryVisibility", () => {
  for (const visibility of ["public", "private", "internal"] as const) {
    it(`reads ${visibility}`, async () => {
      const { fetch } = fakeFetch({
        "GET /repos/acme/shop": {
          body: { default_branch: "main", private: visibility !== "public", visibility },
        },
      });
      expect(
        await new GitHubClient({ token: TOKEN, fetch }).repositoryVisibility("acme", "shop"),
      ).toBe(visibility);
    });
  }

  it("refuses an unknown visibility", async () => {
    const { fetch } = fakeFetch({ "GET /repos/acme/shop": { body: { visibility: "secret" } } });
    const error = await failure(
      new GitHubClient({ token: TOKEN, fetch }).repositoryVisibility("acme", "shop"),
    );
    expect(error.code).toBe("PROVIDER_ERROR");
  });
});

describe("the fork-PR approval policy", () => {
  it("reads it", async () => {
    const { fetch } = fakeFetch({
      [`GET ${FORK_PR}`]: { body: { approval_policy: "first_time_contributors" } },
    });
    expect(
      await new GitHubClient({ token: TOKEN, fetch }).forkPrApprovalPolicy("acme", "shop"),
    ).toBe("first_time_contributors");
  });

  it("sets it", async () => {
    const { fetch, calls } = fakeFetch({ [`PUT ${FORK_PR}`]: { status: 204 } });
    await new GitHubClient({ token: TOKEN, fetch }).setForkPrApprovalPolicy(
      "acme",
      "shop",
      "all_external_contributors",
    );
    expect(calls[0]).toMatchObject({
      method: "PUT",
      body: { approval_policy: "all_external_contributors" },
    });
  });

  it("refuses an unknown policy", async () => {
    const { fetch } = fakeFetch({ [`GET ${FORK_PR}`]: { body: { approval_policy: "never" } } });
    const error = await failure(
      new GitHubClient({ token: TOKEN, fetch }).forkPrApprovalPolicy("acme", "shop"),
    );
    expect(error.code).toBe("PROVIDER_ERROR");
  });

  it("names Administration on a 403, from GitHub's header", async () => {
    const { fetch } = fakeFetch({ [FORK_PR]: NO_ADMIN });
    const client = new GitHubClient({ token: TOKEN, fetch });
    for (const call of [
      client.forkPrApprovalPolicy("acme", "shop"),
      client.setForkPrApprovalPolicy("acme", "shop", "all_external_contributors"),
    ]) {
      const error = await failure(call);
      expect(error.code).toBe("CREDENTIALS_INVALID");
      expect(error.hint).toContain("Administration: Read and write");
    }
  });
});
