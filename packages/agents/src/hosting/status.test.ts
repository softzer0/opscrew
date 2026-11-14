// Feature 027 (T2713): `opscrew status` on a hosting account, through each panel's fakes.
import { rm } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { componentStatusReport } from "../status/run";
import {
  type HostedOptions,
  hostedApp,
  hostingTestPlan,
  PANEL_TOKEN,
  pleskAccount,
} from "./__fixtures__/account";
import { hostingRecordFile } from "./record";
import { hostingStatusReport } from "./status";

async function status(o: HostedOptions = {}) {
  const app = await hostedApp(o);
  const deps = await app.deps();
  return { app, deps };
}

describe("status on a hosting account", () => {
  it("shows the running release, those kept, the last attempt, the certificate and the disk left", async () => {
    const { app, deps } = await status();
    const { lines } = await componentStatusReport(deps, app.plan);
    expect(lines).toEqual([
      "Hosting account: cPanel account acct at panel.example.com; the app is in ~/opscrew/notes-prod/ and answers on https://notes.example.com.",
      "Release: 812-1 runs. Kept for a rollback: 790-1 (the default), 777-2.",
      "Last attempt: release 812-1 deployed at 2026-11-12 10:30 UTC.",
      expect.stringMatching(
        /^Certificate: notes\.example\.com's is installed, valid until \d{4}-\d{2}-\d{2}\.$/,
      ),
      expect.stringMatching(
        /^The account: cPanel.*Web server: LiteSpeed, from example\.com's Server header\.$/,
      ),
      expect.stringMatching(/Disk: [\d,]+ MB left of [\d,]+ MB\./),
    ]);
    expect(JSON.stringify(deps.audit.entries)).not.toContain(PANEL_TOKEN);
    expect(deps.audit.entries).toContainEqual(
      expect.objectContaining({ action: "read the app on the hosting account (read-only)" }),
    );
  });

  it("says why the last release failed, and on Apache how long a switch takes to reach PHP", async () => {
    const { app, deps } = await status({ webServer: "Apache" });
    app.account.write(
      `${app.folder}/state/status`,
      [
        "running=812-1",
        "previous=790-1",
        "kept=790-1",
        "attempt=830-1",
        "result=failed",
        "reason=https://notes.example.com/ didn't answer 2xx or 3xx with it (HTTP 500); switched back to 812-1",
        "at=2026-11-12T11:00:00Z",
        "",
      ].join("\n"),
    );
    const { lines } = await hostingStatusReport(deps, app.plan);
    expect(lines).toContain(
      "Last attempt: release 830-1 failed at 2026-11-12 11:00 UTC: https://notes.example.com/ didn't answer 2xx or 3xx with it (HTTP 500); switched back to 812-1.",
    );
    expect(lines.at(-1)).toBe(
      "On Apache with PHP-FPM, some requests may still run the release before for about 2 minutes after a deploy or a rollback: OpsCrew turns on opcache.revalidate_path so PHP's code cache follows the switch once PHP's path cache expires, and its checks wait that long.",
    );
  });

  it("before the first release, and before provision", async () => {
    const { app, deps } = await status();
    app.account.remove(`${app.folder}/state/status`);
    const { lines } = await hostingStatusReport(deps, app.plan);
    expect(lines[1]).toBe(
      "Release: none runs yet; the agent deploys the first one the deploy workflow publishes.",
    );
    const fresh = await hostingStatusReport(deps, hostingTestPlan({ deployed: false }));
    expect(fresh.lines).toEqual([
      "The hosting account isn't set up for the app yet: `opscrew provision` sets it up.",
    ]);
  });

  it("on Plesk: the releases over SFTP, and certificates the API can't show", async () => {
    const { app, deps } = await status({ account: pleskAccount() });
    const { lines } = await hostingStatusReport(deps, app.plan, { files: app.account.files });
    expect(lines).toContain(
      "Release: 812-1 runs. Kept for a rollback: 790-1 (the default), 777-2.",
    );
    expect(lines).toContain(
      "Certificate: Plesk's API doesn't show certificates; check notes.example.com's in Plesk.",
    );
    // Without an SFTP login, Plesk's API can't read the agent's files: said in its place.
    const without = await hostingStatusReport(deps, app.plan);
    expect(without.lines[1]).toBe(
      "OpsCrew could not read the agent's status. Plesk's API can't read or write files, so OpsCrew reaches them over SFTP, and OPSCREW_SFTP_HOST, OPSCREW_SFTP_USER and OPSCREW_SFTP_KEY aren't set: it can't read it. Set them to the account's SFTP login (OPSCREW_SFTP_KEY is your key file's path), then run the command again.",
    );
  });

  it("says when OpsCrew has no record of the account here", async () => {
    const { app, deps } = await status();
    await rm(hostingRecordFile(deps.paths));
    const { lines } = await hostingStatusReport(deps, app.plan);
    expect(lines).toEqual([
      "OpsCrew could not read the hosting account. OpsCrew has no record of the hosting account's panel on this computer (.opscrew/hosting.json), so it can't reach the app there. Run the command on the computer that ran `opscrew provision`, or on one where .opscrew/ was restored from OpsCrew's recovery copy. Before the app's first provision, run `opscrew interview`: it finds your panel and records the account in .opscrew/hosting.json.",
    ]);
  });
});
