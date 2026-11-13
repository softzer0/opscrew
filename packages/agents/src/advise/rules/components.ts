/**
 * Advise's component rules (spec US8): Postgres taking most of a short app server's memory gets a
 * server of its own (018), priced; a filling disk while Garage keeps the app's files on it gets a
 * provider's object storage, priced. A cache is design's to add, not advise's.
 */
import type { ComputeOffer } from "@opscrew/contracts";
import { STORAGE_NAMES } from "@opscrew/iac-templates";
import { APP_SERVER, serviceOf } from "@opscrew/plan-schema";
import { backupsByDefault } from "../../design/backups";
import { convertMoney, roundCents } from "../../design/cost";
import { cheapestServerOffer, extraServerNeed } from "../../design/servers";
import { storageOffers } from "../../design/storage";
import { sizeText } from "../../retarget/texts";
import { monitoringLimits } from "../../shared/memory";
import { type Proposal, type Readings, THRESHOLDS } from "../types";
import {
  cloudServers,
  diskFilling,
  historyBasis,
  isPriced,
  PLAN,
  percent,
  percentAbove,
  priceSource,
  serverCost,
  withoutStop,
} from "./shared";

/** The component proposals: Postgres on its own server, object storage. */
export function componentRules(readings: Readings): Proposal[] {
  return [...databaseServerProposals(readings), ...objectStorageProposals(readings)];
}

/** The name proposed for the database's own server. */
const DATABASE_SERVER = "db";

/**
 * Postgres on the app's Hetzner or DigitalOcean server, its container's p95 memory above
 * `databaseShare` of the server's while the server's p95 memory is above `memoryHigh`: a server of
 * its own, sized and priced as design does an extra server (the add-ons' containers on it, backups
 * in prod unless the interview says the data doesn't matter: `backupsByDefault`).
 */
function databaseServerProposals(readings: Readings): Proposal[] {
  const { plan, flags } = readings;
  const app = cloudServers(readings).find((s) => s.name === APP_SERVER);
  if (app === undefined) return [];
  const postgres = serviceOf(plan, "postgres");
  if (postgres === undefined || (postgres.server ?? APP_SERVER) !== APP_SERVER) return [];
  const read = readings.servers[APP_SERVER];
  const history = read?.history;
  const total = read?.now.server?.memory.totalBytes;
  const used = history?.containers.find((c) => c.service === postgres.name)?.memoryP95;
  if (history?.memoryP95 === undefined || total === undefined || used === undefined) return [];
  const share = used / total;
  if (history.memoryP95 <= THRESHOLDS.memoryHigh || share <= THRESHOLDS.databaseShare) return [];

  const need = extraServerNeed([postgres], monitoringLimits(plan, DATABASE_SERVER));
  let own: ComputeOffer | undefined;
  let price: Proposal["price"];
  if (isPriced(app)) {
    const { offer, list } = app.prices;
    own = cheapestServerOffer(list.offers, app.location, need);
    if (own !== undefined) {
      const before = serverCost(app.provider, offer, list, app.backups);
      const { requirements } = readings;
      const backups =
        requirements === undefined ||
        backupsByDefault(requirements, plan.environment?.name ?? "prod");
      const added = serverCost(app.provider, own, list, backups);
      price = {
        before: before.monthly.amount,
        after: roundCents(before.monthly.amount + added.monthly.amount),
        currency: before.monthly.currency,
        ...priceSource([before, added]),
      };
    }
  }
  const basis = historyBasis(history);
  return [
    {
      id: `components.${APP_SERVER}.database-server`,
      category: "components",
      urgency: "when-convenient",
      server: APP_SERVER,
      title: `Give Postgres (${postgres.name}) a server of its own${own === undefined ? "" : `, a ${own.id}`}`,
      reasons: [
        {
          text: `Postgres (${postgres.name}) takes over ${percent(THRESHOLDS.databaseShare)} of server ${APP_SERVER}'s memory at the 95th percentile`,
          figure: `${percentAbove(share)} of ${sizeText(total)}`,
          basis,
        },
        {
          text: `A server of its own for Postgres is the other way to a larger one: server ${APP_SERVER}'s memory in use at the 95th percentile is above ${percent(THRESHOLDS.memoryHigh)}`,
          figure: `${percentAbove(history.memoryP95)} of ${sizeText(total)}`,
          basis,
        },
        {
          text: "Provision copies its data to the new server; the app is offline about 2 minutes, plus a minute for every 100 MB",
          basis: PLAN,
        },
      ],
      ...(price === undefined ? {} : { price }),
      apply: {
        kind: "manual",
        text: `Add a server ${DATABASE_SERVER} (servers in opscrew/plan.yaml) and set server: ${DATABASE_SERVER} on the Postgres service, then run \`opscrew design${flags}\` and \`opscrew provision${flags}\``,
      },
    },
  ];
}

/** Garage keeping the app's files on a filling disk: the provider's object storage, priced. */
function objectStorageProposals(readings: Readings): Proposal[] {
  const { plan, requirements, flags } = readings;
  const storage = plan.storage?.objectStorage;
  const garage = serviceOf(plan, "garage");
  if (storage?.provider !== "garage" || garage === undefined || requirements === undefined) {
    return [];
  }
  const server = garage.server ?? APP_SERVER;
  const read = readings.servers[server];
  const filling = read === undefined ? undefined : diskFilling(server, read);
  if (filling === undefined) return [];
  // The cheapest that keeps the files off the server.
  const offer = storageOffers(requirements, storage.expected).find((o) => o.provider !== "garage");
  if (offer === undefined) return [];
  const name = STORAGE_NAMES[offer.provider];
  const { storageGb, egressGbPerMonth } = storage.expected;
  const { monthly, currency } = storage.price;
  const before = convertMoney({ amount: monthly, currency }, offer.price.currency).amount;
  const note = offer.price.note === undefined ? "" : `. ${withoutStop(offer.price.note)}`;
  return [
    {
      id: `components.${server}.object-storage`,
      category: "components",
      urgency: filling.urgency,
      server,
      title: `Keep the app's files in ${name} instead of on server ${server}`,
      reasons: [
        ...filling.reasons,
        {
          text: `The app keeps its files in Garage on server ${server}. ${name} keeps them off it, priced for ${storageGb} GB stored and ${egressGbPerMonth} GB sent a month (storage.objectStorage.expected)${note}`,
          basis: PLAN,
        },
      ],
      price: {
        before,
        after: offer.price.amount,
        currency: offer.price.currency,
        source: "static",
        asOf: offer.price.checkedOn,
      },
      apply: {
        kind: "manual",
        text: `Set storage.objectStorage.provider to ${offer.provider} in opscrew/plan.yaml, run \`opscrew design${flags}\` and \`opscrew provision${flags}\`, then copy the files from Garage to the new bucket`,
      },
    },
  ];
}
