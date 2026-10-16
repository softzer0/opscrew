import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuditEntry, Clock } from "@opscrew/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendJsonLine, JsonlAuditLog, MemoryAuditLog, readJsonLines } from "./audit";
import { fakeSecret } from "./testing/fake-secrets";

const FAKE_TOKEN = fakeSecret("github-token");
const fakeRedact = (text: string) => text.replaceAll(FAKE_TOKEN, "[REDACTED:github-token]");
const fixedClock = (iso: string): Clock => ({ now: () => new Date(iso) });

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "opscrew-audit-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function readLines(file: string): Promise<string[]> {
  const text = await readFile(file, "utf8");
  return text.split("\n").filter((line) => line.length > 0);
}

describe("JsonlAuditLog", () => {
  it("creates the directory and writes one JSON object per line to the UTC-dated file", async () => {
    const dir = join(root, "nested", "audit");
    const log = new JsonlAuditLog({
      dir,
      redact: fakeRedact,
      clock: fixedClock("2026-10-11T23:30:00.000Z"),
    });

    await log.append({ kind: "phase", actor: "opscrew", action: "scan" });
    await log.append({ kind: "git", actor: "agent", action: "commit", target: "main" });

    const files = await readdir(dir);
    expect(files).toEqual(["2026-10-11.jsonl"]);
    const lines = await readLines(join(dir, "2026-10-11.jsonl"));
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0] ?? "") as AuditEntry;
    expect(first).toEqual({
      at: "2026-10-11T23:30:00.000Z",
      kind: "phase",
      actor: "opscrew",
      action: "scan",
    });
    expect(JSON.parse(lines[1] ?? "")).toMatchObject({ target: "main", action: "commit" });
  });

  it("uses the UTC date of an explicit `at` for the file name", async () => {
    const log = new JsonlAuditLog({ dir: root, redact: fakeRedact });
    await log.append({
      at: "2026-01-02T00:00:01.000Z",
      kind: "iac",
      actor: "opscrew",
      action: "apply",
    });
    expect(await readdir(root)).toEqual(["2026-01-02.jsonl"]);
  });

  it("passes every string field through redact", async () => {
    const log = new JsonlAuditLog({
      dir: root,
      redact: fakeRedact,
      clock: fixedClock("2026-10-11T10:00:00.000Z"),
    });
    await log.append({
      kind: "secret-set",
      actor: "opscrew",
      action: `set secret ${FAKE_TOKEN}`,
      target: `repo/${FAKE_TOKEN}`,
      sessionId: FAKE_TOKEN,
      detail: `token=${FAKE_TOKEN}`,
    });
    const text = await readFile(join(root, "2026-10-11.jsonl"), "utf8");
    expect(text).not.toContain(FAKE_TOKEN);
    const entry = JSON.parse(text) as AuditEntry;
    expect(entry.action).toBe("set secret [REDACTED:github-token]");
    expect(entry.target).toBe("repo/[REDACTED:github-token]");
    expect(entry.sessionId).toBe("[REDACTED:github-token]");
    expect(entry.detail).toBe("token=[REDACTED:github-token]");
  });

  it("drops fields that are not part of AuditEntry", async () => {
    const log = new JsonlAuditLog({
      dir: root,
      redact: fakeRedact,
      clock: fixedClock("2026-10-11T10:00:00.000Z"),
    });
    const input = { kind: "git", actor: "agent", action: "commit", password: "hunter2" } as const;
    await log.append(input);
    const text = await readFile(join(root, "2026-10-11.jsonl"), "utf8");
    expect(text).not.toContain("hunter2");
  });

  it("never interleaves 100 concurrent appends", async () => {
    const log = new JsonlAuditLog({
      dir: root,
      redact: fakeRedact,
      clock: fixedClock("2026-10-11T10:00:00.000Z"),
    });
    const big = "x".repeat(20_000);
    await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        log.append({ kind: "tool-call", actor: "agent", action: `call-${i}`, detail: big }),
      ),
    );
    const lines = await readLines(join(root, "2026-10-11.jsonl"));
    expect(lines).toHaveLength(100);
    const actions = lines.map((line) => (JSON.parse(line) as AuditEntry).action);
    expect(new Set(actions).size).toBe(100);
  });

  it.skipIf(process.platform === "win32")("creates the directory with mode 0o700", async () => {
    const dir = join(root, "private");
    const log = new JsonlAuditLog({ dir, redact: fakeRedact });
    await log.append({ kind: "phase", actor: "opscrew", action: "scan" });
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  });
});

describe("MemoryAuditLog", () => {
  it("records redacted entries with `at` from the clock", async () => {
    const log = new MemoryAuditLog({
      redact: fakeRedact,
      clock: fixedClock("2026-10-11T10:00:00.000Z"),
    });
    await log.append({ kind: "approval", actor: "user", action: "iac-apply", detail: FAKE_TOKEN });
    expect(log.entries).toEqual([
      {
        at: "2026-10-11T10:00:00.000Z",
        kind: "approval",
        actor: "user",
        action: "iac-apply",
        detail: "[REDACTED:github-token]",
      },
    ]);
  });

  it("works without options", async () => {
    const log = new MemoryAuditLog();
    await log.append({ kind: "phase", actor: "opscrew", action: "scan" });
    expect(log.entries).toHaveLength(1);
    expect(log.entries[0]?.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("JSONL helpers", () => {
  it("reads a missing file as empty", async () => {
    expect(await readJsonLines(join(root, "missing.jsonl"))).toEqual([]);
  });

  it("skips corrupt lines, accepts CRLF and a BOM", async () => {
    const file = join(root, "mixed.jsonl");
    await writeFile(
      file,
      `${String.fromCharCode(0xfeff)}{"a":1}\r\nnot json\r\n\r\n{"a":2}\n{"a":`,
      "utf8",
    );
    expect(await readJsonLines(file)).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it("starts a new line after a torn last line so the next record survives", async () => {
    const file = join(root, "torn.jsonl");
    await writeFile(file, '{"n":1}\n{"n":2,"partial', "utf8");
    await appendJsonLine(file, { n: 3 });
    expect(await readJsonLines(file)).toEqual([{ n: 1 }, { n: 3 }]);
  });

  it("appends lines and creates parent directories", async () => {
    const file = join(root, "a", "b", "c.jsonl");
    await appendJsonLine(file, { n: 1 });
    await appendJsonLine(file, { n: 2 });
    expect(await readJsonLines(file)).toEqual([{ n: 1 }, { n: 2 }]);
  });
});
