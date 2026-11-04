/**
 * The monitoring stack's state on its server: containers, each server's last data, disk and
 * retention, read through one fixed read-only command (FR-2021).
 */
import { listText, OpsCrewError, plural } from "@opscrew/core";
import { IMAGES, MONITORING_PROJECT } from "@opscrew/iac-templates";
import {
  APP_SERVER,
  type DeployPlan,
  type MonitoringSettings,
  monitoringOf,
} from "@opscrew/plan-schema";
import { z } from "zod";
import type { AddonContainer } from "../addons/status";
import type { PhaseDeps } from "../context";
import { monitoringOwner } from "../network/owner";
import type { ProvisionServices } from "../provision/types";
import { sizeText } from "../retarget/texts";
import { appServers } from "../shared/servers";
import { ageText } from "../status/network";
import { serverShell } from "../status/servers";
import { readOwnerPlan, senderPlans } from "./repository";

/** A server whose last figures are older than this is silent (US6 #5). */
export const SILENT_AFTER_MS = 5 * 60_000;

/** One of the stack's containers: its state, health and memory. */
export interface MonitoringContainer extends AddonContainer {
  /** Its healthcheck's verdict; absent without one (Loki) or while stopped. */
  healthy?: boolean;
}

/** One monitored server, by its labels, and when its data last arrived. */
export interface MonitoredServer {
  app: string;
  env: string;
  server: string;
  /** When its last figures arrived (ISO 8601); absent when none came in the last 5 minutes. */
  lastFigures?: string;
  /** When its last log line arrived, to the minute (ISO 8601); absent when none in the last hour. */
  lastLog?: string;
  /** No figures for more than 5 minutes. */
  silent: boolean;
}

/** What the monitoring stack reports. Never a secret or a public address. */
export interface MonitoringReading {
  /** The stack's server, by the labels its own figures carry. */
  stack: { app: string; env: string; server: string };
  containers: MonitoringContainer[];
  /** Every server the stack watches: the owner's environment's, then each sender's. */
  servers: MonitoredServer[];
  /** The stack's volumes' sizes. */
  disk: { figuresBytes: number; logsBytes: number };
  retention: MonitoringSettings["retention"];
  /** The parts the stack did not answer (its container down): then nothing is flagged silent. */
  unanswered: ("figures" | "logs" | "disk")[];
}

/** Where the stack runs: the owner's plan, the deps that reach its server, and that server. */
export interface MonitoringStack {
  /** The plan that owns the stack: `plan` itself, or the owner's for a sender. */
  plan: DeployPlan;
  /** `deps` with the owner's paths (its server record and logins) for a sender. */
  deps: PhaseDeps;
  /** The stack's server in the owner's plan: `app` or an extra server's name. */
  server: string;
}

/**
 * The stack `plan` uses: on its own server (`where.kind` "server" or "app"), or for a sender the
 * owner's, read from the repository and reached with the owner's record and logins.
 * @throws OpsCrewError `PHASE_PRECONDITION` when monitoring is off, or the owner's plan no longer
 * runs the server.
 */
export async function monitoringStack(deps: PhaseDeps, plan: DeployPlan): Promise<MonitoringStack> {
  const where = monitoringOf(plan)?.where;
  if (where === undefined) {
    throw new OpsCrewError("PHASE_PRECONDITION", "Self-hosted monitoring is off for this app.", {
      hint: "Turn it on with `opscrew addon enable monitoring`, then run `opscrew provision`.",
    });
  }
  if (where.kind === "app") return { plan, deps, server: APP_SERVER };
  if (where.kind === "server") return { plan, deps, server: where.server };
  const owner = monitoringOwner(deps.paths, plan) as NonNullable<
    ReturnType<typeof monitoringOwner>
  >;
  const ownerPlan = await readOwnerPlan(deps, owner, "Nothing was changed.");
  return { plan: ownerPlan, deps: { ...deps, paths: owner.paths }, server: owner.server };
}

/** The `env` label of a plan's figures and lines. */
function envLabel(plan: DeployPlan): string {
  return plan.environment?.name ?? "prod";
}

/**
 * Every server the stack of `ownerPlan` watches, by the labels its Alloy sets: each server of the
 * owner's environment (the monitoring server included), then each sender's, in repository order.
 */
export async function monitoredServers(
  deps: Pick<PhaseDeps, "paths">,
  ownerPlan: DeployPlan,
): Promise<Omit<MonitoredServer, "silent">[]> {
  return [ownerPlan, ...(await senderPlans(deps, ownerPlan))].flatMap((plan) =>
    appServers(plan).map((server) => ({ app: plan.app.name, env: envLabel(plan), server })),
  );
}

const CONTAINER_PREFIX = `${MONITORING_PROJECT}-`;
const PROMETHEUS = `${CONTAINER_PREFIX}prometheus-1`;
const FRONT = `${CONTAINER_PREFIX}front-1`;
const VOLUMES = [`${MONITORING_PROJECT}_prometheus`, `${MONITORING_PROJECT}_loki`];

/** The newest figures of each server: when `node_load1` last arrived, by its labels. */
const FIGURES_QUERY = "max by (app, env, server) (timestamp(node_load1))";
/** The lines of each server per minute over Loki's default range, the last hour. */
const LOGS_QUERY = 'sum by (app, env, server) (count_over_time({app=~".+"}[1m]))';

const marker = (name: string) => `echo '==opscrew-monitoring:${name}'`;

/**
 * The read-only command `monitoringStatus` runs on the stack's server, fixed text only: the
 * project's containers with their state and health, every container's memory, Prometheus's answer
 * for each server's last figures (asked inside its container), Loki's lines per minute of the
 * last hour (asked from the front, on the stack's network: Loki's image has no shell), and the
 * size of the two data volumes (`du` in the pinned Caddy image the front runs, never pulled, the
 * volumes mounted read-only and only once both exist, so it never creates one).
 */
export const MONITORING_STATUS_COMMAND = [
  marker("containers"),
  `docker ps -a --filter label=com.docker.compose.project=${MONITORING_PROJECT} --format '{{.Names}}|{{.State}}|{{.Status}}'`,
  marker("memory"),
  "docker stats --no-stream --format '{{.Name}}|{{.MemUsage}}'",
  marker("figures"),
  `docker exec ${PROMETHEUS} wget -q -O - 'http://127.0.0.1:9090/api/v1/query?query=${encodeURIComponent(FIGURES_QUERY)}'`,
  "echo",
  marker("logs"),
  `docker exec ${FRONT} wget -q -O - 'http://loki:3100/loki/api/v1/query_range?query=${encodeURIComponent(LOGS_QUERY)}&step=60'`,
  "echo",
  marker("disk"),
  `docker volume inspect ${VOLUMES.join(" ")} >/dev/null && docker run --rm --pull never --network none --user 0:0 --entrypoint du -v ${VOLUMES[0]}:/v/prometheus:ro -v ${VOLUMES[1]}:/v/loki:ro ${IMAGES.caddy.ref} -sk /v/prometheus /v/loki`,
  "true",
].join("; ");

/** The command's output, by section. */
function sections(stdout: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  let current: string[] | undefined;
  for (const line of stdout.split(/\r?\n/).map((text) => text.trim())) {
    const match = /^==opscrew-monitoring:([a-z]+)$/.exec(line);
    if (match !== null) {
      current = [];
      out[match[1] as string] = current;
    } else if (current !== undefined && line !== "") {
      current.push(line);
    }
  }
  return out;
}

/** One of the stack's own containers, by the names Compose gives the project's four services. */
const CONTAINER = new RegExp(
  `^(${CONTAINER_PREFIX}(?:prometheus|loki|grafana|front)-\\d+)\\|([a-z]+)\\|(.*)$`,
);
const MEMORY = /^([A-Za-z0-9][A-Za-z0-9_.-]*)\|([0-9.]+ ?[KMGT]?i?B \/ [0-9.]+ ?[KMGT]?i?B)$/;

/** The stack's containers from the `containers` and `memory` sections; others are left out. */
function parseContainers(states: string[], usage: string[]): MonitoringContainer[] {
  const memory = new Map(
    usage.flatMap((line) => {
      const used = MEMORY.exec(line);
      return used === null ? [] : [[used[1] as string, used[2] as string] as const];
    }),
  );
  return states.flatMap((line) => {
    const found = CONTAINER.exec(line);
    if (found === null) return [];
    const [, name = "", state, status = ""] = found;
    const running = state === "running";
    const used = memory.get(name);
    const health = /\((healthy|unhealthy)\)/.exec(status)?.[1];
    return [
      {
        name,
        running,
        ...(running && used !== undefined ? { memory: used } : {}),
        ...(running && health !== undefined ? { healthy: health === "healthy" } : {}),
      },
    ];
  });
}

const LabelsSchema = z.object({ app: z.string(), env: z.string(), server: z.string() });
const NumberText = z.string().regex(/^\d+(?:\.\d+)?(?:e\+?\d+)?$/);

/** Prometheus's answer to {@link FIGURES_QUERY}: each server's last sample time in seconds. */
const FiguresAnswerSchema = z.object({
  status: z.literal("success"),
  data: z.object({
    resultType: z.literal("vector"),
    result: z.array(z.object({ metric: LabelsSchema, value: z.tuple([z.number(), NumberText]) })),
  }),
});

/** Loki's answer to {@link LOGS_QUERY}: each server's lines per minute, by time in seconds. */
const LogsAnswerSchema = z.object({
  status: z.literal("success"),
  data: z.object({
    resultType: z.literal("matrix"),
    result: z.array(
      z.object({
        metric: LabelsSchema,
        values: z.array(z.tuple([z.number(), NumberText])),
      }),
    ),
  }),
});

/** The JSON of a section's only line through `schema`; `undefined` when it does not fit. */
function answer<T>(lines: string[] | undefined, schema: z.ZodType<T>): T | undefined {
  if (lines?.length !== 1) return undefined;
  try {
    const parsed = schema.safeParse(JSON.parse(lines[0] as string));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

const key = (labels: { app: string; env: string; server: string }) =>
  `${labels.app}\u0000${labels.env}\u0000${labels.server}`;

/** The two volumes' sizes from `du -sk`'s lines; `undefined` unless both are there. */
function parseDisk(lines: string[] | undefined): MonitoringReading["disk"] | undefined {
  const sizes = new Map(
    (lines ?? []).flatMap((line) => {
      const found = /^(\d+)\s+\/v\/(prometheus|loki)$/.exec(line);
      return found === null ? [] : [[found[2] as string, Number(found[1]) * 1024] as const];
    }),
  );
  const figures = sizes.get("prometheus");
  const logs = sizes.get("loki");
  return figures === undefined || logs === undefined
    ? undefined
    : { figuresBytes: figures, logsBytes: logs };
}

/** What {@link monitoringStatus} reads the stack with (fakes in tests). */
export type MonitoringStatusServices = Pick<ProvisionServices, "remote">;

/**
 * Reads the monitoring stack's state on its server (a sender's: on the owner's, with the owner's
 * login) through {@link MONITORING_STATUS_COMMAND}, read-only, audited as `remote-exec` without an
 * address. Every answer is parsed with zod; a part the stack did not answer is `unanswered`, and
 * then no server is flagged silent. A server is silent when its last figures are more than 5
 * minutes old (US6 #5).
 * @throws OpsCrewError `PHASE_PRECONDITION` when monitoring is off or the server's login is not on
 * this computer, `COMMAND_FAILED` when the server could not be reached.
 */
export async function monitoringStatus(
  deps: PhaseDeps,
  plan: DeployPlan,
  services: MonitoringStatusServices = {},
): Promise<MonitoringReading> {
  const stack = await monitoringStack(deps, plan);
  const settings = monitoringOf(stack.plan) as MonitoringSettings;
  const { docker } = await serverShell(stack.deps, stack.plan, stack.server, services);
  deps.reporter.step(`Reading the monitoring stack on server ${stack.server} (read-only)`);
  const result = await docker.run(MONITORING_STATUS_COMMAND, { timeoutMs: 120_000 });
  if (result.exitCode !== 0) {
    throw new OpsCrewError(
      "COMMAND_FAILED",
      `OpsCrew could not read the monitoring stack on server ${stack.server} over SSH (exit code ${result.exitCode}).`,
      {
        hint: `Check that server ${stack.server} is on and that this computer reaches it over SSH, then try again. While the stack is down, each server's agent keeps its figures for up to 8 hours and its log lines for about 20 minutes, and sends them when it is back.`,
      },
    );
  }
  await deps.audit.append({
    kind: "remote-exec",
    actor: "opscrew",
    action: "read the monitoring stack's containers, last data and disk (read-only)",
    target: `server ${stack.server}`,
    decision: "allow",
  });
  const read = sections(result.stdout);
  const figures = answer(read.figures, FiguresAnswerSchema);
  const logs = answer(read.logs, LogsAnswerSchema);
  const disk = parseDisk(read.disk);
  const lastFigures = new Map(
    (figures?.data.result ?? []).map((item) => [key(item.metric), Number(item.value[1]) * 1000]),
  );
  const lastLog = new Map(
    (logs?.data.result ?? []).flatMap((item) => {
      const times = item.values.filter(([, count]) => Number(count) > 0).map(([at]) => at * 1000);
      return times.length === 0 ? [] : [[key(item.metric), Math.max(...times)] as const];
    }),
  );
  const now = deps.clock.now().getTime();
  const servers = (await monitoredServers(deps, stack.plan)).map((labels) => {
    const figured = lastFigures.get(key(labels));
    const logged = lastLog.get(key(labels));
    return {
      ...labels,
      ...(figured === undefined ? {} : { lastFigures: new Date(figured).toISOString() }),
      ...(logged === undefined ? {} : { lastLog: new Date(logged).toISOString() }),
      silent: figures !== undefined && (figured === undefined || now - figured > SILENT_AFTER_MS),
    };
  });
  return {
    stack: { app: stack.plan.app.name, env: envLabel(stack.plan), server: stack.server },
    containers: parseContainers(read.containers ?? [], read.memory ?? []),
    servers,
    disk: disk ?? { figuresBytes: 0, logsBytes: 0 },
    retention: settings.retention,
    unanswered: [
      ...(figures === undefined ? (["figures"] as const) : []),
      ...(logs === undefined ? (["logs"] as const) : []),
      ...(disk === undefined ? (["disk"] as const) : []),
    ],
  };
}

/** `20 seconds ago`, `3 minutes ago`: how long before `now` it was `at`. */
function ago(at: string, now: Date): string {
  return ageText(Math.max(0, Math.round((now.getTime() - Date.parse(at)) / 1000)));
}

/** A monitored server in words: `server app of shop (staging)`. */
export function monitoredServerWords(server: Pick<MonitoredServer, "app" | "env" | "server">) {
  return `server ${server.server} of ${server.app} (${server.env})`;
}

/**
 * What to check for a silent server: its agent and, unless it is the stack's own server (which
 * pushes over a Docker network), its link on the private network (US6 #5).
 */
export function silentText(server: MonitoredServer, stack: MonitoringReading["stack"]): string {
  const own = key(server) === key(stack);
  return `nothing has arrived for more than 5 minutes. Check its agent, Grafana Alloy (the opscrew-alloy containers on that server)${own ? "" : ", and its link on the private network (`opscrew status` in that environment shows each link)"}.`;
}

/** A monitored server's line: when its figures and last log line arrived, or what to check. */
function serverLine(server: MonitoredServer, stack: MonitoringReading["stack"], now: Date): string {
  const name = monitoredServerWords(server);
  if (server.silent) return `${name}: ${silentText(server, stack)}`;
  const figures =
    server.lastFigures === undefined
      ? "figures not read"
      : `figures ${ago(server.lastFigures, now)}`;
  const log =
    server.lastLog === undefined
      ? "no log line in the last hour"
      : `last log line ${ago(server.lastLog, now)}`;
  return `${name}: ${figures}, ${log}`;
}

/**
 * `opscrew addon status`'s lines of the stack (FR-2021): its containers and memory, the disk its
 * figures and logs take, the retention, and each server's last data, silent ones flagged with what
 * to check. Never a secret or a public address.
 */
export function monitoringReadingLines(reading: MonitoringReading, now: Date): string[] {
  const { retention } = reading;
  const unanswered = reading.unanswered;
  return [
    ...reading.containers.map(
      (c) =>
        `  ${c.name}: ${c.running ? "running" : "stopped"}${c.healthy === undefined ? "" : c.healthy ? ", healthy" : ", unhealthy"}${c.memory === undefined ? "" : `, memory ${c.memory}`}`,
    ),
    ...(reading.containers.length === 0 ? ["  No container of the stack runs on the server."] : []),
    `  Kept: figures ${plural(retention.metricsDays, "day")} (at most ${retention.metricsMaxGb} GB), logs ${plural(retention.logsDays, "day")}.`,
    unanswered.includes("disk")
      ? "  Disk: not read (the stack's volumes were not found)."
      : `  Disk: figures ${sizeText(reading.disk.figuresBytes)}, logs ${sizeText(reading.disk.logsBytes)}.`,
    ...(unanswered.includes("figures") || unanswered.includes("logs")
      ? [
          `  The stack did not answer for the servers' last ${listText(unanswered.filter((part) => part !== "disk"))}: run \`opscrew provision\` to start it again. Meanwhile each server's agent keeps its figures for up to 8 hours and its log lines for about 20 minutes.`,
        ]
      : []),
    ...reading.servers.map((server) => `  ${serverLine(server, reading.stack, now)}`),
  ];
}

/**
 * `opscrew status`'s one line for this environment (FR-2021): how many of its servers send, and
 * which are silent, with what to check.
 */
export function monitoringStatusLine(reading: MonitoringReading, plan: DeployPlan): string {
  const { stack } = reading;
  const mine = reading.servers.filter(
    (server) => server.app === plan.app.name && server.env === envLabel(plan),
  );
  const silent = mine.filter((server) => server.silent);
  const where = `the monitoring stack on server ${stack.server}${stack.app === plan.app.name && stack.env === envLabel(plan) ? "" : ` of ${stack.app} (${stack.env})`}`;
  if (reading.unanswered.includes("figures")) {
    return `Monitoring: ${where} did not answer for the servers' figures; \`opscrew addon status\` shows its containers.`;
  }
  if (silent.length === 0) {
    return `Monitoring: ${plural(mine.length, "server")} sending to ${where}, each within the last 5 minutes.`;
  }
  return `Monitoring: ${silent.map((server) => `server ${server.server}`).join(", ")} sent nothing to ${where} for more than 5 minutes. Check ${silent.length === 1 ? "its" : "their"} agent, Grafana Alloy, and ${silent.length === 1 ? "its" : "their"} link on the private network; \`opscrew addon status\` says more.`;
}
