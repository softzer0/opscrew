# Contract: self-hosted monitoring

## plan-schema (T2002)

```ts
export const MONITORING_PUSH_PORT = 9091;      // the front, on each private address
export const MONITORING_GRAFANA_PORT = 3000;   // Grafana, on 127.0.0.1 and each private address
export const MONITORING_SERVER = "monitoring"; // the default extra server's name

export const MonitoringWhereSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("server"), server: ServerNameSchema }),
  z.strictObject({ kind: z.literal("app") }),
  z.strictObject({
    kind: z.literal("shared"),
    owner: z.strictObject({ plan: RepoPathSchema, server: ServerNameSchema }),
  }),
]);

export const MonitoringSchema = z.strictObject({
  enabled: z.boolean().default(false),
  where: MonitoringWhereSchema,
  versions: z.strictObject({ prometheus: z.string(), loki: z.string(), grafana: z.string(), alloy: z.string() }),
  retention: z.strictObject({
    metricsDays: z.int().min(1).max(90).default(15),
    logsDays: z.int().min(1).max(30).default(7),
    metricsMaxGb: z.int().min(1),
  }),
  memoryMb: z.strictObject({ prometheus, loki, grafana, front, alloy, proxy }).prefault({}),
});
// ObservabilitySchema += { monitoring?: MonitoringSchema }
// ADDON_MEMORY_DEFAULTS += { monitoring: { prometheus, loki, grafana, front, alloy, proxy } }  (S2)

export function monitoringOf(plan: DeployPlan): MonitoringSettings | undefined;   // enabled only
export function monitoringServerName(plan: DeployPlan): string | undefined;       // "app", a server, or owner.server
export function isOutsideMember(plan: DeployPlan, member: NetworkMember): boolean;
```

- `checkObservability` gains the rules of data-model.md, each with a plain message naming the
  field and what to change.
- 018's rule "every network member is the app or a `servers` entry" gains the outside member's
  exception.
- `packages/plan-schema/schemas/plan.schema.json` is regenerated.

## iac-templates

```ts
// T2003
IMAGES.prometheus, IMAGES.loki, IMAGES.grafana: ImagePin;   // IMAGES.alloy → 1.21.3

// T2004
export interface MonitoringStackInput {
  settings: MonitoringSettings;            // the owner's
  networks: {                              // empty for kind "app" with no network
    address: string;                       // the monitoring server's address on that network
    servers: string[];                     // the members that send (private addresses)
    devices: string[];                     // the devices' private addresses
  }[];
  hasDevices: boolean;
  plan: DeployPlan;                        // the owner's, for headers and labels
}
export function renderMonitoringStack(input: MonitoringStackInput): { path: string; content: string }[];
export const MONITORING_DIR = "opscrew/addons/monitoring";
export const MONITORING_PUSH_NETWORK = "opscrew-monitoring-push";   // the front by name, for the stack's own server's Alloy

// T2005
export interface DashboardQuery { dashboard: string; panel: string; datasource: "prometheus" | "loki"; expr: string }
export const DASHBOARD_QUERIES: readonly DashboardQuery[];
export function renderDashboards(options: { caddy: boolean }): { uid: string; file: string; json: string }[];
export const MONITORING_LABELS = ["app", "env", "server", "service", "host"] as const;

// T2006
export interface AlloyDestinations { grafanaCloud?: GrafanaCloudSettings; monitoring?: { address: string } }
export function renderAlloyConfig(plan: DeployPlan, server: string, destinations: AlloyDestinations): string;
export function renderAlloyCompose(plan: DeployPlan, server: string, destinations: AlloyDestinations): string;
// renderAddon(plan, "grafana-cloud") keeps its output for a plan without monitoring

// T2007 (the constant is in edge/index.ts from the start, so T2006 can import it)
export const CADDY_METRICS_PORT = 9180;   // on the edge's internal network only
```

## ssh-host (T2008)

```ts
ADDON_KINDS = ["beszel", "alloy", "monitoring"];
// host step "monitoring": params { files: { path, sha256 }[], removeData?: boolean }
// host step "alloy": params += { server: string, destinations: ("grafanaCloud" | "monitoring")[] }
// host step "grant": access += "monitor" (kind "postgres" only; login "opscrew_monitor")
ApplyOptions.secrets += { grafanaAdminPassword?: string; monitoringPostgresPassword?: string };
// facts += { monitoring?: { containers: AddonContainer[]; files: Record<string, string> };
//            alloy?: { destinations: string[] } }
```

## agents

```ts
// T2009 (agents/src/monitoring)
monitoringEnable(deps, plan, { on?: "app" | "server"; newServer?: boolean }): Promise<MonitoringChange>;
monitoringDisable(deps, plan): Promise<MonitoringChange>;
monitoringEstimate(deps, plans): Promise<MonitoringEstimate>;   // series, figures GB, logs GB, metricsMaxGb
repositoryMonitoring(deps): Promise<{ plan: RepoPath; server: string } | undefined>;
monitoringSenders(deps, ownerPlan): Promise<RepoPath[]>;

// T2011 (agents/src/provision/monitoring.ts)
monitoringHostPlans(deps, plan): Promise<HostPlanStep[]>;   // in the order of plan.md 11.

// T2012
monitoringStatus(deps, plan): Promise<MonitoringReading>;
// MonitoringReading: { containers, servers: { app, env, server, lastFigures?, lastLog?, silent }[],
//                      disk: { figuresBytes, logsBytes }, retention }
```

## CLI and MCP (T2014)

- `opscrew addon enable monitoring [--on app|server] [--new-server] [--app <name>] [--env <name>]`
- `opscrew addon disable monitoring [--app] [--env]`
- `opscrew addon open monitoring [--port <local>]`
- `opscrew addon status`: a "Monitoring" section.
- MCP: `opscrew_addon_enable` / `_disable` / `_status` with `addon: "monitoring"`; `on` and
  `newServer` arguments on enable.
