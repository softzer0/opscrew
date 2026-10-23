import type { FetchLike } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { fakeFetch as coreFakeFetch, type FakeReply, fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { GITHUB_API } from "./github";
import { GitHubClient } from "./index";

const TOKEN = fakeSecret("github-token");
const FILE = ".github/workflows/opscrew-deploy.yml";

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

  it("asks for the run's details and returns the run from GitHub's 200 answer", async () => {
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
    expect(calls[0]?.body).toEqual({
      ref: "main",
      inputs: { digest: "sha256:a" },
      return_run_details: true,
    });
  });

  it("refuses a 200 answer that names no run", async () => {
    const { fetch } = fakeFetch({ [DISPATCH]: [{ status: 200, body: { run_url: "x" } }] });
    const error = await client(fetch)
      .dispatchWorkflow("acme", "shop", FILE, "main")
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "PROVIDER_ERROR" });
  });

  it("stops plainly on a 204, which names no run, after recording the accepted dispatch", async () => {
    const { fetch, calls } = fakeFetch({ [DISPATCH]: [{ status: 204 }] });
    let accepted = false;
    const error = await client(fetch)
      .dispatchWorkflow("acme", "shop", FILE, "refs/heads/main", {}, async () => {
        accepted = true;
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpsCrewError);
    expect(error).toMatchObject({
      code: "PROVIDER_ERROR",
      message:
        "GitHub started .github/workflows/opscrew-deploy.yml on main but did not say which run it is, so OpsCrew cannot follow it; look in https://github.com/acme/shop/actions.",
    });
    expect(JSON.stringify(error)).not.toContain(TOKEN);
    // GitHub accepted it, and no list of runs is read.
    expect(accepted).toBe(true);
    expect(calls).toHaveLength(1);
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

describe("getWorkflowRun", () => {
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
