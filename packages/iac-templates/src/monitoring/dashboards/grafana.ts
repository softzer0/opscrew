/**
 * Classic Grafana dashboard JSON (`schemaVersion` 42, research R7 S3), built from the small
 * definitions in this folder's dashboard modules.
 */

/** The stack's two provisioned data sources. */
export type Source = "prometheus" | "loki";

const DATASOURCES = {
  prometheus: { type: "prometheus", uid: "opscrew-prometheus" },
  loki: { type: "loki", uid: "opscrew-loki" },
} as const;

/** The `app`, `env` and `server` variables' matchers, which every query carries. */
export const SELECTED = 'app=~"$app", env=~"$env", server=~"$server"';

/** The matchers for Caddy's series: Alloy labels everything from Caddy's scrape `service="caddy"`. */
export const CADDY_SELECTED = `service="caddy", ${SELECTED}`;

/** One query of a panel. */
export interface Target {
  expr: string;
  legend: string;
}

/** One panel: a graph of its queries, a bar per series (an instant query), logs, or text. */
export type Panel =
  | {
      type: "timeseries" | "bargauge" | "logs";
      title: string;
      source: Source;
      targets: Target[];
      /** Grafana's unit id, such as `bytes` or `percentunit`. */
      unit?: string;
      /** Bars instead of lines (the logs' volume). */
      bars?: boolean;
      /** Columns out of 24; 12 when absent. */
      width?: number;
    }
  | { type: "text"; title: string; content: string };

/** A dashboard, before rendering. */
export interface Dashboard {
  /** The short name: the uid is `opscrew-<name>` and the file `<name>.json`. */
  name: string;
  title: string;
  description: string;
  panels: Panel[];
  /** Variables after `app`, `env` and `server`. */
  variables?: object[];
}

/**
 * A multi-select variable with "All" (R7 S3), from the label's values on `node_load1`, which every
 * server with monitoring sends (`up` is kept only for Caddy's scrape).
 */
function labelVariable(name: string, label: string, selector: string): object {
  const query = `label_values(node_load1${selector}, ${name})`;
  return {
    name,
    label,
    type: "query",
    datasource: DATASOURCES.prometheus,
    query: { qryType: 1, query, refId: "PrometheusVariableQueryEditor-VariableQuery" },
    definition: query,
    refresh: 2,
    sort: 1,
    multi: true,
    includeAll: true,
    // Loki refuses a selector whose only matcher is `=~".*"`.
    allValue: ".+",
    current: { text: ["All"], value: ["$__all"] },
    options: [],
    regex: "",
    hide: 0,
  };
}

const VARIABLES = [
  labelVariable("app", "App", ""),
  labelVariable("env", "Environment", '{app=~"$app"}'),
  labelVariable("server", "Server", '{app=~"$app", env=~"$env"}'),
];

/** A multi-select variable with "All", from the values of a Loki label on the selected streams. */
export function lokiLabelVariable(name: string, label: string): object {
  const stream = `{${SELECTED}}`;
  return {
    name,
    label,
    type: "query",
    datasource: DATASOURCES.loki,
    query: { type: 1, label: name, stream, refId: "LokiVariableQueryEditor-VariableQuery" },
    definition: `label_values(${stream}, ${name})`,
    refresh: 2,
    sort: 1,
    multi: true,
    includeAll: true,
    allValue: ".+",
    current: { text: ["All"], value: ["$__all"] },
    options: [],
    regex: "",
    hide: 0,
  };
}

function renderTarget(panel: Panel & { source: Source }, target: Target, index: number): object {
  const common = {
    refId: String.fromCharCode(65 + index),
    datasource: DATASOURCES[panel.source],
    expr: target.expr,
    legendFormat: target.legend,
  };
  if (panel.source === "loki") return { ...common, queryType: "range" };
  if (panel.type === "bargauge") return { ...common, instant: true, range: false };
  return { ...common, range: true };
}

function renderPanel(panel: Panel, id: number, gridPos: object): object {
  if (panel.type === "text") {
    return {
      id,
      type: "text",
      title: panel.title,
      gridPos,
      options: { mode: "markdown", content: panel.content },
    };
  }
  const targets = panel.targets.map((target, index) => renderTarget(panel, target, index));
  const head = { id, type: panel.type, title: panel.title, datasource: DATASOURCES[panel.source] };
  if (panel.type === "logs") {
    return {
      ...head,
      gridPos,
      options: {
        showTime: true,
        wrapLogMessage: true,
        sortOrder: "Descending",
        enableLogDetails: true,
        dedupStrategy: "none",
      },
      targets,
    };
  }
  const defaults = {
    unit: panel.unit ?? "short",
    min: 0,
    ...(panel.unit === "percentunit" ? { max: 1 } : {}),
    ...(panel.bars
      ? { custom: { drawStyle: "bars", fillOpacity: 80, stacking: { mode: "normal" } } }
      : {}),
  };
  const options =
    panel.type === "bargauge"
      ? {
          orientation: "horizontal",
          displayMode: "basic",
          showUnfilled: true,
          reduceOptions: { calcs: ["lastNotNull"], fields: "", values: false },
        }
      : {
          legend: { displayMode: "list", placement: "bottom", showLegend: true },
          tooltip: { mode: "multi", sort: "desc" },
        };
  return { ...head, gridPos, fieldConfig: { defaults, overrides: [] }, options, targets };
}

/** The dashboard's JSON, two panels a row unless a panel is wider. */
export function renderDashboard(dashboard: Dashboard): string {
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  const panels = dashboard.panels.map((panel, index) => {
    const w = panel.type === "text" ? 24 : (panel.width ?? 12);
    const h = panel.type === "text" ? 4 : panel.type === "logs" ? 16 : 8;
    if (x + w > 24) {
      x = 0;
      y += rowHeight;
      rowHeight = 0;
    }
    const gridPos = { h, w, x, y };
    x += w;
    rowHeight = Math.max(rowHeight, h);
    return renderPanel(panel, index + 1, gridPos);
  });
  const json = {
    uid: `opscrew-${dashboard.name}`,
    title: dashboard.title,
    description: dashboard.description,
    tags: ["opscrew"],
    schemaVersion: 42,
    version: 1,
    editable: true,
    graphTooltip: 1,
    timezone: "browser",
    time: { from: "now-6h", to: "now" },
    refresh: "30s",
    fiscalYearStartMonth: 0,
    links: [],
    annotations: {
      list: [
        {
          builtIn: 1,
          datasource: { type: "grafana", uid: "-- Grafana --" },
          enable: true,
          hide: true,
          iconColor: "rgba(0, 211, 255, 1)",
          name: "Annotations & Alerts",
          type: "dashboard",
        },
      ],
    },
    templating: { list: [...VARIABLES, ...(dashboard.variables ?? [])] },
    panels,
  };
  return `${JSON.stringify(json, null, 2)}\n`;
}
