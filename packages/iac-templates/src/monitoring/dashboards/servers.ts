import { type Dashboard, SELECTED } from "./grafana";

const BY = "app, env, server";

/** Each server's CPU, load, memory, disk and network (the unix exporter and cAdvisor's root). */
export const servers: Dashboard = {
  name: "servers",
  title: "OpsCrew: servers",
  description: "Each server's CPU, load, memory, disk and network.",
  panels: [
    {
      type: "timeseries",
      title: "CPU in use",
      source: "prometheus",
      unit: "percentunit",
      targets: [
        {
          expr: `1 - avg by (${BY}) (rate(node_cpu_seconds_total{mode="idle", ${SELECTED}}[$__rate_interval]))`,
          legend: "{{app}} {{env}} {{server}}",
        },
      ],
    },
    {
      type: "timeseries",
      title: "Load",
      source: "prometheus",
      targets: [
        { expr: `node_load1{${SELECTED}}`, legend: "1m {{app}} {{env}} {{server}}" },
        { expr: `node_load5{${SELECTED}}`, legend: "5m {{app}} {{env}} {{server}}" },
        { expr: `node_load15{${SELECTED}}`, legend: "15m {{app}} {{env}} {{server}}" },
      ],
    },
    {
      type: "timeseries",
      title: "Memory in use",
      source: "prometheus",
      unit: "percentunit",
      targets: [
        {
          expr: `1 - node_memory_MemAvailable_bytes{${SELECTED}} / node_memory_MemTotal_bytes{${SELECTED}}`,
          legend: "{{app}} {{env}} {{server}}",
        },
      ],
    },
    {
      type: "timeseries",
      title: "Disk in use",
      source: "prometheus",
      unit: "percentunit",
      targets: [
        {
          expr: `1 - node_filesystem_avail_bytes{${SELECTED}} / node_filesystem_size_bytes{${SELECTED}}`,
          legend: "{{app}} {{env}} {{server}} {{mountpoint}}",
        },
      ],
    },
    {
      type: "timeseries",
      title: "Disk free",
      source: "prometheus",
      unit: "bytes",
      targets: [
        {
          expr: `node_filesystem_avail_bytes{${SELECTED}}`,
          legend: "{{app}} {{env}} {{server}} {{mountpoint}}",
        },
      ],
    },
    {
      type: "timeseries",
      title: "Network in and out",
      source: "prometheus",
      unit: "Bps",
      targets: [
        {
          expr: `sum by (${BY}, interface) (rate(container_network_receive_bytes_total{${SELECTED}}[$__rate_interval]))`,
          legend: "in {{app}} {{env}} {{server}} {{interface}}",
        },
        {
          expr: `sum by (${BY}, interface) (rate(container_network_transmit_bytes_total{${SELECTED}}[$__rate_interval]))`,
          legend: "out {{app}} {{env}} {{server}} {{interface}}",
        },
      ],
    },
  ],
};
