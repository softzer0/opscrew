/**
 * Advise's reliability rules (spec US6): backups off while the data matters, and on an own server
 * or Portainer the scheduled snapshots and their off-server copy (024 FR-2410), the scheduled
 * check off for prod, a check that keeps failing and recovering, and a container restarting in a
 * loop.
 */
import { listText, plural } from "@opscrew/core";
import { isServerlessProvider, snapshotOffsiteOf, snapshotScheduleOf } from "@opscrew/plan-schema";
import { backupsByDefault } from "../../design/backups";
import { noProviderBackups } from "../../design/snapshots";
import { storagePrice } from "../../design/storage";
import { logParts } from "../../logs/parts";
import { providerProfile } from "../../providers";
import { dataServers } from "../../snapshot/hosts";
import { type Proposal, type Readings, THRESHOLDS } from "../types";
import {
  cloudServers,
  historyBasis,
  isPriced,
  orderPageReasons,
  PLAN,
  priceChange,
  readingBasis,
  serverCost,
} from "./shared";

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
    ...snapshotProposals(readings),
    ...checkProposals(readings),
    ...flapProposals(readings),
    ...restartProposals(readings),
  ];
}

/**
 * Each server without automated backups, at a provider that offers them through OpsCrew, in prod while
 * the interview says the data is important (`backupsByDefault`: dev and staging rely on OpsCrew's
 * own snapshots), priced without and with them when the prices list its type, except where only
 * the provider's order page prices them (`orderPageReasons`).
 */
function backupProposals(readings: Readings): Proposal[] {
  const { requirements, plan } = readings;
  if (requirements === undefined) return [];
  if (!backupsByDefault(requirements, plan.environment?.name ?? "prod")) return [];
  const criticality = requirements.dataCriticality;
  return (
    cloudServers(readings)
      // A provider without automated backups through OpsCrew gets the snapshot proposals instead.
      .filter((server) => !server.backups && providerProfile(server.provider).providerBackups)
      .map((server): Proposal => {
        const { name, provider } = server;
        // Backups priced only on the provider's order page get no € figure (Contabo's).
        const unpriced = orderPageReasons(provider);
        const price =
          isPriced(server) && unpriced.length === 0
            ? priceChange(
                serverCost(provider, server.prices.offer, server.prices.list, false),
                serverCost(provider, server.prices.offer, server.prices.list, true),
              )
            : undefined;
        return {
          id: `reliability.${name}.backups`,
          category: "reliability",
          urgency: "when-convenient",
          server: name,
          title: `Turn on automated backups for server ${name}`,
          reasons: [
            {
              text: `The interview says the app's data is ${criticality}, and server ${name} has no automated backups: a broken disk or a wrong command would lose it`,
              basis: PLAN,
            },
            ...unpriced,
          ],
          ...(price === undefined ? {} : { price }),
          apply: { kind: "plan", change: { kind: "backups", server: name, enabled: true } },
        };
      })
  );
}

/**
 * Where no provider backs the data up (`noProviderBackups`: an own server, Portainer, or a cloud
 * provider without automated backups through OpsCrew) and it matters, with data to
 * snapshot and outside a preview environment: the scheduled snapshots when they are off, and the
 * encrypted copy off the server when it is off, on Cloudflare R2 (priced as provision shows it)
 * when the domain is there, else at Hetzner or DigitalOcean in a region the user picks.
 */
function snapshotProposals({ plan, requirements, flags }: Readings): Proposal[] {
  const criticality = requirements?.dataCriticality;
  if (criticality !== "important" && criticality !== "critical") return [];
  const portainer = plan.target.provider === "portainer";
  if (!noProviderBackups(plan.target.provider)) return [];
  if (plan.environment?.previews !== undefined || dataServers(plan).length === 0) return [];
  const where = portainer ? "the Portainer host" : "your server";
  const data = `The interview says the app's data is ${criticality}`;
  const proposals: Proposal[] = [];
  if (snapshotScheduleOf(plan) === undefined) {
    proposals.push({
      id: "reliability.env.snapshot-schedule",
      category: "reliability",
      urgency: "when-convenient",
      title: "Take snapshots of the app's data on a schedule",
      reasons: [
        {
          text: `${data}, and nothing backs it up on ${where}: no snapshot is taken unless someone runs \`opscrew snapshot${flags}\``,
          basis: PLAN,
        },
      ],
      apply: { kind: "command", command: `opscrew snapshot schedule on${flags}` },
    });
  }
  if (snapshotOffsiteOf(plan) === undefined) {
    const r2 = plan.dns.provider === "cloudflare" && plan.dns.domain !== undefined;
    const price = storagePrice("r2", { storageGb: 0, egressGbPerMonth: 0 });
    proposals.push({
      id: "reliability.env.snapshot-offsite",
      category: "reliability",
      urgency: "when-convenient",
      title: `Keep an encrypted copy of each snapshot off ${portainer ? "the host" : "the server"}`,
      reasons: [
        {
          text: `${data}, and its snapshots stay on ${where}: losing it loses them too. The copy is encrypted to the recovery copy's age key, which only you hold`,
          basis: PLAN,
        },
      ],
      ...(r2
        ? {
            price: {
              before: 0,
              after: price.amount,
              currency: price.currency,
              source: "static" as const,
              asOf: price.checkedOn,
            },
            apply: {
              kind: "command" as const,
              command: `opscrew snapshot offsite on --to r2${flags}`,
            },
          }
        : {
            apply: {
              kind: "manual" as const,
              text: `Run \`opscrew snapshot offsite on --to hetzner --region <region>${flags}\` (or \`--to digitalocean\`) with the region the copies should be in, or keep them in your own S3-compatible bucket or on your own machine over SFTP (\`--to s3\`, \`--to sftp\`)`,
            },
          }),
    });
  }
  return proposals;
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
          text: "The scheduled check is off for prod, so nobody is told when the app stops answering. It runs in the repository's GitHub Actions and opens an issue when the app fails; it adds no server cost",
          basis: PLAN,
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
          text: `The scheduled check opened its issue on ${listText(days)}: the app stopped answering and came back each time`,
          figure: `${plural(check.length, "issue")} in ${THRESHOLDS.historyDays} days`,
          basis: { kind: "account" },
        },
        {
          text: `Look at the app's logs around those dates, and at \`opscrew status${flags}\` for a server short of memory or disk`,
          basis: PLAN,
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
          text: "Its container keeps restarting; deploys don't count, as each starts a new container",
          basis: historyBasis(history),
        }))
      : now.containers.map(({ service, restarts }) => ({
          service,
          restarts,
          text: "Its container has kept restarting since it was last deployed",
          basis: readingBasis(now),
        }));
    return counts
      .filter((count) => count.restarts >= THRESHOLDS.restarts)
      .map(
        ({ service, restarts, text, basis }): Proposal => ({
          id: `reliability.${server}.restart-loop-${service}`,
          category: "reliability",
          urgency: "soon",
          server,
          title: `Find out why ${service} keeps restarting on server ${server}`,
          reasons: [{ text, figure: plural(restarts, "restart"), basis }],
          apply: { kind: "command", command: logsCommand(readings, server, service) },
        }),
      );
  });
}
