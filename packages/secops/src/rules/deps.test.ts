import type { FetchLike, ScanContext } from "@opscrew/contracts";
import { describe, expect, it } from "vitest";
import {
  compareVersions,
  createOsvScanner,
  cvss3BaseScore,
  depsRuleId,
  fixedVersion,
  OSV_API,
  type OsvVulnerability,
  osvSeverity,
  severityFromScore,
} from "./deps";

type Call = { url: string; method: string; body?: unknown };

function context(files: Record<string, string>, overrides: Partial<ScanContext> = {}): ScanContext {
  return {
    rootDir: "/project",
    files: Object.keys(files),
    readFile: async (file) => files[file] ?? "",
    offline: false,
    fetch: async () => {
      throw new Error("unexpected fetch");
    },
    runner: { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) },
    ...overrides,
  };
}

function packageLock(packages: Record<string, string>): string {
  return JSON.stringify({
    lockfileVersion: 3,
    packages: Object.fromEntries(
      Object.entries(packages).map(([name, version]) => [`node_modules/${name}`, { version }]),
    ),
  });
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });

/** Fake OSV API: `vulnsFor(name, version)` decides which ids each queried package has. */
function fakeOsv(
  vulnsFor: (name: string, version: string) => string[],
  details: Record<string, OsvVulnerability | number>,
): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, body });
    if (url === `${OSV_API}/querybatch`) {
      const queries = (body as { queries: { package: { name: string }; version: string }[] })
        .queries;
      return json({
        results: queries.map((q) => {
          const vulns = vulnsFor(q.package.name, q.version).map((id) => ({
            id,
            modified: "2024-01-01T00:00:00Z",
          }));
          return vulns.length > 0 ? { vulns } : {};
        }),
      });
    }
    const id = decodeURIComponent(url.slice(`${OSV_API}/vulns/`.length));
    const detail = details[id];
    if (typeof detail === "number") return json({ message: "nope" }, detail);
    return detail ? json(detail) : json({ message: "not found" }, 404);
  };
  return { fetch, calls };
}

const LODASH_INJECTION: OsvVulnerability = {
  id: "GHSA-35jh-r3h4-6jhm",
  summary: "Command Injection in lodash",
  aliases: ["CVE-2021-23337"],
  database_specific: { severity: "HIGH" },
  affected: [
    {
      package: { ecosystem: "npm", name: "lodash" },
      ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "4.17.21" }] }],
    },
  ],
  references: [
    { type: "ADVISORY", url: "https://nvd.nist.gov/vuln/detail/CVE-2021-23337" },
    { type: "WEB", url: "https://example.com/blog" },
  ],
};

describe("createOsvScanner", () => {
  it("queries the batch API, fetches details and reports one finding per package and vulnerability", async () => {
    const { fetch, calls } = fakeOsv(
      (name) => (name === "lodash" ? ["GHSA-35jh-r3h4-6jhm", "PYSEC-0000-1"] : []),
      { "GHSA-35jh-r3h4-6jhm": LODASH_INJECTION },
    );
    const ctx = context(
      { "package-lock.json": packageLock({ lodash: "4.17.20", express: "4.18.2" }) },
      { fetch },
    );
    const scanner = createOsvScanner({ which: () => undefined });
    expect(await scanner.isAvailable(ctx)).toBe(true);
    const findings = await scanner.scan(ctx);

    expect(calls[0]).toMatchObject({ url: `${OSV_API}/querybatch`, method: "POST" });
    expect((calls[0]?.body as { queries: unknown[] } | undefined)?.queries).toEqual([
      { package: { name: "lodash", ecosystem: "npm" }, version: "4.17.20" },
      { package: { name: "express", ecosystem: "npm" }, version: "4.18.2" },
    ]);
    expect(findings).toHaveLength(2);
    const [injection, unknown] = findings;
    expect(injection).toMatchObject({
      ruleId: "deps/GHSA-35jh-r3h4-6jhm",
      severity: "high",
      category: "dependency",
      file: "package-lock.json",
      evidence: "lodash@4.17.20",
      source: "osv",
    });
    expect(injection?.remediation).toContain("Upgrade lodash to 4.17.21");
    expect(injection?.references).toEqual([
      "https://osv.dev/vulnerability/GHSA-35jh-r3h4-6jhm",
      "https://nvd.nist.gov/vuln/detail/CVE-2021-23337",
    ]);
    expect(injection?.id).toMatch(/^[0-9a-f]{16}$/);
    // details missing (404) → the id alone still makes a medium finding
    expect(unknown).toMatchObject({ ruleId: "deps/PYSEC-0000-1", severity: "medium" });
    expect(unknown?.remediation).toContain("No fixed version");
  });

  it("chunks batch queries at 500 packages", async () => {
    const many = Object.fromEntries(Array.from({ length: 501 }, (_, i) => [`pkg-${i}`, "1.0.0"]));
    const { fetch, calls } = fakeOsv(() => [], {});
    const findings = await createOsvScanner({ which: () => undefined }).scan(
      context({ "package-lock.json": packageLock(many) }, { fetch }),
    );
    expect(findings).toEqual([]);
    const batches = calls.filter((c) => c.url.endsWith("/querybatch"));
    expect(batches.map((c) => (c.body as { queries: unknown[] }).queries.length)).toEqual([500, 1]);
  });

  it("follows page tokens for packages with many vulnerabilities", async () => {
    let round = 0;
    const calls: Call[] = [];
    const fetch: FetchLike = async (input, init) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      calls.push({ url: String(input), method: init?.method ?? "GET", body });
      if (!String(input).endsWith("/querybatch")) return json({}, 404);
      round++;
      return round === 1
        ? json({ results: [{ vulns: [{ id: "GHSA-aaaa-aaaa-aaaa" }], next_page_token: "t1" }] })
        : json({ results: [{ vulns: [{ id: "GHSA-bbbb-bbbb-bbbb" }] }] });
    };
    const findings = await createOsvScanner({ which: () => undefined }).scan(
      context({ "package-lock.json": packageLock({ big: "1.0.0" }) }, { fetch }),
    );
    expect(findings.map((f) => f.ruleId)).toEqual([
      "deps/GHSA-aaaa-aaaa-aaaa",
      "deps/GHSA-bbbb-bbbb-bbbb",
    ]);
    expect(
      (calls[1]?.body as { queries: { page_token?: string }[] } | undefined)?.queries[0]
        ?.page_token,
    ).toBe("t1");
  });

  it("throws on network errors and HTTP failures so the engine marks the scanner failed", async () => {
    const files = { "requirements.txt": "django==4.2.1\n" };
    const offlineFetch: FetchLike = async () => {
      throw new TypeError("fetch failed");
    };
    await expect(
      createOsvScanner({ which: () => undefined }).scan(context(files, { fetch: offlineFetch })),
    ).rejects.toThrow(/Could not reach api\.osv\.dev/);
    const serverError: FetchLike = async () => json({ message: "boom" }, 503);
    await expect(
      createOsvScanner({ which: () => undefined }).scan(context(files, { fetch: serverError })),
    ).rejects.toThrow(/HTTP 503/);
  });

  it("is unavailable offline, without lockfiles, or when osv-scanner is installed — with reasons", async () => {
    const files = { "package-lock.json": packageLock({ a: "1.0.0" }) };
    const scanner = createOsvScanner({ which: () => undefined });

    const offline = context(files, { offline: true });
    expect(await scanner.isAvailable(offline)).toBe(false);
    expect(scanner.skipReason(offline)).toMatch(/Offline/);

    const empty = context({ "README.md": "" });
    expect(await scanner.isAvailable(empty)).toBe(false);
    expect(scanner.skipReason(empty)).toMatch(/No supported lockfile/);

    const superseded = createOsvScanner({
      which: (n) => (n === "osv-scanner" ? "/bin/osv-scanner" : undefined),
    });
    expect(await superseded.isAvailable(context(files))).toBe(false);
    expect(superseded.skipReason(context(files))).toMatch(/superseded by osv-scanner/i);
  });
});

describe("OSV severity and remediation helpers", () => {
  it("maps advisory labels", () => {
    for (const [label, severity] of [
      ["CRITICAL", "critical"],
      ["HIGH", "high"],
      ["MODERATE", "medium"],
      ["LOW", "low"],
    ] as const) {
      expect(osvSeverity({ id: "X", database_specific: { severity: label } })).toBe(severity);
    }
    expect(
      osvSeverity({ id: "X", affected: [{ ecosystem_specific: { severity: "moderate" } }] }),
    ).toBe("medium");
  });

  it("computes CVSS v3 base scores and maps them", () => {
    expect(cvss3BaseScore("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H")).toBe(9.8);
    expect(cvss3BaseScore("CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N")).toBe(6.1);
    expect(cvss3BaseScore("CVSS:3.0/AV:L/AC:L/PR:L/UI:N/S:U/C:H/I:N/A:N")).toBe(5.5);
    expect(cvss3BaseScore("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:N")).toBe(0);
    expect(
      cvss3BaseScore("CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N"),
    ).toBeUndefined();
    expect(cvss3BaseScore("AV:N/AC:L/Au:N/C:P/I:P/A:P")).toBeUndefined();
    expect(
      osvSeverity({
        id: "X",
        severity: [{ type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H" }],
      }),
    ).toBe("critical");
    expect(osvSeverity({ id: "X", severity: [{ type: "CVSS_V4", score: "CVSS:4.0/AV:N" }] })).toBe(
      "medium",
    );
    expect(osvSeverity({ id: "X", severity: [{ score: "7.5" }] })).toBe("high");
    expect([9, 7, 4, 0.1, 0].map(severityFromScore)).toEqual([
      "critical",
      "high",
      "medium",
      "low",
      "info",
    ]);
  });

  it("picks the lowest fixed version above the installed one", () => {
    const vuln: OsvVulnerability = {
      id: "X",
      affected: [
        {
          package: { name: "pkg" },
          ranges: [
            {
              events: [
                { introduced: "1.0.0" },
                { fixed: "1.2.5" },
                { introduced: "2.0.0" },
                { fixed: "2.0.3" },
              ],
            },
          ],
        },
        { package: { name: "other" }, ranges: [{ events: [{ fixed: "1.2.1" }] }] },
      ],
    };
    expect(fixedVersion(vuln, { name: "pkg", version: "1.2.0" })).toBe("1.2.5");
    expect(fixedVersion(vuln, { name: "pkg", version: "2.0.1" })).toBe("2.0.3");
    expect(fixedVersion(vuln, { name: "pkg", version: "3.0.0" })).toBeUndefined();
    expect(compareVersions("1.10.0", "1.9.9")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "1.0")).toBe(0);
  });

  it("prefers GHSA or CVE ids for rule ids", () => {
    expect(depsRuleId({ id: "GHSA-xxxx-yyyy-zzzz" })).toBe("deps/GHSA-xxxx-yyyy-zzzz");
    expect(depsRuleId({ id: "PYSEC-2023-100", aliases: ["CVE-2023-36053"] })).toBe(
      "deps/CVE-2023-36053",
    );
    expect(depsRuleId({ id: "RUSTSEC-2024-1" })).toBe("deps/RUSTSEC-2024-1");
  });
});
