import { OpsCrewError } from "@opscrew/core";
import { fakeFetch as coreFakeFetch, type FakeReply, fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { GITHUB_API } from "./github";
import { GITHUB_TOKEN_PERMISSIONS, GitHubClient } from "./index";

const TOKEN = fakeSecret("github-token");
const API = "/repos/acme/shop";

function setup(routes: Record<string, FakeReply | FakeReply[]>) {
  const { fetch, calls } = coreFakeFetch(routes, { base: GITHUB_API });
  return { client: new GitHubClient({ token: TOKEN, fetch }), calls };
}

/** The error a call failed with, checked to hold no token. */
async function failure(call: Promise<unknown>): Promise<OpsCrewError> {
  const error = await call.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(OpsCrewError);
  const { message, hint = "" } = error as OpsCrewError;
  expect(`${message} ${hint}`).not.toContain(TOKEN);
  return error as OpsCrewError;
}

function issue(number: number, extra: Record<string, unknown> = {}) {
  return {
    number,
    title: `Check ${number} failing`,
    html_url: `https://github.com/acme/shop/issues/${number}`,
    body: `<!-- opscrew-check:shop/production/health/${number} -->`,
    created_at: "2026-10-01T10:00:00Z",
    state: "open",
    ...extra,
  };
}

describe("checkWorkflowState", () => {
  const WORKFLOW = `GET ${API}/actions/workflows/opscrew-check.yml`;

  it("reads the workflow's state: active, or off for inactivity", async () => {
    const { client, calls } = setup({
      [WORKFLOW]: [
        {
          body: {
            id: 1,
            name: "OpsCrew check",
            path: ".github/workflows/opscrew-check.yml",
            state: "active",
          },
        },
        { body: { id: 1, name: "OpsCrew check", state: "disabled_inactivity" } },
      ],
    });
    expect(await client.checkWorkflowState("acme", "shop", "opscrew-check.yml")).toBe("active");
    expect(
      await client.checkWorkflowState("acme", "shop", ".github/workflows/opscrew-check.yml"),
    ).toBe("disabled_inactivity");
    expect(calls.map((c) => c.path)).toEqual([
      `${API}/actions/workflows/opscrew-check.yml`,
      `${API}/actions/workflows/opscrew-check.yml`,
    ]);
  });

  it("is missing when GitHub has no such workflow (404)", async () => {
    const { client } = setup({ [WORKFLOW]: { status: 404, body: { message: "Not Found" } } });
    expect(await client.checkWorkflowState("acme", "shop", "opscrew-check.yml")).toBe("missing");
  });

  it("names Actions: Read on a 403", async () => {
    const { client } = setup({
      [WORKFLOW]: {
        status: 403,
        body: { message: "Resource not accessible by personal access token" },
      },
    });
    const error = await failure(client.checkWorkflowState("acme", "shop", "opscrew-check.yml"));
    expect(error.hint).toContain("Actions: Read");
  });
});

describe("openIssues", () => {
  it("reads every page, and skips pull requests", async () => {
    const first = `${API}/issues?labels=opscrew-check&state=open&per_page=100&page=1`;
    const second = `${API}/issues?labels=opscrew-check&state=open&per_page=100&page=2`;
    const { client, calls } = setup({
      [`GET ${first}`]: {
        body: [issue(3), issue(4, { pull_request: { url: "https://api.github.com/x" } })],
        headers: {
          link: `<${GITHUB_API}${second}>; rel="next", <${GITHUB_API}${second}>; rel="last"`,
        },
      },
      [`GET ${second}`]: { body: [issue(9, { body: null })] },
    });
    expect(await client.openIssues("acme", "shop", "opscrew-check")).toEqual([
      {
        number: 3,
        title: "Check 3 failing",
        url: "https://github.com/acme/shop/issues/3",
        body: "<!-- opscrew-check:shop/production/health/3 -->",
        createdAt: "2026-10-01T10:00:00Z",
      },
      {
        number: 9,
        title: "Check 9 failing",
        url: "https://github.com/acme/shop/issues/9",
        body: "",
        createdAt: "2026-10-01T10:00:00Z",
      },
    ]);
    expect(calls.map((c) => c.path)).toEqual([first, second]);
  });

  it("names Issues: Read on a 403", async () => {
    const { client } = setup({
      [`GET ${API}/issues`]: {
        status: 403,
        body: { message: "Resource not accessible by personal access token" },
      },
    });
    const error = await failure(client.openIssues("acme", "shop", "opscrew-check"));
    expect(error.code).toBe("CREDENTIALS_INVALID");
    expect(error.hint).toContain("Issues: Read");
  });
});

describe("repository variables", () => {
  const VARIABLE = `${API}/actions/variables/OPSCREW_CHECK_PAUSED`;

  it("reads a variable, and undefined when it does not exist", async () => {
    const { client } = setup({
      [`GET ${VARIABLE}`]: [
        { body: { name: "OPSCREW_CHECK_PAUSED", value: "{}", created_at: "x", updated_at: "y" } },
        { status: 404, body: { message: "Not Found" } },
      ],
    });
    expect(await client.getRepoVariable("acme", "shop", "OPSCREW_CHECK_PAUSED")).toBe("{}");
    expect(await client.getRepoVariable("acme", "shop", "OPSCREW_CHECK_PAUSED")).toBeUndefined();
  });

  it("creates a variable that does not exist", async () => {
    const { client, calls } = setup({
      [`PATCH ${VARIABLE}`]: { status: 404, body: { message: "Not Found" } },
      [`POST ${API}/actions/variables`]: { status: 201, body: {} },
    });
    await client.setRepoVariable("acme", "shop", "OPSCREW_CHECK_PAUSED", '{"shop/qa":"move"}');
    expect(calls.map((c) => [c.method, c.path, c.body])).toEqual([
      ["PATCH", VARIABLE, { name: "OPSCREW_CHECK_PAUSED", value: '{"shop/qa":"move"}' }],
      [
        "POST",
        `${API}/actions/variables`,
        { name: "OPSCREW_CHECK_PAUSED", value: '{"shop/qa":"move"}' },
      ],
    ]);
  });

  it("updates a variable that exists", async () => {
    const { client, calls } = setup({ [`PATCH ${VARIABLE}`]: { status: 204 } });
    await client.setRepoVariable("acme", "shop", "OPSCREW_CHECK_PAUSED", "{}");
    expect(calls.map((c) => c.method)).toEqual(["PATCH"]);
  });

  it("deletes a variable, and a missing one counts as deleted", async () => {
    const { client, calls } = setup({
      [`DELETE ${VARIABLE}`]: [{ status: 204 }, { status: 404, body: { message: "Not Found" } }],
    });
    await client.deleteRepoVariable("acme", "shop", "OPSCREW_CHECK_PAUSED");
    await client.deleteRepoVariable("acme", "shop", "OPSCREW_CHECK_PAUSED");
    expect(calls.map((c) => c.method)).toEqual(["DELETE", "DELETE"]);
  });

  it("names Variables: Read and write on a 403", async () => {
    const { client } = setup({
      [`PATCH ${VARIABLE}`]: {
        status: 403,
        body: { message: "Resource not accessible by personal access token" },
      },
    });
    const error = await failure(
      client.setRepoVariable("acme", "shop", "OPSCREW_CHECK_PAUSED", "{}"),
    );
    expect(error.hint).toContain("Variables: Read and write");
  });
});

describe("includedMinutes", () => {
  const user = (login: string, plan?: string) => ({
    login,
    id: 1,
    ...(plan === undefined ? {} : { plan: { name: plan, space: 1, private_repos: 1 } }),
  });

  it("reads the user's own plan: 2,000 on Free and 3,000 on Pro", async () => {
    for (const [plan, minutes] of [
      ["free", 2_000],
      ["pro", 3_000],
    ] as const) {
      const { client } = setup({
        "GET /users/octocat": { body: { id: 1, type: "User" } },
        "GET /user": { body: user("octocat", plan) },
      });
      expect(await client.includedMinutes("octocat")).toBe(minutes);
    }
  });

  it("reads an organization's plan: 2,000 on Free, 3,000 on Team and 50,000 on Enterprise", async () => {
    for (const [plan, minutes] of [
      ["free", 2_000],
      ["team", 3_000],
      ["enterprise", 50_000],
    ] as const) {
      const { client } = setup({
        "GET /users/acme": { body: { id: 2, type: "Organization" } },
        "GET /orgs/acme": { body: user("acme", plan) },
      });
      expect(await client.includedMinutes("acme")).toBe(minutes);
    }
  });

  it("is undefined when GitHub hides the plan or it is another user's account", async () => {
    const hidden = setup({
      "GET /users/acme": { body: { id: 2, type: "Organization" } },
      "GET /orgs/acme": { body: user("acme") },
    });
    expect(await hidden.client.includedMinutes("acme")).toBeUndefined();
    const other = setup({
      "GET /users/someone": { body: { id: 3, type: "User" } },
      "GET /user": { body: user("octocat", "pro") },
    });
    expect(await other.client.includedMinutes("someone")).toBeUndefined();
    const unknown = setup({
      "GET /users/acme": { body: { id: 2, type: "Organization" } },
      "GET /orgs/acme": { body: user("acme", "business_plus") },
    });
    expect(await unknown.client.includedMinutes("acme")).toBeUndefined();
  });
});

describe("getRepo", () => {
  it("says whether the repository has issues", async () => {
    const { client } = setup({
      [`GET ${API}`]: {
        body: {
          default_branch: "main",
          private: false,
          has_issues: false,
          permissions: { push: true },
        },
      },
    });
    expect(await client.getRepo("acme", "shop")).toEqual({
      defaultBranch: "main",
      private: false,
      canPush: true,
      hasIssues: false,
    });
  });
});

describe("GITHUB_TOKEN_PERMISSIONS", () => {
  it("lists Issues and Variables, only with the scheduled check", () => {
    expect(GITHUB_TOKEN_PERMISSIONS).toContain("Issues: Read (only with the scheduled check)");
    expect(GITHUB_TOKEN_PERMISSIONS).toContain(
      "Variables: Read and write (only with the scheduled check)",
    );
  });
});
