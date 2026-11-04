/**
 * The self-hosted monitoring stack's files (`opscrew-monitoring`): Prometheus, Loki, Grafana and
 * the front, rendered from the owner's plan.
 */
import type { DeployPlan, MonitoringSettings } from "@opscrew/plan-schema";
import { edgeProxy } from "../edge";
import { renderMonitoringCompose } from "./compose";
import {
  renderFrontCaddyfile,
  renderGrafanaDashboardProvider,
  renderGrafanaDatasources,
  renderLokiConfig,
  renderPrometheusConfig,
} from "./config";
import { renderDashboards } from "./dashboards";

export { GRAFANA_CREDENTIAL_FILE, MONITORING_PROJECT, MONITORING_PUSH_NETWORK } from "./compose";
export * from "./dashboards";

/** What the stack's files are rendered from. */
export interface MonitoringStackInput {
  /** The owner's settings. */
  settings: MonitoringSettings;
  /** One per network the stack's server is on; empty for kind "app" with no network. */
  networks: {
    /** The monitoring server's address on that network. */
    address: string;
    /** The members that send (private addresses). */
    servers: string[];
    /** The devices' private addresses. */
    devices: string[];
  }[];
  /** The owner's plan, for headers and labels. */
  plan: DeployPlan;
}

/**
 * The stack's files, each with its path under `opscrew/addons/monitoring`: `compose.yaml`,
 * `prometheus.yml`, `loki.yaml`, the front's `Caddyfile`, Grafana's provisioning files and its
 * dashboards (`grafana/dashboards/*.json`; http and caddy need the plan's edge to be Caddy). None
 * holds a secret: Grafana reads its admin password from `grafana_admin_credential`, which the host
 * step writes beside them.
 */
export function renderMonitoringStack(
  input: MonitoringStackInput,
): { path: string; content: string }[] {
  const { plan, settings } = input;
  return [
    { path: "compose.yaml", content: renderMonitoringCompose(input) },
    { path: "prometheus.yml", content: renderPrometheusConfig(plan) },
    { path: "loki.yaml", content: renderLokiConfig(plan, settings) },
    { path: "Caddyfile", content: renderFrontCaddyfile(plan) },
    {
      path: "grafana/provisioning/datasources/opscrew.yaml",
      content: renderGrafanaDatasources(plan),
    },
    {
      path: "grafana/provisioning/dashboards/opscrew.yaml",
      content: renderGrafanaDashboardProvider(plan),
    },
    ...renderDashboards({ caddy: edgeProxy(plan) === "caddy" }).map((dashboard) => ({
      path: `grafana/dashboards/${dashboard.file}`,
      content: dashboard.json,
    })),
  ];
}
