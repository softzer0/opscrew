import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Finding, ScanContext } from "@opscrew/contracts";
import { materializeFixture } from "@opscrew/core/testing";
import { afterAll, describe, expect, it } from "vitest";
import { createFirebaseScanner } from "./firebase";

const FIXTURES = fileURLToPath(new URL("../../test/fixtures/firebase/", import.meta.url));
const temps: string[] = [];

async function listFiles(root: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await listFiles(root, relative)));
    else out.push(relative);
  }
  return out.sort();
}

function context(rootDir: string, files: string[], read: (path: string) => Promise<string>) {
  const ctx: ScanContext = {
    rootDir,
    files,
    readFile: read,
    offline: true,
    fetch: async () => {
      throw new Error("network is not allowed in this test");
    },
    runner: {
      run: async () => {
        throw new Error("subprocesses are not allowed in this test");
      },
    },
  };
  return ctx;
}

/** Minimal offline `ScanContext` over a materialised copy of `test/fixtures/firebase/<name>`. */
async function fixtureContext(name: string): Promise<ScanContext> {
  const rootDir = await mkdtemp(join(tmpdir(), `opscrew-firebase-${name}-`));
  temps.push(rootDir);
  await materializeFixture(join(FIXTURES, name), rootDir);
  return context(rootDir, await listFiles(rootDir), (path) =>
    readFile(join(rootDir, path), "utf8"),
  );
}

function memoryContext(files: Record<string, string>): ScanContext {
  return context("/virtual", Object.keys(files).sort(), async (path) => {
    const text = files[path];
    if (text === undefined) throw new Error(`missing ${path}`);
    return text;
  });
}

const scanner = createFirebaseScanner();
const summary = (findings: Finding[]) =>
  findings.map((f) => `${f.ruleId} ${f.severity} ${f.file}:${f.line}`).sort();

afterAll(async () => {
  await Promise.all(temps.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("createFirebaseScanner", () => {
  it("is a builtin scanner that is always available", async () => {
    expect(scanner.id).toBe("opscrew-firebase");
    expect(scanner.kind).toBe("builtin");
    expect(await scanner.isAvailable(memoryContext({}))).toBe(true);
  });

  it("flags fully open Firestore, Storage and Realtime Database rules as critical (positive)", async () => {
    const findings = await scanner.scan(await fixtureContext("open"));
    expect(summary(findings)).toEqual([
      "firebase/open-rules critical firestore.rules:5",
      "firebase/open-rules critical storage.rules:5",
      "firebase/rtdb-open critical database.rules.json:3",
      "firebase/rtdb-open critical database.rules.json:4",
    ]);
    for (const finding of findings) {
      expect(finding).toMatchObject({ category: "firebase", source: "opscrew-firebase" });
      expect(finding.id).toMatch(/^[0-9a-f]{16}$/);
      expect(finding.description.length).toBeGreaterThan(20);
      expect(finding.remediation.length).toBeGreaterThan(20);
    }
    const firestore = findings.find((f) => f.file === "firestore.rules");
    expect(firestore?.title).toBe("Cloud Firestore rules let anyone read and write /{document=**}");
    expect(findings.find((f) => f.file === "storage.rules")?.title).toContain("Cloud Storage");
  });

  it("flags expired or pending test-mode rules as critical (positive)", async () => {
    const findings = await scanner.scan(await fixtureContext("test-mode"));
    expect(summary(findings)).toEqual([
      "firebase/test-mode-rules critical database.rules.json:3",
      "firebase/test-mode-rules critical database.rules.json:4",
      "firebase/test-mode-rules critical firestore.rules:11",
    ]);
    const firestore = findings.find((f) => f.file === "firestore.rules");
    expect(firestore?.description).toContain("2025-03-07");
  });

  it("flags public reads on collections as high and follows firebase.json rule paths (positive)", async () => {
    const findings = await scanner.scan(await fixtureContext("mixed"));
    expect(summary(findings)).toEqual([
      "firebase/public-read high config/app-firestore.rules:18",
      "firebase/public-read high config/app-firestore.rules:9",
      "firebase/rtdb-open high config/rtdb-rules.json:6",
    ]);
    const titles = findings.map((f) => f.title).sort();
    expect(titles).toEqual([
      "Cloud Firestore data under /announcements/{id} is readable by everyone",
      "Cloud Firestore data under /posts/{postId} is readable by everyone",
      "Realtime Database readable by everyone at /public",
    ]);
  });

  it("does not flag owner-scoped, false or authenticated rules in the mixed project (negative)", async () => {
    const findings = await scanner.scan(await fixtureContext("mixed"));
    const evidence = findings.map((f) => f.evidence ?? "").join("\n");
    expect(evidence).not.toMatch(/\/users\/|\/drafts\/|create, update, delete/);
  });

  it("finds nothing in locked-down rules, commented-out open rules and non-Firebase .rules files (negative)", async () => {
    expect(await scanner.scan(await fixtureContext("secure"))).toEqual([]);
  });

  it("returns nothing for a project without Firebase (negative)", async () => {
    expect(
      await scanner.scan(memoryContext({ "src/index.ts": "export const rules = 'allow';\n" })),
    ).toEqual([]);
  });

  it("flags an unconditional write without read (positive)", async () => {
    const findings = await scanner.scan(
      memoryContext({
        "firestore.rules":
          "service cloud.firestore {\n  match /databases/{database}/documents {\n" +
          "    match /logs/{id} { allow create: if true; }\n  }\n}\n",
      }),
    );
    expect(summary(findings)).toEqual(["firebase/open-rules critical firestore.rules:3"]);
    expect(findings[0]?.title).toBe("Cloud Firestore rules let anyone write /logs/{id}");
  });

  it("treats public Storage reads as medium (positive)", async () => {
    const findings = await scanner.scan(
      memoryContext({
        "storage.rules":
          "service firebase.storage {\n  match /b/{bucket}/o {\n" +
          "    match /public/{file} {\n      allow read;\n      allow write: if request.auth != null;\n" +
          "    }\n  }\n}\n",
      }),
    );
    expect(summary(findings)).toEqual(["firebase/public-read medium storage.rules:4"]);
  });

  it("flags string `true` at the database root (positive) but ignores `false` and auth checks (negative)", async () => {
    const findings = await scanner.scan(
      memoryContext({
        "database.rules.json": JSON.stringify(
          { rules: { ".read": "auth != null", ".write": "true", private: { ".read": false } } },
          null,
          2,
        ),
      }),
    );
    expect(summary(findings)).toEqual(["firebase/rtdb-open critical database.rules.json:4"]);
  });

  it("ignores rules files with conditions that only look permissive (negative)", async () => {
    const findings = await scanner.scan(
      memoryContext({
        "firestore.rules":
          "service cloud.firestore {\n  match /databases/{database}/documents {\n" +
          '    match /a/{id} { allow read: if resource.data.visibility == "true"; }\n' +
          "    match /b/{id} { allow read: if true && request.auth != null; }\n" +
          "    match /c/{id} { allow write: if request.time < resource.data.lockedUntil; }\n" +
          "  }\n}\n",
      }),
    );
    expect(findings).toEqual([]);
  });

  it("ignores malformed database rules instead of throwing (negative)", async () => {
    const findings = await scanner.scan(
      memoryContext({ "database.rules.json": '{ "rules": { ".read": true, ' }),
    );
    expect(findings).toEqual([]);
  });

  it("is deterministic", async () => {
    const first = await scanner.scan(await fixtureContext("open"));
    const second = await scanner.scan(await fixtureContext("open"));
    expect(second.map((f) => f.id)).toEqual(first.map((f) => f.id));
  });
});
