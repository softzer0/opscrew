import { OpsCrewError } from "@opscrew/core";
import { z } from "zod";

/** One line of a container's log (`PortainerClient.containerLogs`). */
export interface ContainerLogLine {
  stream: "stdout" | "stderr";
  /** Docker's timestamp of the line (RFC 3339, nanoseconds); {@link sinceAfter} reads past it. */
  time: string;
  line: string;
}

/** A container's CPU and memory from one stats sample (`PortainerClient.containerStats`). */
export interface ContainerFigures {
  /** Of one CPU: 100 is one CPU fully busy. */
  cpuPercent: number;
  /** Used memory without the page cache Docker can reclaim. */
  memoryUsedBytes: number;
}

const TIMESTAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;
const LINE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})) ?/;

/**
 * The lines of a `…/logs?timestamps=1` answer, sorted by time. A container without a TTY answers in
 * Docker's framing: 8-byte headers (the stream in byte 0, a big-endian size in bytes 4–7) before
 * each chunk, and a line may span frames. A TTY container answers its raw stream (CRLF), passed
 * as stdout. The two are told apart by the first byte: with timestamps, a raw stream starts with
 * a digit, and a frame with its stream number 0–3 (older Docker labels both answers as raw).
 */
export function logLines(body: Uint8Array): ContainerLogLine[] {
  const out: ContainerLogLine[] = [];
  if (body.length === 0) return out;
  if ((body[0] ?? 0) > 3) {
    const rest = splitLines(Buffer.from(body), "stdout", out);
    if (rest.length > 0) out.push(parseLine(rest, "stdout"));
    return out;
  }
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const pending: Record<ContainerLogLine["stream"], Buffer> = {
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
  };
  let offset = 0;
  while (offset < body.length) {
    const end = offset + 8 <= body.length ? offset + 8 + view.getUint32(offset + 4) : Infinity;
    if (end > body.length) {
      throw new OpsCrewError("PROVIDER_ERROR", "Portainer's log answer ended inside a frame.", {
        hint: "Try again; if it keeps failing, please report it to OpsCrew.",
      });
    }
    const type = body[offset];
    const payload = Buffer.from(body.subarray(offset + 8, end));
    offset = end;
    if (type === 1 || type === 2) {
      const stream = type === 1 ? "stdout" : "stderr";
      pending[stream] = splitLines(Buffer.concat([pending[stream], payload]), stream, out);
    } else if (type === 3) {
      throw new OpsCrewError(
        "PROVIDER_ERROR",
        `Docker could not read the container's logs: ${payload.toString("utf8").trim().slice(0, 400)}.`,
        { hint: "Check the container in Portainer, then try again." },
      );
    }
  }
  for (const stream of ["stdout", "stderr"] as const) {
    if (pending[stream].length > 0) out.push(parseLine(pending[stream], stream));
  }
  // Oldest first, so polling after the last line's time repeats none. Docker's timestamps are
  // fixed-width UTC, so text order is time order; the sort is stable for equal times.
  return out.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
}

/** Appends each complete line of `data` to `out`; returns what follows the last newline. */
function splitLines(data: Buffer, stream: ContainerLogLine["stream"], out: ContainerLogLine[]) {
  let start = 0;
  for (let index = data.indexOf(10); index !== -1; index = data.indexOf(10, start)) {
    out.push(parseLine(data.subarray(start, index), stream));
    start = index + 1;
  }
  return data.subarray(start);
}

function parseLine(bytes: Buffer, stream: ContainerLogLine["stream"]): ContainerLogLine {
  const text = bytes.toString("utf8").replace(/\r$/, "");
  const match = LINE.exec(text);
  if (match === null) {
    throw new OpsCrewError("PROVIDER_ERROR", "Portainer returned a log line without a timestamp.", {
      hint: "OpsCrew supports Portainer 2.45 or newer; if yours is, please report this to OpsCrew.",
    });
  }
  return { stream, time: match[1] as string, line: text.slice(match[0].length) };
}

/**
 * The `since` value that asks for the lines after one with timestamp `time`:
 * `<seconds>.<nanoseconds>`, one nanosecond later (whole milliseconds would repeat the line).
 */
export function sinceAfter(time: string): string {
  const match = TIMESTAMP.exec(time);
  const ms = match === null ? Number.NaN : Date.parse(`${match[1]}${match[3]}`);
  if (match === null || Number.isNaN(ms)) {
    throw new OpsCrewError("INTERNAL", `"${time}" is not a Docker log timestamp.`);
  }
  let seconds = ms / 1000;
  let nanos = Number((match[2] ?? "").padEnd(9, "0")) + 1;
  if (nanos === 1_000_000_000) {
    seconds += 1;
    nanos = 0;
  }
  return `${seconds}.${String(nanos).padStart(9, "0")}`;
}

const cpuSchema = z.object({
  cpu_usage: z
    .object({
      total_usage: z.number().optional(),
      percpu_usage: z.array(z.number()).nullable().optional(),
    })
    .optional(),
  system_cpu_usage: z.number().optional(),
  online_cpus: z.number().optional(),
});

/** Docker's `…/stats?stream=false` answer, reduced to what the figures need. */
export const dockerStatsSchema = z.object({
  cpu_stats: cpuSchema,
  precpu_stats: cpuSchema,
  memory_stats: z.object({
    usage: z.number().optional(),
    stats: z.record(z.string(), z.number()).optional(),
  }),
});

/**
 * CPU % = (CPU delta / system delta) × online CPUs × 100. Memory is usage without `cache` on
 * cgroup v1 (where Docker reports it), else without `inactive_file` (cgroup v2), as `docker stats`
 * shows it. The limit is `containerInspect`'s (`HostConfig.Memory`), not this sample's.
 */
export function containerFigures(stats: z.output<typeof dockerStatsSchema>): ContainerFigures {
  const now = stats.cpu_stats;
  const before = stats.precpu_stats;
  const cpuDelta = (now.cpu_usage?.total_usage ?? 0) - (before.cpu_usage?.total_usage ?? 0);
  const systemDelta = (now.system_cpu_usage ?? 0) - (before.system_cpu_usage ?? 0);
  const cpus = now.online_cpus || now.cpu_usage?.percpu_usage?.length || 0;
  const cpuPercent = cpuDelta > 0 && systemDelta > 0 ? (cpuDelta / systemDelta) * cpus * 100 : 0;

  const memory = stats.memory_stats;
  const usage = memory.usage ?? 0;
  const reclaimable = memory.stats?.cache ?? memory.stats?.inactive_file ?? 0;
  return { cpuPercent, memoryUsedBytes: reclaimable < usage ? usage - reclaimable : usage };
}
