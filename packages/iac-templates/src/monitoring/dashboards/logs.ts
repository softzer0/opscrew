import { type Dashboard, lokiLabelVariable, SELECTED } from "./grafana";

const STREAM = `{${SELECTED}, service=~"$service"} |= "$search"`;

/** The app's logs, masked on the server, filtered by app, env, server, service and a text box. */
export const logs: Dashboard = {
  name: "logs",
  title: "OpsCrew: logs",
  description: "The app's logs, masked before they left the server, and their volume.",
  variables: [
    lokiLabelVariable("service", "Service"),
    {
      name: "search",
      label: "Search",
      type: "textbox",
      query: "",
      current: { text: "", value: "" },
      options: [],
      hide: 0,
    },
  ],
  panels: [
    {
      type: "timeseries",
      title: "Log volume",
      source: "loki",
      bars: true,
      width: 24,
      targets: [
        {
          expr: `sum by (service) (count_over_time(${STREAM} [$__interval]))`,
          legend: "{{service}}",
        },
      ],
    },
    {
      type: "logs",
      title: "Logs",
      source: "loki",
      width: 24,
      targets: [{ expr: STREAM, legend: "" }],
    },
  ],
};
