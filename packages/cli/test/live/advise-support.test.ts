/** Offline checks of the advise live test's pure helpers (`advise-support.ts`). No network. */
import type { Proposal } from "@opscrew/agents";
import { describe, expect, it } from "vitest";
import {
  ADVISE_GATE,
  adviceReport,
  BALLAST_LABEL,
  BALLAST_REACHED,
  ballastCommand,
  ballastMb,
  expectedMonthly,
  headingOf,
  memoryShare,
  newAuditLines,
  notReads,
  tokenDue,
  unexpectedNotRead,
} from "./advise-support";
import { ENVIRONMENT_E2E_VARIABLES } from "./environments-support";
import { missingVariables } from "./support";

/** A cx23-sized `/proc/meminfo` (about 3.7 GiB) with `availableMb` available. */
const meminfo = (availableMb: number) =>
  [
    "MemTotal:        3884400 kB",
    "MemFree:          102400 kB",
    `MemAvailable:    ${availableMb * 1024} kB`,
    "Buffers:           20480 kB",
  ].join("\n");

const backups: Proposal = {
  id: "reliability.app.backups",
  category: "reliability",
  urgency: "when-convenient",
  server: "app",
  title: "Turn on automated backups for server app",
  reasons: [{ text: "The data is important.", figure: "important", basis: { kind: "plan" } }],
  price: { before: 4.99, after: 5.89, currency: "EUR", source: "live" },
  apply: { kind: "plan", change: { kind: "backups", server: "app", enabled: true } },
};

describe("the gate", () => {
  it("is skipped without the gate or one of the Hetzner pass's variables", () => {
    expect(missingVariables({}, ADVISE_GATE, ENVIRONMENT_E2E_VARIABLES)).toEqual([
      "OPSCREW_E2E_ADVISE=1",
      ...ENVIRONMENT_E2E_VARIABLES,
    ]);
  });
});

describe("the ballast", () => {
  it("allocates what brings the memory in use to 92% of the server", () => {
    const mb = ballastMb(meminfo(3200));
    // 3200 MiB available less 8% of 3793 MiB.
    expect(mb).toBe(2896);
    const after = memoryShare(meminfo(3200 - mb));
    expect(after).toBeGreaterThan(BALLAST_REACHED);
    expect(after).toBeCloseTo(0.92, 2);
  });

  it("refuses when too little is available to add one", () => {
    expect(() => ballastMb(meminfo(400))).toThrow(/too little to add a ballast/);
  });

  it("reads the share in use as total less available", () => {
    expect(memoryShare(meminfo(1897))).toBeCloseTo(0.5, 2);
    expect(() => memoryShare("MemTotal: 1 kB")).toThrow(/MemAvailable/);
  });

  it("starts a labelled container with no restart policy and its size passed by name", () => {
    const command = ballastCommand(2896, "node:24-alpine@sha256:abc");
    expect(command).toContain("docker run -d --restart no");
    expect(command).toContain(`--label ${BALLAST_LABEL}`);
    expect(command).toContain("-e BALLAST_MB=2896 node:24-alpine@sha256:abc node -e '");
    // One quoted script, so the remote shell expands nothing in it.
    expect(command.match(/'/g)).toHaveLength(2);
    expect(command).not.toContain("$");
  });
});

describe("adviceReport", () => {
  it("checks the report against ProposalSchema", () => {
    const report = {
      proposals: [backups],
      basis: { app: { kind: "one-reading", at: "2026-11-05T10:00:00.000Z" } },
      checked: ["the plan"],
      notRead: [],
    };
    expect(adviceReport(JSON.stringify(report))).toEqual(report);
  });

  it("refuses a proposal without reasons, naming the field and not the text", () => {
    const bad = { proposals: [{ ...backups, reasons: [] }], basis: {}, checked: [], notRead: [] };
    expect(() => adviceReport(JSON.stringify(bad))).toThrow(/proposals\.0\.reasons/);
    expect(() => adviceReport("no json, a value")).toThrow(/printed no JSON/);
    expect(() => adviceReport("no json, a value")).not.toThrow(/a value/);
  });
});

describe("expectedMonthly", () => {
  const offer = { monthly: { amount: 3.49, currency: "EUR" as const } };
  const extras = { ipv4Monthly: { amount: 0.5, currency: "EUR" as const }, backupPercent: 20 };

  it("adds the IPv4 address and, with backups, their percentage of the type's price", () => {
    expect(expectedMonthly(offer, extras, false)).toBe(3.99);
    // 20% of 3.49 is 0.698, rounded to 0.70.
    expect(expectedMonthly(offer, extras, true)).toBe(4.69);
  });

  it("refuses a list without the backup percentage", () => {
    expect(() => expectedMonthly(offer, { ipv4Monthly: extras.ipv4Monthly }, true)).toThrow(
      /backup percentage/,
    );
  });
});

describe("the audit lines", () => {
  const read = JSON.stringify({
    kind: "remote-exec",
    actor: "opscrew",
    action: "read the server's and the app's figures (read-only)",
    target: "server app",
  });
  const apply = JSON.stringify({ kind: "iac", actor: "opscrew", action: "apply" });

  it("takes each file's lines past its count before", () => {
    const before = new Map([["a.jsonl", 1]]);
    const after = new Map([
      ["a.jsonl", ["old", read]],
      ["b.jsonl", [apply]],
    ]);
    expect(newAuditLines(before, after)).toEqual([read, apply]);
  });

  it("names every entry that isn't a read-only remote command or provider call", () => {
    const providerRead = JSON.stringify({
      kind: "provider-call",
      action: "list the app's containers (read-only)",
    });
    const unlabelled = JSON.stringify({ kind: "remote-exec", action: "docker compose up" });
    expect(notReads([read, providerRead, apply, unlabelled, "{"])).toEqual([
      "iac: apply",
      "remote-exec: docker compose up",
      "an audit line that isn't JSON",
    ]);
  });
});

describe("unexpectedNotRead", () => {
  it("keeps all but DigitalOcean's live prices and an account-owned Cloudflare token's expiry", () => {
    const expected = [
      "live prices: DIGITALOCEAN_TOKEN is not set, so prices come from DigitalOcean's published price list dated 2026-10-01 and are estimates; Droplet availability is not checked. Set DIGITALOCEAN_TOKEN for live prices.",
      "the Cloudflare token's expiry: Cloudflare gives none for an account-owned token",
    ];
    const unexpected = [
      "Dependabot alerts: the GitHub token lacks the permission",
      "Hetzner Cloud's prices in nbg1: the request timed out",
    ];
    expect(unexpectedNotRead([...expected, ...unexpected])).toEqual(unexpected);
  });
});

describe("headingOf", () => {
  const text = [
    "Advise's proposals, the most urgent first:",
    "",
    "Soon:",
    "  Move server app to cx33 (4 vCPU, 8 GB memory, 80 GB disk) [size.app.larger]",
    "    Price: €4.99 → €7.99 a month (live prices)",
    "",
    "When convenient:",
    "  Turn on automated backups for server app [reliability.app.backups]",
  ].join("\n");

  it("gives the nearest heading before the id", () => {
    expect(headingOf(text, "size.app.larger")).toBe("Soon:");
    expect(headingOf(text, "reliability.app.backups")).toBe("When convenient:");
  });

  it("gives none for an id the text doesn't show, or one under no heading", () => {
    expect(headingOf(text, "security.env.dependabot-off")).toBeUndefined();
    expect(headingOf("  A title [a.b.c]", "a.b.c")).toBeUndefined();
  });
});

describe("tokenDue", () => {
  const now = new Date("2026-11-05T12:00:00Z");

  it("is due within 30 days of the expiry and never without one", () => {
    expect(tokenDue("2026-11-27T17:25:14.000Z", now)).toBe(true);
    expect(tokenDue("2026-12-06T12:00:00.000Z", now)).toBe(false);
    expect(tokenDue("2026-11-01T00:00:00.000Z", now)).toBe(true);
    expect(tokenDue(undefined, now)).toBe(false);
  });
});
