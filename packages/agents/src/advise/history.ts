/**
 * Advise's history (US3, US4): each server's 14 days from the self-hosted stack's Prometheus,
 * through one fixed read-only command, with the queries the spike settled (research R5, S2).
 */
import { OpsCrewError } from "@opscrew/core";
import { type DeployPlan, monitoringOf } from "@opscrew/plan-schema";
import { z } from "zod";
import type { PhaseDeps } from "../context";
import {
  answer,
  envLabel,
  FIGURES_QUERY,
  lastFigures,
  type MonitoringStatusServices,
  marker,
  monitoringStack,
  prometheusQuery,
  SILENT_AFTER_MS,
  sections,
} from "../monitoring/status";
import { appServers } from "../shared/servers";
import { serverShell } from "../status/servers";
import { type ServerHistory, THRESHOLDS } from "./types";

type ServerFigure = Exclude<keyof ServerHistory, "containers" | "notRead">;
type ContainerFigure = Exclude<keyof ServerHistory["containers"][number], "service">;

/** One query: its section in the command's output, what it reads in words, and its text. */
interface Query {
  section: string;
  words: string;
  query: (sel: string) => string;
}

const BY = "app, env, server";
const WINDOW = `${THRESHOLDS.historyDays}d`;
const P = THRESHOLDS.percentile;

/** Each server's figures, by the plan's labels `sel` (`app="…",env="…"`). */
const SERVER_QUERIES: Record<ServerFigure, Query> = {
  days: {
    section: "days",
    words: "how far back its figures go",
    query: (sel) =>
      `max by (${BY}) ((time() - min_over_time(timestamp(node_memory_MemTotal_bytes{${sel}})[${WINDOW}:1h])) / 86400)`,
  },
  cpuP95: {
    section: "cpu",
    words: "its CPU p95",
    query: (sel) =>
      `quantile_over_time(${P}, (1 - avg by (${BY}) (rate(node_cpu_seconds_total{${sel},mode="idle"}[5m])))[${WINDOW}:5m])`,
  },
  memoryP95: {
    section: "memory",
    words: "its memory p95",
    query: (sel) =>
      `quantile_over_time(${P}, (1 - max by (${BY}) (node_memory_MemAvailable_bytes{${sel}}) / max by (${BY}) (node_memory_MemTotal_bytes{${sel}}))[${WINDOW}:5m])`,
  },
  loadOverCpus: {
    section: "load",
    words: "its load against its CPUs",
    query: (sel) =>
      `avg_over_time((max by (${BY}) (node_load15{${sel}}) > bool on (${BY}) count by (${BY}) (node_cpu_seconds_total{${sel},mode="idle"}))[${WINDOW}:5m])`,
  },
  diskFullInDays: {
    section: "disk",
    words: "the disk's trend",
    query: (sel) =>
      `max by (${BY}) (node_filesystem_avail_bytes{${sel},mountpoint="/"}) / max by (${BY}) (-deriv(node_filesystem_avail_bytes{${sel},mountpoint="/"}[7d]) > 0) / 86400`,
  },
};

/** Each container's figures, by its Compose service; restarts per container, so not deploys. */
const CONTAINER_QUERIES: Record<ContainerFigure, Query> = {
  memoryP95: {
    section: "containermemory",
    words: "its containers' memory p95",
    query: (sel) =>
      `quantile_over_time(${P}, (max by (${BY}, service) (container_memory_working_set_bytes{${sel}}))[${WINDOW}:5m])`,
  },
  memoryMax: {
    section: "containerpeak",
    words: "its containers' memory maximum",
    query: (sel) =>
      `max by (${BY}, service) (max_over_time(container_memory_working_set_bytes{${sel}}[${WINDOW}]))`,
  },
  limit: {
    section: "containerlimit",
    words: "its containers' memory limits",
    query: (sel) => `max by (${BY}, service) (container_spec_memory_limit_bytes{${sel}} > 0)`,
  },
  restarts: {
    section: "restarts",
    words: "its containers' restarts",
    query: (sel) =>
      `sum by (${BY}, service) (changes(container_start_time_seconds{${sel}}[${WINDOW}]))`,
  },
  oomKills: {
    section: "oomkills",
    words: "its containers' kills for running out of memory",
    query: (sel) =>
      `sum by (${BY}, service) (increase(container_oom_events_total{${sel}}[${WINDOW}]))`,
  },
};

/** Asks Prometheus inside its container for `query`, after the marker of `section`. */
function ask(section: string, query: string): string[] {
  return [marker(section), prometheusQuery(query), "echo"];
}

/**
 * The read-only command: each server's newest figures, then each query. Only the plan's `app`
 * and `env` labels vary; the queries are URL-encoded.
 */
function historyCommand(sel: string): string {
  return [
    ...ask("figures", FIGURES_QUERY),
    ...[...Object.values(SERVER_QUERIES), ...Object.values(CONTAINER_QUERIES)].flatMap((q) =>
      ask(q.section, q.query(sel)),
    ),
    "true",
  ].join("; ");
}

/** Prometheus's instant answer: one sample per series, its value as text (`"0.85"`, `"NaN"`). */
function answerSchema<T extends z.ZodRawShape>(labels: T) {
  return z.object({
    status: z.literal("success"),
    data: z.object({
      resultType: z.literal("vector"),
      result: z.array(
        z.object({ metric: z.object(labels), value: z.tuple([z.number(), z.string()]) }),
      ),
    }),
  });
}
const ServerAnswerSchema = answerSchema({ server: z.string() });
const ContainerAnswerSchema = answerSchema({ server: z.string(), service: z.string() });

/** The answered series with a finite value; `undefined` when the query failed. */
function samples<Labels>(
  lines: string[] | undefined,
  schema: z.ZodType<{ data: { result: { metric: Labels; value: [number, string] }[] } }>,
): { labels: Labels; value: number }[] | undefined {
  return answer(lines, schema)?.data.result.flatMap((series) => {
    const value = Number(series.value[1]);
    return Number.isFinite(value) ? [{ labels: series.metric, value }] : [];
  });
}

const failed = (words: string) => `${words}: Prometheus did not answer the query`;

/**
 * The 14 days of each server of `plan`'s environment from the self-hosted stack, by the plan's
 * server name; `undefined` without monitoring. Read on the stack's server (the owner's, with its
 * login, for a sender) through one fixed read-only command, audited as `remote-exec` without an
 * address; every answer parsed with zod. Never fatal for a query: what one did not answer is
 * absent and listed in `notRead`, and a server without figures has `days` 0. A server whose
 * figures stopped (none in the last 5 minutes) is listed too, without its limits and disk trend.
 * @throws OpsCrewError `PHASE_PRECONDITION` when the server's login is not on this computer,
 * `COMMAND_FAILED` when the stack's server could not be reached (advise says it in its own words).
 */
export async function readHistory(
  deps: PhaseDeps,
  plan: DeployPlan,
  services: MonitoringStatusServices = {},
): Promise<Record<string, ServerHistory> | undefined> {
  if (monitoringOf(plan) === undefined) return undefined;
  const stack = await monitoringStack(deps, plan);
  const { docker } = await serverShell(stack.deps, stack.plan, stack.server, services);
  deps.reporter.step(
    `Reading ${THRESHOLDS.historyDays} days of figures from the monitoring stack on server ${stack.server} (read-only)`,
  );
  const labels = { app: plan.app.name, env: envLabel(plan) };
  const result = await docker.run(historyCommand(`app="${labels.app}",env="${labels.env}"`), {
    timeoutMs: 30_000,
  });
  if (result.exitCode !== 0) {
    throw new OpsCrewError(
      "COMMAND_FAILED",
      `The monitoring stack on server ${stack.server} did not answer (exit code ${result.exitCode}).`,
    );
  }
  await deps.audit.append({
    kind: "remote-exec",
    actor: "opscrew",
    action: `read ${THRESHOLDS.historyDays} days of each server's figures from the monitoring stack (read-only)`,
    target: `server ${stack.server}`,
    decision: "allow",
  });
  const read = sections(result.stdout);
  const histories = new Map<string, ServerHistory>(
    appServers(plan).map((server) => [server, { days: 0, containers: [], notRead: [] }]),
  );
  const everyServer = (text: string) => {
    for (const history of histories.values()) history.notRead?.push(text);
  };

  // A server whose figures stopped: its limits and disk trend, read at this instant, are stale.
  const newest = lastFigures(read.figures);
  const stopped = new Set<string>();
  if (newest === undefined) everyServer(failed("whether its figures still arrive"));
  else {
    const now = deps.clock.now().getTime();
    for (const [server, history] of histories) {
      const at = newest({ ...labels, server });
      if (at !== undefined && now - at <= SILENT_AFTER_MS) continue;
      stopped.add(server);
      history.notRead?.push(
        at === undefined
          ? "its figures: none arrived in the last 5 minutes"
          : `its figures stopped at ${new Date(at).toISOString()}`,
      );
    }
  }

  for (const [name, q] of Object.entries(SERVER_QUERIES) as [ServerFigure, Query][]) {
    const answered = samples(read[q.section], ServerAnswerSchema);
    if (answered === undefined) everyServer(failed(q.words));
    for (const { labels: series, value } of answered ?? []) {
      if (name === "diskFullInDays" && stopped.has(series.server)) continue;
      const history = histories.get(series.server);
      if (history !== undefined) history[name] = value;
    }
  }
  for (const [name, q] of Object.entries(CONTAINER_QUERIES) as [ContainerFigure, Query][]) {
    const answered = samples(read[q.section], ContainerAnswerSchema);
    if (answered === undefined) everyServer(failed(q.words));
    for (const { labels: series, value } of answered ?? []) {
      const history = histories.get(series.server);
      if (history === undefined) continue;
      let container = history.containers.find((c) => c.service === series.service);
      if (container === undefined) {
        container = { service: series.service };
        history.containers.push(container);
      }
      if (name === "limit" && stopped.has(series.server)) continue;
      // `increase` extrapolates to the window's edges: a count of kills is whole.
      container[name] = name === "oomKills" ? Math.round(value) : value;
    }
  }

  for (const history of histories.values()) {
    if (history.notRead?.length === 0) delete history.notRead;
  }
  return Object.fromEntries(histories);
}
