/**
 * `opscrew logs` (US1, FR-1701–FR-1703): the app's lines on every target, newest last, read-only
 * through the access `status` already uses, each line masked by the redactor with the app's known
 * values registered first.
 */
import { type ContainerLogLine, sinceAfter } from "@opscrew/connector-portainer";
import { OpsCrewError } from "@opscrew/core";
import { type DeployPlan, isServerlessProvider } from "@opscrew/plan-schema";
import { formatUtc } from "@opscrew/secops";
import type { PhaseDeps } from "../context";
import { hostingLogs } from "../hosting/logs";
import { registerAppSecrets } from "../shared/app-secrets";
import { hasExtraServers } from "../shared/servers";
import { cloudflareLogs } from "./cloudflare";
import { parseSince } from "./commands";
import { readFailedLogs } from "./failed";
import { type LogLine, type LogRead, logRead } from "./lines";
import { logPart } from "./parts";
import { siteDeployRuns } from "./sites";
import { byTime, dockerLogs, type LogServices } from "./targets";

/** Options of {@link readLogs}: the command's flags, and fakes in tests. */
export interface LogOptions {
  /**
   * `--service`: the web process (`app`, the default), a worker, a cron job or a service by its
   * plan name, `cron`, or `edge`, the proxy in front of the app.
   */
  service?: string;
  /** `--since`: only lines of the last `30s`, `15m`, `2h` or `3d`. */
  since?: string;
  /** `--tail`: how many of the latest lines (default 200; with `failed`, every kept line). */
  tail?: number;
  /** `--follow`: then the new lines as they come, until `signal` aborts. */
  follow?: boolean;
  /**
   * `--failed`: the lines the deploy kept of the last copy that failed its checks (FR-1910), of
   * the part that failed unless `service` names another. Not with `since` or `follow`.
   */
  failed?: boolean;
  /** Stops a follow (Ctrl-C). */
  signal?: AbortSignal;
  /** A server the user owns: `--host-key SHA256:…` for the first connection from this computer. */
  hostKey?: string;
  /**
   * The server's shell, the own server's fakes, Portainer's client and the poll's sleep, and
   * Cloudflare's clients (tests).
   */
  services?: LogServices;
}

/** Lines `logs` shows without `--tail`. */
const DEFAULT_TAIL = 200;

/** What every container keeps (10 MB × 3 files, `runtime/services.ts`). */
const KEPT = "Each deploy starts new containers, and each keeps up to 30 MB of logs.";

/** The first line: from when the lines are, and why older ones are gone. */
function firstLine(oldest: string | undefined, since: string | undefined, note?: string): string {
  const range =
    oldest !== undefined
      ? `The oldest line here is from ${formatUtc(oldest)}.`
      : since !== undefined
        ? `No lines in the last ${since}.`
        : "No lines yet.";
  return [range, KEPT, ...(note === undefined ? [] : [note])].join(" ");
}

/**
 * The app's log lines on the plan's target (FR-1701), after registering the app's known values
 * with the redactor (FR-1702). Read-only (FR-1703):
 * - **Servers:** `docker logs` over the access `status` uses, as `deploy` on a server OpsCrew
 *   created and through the pinned admin login on the user's own; a follow ends with ssh. A
 *   service placed on an extra server (feature 018) is read there, and the lines name the server.
 * - **Portainer:** its Docker API; a follow asks again every 2 seconds.
 * - **This computer:** Docker through the runner.
 * - **A server-rendered app on Cloudflare:** the Worker's requests from Workers Logs, and its live
 *   tail when following (`cloudflareLogs`).
 * - **GitHub Pages and a static site on Cloudflare:** no request logs; the last deploy runs.
 * - **A hosting account:** the agent's last lines, through the panel's files (`hostingLogs`).
 *
 * With `failed`, the lines the deploy kept of the last failed copy instead (`readFailedLogs`).
 *
 * Every read of containers is audited as `remote-exec`, and of a Worker as `provider-call`,
 * without an address. Errors (an unknown `--service`, a server that does not answer, a permission
 * Cloudflare refused) reject before any line.
 * @throws OpsCrewError `INVALID_INPUT` for a bad `--service`, `--since` or `--tail`.
 */
export async function readLogs(
  deps: PhaseDeps,
  plan: DeployPlan,
  options: LogOptions = {},
): Promise<LogRead> {
  await registerAppSecrets(deps, plan);
  const tail = options.tail ?? DEFAULT_TAIL;
  if (!Number.isSafeInteger(tail) || tail <= 0) {
    throw new OpsCrewError("INVALID_INPUT", "--tail takes a positive whole number of lines.", {
      hint: `For example \`--tail 50\`. Without it, \`opscrew logs\` shows the last ${DEFAULT_TAIL}.`,
    });
  }
  if (plan.target.provider === "hosting") {
    return hostingLogs(deps, plan, { ...options, tail });
  }
  if (options.failed === true) {
    return readFailedLogs(deps, plan, options);
  }
  const seconds = options.since === undefined ? undefined : parseSince(options.since);
  const { target } = plan;
  if (target.provider === "cloudflare-workers" && target.render === "ssr") {
    return cloudflareLogs(deps, plan, target, {
      service: options.service,
      sinceSeconds: seconds,
      tail,
      follow: options.follow,
      signal: options.signal,
      services: options.services,
    });
  }
  if (isServerlessProvider(target.provider)) {
    const site = await siteDeployRuns(deps, plan);
    return logRead(
      deps.redactor.redact(site.first),
      site.lines.map((line) => ({ ...line, text: deps.redactor.redact(line.text) })),
    );
  }

  const part = logPart(plan, options.service ?? "app");
  const place = await dockerLogs(deps, plan, { ...options, server: part.server });
  deps.reporter.step(`Reading the lines of ${part.what} ${place.where} (read-only)`);
  await deps.audit.append({
    kind: "remote-exec",
    actor: "opscrew",
    action: "read the app's logs (read-only)",
    target: place.audit,
    decision: "allow",
    detail: `${part.service}${options.follow === true ? ", following" : ""}`,
  });
  const containers = await place.containers(part);
  if (containers.length === 0) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `There is no container of ${part.what} ${place.where}, so it has no lines.`,
      { hint: "`opscrew status` shows what runs. A part starts with the app's next deploy." },
    );
  }
  const since =
    seconds === undefined
      ? undefined
      : String(Math.floor(deps.clock.now().getTime() / 1000) - seconds);
  const read = await Promise.all(
    containers.map(async (container) =>
      (await place.read(container, { tail, ...(since === undefined ? {} : { since }) })).sort(
        byTime,
      ),
    ),
  );
  const line = (raw: ContainerLogLine): LogLine => ({
    time: raw.time,
    service: part.service,
    stream: raw.stream,
    text: deps.redactor.redact(raw.line),
  });
  const past = read.flat().sort(byTime).slice(-tail);
  // With extra servers, the first line says which server the lines are from.
  const from = hasExtraServers(plan) ? [`These lines are from server ${part.server}.`] : [];
  const note = [...from, ...(part.note === undefined ? [] : [part.note])].join(" ");
  const first = deps.redactor.redact(
    firstLine(past[0]?.time, options.since, note === "" ? undefined : note),
  );
  if (options.follow !== true) return logRead(first, past.map(line));
  // Each container goes on after the last line read of it, so no line shows twice.
  const follow = async (push: (line: LogLine) => void, signal: AbortSignal) => {
    await Promise.all(
      containers.map((container, index) => {
        const last = read[index]?.at(-1);
        const after = last === undefined ? since : sinceAfter(last.time);
        return place.follow(
          container,
          { tail, ...(after === undefined ? {} : { since: after }) },
          (raw) => push(line(raw)),
          signal,
        );
      }),
    );
  };
  return logRead(first, past.map(line), follow, options.signal);
}
