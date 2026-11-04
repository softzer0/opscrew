/**
 * The disk the monitoring stack's retention takes (FR-2020), from each sending server's series and
 * log volume (research R7: "Series per server" and "S2, memory and disk").
 */
import type { RemoteExec } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { edgeProxy, siteHosts } from "@opscrew/iac-templates";
import {
  APP_SERVER,
  type DeployPlan,
  type MonitoringSettings,
  monitoringServerName,
} from "@opscrew/plan-schema";
import { z } from "zod";
import { CountSchema, serverReadCommand } from "../addons/estimate";
import { ADDON_PHASE } from "../addons/settings";
import { appPaths } from "../apps/list";
import type { PhaseDeps } from "../context";
import { serverWords } from "../shared/server-address";
import { appServers } from "../shared/servers";
import { serverShell } from "../status/servers";

/** One GiB: providers and Prometheus's size cap count disks in it. */
const GIB = 1024 ** 3;
/** Every scrape and push runs at 15 seconds. */
const SAMPLE_SECONDS = 15;
/** Bytes a sample takes in Prometheus's compacted blocks (S2: 1–2). */
const BLOCK_BYTES = 2;
/** Bytes a sample takes in Prometheus's write-ahead log before compaction (S2: about 10). */
const WAL_BYTES = 10;
/** The hours of samples the write-ahead log holds before they reach a block. */
const WAL_HOURS = 3;
/** Loki keeps a log's text in about a quarter of its size (S2: chunks and index, plus its WAL). */
const LOG_SHARE = 0.25;
/** The share of the disk the stack's data may take (FR-2020). */
const DISK_SHARE = 0.8;
/** Alloy and its Docker proxy, which every monitored server runs. */
const ALLOY_CONTAINERS = 2;
/** Prometheus, Loki, Grafana and the front, on the stack's server. */
const STACK_CONTAINERS = 4;

/** What one read of a server gives: its size, its running containers and the app's logs. */
export interface ServerFigures {
  cpus: number;
  memoryMb: number;
  /** Its running containers. */
  containers: number;
  /** The bytes of `docker logs --since 24h` over the app's containers there. */
  logBytes24h: number;
  /** Free space on its root filesystem, in GiB. */
  diskFreeGb: number;
}

/**
 * The read-only command: 017's read of the CPUs, memory and the app's log bytes of a day, then the
 * running containers and the root filesystem's free bytes. Fixed text and the checked app name only.
 */
export function figuresCommand(app: string): string {
  return `${serverReadCommand(app, true)} && docker ps -q | wc -l && df -PB1 / | awk 'NR == 2 { print $4 }'`;
}

/**
 * Reads the server's figures for the estimate (read-only, audited without the address).
 * @throws OpsCrewError `COMMAND_FAILED` when the read fails or answers something else.
 */
export async function readFigures(
  deps: Pick<PhaseDeps, "audit">,
  remote: RemoteExec,
  app: string,
  server: string,
): Promise<ServerFigures> {
  const result = await remote.run(figuresCommand(app), { timeoutMs: 120_000 });
  const counts = z.array(CountSchema).length(5).safeParse(result.stdout.trim().split(/\s+/));
  if (result.exitCode !== 0 || !counts.success) {
    throw new OpsCrewError(
      "COMMAND_FAILED",
      `OpsCrew could not read the size, containers and log volume of ${serverWords(server)}, which the monitoring's disk estimate needs. Nothing was changed.`,
      {
        hint: "Check that the server is on and that this computer reaches it (`opscrew status`), then run the command again.",
      },
    );
  }
  const [cpus, memoryKb, logBytes24h, containers, freeBytes] = counts.data as [
    number,
    number,
    number,
    number,
    number,
  ];
  await deps.audit.append({
    kind: "remote-exec",
    actor: "opscrew",
    action:
      "read the server's CPUs, memory, containers, free disk and the app's log volume of a day for monitoring (read-only)",
    phase: ADDON_PHASE,
    target: serverWords(server),
    decision: "allow",
  });
  return {
    cpus,
    memoryMb: Math.round(memoryKb / 1024),
    containers,
    logBytes24h,
    diskFreeGb: freeBytes / GIB,
  };
}

/** What a server sends, for {@link serverSeries}. */
export interface SeriesInput {
  cpus: number;
  containers: number;
  /** The hostnames the Caddy edge on it serves for the app (none without it). */
  hostnames?: number;
  /** Postgres runs on it. */
  postgres?: boolean;
}

/**
 * The series a server sends (research R7): 5 per vCPU and 7 for the server, 5 per container and 2
 * for its network, about 80 per hostname on the Caddy edge's server, and 40 on Postgres's.
 */
export function serverSeries(input: SeriesInput): number {
  return (
    5 * input.cpus +
    7 +
    5 * input.containers +
    2 +
    80 * (input.hostnames ?? 0) +
    (input.postgres === true ? 40 : 0)
  );
}

/** One server's part of the estimate. */
export interface ServerLoad {
  series: number;
  logBytes24h: number;
}

/** The stack's size estimate, summed across the environments that send to it. */
export interface MonitoringEstimate {
  /** The figures' series. */
  series: number;
  /** The figures' disk use over their retention, in GB. */
  figuresGb: number;
  /** The logs' disk use over their retention, in GB. */
  logsGb: number;
  /** Prometheus's size cap, in GB: 80% of the disk left after the logs. */
  metricsMaxGb: number;
  /** The disk it was estimated for, in GB. */
  diskGb: number;
  /** The figures and logs fit in 80% of the disk. */
  fits: boolean;
}

type Retention = Pick<MonitoringSettings["retention"], "metricsDays" | "logsDays">;

/**
 * The disk `loads` take over `retention` on a disk of `diskGb`: figures at 15-second samples of 2
 * bytes over their days, plus the write-ahead log's 3 hours at 10 bytes; logs at a quarter of
 * their text over their days.
 */
export function estimateDisk(
  loads: readonly ServerLoad[],
  retention: Retention,
  diskGb: number,
): MonitoringEstimate {
  const series = loads.reduce((sum, load) => sum + load.series, 0);
  const perSecond = series / SAMPLE_SECONDS;
  const figuresBytes =
    perSecond * 86_400 * retention.metricsDays * BLOCK_BYTES +
    perSecond * WAL_HOURS * 3600 * WAL_BYTES;
  const logBytes = loads.reduce((sum, load) => sum + load.logBytes24h, 0);
  const logsBytes = logBytes * retention.logsDays * LOG_SHARE;
  const figuresGb = figuresBytes / GIB;
  const logsGb = logsBytes / GIB;
  return {
    series,
    figuresGb,
    logsGb,
    metricsMaxGb: Math.max(1, Math.floor(DISK_SHARE * (diskGb - logsGb))),
    diskGb,
    fits: figuresGb + logsGb <= DISK_SHARE * diskGb,
  };
}

/**
 * The longest retention of `field` (the other as `retention` has it) whose estimate fits `diskGb`,
 * or `undefined` when even one day does not.
 */
export function fittingDays(
  loads: readonly ServerLoad[],
  retention: Retention,
  diskGb: number,
  field: keyof Retention,
): number | undefined {
  for (let days = retention[field] - 1; days >= 1; days -= 1) {
    if (estimateDisk(loads, { ...retention, [field]: days }, diskGb).fits) return days;
  }
  return undefined;
}

/** How the estimate reads a plan's server: its shell for read-only commands (fakes in tests). */
export type FiguresRemote = (server: string, plan: DeployPlan) => Promise<RemoteExec>;

/** The shell on `plan`'s server `server` that reaches Docker, with that plan's environment's paths. */
async function figuresShell(deps: PhaseDeps, plan: DeployPlan, server: string) {
  const paths = appPaths(deps.paths, plan.app.key, plan.environment?.name);
  return (await serverShell({ ...deps, paths }, plan, server)).docker;
}

/** A server's load, with what its read found (none for the stack's own server). */
export interface ReadLoad extends ServerLoad {
  plan: DeployPlan;
  server: string;
  figures?: ServerFigures;
}

/**
 * Each server of each of `plans` (the environments that send to the stack, with their monitoring
 * settings) read once ({@link readFigures}, through `remote`, by default its login's shell that
 * reaches Docker), its series with Alloy's containers (and the stack's on the app's server with
 * `kind: "app"`) counted. The stack's own server is not read: its series come from `stackVcpus`.
 */
export async function readLoads(
  deps: PhaseDeps,
  plans: readonly DeployPlan[],
  stackVcpus: number,
  remote?: FiguresRemote,
): Promise<ReadLoad[]> {
  const loads: ReadLoad[] = [];
  for (const plan of plans) {
    const stackServer = monitoringServerName(plan);
    const kind = plan.observability?.monitoring?.where.kind;
    const postgres = plan.services.find((s) => s.enabled && s.kind === "postgres");
    for (const server of appServers(plan)) {
      if (kind === "server" && server === stackServer) {
        const containers = ALLOY_CONTAINERS + STACK_CONTAINERS;
        loads.push({
          plan,
          server,
          series: serverSeries({ cpus: stackVcpus, containers }),
          logBytes24h: 0,
        });
        continue;
      }
      const shell = await (remote?.(server, plan) ?? figuresShell(deps, plan, server));
      const figures = await readFigures(deps, shell, plan.app.name, server);
      const stack = kind === "app" && server === APP_SERVER ? STACK_CONTAINERS : 0;
      const series = serverSeries({
        cpus: figures.cpus,
        containers: figures.containers + ALLOY_CONTAINERS + stack,
        ...(server === APP_SERVER && edgeProxy(plan) === "caddy"
          ? { hostnames: Math.max(1, siteHosts(plan).length) }
          : {}),
        postgres: postgres !== undefined && (postgres.server ?? APP_SERVER) === server,
      });
      loads.push({ plan, server, series, logBytes24h: figures.logBytes24h, figures });
    }
  }
  return loads;
}
