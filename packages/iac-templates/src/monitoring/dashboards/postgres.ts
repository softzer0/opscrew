import { type Dashboard, SELECTED } from "./grafana";

const BY = "app, env, server, service";
const BY_DATABASE = `${BY}, datname`;
const LEGEND = "{{server}} {{service}} {{datname}}";

function rate(metric: string): string {
  return `rate(${metric}{${SELECTED}}[$__rate_interval])`;
}

/** Postgres's connections, transactions, cache, size, deadlocks and oldest query (R7 "Postgres"). */
export const postgres: Dashboard = {
  name: "postgres",
  title: "OpsCrew: Postgres",
  description:
    "Postgres's connections, transactions, cache hit ratio, size, deadlocks and oldest query.",
  panels: [
    {
      type: "timeseries",
      title: "Connections",
      source: "prometheus",
      targets: [
        {
          expr: `sum by (${BY}) (pg_stat_database_numbackends{${SELECTED}})`,
          legend: "in use {{server}} {{service}}",
        },
        {
          expr: `max by (${BY}) (pg_settings_max_connections{${SELECTED}})`,
          legend: "max_connections {{server}} {{service}}",
        },
      ],
    },
    {
      type: "timeseries",
      title: "Transactions",
      source: "prometheus",
      unit: "ops",
      targets: [
        {
          expr: `sum by (${BY_DATABASE}) (${rate("pg_stat_database_xact_commit")} + ${rate("pg_stat_database_xact_rollback")})`,
          legend: LEGEND,
        },
      ],
    },
    {
      type: "timeseries",
      title: "Cache hit ratio",
      source: "prometheus",
      unit: "percentunit",
      targets: [
        {
          expr: `sum by (${BY_DATABASE}) (${rate("pg_stat_database_blks_hit")}) / (sum by (${BY_DATABASE}) (${rate("pg_stat_database_blks_hit")}) + sum by (${BY_DATABASE}) (${rate("pg_stat_database_blks_read")}))`,
          legend: LEGEND,
        },
      ],
    },
    {
      type: "timeseries",
      title: "Size",
      source: "prometheus",
      unit: "bytes",
      targets: [
        {
          expr: `max by (${BY_DATABASE}) (pg_database_size_bytes{${SELECTED}})`,
          legend: LEGEND,
        },
      ],
    },
    {
      type: "bargauge",
      title: "Deadlocks",
      source: "prometheus",
      targets: [
        {
          // In the shown range.
          expr: `sum by (${BY_DATABASE}) (increase(pg_stat_database_deadlocks{${SELECTED}}[$__range]))`,
          legend: LEGEND,
        },
      ],
    },
    {
      type: "timeseries",
      title: "Oldest running query",
      source: "prometheus",
      unit: "s",
      targets: [
        {
          expr: `max by (${BY}) (pg_stat_activity_max_tx_duration{state="active", ${SELECTED}})`,
          legend: "{{server}} {{service}}",
        },
      ],
    },
  ],
};
