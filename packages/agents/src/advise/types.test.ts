import { describe, expect, it } from "vitest";
import {
  applyProposal,
  componentRules,
  costRules,
  type Proposal,
  ProposalSchema,
  readHistory,
  reliabilityRules,
  runAdvise,
  sizeRules,
  THRESHOLDS,
  upkeepRules,
} from "../index";

const AT = "2026-11-05T10:00:00.000Z";

const larger: Proposal = {
  id: "size.app.larger",
  category: "size",
  urgency: "soon",
  server: "app",
  title: "Move server app to cx33",
  reasons: [
    {
      text: "Memory in use at the 95th percentile",
      figure: "90%",
      basis: { kind: "history", days: 14 },
    },
  ],
  price: { before: 4.99, after: 8.49, currency: "EUR", source: "live" },
  apply: { kind: "plan", change: { kind: "server-type", server: "app", serverType: "cx33" } },
};

const proposals: Proposal[] = [
  larger,
  {
    id: "size.app.web-limit",
    category: "size",
    urgency: "now",
    server: "app",
    title: "Raise the web process's memory limit to 768 MB",
    reasons: [{ text: "Its maximum reached its limit", basis: { kind: "one-reading", at: AT } }],
    apply: {
      kind: "plan",
      change: { kind: "memory-limit", container: { kind: "web" }, memoryMb: 768 },
    },
  },
  {
    id: "size.app.worker-limit",
    category: "size",
    urgency: "now",
    title: "Raise the worker's memory limit",
    reasons: [{ text: "3 OOM kills", figure: "3", basis: { kind: "history", days: 14 } }],
    apply: {
      kind: "plan",
      change: { kind: "memory-limit", container: { kind: "worker", name: "jobs" }, memoryMb: 384 },
    },
  },
  {
    id: "size.db.postgres-limit",
    category: "size",
    urgency: "now",
    server: "db",
    title: "Raise Postgres's memory limit",
    reasons: [{ text: "At its limit", basis: { kind: "history", days: 5 } }],
    apply: {
      kind: "plan",
      change: {
        kind: "memory-limit",
        container: { kind: "service", name: "postgres" },
        memoryMb: 1024,
      },
    },
  },
  {
    id: "reliability.app.backups",
    category: "reliability",
    urgency: "when-convenient",
    server: "app",
    title: "Turn on the server's backups",
    reasons: [{ text: "The data is important", basis: { kind: "plan" } }],
    price: { before: 4.99, after: 5.99, currency: "EUR", source: "static", asOf: "2026-10-01" },
    apply: { kind: "plan", change: { kind: "backups", server: "app", enabled: true } },
  },
  {
    id: "reliability.env.check",
    category: "reliability",
    urgency: "when-convenient",
    title: "Turn on the scheduled check",
    reasons: [{ text: "Production has no scheduled check", basis: { kind: "plan" } }],
    apply: { kind: "plan", change: { kind: "check", enabled: true } },
  },
  {
    id: "upkeep.env.github-token",
    category: "upkeep",
    urgency: "now",
    title: "Replace the GitHub token",
    reasons: [{ text: "It expires on 2026-11-09", basis: { kind: "account" } }],
    apply: { kind: "command", command: "opscrew init" },
  },
  {
    id: "security.env.dependabot",
    category: "security",
    urgency: "soon",
    title: "Turn on Dependabot alerts",
    reasons: [{ text: "Dependabot alerts are off", basis: { kind: "account" } }],
    apply: { kind: "command", command: "Settings, Code security: Dependabot alerts" },
  },
  {
    id: "cost.app.cheaper",
    category: "cost",
    urgency: "when-convenient",
    server: "app",
    title: "Move server app to cx33",
    reasons: [{ text: "The same CPUs, memory and disk cost less", basis: { kind: "plan" } }],
    price: { before: 19.49, after: 8.49, currency: "USD", source: "live" },
    apply: { kind: "plan", change: { kind: "server-type", server: "app", serverType: "cx33" } },
  },
  {
    id: "components.db.own-server",
    category: "components",
    urgency: "when-convenient",
    server: "app",
    title: "Give Postgres its own server",
    reasons: [{ text: "Postgres uses most of the memory", basis: { kind: "history", days: 14 } }],
    apply: { kind: "command", command: "opscrew design" },
  },
  {
    id: "moving.env.retarget",
    category: "moving",
    urgency: "when-convenient",
    title: "Move to DigitalOcean",
    reasons: [{ text: "The same need costs less there", basis: { kind: "plan" } }],
    apply: { kind: "command", command: "opscrew retarget" },
  },
];

describe("ProposalSchema", () => {
  it.each(proposals.map((p) => [p.id, p] as const))("parses %s", (_id, proposal) => {
    expect(ProposalSchema.parse(proposal)).toEqual(proposal);
  });

  it("covers every category, urgency, basis and plan change", () => {
    const kinds = (pick: (p: Proposal) => string | undefined) =>
      new Set(proposals.map(pick).filter((k) => k !== undefined));
    expect(kinds((p) => p.category).size).toBe(7);
    expect(kinds((p) => p.urgency).size).toBe(3);
    expect(new Set(proposals.flatMap((p) => p.reasons.map((r) => r.basis.kind))).size).toBe(4);
    expect(kinds((p) => (p.apply.kind === "plan" ? p.apply.change.kind : undefined)).size).toBe(4);
    expect(kinds((p) => p.apply.kind).size).toBe(2);
  });

  const malformed: [string, unknown][] = [
    ["an unknown category", { ...larger, category: "speed" }],
    ["an unknown urgency", { ...larger, urgency: "later" }],
    ["no reasons", { ...larger, reasons: [] }],
    ["a reason without a basis", { ...larger, reasons: [{ text: "high" }] }],
    ["an unknown basis", { ...larger, reasons: [{ text: "high", basis: { kind: "guess" } }] }],
    [
      "a history without days",
      { ...larger, reasons: [{ text: "high", basis: { kind: "history" } }] },
    ],
    ["an empty title", { ...larger, title: "" }],
    ["a missing id", { ...larger, id: undefined }],
    ["a price in another currency", { ...larger, price: { ...larger.price, currency: "GBP" } }],
    ["a price without a source", { ...larger, price: { before: 1, after: 2, currency: "EUR" } }],
    ["an unknown apply", { ...larger, apply: { kind: "shell", command: "rm" } }],
    ["a command apply without a command", { ...larger, apply: { kind: "command" } }],
    [
      "an unknown plan change",
      { ...larger, apply: { kind: "plan", change: { kind: "region", region: "nbg1" } } },
    ],
    [
      "a server type without a type",
      { ...larger, apply: { kind: "plan", change: { kind: "server-type", server: "app" } } },
    ],
    [
      "a memory limit that is not a whole number",
      {
        ...larger,
        apply: {
          kind: "plan",
          change: { kind: "memory-limit", container: { kind: "web" }, memoryMb: 1.5 },
        },
      },
    ],
    [
      "a memory limit for a worker without its name",
      {
        ...larger,
        apply: {
          kind: "plan",
          change: { kind: "memory-limit", container: { kind: "worker" }, memoryMb: 512 },
        },
      },
    ],
    [
      "backups turned off",
      {
        ...larger,
        apply: { kind: "plan", change: { kind: "backups", server: "app", enabled: false } },
      },
    ],
    [
      "the check turned off",
      { ...larger, apply: { kind: "plan", change: { kind: "check", enabled: false } } },
    ],
  ];

  it.each(malformed)("refuses %s", (_what, value) => {
    expect(ProposalSchema.safeParse(value).success).toBe(false);
  });
});

describe("THRESHOLDS", () => {
  it("holds the data model's values and cannot be changed", () => {
    expect(THRESHOLDS).toEqual({
      historyDays: 14,
      minHistoryDaysToShrink: 7,
      percentile: 0.95,
      memoryHigh: 0.85,
      loadHighShare: 0.25,
      shrinkHeadroom: 0.4,
      containerAtLimit: 0.95,
      limitRaise: 1.5,
      diskHigh: 0.85,
      diskFullDays: 30,
      diskFullDaysNow: 7,
      restarts: 3,
      checkFlaps: 3,
      tokenDays: 30,
      tokenDaysNow: 7,
      databaseShare: 0.5,
    });
    expect(Object.isFrozen(THRESHOLDS)).toBe(true);
  });
});

describe("the stubs", () => {
  it("are exported from the agents root for the waves to fill", () => {
    const stubs = [
      readHistory,
      sizeRules,
      costRules,
      reliabilityRules,
      upkeepRules,
      componentRules,
    ];
    for (const stub of [...stubs, runAdvise, applyProposal]) expect(stub).toBeTypeOf("function");
  });
});
