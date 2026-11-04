import { OpsCrewError } from "@opscrew/core";
import { fakeFetch as coreFakeFetch, type FakeReply, fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { GITHUB_API } from "./github";
import { GitHubClient } from "./index";

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

/** A Dependabot alert as GitHub's documentation shows it. */
function alert(number: number, severity: string, name: string) {
  return {
    number,
    state: "open",
    dependency: {
      package: { ecosystem: "npm", name },
      manifest_path: "package-lock.json",
      scope: "runtime",
    },
    security_advisory: {
      ghsa_id: "GHSA-aaaa-bbbb-cccc",
      summary: `A flaw in ${name}`,
      severity,
    },
    security_vulnerability: {
      package: { ecosystem: "npm", name },
      severity,
      vulnerable_version_range: "< 1.2.3",
      first_patched_version: { identifier: "1.2.3" },
    },
    url: `https://api.github.com/repos/acme/shop/dependabot/alerts/${number}`,
    html_url: `https://github.com/acme/shop/security/dependabot/${number}`,
    created_at: "2026-10-01T10:00:00Z",
  };
}

const NEXT = (query: string) => ({
  link: `<${GITHUB_API}${API}/${query}>; rel="next", <${GITHUB_API}${API}/x>; rel="first"`,
});

describe("dependabotAlerts", () => {
  const ALERTS = `GET ${API}/dependabot/alerts`;

  it("lists the open alerts of every page with severity, package and link", async () => {
    const { client, calls } = setup({
      [`${ALERTS}?state=open&per_page=100`]: {
        body: [alert(1, "critical", "lodash"), alert(2, "high", "express")],
        headers: NEXT("dependabot/alerts?state=open&per_page=100&after=abc"),
      },
      [`${ALERTS}?state=open&per_page=100&after=abc`]: { body: [alert(3, "low", "debug")] },
    });
    expect(await client.dependabotAlerts("acme", "shop")).toEqual({
      state: "on",
      alerts: [
        {
          severity: "critical",
          package: "lodash",
          url: "https://github.com/acme/shop/security/dependabot/1",
        },
        {
          severity: "high",
          package: "express",
          url: "https://github.com/acme/shop/security/dependabot/2",
        },
        {
          severity: "low",
          package: "debug",
          url: "https://github.com/acme/shop/security/dependabot/3",
        },
      ],
    });
    expect(calls.map((c) => c.path)).toEqual([
      `${API}/dependabot/alerts?state=open&per_page=100`,
      `${API}/dependabot/alerts?state=open&per_page=100&after=abc`,
    ]);
    expect(calls[1]?.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("is on with no alerts when GitHub lists none", async () => {
    const { client } = setup({ [ALERTS]: { body: [] } });
    expect(await client.dependabotAlerts("acme", "shop")).toEqual({ state: "on", alerts: [] });
  });

  it("is off when GitHub says the alerts are disabled", async () => {
    const { client } = setup({
      [ALERTS]: {
        status: 403,
        body: {
          message: "Dependabot alerts are disabled for this repository.",
          documentation_url: "https://docs.github.com/rest/dependabot/alerts",
        },
      },
    });
    expect(await client.dependabotAlerts("acme", "shop")).toEqual({ state: "off" });
  });

  it("names Dependabot alerts: Read on any other 403, without the token", async () => {
    const { client } = setup({
      [ALERTS]: {
        status: 403,
        body: { message: "Resource not accessible by personal access token" },
        headers: { "x-accepted-github-permissions": "vulnerability_alerts=read" },
      },
    });
    const error = await failure(client.dependabotAlerts("acme", "shop"));
    expect(error.code).toBe("CREDENTIALS_INVALID");
    expect(error.message).toContain("Resource not accessible by personal access token");
    expect(error.hint).toContain("Dependabot alerts: Read");
    expect(error.hint).toContain("run the command again");
  });

  it("refuses a severity GitHub does not document", async () => {
    const { client } = setup({ [ALERTS]: { body: [alert(1, "urgent", "lodash")] } });
    const error = await failure(client.dependabotAlerts("acme", "shop"));
    expect(error.code).toBe("PROVIDER_ERROR");
  });

  it("does not follow a next page on another host", async () => {
    const { client, calls } = setup({
      [ALERTS]: {
        body: [alert(1, "high", "lodash")],
        headers: { link: '<https://elsewhere.example.com/alerts?after=abc>; rel="next"' },
      },
    });
    const error = await failure(client.dependabotAlerts("acme", "shop"));
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(calls).toHaveLength(1);
  });
});

/** A pull request as GitHub lists it. */
function pull(number: number, login: string) {
  return {
    number,
    title: `Bump thing ${number}`,
    html_url: `https://github.com/acme/shop/pull/${number}`,
    created_at: `2026-10-0${number}T08:00:00Z`,
    state: "open",
    user: { login, type: login.endsWith("[bot]") ? "Bot" : "User" },
  };
}

describe("dependabotPulls", () => {
  it("keeps the open pull requests by dependabot[bot], every page", async () => {
    const { client, calls } = setup({
      [`GET ${API}/pulls?state=open&per_page=100`]: {
        body: [pull(1, "dependabot[bot]"), pull(2, "octocat")],
        headers: NEXT("pulls?state=open&per_page=100&page=2"),
      },
      [`GET ${API}/pulls?state=open&per_page=100&page=2`]: {
        body: [pull(3, "dependabot[bot]"), pull(4, "renovate[bot]")],
      },
    });
    expect(await client.dependabotPulls("acme", "shop")).toEqual([
      {
        number: 1,
        title: "Bump thing 1",
        createdAt: "2026-10-01T08:00:00Z",
        url: "https://github.com/acme/shop/pull/1",
      },
      {
        number: 3,
        title: "Bump thing 3",
        createdAt: "2026-10-03T08:00:00Z",
        url: "https://github.com/acme/shop/pull/3",
      },
    ]);
    expect(calls).toHaveLength(2);
  });

  it("names Pull requests: Read on a 403", async () => {
    const { client } = setup({
      [`GET ${API}/pulls`]: {
        status: 403,
        body: { message: "Resource not accessible by personal access token" },
      },
    });
    const error = await failure(client.dependabotPulls("acme", "shop"));
    expect(error.hint).toContain("Pull requests: Read");
  });
});

/** An issue as GitHub lists it. */
function issue(number: number, createdAt: string, extra: Record<string, unknown> = {}) {
  return {
    number,
    title: `Check ${number} failing`,
    html_url: `https://github.com/acme/shop/issues/${number}`,
    body: null,
    created_at: createdAt,
    updated_at: "2026-11-04T10:00:00Z",
    closed_at: null,
    state: "open",
    ...extra,
  };
}

describe("issuesSince", () => {
  const SINCE = "2026-10-22T00:00:00Z";
  const QUERY = `labels=opscrew-check&state=all&since=${encodeURIComponent(SINCE)}&per_page=100`;

  it("keeps the issues opened since the date, open or closed, pull requests left out", async () => {
    const { client, calls } = setup({
      [`GET ${API}/issues?${QUERY}`]: {
        body: [
          issue(9, "2026-11-01T10:00:00Z"),
          issue(8, "2026-10-25T10:00:00Z", {
            state: "closed",
            closed_at: "2026-10-26T09:00:00Z",
          }),
          // Updated since the date but opened before it.
          issue(5, "2026-09-01T10:00:00Z"),
          issue(7, "2026-10-30T10:00:00Z", { pull_request: { url: "x" } }),
        ],
        headers: NEXT(`issues?${QUERY}&page=2`),
      },
      [`GET ${API}/issues?${QUERY}&page=2`]: { body: [issue(6, "2026-10-22T00:00:00Z")] },
    });
    expect(await client.issuesSince("acme", "shop", "opscrew-check", SINCE)).toEqual([
      { number: 9, createdAt: "2026-11-01T10:00:00Z" },
      { number: 8, createdAt: "2026-10-25T10:00:00Z", closedAt: "2026-10-26T09:00:00Z" },
      { number: 6, createdAt: "2026-10-22T00:00:00Z" },
    ]);
    expect(calls.map((c) => c.path)).toEqual([
      `${API}/issues?${QUERY}`,
      `${API}/issues?${QUERY}&page=2`,
    ]);
  });

  it("names Issues: Read on a 403", async () => {
    const { client } = setup({
      [`GET ${API}/issues`]: {
        status: 403,
        body: { message: "Resource not accessible by personal access token" },
      },
    });
    const error = await failure(client.issuesSince("acme", "shop", "opscrew-check", SINCE));
    expect(error.hint).toContain("Issues: Read");
  });
});

describe("tokenExpiry", () => {
  it("reads GitHub's expiry header as ISO 8601", async () => {
    const { client, calls } = setup({
      "GET /user": {
        body: { login: "octocat" },
        headers: { "github-authentication-token-expiration": "2026-11-27 17:25:14 UTC" },
      },
    });
    expect(await client.tokenExpiry()).toBe("2026-11-27T17:25:14Z");
    expect(calls.map((c) => c.path)).toEqual(["/user"]);
  });

  it("is undefined for a token without an expiry", async () => {
    const { client } = setup({ "GET /user": { body: { login: "octocat" } } });
    expect(await client.tokenExpiry()).toBeUndefined();
  });

  it("refuses a header in another form", async () => {
    const { client } = setup({
      "GET /user": {
        body: { login: "octocat" },
        headers: { "github-authentication-token-expiration": "next Tuesday" },
      },
    });
    const error = await failure(client.tokenExpiry());
    expect(error.code).toBe("PROVIDER_ERROR");
  });

  it("keeps the token out of a rejection", async () => {
    const { client } = setup({
      "GET /user": { status: 401, body: { message: "Bad credentials" } },
    });
    const error = await failure(client.tokenExpiry());
    expect(error.code).toBe("CREDENTIALS_INVALID");
  });
});
