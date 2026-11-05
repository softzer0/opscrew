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
  | { kind: "memory-limit"; container: { kind: "web" } | { kind: "worker" | "service"; name: string }; memoryMb: number }
  | { kind: "backups"; server: string; enabled: true }
  | { kind: "check"; enabled: true };
export interface Proposal {
  id: string; category: ProposalCategory; urgency: Urgency; server?: string;
  title: string; reasons: Reason[]; price?: ProposalPrice;
  apply: { kind: "plan"; change: PlanChange } | { kind: "command"; command: string } | { kind: "manual"; text: string };
}
export const URGENCIES, CATEGORIES;                         // each list once; the types come from the schemas (z.infer)
export const ProposalSchema;                                // the tests check every proposal against it
export const THRESHOLDS: Readonly<{ ... }>;                  // data-model.md
export interface ServerHistory {                             // T2104 fills
  days: number; cpuP95?: number; memoryP95?: number; loadOverCpus?: number; diskFullInDays?: number;
  notRead?: string[];                                        // a query that failed, figures that stopped (no address)
  containers: { service: string; memoryP95?: number; memoryMax?: number; limit?: number; restarts?: number; oomKills?: number }[];
}
export interface Readings { at: string; flags: string; ... } // `at`: when read (deps.clock, ISO); `flags`: commandFlags; per server now/history, plan, requirements, prices, upkeep, check, notRead
export interface AdviceReport { proposals: Proposal[]; basis: Record<string, Basis>; checked: string[]; notRead: string[]; suggestMonitoring: boolean }
```

```ts
// T2104
readHistory(deps, plan, services?): Promise<Record<string, ServerHistory> | undefined>;   // undefined without monitoring; services: test seam, as monitoringStatus
// T2105, T2106: pure
sizeRules(readings): Proposal[]; costRules(readings): Proposal[];
reliabilityRules(readings): Proposal[]; upkeepRules(readings): Proposal[]; componentRules(readings): Proposal[];
// T2107
runAdvise(deps, plan, options?): Promise<AdviceReport>;          // options: services, github, cloudflare seams (RunAdviseOptions)
applyProposal(deps, plan, id, options?): Promise<AppliedProposal>;
type AppliedProposal = { plan: DeployPlan; summary: string } | { command: string } | { manual: string };
```

## connectors (T2103)

```ts
// @opscrew/connector-github
dependabotAlerts(owner, repo): Promise<
  | { state: "on"; alerts: { severity: "critical" | "high" | "medium" | "low"; package: string; url: string }[] }
  | { state: "off" }                             // 403 "Dependabot alerts are disabled for this repository."
>;
// any other 403 throws OpsCrewError("CREDENTIALS_INVALID", …) through the connector's missing-permission
// helper, naming "Dependabot alerts: Read" (R5, S3); GITHUB_TOKEN_PERMISSIONS lists it as optional
dependabotPulls(owner, repo): Promise<{ number: number; title: string; createdAt: string; url: string }[]>;
issuesSince(owner, repo, label, since): Promise<{ number: number; createdAt: string; closedAt?: string }[]>;
// opened since `since`: GitHub's own `since` filters by the last update, so the connector filters again
tokenExpiry(): Promise<string | undefined>;   // GitHub-Authentication-Token-Expiration ("2026-11-27 17:25:14 UTC") as ISO 8601

// @opscrew/connector-cloudflare
verifyToken(): Promise<CloudflareTokenCheck>;   // the existing CredentialCheck plus status? and expiresOn?
// an account-owned token is verified through the zone list: no expiry, listed as not read
```

## CLI and MCP (T2108)

- `opscrew advise [--apply <id>] [--json] [--app <name>] [--env <name>]`
- MCP `opscrew_advise` (`projectDir`, `app`, `env`), read only.
- Both print `renderAdviceReport(report, flags)` and `renderAppliedProposal(applied)` from agents' `advise/render.ts`; the closing monitoring line when `report.suggestMonitoring` (Hetzner and DigitalOcean servers without monitoring, on one reading).
