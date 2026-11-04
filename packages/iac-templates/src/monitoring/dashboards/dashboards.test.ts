import { describe, expect, it } from "vitest";
import { DASHBOARD_QUERIES, renderDashboards } from "./index";

/** The labels every series carries (the contract's): the variables and queries use these. */
const MONITORING_LABELS = ["app", "env", "server", "service", "host"];

/** The series' own labels the queries may use (plan.md 5.), beside the contract's. */
const OWN_LABELS = [
  "container",
  "container_id",
  "caddy_server",
  "code",
  "method",
  "handler",
  "datname",
  "state",
  "interface",
  "cpu",
  "mode",
  "mountpoint",
  "device",
  "fstype",
  "le",
];
const ALLOWED = new Set([...MONITORING_LABELS, ...OWN_LABELS]);

const NAMES = ["servers", "containers", "http", "caddy", "postgres", "logs"];

interface Json {
  uid: string;
  schemaVersion: number;
  templating: { list: Variable[] };
  panels: Panel[];
}
interface Variable {
  name: string;
  type: string;
  datasource?: { uid: string };
  definition?: string;
  allValue?: string;
}
interface Panel {
  type: string;
  title: string;
  datasource?: { uid: string };
  targets?: { expr: string; datasource: { uid: string } }[];
  options?: { content?: string };
}

function parsed(caddy: boolean): (Json & { file: string })[] {
  return renderDashboards({ caddy }).map((d) => ({ ...JSON.parse(d.json), file: d.file }));
}

/** Every label a PromQL or LogQL query names: in matchers and in `by (…)` and the like. */
function labelsIn(query: string): string[] {
  const found: string[] = [];
  for (const m of query.matchAll(/([A-Za-z_]\w*)\s*(?:=~|!~|!=|=)\s*"/g)) found.push(m[1] ?? "");
  for (const m of query.matchAll(/\b(?:by|without|on|ignoring)\s*\(([^)]*)\)/g)) {
    found.push(...(m[1] ?? "").split(",").map((label) => label.trim()));
  }
  const values = /^label_values\((?:.*,)?\s*(\w+)\)$/.exec(query);
  if (values) found.push(values[1] ?? "");
  return found.filter((label) => label !== "");
}

describe("renderDashboards", () => {
  it("gives the six dashboards with stable, unique uids and bare file names", () => {
    const dashboards = renderDashboards({ caddy: true });
    expect(dashboards.map((d) => d.uid)).toEqual(NAMES.map((name) => `opscrew-${name}`));
    expect(dashboards.map((d) => d.file)).toEqual(NAMES.map((name) => `${name}.json`));
    expect(new Set(dashboards.map((d) => d.uid)).size).toBe(6);
    for (const d of parsed(true)) expect(d.uid).toBe(`opscrew-${d.file.replace(".json", "")}`);
  });

  it("renders classic JSON at schemaVersion 42 with the app, env and server variables", () => {
    for (const d of [...parsed(true), ...parsed(false)]) {
      expect(d.schemaVersion).toBe(42);
      const variables = d.templating.list;
      expect(variables.slice(0, 3).map((v) => v.name)).toEqual(["app", "env", "server"]);
      for (const v of variables.filter((v) => v.type === "query")) expect(v.allValue).toBe(".+");
    }
  });

  it("uses only the two provisioned data sources", () => {
    for (const d of [...parsed(true), ...parsed(false)]) {
      for (const panel of d.panels) {
        if (panel.type === "text") continue;
        expect(["opscrew-prometheus", "opscrew-loki"]).toContain(panel.datasource?.uid);
        for (const target of panel.targets ?? []) {
          expect(target.datasource.uid).toBe(panel.datasource?.uid);
        }
      }
      for (const v of d.templating.list) {
        if (v.datasource)
          expect(["opscrew-prometheus", "opscrew-loki"]).toContain(v.datasource.uid);
      }
    }
  });

  it("uses only the contract's labels and the series' own", () => {
    const queries = parsed(true).flatMap((d) => [
      ...d.panels.flatMap((p) => (p.targets ?? []).map((t) => t.expr)),
      ...d.templating.list.flatMap((v) => (v.definition ? [v.definition] : [])),
    ]);
    expect(queries.length).toBeGreaterThan(30);
    for (const query of queries) {
      for (const label of labelsIn(query)) {
        expect(ALLOWED.has(label), `${label} in ${query}`).toBe(true);
      }
    }
  });

  it("filters every series by the app, env and server variables", () => {
    for (const { expr } of DASHBOARD_QUERIES) {
      const selectors = expr.match(/\{[^}]*\}/g) ?? [];
      expect(selectors.length, expr).toBeGreaterThan(0);
      for (const selector of selectors) {
        expect(selector, expr).toContain('app=~"$app", env=~"$env", server=~"$server"');
      }
      for (const m of expr.matchAll(/\b(?:node|container|caddy|pg|process)_\w+(.)/g)) {
        expect(m[1], expr).toBe("{");
      }
    }
  });

  it("selects Caddy's series by service in the http and caddy dashboards", () => {
    const fromCaddy = DASHBOARD_QUERIES.filter(
      (q) => q.dashboard === "opscrew-http" || q.dashboard === "opscrew-caddy",
    );
    expect(fromCaddy.length).toBeGreaterThan(0);
    for (const { expr } of fromCaddy) {
      for (const selector of expr.match(/\{[^}]*\}/g) ?? []) {
        expect(selector, expr).toContain('service="caddy"');
      }
    }
  });

  it("with another edge, holds one text panel in http and caddy saying they need Caddy", () => {
    const withCaddy = parsed(true);
    const without = parsed(false);
    for (const d of without) {
      if (d.uid === "opscrew-http" || d.uid === "opscrew-caddy") {
        expect(d.panels).toHaveLength(1);
        expect(d.panels[0]?.type).toBe("text");
        expect(d.panels[0]?.options?.content).toContain("Caddy, OpsCrew's default edge");
      } else {
        expect(d).toEqual(withCaddy.find((c) => c.uid === d.uid));
      }
    }
  });

  // In the .snap file: Biome would reformat JSON snapshot files.
  it.each(NAMES)("snapshots %s.json", (name) => {
    const dashboard = renderDashboards({ caddy: true }).find((d) => d.file === `${name}.json`);
    expect(dashboard?.json).toMatchSnapshot();
  });
});

describe("DASHBOARD_QUERIES", () => {
  it("lists every panel's query with its dashboard, title and data source", () => {
    const fromJson = parsed(true).flatMap((d) =>
      d.panels.flatMap((p) =>
        (p.targets ?? []).map((t) => ({
          dashboard: d.uid,
          panel: p.title,
          datasource: p.datasource?.uid === "opscrew-loki" ? "loki" : "prometheus",
          expr: t.expr,
        })),
      ),
    );
    expect(DASHBOARD_QUERIES).toEqual(fromJson);
    expect(new Set(DASHBOARD_QUERIES.map((q) => q.dashboard)).size).toBe(6);
  });

  it("reads the series Alloy sends (research R7)", () => {
    const exprs = DASHBOARD_QUERIES.map((q) => q.expr).join("\n");
    for (const series of [
      "node_cpu_seconds_total",
      "node_load1",
      "node_memory_MemAvailable_bytes",
      "node_filesystem_avail_bytes",
      "container_network_receive_bytes_total",
      "container_network_transmit_bytes_total",
      "container_cpu_usage_seconds_total",
      "container_memory_working_set_bytes",
      "container_spec_memory_limit_bytes",
      "container_start_time_seconds",
      "caddy_http_request_duration_seconds_count",
      "caddy_http_request_duration_seconds_bucket",
      "caddy_http_requests_in_flight",
      "caddy_http_request_errors_total",
      "process_resident_memory_bytes",
      "process_cpu_seconds_total",
      "pg_stat_database_numbackends",
      "pg_settings_max_connections",
      "pg_stat_database_xact_commit",
      "pg_stat_database_blks_hit",
      "pg_database_size_bytes",
      "pg_stat_database_deadlocks",
      "pg_stat_activity_max_tx_duration",
    ]) {
      expect(exprs).toContain(series);
    }
    expect(exprs).toContain(
      'changes((max by (app, env, server, service) (container_start_time_seconds{app=~"$app", env=~"$env", server=~"$server"}))[$__range:15s])',
    );
  });
});
