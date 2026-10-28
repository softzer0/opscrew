import type { RemoteExec } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { z } from "zod";
import type { PhaseDeps } from "../context";
import { ADDON_PHASE } from "./settings";

/** What one read of the server gives: its CPUs and memory, and the app's log bytes of a day. */
export interface ServerReading {
  cpus: number;
  memoryMb: number;
  /** The bytes of `docker logs --since 24h` over the app's containers (Grafana Cloud only). */
  logBytes24h?: number;
}

/** An app name as the plan allows it, the only variable text in the read's command. */
const APP_NAME = /^[a-z0-9][a-z0-9-]*$/;

/**
 * The read-only command: `nproc`, the server's memory in kB, and with `logs` the byte count of the
 * app's containers' logs of the last 24 hours (counted on the server; no line leaves it). Built
 * from fixed text and the checked app name (the Compose project) only.
 */
export function serverReadCommand(app: string, logs: boolean): string {
  if (!APP_NAME.test(app)) throw new Error(`Not an app name: ${app}`);
  const base = "nproc && awk '/^MemTotal:/ { print $2 }' /proc/meminfo";
  if (!logs) return base;
  return `${base} && docker ps -q --filter label=com.docker.compose.project=${app} | while read -r id; do docker logs --since 24h "$id" 2>&1; done | wc -c`;
}

const CountSchema = z
  .string()
  .regex(/^\d{1,15}$/)
  .transform(Number);

/**
 * Reads the server's CPUs and memory, and with `logs` the app's log volume of the last day, as the
 * deploy user (read-only, audited without the address).
 * @throws OpsCrewError `COMMAND_FAILED` when the read fails or answers something else.
 */
export async function readServer(
  deps: Pick<PhaseDeps, "audit">,
  remote: RemoteExec,
  app: string,
  logs: boolean,
): Promise<ServerReading> {
  const result = await remote.run(serverReadCommand(app, logs), { timeoutMs: 120_000 });
  const lines = result.stdout.trim().split(/\s+/);
  const counts = z
    .array(CountSchema)
    .length(logs ? 3 : 2)
    .safeParse(lines);
  if (result.exitCode !== 0 || !counts.success) {
    throw new OpsCrewError(
      "COMMAND_FAILED",
      "OpsCrew could not read the server's CPUs and memory as the deploy user, so it changed nothing.",
      {
        hint: "Check that the server is on and that this computer reaches it with the project's deploy key (`opscrew status`), then run the command again.",
      },
    );
  }
  const [cpus, memoryKb, logBytes] = counts.data as [number, number, number?];
  await deps.audit.append({
    kind: "remote-exec",
    actor: "opscrew",
    action: logs
      ? "read the server's CPUs, memory and the app's log volume of a day for Grafana Cloud (read-only)"
      : "read the server's CPUs and memory for Beszel (read-only)",
    phase: ADDON_PHASE,
    target: "server",
    decision: "allow",
  });
  return {
    cpus,
    memoryMb: Math.round(memoryKb / 1024),
    ...(logBytes !== undefined ? { logBytes24h: logBytes } : {}),
  };
}

/** Grafana Cloud's free tier: active metric series, and log bytes a month (50 GB). */
export const GRAFANA_FREE_TIER = { series: 10_000, logBytesPerMonth: 50e9 };

/**
 * The series Alloy sends for a server of `cpus` CPUs (its allow-list, spike result 3): five CPU
 * modes per CPU, three load averages, two memory figures and `/`'s size and free space. Alloy runs
 * on its own network, so no interface adds any.
 */
export function grafanaSeries(cpus: number): number {
  return cpus * 5 + 3 + 2 + 2;
}

/** OpsCrew's estimate of what the server sends to Grafana Cloud, against the free tier. */
export interface GrafanaEstimate {
  series: number;
  /** A month of logs at the last day's rate, with the plan's sampling. */
  logBytesPerMonth: number;
  /** Past the free tier's 50 GB a month of logs: the highest sampling that fits it. */
  fittingSampling?: number;
  /** Past either free limit. */
  over: boolean;
}

/** The estimate for a read of the server and a share of log lines sent (`logSampling`, 1–100). */
export function grafanaEstimate(
  reading: Pick<ServerReading, "cpus" | "logBytes24h">,
  logSampling: number,
): GrafanaEstimate {
  const series = grafanaSeries(reading.cpus);
  const allLogs = 30 * (reading.logBytes24h ?? 0);
  const logBytesPerMonth = Math.round((allLogs * logSampling) / 100);
  const logsOver = logBytesPerMonth > GRAFANA_FREE_TIER.logBytesPerMonth;
  const fitting = Math.floor((GRAFANA_FREE_TIER.logBytesPerMonth / allLogs) * 100);
  return {
    series,
    logBytesPerMonth,
    ...(logsOver ? { fittingSampling: Math.max(1, Math.min(99, fitting)) } : {}),
    over: logsOver || series > GRAFANA_FREE_TIER.series,
  };
}

/** Bytes in GB, one decimal (Grafana counts decimal gigabytes). */
function gigabytes(bytes: number): string {
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

/** The estimate in words, next to the free tier's limits. */
export function estimateText(estimate: GrafanaEstimate, logSampling: number): string {
  const sampled = logSampling < 100 ? `, ${logSampling}% of the lines sent` : "";
  return `Grafana Cloud's free tier keeps 10,000 metric series and 50 GB of logs a month, each for 14 days. OpsCrew's estimate for this server: ${estimate.series.toLocaleString("en-US")} series, and ${gigabytes(estimate.logBytesPerMonth)} of logs a month (30 times the app's last 24 hours${sampled}).`;
}
