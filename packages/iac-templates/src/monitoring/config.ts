import {
  type DeployPlan,
  MONITORING_PUSH_PORT,
  type MonitoringSettings,
} from "@opscrew/plan-schema";
import { GRAFANA_DASHBOARDS_IN_CONTAINER } from "./compose";
import { DATASOURCES } from "./dashboards/grafana";
import { headerComment } from "./header";

/** Prometheus's upstream on the stack's network, and Loki's. */
const PROMETHEUS = "prometheus:9090";
const LOKI = "loki:3100";

/**
 * `prometheus.yml`: no scrape jobs and no external labels (every figure arrives by remote write,
 * labelled by Alloy), and late samples accepted up to 4 hours, as long as Alloy keeps them.
 */
export function renderPrometheusConfig(plan: DeployPlan): string {
  return [
    ...headerComment(plan, [
      "Prometheus for OpsCrew's monitoring stack: no scrape jobs and no external labels. Every figure",
      "arrives by remote write from the servers' Alloy, through the front, already labelled app, env",
      "and server. Retention (time and size) is on the command line in compose.yaml.",
    ]),
    "global: {}",
    "",
    "storage:",
    "  tsdb:",
    "    # Samples up to 4 hours behind the newest are still accepted, so a server cut off from the",
    "    # stack sends what Alloy kept for it once it is back (without it: 400, and Alloy drops them).",
    "    out_of_order_time_window: 4h",
    "",
  ].join("\n");
}

/**
 * `loki.yaml`: one process, files on disk under `/loki`, one tenant with no auth, schema v13 on
 * tsdb with a 24-hour index, the compactor's retention at `logsDays`, older lines refused at push,
 * no extra `service_name` label, no usage reports, and limits sized to a small server.
 */
export function renderLokiConfig(plan: DeployPlan, settings: MonitoringSettings): string {
  const retention = `${settings.retention.logsDays * 24}h`;
  return [
    ...headerComment(plan, [
      "Loki for OpsCrew's monitoring stack: one process, files on disk under /loki (the `loki`",
      "volume), no auth (one tenant; only the front's push path reaches it), schema v13 on tsdb with",
      "a 24-hour index, and retention by the compactor.",
    ]),
    "auth_enabled: false",
    "",
    "server:",
    "  http_listen_port: 3100",
    "  grpc_listen_port: 9095",
    "  log_level: warn",
    "",
    "common:",
    "  instance_addr: 127.0.0.1",
    "  path_prefix: /loki",
    "  replication_factor: 1",
    "  ring:",
    "    kvstore:",
    "      store: inmemory",
    "  storage:",
    "    filesystem:",
    "      chunks_directory: /loki/chunks",
    "      rules_directory: /loki/rules",
    "",
    "schema_config:",
    "  configs:",
    '    - from: "2026-01-01"',
    "      store: tsdb",
    "      object_store: filesystem",
    "      schema: v13",
    "      index:",
    "        prefix: index_",
    "        period: 24h",
    "",
    "storage_config:",
    "  tsdb_shipper:",
    "    active_index_directory: /loki/tsdb-index",
    "    cache_location: /loki/tsdb-cache",
    "",
    "compactor:",
    "  working_directory: /loki/compactor",
    "  compaction_interval: 10m",
    "  retention_enabled: true",
    "  retention_delete_delay: 2h",
    "  retention_delete_worker_count: 150",
    "  delete_request_store: filesystem",
    "",
    "limits_config:",
    `  # monitoring.retention.logsDays (${settings.retention.logsDays}) in hours.`,
    `  retention_period: ${retention}`,
    "  # Lines older than the retention are refused at push, so a late batch never outlives it.",
    "  reject_old_samples: true",
    `  reject_old_samples_max_age: ${retention}`,
    "  # Only the labels Alloy sends: no service_name copied from service.",
    "  discover_service_name: []",
    "  # A small server: about 4 MB/s sustained (all servers together), bursts of 8 MB.",
    "  ingestion_rate_mb: 4",
    "  ingestion_burst_size_mb: 8",
    "  per_stream_rate_limit: 2MB",
    "  per_stream_rate_limit_burst: 8MB",
    "  max_global_streams_per_user: 5000",
    "  max_line_size: 256KB",
    "  max_line_size_truncate: true",
    "  allow_structured_metadata: true",
    "  volume_enabled: true",
    "  max_query_series: 1000",
    "  max_entries_limit_per_query: 5000",
    "",
    "query_range:",
    "  results_cache:",
    "    cache:",
    "      embedded_cache:",
    "        enabled: true",
    "        max_size_mb: 50",
    "",
    "ruler:",
    "  enable_api: false",
    "",
    "# No usage reports to stats.grafana.org.",
    "analytics:",
    "  reporting_enabled: false",
    "",
  ].join("\n");
}

/**
 * The front's `Caddyfile`: at {@link MONITORING_PUSH_PORT}, only `POST /api/v1/write` (to
 * Prometheus) and `POST /loki/api/v1/push` (to Loki), each rewritten to the exact path, bodies up
 * to 8 MiB; anything else answers 403. No admin API, no certificates and no saved configuration.
 */
export function renderFrontCaddyfile(plan: DeployPlan): string {
  const route = (name: string, path: string, upstream: string) => [
    `\t@${name} {`,
    "\t\tmethod POST",
    `\t\tpath ${path}`,
    "\t}",
    `\thandle @${name} {`,
    `\t\trewrite * ${path}`,
    `\t\treverse_proxy ${upstream}`,
    "\t}",
    "",
  ];
  return [
    ...headerComment(plan, [
      "OpsCrew's monitoring front: only the two push paths, POST only. Grafana reads Prometheus and",
      "Loki on the stack's own network; their query APIs are never reachable here.",
    ]),
    "{",
    "\tadmin off",
    "\tauto_https off",
    "\tpersist_config off",
    "}",
    "",
    `:${MONITORING_PUSH_PORT} {`,
    "\t# Alloy's batches stay under 1 MiB on the wire; past 8 MiB the front answers 413.",
    "\trequest_body {",
    "\t\tmax_size 8MiB",
    "\t}",
    "",
    ...route("metrics", "/api/v1/write", PROMETHEUS),
    ...route("logs", "/loki/api/v1/push", LOKI),
    "\thandle {",
    "\t\trespond 403",
    "\t}",
    "}",
    "",
  ].join("\n");
}

/**
 * Grafana's data sources: Prometheus and Loki on the stack's network, read-only in Grafana; `prune`
 * removes one this file no longer lists.
 */
export function renderGrafanaDatasources(plan: DeployPlan): string {
  return [
    ...headerComment(plan, [
      "OpsCrew's two data sources, read-only in Grafana. Grafana reaches both on the stack's own",
      "network; neither query API is published.",
    ]),
    "apiVersion: 1",
    "prune: true",
    "datasources:",
    "  - name: Prometheus",
    `    uid: ${DATASOURCES.prometheus.uid}`,
    "    type: prometheus",
    "    access: proxy",
    `    url: http://${PROMETHEUS}`,
    "    isDefault: true",
    "    editable: false",
    "    jsonData:",
    "      httpMethod: POST",
    "      # Alloy sends every 15 seconds: $__rate_interval is built from it.",
    "      timeInterval: 15s",
    "      prometheusType: Prometheus",
    "  - name: Loki",
    `    uid: ${DATASOURCES.loki.uid}`,
    "    type: loki",
    "    access: proxy",
    `    url: http://${LOKI}`,
    "    editable: false",
    "    jsonData:",
    "      maxLines: 1000",
    "",
  ].join("\n");
}

/**
 * Grafana's dashboard provider: OpsCrew's dashboards from `grafana/dashboards/`, in the folder
 * "OpsCrew", which can't be saved from the UI (only copied), restored from the files every 30
 * seconds; a file removed removes its dashboard.
 */
export function renderGrafanaDashboardProvider(plan: DeployPlan): string {
  return [
    ...headerComment(plan, [
      "OpsCrew's dashboards, from the JSON files in grafana/dashboards, in the folder OpsCrew. They",
      "can't be saved from Grafana, only copied; your copies and own dashboards are kept.",
    ]),
    "apiVersion: 1",
    "providers:",
    "  - name: opscrew",
    "    orgId: 1",
    "    folder: OpsCrew",
    "    folderUid: opscrew",
    "    type: file",
    "    disableDeletion: false",
    "    allowUiUpdates: false",
    "    updateIntervalSeconds: 30",
    "    options:",
    `      path: ${GRAFANA_DASHBOARDS_IN_CONTAINER}`,
    "      foldersFromFilesStructure: false",
    "",
  ].join("\n");
}
