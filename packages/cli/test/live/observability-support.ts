/**
 * The pure parts of feature 017's live passes (docs/e2e.md "Observability"): their settings, the
 * request log they add to the default example, and readers of what the CLI, GitHub, ntfy, Grafana
 * Cloud and the server answer. No network and no files.
 */
import { randomBytes } from "node:crypto";

/** Runs the observability pass on a cloud server: logs, status, the check, the leak search. */
export const OBSERVABILITY_GATE = "OPSCREW_E2E_OBSERVABILITY";
/** Runs the add-ons pass on a cloud server: Beszel, and Grafana Cloud with its variables. */
export const ADDONS_GATE = "OPSCREW_E2E_ADDONS";
/** The ntfy topic (on ntfy.sh) the check's webhook posts to. */
export const NTFY_TOPIC_VARIABLE = "OPSCREW_E2E_NTFY_TOPIC";

const GRAFANA = {
  metricsUrl: "OPSCREW_E2E_GRAFANA_CLOUD_METRICS_URL",
  metricsUser: "OPSCREW_E2E_GRAFANA_CLOUD_METRICS_USER",
  logsUrl: "OPSCREW_E2E_GRAFANA_CLOUD_LOGS_URL",
  logsUser: "OPSCREW_E2E_GRAFANA_CLOUD_LOGS_USER",
  token: "OPSCREW_E2E_GRAFANA_CLOUD_TOKEN",
  readToken: "OPSCREW_E2E_GRAFANA_CLOUD_READ_TOKEN",
} as const;

/** Grafana Cloud's variables: the stack's endpoints, the write token and the test's read token. */
export const GRAFANA_CLOUD_VARIABLES: readonly string[] = Object.values(GRAFANA);

/** The example the passes deploy: their request log (`proxy.ts`) is written for its Next.js. */
export const OBSERVABILITY_APP = "nextjs-postgres";

/** A Grafana Cloud free stack: where it receives, its user ids, and the two tokens. */
export type GrafanaCloudSettings = Record<keyof typeof GRAFANA, string>;

/** What the observability and add-on passes read from their variables. */
export interface ObservabilitySettings {
  /** `OPSCREW_E2E_OBSERVABILITY=1`: logs, status, the scheduled check with ntfy, the leak search. */
  check: boolean;
  /** The ntfy.sh topic of the check's webhook ("" without `check`). */
  ntfyTopic: string;
  /** `OPSCREW_E2E_ADDONS=1`: Beszel, and Grafana Cloud with {@link grafana}. */
  addons: boolean;
  grafana?: GrafanaCloudSettings;
}

/**
 * ntfy's topic rule, at least 16 characters: anyone who knows a topic on ntfy.sh can read it, so
 * the test's must be hard to guess.
 */
const NTFY_TOPIC = /^[A-Za-z0-9_-]{16,64}$/;

/**
 * The passes of feature 017 that `OPSCREW_E2E_OBSERVABILITY` and `OPSCREW_E2E_ADDONS` turn on for
 * `app` (an example name, `undefined` for a GitHub repository); `{ skip }` with the reason the run
 * is skipped (a missing variable, another app); or the line the Hetzner pass logs when neither is
 * set. Grafana Cloud runs with the add-ons only when all of its variables are set.
 */
export function observabilitySettings(
  app: string | undefined,
  env: Record<string, string | undefined>,
): ObservabilitySettings | { skip: string } | string {
  const value = (name: string) => env[name]?.trim() ?? "";
  const check = value(OBSERVABILITY_GATE) === "1";
  const addons = value(ADDONS_GATE) === "1";
  if (!check && !addons) {
    return `not checked: feature 017's observability (set ${OBSERVABILITY_GATE}=1 or ${ADDONS_GATE}=1; see docs/e2e.md)`;
  }
  if (app !== OBSERVABILITY_APP) {
    return {
      skip: `the observability passes add a request log to examples/${OBSERVABILITY_APP}, so they run with OPSCREW_E2E_APP=${OBSERVABILITY_APP} (the default)`,
    };
  }
  const ntfyTopic = check ? value(NTFY_TOPIC_VARIABLE) : "";
  if (check) {
    if (value("OPSCREW_E2E_CLOUDFLARE_TOKEN") === "" || value("OPSCREW_E2E_DOMAIN") === "") {
      return {
        skip: "the scheduled check checks the app's hostname over HTTPS: set OPSCREW_E2E_CLOUDFLARE_TOKEN and OPSCREW_E2E_DOMAIN",
      };
    }
    if (!NTFY_TOPIC.test(ntfyTopic)) {
      return {
        skip: `set ${NTFY_TOPIC_VARIABLE} to a topic on ntfy.sh of 16 to 64 letters, digits, "-" or "_" that nobody can guess (the check's webhook posts there)`,
      };
    }
  }
  const settings: ObservabilitySettings = { check, ntfyTopic, addons };
  const given = GRAFANA_CLOUD_VARIABLES.filter((name) => value(name) !== "");
  if (!addons || given.length === 0) return settings;
  const missing = GRAFANA_CLOUD_VARIABLES.filter((name) => value(name) === "");
  if (missing.length > 0) {
    return { skip: `Grafana Cloud's pass needs ${missing.join(", ")} too (docs/e2e.md)` };
  }
  const grafana = Object.fromEntries(
    Object.entries(GRAFANA).map(([key, name]) => [key, value(name)]),
  ) as GrafanaCloudSettings;
  return { ...settings, grafana };
}

// ---------------------------------------------------------------------------------------------
// The request log.

/** The start of every path the passes request, which the request log logs. */
export const REQUEST_PREFIX = "/opscrew-e2e-";
/** The app's variable holding the seeded secret (a name detection reads as a secret). */
export const SEEDED_VARIABLE = "SEEDED_SECRET";

/**
 * The files that make `app` log one line per request to a path starting with
 * {@link REQUEST_PREFIX}, so `logs --follow` has a request to show; `undefined` for an app they are
 * not written for. With `seeded`, a request to a path holding `-seeded-` also prints the app's
 * {@link SEEDED_VARIABLE}, the seeded secret of the leak search (SC-1704); only the test's own
 * requests do, so the test chooses when the secret is printed. A Next.js 16 proxy runs in the
 * server's own process, so its lines are the app container's.
 */
export function requestLogFiles(app: string, seeded = false): Record<string, string> | undefined {
  if (app !== OBSERVABILITY_APP) return undefined;
  const line = seeded
    ? `\`opscrew-e2e request \${request.method} \${pathname}\${pathname.includes("-seeded-") ? \` seeded=\${process.env.${SEEDED_VARIABLE}}\` : ""}\``
    : // biome-ignore lint/suspicious/noTemplateCurlyInString: TypeScript source for the app.
      "`opscrew-e2e request ${request.method} ${pathname}`";
  return {
    "proxy.ts": [
      "// Added by OpsCrew's live tests: one log line per request to the test's own paths.",
      "export function proxy(request: Request): void {",
      "  const { pathname } = new URL(request.url);",
      `  if (!pathname.startsWith("${REQUEST_PREFIX}")) return;`,
      `  console.log(${line});`,
      "}",
      "",
    ].join("\n"),
  };
}

/** A path of its own for one request: `/opscrew-e2e-follow-<hex>` or `/opscrew-e2e-seeded-<hex>`. */
export function requestPath(kind: "follow" | "seeded"): string {
  return `${REQUEST_PREFIX}${kind}-${randomBytes(6).toString("hex")}`;
}

/** The lines `opscrew logs` printed (`<time> <part> <text>`), without its first line. */
export function logLines(output: string): string[] {
  return output.split(/\r?\n/).filter((line) => /^\d{4}-\d{2}-\d{2}T\S+ \S+ /.test(line));
}

// ---------------------------------------------------------------------------------------------
// `opscrew status`' figures.

/** The figures block of `opscrew status` ("Resources (read now):"), line by line. */
export interface StatusFigures {
  /** "Server: …" */
  server?: string;
  /** "The Worker (last 24 hours): …" */
  worker?: string;
  /** Each part's line: "<part>: CPU …". */
  parts: string[];
  /** Each "Not available: …". */
  notAvailable: string[];
  /** Each "Warning: …" and "High: …". */
  flags: string[];
}

/** The figures `opscrew status` printed, or `undefined` when it printed none. */
export function statusFigures(output: string): StatusFigures | undefined {
  const lines = output.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === "Resources (read now):");
  if (start < 0) return undefined;
  const figures: StatusFigures = { parts: [], notAvailable: [], flags: [] };
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith("  ")) break;
    const text = line.trim();
    const after = (prefix: string) => (text.startsWith(prefix) ? text.slice(prefix.length) : "");
    if (after("Server: ") !== "") figures.server = after("Server: ");
    else if (after("The Worker (last 24 hours): ") !== "") figures.worker = text;
    else if (after("Not available: ") !== "") figures.notAvailable.push(after("Not available: "));
    else if (/^(Warning|High): /.test(text)) figures.flags.push(text);
    else if (/^[^:]+: CPU [\d.]+%/.test(text)) figures.parts.push(text);
  }
  return figures;
}

/** Where `status` runs: a server, a Portainer, this computer, or a Worker on Cloudflare. */
export type FiguresKind = "server" | "portainer" | "local" | "worker";

/** What `figures` lacks of what `status` must show for `kind` (US2), in words. */
export function figureProblems(figures: StatusFigures | undefined, kind: FiguresKind): string[] {
  if (figures === undefined) return ["status showed no resource figures"];
  if (kind === "worker") {
    return figures.worker === undefined ? ["status showed no line of the Worker's requests"] : [];
  }
  const problems: string[] = [];
  if (figures.parts.length === 0) problems.push("status showed no part of the app with its CPU");
  const server = figures.server ?? "";
  if (kind === "server") {
    if (!/^load [\d.]+, [\d.]+, [\d.]+ .* on \d+ CPUs?;/.test(server)) {
      problems.push("the server's line shows no load against its CPUs");
    }
    if (!/memory [\d.]+ [KMGT]?B used of /.test(server)) {
      problems.push("the server's line shows no memory used of its total");
    }
    if (!/disk .* used, .* free of .* \(\d+% full\)/.test(server)) {
      problems.push("the server's line shows no disk used and free");
    }
  }
  if (kind === "local" && !/memory /.test(server)) {
    problems.push("the line of this computer's Docker shows no memory");
  }
  if (kind === "portainer" && !figures.notAvailable.some((entry) => entry.includes("disk"))) {
    problems.push("status does not name the host's disk as not available");
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// The scheduled check.

/**
 * The bytes a file must hold to take the disk of `df -P -B1 /` (its last line) to `percent`, as
 * the check reads it (used of used and available, rounded up); 0 when it is there already.
 */
export function fillBytes(df: string, percent: number): number {
  const fields = df.trim().split(/\r?\n/).at(-1)?.trim().split(/\s+/) ?? [];
  const [, , used, free] = fields.map(Number);
  if (fields.length < 6 || used === undefined || free === undefined || !(used + free > 0)) {
    throw new Error("The server's `df -P -B1 /` answered in a form the test cannot read.");
  }
  return Math.max(0, Math.ceil((percent * (used + free)) / 100) - used);
}

/** The check's hidden marker in an issue's body: its key (`<app>/<env>/<check>/<target>`). */
export function issueKey(body: string | null | undefined): string | undefined {
  return /<!-- opscrew-check:(\S+) -->/.exec(body ?? "")?.[1];
}

/** How long the problem lasted, from the comment the check closes a recovered issue with. */
export function resolvedAfter(comments: readonly string[]): string | undefined {
  for (const comment of comments) {
    const lasted = /^Resolved after (.+)\.$/m.exec(comment)?.[1];
    if (lasted !== undefined) return lasted;
  }
  return undefined;
}

/** The minutes GitHub bills for a run: each job's time rounded up to a whole minute. */
export function billedMinutes(jobs: readonly { startedAt: string; completedAt: string }[]): number {
  return jobs.reduce((sum, job) => {
    const ms = Date.parse(job.completedAt) - Date.parse(job.startedAt);
    return sum + Math.max(1, Math.ceil(ms / 60_000));
  }, 0);
}

/** How many times a month (30 days) a check every `intervalMinutes` runs. */
export function monthlyRuns(intervalMinutes: number): number {
  return (60 / intervalMinutes) * 24 * 30;
}

/** ntfy's poll of `topic` on ntfy.sh: the messages since `sinceSeconds` (Unix time), as JSON lines. */
export function ntfyPollUrl(topic: string, sinceSeconds: number): string {
  return `https://ntfy.sh/${topic}/json?poll=1&since=${sinceSeconds}`;
}

/** One message ntfy kept. */
export interface NtfyMessage {
  time: number;
  title: string;
  message: string;
}

/** The messages of an ntfy poll's answer (one JSON object per line; other events left out). */
export function ntfyMessages(body: string): NtfyMessage[] {
  const messages: NtfyMessage[] = [];
  for (const line of body.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const event = JSON.parse(line) as {
      event?: string;
      time?: number;
      title?: string;
      message?: string;
    };
    if (event.event !== "message") continue;
    messages.push({
      time: event.time ?? 0,
      title: event.title ?? "",
      message: event.message ?? "",
    });
  }
  return messages;
}

// ---------------------------------------------------------------------------------------------
// Grafana Cloud.

/**
 * Loki's `query_range` of the stack whose push URL is `pushUrl` (the same host serves queries):
 * `query` from `startMs` on, at most `limit` lines.
 */
export function lokiQueryUrl(
  pushUrl: string,
  query: string,
  startMs: number,
  limit = 1000,
): string {
  const params = new URLSearchParams({
    query,
    start: `${startMs}000000`,
    limit: String(limit),
    direction: "forward",
  });
  return `${new URL(pushUrl).origin}/loki/api/v1/query_range?${params}`;
}

/**
 * Prometheus' instant query of the stack whose `remote_write` URL is `pushUrl`
 * (`…/api/prom/push` → `…/api/prom/api/v1/query`).
 */
export function prometheusQueryUrl(pushUrl: string, query: string): string {
  const base = pushUrl.replace(/\/push\/?$/, "");
  return `${base}/api/v1/query?${new URLSearchParams({ query })}`;
}

/** The streams of a Loki answer: each stream's labels and its lines. */
export function lokiStreams(json: unknown): { labels: Record<string, string>; lines: string[] }[] {
  const result = (
    json as {
      data?: { result?: { stream?: Record<string, string>; values?: [string, string][] }[] };
    }
  )?.data?.result;
  return (result ?? []).map((stream) => ({
    labels: stream.stream ?? {},
    lines: (stream.values ?? []).map(([, line]) => line),
  }));
}

/** The samples of a Prometheus instant vector: each series' labels and its value. */
export function promVector(json: unknown): { metric: Record<string, string>; value: number }[] {
  const result = (
    json as { data?: { result?: { metric?: Record<string, string>; value?: [number, string] }[] } }
  )?.data?.result;
  return (result ?? []).map((sample) => ({
    metric: sample.metric ?? {},
    value: Number(sample.value?.[1]),
  }));
}

// ---------------------------------------------------------------------------------------------
// The add-ons on the server.

/**
 * A read-only command listing what is left of the add-on whose Compose project is `project`: its
 * containers, volumes and networks (by Compose's label), and which of `paths` exist, one per line
 * (`container <id>`, `volume <name>`, `network <id>`, `path <path>`).
 */
export function addonLeftoverCommand(project: string, paths: readonly string[]): string {
  const label = `label=com.docker.compose.project=${project}`;
  return [
    `docker ps -aq --filter ${label} | sed 's/^/container /'`,
    `docker volume ls -q --filter ${label} | sed 's/^/volume /'`,
    `docker network ls -q --filter ${label} | sed 's/^/network /'`,
    `for f in ${paths.join(" ")}; do if [ -e "$f" ] || [ -L "$f" ]; then echo "path $f"; fi; done`,
  ].join("; ");
}

/** What {@link addonLeftoverCommand} found: counts by kind, and each path (never an id). */
export function addonLeftovers(output: string): string[] {
  const counts = new Map<string, number>();
  const paths: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const [kind, ...rest] = line.trim().split(" ");
    if (kind === "path") paths.push(rest.join(" "));
    else if (kind === "container" || kind === "volume" || kind === "network") {
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
  }
  return [
    ...[...counts].map(([kind, count]) => `${count} ${kind}${count === 1 ? "" : "s"}`),
    ...paths,
  ];
}

const UNITS: Readonly<Record<string, number>> = {
  B: 1,
  kB: 1e3,
  KB: 1e3,
  MB: 1e6,
  GB: 1e9,
  KiB: 1024,
  MiB: 1024 ** 2,
  GiB: 1024 ** 3,
};

/** Docker's memory use against the limit (`12.5MiB / 128MiB`), in bytes. */
export function memoryUsage(text: string): { usedBytes: number; limitBytes: number } | undefined {
  const match = /^([\d.]+) ?([kKMG]?i?B) \/ ([\d.]+) ?([kKMG]?i?B)$/.exec(text.trim());
  if (match === null) return undefined;
  const bytes = (value: string | undefined, unit: string | undefined) =>
    Number(value) * (UNITS[unit ?? ""] ?? Number.NaN);
  const usedBytes = bytes(match[1], match[2]);
  const limitBytes = bytes(match[3], match[4]);
  return Number.isFinite(usedBytes) && Number.isFinite(limitBytes)
    ? { usedBytes, limitBytes }
    : undefined;
}
