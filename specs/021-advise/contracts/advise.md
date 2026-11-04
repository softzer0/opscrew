# Contract: advise

## agents (T2102: types and stubs)

```ts
// agents/src/advise/types.ts, exported from the agents root
export type ProposalCategory = "size" | "cost" | "reliability" | "upkeep" | "security" | "components" | "moving";
export type Urgency = "now" | "soon" | "when-convenient";
export type Basis =
  | { kind: "history"; days: number }
  | { kind: "one-reading"; at: string }
  | { kind: "plan" }
  | { kind: "account" };
export interface Reason { text: string; figure?: string; basis: Basis }
export interface ProposalPrice { before: number; after: number; currency: "EUR" | "USD"; source: "live" | "static"; asOf?: string }
export type PlanChange =
  | { kind: "server-type"; server: string; serverType: string }
  | { kind: "backups"; server: string; enabled: true }
  | { kind: "check"; enabled: true };
export interface Proposal {
  id: string; category: ProposalCategory; urgency: Urgency; server?: string;
  title: string; reasons: Reason[]; price?: ProposalPrice;
  apply: { kind: "plan"; change: PlanChange } | { kind: "command"; command: string };
}
export const ProposalSchema: z.ZodType<Proposal>;           // for the CLI's --json and MCP
export const THRESHOLDS: Readonly<{ ... }>;                  // data-model.md
export interface ServerHistory {                             // T2104 fills
  days: number; cpuP95?: number; memoryP95?: number; loadOverCpus?: number; diskFullInDays?: number;
  containers: { service: string; memoryP95?: number; memoryMax?: number; limit?: number; restarts?: number }[];
}
export interface Readings { ... }                            // per server now/history, plan, requirements, prices, upkeep, check, notRead
export interface AdviceReport { proposals: Proposal[]; basis: Record<string, Basis>; checked: string[]; notRead: string[] }
```

```ts
// T2104
readHistory(deps, plan): Promise<Record<string, ServerHistory> | undefined>;   // undefined without monitoring
// T2105, T2106: pure
sizeRules(readings): Proposal[]; costRules(readings): Proposal[];
reliabilityRules(readings): Proposal[]; upkeepRules(readings): Proposal[]; componentRules(readings): Proposal[];
// T2107
runAdvise(deps, plan, options?): Promise<AdviceReport>;
applyProposal(deps, plan, id): Promise<{ plan: DeployPlan; summary: string } | { command: string }>;
```

## connectors (T2103)

```ts
// @opscrew/connector-github
dependabotAlerts(owner, repo): Promise<{ severity: "critical" | "high" | "medium" | "low"; package: string; url: string }[]>;
// throws OpsCrewError("PERMISSION_DENIED", …) naming "Dependabot alerts: read" on 403
dependabotPulls(owner, repo): Promise<{ number: number; title: string; createdAt: string; url: string }[]>;
issuesSince(owner, repo, label, since): Promise<{ number: number; createdAt: string; closedAt?: string }[]>;
tokenExpiry(): Promise<string | undefined>;   // from GitHub-Authentication-Token-Expiration, ISO date

// @opscrew/connector-cloudflare
verifyToken(): Promise<{ status: "active" | "disabled" | "expired"; expiresOn?: string }>;
```

## CLI and MCP (T2108)

- `opscrew advise [--apply <id>] [--json] [--app <name>] [--env <name>]`
- MCP `opscrew_advise` (`projectDir`, `app`, `env`), read only.
