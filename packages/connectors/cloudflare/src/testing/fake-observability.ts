import type { TailSocket } from "../client";

/**
 * Workers logs, live tail and analytics as feature 017's spike measured them (research.md "Spike
 * results" 6), for {@link FakeZone}. Requests carry the visitor's address in their headers and
 * `cf`, as Cloudflare's do, so tests can check it is never kept.
 */

/** The visitor's address the fake's requests carry (a documentation address). */
export const FAKE_VISITOR_IP = "203.0.113.7";

/** A request a Worker of the fake account handled. */
export interface FakeWorkerRequest {
  worker: string;
  requestId: string;
  /** Unix ms. */
  time: number;
  method: string;
  /** The full URL, query string included. */
  url: string;
  status: number;
  /** Default `ok`, or `exception` with {@link FakeWorkerRequest.exception}. */
  outcome?: string;
  /** Console lines; `level` is absent for a plain `console.log`, as Cloudflare sends it. */
  logs?: { message: string; level?: string }[];
  exception?: { name: string; message: string };
}

/** A Worker's figures, as GraphQL answers them (CPU time in microseconds). */
export interface FakeWorkerFigures {
  requests: number;
  errors: number;
  cpuTimeP50: number;
  cpuTimeP99: number;
}

const HEADERS = { "cf-connecting-ip": FAKE_VISITOR_IP, "user-agent": "curl/8.5.0" };
const CF = { country: "RS", city: "Belgrade", clientTcpRtt: 12, asn: 64496 };

function outcome(request: FakeWorkerRequest): string {
  return request.outcome ?? (request.exception ? "exception" : "ok");
}

function errorText(e: { name: string; message: string }): string {
  return `${e.name}: ${e.message}`;
}

/** The request's events as the telemetry query answers them: its own, then one per line. */
export function telemetryEvents(request: FakeWorkerRequest): Record<string, unknown>[] {
  const url = new URL(request.url);
  const metadata = {
    requestId: request.requestId,
    rayId: `ray-${request.requestId}`,
    service: request.worker,
  };
  const shortRequest = {
    method: request.method,
    url: request.url,
    path: url.pathname,
    search: Object.fromEntries(url.searchParams),
  };
  const lines: Record<string, unknown>[] = (request.logs ?? []).map((line, i) => ({
    source: { message: line.message, ...(line.level ? { level: line.level } : {}) },
    dataset: "cloudflare-workers",
    timestamp: request.time + i + 1,
    $workers: { event: { request: shortRequest } },
    $metadata: {
      ...metadata,
      type: "cf-worker",
      message: line.message,
      ...(line.level ? { level: line.level } : {}),
    },
  }));
  const exception = request.exception;
  if (exception) {
    lines.push({
      source: {
        message: exception.message,
        exception: {
          name: exception.name,
          stack: `${errorText(exception)}\n    at worker.js:1:1`,
          timestamp: request.time + lines.length + 1,
        },
      },
      dataset: "cloudflare-workers",
      timestamp: request.time + lines.length + 1,
      $workers: { event: { request: shortRequest } },
      $metadata: {
        ...metadata,
        type: "cf-worker",
        level: "error",
        message: exception.message,
        error: errorText(exception),
      },
    });
  }
  const own = {
    source: {},
    dataset: "cloudflare-workers",
    timestamp: request.time,
    $workers: {
      outcome: outcome(request),
      eventType: "fetch",
      wallTimeMs: 4,
      cpuTimeMs: 1,
      scriptName: request.worker,
      scriptVersion: { id: "33333333-3333-4333-8333-333333333333" },
      event: {
        request: { method: request.method, url: request.url, headers: HEADERS, cf: CF },
        path: url.pathname,
        search: Object.fromEntries(url.searchParams),
        response: { status: request.status },
      },
    },
    $metadata: {
      ...metadata,
      type: "cf-worker-event",
      trigger: `${request.method} ${url.pathname}`,
      level: exception ? "error" : "info",
      message: `${request.method} ${request.url}`,
      ...(exception ? { error: errorText(exception) } : {}),
    },
  };
  return [own, ...lines];
}

/** The request as one `trace-v1` message of the live tail. */
export function tailMessage(request: FakeWorkerRequest): Record<string, unknown> {
  return {
    wallTime: 4,
    cpuTime: 1,
    truncated: false,
    executionModel: "stateless",
    outcome: outcome(request),
    scriptName: request.worker,
    diagnosticsChannelEvents: [],
    exceptions: request.exception ? [{ ...request.exception, timestamp: request.time + 1 }] : [],
    logs: (request.logs ?? []).map((line, i) => ({
      message: [line.message],
      level: line.level ?? "log",
      timestamp: request.time + i,
    })),
    eventTimestamp: request.time,
    event: {
      request: { url: request.url, method: request.method, headers: HEADERS, cf: CF },
      response: { status: request.status },
    },
  };
}

/** The GraphQL answer for a Worker's figures (no row when it has none). */
export function analyticsAnswer(worker: string, figures: FakeWorkerFigures | undefined) {
  const rows = figures
    ? [
        {
          dimensions: { scriptName: worker },
          quantiles: { cpuTimeP50: figures.cpuTimeP50, cpuTimeP99: figures.cpuTimeP99 },
          sum: { requests: figures.requests, errors: figures.errors, subrequests: 0 },
        },
      ]
    : [];
  return { data: { viewer: { accounts: [{ workersInvocationsAdaptive: rows }] } }, errors: null };
}

/**
 * A WebSocket to a Worker's live tail. Like Cloudflare's, it never emits `close` after `close()`
 * (the closing handshake never completes), so a client that waits for it would hang.
 */
export class FakeTailSocket implements TailSocket {
  binaryType = "blob";
  /** How often `close()` was called. */
  closeCalls = 0;
  readonly #listeners = new Map<string, ((event: { data: unknown }) => void)[]>();

  constructor(
    readonly url: string,
    readonly protocol: string,
  ) {}

  addEventListener(type: string, listener: (event: { data: unknown }) => void): void {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
  }

  close(): void {
    this.closeCalls++;
  }

  /** Sends `message` as a frame: binary JSON with `binaryType` `arraybuffer`, else a `Blob`. */
  send(message: unknown): void {
    const json = JSON.stringify(message);
    const data =
      this.binaryType === "arraybuffer" ? new TextEncoder().encode(json).buffer : new Blob([json]);
    this.emit("message", data);
  }

  /** Emits `type` to the listeners. */
  emit(type: "message" | "close" | "error", data?: unknown): void {
    for (const listener of this.#listeners.get(type) ?? []) listener({ data });
  }
}
