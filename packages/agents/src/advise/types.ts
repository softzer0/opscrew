/**
 * Advise's types (feature 021): the proposals it lists, the readings its rules read and the
 * thresholds they apply (data-model.md, contracts/advise.md).
 */
import type { DependabotAlerts, DependabotPull, IssueDates } from "@opscrew/connector-github";
import type { CheckResult, ComputeOffer, ProviderExtras, ProviderId } from "@opscrew/contracts";
import type { DeployPlan, Requirements } from "@opscrew/plan-schema";
import { z } from "zod";
import type { ResourceReading } from "../status";

/**
 * The urgencies, most urgent first. `now`: about to break; `soon`: security findings, a filling
 * disk, over budget; the rest later.
 */
export const URGENCIES = ["now", "soon", "when-convenient"] as const;

/**
 * What a proposal is about, in the order proposals of one urgency are listed: a move in progress
 * first, then a server's size, security, upkeep, savings, and the rest (US1-3).
 */
export const CATEGORIES = [
  "moving",
  "size",
  "security",
  "upkeep",
  "cost",
  "reliability",
  "components",
] as const;

const BasisSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("history"), days: z.number().nonnegative() }),
  z.object({ kind: z.literal("one-reading"), at: z.string().min(1) }),
  z.object({ kind: z.literal("plan") }),
  z.object({ kind: z.literal("account") }),
]);

const ReasonSchema = z.object({
  text: z.string().min(1),
  figure: z.string().min(1).optional(),
  basis: BasisSchema,
});

const PriceSchema = z.object({
  before: z.number().nonnegative(),
  after: z.number().nonnegative(),
  currency: z.enum(["EUR", "USD"]),
  source: z.enum(["live", "static"]),
  asOf: z.string().min(1).optional(),
});

const PlanChangeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("server-type"),
    server: z.string().min(1),
    serverType: z.string().min(1),
  }),
  z.object({
    kind: z.literal("memory-limit"),
    container: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("web") }),
      z.object({ kind: z.enum(["worker", "service"]), name: z.string().min(1) }),
    ]),
    memoryMb: z.number().int().positive(),
  }),
  z.object({ kind: z.literal("backups"), server: z.string().min(1), enabled: z.literal(true) }),
  z.object({ kind: z.literal("check"), enabled: z.literal(true) }),
]);

/** A proposal as `--json` and the MCP tool give it. */
export const ProposalSchema = z.object({
  /** `<category>.<server or "env">.<what>`, stable across runs. */
  id: z.string().min(1),
  category: z.enum(CATEGORIES),
  urgency: z.enum(URGENCIES),
  /** The plan's name of the server it concerns (`app` or an extra server). */
  server: z.string().min(1).optional(),
  title: z.string().min(1),
  reasons: z.array(ReasonSchema).min(1),
  price: PriceSchema.optional(),
  /** A plan edit, a command to run, or, with nothing to type, what to do by hand. */
  apply: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("plan"), change: PlanChangeSchema }),
    z.object({ kind: z.literal("command"), command: z.string().min(1) }),
    z.object({ kind: z.literal("manual"), text: z.string().min(1) }),
  ]),
});

/** What a proposal is about. */
export type ProposalCategory = (typeof CATEGORIES)[number];
/** How soon a proposal matters. */
export type Urgency = (typeof URGENCIES)[number];
/** Where a reason's figure comes from. */
export type Basis = z.infer<typeof BasisSchema>;
/** One sentence of why, with its figure. */
export type Reason = z.infer<typeof ReasonSchema>;
/** The monthly net price before and after the proposal. */
export type ProposalPrice = z.infer<typeof PriceSchema>;
/** A plan edit `opscrew advise --apply` can make. */
export type PlanChange = z.infer<typeof PlanChangeSchema>;
/** One proposal. */
export type Proposal = z.infer<typeof ProposalSchema>;

/** The rules' thresholds (data-model.md "The thresholds"; the guide states them). */
export const THRESHOLDS = Object.freeze({
  /** The history queries' window, in days. */
  historyDays: 14,
  /** Never a smaller server with fewer days of history. */
  minHistoryDaysToShrink: 7,
  /** The percentile of CPU, memory and a container's memory. */
  percentile: 0.95,
  /** Memory p95 above this share of the server: a larger server. */
  memoryHigh: 0.85,
  /** The 15-minute load above the CPUs for this share of the period: a larger server. */
  loadHighShare: 0.25,
  /** A smaller type holds the p95 with this headroom. */
  shrinkHeadroom: 0.4,
  /** A container's maximum at this share of its limit (or any OOM kill): at its limit. */
  containerAtLimit: 0.95,
  /** The proposed limit: this times the current one, rounded up to 64 MB. */
  limitRaise: 1.5,
  /** A disk this full now. */
  diskHigh: 0.85,
  /** A disk full within this many days (`soon`). */
  diskFullDays: 30,
  /** A disk full within this many days (`now`). */
  diskFullDaysNow: 7,
  /** Restarts of one container in the period: a restart loop. */
  restarts: 3,
  /** The check's issues opened in the period: a flapping check. */
  checkFlaps: 3,
  /** A token expiring within this many days (`soon`). */
  tokenDays: 30,
  /** A token expiring within this many days (`now`). */
  tokenDaysNow: 7,
  /** Postgres's share of a short server's memory (p95 of its container): its own server. */
  databaseShare: 0.5,
});

/** A server's 14 days from the self-hosted stack (shares 0–1, memory in bytes). */
export interface ServerHistory {
  /** How far back the figures go. */
  days: number;
  cpuP95?: number;
  memoryP95?: number;
  /** The share of the period the 15-minute load passed the CPUs. */
  loadOverCpus?: number;
  /** Absent for a disk that isn't filling. */
  diskFullInDays?: number;
  containers: {
    service: string;
    memoryP95?: number;
    memoryMax?: number;
    limit?: number;
    restarts?: number;
    oomKills?: number;
  }[];
  /**
   * What couldn't be read, in plain words for the report: a query that failed (its figure is then
   * absent), or figures that stopped (then no limit and no disk trend).
   */
  notRead?: string[];
}

/** One server's readings: the moment `status` reads, and its history when the stack has one. */
export interface ServerReadings {
  now: ResourceReading;
  history?: ServerHistory;
}

/** One provider's offers and extra costs in one location, from its catalogue. */
export interface PriceList {
  provider: ProviderId;
  location: string;
  offers: ComputeOffer[];
  extras: ProviderExtras;
}

/** Everything advise's rules read, gathered once per run. */
export interface Readings {
  /** When the readings were taken (ISO 8601). */
  at: string;
  /** Per server, by the plan's name (`app` or an extra server). */
  servers: Record<string, ServerReadings>;
  plan: DeployPlan;
  /**
   * The memory limits of the previews another environment runs on this environment's server
   * (spec.md US9), in MB: the app's server holds them too.
   */
  sharedPreviewsMb?: number;
  requirements?: Requirements;
  prices: PriceList[];
  upkeep: {
    /** Absent when it couldn't be read (then listed in `notRead`). */
    dependabot?: DependabotAlerts;
    /** Dependabot's open pull requests. */
    pulls: DependabotPull[];
    /** The tokens' expiry, ISO 8601, for the tokens that have one. */
    tokens: { service: "github" | "cloudflare"; expiresAt: string }[];
    /** `secure`'s host checks per server, by the plan's name. */
    hostChecks: Record<string, CheckResult[]>;
  };
  /** The scheduled check's issues opened in the period; absent when not read. */
  check?: IssueDates[];
  /** What couldn't be read, each with why. */
  notRead: string[];
  /**
   * What every `opscrew` command a proposal names adds: ` --app …`/` --env …` from commandFlags,
   * empty for the default.
   */
  flags: string;
}

/** What `opscrew advise` reports. */
export interface AdviceReport {
  /** Ordered by urgency, then category. */
  proposals: Proposal[];
  /** Per server: `history` with its days, or `one-reading`. */
  basis: Record<string, Basis>;
  /** What was read. */
  checked: string[];
  /** What couldn't be read, each with why. */
  notRead: string[];
  /**
   * Monitoring is off and the app's server is one OpsCrew created (Hetzner or DigitalOcean): its
   * 14 days of figures would let advise also propose a smaller server.
   */
  suggestMonitoring: boolean;
}
