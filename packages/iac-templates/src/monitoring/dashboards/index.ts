/**
 * The monitoring stack's provisioned Grafana dashboards and their queries: servers, containers,
 * http, caddy, postgres and logs, as classic JSON (plan.md 5.).
 */
import { caddy } from "./caddy";
import { containers } from "./containers";
import { type Dashboard, dashboardUid, renderDashboard } from "./grafana";
import { http } from "./http";
import { logs } from "./logs";
import { postgres } from "./postgres";
import { servers } from "./servers";

/** One panel's query: its dashboard, its title and its data source. */
export interface DashboardQuery {
  /** The dashboard's uid. */
  dashboard: string;
  panel: string;
  datasource: "prometheus" | "loki";
  expr: string;
}

const DASHBOARDS: Dashboard[] = [servers, containers, http, caddy, postgres, logs];

/** The dashboards whose figures come from Caddy. */
const FROM_CADDY = new Set<Dashboard>([http, caddy]);

/** Every panel's query, across the dashboards (with Caddy as the edge). */
export const DASHBOARD_QUERIES: readonly DashboardQuery[] = DASHBOARDS.flatMap((dashboard) =>
  dashboard.panels.flatMap((panel) =>
    panel.type === "text"
      ? []
      : panel.targets.map((target) => ({
          dashboard: dashboardUid(dashboard),
          panel: panel.title,
          datasource: panel.source,
          expr: target.expr,
        })),
  ),
);

/** With another edge than Caddy, its dashboard holds only a note that it needs Caddy. */
function withoutCaddy(dashboard: Dashboard): Dashboard {
  const content =
    "These figures come from Caddy, OpsCrew's default edge. This app uses another edge, so this dashboard has nothing to show.";
  return { ...dashboard, panels: [{ type: "text", title: "Needs Caddy", content }] };
}

/**
 * The dashboards' JSON files, each with its stable uid (`opscrew-<name>`) and a bare file name
 * (`<name>.json`). With `caddy: false`, http and caddy hold a note that they need Caddy.
 */
export function renderDashboards(options: {
  caddy: boolean;
}): { uid: string; file: string; json: string }[] {
  return DASHBOARDS.map((dashboard) => ({
    uid: dashboardUid(dashboard),
    file: `${dashboard.name}.json`,
    json: renderDashboard(
      options.caddy || !FROM_CADDY.has(dashboard) ? dashboard : withoutCaddy(dashboard),
    ),
  }));
}
