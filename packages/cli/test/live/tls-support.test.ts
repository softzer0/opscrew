/**
 * Offline checks of feature 014's live helpers: the deeper checks read from the report, the origin
 * check's fallback, the leftover and zone comparisons, the minimum-TLS decision, CAA records, the
 * interruption of a load and the secret parts of the generated values. No network.
 */
import type { SharedRecord } from "@opscrew/connector-cloudflare";
import { fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { leakedLabels, Scrubber } from "./support";
import {
  caaAt,
  cloudflareSideProblems,
  deepProblems,
  deepSections,
  fromEdgeNetwork,
  generatedSecrets,
  longestInterruption,
  minTlsDecision,
  otherRecordChanges,
  tlsLeft,
  tlsLeftText,
  type ZoneRecord,
  type ZoneTls,
} from "./tls-support";

/** A report's "Deeper checks" as `opscrew secure --deep` renders it (agents' secure/report.ts). */
function report(sections: string): string {
  return [
    "# OpsCrew security report: shop",
    "",
    "## Summary",
    "",
    "| Area | Result |",
    "|---|---|",
    "| Deeper checks | 1 failed |",
    "",
    "## Deeper checks",
    "",
    "Run with `opscrew secure --deep`. They change nothing on the server.",
    "",
    sections,
    "## Code scan",
    "",
    "| Result | Severity | Check | Where | Details |",
    "|---|---|---|---|---|",
    "| **Fail** | High | Not a deeper check | x | y |",
    "",
  ].join("\n");
}

const LYNIS = [
  "### Lynis 3.1.7",
  "",
  "The server's own audit, run in a read-only container that leaves nothing behind.",
  "",
  "Hardening index: **71** of 100.",
  "",
  "| Result | Severity | Check | Where | Details |",
  "|---|---|---|---|---|",
  "| Warn | Medium | Lynis PKGS-7392 | | Vulnerable packages \\| found. |",
  "",
].join("\n");

const SSH_PASS = [
  "### ssh-audit v3.9.0",
  "",
  "The SSH service, audited from this computer.",
  "",
  "| Result | Severity | Check | Where | Details |",
  "|---|---|---|---|---|",
  '| Pass | High | SSH meets ssh-audit\'s "Hardened Ubuntu Server 24.04 LTS (version 2)" policy | server:22 | The SSH server meets the policy. |',
  "",
].join("\n");

const SSH_NOISE = [
  "### ssh-audit v3.9.0",
  "",
  "Known noise, set apart and not counted:",
  "",
  "| Check | Where | Details | Why it is set apart |",
  "|---|---|---|---|",
  '| SSH meets ssh-audit\'s "Hardened Ubuntu Server 24.04 LTS (version 2)" policy | server:22 | Host key sizes differ. | The RSA host key has 3072 bits. |',
  "",
].join("\n");

const TESTSSL_CLEAN = [
  "### testssl.sh 3.2.4",
  "",
  "| Result | Severity | Check | Where | Details |",
  "|---|---|---|---|---|",
  "| Warn | Low | TLS check cipher_order | shop.example.com (Cloudflare's edge) | No server order. |",
  "",
].join("\n");

const skipped = (tool: string) =>
  [
    `### ${tool} 1.0`,
    "",
    "| Result | Severity | Check | Where | Details |",
    "|---|---|---|---|---|",
    `| Skip | Info | ${tool} ran | | Not in a Portainer: OpsCrew has no login to the host. Nothing to do. |`,
    "",
  ].join("\n");

describe("the deeper checks in SECURITY_REPORT.md", () => {
  it("reads each tool's rows, noise and hardening index, and stops at the next section", () => {
    const sections = deepSections(report([LYNIS, SSH_NOISE, TESTSSL_CLEAN].join("\n")));
    expect(sections.map((s) => [s.tool, s.version])).toEqual([
      ["Lynis", "3.1.7"],
      ["ssh-audit", "v3.9.0"],
      ["testssl.sh", "3.2.4"],
    ]);
    expect(sections[0]?.hardeningIndex).toBe(71);
    expect(sections[0]?.rows).toEqual([
      {
        result: "Warn",
        severity: "Medium",
        check: "Lynis PKGS-7392",
        where: "",
        details: "Vulnerable packages | found.",
      },
    ]);
    expect(sections[1]?.rows).toEqual([]);
    expect(sections[1]?.noise).toHaveLength(1);
    expect(sections.flatMap((s) => s.rows).some((r) => r.check === "Not a deeper check")).toBe(
      false,
    );
    expect(deepSections("# no deeper checks\n")).toEqual([]);
  });

  it("passes a clean run, and an ssh-audit policy whose only mismatch is noise", () => {
    const all = { ran: ["lynis", "ssh-audit", "testssl"] as const };
    expect(deepProblems(report([LYNIS, SSH_PASS, TESTSSL_CLEAN].join("\n")), all)).toEqual([]);
    expect(deepProblems(report([LYNIS, SSH_NOISE, TESTSSL_CLEAN].join("\n")), all)).toEqual([]);
  });

  it("names a high testssl.sh finding, a failed policy, a skipped tool and a missing section", () => {
    const high = TESTSSL_CLEAN.replace(
      "| Warn | Low | TLS check cipher_order |",
      "| **Fail** | High | TLS check BEAST |",
    );
    const failed = SSH_PASS.replace("| Pass | High |", "| **Fail** | High |").replace(
      "The SSH server meets the policy.",
      "The SSH server does not meet the policy: Ciphers differ.",
    );
    const problems = deepProblems(report([failed, high, skipped("Lynis")].join("\n")), {
      ran: ["lynis", "ssh-audit", "testssl"],
    });
    expect(problems).toEqual([
      expect.stringContaining("Lynis did not run"),
      "Lynis gave no hardening index",
      "ssh-audit's policy test: The SSH server does not meet the policy: Ciphers differ.",
      "testssl.sh reports TLS check BEAST (High) at shop.example.com (Cloudflare's edge)",
    ]);
    expect(deepProblems(report(TESTSSL_CLEAN), { ran: ["ssh-audit"] })).toEqual([
      "the report has no section for ssh-audit",
    ]);
  });

  it("expects the tools a Portainer skips to be skipped with their reason", () => {
    const portainer = report([skipped("Lynis"), skipped("ssh-audit"), TESTSSL_CLEAN].join("\n"));
    expect(deepProblems(portainer, { ran: ["testssl"], skipped: ["lynis", "ssh-audit"] })).toEqual(
      [],
    );
    expect(
      deepProblems(report([LYNIS, skipped("ssh-audit"), TESTSSL_CLEAN].join("\n")), {
        ran: ["testssl"],
        skipped: ["lynis", "ssh-audit"],
      }),
    ).toEqual(["Lynis should be skipped with its reason here"]);
  });
});

describe("the origin check from a container on the edge's network", () => {
  const check =
    "printf 'GET / HTTP/1.1\\r\\nHost: %s\\r\\n\\r\\n' 'shop.example.com' | timeout 15 openssl s_client -connect 127.0.0.1:443 -servername 'shop.example.com' -tls1_3 -ign_eof 2>&1";

  it("sends the check to the proxy's address on the edge's network, on the container's stdin", () => {
    const command = fromEdgeNetwork(check, "nginx", "example/openssl:1@sha256:abc");
    expect(command).toMatch(
      /^printf '%s' '[A-Za-z0-9+/=]+' \| base64 -d \| docker run --rm -i --network opscrew-edge --entrypoint \/bin\/sh example\/openssl:1@sha256:abc$/,
    );
    const encoded = /'([A-Za-z0-9+/=]+)'/.exec(command)?.[1] ?? "";
    const script = Buffer.from(encoded, "base64").toString("utf8");
    expect(script).toContain("-connect nginx:8443 -servername 'shop.example.com'");
    expect(script).not.toContain("127.0.0.1");
    const caddy = fromEdgeNetwork(check, "caddy", "img");
    const caddyScript = Buffer.from(/'([A-Za-z0-9+/=]+)'/.exec(caddy)?.[1] ?? "", "base64");
    expect(caddyScript.toString("utf8")).toContain("-connect caddy:443 ");
  });

  it("refuses a check that no longer connects to 127.0.0.1:443", () => {
    expect(() =>
      fromEdgeNetwork("openssl s_client -connect localhost:443", "caddy", "img"),
    ).toThrow(/update the fallback/);
  });
});

const zone = (over: Partial<ZoneTls> = {}): ZoneTls => ({
  originCertificates: [],
  clientCertificates: [],
  hostnameSettings: [],
  minTls: { value: "1.0", editable: true },
  ...over,
});

describe("what of a run's origin TLS is left in the zone", () => {
  const run = ["e2e-abc.example.com", "www.e2e-abc.example.com"];

  it("finds the run's origin certificates, new client certificates and settings still on", () => {
    const before = zone({ clientCertificates: ["user-1"] });
    const now = zone({
      originCertificates: [
        { id: "o-run", hostnames: ["E2E-abc.example.com", "www.e2e-abc.example.com"] },
        { id: "o-other", hostnames: ["shop.example.com"] },
      ],
      clientCertificates: ["user-1", "c-run"],
      hostnameSettings: [
        { hostname: "e2e-abc.example.com", certId: "c-run", enabled: true },
        { hostname: "www.e2e-abc.example.com", certId: "c-run", enabled: null },
      ],
    });
    const left = tlsLeft(now, before, run);
    expect(left).toEqual({
      originCertificates: ["o-run"],
      clientCertificates: ["c-run"],
      hostnameSettings: ["e2e-abc.example.com"],
    });
    expect(tlsLeftText(left)).toEqual([
      "the origin certificate o-run",
      "the client certificate c-run",
      "the origin pull setting of e2e-abc.example.com",
    ]);
    expect(tlsLeftText(tlsLeft(before, before, run))).toEqual([]);
  });
});

describe("the app's origin TLS from Cloudflare's side", () => {
  const hosts = ["e2e-abc.example.com", "www.e2e-abc.example.com"];
  const record: SharedRecord = {
    zoneId: "0123456789abcdef0123456789abcdef",
    hostnames: {},
    createdEntrypoints: [],
    tls: {
      origin: {
        id: "o-1",
        hostnames: hosts,
        expiresAt: "2041-10-16T23:53:00.000Z",
        sha256: "a".repeat(64),
        superseded: [],
      },
      client: {
        id: "c-1",
        expiresAt: "2041-10-16T23:58:23.000Z",
        sha256: "b".repeat(64),
        enabled: hosts,
        retiring: [],
      },
    },
  };
  const on = (hostname: string) => ({ hostname, certId: "c-1", enabled: true });

  it("passes the record's certificates in the zone with every hostname's setting on", () => {
    const good = zone({
      originCertificates: [{ id: "o-1", hostnames: [...hosts].reverse() }],
      clientCertificates: ["c-1"],
      hostnameSettings: hosts.map(on),
    });
    expect(cloudflareSideProblems(good, record, hosts)).toEqual([]);
  });

  it("names a missing certificate, a wrong coverage, a setting off and the permission gap", () => {
    const bad = zone({
      originCertificates: [{ id: "o-1", hostnames: [hosts[0] as string] }],
      hostnameSettings: [on(hosts[0] as string), { ...on(hosts[1] as string), enabled: null }],
    });
    const gapped = { ...record, tls: { ...record.tls, gap: "permission" as const } };
    expect(cloudflareSideProblems(bad, gapped, hosts)).toEqual([
      'the record has the gap "permission"',
      "the origin certificate covers e2e-abc.example.com, not e2e-abc.example.com, www.e2e-abc.example.com",
      "the zone has no client certificate c-1",
      "the origin pull setting of www.e2e-abc.example.com is not on with the app's client certificate",
    ]);
    expect(cloudflareSideProblems(zone(), { ...record, tls: undefined }, hosts)).toEqual([
      "the record names no origin certificate",
      "the record names no client certificate",
    ]);
  });
});

describe("the zone's other records", () => {
  const record = (over: Partial<ZoneRecord>): ZoneRecord => ({
    id: "1",
    type: "A",
    name: "shop.example.com",
    content: "192.0.2.1",
    proxied: true,
    comment: null,
    ...over,
  });

  it("names changes to records off the run's hostnames by type and count only", () => {
    const own = ["e2e-abc.example.com"];
    const before = [
      record({}),
      record({ id: "2", type: "TXT", name: "example.com", content: "v=spf1 -all" }),
      record({ id: "3", type: "MX", name: "example.com", content: "mail.example.com" }),
    ];
    const after = [
      record({ content: "192.0.2.2" }),
      record({ id: "3", type: "MX", name: "example.com", content: "mail.example.com" }),
      record({ id: "4", type: "A", name: "e2e-abc.example.com", content: "198.51.100.1" }),
      record({ id: "5", type: "CAA", name: "other.example.com" }),
      record({ id: "6", type: "CAA", name: "other2.example.com" }),
    ];
    const changes = otherRecordChanges(before, after, own);
    expect(changes).toEqual([
      "a A record was changed",
      "a TXT record was removed",
      "a CAA record was added (2 times)",
    ]);
    expect(changes.join(" ")).not.toMatch(/example\.com|192\.0\.2/);
    expect(otherRecordChanges(before, before, own)).toEqual([]);
  });
});

describe("the minimum-TLS decision and CAA records", () => {
  const managed = { id: "1", type: "A", name: "a.example.com", proxied: true };

  it("raises 1.0 only when every proxied record is OpsCrew's and the setting is editable", () => {
    const ours: ZoneRecord = { ...managed, comment: "Managed by OpsCrew" };
    const theirs: ZoneRecord = { ...managed, id: "2", name: "blog.example.com", comment: null };
    const dnsOnly: ZoneRecord = { ...theirs, id: "3", proxied: false };
    const mx: ZoneRecord = { ...theirs, id: "4", type: "MX" };
    const at = (value: string, editable = true) => ({ value, editable });
    expect(minTlsDecision(at("1.0"), [ours, dnsOnly, mx])).toBe("raise");
    expect(minTlsDecision(at("1.0"), [])).toBe("raise");
    expect(minTlsDecision(at("1.0"), [ours, theirs])).toBe("advise");
    expect(minTlsDecision(at("1.0", false), [ours])).toBe("advise");
    expect(minTlsDecision(at("1.1"), [ours])).toBe("advise");
    expect(minTlsDecision(at("1.2"), [theirs])).toBe("none");
    expect(minTlsDecision(at("1.3"), [])).toBe("none");
  });

  it("lists the issue CAA records at one name, sorted, with OpsCrew's marked", () => {
    const caa = (id: string, name: string, value: string, comment: string | null): ZoneRecord => ({
      id,
      type: "CAA",
      name,
      comment,
      data: { flags: 0, tag: "issue", value },
    });
    const records = [
      caa("1", "e2e-abc.example.com", "sectigo.com", "Managed by OpsCrew"),
      caa("2", "e2e-abc.example.com", "letsencrypt.org", "Managed by OpsCrew"),
      caa("3", "example.com", "pki.goog", null),
      { ...caa("4", "e2e-abc.example.com", "mailto:x@example.com", null), data: { tag: "iodef" } },
    ];
    expect(caaAt(records, "E2E-abc.example.com")).toEqual([
      { issuer: "letsencrypt.org", opscrew: true },
      { issuer: "sectigo.com", opscrew: true },
    ]);
    expect(caaAt(records, "example.com")).toEqual([{ issuer: "pki.goog", opscrew: false }]);
    expect(caaAt(records, "nothing.example.com")).toEqual([]);
  });
});

describe("the longest interruption of a load", () => {
  const at = (ms: number) => ({
    at: new Date(Date.UTC(2026, 9, 21, 12, 0, 0) + ms).toISOString(),
    what: "HTTP 502",
  });

  it("measures the longest stretch of failures sent close together", () => {
    expect(longestInterruption([], 50)).toBe(0);
    expect(longestInterruption([at(1_000)], 50)).toBe(50);
    const failures = [at(10_000), at(10_050), at(13_000), at(1_000), at(1_050), at(4_000)];
    // 1.0–1.05 s and 4.0 s are 2.95 s apart (two stretches), 10.0–13.0 s are 2.95 s apart too.
    expect(longestInterruption(failures, 50)).toBe(100);
    expect(longestInterruption(failures, 50, 3_000)).toBe(3_050);
  });
});

describe("the secret parts of the generated values", () => {
  it("keeps every other value, and of origin TLS only the keys and the stack variable", () => {
    const key = fakeSecret("private-key-pem", "origin");
    const pullKey = fakeSecret("private-key-pem", "pull");
    const requestKey = fakeSecret("private-key-pem", "request");
    const values = {
      POSTGRES_PASSWORD: fakeSecret("generic-password", "db"),
      short: "abc",
      originTls: {
        ORIGIN_TLS_KEY: key,
        ORIGIN_TLS_CERT: "-----BEGIN CERTIFICATE-----\npublic-origin\n-----END CERTIFICATE-----\n",
        ORIGIN_PULL_KEY: pullKey,
        ORIGIN_PULL_CERT: "-----BEGIN CERTIFICATE-----\npublic-pull\n-----END CERTIFICATE-----\n",
        ORIGIN_TLS_REQUEST: {
          key: requestKey,
          csr: "-----BEGIN CERTIFICATE REQUEST-----\npublic\n-----END CERTIFICATE REQUEST-----\n",
          hostnames: ["e2e-abc.example.com"],
        },
      },
    };
    const secrets = generatedSecrets(values);
    const { originTls } = values;
    const bundle = Buffer.from(
      `${originTls.ORIGIN_TLS_CERT}${key}${originTls.ORIGIN_PULL_CERT}`,
    ).toString("base64");
    expect(secrets).toEqual([values.POSTGRES_PASSWORD, key, pullKey, requestKey, bundle]);
    expect(generatedSecrets({ A: fakeSecret("generic-password", "a") })).toHaveLength(1);
    expect(generatedSecrets(["not an object value"])).toEqual(["not an object value"]);
  });

  it("does not take a PEM armor line for a secret of its own", () => {
    const scrubber = new Scrubber();
    const key = fakeSecret("private-key-pem", "origin");
    scrubber.add(key, "origin-key");
    const armor = key.split(/\r?\n/).filter((line) => line.startsWith("-----"));
    expect(armor.length).toBeGreaterThan(0);
    const committed = `pull.pem:\n-----BEGIN CERTIFICATE-----\n${armor.join("\n")}\n`;
    expect(leakedLabels(committed, scrubber.entries())).toEqual([]);
    const line =
      key.split(/\r?\n/).find((item) => item.length >= 16 && !item.startsWith("-----")) ?? "";
    expect(line).not.toBe("");
    expect(leakedLabels(`a log with ${line} in it`, scrubber.entries())).toEqual(["origin-key"]);
  });
});
