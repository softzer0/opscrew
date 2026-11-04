import { CADDY_SELECTED, type Dashboard } from "./grafana";

const COUNT = `caddy_http_request_duration_seconds_count{handler!="metrics", ${CADDY_SELECTED}}`;
const REQUESTS = `sum by (host) (rate(${COUNT}[$__rate_interval]))`;

/** The share of requests answered with `codes`; 0 while there are none. */
function share(codes: string): string {
  const matching = `caddy_http_request_duration_seconds_count{handler!="metrics", code=~"${codes}", ${CADDY_SELECTED}}`;
  return `(sum by (host) (rate(${matching}[$__rate_interval])) or 0 * ${REQUESTS}) / ${REQUESTS}`;
}

function quantile(q: string): string {
  const buckets = `caddy_http_request_duration_seconds_bucket{handler!="metrics", ${CADDY_SELECTED}}`;
  return `histogram_quantile(${q}, sum by (host, le) (rate(${buckets}[$__rate_interval])))`;
}

/** Requests, error shares and latency per host, from Caddy's figures (R7 S5). */
export const http: Dashboard = {
  name: "http",
  title: "OpsCrew: HTTP",
  description: "Requests, error shares and latency per host, from Caddy, OpsCrew's default edge.",
  panels: [
    {
      type: "timeseries",
      title: "Requests",
      source: "prometheus",
      unit: "reqps",
      targets: [{ expr: REQUESTS, legend: "{{host}}" }],
    },
    {
      type: "timeseries",
      title: "Latency p50 and p95",
      source: "prometheus",
      unit: "s",
      targets: [
        { expr: quantile("0.5"), legend: "p50 {{host}}" },
        { expr: quantile("0.95"), legend: "p95 {{host}}" },
      ],
    },
    {
      type: "timeseries",
      title: "4xx share",
      source: "prometheus",
      unit: "percentunit",
      targets: [{ expr: share("4.."), legend: "{{host}}" }],
    },
    {
      type: "timeseries",
      title: "5xx share",
      source: "prometheus",
      unit: "percentunit",
      targets: [{ expr: share("5.."), legend: "{{host}}" }],
    },
  ],
};
