/**
 * Advise's report and an applied proposal in words (US1, US2, US4), as the CLI prints them and
 * the MCP tool returns them.
 */
import { describe, expect, it } from "vitest";
import { renderAdviceReport, renderAppliedProposal } from "./render";
import type { AdviceReport, Proposal } from "./types";

const AT = "2026-11-04T12:00:00.000Z";

const LARGER: Proposal = {
  id: "size.app.larger",
  category: "size",
  urgency: "soon",
  server: "app",
  title: "Move server app to a cx33",
  reasons: [
    {
      text: "Memory in use is above 85% of the server",
      figure: "91.2% of 4 GB",
      basis: { kind: "history", days: 14 },
    },
    { text: "The app is offline one to three minutes", basis: { kind: "plan" } },
  ],
  price: { before: 3.49, after: 5.49, currency: "EUR", source: "live" },
  apply: { kind: "plan", change: { kind: "server-type", server: "app", serverType: "cx33" } },
};

const REBOOT: Proposal = {
  id: "security.app.reboot",
  category: "security",
  urgency: "now",
  server: "app",
  title: "Restart server app to finish its security updates",
  reasons: [
    {
      text: "Security updates wait for a restart",
      figure: "3 updates",
      basis: { kind: "one-reading", at: AT },
    },
  ],
  apply: { kind: "manual", text: "Restart the server from the Hetzner Cloud console." },
};

const MONITORING: Proposal = {
  id: "reliability.env.monitoring",
  category: "reliability",
  urgency: "when-convenient",
  title: "Turn on self-hosted monitoring",
  reasons: [{ text: "Nothing keeps the servers' figures", basis: { kind: "plan" } }],
  price: {
    before: 3.49,
    after: 3.49,
    currency: "USD",
    source: "static",
    asOf: "2026-06-15T00:00:00.000Z",
  },
  apply: { kind: "command", command: "opscrew addon enable monitoring --env staging" },
};

/** A report; monitoring off on a server OpsCrew created, so the closing line may apply. */
function report(over: Partial<AdviceReport> = {}): AdviceReport {
  return {
    proposals: [REBOOT, LARGER, MONITORING],
    basis: { app: { kind: "history", days: 14 } },
    checked: ["the plan", "server app's figures"],
    notRead: [],
    suggestMonitoring: true,
    ...over,
  };
}

describe("renderAdviceReport", () => {
  it("groups the proposals by urgency, each with its reasons, price and how to apply it", () => {
    const text = renderAdviceReport(report(), " --env staging");
    expect(text).toBe(
      [
        "Advise's proposals, the most urgent first:",
        "",
        "Now:",
        "  Restart server app to finish its security updates [security.app.reboot]",
        "    - Security updates wait for a restart (3 updates, one reading)",
        "    Price: no change",
        "    By hand: Restart the server from the Hetzner Cloud console.",
        "",
        "Soon:",
        "  Move server app to a cx33 [size.app.larger]",
        "    - Memory in use is above 85% of the server (91.2% of 4 GB, over 14 days)",
        "    - The app is offline one to three minutes",
        "    Price: €3.49 → €5.49 a month (live prices)",
        "    Apply: opscrew advise --apply size.app.larger --env staging",
        "",
        "When convenient:",
        "  Turn on self-hosted monitoring [reliability.env.monitoring]",
        "    - Nothing keeps the servers' figures",
        "    Price: $3.49 → $3.49 a month (static prices dated 2026-06-15)",
        "    Run: opscrew addon enable monitoring --env staging",
        "",
        "Checked: the plan and server app's figures.",
      ].join("\n"),
    );
  });

  it("labels each side's VAT when one side's price includes it", () => {
    const move: Proposal = {
      ...MONITORING,
      price: {
        before: 5.99,
        after: 5.5,
        currency: "EUR",
        source: "static",
        asOf: "2026-10-14T00:00:00.000Z",
        includesVat: { before: false, after: true },
      },
    };
    expect(renderAdviceReport(report({ proposals: [move] }), "")).toContain(
      "    Price: €5.99 (excl. VAT) → €5.50 (incl. VAT) a month (static prices dated 2026-10-14)",
    );
  });

  it("leaves out an urgency without proposals and lists what couldn't be read", () => {
    const text = renderAdviceReport(
      report({
        proposals: [LARGER],
        notRead: ["Dependabot alerts: no GitHub token is available"],
      }),
      "",
    );
    expect(text).not.toContain("Now:");
    expect(text).not.toContain("When convenient:");
    expect(text).toContain("Apply: opscrew advise --apply size.app.larger\n");
    expect(text).toContain("Couldn't read:\n  - Dependabot alerts: no GitHub token is available");
  });

  it("with no proposals, says so and what it checked", () => {
    const text = renderAdviceReport(report({ proposals: [] }), "");
    expect(text).toBe(
      [
        "Nothing to change: advise found nothing to propose.",
        "",
        "Checked: the plan and server app's figures.",
      ].join("\n"),
    );
  });

  it("with monitoring off and one reading, closes with the line on monitoring's figures", () => {
    const basis = { app: { kind: "one-reading", at: AT } } as const;
    const text = renderAdviceReport(report({ proposals: [], basis }), " --app api");
    expect(text.split("\n").at(-1)).toBe(
      "These figures are one reading. `opscrew addon enable monitoring --app api` gives two weeks of figures, so advise can also propose smaller servers.",
    );
    // With history, or without servers, no such line.
    expect(renderAdviceReport(report(), "")).not.toContain("one reading.");
    expect(renderAdviceReport(report({ basis: {} }), "")).not.toContain("one reading.");
  });

  it("has no closing line on the user's own server, nor with monitoring on and one reading", () => {
    // runAdvise sets suggestMonitoring false for both: an own server can't be resized, and
    // monitoring that is on (its history unread) needs no enabling.
    const basis = { app: { kind: "one-reading", at: AT } } as const;
    const text = renderAdviceReport(
      report({ proposals: [LARGER], basis, suggestMonitoring: false }),
      "",
    );
    expect(text).not.toContain("addon enable monitoring");
    expect(text.split("\n").at(-1)).toBe("Checked: the plan and server app's figures.");
  });

  it("adds a reason's figure after its text, with the basis of a measured one", () => {
    const token: Proposal = {
      ...REBOOT,
      reasons: [
        {
          text: "The GitHub token expires on 2026-11-07",
          figure: "in 3 days",
          basis: { kind: "account" },
        },
        {
          text: "The disk is filling",
          figure: "full in 20 days",
          basis: { kind: "history", days: 14 },
        },
      ],
    };
    const text = renderAdviceReport(report({ proposals: [token] }), "");
    expect(text).toContain("    - The GitHub token expires on 2026-11-07 (in 3 days)\n");
    expect(text).toContain("    - The disk is filling (full in 20 days, over 14 days)\n");
  });
});

describe("renderAppliedProposal", () => {
  it("gives the plan change's summary as it is", () => {
    const summary = "Changed opscrew/plan.yaml: target.backups from off to on.";
    expect(renderAppliedProposal({ plan: {} as never, summary })).toBe(summary);
  });

  it("gives the command, or what to do by hand, saying nothing was changed", () => {
    expect(renderAppliedProposal({ command: "opscrew addon enable monitoring" })).toBe(
      "Advise changed nothing: another command applies this one. Run:\n  opscrew addon enable monitoring",
    );
    expect(renderAppliedProposal({ manual: "Restart the server from its console." })).toBe(
      "Advise changed nothing: this one is done by hand.\n  Restart the server from its console.",
    );
  });
});
