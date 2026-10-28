/**
 * `logs` of a server-rendered app on Cloudflare's hosting (US1 #4, research R2 and spike result
 * 6): the Worker's past requests from Workers Logs, and its live tail with `--follow`. Each
 * request shows its method, path, status and outcome, then its console lines and exceptions; the
 * connector keeps no query string, header or `cf` field.
 */
import type { CloudflareClient, TailEvent, WorkerLogEntry } from "@opscrew/connector-cloudflare";
import { OpsCrewError } from "@opscrew/core";
import type { CloudflareWorkersDeployTarget, DeployPlan } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { sharedCloudflareClient } from "../provision/shared-cloudflare";
import type { ProvisionServices } from "../provision/types";
import { type LogLine, type LogRead, logRead } from "./lines";

/** The Cloudflare clients `logs` and `status` take (fakes in tests). */
export type CloudflareReadServices = Pick<ProvisionServices, "cloudflare" | "sharedCloudflare">;

/** The day the allowances below were read from Cloudflare's pricing pages (research R2). */
const CHECKED_ON = "2026-10-28";

/**
 * Workers Logs' allowance, in order: each applies until its `until` day (UTC) included, the last
 * one after. Cloudflare publishes no API for it, so the table is dated (constitution: a static
 * fallback names its date). Sources: https://developers.cloudflare.com/workers/platform/pricing/
 * until 2026-11-30, then https://developers.cloudflare.com/observability/pricing/.
 */
const WORKERS_LOGS_ALLOWANCES: readonly { until?: string; words: string }[] = [
  {
    until: "2026-11-30",
    words:
      "3 days on Workers Free, up to 200,000 events a day, and 7 days on Workers Paid, up to 20 million a month; each request and each console line is one event",
  },
  {
    words:
      "7 days, up to 0.5 GB a day on the Free plan (then none until 00:00 UTC) and 50 GB a month on a paid plan (then $0.25 per GB)",
  },
];

/** How far back `logs` asks: the longest any plan keeps them. */
const KEPT_MS = 7 * 86_400_000;

/** The most requests one telemetry query returns. */
const QUERY_LIMIT = 2_000;

/** The first line: the dated allowance, what happens past it, and the half-minute delay. */
function firstLine(now: Date): string {
  const day = now.toISOString().slice(0, 10);
  const allowance =
    WORKERS_LOGS_ALLOWANCES.find((entry) => entry.until !== undefined && day <= entry.until) ??
    WORKERS_LOGS_ALLOWANCES.at(-1);
  return [
    `Cloudflare keeps a Worker's logs ${allowance?.words} (Cloudflare's prices as of ${CHECKED_ON}).`,
    "On the Free plan, lines past the allowance are not kept, and Cloudflare does not say when that happens.",
    "Requests from the last half-minute may not show yet (`--follow` shows them at once).",
  ].join(" ");
}

/**
 * OpsCrew's Cloudflare client and the account that holds the Worker: the one of the plan's zone.
 * @throws OpsCrewError `CREDENTIALS_MISSING` without `CLOUDFLARE_API_TOKEN`, and
 * `CREDENTIALS_INVALID` when the token cannot see the zone.
 */
export async function cloudflareWorkerAccount(
  deps: PhaseDeps,
  plan: DeployPlan,
  services: CloudflareReadServices = {},
): Promise<{ client: CloudflareClient; accountId: string }> {
  const client = sharedCloudflareClient(deps, services);
  const domain = plan.dns.domain;
  const zone =
    domain === undefined ? undefined : await (services.cloudflare ?? client).findZone(domain);
  if (zone?.accountId === undefined) {
    throw new OpsCrewError(
      "CREDENTIALS_INVALID",
      `CLOUDFLARE_API_TOKEN cannot see the zone of ${domain ?? "the app's domain"}, so OpsCrew cannot tell which Cloudflare account holds the app's Worker.`,
      {
        hint: "Set CLOUDFLARE_API_TOKEN to the token `opscrew provision` used for this app, then try again.",
      },
    );
  }
  return { client, accountId: zone.accountId };
}

/**
 * An entry as a line: a request's own (on stderr unless its outcome is `ok`), or one of its console
 * lines or exceptions (on stderr when an error or a warning).
 */
function entryLine(
  worker: string,
  entry: WorkerLogEntry,
  redact: (text: string) => string,
): LogLine {
  const request = entry.status !== undefined || entry.outcome !== undefined;
  const text = request
    ? [entry.message, entry.status, entry.outcome].filter((part) => part !== undefined).join(" ")
    : entry.error !== undefined
      ? `${entry.error}: ${entry.message}`
      : entry.message;
  const failed = request
    ? entry.outcome !== "ok"
    : entry.error !== undefined || entry.level === "error" || entry.level === "warn";
  return {
    time: entry.time,
    service: worker,
    stream: failed ? "stderr" : "stdout",
    text: redact(text),
  };
}

/** A live request's entries: its own, then its console lines and exceptions. */
function tailEntries(event: TailEvent): WorkerLogEntry[] {
  const own = [event.method, event.path].filter((part) => part !== undefined).join(" ");
  return [
    {
      time: event.time,
      level: "log",
      message: own,
      outcome: event.outcome,
      ...(event.status === undefined ? {} : { status: event.status }),
    },
    ...event.logs.map((line) => ({ time: event.time, ...line })),
    ...event.exceptions.map((e) => ({
      time: event.time,
      level: "error",
      message: e.message,
      error: e.name,
    })),
  ];
}

/**
 * The Worker's lines (US1 #4): its requests of the last 7 days (or `--since`), then with `follow`
 * its live tail until `signal` aborts. Here `tail` counts requests, not lines: the newest `tail`
 * requests (at most 2,000) are kept whole, each with all its console lines and exceptions.
 * `--service` takes only `app` or the Worker's name. Audited as a read at Cloudflare.
 * @throws OpsCrewError `INVALID_INPUT` for another `--service`; Cloudflare's refusal names the
 * missing permission.
 */
export async function cloudflareLogs(
  deps: PhaseDeps,
  plan: DeployPlan,
  target: CloudflareWorkersDeployTarget,
  options: {
    service?: string | undefined;
    sinceSeconds?: number | undefined;
    tail: number;
    follow?: boolean | undefined;
    signal?: AbortSignal | undefined;
    services?: CloudflareReadServices | undefined;
  },
): Promise<LogRead> {
  const { worker } = target;
  const service = options.service ?? "app";
  if (service !== "app" && service !== worker) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `The app has no part named "${service}". It is one part on Cloudflare's hosting, the Worker ${worker}, so --service takes app or ${worker}.`,
      { hint: "Without --service, `opscrew logs` shows the Worker's lines." },
    );
  }
  const { client, accountId } = await cloudflareWorkerAccount(deps, plan, options.services);
  const following = options.follow === true;
  deps.reporter.step(`Reading the lines of the Worker ${worker} at Cloudflare (read-only)`);
  await deps.audit.append({
    kind: "provider-call",
    actor: "opscrew",
    action: "read the app's logs (read-only)",
    target: "cloudflare",
    decision: "allow",
    detail: `${worker}${following ? ", following" : ""}`,
  });
  const now = deps.clock.now();
  const to = now.getTime();
  const from =
    options.sinceSeconds === undefined ? to - KEPT_MS : to - options.sinceSeconds * 1_000;
  const entries = await client.workersLogs(accountId, worker, {
    from,
    to,
    limit: Math.min(options.tail, QUERY_LIMIT),
  });
  const line = (entry: WorkerLogEntry) =>
    entryLine(worker, entry, (text) => deps.redactor.redact(text));
  const past = entries.map(line);
  const first = deps.redactor.redact(firstLine(now));
  if (!following) return logRead(first, past);
  return logRead(
    first,
    past,
    async (push, signal) => {
      deps.reporter.step(
        `Following the Worker's requests live. Cloudflare keeps one live log per Worker, so stopping this also stops \`wrangler tail\` or the dashboard's live logs of ${worker}.`,
      );
      await client.workersTail(accountId, worker, {
        signal,
        onEvent: (event) => {
          for (const entry of tailEntries(event)) push(line(entry));
        },
      });
    },
    options.signal,
  );
}
