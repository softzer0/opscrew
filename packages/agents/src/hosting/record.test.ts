// Feature 027 (T2710): `.opscrew/hosting.json`, OpsCrew's record of a hosting account.
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createTestPhaseDeps } from "../testing";
import {
  forgetObject,
  hostingRecordFile,
  readHostingRecord,
  recordedObject,
  recordObject,
  updateHostingRecord,
} from "./record";

const PANEL = { kind: "cpanel", url: "https://panel.example.com:2083", user: "acct" } as const;

describe("the hosting record", () => {
  it("is absent until written, then reads back what was written", async () => {
    const deps = await createTestPhaseDeps();
    expect(await readHostingRecord(deps.paths)).toBeUndefined();
    const written = await updateHostingRecord(deps.paths, (current) => ({
      ...current,
      panel: PANEL,
      objects: [
        { kind: "hostname", key: "app.example.com" },
        { kind: "cron", key: "7" },
      ],
    }));
    expect(written).toEqual({
      schemaVersion: 1,
      panel: PANEL,
      objects: [
        { kind: "hostname", key: "app.example.com" },
        { kind: "cron", key: "7" },
      ],
    });
    expect(await readHostingRecord(deps.paths)).toEqual(written);
    const file = hostingRecordFile(deps.paths);
    expect(file.replaceAll("\\", "/")).toMatch(/\/\.opscrew\/hosting\.json$/);
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
    // The state folder keeps itself out of git.
    expect(await readFile(file.replace(/hosting\.json$/, ".gitignore"), "utf8")).toBe("*\n");
  });

  it("keeps an SFTP host's login, its confirmed key, the folder and PHP's path", async () => {
    const deps = await createTestPhaseDeps();
    const sftp = {
      host: "sftp.example.com",
      port: 22,
      user: "deploy",
      hostKey: `SHA256:${"A".repeat(43)}`,
      folder: "opscrew",
      phpPath: "/home/deploy/opscrew",
    };
    await updateHostingRecord(deps.paths, (current) => ({ ...current, sftp }));
    expect((await readHostingRecord(deps.paths))?.sftp).toEqual(sftp);
    await expect(
      updateHostingRecord(deps.paths, (current) => ({
        ...current,
        sftp: { ...sftp, phpPath: "x" },
      })),
    ).rejects.toThrow();
  });

  it("stops on a damaged record instead of reading it as empty", async () => {
    const deps = await createTestPhaseDeps();
    const file = hostingRecordFile(deps.paths);
    await mkdir(deps.paths.stateDir, { recursive: true });
    await writeFile(file, "{ not json");
    await expect(readHostingRecord(deps.paths)).rejects.toMatchObject({
      code: "ARTIFACT_INVALID",
      message: expect.stringContaining("it is not valid JSON"),
    });
    await writeFile(file, JSON.stringify({ schemaVersion: 1, objects: [{ kind: "x", key: "y" }] }));
    await expect(readHostingRecord(deps.paths)).rejects.toMatchObject({
      code: "ARTIFACT_INVALID",
      message: expect.stringContaining("objects.0.kind is not valid"),
    });
  });
  it("records each object made right away, one per kind and key, and forgets one removed (T2711)", async () => {
    const deps = await createTestPhaseDeps();
    await recordObject(deps.paths, { kind: "cron", key: "7", value: "* * * * * one" });
    await recordObject(deps.paths, { kind: "deploy-key", key: "4000", value: "ssh-ed25519 AAAA" });
    await recordObject(deps.paths, { kind: "cron", key: "7", value: "* * * * * two" });
    await recordObject(deps.paths, { kind: "panel-step", key: "agent-cron" });
    const record = await readHostingRecord(deps.paths);
    expect(record?.objects).toEqual([
      { kind: "deploy-key", key: "4000", value: "ssh-ed25519 AAAA" },
      { kind: "cron", key: "7", value: "* * * * * two" },
      { kind: "panel-step", key: "agent-cron" },
    ]);
    expect(recordedObject(record, "cron")?.value).toBe("* * * * * two");
    expect(recordedObject(record, "cron", "8")).toBeUndefined();
    await forgetObject(deps.paths, "cron", "7");
    expect(recordedObject(await readHostingRecord(deps.paths), "cron")).toBeUndefined();
  });
});
