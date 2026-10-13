import type { FetchLike } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { GitHubClient } from "./index";

const TOKEN = fakeSecret("github-token");
const FILE = ".github/workflows/opscrew-deploy.yml";
const RUNS = "GET /repos/acme/shop/actions/workflows/opscrew-deploy.yml/runs";

type Reply = { status?: number; body?: unknown };
type Call = { method: string; url: string; body?: unknown };

/** Routes by method + path prefix; each route serves its replies in order, repeating the last. */
function fakeFetch(routes: Record<string, Reply[]>) {
  const calls: Call[] = [];
  const served: Record<string, number> = {};
  const fetch: FetchLike = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ method, url, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    const path = url.replace("https://api.github.com", "");
    const key = Object.keys(routes).find((k) => `${method} ${path}`.startsWith(k));
    if (!key) throw new Error(`unrouted ${method} ${path}`);
    const replies = routes[key] as Reply[];
    const index = Math.min(served[key] ?? 0, replies.length - 1);
    served[key] = (served[key] ?? 0) + 1;
    const reply = replies[index] as Reply;
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
      status: reply.status ?? 200,
    });
  };
  return { fetch, calls };
}

function fakeClock() {
  let t = 1_000_000;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
  };
}

function run(id: number, status: string, conclusion: string | null, createdAt: string) {
  return {
    id,
    status,
    conclusion,
    html_url: `https://github.com/acme/shop/actions/runs/${id}`,
    head_sha: "abc",
    created_at: createdAt,
  };
}

function client(fetch: FetchLike, clock = fakeClock()) {
  return new GitHubClient({ token: TOKEN, fetch, sleep: clock.sleep, now: clock.now });
}

describe("dispatchWorkflow", () => {
  it("returns the run id from a 200 answer", async () => {
    const { fetch, calls } = fakeFetch({
      "POST /repos/acme/shop/actions/workflows/opscrew-deploy.yml/dispatches": [
        { status: 200, body: { workflow_run_id: 42, run_url: "x", html_url: "y" } },
      ],
    });
    expect(await client(fetch).dispatchWorkflow("acme", "shop", FILE, "main")).toEqual({
      runId: 42,
    });
    expect(calls[0]).toMatchObject({ method: "POST", body: { ref: "main" } });
  });

  it("returns no id for a 204 answer", async () => {
    const { fetch } = fakeFetch({
      "POST /repos/acme/shop/actions/workflows/opscrew-deploy.yml/dispatches": [{ status: 204 }],
    });
    expect(await client(fetch).dispatchWorkflow("acme", "shop", FILE, "main")).toEqual({});
  });

  it("reports failures plainly without the token", async () => {
    const { fetch } = fakeFetch({
      "POST /repos/acme/shop/actions/workflows/opscrew-deploy.yml/dispatches": [
        { status: 422, body: { message: "Workflow does not have 'workflow_dispatch' trigger" } },
      ],
    });
    const error = await client(fetch)
      .dispatchWorkflow("acme", "shop", FILE, "main")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpsCrewError);
    expect(error).toMatchObject({ code: "PROVIDER_ERROR" });
    expect((error as Error).message).toContain("workflow_dispatch");
    expect(JSON.stringify(error)).not.toContain(TOKEN);
    expect(String((error as Error).message)).not.toContain(TOKEN);
  });
});

describe("getWorkflowRun and listWorkflowRuns", () => {
  it("reads one run", async () => {
    const { fetch, calls } = fakeFetch({
      "GET /repos/acme/shop/actions/runs/7": [
        { body: run(7, "in_progress", null, "2026-10-13T10:00:00Z") },
      ],
    });
    expect(await client(fetch).getWorkflowRun("acme", "shop", 7)).toEqual({
      id: 7,
      status: "in_progress",
      conclusion: null,
      htmlUrl: "https://github.com/acme/shop/actions/runs/7",
      headSha: "abc",
      createdAt: "2026-10-13T10:00:00Z",
    });
    expect(calls[0]?.url).toBe("https://api.github.com/repos/acme/shop/actions/runs/7");
  });

  it("filters by event and creation time", async () => {
    const { fetch, calls } = fakeFetch({ [RUNS]: [{ body: { workflow_runs: [] } }] });
    await client(fetch).listWorkflowRuns("acme", "shop", {
      workflowFile: FILE,
      branch: "main",
      event: "workflow_dispatch",
      createdSince: "2026-10-13T10:00:00Z",
    });
    const query = new URL(calls[0]?.url ?? "").searchParams;
    expect(query.get("event")).toBe("workflow_dispatch");
    expect(query.get("created")).toBe(">=2026-10-13T10:00:00Z");
    expect(query.get("branch")).toBe("main");
  });

  it("keeps the old call shape without filters", async () => {
    const { fetch, calls } = fakeFetch({ [RUNS]: [{ body: { workflow_runs: [] } }] });
    await client(fetch).listWorkflowRuns("acme", "shop", { workflowFile: FILE });
    const query = new URL(calls[0]?.url ?? "").searchParams;
    expect(query.has("event")).toBe(false);
    expect(query.has("created")).toBe(false);
  });
});

describe("waitForWorkflowRun", () => {
  const since = "2026-10-13T10:00:00.250Z";

  for (const conclusion of ["success", "failure", "cancelled"]) {
    it(`waits by id through queued and in_progress to ${conclusion}`, async () => {
      const clock = fakeClock();
      const { fetch, calls } = fakeFetch({
        "GET /repos/acme/shop/actions/runs/42": [
          { body: run(42, "queued", null, "2026-10-13T10:00:01Z") },
          { body: run(42, "in_progress", null, "2026-10-13T10:00:01Z") },
          { body: run(42, "completed", conclusion, "2026-10-13T10:00:01Z") },
        ],
      });
      const result = await client(fetch, clock).waitForWorkflowRun("acme", "shop", {
        workflowFile: FILE,
        ref: "main",
        runId: 42,
        since,
        pollMs: 1000,
      });
      expect(result).toEqual({
        id: 42,
        conclusion,
        htmlUrl: "https://github.com/acme/shop/actions/runs/42",
      });
      expect(calls).toHaveLength(3);
      expect(clock.sleeps).toEqual([1000, 1000]);
    });
  }

  it("finds the newest dispatch run since the dispatch when there is no id", async () => {
    const clock = fakeClock();
    const { fetch, calls } = fakeFetch({
      [RUNS]: [
        { body: { workflow_runs: [] } },
        {
          body: {
            workflow_runs: [
              run(9, "completed", "success", "2026-10-13T09:59:59Z"),
              run(10, "queued", null, "2026-10-13T10:00:00Z"),
            ],
          },
        },
      ],
      "GET /repos/acme/shop/actions/runs/10": [
        { body: run(10, "completed", "success", "2026-10-13T10:00:00Z") },
      ],
    });
    const result = await client(fetch, clock).waitForWorkflowRun("acme", "shop", {
      workflowFile: FILE,
      ref: "refs/heads/main",
      since,
      pollMs: 2000,
    });
    expect(result).toMatchObject({ id: 10, conclusion: "success" });
    const query = new URL(calls[0]?.url ?? "").searchParams;
    expect(query.get("event")).toBe("workflow_dispatch");
    expect(query.get("branch")).toBe("main");
    // Two minutes of allowance for a local clock ahead of GitHub's.
    expect(query.get("created")).toBe(">=2026-10-13T09:58:00Z");
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual([
      "/repos/acme/shop/actions/workflows/opscrew-deploy.yml/runs",
      "/repos/acme/shop/actions/workflows/opscrew-deploy.yml/runs",
      "/repos/acme/shop/actions/runs/10",
    ]);
  });

  it("finds the run when the local clock is ahead of GitHub's (up to two minutes)", async () => {
    const clock = fakeClock();
    // This computer said 10:01:30 before the dispatch; GitHub stamped the run 10:00:05.
    const { fetch } = fakeFetch({
      [RUNS]: [
        {
          body: {
            workflow_runs: [
              run(20, "completed", "success", "2026-10-13T09:59:00Z"),
              run(21, "completed", "failure", "2026-10-13T10:00:05Z"),
            ],
          },
        },
      ],
    });
    const result = await client(fetch, clock).waitForWorkflowRun("acme", "shop", {
      workflowFile: FILE,
      ref: "main",
      since: "2026-10-13T10:01:30.000Z",
      pollMs: 1000,
    });
    // The newest run is the dispatched one, even though it looks older than `since`.
    expect(result).toMatchObject({ id: 21, conclusion: "failure" });
    expect(clock.sleeps).toEqual([]);
  });

  it("times out with the run link when the run is known", async () => {
    const clock = fakeClock();
    const { fetch } = fakeFetch({
      "GET /repos/acme/shop/actions/runs/42": [
        { body: run(42, "in_progress", null, "2026-10-13T10:00:01Z") },
      ],
    });
    const error = await client(fetch, clock)
      .waitForWorkflowRun("acme", "shop", {
        workflowFile: FILE,
        ref: "main",
        runId: 42,
        since,
        timeoutMs: 120_000,
        pollMs: 10_000,
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpsCrewError);
    expect(error).toMatchObject({
      code: "PROVIDER_ERROR",
      hint: expect.stringContaining("https://github.com/acme/shop/actions/runs/42"),
    });
    expect((error as Error).message).toContain("2 minutes");
    expect(JSON.stringify(error)).not.toContain(TOKEN);
    expect(clock.sleeps.reduce((a, b) => a + b, 0)).toBe(120_000);
  });

  it("times out plainly when the run never appears", async () => {
    const clock = fakeClock();
    const { fetch } = fakeFetch({ [RUNS]: [{ body: { workflow_runs: [] } }] });
    const error = await client(fetch, clock)
      .waitForWorkflowRun("acme", "shop", {
        workflowFile: FILE,
        ref: "main",
        since,
        timeoutMs: 60_000,
        pollMs: 5_000,
      })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: "PROVIDER_ERROR",
      message: expect.stringContaining("did not show a run"),
      hint: expect.stringContaining("https://github.com/acme/shop"),
    });
    expect(JSON.stringify(error)).not.toContain(TOKEN);
  });
});
