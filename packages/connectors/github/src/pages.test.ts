import { OpsCrewError } from "@opscrew/core";
import { fakeFetch as coreFakeFetch, type FakeReply, fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { GITHUB_API } from "./github";
import { GitHubClient } from "./index";

const TOKEN = fakeSecret("github-token");
const API = "/repos/acme/shop";

const fakeFetch = (routes: Record<string, FakeReply | FakeReply[]>) =>
  coreFakeFetch(routes, { base: GITHUB_API });

function setup(routes: Record<string, FakeReply | FakeReply[]>) {
  const { fetch, calls } = fakeFetch(routes);
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

/** GitHub's `page` answer with the fields OpsCrew reads. */
function page(overrides: Record<string, unknown> = {}) {
  return {
    url: `https://api.github.com${API}/pages`,
    status: "built",
    cname: null,
    custom_404: false,
    public: true,
    build_type: "workflow",
    https_enforced: false,
    ...overrides,
  };
}

/** GitHub's health check of the custom domain, with the fields OpsCrew reads. */
function health(domain: Record<string, unknown>) {
  return {
    domain: {
      host: "docs.example.com",
      dns_resolves: true,
      is_valid: true,
      is_proxied: false,
      is_https_eligible: true,
      responds_to_https: false,
      ...domain,
    },
    alt_domain: null,
  };
}

describe("getPages", () => {
  it("is undefined when Pages is off (404)", async () => {
    const { client } = setup({
      [`GET ${API}/pages`]: { status: 404, body: { message: "Not Found" } },
    });
    await expect(client.getPages("acme", "shop")).resolves.toBeUndefined();
  });

  it("reads a site published by the workflow, with its domain and HTTPS", async () => {
    const { client } = setup({
      [`GET ${API}/pages`]: {
        body: page({ cname: "docs.example.com", https_enforced: true, status: "built" }),
      },
    });
    expect(await client.getPages("acme", "shop")).toEqual({
      buildType: "workflow",
      cname: "docs.example.com",
      httpsEnforced: true,
      status: "built",
    });
  });

  it("reads a site turned on by hand from a branch (legacy), without a domain", async () => {
    const { client } = setup({
      [`GET ${API}/pages`]: {
        body: page({
          build_type: "legacy",
          status: null,
          source: { branch: "gh-pages", path: "/" },
        }),
      },
    });
    expect(await client.getPages("acme", "shop")).toEqual({
      buildType: "legacy",
      httpsEnforced: false,
    });
  });

  it("refuses an answer that is not a Pages site", async () => {
    const { client } = setup({ [`GET ${API}/pages`]: { body: { build_type: "nightly" } } });
    await failure(client.getPages("acme", "shop"));
  });
});

describe("createPages", () => {
  it("turns Pages on, published by the workflow", async () => {
    const { client, calls } = setup({ [`POST ${API}/pages`]: { status: 201, body: page() } });
    await client.createPages("acme", "shop");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toEqual({ build_type: "workflow" });
  });

  it("says what GitHub needs when the plan does not allow Pages here (422)", async () => {
    const { client, calls } = setup({
      [`POST ${API}/pages`]: {
        status: 422,
        body: {
          message: "Your current plan does not support GitHub Pages for this repository.",
        },
      },
    });
    const error = await failure(client.createPages("acme", "shop"));
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toContain(
      "Your current plan does not support GitHub Pages for this repository",
    );
    expect(error.message).toContain("nothing changed");
    expect(error.hint).toContain("private repository needs a paid GitHub plan");
    expect(calls).toHaveLength(1);
  });

  it("names both permissions GitHub accepts for it (403)", async () => {
    const { client } = setup({
      [`POST ${API}/pages`]: {
        status: 403,
        body: { message: "Resource not accessible by personal access token" },
        headers: { "x-accepted-github-permissions": "pages=write,administration=write" },
      },
    });
    const error = await failure(client.createPages("acme", "shop"));
    expect(error.code).toBe("CREDENTIALS_INVALID");
    expect(error.hint).toContain(
      "Give the token Pages: Read and write and Administration: Read and write on this repository",
    );
  });
});

describe("updatePages", () => {
  it("sets the custom domain", async () => {
    const { client, calls } = setup({ [`PUT ${API}/pages`]: { status: 204 } });
    await client.updatePages("acme", "shop", { cname: "docs.example.com" });
    expect(calls[0]?.body).toEqual({ cname: "docs.example.com" });
  });

  it("removes the custom domain with null", async () => {
    const { client, calls } = setup({ [`PUT ${API}/pages`]: { status: 204 } });
    await client.updatePages("acme", "shop", { cname: null });
    expect(calls[0]?.body).toEqual({ cname: null });
  });

  it("enforces HTTPS without touching the domain", async () => {
    const { client, calls } = setup({ [`PUT ${API}/pages`]: { status: 204 } });
    await client.updatePages("acme", "shop", { httpsEnforced: true });
    expect(calls[0]?.body).toEqual({ https_enforced: true });
  });

  it("says to wait when HTTPS is asked for before the certificate exists (404)", async () => {
    const { client } = setup({
      [`PUT ${API}/pages`]: {
        status: 404,
        body: { message: "The certificate does not exist yet" },
      },
    });
    const error = await failure(client.updatePages("acme", "shop", { httpsEnforced: true }));
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toContain("The certificate does not exist yet");
    expect(error.hint).toContain(
      "has not issued the site's certificate yet, or GitHub Pages is off",
    );
    expect(error.hint).toContain("opscrew status");
    expect(error.hint).not.toContain("Secrets: Read and write");
  });
});

describe("deletePages", () => {
  it("turns Pages off", async () => {
    const { client, calls } = setup({ [`DELETE ${API}/pages`]: { status: 204 } });
    await client.deletePages("acme", "shop");
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([`DELETE ${API}/pages`]);
  });

  it("counts a site already off (404) as deleted", async () => {
    const { client } = setup({
      [`DELETE ${API}/pages`]: { status: 404, body: { message: "Not Found" } },
    });
    await expect(client.deletePages("acme", "shop")).resolves.toBeUndefined();
  });
});

describe("pagesHealth", () => {
  const route = `GET ${API}/pages/health`;

  it("is pending while GitHub is still checking (202)", async () => {
    const { client } = setup({ [route]: { status: 202 } });
    expect(await client.pagesHealth("acme", "shop")).toEqual({
      certificate: "pending",
      dns: "pending",
    });
  });

  it("is pending while the domain does not resolve yet", async () => {
    const { client } = setup({
      [route]: { body: health({ dns_resolves: false, is_valid: false, is_https_eligible: false }) },
    });
    expect(await client.pagesHealth("acme", "shop")).toEqual({
      certificate: "pending",
      dns: "pending",
    });
  });

  it("is pending while GitHub's answer has no verdict on the domain", async () => {
    const { client } = setup({ [route]: { body: health({ is_valid: undefined }) } });
    expect(await client.pagesHealth("acme", "shop")).toEqual({
      certificate: "pending",
      dns: "pending",
    });
  });

  it("has the DNS right and the certificate pending", async () => {
    const { client } = setup({ [route]: { body: health({}) } });
    expect(await client.pagesHealth("acme", "shop")).toEqual({
      certificate: "pending",
      dns: "ok",
    });
  });

  it("has the certificate issued once the domain answers over HTTPS", async () => {
    const { client } = setup({ [route]: { body: health({ responds_to_https: true }) } });
    expect(await client.pagesHealth("acme", "shop")).toEqual({ certificate: "issued", dns: "ok" });
  });

  it("is an error when the domain does not point at GitHub Pages", async () => {
    const { client } = setup({
      [route]: { body: health({ is_valid: false, reason: "InvalidCNAMEError" }) },
    });
    expect(await client.pagesHealth("acme", "shop")).toEqual({
      certificate: "error",
      dns: "error",
    });
  });

  it("is an error when Cloudflare's proxy is in front of the domain", async () => {
    const { client } = setup({
      [route]: { body: health({ is_proxied: true, responds_to_https: true }) },
    });
    expect(await client.pagesHealth("acme", "shop")).toEqual({
      certificate: "error",
      dns: "error",
    });
  });

  it("has the certificate in error when GitHub cannot issue one (a CAA record)", async () => {
    const { client } = setup({
      [route]: { body: health({ is_https_eligible: false, caa_error: "not allowed" }) },
    });
    expect(await client.pagesHealth("acme", "shop")).toEqual({ certificate: "error", dns: "ok" });
  });

  it("is undefined when Pages is off (404)", async () => {
    const { client } = setup({ [route]: { status: 404, body: { message: "Not Found" } } });
    await expect(client.pagesHealth("acme", "shop")).resolves.toBeUndefined();
  });
});

describe("pagesRuns", () => {
  const route = `GET ${API}/actions/workflows/opscrew-pages.yml/runs`;
  const FILE = ".github/workflows/opscrew-pages.yml";

  /** A successful run as GitHub lists it. */
  function run(id: number, attempt: number, created: string, started: string, sha: string) {
    return {
      id,
      status: "completed",
      conclusion: "success",
      html_url: `https://github.com/acme/shop/actions/runs/${id}`,
      head_sha: sha,
      created_at: created,
      run_attempt: attempt,
      run_started_at: started,
    };
  }

  it("asks for the workflow's successful runs", async () => {
    const { client, calls } = setup({ [route]: { body: { total_count: 0, workflow_runs: [] } } });
    expect(await client.pagesRuns("acme", "shop", FILE)).toEqual([]);
    expect(calls[0]?.path).toBe(`${route.slice(4)}?per_page=100&status=success`);
  });

  it("puts the latest started first, so a re-run of an older run moves to the top", async () => {
    const newer = "b".repeat(40);
    const older = "a".repeat(40);
    const { client } = setup({
      [route]: {
        body: {
          total_count: 2,
          // GitHub lists by creation; the older run was re-run after the newer one.
          workflow_runs: [
            run(20, 1, "2026-10-23T13:55:00Z", "2026-10-23T13:55:10Z", newer),
            run(10, 2, "2026-10-23T13:40:00Z", "2026-10-23T13:56:13Z", older),
          ],
        },
      },
    });
    expect(await client.pagesRuns("acme", "shop", FILE)).toEqual([
      { runId: 10, attempt: 2, startedAt: "2026-10-23T13:56:13Z", headSha: older },
      { runId: 20, attempt: 1, startedAt: "2026-10-23T13:55:10Z", headSha: newer },
    ]);
  });

  it("refuses a run without its attempt", async () => {
    const { client } = setup({
      [route]: { body: { workflow_runs: [{ id: 1, head_sha: "a".repeat(40) }] } },
    });
    await failure(client.pagesRuns("acme", "shop", FILE));
  });
});

describe("rerunWorkflowRun", () => {
  it("re-runs the run", async () => {
    const { client, calls } = setup({ [`POST ${API}/actions/runs/4242/rerun`]: { status: 201 } });
    await client.rerunWorkflowRun("acme", "shop", 4242);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `POST ${API}/actions/runs/4242/rerun`,
    ]);
  });

  it("names the permission GitHub wants (403)", async () => {
    const { client } = setup({
      [`POST ${API}/actions/runs/4242/rerun`]: {
        status: 403,
        body: { message: "Resource not accessible by personal access token" },
        headers: { "x-accepted-github-permissions": "actions=write" },
      },
    });
    const error = await failure(client.rerunWorkflowRun("acme", "shop", 4242));
    expect(error.hint).toContain("Give the token Actions: Read and write on this repository");
  });

  it("says a run older than GitHub allows can no longer be re-run (403 naming no permission)", async () => {
    const said = "Unable to re-run this workflow run because it was created over a month ago";
    const { client } = setup({
      [`POST ${API}/actions/runs/4242/rerun`]: { status: 403, body: { message: said } },
    });
    const error = await failure(client.rerunWorkflowRun("acme", "shop", 4242));
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toContain("can no longer re-run workflow run 4242");
    expect(error.message).toContain(said);
    expect(error.hint).not.toContain("Secrets: Read and write");
  });
});

describe("pagesAllowed", () => {
  const repo = (isPrivate: boolean, type = "User", login = "acme") => ({
    [`GET ${API}`]: {
      body: { default_branch: "main", private: isPrivate, owner: { login, type } },
    },
  });

  it("is yes for a public repository, without reading any plan", async () => {
    const { client, calls } = setup(repo(false));
    expect(await client.pagesAllowed("acme", "shop")).toBe("yes");
    expect(calls).toHaveLength(1);
  });

  it("is no for a private repository on GitHub Free", async () => {
    const { client } = setup({
      ...repo(true),
      "GET /user": { body: { login: "acme", id: 1, plan: { name: "free" } } },
    });
    expect(await client.pagesAllowed("acme", "shop")).toBe("no");
  });

  it("is yes for a private repository on a paid plan", async () => {
    const { client } = setup({
      ...repo(true),
      "GET /user": { body: { login: "Acme", id: 1, plan: { name: "pro" } } },
    });
    expect(await client.pagesAllowed("acme", "shop")).toBe("yes");
  });

  it("is unknown when the token cannot read the plan", async () => {
    const { client } = setup({ ...repo(true), "GET /user": { body: { login: "acme", id: 1 } } });
    expect(await client.pagesAllowed("acme", "shop")).toBe("unknown");
  });

  it("is unknown for another user's private repository", async () => {
    const { client } = setup({
      ...repo(true),
      "GET /user": { body: { login: "octocat", id: 2, plan: { name: "pro" } } },
    });
    expect(await client.pagesAllowed("acme", "shop")).toBe("unknown");
  });

  it("reads an organization's plan where it shows", async () => {
    const team = setup({
      ...repo(true, "Organization"),
      "GET /orgs/acme": { body: { login: "acme", id: 3, plan: { name: "team" } } },
    });
    expect(await team.client.pagesAllowed("acme", "shop")).toBe("yes");
    const free = setup({
      ...repo(true, "Organization"),
      "GET /orgs/acme": { body: { login: "acme", id: 3, plan: { name: "free" } } },
    });
    expect(await free.client.pagesAllowed("acme", "shop")).toBe("no");
    const hidden = setup({
      ...repo(true, "Organization"),
      "GET /orgs/acme": { body: { login: "acme", id: 3 } },
    });
    expect(await hidden.client.pagesAllowed("acme", "shop")).toBe("unknown");
  });
});
