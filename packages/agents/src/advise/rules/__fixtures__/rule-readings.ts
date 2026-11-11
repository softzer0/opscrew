/**
 * What advise's rule tests share: readings with exact figures or shares (for the thresholds'
 * edges), price lists (a hand-made one, and the providers' dated static tables or the same offers
 * as live), plans with another type, a worker or an extra server, and the proposals checked
 * against the schema `--json` and MCP use.
 */
import { StaticDigitalOceanCatalog } from "@opscrew/provider-digitalocean";
import { StaticHetznerCatalog } from "@opscrew/provider-hetzner";
import type {
  CheckResult,
  ComputeCatalog,
  ComputeOffer,
  ProviderExtras,
} from "@opscrew/contracts";
import { Redactor } from "@opscrew/core";
import type { DeployPlan } from "@opscrew/plan-schema";
import { expect } from "vitest";
import type { ContainerReading, ResourceReading } from "../../../status";
import { vpsConnector } from "../../../providers";
import { offer } from "../../../testing";
import {
  type PriceList,
  type Proposal,
  ProposalSchema,
  type Readings,
  type ServerHistory,
  type ServerReadings,
} from "../../types";

/** When the test readings were taken. */
export const AT = "2026-11-05T10:00:00.000Z";

export const GB = 1024 ** 3;
export const MB = 1024 ** 2;
const DAY_MS = 86_400_000;

/** When a live catalogue was read. */
const LIVE_AS_OF = "2026-11-05T09:59:00.000Z";

/** `days` after {@link AT}, as ISO 8601 (`ms` more for the edges). */
export function afterAt(days: number, ms = 0): string {
  return new Date(Date.parse(AT) + days * DAY_MS + ms).toISOString();
}

/** A container as `status` reads it: `usedMb` of memory (100), its limit when it has one. */
export function container(
  service: string,
  { usedMb = 100, limitMb, restarts = 0 }: { usedMb?: number; limitMb?: number; restarts?: number } = {},
): ContainerReading {
  return {
    service,
    cpuPercent: 5,
    memory: {
      usedBytes: usedMb * MB,
      ...(limitMb === undefined ? {} : { limitBytes: limitMb * MB }),
    },
    restarts,
    startedAt: "2026-11-04T08:00:00.000Z",
  };
}

/**
 * What {@link reading} reads: the memory as `[usedMb, totalMb]` or a share of 4 GB, the disk as
 * `[usedGb, totalGb]` or a share of 40 GB.
 */
interface ReadingInit {
  cpus?: number;
  load15?: number;
  memory?: number | [number, number];
  disk?: number | [number, number];
  containers?: ContainerReading[];
}

/** One reading of a server (defaults: 2 CPUs, quiet, 40% of 4 GB memory, 30% of a 40 GB disk). */
export function reading(init: ReadingInit = {}): ResourceReading {
  const { cpus = 2, load15 = 0.4, memory = 0.4, disk = 0.3 } = init;
  const [usedMb, totalMb] = typeof memory === "number" ? [memory * 4096, 4096] : memory;
  const [usedGb, totalGb] = typeof disk === "number" ? [disk * 40, 40] : disk;
  return {
    takenAt: AT,
    server: {
      cpus,
      load1: load15,
      load5: load15,
      load15,
      memory: { usedBytes: Math.round(usedMb * MB), totalBytes: totalMb * MB },
      disk: {
        usedBytes: Math.round(usedGb * GB),
        freeBytes: Math.round((totalGb - usedGb) * GB),
        totalBytes: totalGb * GB,
      },
    },
    containers: init.containers ?? [],
    unavailable: [],
    flags: [],
  };
}

/** 14 days of history, quiet unless `o` says. */
export function history(o: Partial<ServerHistory> = {}): ServerHistory {
  return { days: 14, cpuP95: 0.2, memoryP95: 0.4, loadOverCpus: 0, containers: [], ...o };
}

/** One server's readings. */
export function server(now: ResourceReading, past?: ServerHistory): ServerReadings {
  return past === undefined ? { now } : { now, history: past };
}

/** Hetzner's prices in nbg1: cx23 (4 GB) and cx33 (8 GB), IPv4 €0.50, backups 20%, all live. */
export function hetznerPrices(): PriceList {
  return {
    provider: "hetzner",
    location: "nbg1",
    offers: [
      offer({ id: "cx23", vcpus: 2, memoryGb: 4, diskGb: 40, price: 5.49, source: "live", asOf: AT }),
      offer({ id: "cx33", vcpus: 4, memoryGb: 8, diskGb: 80, price: 8.49, source: "live", asOf: AT }),
    ],
    extras: {
      ipv4Monthly: { amount: 0.5, currency: "EUR" },
      backupPercent: 20,
      pricesIncludeVat: false,
      source: "live",
      asOf: AT,
    },
  };
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
    offers: offers.map((o): ComputeOffer => ({ ...o, ...live })),
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

/** Contabo's prices in `location` from its dated static table (it has no price API). */
export function contaboTable(location = "EU") {
  const offline = () => Promise.reject(new Error("The tests read no network."));
  const deps = { env: {}, fetch: offline, redactor: new Redactor(), version: "0.0.0-test" };
  return pricesOf(vpsConnector("contabo", deps).catalog(), location, "static");
}

/** The server's address, which no proposal may show. */
export const SERVER_ADDRESS = "203.0.113.10";

/** A host check result as `secure` gives it, on the test server's address. */
export function hostCheck(
  init: Pick<CheckResult, "id" | "status" | "severity" | "message"> & Partial<CheckResult>,
): CheckResult {
  return { title: init.id, target: SERVER_ADDRESS, ...init };
}

/** Readings of `plan` with nothing to report unless `overrides` say. */
export function readingsOf(plan: DeployPlan, overrides: Partial<Readings> = {}): Readings {
  return {
    at: AT,
    servers: {},
    plan,
    prices: [hetznerPrices()],
    upkeep: { pulls: [], tokens: [], hostChecks: {} },
    notRead: [],
    flags: "",
    ...overrides,
  };
}

/**
 * `rule`, its proposals each checked against the schema `--json` and MCP use, and each reason
 * written one way: no closing full stop, its figure not repeated in its text.
 */
export function validated(rule: (readings: Readings) => Proposal[]) {
  return (readings: Readings): Proposal[] => {
    const proposals = rule(readings);
    for (const proposal of proposals) {
      expect(ProposalSchema.parse(proposal)).toEqual(proposal);
      for (const { text, figure } of proposal.reasons) {
        expect(text).not.toMatch(/\.$/);
        if (figure !== undefined) expect(text).not.toContain(figure);
      }
    }
    return proposals;
  };
}

/** The proposals' ids. */
export function ids(proposals: Proposal[]): string[] {
  return proposals.map((p) => p.id);
}

/** A proposal's reasons, one a line: `text [figure]`. */
export function texts(proposal: Proposal | undefined): string {
  return (proposal?.reasons ?? []).map((r) => `${r.text} [${r.figure ?? ""}]`).join("\n");
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
