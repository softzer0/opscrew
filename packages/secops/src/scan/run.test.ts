import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Finding, ScanContext, Scanner } from "@opscrew/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createConfigScanner } from "../rules/config";
import { createSecretsScanner } from "../rules/secrets";
import { createFinding } from "./finding";
import { dedupeFindings, runScan, type ScannerSkipReason, type ScanProgressEvent } from "./run";
import {
  expectNoFakeValues,
  failingRunner,
  gitRunner,
  keys,
  type MaterializedFixture,
  materialize,
  noFetch,
} from "./test-utils";

let fixture: MaterializedFixture | undefined;
afterEach(async () => {
  await fixture?.cleanup();
  fixture = undefined;
});

const TRACKED = [".env", ".gitignore", "Dockerfile", "package.json", "src/server.js"];

async function setup(): Promise<MaterializedFixture> {
  fixture = await materialize("scan/app");
  await mkdir(path.join(fixture.dir, ".git"));
  return fixture;
}

function fakeScanner(
  id: string,
  scan: (context: ScanContext) => Promise<Finding[]>,
  options: { kind?: Scanner["kind"]; available?: boolean; skipReason?: string } = {},
): Scanner & ScannerSkipReason {
  const scanner: Scanner & ScannerSkipReason = {
    id,
    kind: options.kind ?? "builtin",
    isAvailable: async () => options.available ?? true,
    scan,
  };
  if (options.skipReason !== undefined) {
    const reason = options.skipReason;
    scanner.skipReason = () => reason;
  }
  return scanner;
}

function external(
  source: string,
  overrides: Partial<Omit<Finding, "id">> & { ruleId: string },
): Finding {
  return createFinding({
    title: "external",
    severity: "high",
    category: "secret",
    description: "found by an external tool",
    remediation: "fix it",
    source,
    rawMatch: `${source}:${overrides.ruleId}:${overrides.file}:${overrides.line}`,
    ...overrides,
  });
}

const fixedClock = () => {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 9, 11, 12, 0, tick++));
};

describe("runScan", () => {
  it("runs the built-in scanners and builds a sorted, counted, deduplicated report", async () => {
    const { dir, fakes } = await setup();
    const report = await runScan(dir, {
      offline: true,
      fetch: noFetch,
      runner: gitRunner(TRACKED),
      scanners: [createSecretsScanner(), createConfigScanner()],
      version: "0.1.0-test",
      now: fixedClock(),
    });
    expect(report.tool).toBe("opscrew");
    expect(report.version).toBe("0.1.0-test");
    expect(report.project).toBe("app");
    expect(report.startedAt).toBe("2026-10-11T12:00:00.000Z");
    expect(report.finishedAt).toBe("2026-10-11T12:00:01.000Z");
    expect(report.findings.map((f) => `${f.severity} ${f.ruleId}@${f.file}:${f.line}`)).toEqual([
      "critical secrets/committed-env@.env:1",
      "critical secrets/stripe-secret-key@.env:1",
      "critical secrets/github-token@src/server.js:4",
      "medium config/dockerfile-root@Dockerfile:1",
    ]);
    expect(report.counts).toEqual({ critical: 3, high: 0, medium: 1, low: 0, info: 0 });
    expect(report.scanners).toEqual([
      { id: "opscrew-secrets", status: "ran", durationMs: expect.any(Number) },
      { id: "opscrew-config", status: "ran", durationMs: expect.any(Number) },
    ]);
    expectNoFakeValues(report.findings, fakes);
    const json = JSON.stringify(report);
    for (const fake of fakes) expect(json).not.toContain(fake);
    expect(json).not.toContain(dir);
    expect(json).not.toContain(dir.replace(/\\/g, "/"));
  });

  it("isolates failures and explains skipped scanners", async () => {
    const { dir } = await setup();
    const report = await runScan(dir, {
      offline: true,
      fetch: noFetch,
      runner: failingRunner,
      version: "0.1.0",
      scanners: [
        fakeScanner("boom", async (context) => {
          throw new Error(`could not read ${path.join(context.rootDir, "src", "server.js")}`);
        }),
        fakeScanner("gitleaks", async () => [], { kind: "external", available: false }),
        fakeScanner("osv", async () => [], {
          available: false,
          skipReason: "Skipped in offline mode.",
        }),
        fakeScanner("quiet", async () => [], { available: false }),
        fakeScanner("ok", async () => [
          external("ok", { ruleId: "config/x", category: "config", file: "a", line: 1 }),
        ]),
      ],
    });
    const byId = Object.fromEntries(report.scanners.map((s) => [s.id, s]));
    expect(byId.boom?.status).toBe("failed");
    expect(byId.boom?.reason).toMatch(/^boom failed: could not read src[\\/]server\.js$/);
    expect(byId.gitleaks).toEqual({
      id: "gitleaks",
      status: "skipped",
      reason: "gitleaks is not installed; install it for extra coverage.",
    });
    expect(byId.osv).toEqual({ id: "osv", status: "skipped", reason: "Skipped in offline mode." });
    expect(byId.quiet?.status).toBe("skipped");
    expect(byId.quiet?.reason).toBeTruthy();
    expect(byId.ok?.status).toBe("ran");
    expect(report.scanners.map((s) => s.id)).toEqual(["boom", "gitleaks", "osv", "quiet", "ok"]);
    expect(report.findings).toHaveLength(1);
  });

  it("runs at most four scanners at a time and reports progress", async () => {
    const { dir } = await setup();
    let active = 0;
    let peak = 0;
    const slow = (id: string) =>
      fakeScanner(id, async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 15));
        active--;
        return [];
      });
    const events: ScanProgressEvent[] = [];
    const report = await runScan(dir, {
      offline: true,
      fetch: noFetch,
      runner: failingRunner,
      version: "0.1.0",
      scanners: Array.from({ length: 9 }, (_, index) => slow(`s${index}`)),
      onProgress: (event) => {
        events.push(event);
        throw new Error("a broken progress callback must not stop the scan");
      },
    });
    expect(peak).toBe(4);
    expect(report.scanners.every((s) => s.status === "ran")).toBe(true);
    expect(events.filter((e) => e.type === "started")).toHaveLength(9);
    expect(events.filter((e) => e.type === "finished")).toHaveLength(9);
    expect(events.find((e) => e.type === "finished")).toMatchObject({ status: "ran", findings: 0 });
  });

  it("deduplicates across scanners, keeps the most severe and normalises paths", async () => {
    const { dir } = await setup();
    const absolute = path.join(dir, "src", "server.js");
    const report = await runScan(dir, {
      offline: true,
      fetch: noFetch,
      runner: gitRunner(TRACKED),
      version: "0.1.0",
      scanners: [
        createSecretsScanner(),
        fakeScanner(
          "gitleaks",
          async () => [
            // Same leaked token as opscrew-secrets, reported with an absolute path: duplicate.
            external("gitleaks", {
              ruleId: "gitleaks/github-pat",
              file: absolute,
              line: 4,
              description: `Found in ${absolute}`,
            }),
            // Outside the project: the file is dropped, the finding stays.
            external("gitleaks", {
              ruleId: "gitleaks/generic",
              file: path.join(path.dirname(dir), "elsewhere.txt"),
              line: 1,
              severity: "low",
            }),
          ],
          { kind: "external" },
        ),
        fakeScanner("trivy", async () => [
          external("trivy", {
            ruleId: "config/dockerfile-root",
            category: "config",
            file: "./Dockerfile",
            line: 1,
            severity: "high",
          }),
        ]),
        createConfigScanner(),
      ],
    });
    expect(keys(report.findings)).toEqual(
      [
        "secrets/committed-env@.env:1",
        "secrets/stripe-secret-key@.env:1",
        "secrets/github-token@src/server.js:4",
        "config/dockerfile-root@Dockerfile:1",
        "gitleaks/generic@:",
      ].sort(),
    );
    const root = report.findings.find((f) => f.ruleId === "config/dockerfile-root");
    expect(root?.source).toBe("trivy");
    expect(root?.severity).toBe("high");
    expect(JSON.stringify(report)).not.toContain(dir);
  });

  it("masks secret-shaped text that a scanner forgot to mask", async () => {
    const { dir, fakes } = await setup();
    const leaky = fakes.find((fake) => fake.startsWith("ghp_")) ?? "";
    const report = await runScan(dir, {
      offline: true,
      fetch: noFetch,
      runner: failingRunner,
      version: "0.1.0",
      scanners: [
        fakeScanner("leaky", async () => [
          external("leaky", {
            ruleId: "leaky/x",
            file: "src/server.js",
            line: 4,
            evidence: leaky,
            description: `token ${leaky}`,
          }),
        ]),
      ],
    });
    expectNoFakeValues(report.findings, fakes);
  });

  it("rejects a root that is not a directory", async () => {
    await expect(
      runScan(path.join(process.cwd(), "does-not-exist"), {
        offline: true,
        fetch: noFetch,
        runner: failingRunner,
        version: "0.1.0",
        scanners: [],
      }),
    ).rejects.toThrow(/not a directory/);
  });
});

describe("dedupeFindings", () => {
  const base = { title: "t", description: "d", remediation: "r", rawMatch: "" };

  it("drops repeated ids and same-rule duplicates at one location", () => {
    const a = createFinding({
      ...base,
      ruleId: "config/x",
      severity: "low",
      category: "config",
      file: "f",
      line: 1,
      source: "s",
      rawMatch: "1",
    });
    const b = { ...a, id: "other", severity: "high" as const };
    expect(dedupeFindings([a, a, b])).toEqual([b]);
  });

  it("keeps different rules of one scanner at the same line", () => {
    const shared = { ...base, severity: "high" as const, file: "f", line: 1, source: "s" };
    const findings = [
      createFinding({ ...shared, ruleId: "secrets/a", category: "secret", rawMatch: "1" }),
      createFinding({ ...shared, ruleId: "secrets/b", category: "secret", rawMatch: "2" }),
    ];
    expect(dedupeFindings(findings)).toHaveLength(2);
  });

  it("treats the config and Supabase client-exposed env rules as one family", () => {
    const shared = { ...base, severity: "critical" as const, file: ".env", line: 2 };
    const findings = [
      createFinding({
        ...shared,
        ruleId: "config/client-exposed-secret",
        category: "config",
        source: "opscrew-config",
      }),
      createFinding({
        ...shared,
        ruleId: "supabase/service-role-env-exposed",
        category: "supabase",
        source: "opscrew-supabase",
      }),
    ];
    expect(dedupeFindings(findings).map((f) => f.ruleId)).toEqual(["config/client-exposed-secret"]);
  });
});
