// Feature 027 (T2711): one-time requests to the agent on a hosting account (plan 6).
import { createHash } from "node:crypto";
import type { HostingFiles } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { describe, expect, it } from "vitest";
import {
  type HostingRequest,
  requestText,
  sendRequest,
  waitForResult,
  writeRequest,
} from "./requests";

const HASH = "a".repeat(64);
const NOW = new Date("2026-11-12T12:00:00.000Z");
const FOLDER = "opscrew/notes-prod";

/** An account's files in memory, with every write logged. */
class MemoryFiles implements HostingFiles {
  readonly files = new Map<string, string>();
  readonly writes: { path: string; mode: number }[] = [];
  async writeFile(path: string, content: Uint8Array, mode: number) {
    this.files.set(path, new TextDecoder().decode(content));
    this.writes.push({ path, mode });
  }
  async uploadTar() {}
  async readFile(path: string) {
    return this.files.get(path);
  }
  async remove(path: string) {
    this.files.delete(path);
  }
  async list() {
    return undefined;
  }
}

describe("requestText", () => {
  it("writes the kind, the approved hash and the expiry 30 minutes on, then the kind's fields", () => {
    const expires = NOW.getTime() / 1000 + 1800;
    expect(requestText({ kind: "rollback", release: "41-2", restore: true }, HASH, NOW)).toBe(
      `kind=rollback\nhash=${HASH}\nexpires=${expires}\nrelease=41-2\nrestore=yes\n`,
    );
    expect(requestText({ kind: "env" }, HASH.toUpperCase(), NOW)).toBe(
      `kind=env\nhash=${HASH}\nexpires=${expires}\n`,
    );
    expect(requestText({ kind: "restore", snapshot: "snapshot-1" }, HASH, NOW)).toContain(
      "snapshot=snapshot-1\n",
    );
  });

  it.each([
    [{ kind: "restore", snapshot: "../x; rm -rf" }, HASH, "a snapshot's id in dumps/"],
    [{ kind: "restore", snapshot: "snapshot-1.sql.gz" }, HASH, "a snapshot's id in dumps/"],
    [{ kind: "restore", snapshot: "-x" }, HASH, "a snapshot's id in dumps/"],
    [{ kind: "restore", snapshot: "" }, HASH, "a snapshot's id in dumps/"],
    [{ kind: "rollback", release: "41-0", restore: false }, HASH, "a release's id"],
    [{ kind: "rollback", release: "latest", restore: false }, HASH, "a release's id"],
    [{ kind: "env" }, "not-a-hash", "a plan's SHA-256 hash"],
  ] as const)(
    "refuses what the agent would refuse, before writing: %j",
    async (request, hash, what) => {
      const error = (() => {
        try {
          requestText(request as HostingRequest, hash, NOW);
        } catch (caught) {
          return caught;
        }
      })();
      expect(error).toBeInstanceOf(OpsCrewError);
      expect(error).toMatchObject({ code: "INVALID_INPUT" });
      expect((error as OpsCrewError).message).toContain(what);
      const files = new MemoryFiles();
      await expect(
        writeRequest(files, FOLDER, request as HostingRequest, { hash, now: NOW }),
      ).rejects.toThrow(OpsCrewError);
      expect(files.writes).toEqual([]);
    },
  );

  it("takes the agent's own names: a snapshot's id, a release's dump and a release id", () => {
    expect(
      requestText({ kind: "restore", snapshot: "snapshot-20261112T120000Z-2" }, HASH, NOW),
    ).toContain("snapshot=snapshot-20261112T120000Z-2\n");
    expect(requestText({ kind: "restore", snapshot: "41-2" }, HASH, NOW)).toContain(
      "snapshot=41-2\n",
    );
    expect(requestText({ kind: "rollback", release: "41-2", restore: false }, HASH, NOW)).toContain(
      "release=41-2\n",
    );
  });
});

describe("writeRequest and waitForResult", () => {
  it("names the request by the SHA-256 of its bytes, 0600, in requests/", async () => {
    const files = new MemoryFiles();
    const name = await writeRequest(files, FOLDER, { kind: "snapshot" }, { hash: HASH, now: NOW });
    const text = requestText({ kind: "snapshot" }, HASH, NOW);
    expect(name).toBe(createHash("sha256").update(text).digest("hex"));
    expect(files.files.get(`${FOLDER}/requests/${name}.req`)).toBe(text);
    expect(files.writes).toEqual([{ path: `${FOLDER}/requests/${name}.req`, mode: 0o600 }]);
  });

  it("waits while the agent carries it out, and reads its answer once the request is gone", async () => {
    const files = new MemoryFiles();
    let ticks = 0;
    const result = await sendRequest(
      files,
      FOLDER,
      { kind: "snapshot" },
      {
        hash: HASH,
        now: NOW,
        sleep: async () => {
          ticks++;
          const [request] = [...files.files.keys()].filter((path) => path.endsWith(".req"));
          const name = request?.replace(/^.*\//, "").replace(/\.req$/, "");
          if (ticks === 1) {
            // The agent writes "failed" before it starts, pending: not the answer yet.
            files.files.set(
              `${FOLDER}/state/${name}.result`,
              "result=failed\nreason=the agent stopped while carrying it out\npending=1\n",
            );
          } else if (ticks === 2 && request !== undefined) {
            files.files.set(
              `${FOLDER}/state/${name}.result`,
              "result=done\ndump=snapshot-20261112T120000Z.sql.gz\n",
            );
            files.files.delete(request);
          }
        },
      },
    );
    expect(result).toMatchObject({ result: "done", dump: "snapshot-20261112T120000Z.sql.gz" });
    expect(ticks).toBe(2);
  });

  it("never takes a pending answer, even with the request gone, and takes it once the agent's next run made it final", async () => {
    const files = new MemoryFiles();
    const name = "c".repeat(64);
    const result = `${FOLDER}/state/${name}.result`;
    const stopped = "result=failed\nreason=the agent stopped while carrying it out\n";
    let ticks = 0;
    const answer = await waitForResult(files, FOLDER, name, {
      sleep: async () => {
        ticks++;
        // The placeholder of a run that stopped part-way, the request file already gone.
        if (ticks === 1) files.files.set(result, `${stopped}pending=1\n`);
        // The agent's next run, holding its lock, made it final.
        if (ticks === 3) files.files.set(result, stopped);
      },
    });
    expect(answer).toEqual({ result: "failed", reason: "the agent stopped while carrying it out" });
    expect(ticks).toBe(3);
  });

  it("reads made=no, the agent's word that it made nothing, and no other value of it", async () => {
    const files = new MemoryFiles();
    const sleep = async () => undefined;
    const refused =
      "result=failed\nreason=CloudLinux's selector didn't make the app: no version 99";
    files.files.set(`${FOLDER}/state/${"d".repeat(64)}.result`, `${refused}\nmade=no\n`);
    expect(await waitForResult(files, FOLDER, "d".repeat(64), { sleep })).toEqual({
      result: "failed",
      reason: "CloudLinux's selector didn't make the app: no version 99",
      made: "no",
    });
    files.files.set(`${FOLDER}/state/${"e".repeat(64)}.result`, `${refused}\nmade=yes\n`);
    await expect(waitForResult(files, FOLDER, "e".repeat(64), { sleep })).rejects.toThrow(
      "OpsCrew can't read the agent's answer",
    );
  });

  it("says after 5 minutes that the agent's cron line may be missing", async () => {
    const files = new MemoryFiles();
    let slept = 0;
    const error = await waitForResult(files, FOLDER, "b".repeat(64), {
      sleep: async (ms) => {
        slept += ms;
      },
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpsCrewError);
    expect((error as OpsCrewError).message).toContain(
      "didn't carry out OpsCrew's request within 5 minutes. Its cron line may be missing",
    );
    expect(slept).toBe(5 * 60 * 1000);
  });
});
