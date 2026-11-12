// Feature 027 (T2713): `opscrew rollback` on a hosting account, through each panel's fakes, the
// agent's part played by the test.
import { DEPLOY_PAUSED_VARIABLE } from "@opscrew/iac-templates";
import { describe, expect, it } from "vitest";
import { rollback } from "../rollback/index";
import { readRollback } from "../rollback/record";
import { rollbackRun } from "../rollback/run";
import { ScriptedApprovalHandler } from "../testing";
import {
  type AgentAnswer,
  commitOfRun,
  directAdminAccount,
  HOSTNAME,
  type HostedOptions,
  hostedApp,
  hostingGitHub,
  PANEL_TOKEN,
  playAgent,
  pleskAccount,
} from "./__fixtures__/account";
import { rollbackHosting } from "./rollback";

/** An app on a fake account, and one `opscrew rollback` run with `options`. */
async function world(o: HostedOptions & { answer?: AgentAnswer } = {}) {
  const app = await hostedApp(o);
  const github = hostingGitHub(app.plan);
  const agent = playAgent(app, o.answer);
  const run = async (
    options: Omit<Parameters<typeof rollback>[1], "services"> = {},
    approve: ConstructorParameters<typeof ScriptedApprovalHandler>[0] = () => true,
  ) => {
    const handler = new ScriptedApprovalHandler(approve);
    const deps = await app.deps(handler);
    const services = { github, sleep: agent.sleep };
    const work =
      app.account.files === undefined
        ? rollback(deps, { ...options, services })
        : rollbackRun(deps, { ...options, services }).then((r) =>
            rollbackHosting(r, { files: app.account.files }),
          );
    const outcome = await work.then(
      (result) => ({ result, error: undefined }),
      (error: unknown) => ({ result: undefined, error }),
    );
    return { deps, handler, ...outcome };
  };
  const pause = () => {
    const text = github.variables.get(DEPLOY_PAUSED_VARIABLE);
    return text === undefined ? undefined : (JSON.parse(text) as Record<string, unknown>);
  };
  return { app, github, agent, run, pause };
}

describe("rollback on a cPanel account", () => {
  it("goes back to the previous release, keeps prod's database by default, then pauses the deploys", async () => {
    const w = await world();
    const { deps, handler, result, error } = await w.run();
    expect(error).toBeUndefined();
    expect(result).toMatchObject({
      kind: "rolled-back",
      status: "deployed",
      how: "release",
      paused: true,
      target: { version: "790-1", commit: commitOfRun(790) },
      from: { version: "812-1", commit: commitOfRun(812) },
      database: { choice: "keep" },
    });

    // One promote approval, bound to both releases, the plan and the choice; no typed name.
    expect(handler.requests.map((request) => request.kind)).toEqual(["promote"]);
    const [approval] = handler.requests;
    expect(approval?.confirmPhrase).toBeUndefined();
    expect(approval?.details).toContain(
      `Now: release 812-1 (commit ${commitOfRun(812).slice(0, 7)})`,
    );
    expect(approval?.details).toContain("Back to: release 790-1");
    expect(approval?.details).toContain("The release command doesn't run.");

    // The request the agent carried out, then the pause pinned to the release.
    expect(w.agent.requests).toEqual([
      expect.objectContaining({
        kind: "rollback",
        release: "790-1",
        restore: "no",
        hash: approval?.planHash,
      }),
    ]);
    expect(Number(w.agent.requests[0]?.expires)).toBe(
      Math.floor(deps.clock.now().getTime() / 1000) + 30 * 60,
    );
    expect(w.app.status().running).toBe("790-1");
    expect(w.pause()).toEqual({
      "notes/prod": {
        reason: "rollback",
        since: deps.clock.now().toISOString(),
        image: "790-1",
        commit: commitOfRun(790),
        from: commitOfRun(812),
      },
    });
    expect(await readRollback(deps.paths)).toMatchObject({
      digest: "790-1",
      from: { digest: "812-1" },
      hash: approval?.planHash,
      database: { choice: "keep" },
    });
    expect(deps.reporter.text()).toContain("prod's deploys are paused");
    // The panel's token is in no output and no audit entry.
    const said = `${deps.reporter.text()}\n${JSON.stringify(deps.audit.entries)}\n${JSON.stringify(handler.requests)}`;
    expect(said).not.toContain(PANEL_TOKEN);
  });

  it("outside prod restores the dump filed under the target by default, approved with the typed hostname", async () => {
    const w = await world({ environment: "staging" });
    const { handler, result, error } = await w.run();
    expect(error).toBeUndefined();
    expect(result).toMatchObject({ database: { choice: "snapshot" } });
    const [approval] = handler.requests;
    expect(approval).toMatchObject({
      kind: "promote",
      allowDestroy: true,
      confirmPhrase: HOSTNAME,
    });
    expect(approval?.details).toContain(
      "Database: Restore the dump taken when release 790-1 stopped running (dumps/790-1.sql.gz)",
    );
    expect(w.agent.requests[0]).toMatchObject({
      kind: "rollback",
      release: "790-1",
      restore: "yes",
    });
    // The agent dumped the database first, filed under the release it left (ADR 0028 D11).
    expect(w.app.account.read(`${w.app.folder}/dumps/812-1.sql.gz`)).toBe("now");
  });

  it("binds the choice in its hash: --to and --database keep, and a hash approved for another rollback stops", async () => {
    const w = await world({ environment: "staging" });
    const keep = await w.run({ to: "777-2", database: "keep" }, () => false);
    const hash = keep.handler.requests[0]?.planHash as string;
    expect(keep.error).toMatchObject({
      code: "APPROVAL_REFUSED",
      hint: expect.stringContaining(
        `opscrew rollback --env staging --to 777-2 --database keep --approve ${hash}`,
      ),
    });
    const restore = await w.run({ to: "777-2", database: "snapshot", approveHash: hash });
    expect(restore.error).toMatchObject({ code: "PLAN_NOT_APPROVED" });
    expect(w.agent.requests).toEqual([]);
    expect(w.pause()).toBeUndefined();

    const again = await w.run({ to: "777-2", database: "keep", approveHash: hash });
    expect(again.error).toBeUndefined();
    expect(w.agent.requests[0]).toMatchObject({ release: "777-2", restore: "no", hash });
  });

  it("lists the releases the account keeps, newest first, read-only", async () => {
    const w = await world();
    const { result, handler } = await w.run({ list: true });
    expect(result).toEqual({
      kind: "list",
      versions: [
        { version: "812-1", marks: ["running"] },
        { version: "790-1", marks: ["previous"] },
        { version: "777-2" },
      ],
      leftOut: [],
    });
    expect(handler.requests).toEqual([]);
    expect(w.agent.requests).toEqual([]);
  });

  it.each([
    [
      "a release the account doesn't keep",
      { to: "700-1" },
      "The hosting account keeps no release 700-1 of prod (it keeps 790-1 and 777-2). Nothing was changed.",
    ],
    ["the release that runs", { to: "812-1" }, "Release 812-1 is the one prod runs now."],
    [
      "down migrations",
      { database: "migrations" as const },
      "On a hosting account OpsCrew restores the dump taken before a release, or keeps the database: it runs no down migrations there.",
    ],
    [
      "a restore without a dump filed under the target",
      { to: "790-1", database: "snapshot" as const },
      "The account keeps no dump filed under release 790-1",
    ],
  ])("refuses %s before anything changes", async (_name, options, message) => {
    const w = await world();
    w.app.account.remove(`${w.app.folder}/dumps/790-1.sql.gz`);
    const { error, handler } = await w.run(options);
    expect(error).toMatchObject({ code: "PHASE_PRECONDITION" });
    expect((error as Error).message).toContain(message);
    expect(handler.requests).toEqual([]);
    expect(w.agent.requests).toEqual([]);
    expect(w.pause()).toBeUndefined();
  });

  it("refuses with no earlier release kept, and while a deploy runs", async () => {
    const w = await world();
    w.app.setStatus({ running: "812-1", kept: [] });
    const none = await w.run();
    expect((none.error as Error).message).toContain(
      "The hosting account keeps no release of prod older than 812-1",
    );
    w.app.setStatus({ running: "812-1", previous: "790-1", kept: ["790-1"] });
    const deploying = w.github.runs.get(812);
    w.github.runs.set(900, {
      ...(deploying as NonNullable<typeof deploying>),
      status: "in_progress",
      conclusion: null,
    });
    const running = await w.run();
    expect((running.error as Error).message).toContain(
      "A run of prod's deploy workflow is queued or in progress",
    );
    expect(w.agent.requests).toEqual([]);
  });

  it("stops with the agent's reason when it refuses, and leaves the deploys unpaused", async () => {
    const w = await world({
      answer: () => "result=refused\nreason=release 790-1 isn't kept on the account\n",
    });
    const { error } = await w.run();
    expect(error).toMatchObject({ code: "COMMAND_FAILED" });
    expect((error as Error).message).toBe(
      "The agent on the hosting account refused the rollback of prod to release 790-1: release 790-1 isn't kept on the account. prod's deploys aren't paused.",
    );
    expect(w.pause()).toBeUndefined();
  });
});

describe("rollback on Plesk and DirectAdmin (SC-2705)", () => {
  it.each([
    ["Plesk, its files over SFTP", pleskAccount],
    ["DirectAdmin", directAdminAccount],
  ])("goes back on %s as on cPanel", async (_name, account) => {
    const w = await world({ account: account(), environment: "staging" });
    const { result, error, handler } = await w.run();
    expect(error).toBeUndefined();
    expect(result).toMatchObject({ kind: "rolled-back", target: { version: "790-1" } });
    expect(handler.requests[0]).toMatchObject({ kind: "promote", confirmPhrase: HOSTNAME });
    expect(w.agent.requests[0]).toMatchObject({ release: "790-1", restore: "yes" });
    expect(w.app.status().running).toBe("790-1");
    expect(w.pause()).toMatchObject({ "notes/staging": { image: "790-1" } });
  });
});
