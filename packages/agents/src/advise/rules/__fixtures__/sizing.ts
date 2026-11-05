/**
 * What the size and cost rules' tests need beyond `rule-readings.ts`: containers with a memory
 * limit, a reading with exact figures (for the thresholds' edges), price lists from the providers'
 * catalogue fakes (the dated static tables, or the same offers as live), and plans with another
 * type, a worker or an extra server.
 */
import { StaticDigitalOceanCatalog } from "@opscrew/connector-digitalocean";
import { StaticHetznerCatalog } from "@opscrew/connector-hetzner";
import type { ComputeCatalog, ComputeOffer, ProviderExtras } from "@opscrew/contracts";
import type { DeployPlan } from "@opscrew/plan-schema";
import type { ContainerReading, ResourceReading } from "../../../status";
import type { PriceList, ServerHistory, ServerReadings } from "../../types";
import { AT, GB, MB } from "./rule-readings";

/** When a live catalogue was read. */
const LIVE_AS_OF = "2026-11-05T09:59:00.000Z";

/** A container using `usedMb` of memory, and its limit when it has one. */
export function containerAt(service: string, usedMb: number, limitMb?: number): ContainerReading {
  return {
    service,
    cpuPercent: 1.5,
    memory: {
      usedBytes: usedMb * MB,
      ...(limitMb === undefined ? {} : { limitBytes: limitMb * MB }),
    },
    restarts: 0,
    startedAt: "2026-11-04T10:00:00.000Z",
  };
}

/** What {@link serverReading} reads: memory as `[usedMb, totalMb]`, the disk as `[usedGb, totalGb]`. */
export interface ReadingInit {
  cpus?: number;
  load15?: number;
  memory?: [number, number];
  disk?: [number, number];
  containers?: ContainerReading[];
}

/** One reading of a server with exact figures (defaults: 2 CPUs, quiet, half its memory). */
export function serverReading(init: ReadingInit = {}): ResourceReading {
  const { cpus = 2, load15 = 0.4, memory = [2000, 4000], disk = [10, 40] } = init;
  const [usedDisk, totalDisk] = disk;
  return {
    takenAt: AT,
    server: {
      cpus,
      load1: load15,
      load5: load15,
      load15,
      memory: { usedBytes: memory[0] * MB, totalBytes: memory[1] * MB },
      disk: {
        usedBytes: usedDisk * GB,
        freeBytes: (totalDisk - usedDisk) * GB,
        totalBytes: totalDisk * GB,
      },
    },
    containers: init.containers ?? [],
    unavailable: [],
    flags: [],
  };
}

/** One server's readings. */
export function server(now: ResourceReading, past?: ServerHistory): ServerReadings {
  return past === undefined ? { now } : { now, history: past };
}

/** `catalog`'s offers and extras in `location`, or the same marked live. */
async function pricesOf(
  catalog: ComputeCatalog,
  location: string,
  source: "static" | "live",
): Promise<PriceList> {
  const offers = await catalog.listOffers(location);
  const extras = await catalog.extras(location);
  if (source === "static") return { provider: catalog.provider, location, offers, extras };
  const live = { source: "live", asOf: LIVE_AS_OF } as const;
  return {
    provider: catalog.provider,
    location,
    offers: offers.map((offer): ComputeOffer => ({ ...offer, ...live })),
    extras: { ...extras, ...live } satisfies ProviderExtras,
  };
}

/** Hetzner's prices in `location` from its dated static table (or the same offers as live). */
export function hetznerTable(location = "nbg1", source: "static" | "live" = "static") {
  return pricesOf(new StaticHetznerCatalog(), location, source);
}

/** DigitalOcean's prices in `location` from its dated static table. */
export function digitaloceanTable(location = "fra1") {
  return pricesOf(new StaticDigitalOceanCatalog(), location, "static");
}

/** `plan` with its app's Hetzner or DigitalOcean server of the type `serverType`. */
export function withServerType(plan: DeployPlan, serverType: string): DeployPlan {
  const { target } = plan;
  if (target.provider !== "hetzner" && target.provider !== "digitalocean") {
    throw new Error("Not a cloud server's plan.");
  }
  return { ...plan, target: { ...target, serverType } };
}

/** `plan` deployed to this computer (the localhost target) instead. */
export function onThisComputer(plan: DeployPlan): DeployPlan {
  return {
    ...plan,
    target: {
      provider: "localhost",
      mode: "local-compose",
      arch: "amd64",
      ports: { https: 443, http: 80 },
      image: "registry",
      edge: "caddy",
    },
  };
}

/** `plan` with a worker `name` of `memoryMb` and `count` copies. */
export function withWorker(plan: DeployPlan, name: string, memoryMb: number, count = 1) {
  return {
    ...plan,
    processes: {
      ...plan.processes,
      workers: [
        {
          name,
          command: "node worker.js",
          source: "user",
          count,
          single: false,
          stopGraceSeconds: 30,
          memoryMb,
          enabled: true,
        },
      ],
    },
  } satisfies DeployPlan;
}

/** `plan` with its Postgres (`db`) on the extra Hetzner server `data` (`serverType` in nbg1). */
export function withDataServer(plan: DeployPlan, serverType = "cx23"): DeployPlan {
  return {
    ...plan,
    servers: [
      {
        name: "data",
        target: {
          provider: "hetzner",
          mode: "vps-compose",
          location: "nbg1",
          serverType,
          backups: true,
        },
      },
    ],
    services: plan.services.map((service) =>
      service.name === "db" ? { ...service, server: "data" } : service,
    ),
  };
}
