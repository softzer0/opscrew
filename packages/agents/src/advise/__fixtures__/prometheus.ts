/**
 * The monitoring stack's Prometheus as advise's history command reaches it: each settled query
 * answered with what was recorded for the spike's figures (`shop`, prod: app, data, monitoring).
 * No network and no real server.
 */
import { readFile } from "node:fs/promises";

/** Each query's recorded answer, by what it reads. */
export type Figure =
  | "figures"
  | "days"
  | "cpuP95"
  | "memoryP95"
  | "loadOverCpus"
  | "diskFullInDays"
  | "containerP95"
  | "containerMax"
  | "containerLimit"
  | "restarts"
  | "oomKills";

/** Prometheus's instant answer. */
export interface Answer {
  status: string;
  data: { resultType: string; result: { metric: Record<string, string>; value: unknown[] }[] };
}

/** The answers' own labels. */
const RECORDED = { app: "shop", env: "prod" };

/** The queries of research R5 (S2), as written, for one app and environment; then status's. */
export function settledQueries(app: string, env: string): Record<Figure, string> {
  const SEL = `app="${app}",env="${env}"`;
  const BY = "app, env, server";
  return {
    // Each server's newest figures, as `opscrew status` asks: every app's.
    figures: "max by (app, env, server) (timestamp(node_load1))",
    days: `max by (${BY}) ((time() - min_over_time(timestamp(node_memory_MemTotal_bytes{${SEL}})[14d:1h])) / 86400)`,
    cpuP95: `quantile_over_time(0.95, (1 - avg by (${BY}) (rate(node_cpu_seconds_total{${SEL},mode="idle"}[5m])))[14d:5m])`,
    memoryP95: `quantile_over_time(0.95, (1 - max by (${BY}) (node_memory_MemAvailable_bytes{${SEL}}) / max by (${BY}) (node_memory_MemTotal_bytes{${SEL}}))[14d:5m])`,
    loadOverCpus: `avg_over_time((max by (${BY}) (node_load15{${SEL}}) > bool on (${BY}) count by (${BY}) (node_cpu_seconds_total{${SEL},mode="idle"}))[14d:5m])`,
    diskFullInDays: `max by (${BY}) (node_filesystem_avail_bytes{${SEL},mountpoint="/"}) / max by (${BY}) (-deriv(node_filesystem_avail_bytes{${SEL},mountpoint="/"}[7d]) > 0) / 86400`,
    containerP95: `quantile_over_time(0.95, (max by (${BY}, service) (container_memory_working_set_bytes{${SEL}}))[14d:5m])`,
    containerMax: `max by (${BY}, service) (max_over_time(container_memory_working_set_bytes{${SEL}}[14d]))`,
    containerLimit: `max by (${BY}, service) (container_spec_memory_limit_bytes{${SEL}} > 0)`,
    restarts: `sum by (${BY}, service) (changes(container_start_time_seconds{${SEL}}[14d]))`,
    oomKills: `sum by (${BY}, service) (increase(container_oom_events_total{${SEL}}[14d]))`,
  };
}

/** Prometheus's answers recorded for the spike's figures (`shop`, prod: app, data, monitoring). */
export async function recordedHistory(): Promise<Record<Figure, Answer>> {
  return JSON.parse(await readFile(new URL("./prometheus-history.json", import.meta.url), "utf8"));
}

const PROMETHEUS = "docker exec opscrew-monitoring-prometheus-1 wget -q -O - ";

/**
 * The stack's server's output for `command`: its `echo`s and `true`, and each Prometheus `wget` of
 * a settled query of `labels` answered with its answer in `answers` (raw text as is; none: wget
 * failed), the recorded series relabelled to `labels`. Any other command part throws.
 */
export function prometheusOutput(
  command: string,
  answers: Partial<Record<Figure, Answer | string>>,
  labels: { app: string; env: string } = RECORDED,
): string {
  const byQuery = new Map(
    Object.entries(settledQueries(labels.app, labels.env)).map(([figure, q]) => [q, figure]),
  );
  return command
    .split("; ")
    .map((part) => {
      if (part === "echo") return "\n";
      if (part === "true") return "";
      const echo = /^echo '([^']*)'$/.exec(part);
      if (echo !== null) return `${echo[1]}\n`;
      const url = new RegExp(
        `^${PROMETHEUS}'http://127\\.0\\.0\\.1:9090/api/v1/query\\?query=([^']*)'$`,
      ).exec(part);
      if (url === null) throw new Error(`unexpected command part: ${part}`);
      const figure = byQuery.get(decodeURIComponent(url[1] as string)) as Figure | undefined;
      if (figure === undefined) throw new Error(`not a settled query: ${url[1]}`);
      const answer = answers[figure];
      if (answer === undefined) return "";
      if (typeof answer === "string") return answer;
      return JSON.stringify({
        ...answer,
        data: {
          ...answer.data,
          result: answer.data.result.map((s) =>
            s.metric.app === RECORDED.app && s.metric.env === RECORDED.env
              ? { ...s, metric: { ...s.metric, ...labels } }
              : s,
          ),
        },
      });
    })
    .join("");
}
