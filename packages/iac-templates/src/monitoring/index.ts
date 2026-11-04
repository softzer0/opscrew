/**
 * The self-hosted monitoring stack's files (`opscrew-monitoring`): Prometheus, Loki, Grafana and
 * the front, rendered from the owner's plan.
 */
import { type DeployPlan, type MonitoringSettings, monitoringOf } from "@opscrew/plan-schema";
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

/**
 * The stack's files, each with its path under `opscrew/addons/monitoring`: `compose.yaml`,
 * `prometheus.yml`, `loki.yaml`, the front's `Caddyfile`, Grafana's provisioning files and its
 * dashboards (`grafana/dashboards/*.json`; http and caddy need the plan's edge to be Caddy). None
 * holds a secret: Grafana reads its admin password from `grafana_admin_credential`, which the host
 * step writes beside them. Rendered from the owner's `plan` (its monitoring settings) and
 * `addresses`, the stack's server's private address on each network it serves (none for kind "app"
 * with no network).
 */
export function renderMonitoringStack(
  plan: DeployPlan,
  addresses: readonly string[],
): { path: string; content: string }[] {
  const settings = monitoringOf(plan) as MonitoringSettings;
  return [
    { path: "compose.yaml", content: renderMonitoringCompose(plan, settings, addresses) },
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
