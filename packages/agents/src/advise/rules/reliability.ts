/**
 * Advise's reliability rules (spec US6): backups off while the data matters, the scheduled check
 * off for prod, a check that keeps failing and recovering, and a container restarting in a loop.
 */
import { listText, plural } from "@opscrew/core";
import {
  APP_SERVER,
  type CloudProvider,
  type DeployPlan,
  isServerlessProvider,
} from "@opscrew/plan-schema";
import { pricedOffer } from "../../design/cost";
import { logParts } from "../../logs/parts";
import { type Proposal, type ProposalPrice, type Readings, THRESHOLDS } from "../types";
import { serverPrices } from "./shared";

/**
 * `opscrew logs` for the container `service` on `server`: `--service` with the part's name when
 * `logs` knows it (by name, or by its container, as the edge proxy's `edge`), else the web
 * process's lines.
 */
function logsCommand({ plan, flags }: Readings, server: string, service: string): string {
  const parts = logParts(plan).filter((part) => part.server === server);
  const part =
    parts.find((p) => p.service === service) ?? parts.find((p) => p.composeService === service);
  return `opscrew logs${part === undefined ? "" : ` --service ${part.service}`}${flags}`;
}

/** The reliability proposals: backups, the scheduled check, check flaps, restart loops. */
export function reliabilityRules(readings: Readings): Proposal[] {
  // Cloudflare's hosting and GitHub Pages run no server and get only the upkeep proposals.
  if (isServerlessProvider(readings.plan.target.provider)) return [];
  return [
    ...backupProposals(readings),
    ...checkProposals(readings),
    ...flapProposals(readings),
    ...restartProposals(readings),
  ];
}

/** A server OpsCrew created, by its plan name. */
interface CloudServer {
  name: string;
  target: { provider: CloudProvider; location: string; serverType: string; backups: boolean };
}

/** The app's servers on Hetzner Cloud or DigitalOcean, the app's first. */
function cloudServers(plan: DeployPlan): CloudServer[] {
  const servers = [{ name: APP_SERVER, target: plan.target }, ...(plan.servers ?? [])];
  return servers.flatMap(({ name, target }) =>
    target.provider === "hetzner" || target.provider === "digitalocean" ? [{ name, target }] : [],
  );
}

/** Each server without automated backups while the interview says the data is important. */
function backupProposals(readings: Readings): Proposal[] {
  const criticality = readings.requirements?.dataCriticality;
  if (criticality !== "important" && criticality !== "critical") return [];
  return cloudServers(readings.plan)
    .filter((server) => !server.target.backups)
    .map(({ name, target }): Proposal => {
      const price = backupsPrice(readings, target);
      return {
        id: `reliability.${name}.backups`,
        category: "reliability",
        urgency: "when-convenient",
        server: name,
        title: `Turn on automated backups for server ${name}`,
        reasons: [
          {
            text: `The interview says the app's data is ${criticality}, and server ${name} has no automated backups: a broken disk or a wrong command would lose it.`,
            figure: criticality,
            basis: { kind: "plan" },
          },
        ],
        ...(price === undefined ? {} : { price }),
        apply: { kind: "plan", change: { kind: "backups", server: name, enabled: true } },
      };
    });
}

/** The server's monthly price without and with backups; none when its type has no price. */
function backupsPrice(
  readings: Readings,
  target: CloudServer["target"],
): ProposalPrice | undefined {
  const prices = serverPrices(readings, target);
  if (prices === undefined) return undefined;
  const { list, offer } = prices;
  const without = pricedOffer(offer, list.extras, { backups: false }).cost;
  const withBackups = pricedOffer(offer, list.extras, { backups: true }).cost;
  return {
    before: without.monthly.amount,
    after: withBackups.monthly.amount,
    currency: withBackups.monthly.currency,
    source: withBackups.source,
    asOf: withBackups.asOf,
  };
}

/** The scheduled check off for prod, where GitHub can reach the app. */
function checkProposals({ plan }: Readings): Proposal[] {
  const prod = plan.environment?.name === undefined;
  const reachable = plan.target.provider !== "localhost";
  if (!prod || !reachable || plan.observability?.check?.enabled === true) return [];
  return [
    {
      id: "reliability.env.check",
      category: "reliability",
      urgency: "when-convenient",
      title: "Turn on the scheduled check for prod",
      reasons: [
        {
          text: "The scheduled check is off for prod, so nobody is told when the app stops answering. It runs in the repository's GitHub Actions and opens an issue when the app fails; it adds no server cost.",
          basis: { kind: "plan" },
        },
      ],
      apply: { kind: "plan", change: { kind: "check", enabled: true } },
    },
  ];
}

/** The scheduled check opened its issue `checkFlaps` times or more in the period. */
function flapProposals({ check = [], flags }: Readings): Proposal[] {
  if (check.length < THRESHOLDS.checkFlaps) return [];
  const days = [...new Set(check.map((issue) => issue.createdAt.slice(0, 10)))].sort();
  return [
    {
      id: "reliability.env.check-flaps",
      category: "reliability",
      urgency: "soon",
      title: "Find out why the app keeps failing its scheduled check",
      reasons: [
        {
          text: `The scheduled check opened its issue ${check.length} times in ${THRESHOLDS.historyDays} days, on ${listText(days)}: the app stopped answering and came back each time. Look at the app's logs around those dates, and at \`opscrew status${flags}\` for a server short of memory or disk.`,
          figure: plural(check.length, "issue"),
          basis: { kind: "account" },
        },
      ],
      apply: {
        kind: "command",
        command: `opscrew logs --since ${THRESHOLDS.historyDays}d${flags}`,
      },
    },
  ];
}

/**
 * Each container that restarted `restarts` times or more: over the history when the server has
 * one (per container, so deploys don't count), else on the one reading.
 */
function restartProposals(readings: Readings): Proposal[] {
  return Object.entries(readings.servers).flatMap(([server, { now, history }]) => {
    const counts = history
      ? history.containers.map(({ service, restarts = 0 }) => ({
          service,
          restarts,
          when: `in ${plural(Math.round(history.days), "day")}; deploys don't count, as each starts a new container`,
          basis: { kind: "history" as const, days: history.days },
        }))
      : now.containers.map(({ service, restarts }) => ({
          service,
          restarts,
          when: "since it was last deployed",
          basis: { kind: "one-reading" as const, at: now.takenAt },
        }));
    return counts
      .filter((count) => count.restarts >= THRESHOLDS.restarts)
      .map(
        ({ service, restarts, when, basis }): Proposal => ({
          id: `reliability.${server}.restart-loop-${service}`,
          category: "reliability",
          urgency: "soon",
          server,
          title: `Find out why ${service} keeps restarting on server ${server}`,
          reasons: [
            {
              text: `Its container restarted ${restarts} times ${when}.`,
              figure: plural(restarts, "restart"),
              basis,
            },
          ],
          apply: { kind: "command", command: logsCommand(readings, server, service) },
        }),
      );
  });
}
