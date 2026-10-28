import { describe, expect, it, vi } from "vitest";
import { type ApiResult, GitHubRepo } from "./cloud";

const REPO = "owner/throwaway";
const BASE = `/repos/${REPO}`;
const WORKFLOW = `${BASE}/contents/.github/workflows/opscrew-check.yml`;

/**
 * A repository answering `answers` by `<METHOD> <path>` (anything else 404), with every call
 * recorded. Nothing reaches GitHub.
 */
function fakeRepo(answers: Record<string, ApiResult>) {
  const github = new GitHubRepo("not-a-token", REPO);
  const calls: { method: string; path: string; body: unknown }[] = [];
  vi.spyOn(github, "call").mockImplementation(async (method, path, body) => {
    calls.push({ method, path, body });
    return answers[`${method} ${path}`] ?? { status: 404, json: { message: "Not Found" } };
  });
  return { github, calls };
}

const ok = (json: unknown, status = 200): ApiResult => ({ status, json });

describe("GitHubRepo.resetCheck", () => {
  it("removes only the check's leftovers, every call under the repository", async () => {
    const { github, calls } = fakeRepo({
      [`GET ${BASE}/actions/workflows/opscrew-check.yml/runs?status=queued&per_page=100`]: ok({
        workflow_runs: [{ id: 7 }],
      }),
      [`GET ${WORKFLOW}?ref=main`]: ok({ sha: "abc123" }),
      [`DELETE ${WORKFLOW}`]: ok({}),
      [`GET ${BASE}/issues?labels=opscrew-check&state=open&per_page=100`]: ok([{ number: 3 }]),
      [`PATCH ${BASE}/issues/3`]: ok({}),
      [`DELETE ${BASE}/labels/opscrew-check`]: ok(undefined, 204),
      [`DELETE ${BASE}/actions/variables/OPSCREW_CHECK_PAUSED`]: ok(undefined, 204),
      [`GET ${BASE}/actions/secrets?per_page=100`]: ok({
        secrets: [
          { name: "OPSCREW_CHECK_SSH_KEY" },
          { name: "OPSCREW_CHECK_SERVER" },
          { name: "OPSCREW_STAGING_CHECK_SERVER" },
          { name: "OPSCREW_DEPLOY_SSH_KEY" },
        ],
      }),
      [`DELETE ${BASE}/actions/secrets/OPSCREW_CHECK_SSH_KEY`]: ok(undefined, 204),
      [`DELETE ${BASE}/actions/secrets/OPSCREW_CHECK_SERVER`]: ok(undefined, 204),
      [`DELETE ${BASE}/actions/secrets/OPSCREW_STAGING_CHECK_SERVER`]: ok(undefined, 204),
    });
    expect(await github.resetCheck()).toEqual([]);
    for (const { path } of calls) expect(path.startsWith(`${BASE}/`), path).toBe(true);
    const done = calls.filter(({ method }) => method !== "GET");
    expect(done.map(({ method, path }) => `${method} ${path}`)).toEqual([
      `POST ${BASE}/actions/runs/7/cancel`,
      `DELETE ${WORKFLOW}`,
      `PATCH ${BASE}/issues/3`,
      `DELETE ${BASE}/labels/opscrew-check`,
      `DELETE ${BASE}/actions/variables/OPSCREW_CHECK_PAUSED`,
      `DELETE ${BASE}/actions/secrets/OPSCREW_CHECK_SSH_KEY`,
      `DELETE ${BASE}/actions/secrets/OPSCREW_CHECK_SERVER`,
      `DELETE ${BASE}/actions/secrets/OPSCREW_STAGING_CHECK_SERVER`,
    ]);
    expect(done.find(({ method }) => method === "DELETE")?.body).toMatchObject({
      sha: "abc123",
      branch: "main",
    });
    expect(done.find(({ method }) => method === "PATCH")?.body).toEqual({
      state: "closed",
      state_reason: "not_planned",
    });
  });

  it("counts 404 as gone, and names what GitHub kept", async () => {
    const { github, calls } = fakeRepo({
      [`GET ${BASE}/issues?labels=opscrew-check&state=open&per_page=100`]: ok([]),
      [`DELETE ${BASE}/actions/variables/OPSCREW_CHECK_PAUSED`]: ok({}, 403),
      [`GET ${BASE}/actions/secrets?per_page=100`]: ok({
        secrets: [{ name: "OPSCREW_CHECK_WEBHOOK" }],
      }),
      [`DELETE ${BASE}/actions/secrets/OPSCREW_CHECK_WEBHOOK`]: ok({}, 500),
    });
    expect(await github.resetCheck()).toEqual([
      "the variable OPSCREW_CHECK_PAUSED (HTTP 403)",
      "the secret OPSCREW_CHECK_WEBHOOK (HTTP 500)",
    ]);
    // No workflow on main (404): nothing deleted there.
    expect(calls.some(({ method, path }) => method === "DELETE" && path === WORKFLOW)).toBe(false);
  });

  it("deletes the workflow only when main has it with its sha", async () => {
    const { github, calls } = fakeRepo({
      [`GET ${WORKFLOW}?ref=main`]: ok({}),
      [`GET ${BASE}/issues?labels=opscrew-check&state=open&per_page=100`]: ok([]),
      [`GET ${BASE}/actions/secrets?per_page=100`]: ok({ secrets: [] }),
    });
    expect(await github.resetCheck()).toEqual([]);
    expect(calls.some(({ method, path }) => method === "DELETE" && path === WORKFLOW)).toBe(false);
  });

  it("names the issues it could not read instead of failing on GitHub's answer", async () => {
    const { github } = fakeRepo({
      [`GET ${BASE}/issues?labels=opscrew-check&state=open&per_page=100`]: ok(
        { message: "Resource not accessible" },
        403,
      ),
      [`GET ${BASE}/actions/secrets?per_page=100`]: ok({ secrets: [] }),
    });
    expect(await github.resetCheck()).toEqual(["the opscrew-check issues unread (HTTP 403)"]);
  });
});
