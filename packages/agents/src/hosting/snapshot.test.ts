// Feature 027 (T2718): `opscrew snapshot` and `opscrew restore` on a hosting account, through the
// agent's requests, with the cPanel fake.
import { describe, expect, it } from "vitest";
import { listSnapshots } from "../snapshot/list";
import { restoreSnapshot } from "../snapshot/restore";
import { snapshotRun } from "../snapshot/run";
import { takeSnapshot } from "../snapshot/take";
import { ScriptedApprovalHandler } from "../testing";
import {
  type AgentAnswer,
  type HostedApp,
  hostedApp,
  hostingTestPlan,
  PANEL_TOKEN,
  playAgent,
} from "./__fixtures__/account";
import { restoreHostingSnapshot, takeHostingSnapshot } from "./snapshot";

const ID = "snapshot-20261011T120000Z";

/**
 * The agent's snapshot as it takes one: the dump when the app has a database, the shared files'
 * copy with `shared`.
 */
function snapshotAgent(app: HostedApp, parts: { dump: boolean; shared: boolean }): AgentAnswer {
  return (request) => {
    if (request.kind !== "snapshot") return undefined;
    const lines = ["result=done"];
    if (parts.dump) {
      app.account.write(`${app.folder}/dumps/${ID}.sql.gz`, "dump");
      lines.push(`dump=${ID}.sql.gz`);
    }
    if (parts.shared) {
      app.account.write(`${app.folder}/dumps/${ID}.shared.tar.gz`, "tar");
      lines.push(`shared=${ID}.shared.tar.gz`);
    }
    return `${lines.join("\n")}\n`;
  };
}

/** The agent's restore: the data as it was first copied, then put back. */
const restoring: AgentAnswer = (request) =>
  request.kind === "restore" ? "result=done\nsaved=snapshot-20261011T120500Z\n" : undefined;

async function run(app: HostedApp, handler?: ScriptedApprovalHandler) {
  const deps = await app.deps(handler);
  return { deps, snapshot: await snapshotRun(deps) };
}

describe("snapshots on a hosting account", () => {
  it("takes one through the agent: the database and the shared files, kept on the account", async () => {
    const app = await hostedApp();
    const { deps, snapshot } = await run(app);
    const agent = playAgent(app, snapshotAgent(app, { dump: true, shared: true }));
    const taken = await takeHostingSnapshot(snapshot, {}, { sleep: agent.sleep });
    expect(agent.requests).toEqual([
      {
        kind: "snapshot",
        hash: expect.stringMatching(/^[0-9a-f]{64}$/),
        expires: expect.any(String),
      },
    ]);
    expect(taken).toEqual({
      id: ID,
      where: "on the hosting account (~/opscrew/notes-prod/dumps/)",
      services: [
        { name: "acct_notes", kind: "mariadb", state: "copied" },
        { name: "files", kind: "files", state: "copied" },
      ],
    });
    expect(deps.reporter.text()).toContain(
      `success: Took the snapshot ${ID} of prod on the hosting account: the database acct_notes and the shared files (${ID}.sql.gz, ${ID}.shared.tar.gz) in ~/opscrew/notes-prod/dumps/.`,
    );
    expect(deps.reporter.text()).toContain(
      "info: Snapshots stay on the hosting account in ~/opscrew/notes-prod/dumps/: download one from the panel's File Manager to keep a copy elsewhere.",
    );
    expect(deps.audit.entries).toContainEqual(
      expect.objectContaining({ action: "ask the agent for a snapshot", detail: "done" }),
    );
    expect(JSON.stringify(deps.audit.entries)).not.toContain(PANEL_TOKEN);

    // Without shared files besides the settings, the snapshot is the dump alone.
    const plain = await takeHostingSnapshot(
      snapshot,
      {},
      { sleep: playAgent(app, snapshotAgent(app, { dump: true, shared: false })).sleep },
    );
    expect(plain.services[1]).toEqual({ name: "files", kind: "files", state: "skipped" });
  });

  it("takes the shared files alone of an app without a database, and refuses one with neither", async () => {
    const app = await hostedApp({ database: false });
    const { deps, snapshot } = await run(app);
    const neither = playAgent(
      app,
      () =>
        "result=refused\nreason=this app has no database and no shared files besides its settings\n",
    );
    await expect(takeHostingSnapshot(snapshot, {}, { sleep: neither.sleep })).rejects.toMatchObject(
      {
        code: "COMMAND_FAILED",
        message:
          "The agent on the hosting account refused the snapshot: this app has no database and no shared files besides its settings. No snapshot was taken.",
      },
    );

    const agent = playAgent(app, snapshotAgent(app, { dump: false, shared: true }));
    const taken = await takeHostingSnapshot(snapshot, {}, { sleep: agent.sleep });
    expect(taken).toEqual({
      id: ID,
      where: "on the hosting account (~/opscrew/notes-prod/dumps/)",
      services: [{ name: "files", kind: "files", state: "copied" }],
    });
    expect(deps.reporter.text()).toContain(
      `success: Took the snapshot ${ID} of prod on the hosting account: the shared files (${ID}.shared.tar.gz) in ~/opscrew/notes-prod/dumps/.`,
    );

    const restored = await restoreHostingSnapshot(
      snapshot,
      ID,
      {},
      {
        sleep: playAgent(app, restoring).sleep,
      },
    );
    expect(restored.services).toEqual([{ name: "files" }]);
    expect(deps.reporter.text()).toContain(
      `success: Restored the snapshot ${ID} of prod on the hosting account: the shared files are as they were then, and the settings files as they are now. The data as it was just before is the snapshot snapshot-20261011T120500Z.`,
    );
    // A release's dump has no database to go back into.
    await expect(restoreHostingSnapshot(snapshot, "790-1", {})).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      message:
        "The snapshot 790-1 holds a database dump, and prod has no database on the hosting account to put it back into. Nothing was changed.",
    });
  });

  it("refuses --skip, an SFTP host, a refusal of the agent's, and before provision", async () => {
    const app = await hostedApp();
    const { snapshot } = await run(app);
    await expect(takeHostingSnapshot(snapshot, { skip: ["db"] })).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message:
        "--skip leaves a service out of a server's snapshot; on a hosting account a snapshot is the database and the shared files, taken together. No snapshot was taken.",
    });
    const refused = playAgent(
      app,
      () => "result=failed\nreason=the database dump or the copy of the shared files failed\n",
    );
    await expect(takeHostingSnapshot(snapshot, {}, { sleep: refused.sleep })).rejects.toMatchObject(
      {
        code: "COMMAND_FAILED",
        message:
          "The agent on the hosting account didn't finish the snapshot: the database dump or the copy of the shared files failed.",
      },
    );

    const base = hostingTestPlan({ database: false });
    const sftp = {
      ...snapshot,
      plan: {
        ...base,
        target: {
          ...base.target,
          panel: "sftp" as const,
          cron: [],
          php: { version: "8.3", via: "account" as const },
        },
      },
    };
    await expect(takeHostingSnapshot(sftp, {})).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      message:
        "prod is on an SFTP host, where no agent of OpsCrew's runs to take or restore snapshots. No snapshot was taken.",
    });
    const fresh = { ...snapshot, plan: hostingTestPlan({ deployed: false }) };
    await expect(takeHostingSnapshot(fresh, {})).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
    });
  });

  it("restores one after an approval like a destroy's, with the hostname typed", async () => {
    const app = await hostedApp();
    app.account.write(`${app.folder}/dumps/${ID}.sql.gz`, "dump");
    app.account.write(`${app.folder}/dumps/${ID}.shared.tar.gz`, "tar");
    const handler = new ScriptedApprovalHandler();
    const { deps, snapshot } = await run(app, handler);
    const agent = playAgent(app, restoring);
    const restored = await restoreHostingSnapshot(snapshot, ID, {}, { sleep: agent.sleep });
    expect(restored).toEqual({
      id: ID,
      where: "on the hosting account (~/opscrew/notes-prod/dumps/)",
      services: [{ name: "acct_notes" }, { name: "files" }],
      saved: { app: "snapshot-20261011T120500Z" },
    });
    const [approval] = handler.requests;
    expect(approval).toMatchObject({
      kind: "remote-exec",
      title: `Restore the snapshot ${ID} of prod on the hosting account`,
      allowDestroy: true,
      confirmPhrase: "notes.example.com",
    });
    expect(approval?.details).toContain(
      `The snapshot ${ID} in ~/opscrew/notes-prod/dumps/ (${ID}.sql.gz and ${ID}.shared.tar.gz).`,
    );
    expect(approval?.details).toContain(
      "It puts back the database acct_notes and the shared files as they were then; the settings files (.env, env.php, mysql.cnf) stay as they are now.",
    );
    expect(approval?.details).toContain("Typing notes.example.com approves it.");
    expect(agent.requests).toEqual([
      { kind: "restore", hash: approval?.planHash, expires: expect.any(String), snapshot: ID },
    ]);
    expect(deps.reporter.text()).toContain(
      `success: Restored the snapshot ${ID} of prod on the hosting account: the database acct_notes and the shared files are as they were then, and the settings files as they are now. The data as it was just before is the snapshot snapshot-20261011T120500Z.`,
    );
    // A release's dump is restored the same way, the database alone.
    const release = await restoreHostingSnapshot(
      snapshot,
      "790-1",
      {},
      {
        sleep: playAgent(app, restoring).sleep,
      },
    );
    expect(release.services).toEqual([{ name: "acct_notes" }]);
    expect(deps.reporter.text()).toContain(
      "success: Restored the snapshot 790-1 of prod on the hosting account: the database acct_notes is as it was then",
    );
  });

  it("refuses a wrong hostname, an unknown snapshot, --from, --only, and a failed restore says where the data is", async () => {
    const app = await hostedApp();
    const wrong = new ScriptedApprovalHandler(() => ({ approved: true, confirmation: "notes" }));
    const { snapshot } = await run(app, wrong);
    const agent = playAgent(app, restoring);
    await expect(
      restoreHostingSnapshot(snapshot, "790-1", {}, { sleep: agent.sleep }),
    ).rejects.toMatchObject({
      code: "APPROVAL_REFUSED",
    });
    expect(agent.requests).toEqual([]);

    const ok = (await run(app)).snapshot;
    await expect(restoreHostingSnapshot(ok, "snapshot-1", {})).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      message:
        "The hosting account keeps no snapshot snapshot-1 of prod; it keeps 777-2 and 790-1. Nothing was changed.",
    });
    await expect(restoreHostingSnapshot(ok, "../x", {})).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(restoreHostingSnapshot(ok, "790-1", { from: "offsite" })).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message:
        "A hosting account's snapshots stay on the account: there is no copy elsewhere to restore from. Nothing was changed.",
    });
    await expect(restoreHostingSnapshot(ok, "790-1", { only: "db" })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    const failing = playAgent(
      app,
      () =>
        "result=failed\nreason=the restore failed: the database is back as it was\nsaved=snapshot-20261011T120500Z\n",
    );
    await expect(
      restoreHostingSnapshot(ok, "790-1", {}, { sleep: failing.sleep }),
    ).rejects.toMatchObject({
      code: "COMMAND_FAILED",
      message:
        "The agent on the hosting account didn't finish the restore of the snapshot 790-1: the restore failed: the database is back as it was. The data as it was just before is the snapshot snapshot-20261011T120500Z.",
    });
  });

  it("runs through `opscrew snapshot` and `opscrew restore`; `snapshot list` says where they are", async () => {
    const app = await hostedApp();
    const deps = await app.deps();
    await expect(takeSnapshot(deps, { skip: ["db"] })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(restoreSnapshot(deps, "snapshot-1")).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      message: expect.stringMatching(/^The hosting account keeps no snapshot snapshot-1 of prod/),
    });
    await expect(listSnapshots(deps)).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      message:
        "prod runs on a hosting account, whose snapshots stay there in ~/opscrew/notes-prod/dumps/, which `opscrew snapshot list` and `opscrew snapshot delete` don't reach. Nothing was changed.",
    });
  });
});
