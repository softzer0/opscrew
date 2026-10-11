import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CommandResult, ScanContext } from "@opscrew/contracts";
import { fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { createGitleaksScanner } from "./gitleaks";
import { createOsvScannerCli } from "./osv-scanner";
import { relativePath } from "./shared";
import { createTrivyScanner } from "./trivy";

const FIXTURES = join(import.meta.dirname, "../../test/fixtures/external");
const ROOT = "D:/work/my-app";

function report(name: string, root = ROOT): string {
  return readFileSync(join(FIXTURES, name), "utf8").replaceAll("{{ROOT}}", root);
}

type Call = { command: string; args: readonly string[] };

/** Runner that answers each call with the next scripted result. */
function scriptedRunner(results: CommandResult[]): {
  runner: ScanContext["runner"];
  calls: Call[];
} {
  const calls: Call[] = [];
  return {
    calls,
    runner: {
      run: async (command, args) => {
        calls.push({ command, args });
        const next = results.shift();
        if (!next) throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
        return next;
      },
    },
  };
}

function context(runner: ScanContext["runner"], overrides: Partial<ScanContext> = {}): ScanContext {
  return {
    rootDir: ROOT,
    files: [
      "src/config.ts",
      "scripts/local.sh",
      "package-lock.json",
      "api/requirements.txt",
      "Dockerfile",
      "infra/main.tf",
    ],
    gitTracked: new Set(["src/config.ts", "package-lock.json", "Dockerfile", "infra/main.tf"]),
    readFile: async () => "",
    offline: false,
    fetch: async () => {
      throw new Error("no network in tests");
    },
    runner,
    ...overrides,
  };
}

const ok = (stdout: string): CommandResult => ({ exitCode: 0, stdout, stderr: "" });
const installed = (name: string) => `/usr/local/bin/${name}`;

describe("gitleaks", () => {
  it("runs `gitleaks dir` with a redacted JSON report and maps findings in scanned files", async () => {
    const { runner, calls } = scriptedRunner([ok(report("gitleaks.json"))]);
    const scanner = createGitleaksScanner({ which: installed });
    const ctx = context(runner);
    expect(await scanner.isAvailable(ctx)).toBe(true);
    const findings = await scanner.scan(ctx);

    expect(calls[0]?.command).toBe("/usr/local/bin/gitleaks");
    expect(calls[0]?.args).toEqual([
      "dir",
      ROOT,
      "--report-format",
      "json",
      "--report-path",
      "-",
      "--redact",
      "--no-banner",
      "--exit-code",
      "0",
    ]);
    // node_modules (not scanned by OpsCrew) and the malformed entry are dropped
    expect(findings.map((f) => [f.ruleId, f.file, f.line, f.severity])).toEqual([
      ["gitleaks/github-pat", "src/config.ts", 3, "critical"],
      ["gitleaks/generic-api-key", "scripts/local.sh", 1, "high"],
    ]);
    expect(findings[0]).toMatchObject({
      category: "secret",
      source: "gitleaks",
      evidence: "github-pat match (redacted)",
    });
    expect(findings[0]?.id).toMatch(/^[0-9a-f]{16}$/);
  });

  it("falls back to `gitleaks detect --no-git` on versions without the dir command", async () => {
    const { runner, calls } = scriptedRunner([
      { exitCode: 1, stdout: "", stderr: 'Error: unknown command "dir" for "gitleaks"' },
      ok("[]"),
    ]);
    expect(await createGitleaksScanner({ which: installed }).scan(context(runner))).toEqual([]);
    expect(calls[1]?.args.slice(0, 4)).toEqual(["detect", "--no-git", "--source", ROOT]);
    expect(calls[1]?.args).toContain("--redact");
  });

  it("masks a secret again when an old gitleaks ignores --redact", async () => {
    const secret = fakeSecret("github-pat");
    const leak = [
      { RuleID: "github-pat", File: `${ROOT}/src/config.ts`, StartLine: 1, Secret: secret },
    ];
    const { runner } = scriptedRunner([ok(JSON.stringify(leak))]);
    const [finding] = await createGitleaksScanner({ which: installed }).scan(context(runner));
    expect(finding?.evidence).toBe(`${secret.slice(0, 4)}…(${secret.length} chars)`);
    expect(JSON.stringify(finding)).not.toContain(secret);
  });

  it("throws on other failures and reports unavailability when the binary is missing", async () => {
    const { runner } = scriptedRunner([{ exitCode: 2, stdout: "", stderr: "permission denied" }]);
    await expect(createGitleaksScanner({ which: installed }).scan(context(runner))).rejects.toThrow(
      /gitleaks exited with code 2: permission denied/,
    );
    const missing = createGitleaksScanner({ which: () => undefined });
    expect(await missing.isAvailable(context(scriptedRunner([]).runner))).toBe(false);
  });

  it("rejects a non-JSON report", async () => {
    const { runner } = scriptedRunner([ok("not json at all")]);
    await expect(createGitleaksScanner({ which: installed }).scan(context(runner))).rejects.toThrow(
      /did not print a JSON report/,
    );
  });
});

describe("osv-scanner", () => {
  it("runs `osv-scanner scan source -r` and maps groups to one finding each", async () => {
    const { runner, calls } = scriptedRunner([
      { exitCode: 1, stdout: report("osv-scanner.json"), stderr: "Scanning…" },
    ]);
    const findings = await createOsvScannerCli({ which: installed }).scan(context(runner));
    expect(calls[0]?.args).toEqual(["scan", "source", "-r", "--format", "json", ROOT]);
    expect(findings.map((f) => [f.ruleId, f.file, f.severity, f.source])).toEqual([
      ["deps/GHSA-35jh-r3h4-6jhm", "package-lock.json", "critical", "osv-scanner"],
      ["deps/GHSA-29mw-wpgm-hmr9", "package-lock.json", "medium", "osv-scanner"],
      ["deps/CVE-2023-36053", "api/requirements.txt", "medium", "osv-scanner"],
    ]);
    expect(findings[0]?.remediation).toContain("Upgrade lodash to 4.17.21");
    expect(findings[2]?.remediation).toContain("Upgrade django to 4.2.3");
  });

  it("falls back to the v1 syntax, treats exit 128 as no packages and throws on errors", async () => {
    const legacy = scriptedRunner([
      { exitCode: 127, stdout: "", stderr: "Incorrect Usage: flag provided but not defined: -r" },
      { exitCode: 128, stdout: "", stderr: "No package sources found" },
    ]);
    expect(await createOsvScannerCli({ which: installed }).scan(context(legacy.runner))).toEqual(
      [],
    );
    expect(legacy.calls[1]?.args).toEqual(["--format", "json", "-r", ROOT]);

    const broken = scriptedRunner([
      { exitCode: 127, stdout: "", stderr: "database download failed" },
    ]);
    await expect(
      createOsvScannerCli({ which: installed }).scan(context(broken.runner)),
    ).rejects.toThrow(/osv-scanner exited with code 127/);
  });

  it("is skipped offline with a reason", async () => {
    const scanner = createOsvScannerCli({ which: installed });
    const offline = context(scriptedRunner([]).runner, { offline: true });
    expect(await scanner.isAvailable(offline)).toBe(false);
    expect(scanner.skipReason(offline)).toMatch(/Offline/);
  });
});

describe("trivy", () => {
  it("runs `trivy fs --scanners misconfig` and maps failed checks only", async () => {
    const { runner, calls } = scriptedRunner([ok(report("trivy.json"))]);
    const findings = await createTrivyScanner({ which: installed }).scan(context(runner));
    expect(calls[0]?.args).toEqual([
      "fs",
      "--scanners",
      "misconfig",
      "--format",
      "json",
      "--quiet",
      ROOT,
    ]);
    expect(findings.map((f) => [f.ruleId, f.file, f.line, f.severity, f.category])).toEqual([
      ["trivy/DS002", "Dockerfile", undefined, "high", "config"],
      ["trivy/DS001", "Dockerfile", 1, "medium", "config"],
      ["trivy/AVD-HCL-0001", "infra/main.tf", 12, "critical", "iac"],
    ]);
    expect(findings[0]).toMatchObject({
      remediation: "Add 'USER <non root user name>' line to the Dockerfile",
      references: [
        "https://avd.aquasec.com/misconfig/ds002",
        "https://docs.docker.com/develop/develop-images/dockerfile_best-practices/",
      ],
      source: "trivy",
    });
  });

  it("is skipped offline and throws when trivy fails", async () => {
    const scanner = createTrivyScanner({ which: installed });
    const offline = context(scriptedRunner([]).runner, { offline: true });
    expect(await scanner.isAvailable(offline)).toBe(false);
    expect(scanner.skipReason(offline)).toMatch(/Offline/);
    const { runner } = scriptedRunner([{ exitCode: 1, stdout: "", stderr: "FATAL fs scan error" }]);
    await expect(scanner.scan(context(runner))).rejects.toThrow(/trivy exited with code 1: FATAL/);
  });
});

describe("install hints for missing scanners (US1 AS4)", () => {
  const missing = () => undefined;
  it.each([
    [
      "gitleaks",
      createGitleaksScanner({ which: missing }),
      "https://github.com/gitleaks/gitleaks#installing",
    ],
    [
      "osv-scanner",
      createOsvScannerCli({ which: missing }),
      "https://google.github.io/osv-scanner/installation/",
    ],
    [
      "trivy",
      createTrivyScanner({ which: missing }),
      "https://trivy.dev/latest/getting-started/installation/",
    ],
  ])(
    "%s says it is not installed and how to install it, online and offline",
    async (name, scanner, url) => {
      for (const offline of [false, true]) {
        const ctx = context(scriptedRunner([]).runner, { offline });
        expect(await scanner.isAvailable(ctx)).toBe(false);
        const reason = scanner.skipReason(ctx);
        expect(reason).toContain(`${name} is not installed`);
        expect(reason).toContain(`brew install ${name}`);
        expect(reason).toContain(url);
      }
    },
  );

  it("gives no install hint when the scanner is installed", () => {
    const ctx = context(scriptedRunner([]).runner);
    expect(createGitleaksScanner({ which: installed }).skipReason(ctx)).toBeUndefined();
    expect(createOsvScannerCli({ which: installed }).skipReason(ctx)).toBeUndefined();
    expect(createTrivyScanner({ which: installed }).skipReason(ctx)).toBeUndefined();
  });
});

describe("relativePath", () => {
  it("strips the root from absolute, Windows and ./ paths", () => {
    expect(relativePath("D:/work/my-app", "D:\\work\\my-app\\src\\a.ts")).toBe("src/a.ts");
    expect(relativePath("D:/work/my-app", "d:/WORK/my-app/src/a.ts")).toBe("src/a.ts");
    expect(relativePath("/home/me/app", "/home/me/app/a/b.txt")).toBe("a/b.txt");
    expect(relativePath("/home/me/app", "./Dockerfile")).toBe("Dockerfile");
    expect(relativePath("/home/me/app", "Dockerfile")).toBe("Dockerfile");
  });
});
