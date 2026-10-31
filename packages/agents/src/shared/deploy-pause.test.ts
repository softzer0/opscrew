import { OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { DEPLOY_PAUSED_VARIABLE } from "@opscrew/iac-templates";
import { describe, expect, it } from "vitest";
import { createTestPhaseDeps, FakeGitHub, testPlan } from "../testing";
import {
  clearDeployPause,
  type DeployPause,
  deployPauseOf,
  pinnedText,
  restoreDeployPause,
  runningDeploy,
  setDeployPause,
} from "./deploy-pause";

const SINCE = "2026-10-11T12:00:00.000Z";
/** Generated hex, not a real registry's digest or commit. */
const IMAGE = `sha256:${"ab".repeat(32)}`;
const COMMIT = "c0ffee".repeat(6).slice(0, 40);
const FROM = "beef".repeat(10);

const ROLLBACK: DeployPause = {
  reason: "rollback",
  since: SINCE,
  image: IMAGE,
  commit: COMMIT,
  from: FROM,
};
/** Another environment's move entry, as OpsCrew wrote it, and one with its keys the other way. */
const STAGING = '"shop/staging":{"reason":"move","since":"2026-10-11T10:00:00.000Z"}';
const BLOG = '"blog/prod":{"since":"2026-10-11T09:00:00.000Z","reason":"move"}';

async function world(variable?: string) {
  const deps = await createTestPhaseDeps();
  const fake = new FakeGitHub();
  if (variable !== undefined) fake.variables.set(DEPLOY_PAUSED_VARIABLE, variable);
  const github = { api: fake, owner: "acme", repo: "shop" };
  const plan = testPlan();
  const variableNow = () => fake.variables.get(DEPLOY_PAUSED_VARIABLE);
  const actions = () => deps.audit.entries.map((entry) => entry.action);
  return { deps, fake, github, plan, variableNow, actions };
}

describe("the deploy pause", () => {
  it("writes a move's entry exactly as 018 does, and audits it under provision", async () => {
    const w = await world();
    const replaced = await setDeployPause(w.deps, w.github, w.plan, {
      reason: "move",
      since: SINCE,
    });
    expect(replaced).toBeUndefined();
    expect(w.variableNow()).toBe(`{"shop/prod":{"reason":"move","since":"${SINCE}"}}`);
    expect(w.deps.audit.entries).toEqual([
      expect.objectContaining({
        kind: "provider-call",
        action: "pause the deploys of shop/prod",
        phase: "provision",
        target: "acme/shop",
        decision: "approved",
      }),
    ]);
  });

  it("writes a rollback's entry with its image, commit and from, and reads it back", async () => {
    const w = await world();
    await setDeployPause(w.deps, w.github, w.plan, ROLLBACK);
    expect(JSON.parse(w.variableNow() ?? "")).toEqual({ "shop/prod": ROLLBACK });
    expect(await deployPauseOf(w.github, w.plan)).toEqual(ROLLBACK);
    const [entry] = w.deps.audit.entries;
    expect(entry?.action).toBe("pause the deploys of shop/prod");
    expect(entry?.phase).toBeUndefined();
    expect(entry?.detail).toBe(`pinned to ${COMMIT} (${IMAGE})`);
  });

  it("keeps other environments' entries byte for byte", async () => {
    const w = await world(`{${STAGING},${BLOG}}`);
    await setDeployPause(w.deps, w.github, w.plan, ROLLBACK);
    const text = w.variableNow() ?? "";
    expect(text).toContain(STAGING);
    expect(text).toContain(BLOG);
    await clearDeployPause(w.deps, w.github, w.plan, "rollback");
    expect(w.variableNow()).toBe(`{${STAGING},${BLOG}}`);
  });

  it("returns the entry it replaced, and restoring it puts the variable back as it was", async () => {
    const before = `{${STAGING},"shop/prod":{"reason":"move","since":"${SINCE}"}}`;
    const w = await world(before);
    const replaced = await setDeployPause(w.deps, w.github, w.plan, ROLLBACK);
    expect(replaced).toEqual({ reason: "move", since: SINCE });
    await restoreDeployPause(w.deps, w.github, w.plan, replaced);
    expect(w.variableNow()).toBe(before);
  });

  it("restoring no entry removes the key, and deletes the variable once it is empty", async () => {
    const w = await world();
    const replaced = await setDeployPause(w.deps, w.github, w.plan, ROLLBACK);
    await restoreDeployPause(w.deps, w.github, w.plan, replaced);
    expect(w.fake.variables.has(DEPLOY_PAUSED_VARIABLE)).toBe(false);
    expect(w.actions()).toEqual([
      "pause the deploys of shop/prod",
      "resume the deploys of shop/prod",
    ]);
  });

  it("restoring no entry when there is none changes nothing", async () => {
    const w = await world(`{${STAGING}}`);
    await restoreDeployPause(w.deps, w.github, w.plan, undefined);
    expect(w.variableNow()).toBe(`{${STAGING}}`);
    expect(w.actions()).toEqual([]);
  });

  it("clears only an entry of the reason it is given", async () => {
    const w = await world();
    await setDeployPause(w.deps, w.github, w.plan, ROLLBACK);
    expect(await clearDeployPause(w.deps, w.github, w.plan, "move")).toBe(false);
    expect(await deployPauseOf(w.github, w.plan)).toEqual(ROLLBACK);
    expect(await clearDeployPause(w.deps, w.github, w.plan, "rollback")).toBe(true);
    expect(w.fake.variables.has(DEPLOY_PAUSED_VARIABLE)).toBe(false);
    expect(await clearDeployPause(w.deps, w.github, w.plan, "rollback")).toBe(false);
    expect(w.actions()).toEqual([
      "pause the deploys of shop/prod",
      "resume the deploys of shop/prod",
    ]);
  });

  it("reads no entry when the variable or the key is not there", async () => {
    expect(await deployPauseOf((await world()).github, testPlan())).toBeUndefined();
    expect(await deployPauseOf((await world(`{${STAGING}}`)).github, testPlan())).toBeUndefined();
  });

  it.each([
    ["not JSON", "paused"],
    ["an entry without since", '{"shop/staging":{"reason":"move"}}'],
    [
      "its own entry of a reason OpsCrew doesn't write",
      '{"shop/prod":{"reason":"e2e","since":"x"}}',
    ],
    ["a rollback entry without its image", `{"shop/prod":{"reason":"rollback","since":"x"}}`],
  ])("stops with today's hint, changing nothing, on a variable that is %s", async (_what, text) => {
    const w = await world(text);
    for (const call of [
      () => deployPauseOf(w.github, w.plan),
      () => setDeployPause(w.deps, w.github, w.plan, ROLLBACK),
      () => clearDeployPause(w.deps, w.github, w.plan, "move"),
    ]) {
      const error = await call().catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(OpsCrewError);
      expect(error).toMatchObject({
        code: "INVALID_INPUT",
        message: `The repository variable ${DEPLOY_PAUSED_VARIABLE} of acme/shop is not the JSON OpsCrew writes, so OpsCrew changed nothing.`,
        hint: "Delete the variable in the repository's Settings → Secrets and variables → Actions → Variables (it only pauses OpsCrew's deploys), then run `opscrew provision` again.",
      });
    }
    expect(w.variableNow()).toBe(text);
    expect(w.actions()).toEqual([]);
  });

  it("tolerates another environment's entry of a reason it doesn't know", async () => {
    const other = '"shop/staging":{"reason":"e2e","since":"2026-10-11T10:00:00.000Z"}';
    const w = await world(`{${other}}`);
    await setDeployPause(w.deps, w.github, w.plan, ROLLBACK);
    expect(w.variableNow()).toContain(other);
  });

  it("holds no secret: only the reason, the times, the digest and the commits", async () => {
    const token = fakeSecret("github-token");
    const w = await world();
    w.deps.redactor.addLiteral(token, "GITHUB_TOKEN");
    await setDeployPause(w.deps, w.github, w.plan, ROLLBACK);
    const shown = `${w.variableNow()}${JSON.stringify(w.deps.audit.entries)}`;
    expect(shown).not.toContain(token);
    expect(Object.keys(JSON.parse(w.variableNow() ?? "")["shop/prod"]).sort()).toEqual([
      "commit",
      "from",
      "image",
      "reason",
      "since",
    ]);
  });
});

describe("pinnedText", () => {
  it("shortens an image digest, and shows a site's version whole", () => {
    const pinned = { reason: "rollback", since: SINCE, commit: COMMIT } as const;
    expect(pinnedText({ ...pinned, image: IMAGE })).toBe(
      "`opscrew rollback` pinned it to c0ffeec (sha256:abababababab)",
    );
    expect(pinnedText({ ...pinned, image: "cccccccc-3333-4333-8333-333333333333" })).toBe(
      "`opscrew rollback` pinned it to c0ffeec (cccccccc-3333-4333-8333-333333333333)",
    );
    expect(pinnedText({ ...pinned, image: "12345678901" })).toBe(
      "`opscrew rollback` pinned it to c0ffeec (12345678901)",
    );
  });
});

describe("runningDeploy", () => {
  const run = (id: number, status: string) => ({
    id,
    status,
    conclusion: null,
    htmlUrl: `https://github.com/acme/shop/actions/runs/${id}`,
    headSha: "a".repeat(40),
    createdAt: "2026-10-11T11:55:00Z",
  });

  it("names a run of the environment's deploy workflow that is queued or in progress", async () => {
    const w = await world();
    w.fake.workflowRuns = [run(43, "completed"), run(42, "in_progress")];
    expect(await runningDeploy(w.github, w.plan)).toEqual({
      url: "https://github.com/acme/shop/actions/runs/42",
    });
    w.fake.workflowRuns = [run(43, "completed")];
    expect(await runningDeploy(w.github, w.plan)).toBeUndefined();
  });
});
