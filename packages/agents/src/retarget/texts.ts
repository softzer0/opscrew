import type { ApprovalRequest, Currency, VpsProviderId } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import type { CostEstimate, DeployPlan } from "@opscrew/plan-schema";
import { noServerCost } from "../design/own";
import { providerProfile } from "../providers";
import { HUNDRED_MB } from "./server-ops";

/** Continues a move. */
export const RUN_COMMAND = "opscrew retarget";
/** Ends a move after the switch: deletes a cloud old server, or removes the app from the old side. */
export const FINISH_COMMAND = "opscrew retarget --finish";
/** Undoes a move before the switch. */
export const ABORT_COMMAND = "opscrew retarget --abort";

/** The next step when no move is in progress. */
export const START_MOVE_HINT = `Start one with \`${RUN_COMMAND} --to <target>\`.`;

/** The stop of `--finish` or `--abort` (`verb`) when no move is in progress. */
export function noMove(verb: "finish" | "abort"): OpsCrewError {
  return new OpsCrewError(
    "PHASE_PRECONDITION",
    `No move is in progress, so there is nothing to ${verb}.`,
    { hint: START_MOVE_HINT },
  );
}

/** The next step while a move is being aborted. */
export const FINISH_ABORT_HINT = `Run \`${ABORT_COMMAND}\` to complete the abort.`;

/** Start of the title of the maintenance window's `remote-exec` approval. */
export const MAINTENANCE_WINDOW_TITLE = "Maintenance window:";

/**
 * True for the maintenance window's approval request (a `remote-exec` request whose title starts
 * with {@link MAINTENANCE_WINDOW_TITLE}). A non-interactive CLI run approves exactly this request
 * when `--allow-downtime` was given, and nothing else.
 */
export function isMaintenanceWindowRequest(
  request: Pick<ApprovalRequest, "kind" | "title">,
): boolean {
  return request.kind === "remote-exec" && request.title.startsWith(MAINTENANCE_WINDOW_TITLE);
}

/** `opscrew retarget … --approve <hash>` with the flags a scripted run needs. */
export function approveCommand(base: string, planHash: string, flags: readonly string[] = []) {
  return [base, ...flags, "--approve", planHash].join(" ");
}

/** The provider's name and what it calls a server, e.g. `DigitalOcean` and `Droplet`. */
export function providerWords(provider: VpsProviderId): { name: string; noun: string } {
  const profile = providerProfile(provider);
  return { name: profile.displayName, noun: profile.serverNoun };
}

/** True when OpsCrew manages the app's DNS records (Cloudflare with a domain). */
export function managedDns(plan: Pick<DeployPlan, "dns">): boolean {
  return plan.dns.provider === "cloudflare" && plan.dns.domain !== undefined;
}

/**
 * True when the old app stays stopped beyond the maintenance window: data is copied (`copies`)
 * and OpsCrew does not manage DNS, so the app is offline until the user's own DNS change (or,
 * without a domain, the users' move to the new address) has taken effect.
 */
export function downtimeUntilDnsChange(plan: Pick<DeployPlan, "dns">, copies: boolean): boolean {
  return copies && !managedDns(plan);
}

/** `until your DNS change has reached your users` (or, without a domain, the new address). */
export function untilSwitched(plan: Pick<DeployPlan, "dns">): string {
  return plan.dns.domain !== undefined
    ? "until your DNS change has reached your users"
    : "until your users use the new address";
}

/**
 * What the downtime means without OpsCrew-managed DNS and with a database to copy: it lasts for
 * the copy plus the user's DNS change, so lower the TTL first, and in scripts pass
 * `--allow-downtime --dns-switched` together only when the records are ready. `sides` are the old
 * and the new side in words. Empty otherwise.
 */
export function manualSwitchDowntime(
  plan: Pick<DeployPlan, "dns">,
  sides: { old: string; fresh: string },
  copies: boolean,
): string[] {
  if (!downtimeUntilDnsChange(plan, copies)) return [];
  const domain = plan.dns.domain;
  if (domain === undefined) {
    return [
      `Without a domain, the downtime lasts for the copy plus the time your users need to switch to the new address: the app on ${sides.old} stays stopped from the copy on.`,
      `In scripts, pass \`--allow-downtime --dns-switched\` together only when your users can switch right after the copy; with \`--allow-downtime\` alone the run stops after the copy, with the app offline, until you run \`${RUN_COMMAND} --dns-switched\`.`,
    ];
  }
  return [
    `Without OpsCrew-managed DNS, the downtime lasts for the copy plus your DNS change: the app on ${sides.old} stays stopped until the DNS records of ${domain} point to ${sides.fresh} and the change has reached your users.`,
    "Lower the TTL of those records beforehand (for example to 60 seconds), so the change reaches your users quickly.",
    `In scripts, pass \`--allow-downtime --dns-switched\` together only when the records are ready to change right after the copy; with \`--allow-downtime\` alone the run stops after the copy, with the app offline, until you change them and run \`${RUN_COMMAND} --dns-switched\`.`,
  ];
}

/** The cost of a side that costs a move nothing more: the user's own server, or their Portainer. */
export function noSideCost(
  provider: "own" | "portainer",
  currency: Currency,
  asOf: string,
): CostEstimate {
  const item =
    provider === "own"
      ? "Your own server (you already pay for it)"
      : "Your Portainer (you already run it)";
  return noServerCost(item, currency, asOf);
}

/** Rough maintenance window: two minutes plus one per started 100 MB copied through this computer. */
export function downtimeMinutes(databaseBytes: number): number {
  return 2 + Math.ceil(Math.max(0, databaseBytes) / HUNDRED_MB);
}

/** About 15 MB/s, the slower way (the archive `PUT`) through Portainer's Docker proxy (R5). */
const PORTAINER_BYTES_PER_MINUTE = 15 * 1024 * 1024 * 60;

/**
 * Rough length of a move's maintenance window for `bytes` of data copied through this computer:
 * {@link downtimeMinutes} between two servers over SSH, or two minutes plus one per started 900 MB
 * when a side is the user's Portainer (about 15 MB/s through its Docker proxy).
 */
export function windowMinutes(bytes: number, portainer: boolean): number {
  if (!portainer) return downtimeMinutes(bytes);
  return 2 + Math.ceil(Math.max(0, bytes) / PORTAINER_BYTES_PER_MINUTE);
}

/** What starting each kind of service empty loses, in a few words. */
const LOSES: Partial<Record<string, string>> = {
  postgres: "every table and row in it",
  mysql: "every table and row in it",
  mariadb: "every table and row in it",
  mongodb: "every collection and document in it",
  clickhouse: "every table and row in it",
  neo4j: "every node and relationship in it",
  rabbitmq: "the messages waiting in its queues",
  nats: "the messages its streams keep",
  kafka: "the messages its topics keep",
  redpanda: "the messages its topics keep",
  garage: "every file stored in it",
  opensearch: "its search index, which the app must build again",
  elasticsearch: "its search index, which the app must build again",
  meilisearch: "its search index, which the app must build again",
  typesense: "its search index, which the app must build again",
};

/**
 * What starting `owner` empty on the new side loses, in one sentence: a service of the plan by
 * its kind (a cache loses little, a queue its waiting jobs), `app` the app's own files (a SQLite
 * database, uploads), `monitoring` the metrics and logs collected so far.
 */
export function emptyLoses(plan: Pick<DeployPlan, "services">, owner: string): string {
  if (owner === "app")
    return "Starting it empty loses the app's own files (its SQLite database, uploads).";
  if (owner === "monitoring") {
    return "Starting it empty loses the metrics, logs and dashboards' history collected so far.";
  }
  const service = plan.services.find((s) => s.name === owner);
  const kind = service?.kind ?? "";
  if (kind === "valkey" || kind === "redis" || kind === "dragonfly") {
    return service !== undefined && "mode" in service.options && service.options.mode === "queue"
      ? "Starting it empty loses the jobs waiting in its queue: let the queue drain first, or copy it."
      : "Starting it empty loses its cached values, which is usually fine for a cache: the app fills it again.";
  }
  return `Starting it empty loses ${LOSES[kind] ?? "everything it stores"}.`;
}

/** `52.4 MB`, `1.2 GB`: a database size in plain words (1 MB is 1024 KB, as for the estimates). */
export function sizeText(bytes: number): string {
  const units = ["bytes", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return unit === 0 ? `${bytes} bytes` : `${value.toFixed(1)} ${units[unit]}`;
}
