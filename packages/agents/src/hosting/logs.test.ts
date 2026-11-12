// Feature 027 (T2713): `opscrew logs` on a hosting account: the agent's last lines, redacted.
import { describe, expect, it } from "vitest";
import { type LogLine, lineText } from "../logs/lines";
import { readLogs } from "../logs/read";
import { APP_VALUE, hostedApp, PANEL_TOKEN, pleskAccount } from "./__fixtures__/account";
import { hostingLogs } from "./logs";

async function lines(read: AsyncIterable<LogLine>): Promise<string[]> {
  const all: string[] = [];
  for await (const line of read) all.push(lineText(line));
  return all;
}

describe("logs on a hosting account", () => {
  it("shows the agent's last lines, redacted, a tool's own line at the time before it", async () => {
    const app = await hostedApp();
    const deps = await app.deps();
    deps.redactor.addLiteral(APP_VALUE, "NOTES_API_KEY");
    const read = await readLogs(deps, app.plan);
    expect(read.first).toBe(
      "The agent's log on the hosting account (~/opscrew/notes-prod/state/agent.log, its last 1,000 lines kept); the oldest line here is from 2026-11-12 10:00 UTC.",
    );
    const all = await lines(read);
    expect(all).toEqual([
      "2026-11-12T10:00:00Z agent Deploying release 790-1 (commit abc).",
      "2026-11-12T10:00:40Z agent Release 790-1 serves.",
      expect.stringMatching(/^2026-11-12T10:30:00Z agent Release 812-1: NOTES_API_KEY=/),
      "2026-11-12T10:30:00Z agent warning: a tool's own line",
      "2026-11-12T10:30:40Z agent Release 812-1 serves.",
    ]);
    expect(all.join("\n")).not.toContain(APP_VALUE);
    expect(JSON.stringify(deps.audit.entries)).not.toContain(PANEL_TOKEN);
    expect(deps.audit.entries).toContainEqual(
      expect.objectContaining({
        kind: "provider-call",
        action: "read the agent's log (read-only)",
      }),
    );

    const two = await lines(await readLogs(deps, app.plan, { tail: 2 }));
    expect(two).toEqual([
      "2026-11-12T10:30:00Z agent warning: a tool's own line",
      "2026-11-12T10:30:40Z agent Release 812-1 serves.",
    ]);
  });

  it("refuses the flags that don't apply before reading anything", async () => {
    const app = await hostedApp();
    const deps = await app.deps();
    await expect(readLogs(deps, app.plan, { follow: true, service: "worker" })).rejects.toThrow(
      "On a hosting account `opscrew logs` shows the agent's log, which names each release it deployed, refused or switched back from and why: --service, --follow don't apply there.",
    );
    expect(deps.audit.entries).toEqual([]);
  });

  it("reads the log over SFTP on Plesk, and says when it is empty", async () => {
    const app = await hostedApp({ account: pleskAccount() });
    const deps = await app.deps();
    app.account.remove(`${app.folder}/state/agent.log`);
    const read = await hostingLogs(deps, app.plan, { tail: 200 }, { files: app.account.files });
    expect(read.first).toBe(
      "The agent on the hosting account has logged nothing yet (~/opscrew/notes-prod/state/agent.log).",
    );
    expect(await lines(read)).toEqual([]);
  });
});
