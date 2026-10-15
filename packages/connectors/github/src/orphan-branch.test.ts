import type { FetchLike } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { GitHubClient } from "./index";

const TOKEN = fakeSecret("github-token");
const BLOB = "b".repeat(40);
const TREE = "c".repeat(40);
const COMMIT = "d".repeat(40);

type Route = { status?: number; body?: unknown };
type Recorded = { method: string; path: string; body?: unknown };

/** GitHub's Git Data API, routed by exact `METHOD path`. */
function fakeGitData(routes: Record<string, Route>) {
  const calls: Recorded[] = [];
  const fetch: FetchLike = async (input, init) => {
    const method = init?.method ?? "GET";
    const path = String(input).replace("https://api.github.com", "");
    calls.push({ method, path, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    const route = routes[`${method} ${path}`];
    if (route === undefined) throw new Error(`unrouted ${method} ${path}`);
    return new Response(route.body === undefined ? null : JSON.stringify(route.body), {
      status: route.status ?? 200,
    });
  };
  return { fetch, calls };
}

const CREATED: Record<string, Route> = {
  "GET /repos/acme/shop/git/ref/heads/opscrew-deploy": {
    status: 404,
    body: { message: "Not Found" },
  },
  "POST /repos/acme/shop/git/blobs": { status: 201, body: { sha: BLOB } },
  "POST /repos/acme/shop/git/trees": { status: 201, body: { sha: TREE } },
  "POST /repos/acme/shop/git/commits": { status: 201, body: { sha: COMMIT } },
  "POST /repos/acme/shop/git/refs": {
    status: 201,
    body: { ref: "refs/heads/opscrew-deploy", object: { sha: COMMIT } },
  },
};

const INPUT = {
  owner: "acme",
  repo: "shop",
  branch: "opscrew-deploy",
  path: "compose.yaml",
  content: "name: opscrew-shop\nservices: {}\n",
  message: "Placeholder until the first deploy",
};

describe("GitHubClient.createOrphanBranch", () => {
  it("creates a branch holding only one file: blob, tree, commit without parents, ref", async () => {
    const { fetch, calls } = fakeGitData(CREATED);
    const result = await new GitHubClient({ token: TOKEN, fetch }).createOrphanBranch(INPUT);

    expect(result).toEqual({ commit: COMMIT });
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "GET /repos/acme/shop/git/ref/heads/opscrew-deploy",
      "POST /repos/acme/shop/git/blobs",
      "POST /repos/acme/shop/git/trees",
      "POST /repos/acme/shop/git/commits",
      "POST /repos/acme/shop/git/refs",
    ]);
    expect(calls[1]?.body).toEqual({ content: INPUT.content, encoding: "utf-8" });
    // No base tree: the commit holds this one file and nothing else.
    expect(calls[2]?.body).toEqual({
      tree: [{ path: "compose.yaml", mode: "100644", type: "blob", sha: BLOB }],
    });
    expect(calls[3]?.body).toEqual({ message: INPUT.message, tree: TREE, parents: [] });
    expect(calls[4]?.body).toEqual({ ref: "refs/heads/opscrew-deploy", sha: COMMIT });
  });

  it("refuses plainly when the branch exists, before writing anything", async () => {
    const { fetch, calls } = fakeGitData({
      ...CREATED,
      "GET /repos/acme/shop/git/ref/heads/opscrew-deploy": {
        body: { ref: "refs/heads/opscrew-deploy", object: { sha: COMMIT } },
      },
    });
    const error = await new GitHubClient({ token: TOKEN, fetch })
      .createOrphanBranch(INPUT)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpsCrewError);
    expect(error).toMatchObject({ code: "PHASE_PRECONDITION" });
    expect((error as Error).message).toContain("opscrew-deploy already exists");
    expect(calls.map((call) => call.method)).toEqual(["GET"]);
  });

  it("refuses plainly when the branch appears between the check and the ref", async () => {
    const { fetch } = fakeGitData({
      ...CREATED,
      "POST /repos/acme/shop/git/refs": {
        status: 422,
        body: { message: "Reference already exists" },
      },
    });
    await expect(
      new GitHubClient({ token: TOKEN, fetch }).createOrphanBranch(INPUT),
    ).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      message: expect.stringContaining("opscrew-deploy already exists"),
    });
  });

  it("names the missing permission without the token", async () => {
    const { fetch } = fakeGitData({
      ...CREATED,
      "POST /repos/acme/shop/git/blobs": {
        status: 403,
        body: { message: "Resource not accessible by personal access token" },
      },
    });
    const error = (await new GitHubClient({ token: TOKEN, fetch })
      .createOrphanBranch(INPUT)
      .catch((e: unknown) => e)) as OpsCrewError;
    expect(error).toMatchObject({ code: "CREDENTIALS_INVALID" });
    expect(`${error.message} ${error.hint}`).toContain("Contents: Read and write");
    expect(`${error.message} ${error.hint}`).not.toContain(TOKEN);
  });

  it.each([
    ["a branch name with spaces", { branch: "deploy branch" }],
    ["a branch name starting with -", { branch: "-x" }],
    ["a path outside the root", { path: "../compose.yaml" }],
    ["a nested path", { path: "a/compose.yaml" }],
    ["an owner with a slash", { owner: "acme/x" }],
  ])("refuses %s before calling GitHub", async (_name, change) => {
    const { fetch, calls } = fakeGitData(CREATED);
    await expect(
      new GitHubClient({ token: TOKEN, fetch }).createOrphanBranch({ ...INPUT, ...change }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(calls).toEqual([]);
  });

  it("refuses an answer without a sha", async () => {
    const { fetch } = fakeGitData({
      ...CREATED,
      "POST /repos/acme/shop/git/trees": { status: 201, body: { nope: true } },
    });
    await expect(
      new GitHubClient({ token: TOKEN, fetch }).createOrphanBranch(INPUT),
    ).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
  });
});
