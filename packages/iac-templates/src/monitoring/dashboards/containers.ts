import { type Dashboard, SELECTED } from "./grafana";

const BY = "app, env, server, service, container";
const LEGEND = "{{server}} {{container}}";

/** Each container's CPU, memory against its limit, and restarts (cAdvisor on the cgroups, R7 S1). */
export const containers: Dashboard = {
  name: "containers",
  title: "OpsCrew: containers",
  description: "Each container's CPU, memory against its limit, and restarts.",
  panels: [
    {
      type: "timeseries",
      title: "CPU (cores)",
      source: "prometheus",
      targets: [
        {
          expr: `sum by (${BY}) (rate(container_cpu_usage_seconds_total{${SELECTED}}[$__rate_interval]))`,
          legend: LEGEND,
        },
      ],
    },
    {
      type: "timeseries",
      title: "Memory (working set)",
      source: "prometheus",
      unit: "bytes",
      targets: [
        {
          expr: `max by (${BY}) (container_memory_working_set_bytes{${SELECTED}})`,
          legend: LEGEND,
        },
      ],
    },
    {
      type: "timeseries",
      title: "Memory against its limit",
      source: "prometheus",
      unit: "percentunit",
      targets: [
        {
          // A limit of 0 is no limit.
          expr: `max by (${BY}) (container_memory_working_set_bytes{${SELECTED}}) / max by (${BY}) (container_spec_memory_limit_bytes{${SELECTED}} > 0)`,
          legend: LEGEND,
        },
      ],
    },
    {
      type: "bargauge",
      title: "Restarts",
      source: "prometheus",
      targets: [
        {
          // A container recreated by a deploy gets a new start time too, so a deploy counts as one.
          expr: `changes((max by (app, env, server, service) (container_start_time_seconds{${SELECTED}}))[$__range:15s])`,
          legend: "{{server}} {{service}}",
        },
      ],
    },
  ],
};
