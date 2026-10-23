import type { FetchLike } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { fakeFetch as coreFakeFetch, type FakeReply, fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { GITHUB_API } from "./github";
import { GitHubClient } from "./index";

const TOKEN = fakeSecret("github-token");
const FILE = ".github/workflows/opscrew-deploy.yml";
const RUNS = "GET /repos/acme/shop/actions/workflows/opscrew-deploy.yml/runs";

/** Routes by method + path prefix; each route serves its replies in order, repeating the last. */
const fakeFetch = (routes: Record<string, FakeReply[]>) =>
  coreFakeFetch(routes, { base: GITHUB_API });

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
  const DISPATCH = "POST /repos/acme/shop/actions/workflows/opscrew-deploy.yml/dispatches";
  /** GitHub's 204 to a dispatch, stamped with GitHub's own clock. */
  const accepted: FakeReply = { status: 204, headers: { date: "Thu, 22 Oct 2026 10:00:00 GMT" } };

  it("returns the run from a 200 answer", async () => {
    const { fetch, calls } = fakeFetch({
      [DISPATCH]: [
        {
          status: 200,
          body: {
            workflow_run_id: 42,
            run_url: "x",
            html_url: "https://github.com/acme/shop/actions/runs/42",
          },
        },
      ],
    });
    const order: string[] = [];
    expect(
      await client(fetch).dispatchWorkflow(
        "acme",
        "shop",
        FILE,
        "main",
        { digest: "sha256:a" },
        async () => {
          order.push(`accepted after ${calls.length} call`);
        },
      ),
    ).toEqual({ runId: 42, url: "https://github.com/acme/shop/actions/runs/42" });
    // The run GitHub named is taken as it is: no list of runs is read.
    expect(calls).toHaveLength(1);
    expect(order).toEqual(["accepted after 1 call"]);
    // Only the body fields GitHub documents for "Create a workflow dispatch event".
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body).toEqual({ ref: "main", inputs: { digest: "sha256:a" } });
  });

  it("refuses a 200 answer that names no run", async () => {
    const { fetch } = fakeFetch({ [DISPATCH]: [{ status: 200, body: { run_url: "x" } }] });
    const error = await client(fetch)
      .dispatchWorkflow("acme", "shop", FILE, "main")
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "PROVIDER_ERROR" });
  });

  it("records the accepted dispatch before it waits for the run", async () => {
    const clock = fakeClock();
    const { fetch, calls } = fakeFetch({
      [DISPATCH]: [accepted],
      [RUNS]: [{ body: { workflow_runs: [] } }],
    });
    let callsWhenAccepted = -1;
    await client(fetch, clock)
      .dispatchWorkflow("acme", "shop", FILE, "main", {}, async () => {
        callsWhenAccepted = calls.length;
      })
      .catch(() => undefined);
    expect(callsWhenAccepted).toBe(1);
    expect(calls.length).toBeGreaterThan(1);
  });

  it("calls nothing back when GitHub refuses the dispatch", async () => {
    const { fetch } = fakeFetch({ [DISPATCH]: [{ status: 422, body: { message: "No ref" } }] });
    let called = false;
    await client(fetch)
      .dispatchWorkflow("acme", "shop", FILE, "main", {}, async () => {
        called = true;
      })
      .catch(() => undefined);
    expect(called).toBe(false);
  });

  it("finds the run it started after a 204, once GitHub shows it", async () => {
    const clock = fakeClock();
    const { fetch, calls } = fakeFetch({
      [DISPATCH]: [accepted],
      [RUNS]: [
        // An earlier dispatch is not this one; the new run appears on the third poll.
        { body: { workflow_runs: [run(9, "completed", "success", "2026-10-22T09:59:30Z")] } },
        { body: { workflow_runs: [run(9, "completed", "success", "2026-10-22T09:59:30Z")] } },
        {
          body: {
            workflow_runs: [
              run(10, "queued", null, "2026-10-22T10:00:07Z"),
              run(9, "completed", "success", "2026-10-22T09:59:30Z"),
            ],
          },
        },
      ],
    });
    expect(
      await client(fetch, clock).dispatchWorkflow("acme", "shop", FILE, "refs/heads/main"),
    ).toEqual({ runId: 10, url: "https://github.com/acme/shop/actions/runs/10" });
    expect(calls[0]?.body).toEqual({ ref: "refs/heads/main", inputs: {} });
    const query = new URL(calls[1]?.url ?? "").searchParams;
    expect(query.get("event")).toBe("workflow_dispatch");
    expect(query.get("branch")).toBe("main");
    // GitHub's clock, from the dispatch's answer, less a second of rounding.
    expect(query.get("created")).toBe(">=2026-10-22T09:59:59Z");
    expect(calls).toHaveLength(4);
    expect(clock.sleeps).toEqual([5000, 5000]);
  });

  it("takes the first run after the dispatch, not a later one", async () => {
    const { fetch } = fakeFetch({
      [DISPATCH]: [accepted],
      [RUNS]: [
        {
          body: {
            workflow_runs: [
              run(12, "queued", null, "2026-10-22T10:00:20Z"),
              run(11, "queued", null, "2026-10-22T10:00:06Z"),
            ],
          },
        },
      ],
    });
    expect(await client(fetch).dispatchWorkflow("acme", "shop", FILE, "main")).toMatchObject({
      runId: 11,
    });
  });

  it("says where to look when the run never appears", async () => {
    const clock = fakeClock();
    const { fetch } = fakeFetch({
      [DISPATCH]: [accepted],
      [RUNS]: [{ body: { workflow_runs: [] } }],
    });
    const error = await client(fetch, clock)
      .dispatchWorkflow("acme", "shop", FILE, "main")
      .catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: "PROVIDER_ERROR",
      message:
        "GitHub accepted the dispatch of .github/workflows/opscrew-deploy.yml on main but showed no run of it within 2 minutes; look in https://github.com/acme/shop/actions.",
    });
    expect(JSON.stringify(error)).not.toContain(TOKEN);
    expect(clock.sleeps.reduce((a, b) => a + b, 0)).toBe(120_000);
  });

  it("reports failures plainly without the token", async () => {
    const { fetch, calls } = fakeFetch({
      [DISPATCH]: [{ status: 500, body: { message: "Server Error" } }],
    });
    const error = await client(fetch)
      .dispatchWorkflow("acme", "shop", FILE, "main")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpsCrewError);
    expect(error).toMatchObject({ code: "PROVIDER_ERROR" });
    expect((error as Error).message).toContain("Server Error");
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(error)).not.toContain(TOKEN);
    expect(String((error as Error).message)).not.toContain(TOKEN);
  });

  it("is a precondition when GitHub has no such workflow or no dispatch trigger for it", async () => {
    for (const [status, message] of [
      [404, "Not Found"],
      [422, "Workflow does not have 'workflow_dispatch' trigger"],
    ] as const) {
      const { fetch } = fakeFetch({ [DISPATCH]: [{ status, body: { message } }] });
      const error = await client(fetch)
        .dispatchWorkflow("acme", "shop", FILE, "main", { digest: "sha256:a" })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(OpsCrewError);
      expect(error).toMatchObject({ code: "PHASE_PRECONDITION" });
      expect((error as OpsCrewError).message).toContain(message);
      expect((error as OpsCrewError).hint).toContain("default branch");
      expect(JSON.stringify(error)).not.toContain(TOKEN);
    }
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
        pollMs: 1000,
      });
      expect(result).toEqual({
        id: 42,
        status: "completed",
        conclusion,
        htmlUrl: "https://github.com/acme/shop/actions/runs/42",
      });
      expect(calls).toHaveLength(3);
      expect(clock.sleeps).toEqual([1000, 1000]);
    });
  }
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

  it("reports once that the run waits for a reviewer, then follows it to its end", async () => {
    const clock = fakeClock();
    const { fetch } = fakeFetch({
      "GET /repos/acme/shop/actions/runs/42": [
        { body: run(42, "queued", null, "2026-10-13T10:00:01Z") },
        { body: run(42, "waiting", null, "2026-10-13T10:00:01Z") },
        { body: run(42, "waiting", null, "2026-10-13T10:00:01Z") },
        { body: run(42, "in_progress", null, "2026-10-13T10:00:01Z") },
        { body: run(42, "completed", "success", "2026-10-13T10:00:01Z") },
      ],
    });
    const waiting: string[] = [];
    const result = await client(fetch, clock).waitForWorkflowRun("acme", "shop", {
      workflowFile: FILE,
      ref: "main",
      runId: 42,
      pollMs: 1000,
      onWaiting: (url) => {
        waiting.push(url);
      },
    });
    expect(waiting).toEqual(["https://github.com/acme/shop/actions/runs/42"]);
    expect(result).toEqual({
      id: 42,
      status: "completed",
      conclusion: "success",
      htmlUrl: "https://github.com/acme/shop/actions/runs/42",
    });
  });

  it("returns a run still waiting for its reviewer when the time is up, not a timeout", async () => {
    const clock = fakeClock();
    const { fetch } = fakeFetch({
      "GET /repos/acme/shop/actions/runs/42": [
        { body: run(42, "waiting", null, "2026-10-13T10:00:01Z") },
      ],
    });
    const result = await client(fetch, clock).waitForWorkflowRun("acme", "shop", {
      workflowFile: FILE,
      ref: "main",
      runId: 42,
      timeoutMs: 60_000,
      pollMs: 10_000,
      onWaiting: () => undefined,
    });
    expect(result).toEqual({
      id: 42,
      status: "waiting",
      conclusion: null,
      htmlUrl: "https://github.com/acme/shop/actions/runs/42",
    });
    expect(clock.sleeps.reduce((a, b) => a + b, 0)).toBe(60_000);
  });

  it("gives a run its whole time again once its review is done", async () => {
    const clock = fakeClock();
    // 50 s waiting for the reviewer, then 50 s running: past the 60 s from the start.
    const { fetch } = fakeFetch({
      "GET /repos/acme/shop/actions/runs/42": [
        ...Array.from({ length: 5 }, () => ({
          body: run(42, "waiting", null, "2026-10-13T10:00:01Z"),
        })),
        ...Array.from({ length: 5 }, () => ({
          body: run(42, "in_progress", null, "2026-10-13T10:00:01Z"),
        })),
        { body: run(42, "completed", "success", "2026-10-13T10:00:01Z") },
      ],
    });
    const result = await client(fetch, clock).waitForWorkflowRun("acme", "shop", {
      workflowFile: FILE,
      ref: "main",
      runId: 42,
      timeoutMs: 60_000,
      pollMs: 10_000,
      onWaiting: () => undefined,
    });
    expect(result).toMatchObject({ status: "completed", conclusion: "success" });
    expect(clock.sleeps.reduce((a, b) => a + b, 0)).toBe(100_000);
  });

  it("times out on a waiting run when the caller does not follow reviews", async () => {
    const clock = fakeClock();
    const { fetch } = fakeFetch({
      "GET /repos/acme/shop/actions/runs/42": [
        { body: run(42, "waiting", null, "2026-10-13T10:00:01Z") },
      ],
    });
    await expect(
      client(fetch, clock).waitForWorkflowRun("acme", "shop", {
        workflowFile: FILE,
        ref: "main",
        runId: 42,
        timeoutMs: 60_000,
        pollMs: 10_000,
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
  });
});
