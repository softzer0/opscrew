import { CADDY_SELECTED, type Dashboard } from "./grafana";

const LEGEND = "{{app}} {{env}} {{server}}";

/** Caddy itself: requests in flight, its memory and CPU, and handler errors (R7 S5). */
export const caddy: Dashboard = {
  name: "caddy",
  title: "OpsCrew: Caddy",
  description: "Caddy, OpsCrew's default edge: requests in flight, its memory and CPU, and errors.",
  panels: [
    {
      type: "timeseries",
      title: "Requests in flight",
      source: "prometheus",
      targets: [
        {
          expr: `sum by (app, env, server) (caddy_http_requests_in_flight{${CADDY_SELECTED}})`,
          legend: LEGEND,
        },
      ],
    },
    {
      type: "timeseries",
      title: "Errors",
      source: "prometheus",
      unit: "reqps",
      targets: [
        {
          expr: `sum by (host) (rate(caddy_http_request_errors_total{${CADDY_SELECTED}}[$__rate_interval]))`,
          legend: "{{host}}",
        },
      ],
    },
    {
      type: "timeseries",
      title: "Memory",
      source: "prometheus",
      unit: "bytes",
      targets: [{ expr: `process_resident_memory_bytes{${CADDY_SELECTED}}`, legend: LEGEND }],
    },
    {
      type: "timeseries",
      title: "CPU (cores)",
      source: "prometheus",
      targets: [
        {
          expr: `rate(process_cpu_seconds_total{${CADDY_SELECTED}}[$__rate_interval])`,
          legend: LEGEND,
        },
      ],
    },
  ],
};
