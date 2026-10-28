import { z } from "zod";

/**
 * Cloudflare's Workers logs, live tail and analytics, as feature 017's spike measured them
 * (research.md "Spike results" 6). Only the request's method, path, status and outcome, its
 * console lines and its exceptions are kept: the request's headers and `cf` (the visitor's IP
 * address and location) and its query string (which can hold secrets) never are.
 */

/** One line of a Worker's past logs: a request, or one of its console lines or exceptions. */
export interface WorkerLogEntry {
  /** ISO time. */
  time: string;
  /** Cloudflare's level (`log` when it gives none). */
  level: string;
  /** `GET /path` for a request; the text of a console line or an exception. */
  message: string;
  /** The response's status, on a request. */
  status?: number;
  /** Cloudflare's outcome (`ok`, `exception` …), on a request. */
  outcome?: string;
  /** The exception's name, on an exception. */
  error?: string;
}

/** One request a Worker handled, as its live tail sends it. */
export interface TailEvent {
  /** ISO time. */
  time: string;
  /** Cloudflare's outcome (`ok`, `exception` …). */
  outcome: string;
  method?: string;
  /** The URL's path, without its query string. */
  path?: string;
  status?: number;
  logs: { level: string; message: string }[];
  exceptions: { name: string; message: string }[];
}

/** A Worker's figures since a given time, from Cloudflare's analytics. */
export interface WorkerAnalytics {
  requests: number;
  /** Requests that threw an exception (a 4xx or 5xx the Worker returns is not one). */
  errors: number;
  cpuTimeP50Ms: number;
  cpuTimeP99Ms: number;
}

/** The fixed id OpsCrew's telemetry queries carry (Cloudflare requires one). */
export const TELEMETRY_QUERY_ID = "opscrew-logs";

/** The telemetry query for a Worker's events between `from` and `to` (ms), grouped by request. */
export function telemetryQuery(worker: string, q: { from: number; to: number; limit: number }) {
  return {
    queryId: TELEMETRY_QUERY_ID,
    timeframe: { from: q.from, to: q.to },
    view: "invocations",
    limit: q.limit,
    parameters: {
      filters: [{ key: "$metadata.service", operation: "eq", type: "string", value: worker }],
    },
  };
}

/** A console line's or an exception's `source`; an invocation's may be anything else. */
const ConsoleSource = z.looseObject({
  message: z.unknown().optional(),
  level: z.string().nullish(),
  exception: z.looseObject({ name: z.string().nullish() }).nullish(),
});

const TelemetryEvent = z.looseObject({
  timestamp: z.number(),
  source: ConsoleSource.optional().catch(undefined),
  $workers: z
    .looseObject({
      outcome: z.string().nullish(),
      event: z
        .looseObject({
          request: z
            .looseObject({ method: z.string().nullish(), url: z.string().nullish() })
            .nullish(),
          path: z.string().nullish(),
          response: z.looseObject({ status: z.number().nullish() }).nullish(),
        })
        .nullish(),
    })
    .nullish(),
  $metadata: z.looseObject({
    type: z.string().nullish(),
    level: z.string().nullish(),
    message: z.string().nullish(),
    error: z.string().nullish(),
  }),
});
type TelemetryEvent = z.infer<typeof TelemetryEvent>;

/** The `result` of a telemetry query with `view: "invocations"`: events by request id. */
export const TelemetryInvocationsSchema = z.looseObject({
  invocations: z.record(z.string(), z.array(TelemetryEvent)).nullish(),
});

/** The type of a request's own event; its console lines and exceptions are `cf-worker`. */
const INVOCATION = "cf-worker-event";

/** A URL's path without its query string; `undefined` when there is neither. */
function pathOf(url: string | null | undefined, path?: string | null): string | undefined {
  if (url) {
    try {
      return new URL(url).pathname;
    } catch {
      // Not an absolute URL: fall back to Cloudflare's own path.
    }
  }
  return path?.split("?")[0] || undefined;
}

/** Console arguments as one line: strings as they are, anything else as JSON. */
export function consoleText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(consoleText).join(" ");
  return JSON.stringify(value) ?? String(value);
}

function requestEntry(event: TelemetryEvent): WorkerLogEntry {
  const request = event.$workers?.event?.request;
  const status = event.$workers?.event?.response?.status;
  const outcome = event.$workers?.outcome;
  const line = [request?.method, pathOf(request?.url, event.$workers?.event?.path)];
  return {
    time: new Date(event.timestamp).toISOString(),
    level: event.$metadata.level ?? "log",
    message: line.filter(Boolean).join(" "),
    ...(status == null ? {} : { status }),
    ...(outcome ? { outcome } : {}),
  };
}

function consoleEntry(event: TelemetryEvent): WorkerLogEntry {
  const source = event.source;
  const name = source?.exception?.name;
  const message =
    source?.message !== undefined
      ? consoleText(source.message)
      : (event.$metadata.error ?? event.$metadata.message ?? "");
  return {
    time: new Date(event.timestamp).toISOString(),
    level: source?.level ?? event.$metadata.level ?? "log",
    message,
    ...(source?.exception ? { error: name || "Error" } : {}),
  };
}

/**
 * The entries of a telemetry query's answer, oldest request first: each request's own line, then
 * its console lines and exceptions in order.
 */
export function toLogEntries(result: z.infer<typeof TelemetryInvocationsSchema>): WorkerLogEntry[] {
  const requests = Object.values(result.invocations ?? {}).map((events) => {
    const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp);
    const own = sorted.filter((e) => e.$metadata.type === INVOCATION);
    const lines = sorted.filter((e) => e.$metadata.type !== INVOCATION);
    return {
      start: sorted[0]?.timestamp ?? 0,
      entries: [...own.map(requestEntry), ...lines.map(consoleEntry)],
    };
  });
  return requests.sort((a, b) => a.start - b.start).flatMap((r) => r.entries);
}

/** One message of a Worker's live tail (`trace-v1`). */
export const TailMessageSchema = z.looseObject({
  outcome: z.string(),
  eventTimestamp: z.number(),
  event: z
    .looseObject({
      request: z.looseObject({ method: z.string().nullish(), url: z.string().nullish() }).nullish(),
      response: z.looseObject({ status: z.number().nullish() }).nullish(),
    })
    .nullish(),
  logs: z.array(z.looseObject({ message: z.unknown(), level: z.string().nullish() })).nullish(),
  exceptions: z
    .array(z.looseObject({ name: z.string().nullish(), message: z.string().nullish() }))
    .nullish(),
});

/** A tail message as a {@link TailEvent}. */
export function toTailEvent(message: z.infer<typeof TailMessageSchema>): TailEvent {
  const request = message.event?.request;
  const path = pathOf(request?.url);
  const status = message.event?.response?.status;
  return {
    time: new Date(message.eventTimestamp).toISOString(),
    outcome: message.outcome,
    ...(request?.method ? { method: request.method } : {}),
    ...(path ? { path } : {}),
    ...(status == null ? {} : { status }),
    logs: (message.logs ?? []).map((l) => ({
      level: l.level ?? "log",
      message: consoleText(l.message),
    })),
    exceptions: (message.exceptions ?? []).map((e) => ({
      name: e.name || "Error",
      message: e.message ?? "",
    })),
  };
}

/** The analytics query: one row per Worker (`scriptName` is the only dimension). */
export const ANALYTICS_QUERY = `query($account: string!, $since: Time!, $worker: string!) {
  viewer {
    accounts(filter: { accountTag: $account }) {
      workersInvocationsAdaptive(limit: 1, filter: { datetime_geq: $since, scriptName: $worker }) {
        sum { requests errors }
        quantiles { cpuTimeP50 cpuTimeP99 }
        dimensions { scriptName }
      }
    }
  }
}`;

/** The GraphQL answer to {@link ANALYTICS_QUERY}. */
export const AnalyticsAnswerSchema = z.looseObject({
  data: z
    .looseObject({
      viewer: z.looseObject({
        accounts: z.array(
          z.looseObject({
            workersInvocationsAdaptive: z.array(
              z.looseObject({
                sum: z.looseObject({ requests: z.number(), errors: z.number() }),
                quantiles: z.looseObject({ cpuTimeP50: z.number(), cpuTimeP99: z.number() }),
              }),
            ),
          }),
        ),
      }),
    })
    .nullish(),
  errors: z
    .array(
      z.looseObject({
        message: z.string().default(""),
        extensions: z.looseObject({ code: z.string().nullish() }).nullish(),
      }),
    )
    .nullish(),
});

/** The Worker's figures in the answer; none (no request since then) reads as zero. */
export function toAnalytics(answer: z.infer<typeof AnalyticsAnswerSchema>): WorkerAnalytics {
  const row = answer.data?.viewer.accounts[0]?.workersInvocationsAdaptive[0];
  return {
    requests: row?.sum.requests ?? 0,
    errors: row?.sum.errors ?? 0,
    // Cloudflare's CPU quantiles are in microseconds.
    cpuTimeP50Ms: (row?.quantiles.cpuTimeP50 ?? 0) / 1000,
    cpuTimeP99Ms: (row?.quantiles.cpuTimeP99 ?? 0) / 1000,
  };
}
