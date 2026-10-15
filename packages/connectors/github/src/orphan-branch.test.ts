import { createHash } from "node:crypto";
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

/**
 * GitHub's Git Data API, routed by exact `METHOD path`; a list answers in turn (its last answer
 * repeats).
 */
function fakeGitData(routes: Record<string, Route | Route[]>) {
  const calls: Recorded[] = [];
  const seen = new Map<string, number>();
  const fetch: FetchLike = async (input, init) => {
    const method = init?.method ?? "GET";
    const path = String(input).replace("https://api.github.com", "");
    calls.push({ method, path, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    const key = `${method} ${path}`;
    const routed = routes[key];
    const count = seen.get(key) ?? 0;
    seen.set(key, count + 1);
    const route = Array.isArray(routed) ? routed[Math.min(count, routed.length - 1)] : routed;
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
      // Absent at the check, there after GitHub's 422.
      "GET /repos/acme/shop/git/ref/heads/opscrew-deploy": [
        { status: 404, body: { message: "Not Found" } },
        { body: { ref: "refs/heads/opscrew-deploy", object: { sha: COMMIT } } },
      ],
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

  it("a 422 for a branch that is still absent is GitHub refusing it (a ruleset): its words and what to do", async () => {
    const { fetch } = fakeGitData({
      ...CREATED,
      "POST /repos/acme/shop/git/refs": {
        status: 422,
        body: { message: "Repository rule violations found" },
      },
    });
    const error = (await new GitHubClient({ token: TOKEN, fetch })
      .createOrphanBranch(INPUT)
      .catch((e: unknown) => e)) as OpsCrewError;
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toContain("Repository rule violations found");
    expect(error.hint).toContain("ruleset");
    expect(`${error.message} ${error.hint}`).not.toContain(TOKEN);
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

const REF = "/repos/acme/shop/git/ref/heads/opscrew-deploy";
const REFS = "/repos/acme/shop/git/refs/heads/opscrew-deploy";
const OLD = "e".repeat(40);

describe("GitHubClient.replaceOrphanBranch", () => {
  const existing: Record<string, Route> = {
    ...CREATED,
    [`GET ${REF}`]: { body: { ref: "refs/heads/opscrew-deploy", object: { sha: OLD } } },
    [`PATCH ${REFS}`]: { body: { ref: "refs/heads/opscrew-deploy", object: { sha: COMMIT } } },
  };

  it("points the existing branch at a new commit holding only one file, without parents (forced)", async () => {
    const { fetch, calls } = fakeGitData(existing);
    const result = await new GitHubClient({ token: TOKEN, fetch }).replaceOrphanBranch(INPUT);
    expect(result).toEqual({ commit: COMMIT, previous: OLD });
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      `GET ${REF}`,
      "POST /repos/acme/shop/git/blobs",
      "POST /repos/acme/shop/git/trees",
      "POST /repos/acme/shop/git/commits",
      `PATCH ${REFS}`,
    ]);
    expect(calls[2]?.body).toEqual({
      tree: [{ path: "compose.yaml", mode: "100644", type: "blob", sha: BLOB }],
    });
    expect(calls[3]?.body).toEqual({ message: INPUT.message, tree: TREE, parents: [] });
    expect(calls[4]?.body).toEqual({ sha: COMMIT, force: true });
  });

  it("refuses plainly when the branch does not exist, before writing anything", async () => {
    const { fetch, calls } = fakeGitData(CREATED);
    await expect(
      new GitHubClient({ token: TOKEN, fetch }).replaceOrphanBranch(INPUT),
    ).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      message: expect.stringContaining("does not exist"),
    });
    expect(calls.map((call) => call.method)).toEqual(["GET"]);
  });

  it("refuses the same invalid input as createOrphanBranch, before calling GitHub", async () => {
    const { fetch, calls } = fakeGitData(existing);
    await expect(
      new GitHubClient({ token: TOKEN, fetch }).replaceOrphanBranch({ ...INPUT, branch: "-x" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(calls).toEqual([]);
  });
});

describe("GitHubClient.deleteBranch", () => {
  it("deletes the branch's ref", async () => {
    const { fetch, calls } = fakeGitData({
      [`GET ${REF}`]: { body: { ref: "refs/heads/opscrew-deploy", object: { sha: OLD } } },
      [`DELETE ${REFS}`]: { status: 204 },
    });
    const result = await new GitHubClient({ token: TOKEN, fetch }).deleteBranch(
      "acme",
      "shop",
      "opscrew-deploy",
    );
    expect(result).toBe("deleted");
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      `GET ${REF}`,
      `DELETE ${REFS}`,
    ]);
  });

  it("a missing branch is fine (also when it goes between the check and the delete)", async () => {
    const missing = fakeGitData({
      [`GET ${REF}`]: { status: 404, body: { message: "Not Found" } },
    });
    await expect(
      new GitHubClient({ token: TOKEN, fetch: missing.fetch }).deleteBranch(
        "acme",
        "shop",
        "opscrew-deploy",
      ),
    ).resolves.toBe("absent");
    expect(missing.calls.map((call) => call.method)).toEqual(["GET"]);
    const raced = fakeGitData({
      [`GET ${REF}`]: [
        { body: { ref: "refs/heads/opscrew-deploy", object: { sha: OLD } } },
        { status: 404, body: { message: "Not Found" } },
      ],
      [`DELETE ${REFS}`]: { status: 422, body: { message: "Reference does not exist" } },
    });
    await expect(
      new GitHubClient({ token: TOKEN, fetch: raced.fetch }).deleteBranch(
        "acme",
        "shop",
        "opscrew-deploy",
      ),
    ).resolves.toBe("absent");
  });

  it("names the missing permission, never the token, and refuses a bad name before calling GitHub", async () => {
    const refused = fakeGitData({
      [`GET ${REF}`]: { body: { ref: "refs/heads/opscrew-deploy", object: { sha: OLD } } },
      [`DELETE ${REFS}`]: { status: 403, body: { message: "Resource not accessible" } },
    });
    const error = (await new GitHubClient({ token: TOKEN, fetch: refused.fetch })
      .deleteBranch("acme", "shop", "opscrew-deploy")
      .catch((e: unknown) => e)) as OpsCrewError;
    expect(error.code).toBe("CREDENTIALS_INVALID");
    expect(`${error.message} ${error.hint}`).toContain("Contents: Read and write");
    expect(`${error.message} ${error.hint}`).not.toContain(TOKEN);

    const bad = fakeGitData({});
    await expect(
      new GitHubClient({ token: TOKEN, fetch: bad.fetch }).deleteBranch("acme", "shop", "a..b"),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(bad.calls).toEqual([]);
  });
});

describe("a 422 on a branch that still exists", () => {
  const exists: Route = { body: { ref: "refs/heads/opscrew-deploy", object: { sha: OLD } } };
  const refused: Route = {
    status: 422,
    body: { message: "Cannot force-update a protected branch" },
  };

  async function refusal(
    call: (client: GitHubClient) => Promise<unknown>,
    routes: Record<string, Route | Route[]>,
  ) {
    const { fetch } = fakeGitData(routes);
    const error = (await call(new GitHubClient({ token: TOKEN, fetch })).catch(
      (e: unknown) => e,
    )) as OpsCrewError;
    expect(error).toBeInstanceOf(OpsCrewError);
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toContain("Cannot force-update a protected branch");
    expect(error.hint).toContain("A branch protection rule or a ruleset may cover opscrew-deploy");
    expect(error.hint).toContain("delete opscrew-deploy yourself");
    expect(`${error.message} ${error.hint}`).not.toContain(TOKEN);
  }

  it("replaceOrphanBranch: a refused forced update says a protection rule may cover the branch", async () => {
    await refusal((client) => client.replaceOrphanBranch(INPUT), {
      ...CREATED,
      [`GET ${REF}`]: exists,
      [`PATCH ${REFS}`]: refused,
    });
  });

  it("replaceOrphanBranch: a branch gone meanwhile is the missing branch, as before", async () => {
    const { fetch } = fakeGitData({
      ...CREATED,
      [`GET ${REF}`]: [exists, { status: 404, body: { message: "Not Found" } }],
      [`PATCH ${REFS}`]: { status: 422, body: { message: "Reference does not exist" } },
    });
    await expect(
      new GitHubClient({ token: TOKEN, fetch }).replaceOrphanBranch(INPUT),
    ).rejects.toMatchObject({ code: "PHASE_PRECONDITION" });
  });

  it("deleteBranch: a refused delete says a protection rule may cover the branch", async () => {
    await refusal((client) => client.deleteBranch("acme", "shop", "opscrew-deploy"), {
      [`GET ${REF}`]: exists,
      [`DELETE ${REFS}`]: refused,
    });
  });
});

describe("GitHubClient.branchHoldsOnly", () => {
  const FILE = { path: "compose.yaml", content: INPUT.content };
  /** The git blob SHA-1 of the file, computed the way git does. */
  const blobSha = (text: string) => {
    const body = Buffer.from(text, "utf8");
    return createHash("sha1")
      .update(Buffer.concat([Buffer.from(`blob ${body.length}\0`), body]))
      .digest("hex");
  };
  const routes = (commit: unknown, tree: unknown): Record<string, Route | Route[]> => ({
    [`GET ${REF}`]: { body: { ref: "refs/heads/opscrew-deploy", object: { sha: COMMIT } } },
    [`GET /repos/acme/shop/git/commits/${COMMIT}`]: { body: commit },
    [`GET /repos/acme/shop/git/trees/${TREE}`]: { body: tree },
  });
  const entry = (extra: Record<string, unknown> = {}) => ({
    path: "compose.yaml",
    mode: "100644",
    type: "blob",
    sha: blobSha(INPUT.content),
    ...extra,
  });
  const holds = async (r: Record<string, Route | Route[]>) =>
    new GitHubClient({ token: TOKEN, fetch: fakeGitData(r).fetch }).branchHoldsOnly(
      "acme",
      "shop",
      "opscrew-deploy",
      FILE,
    );
  const orphan = { sha: COMMIT, tree: { sha: TREE }, parents: [] };

  it("is true for exactly one parentless commit whose tree is only that file", async () => {
    await expect(holds(routes(orphan, { tree: [entry()], truncated: false }))).resolves.toBe(true);
  });

  it("is false for anything else, and for a missing branch", async () => {
    const other = blobSha("something else\n");
    for (const [label, r] of [
      [
        "a commit with parents",
        routes({ ...orphan, parents: [{ sha: OLD }] }, { tree: [entry()] }),
      ],
      ["another file content", routes(orphan, { tree: [entry({ sha: other })] })],
      ["a second file", routes(orphan, { tree: [entry(), entry({ path: "README.md" })] })],
      ["another name", routes(orphan, { tree: [entry({ path: "docker-compose.yml" })] })],
      ["an executable file", routes(orphan, { tree: [entry({ mode: "100755" })] })],
      ["a truncated tree", routes(orphan, { tree: [entry()], truncated: true })],
    ] as const) {
      await expect(holds(r), label).resolves.toBe(false);
    }
    await expect(
      holds({ [`GET ${REF}`]: { status: 404, body: { message: "Not Found" } } }),
    ).resolves.toBe(false);
  });
});
