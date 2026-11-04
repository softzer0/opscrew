/**
 * The monitoring stack's provisioned Grafana dashboards and their queries. A stub until the
 * dashboards' task fills it.
 */

/** The labels every series carries; the dashboards' variables and queries use only these. */
export const MONITORING_LABELS = ["app", "env", "server", "service", "host"] as const;

/** One panel's query: its dashboard, its title and its data source. */
export interface DashboardQuery {
  dashboard: string;
  panel: string;
  datasource: "prometheus" | "loki";
  expr: string;
}

/** Every panel's query, across the dashboards. */
export const DASHBOARD_QUERIES: readonly DashboardQuery[] = [];

/** The dashboards' JSON files, each with its stable uid. */
export function renderDashboards(_options: {
  caddy: boolean;
}): { uid: string; file: string; json: string }[] {
  throw new Error("renderDashboards is not implemented yet.");
}
