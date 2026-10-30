import type { VpsProviderId } from "@opscrew/contracts";
import { listText, plural } from "@opscrew/core";
import {
  CONNECTOR_MEMORY_MB,
  DRAGONFLY_MIN_VCPUS,
  type EdgeProxy,
  edgeMemoryMb,
  serviceSpec,
} from "@opscrew/iac-templates";
import type {
  PlanService,
  ProjectFacts,
  Region,
  Requirements,
  ServiceKind,
  UserScale,
} from "@opscrew/plan-schema";
import { serviceOf } from "@opscrew/plan-schema";
import { providerProfile } from "../providers";
import { appMemoryMb, memoryHeadroom, SYSTEM_RESERVE_MB } from "../shared/memory";
import { type Components, designComponents } from "./components";

/**
 * A provider's locations for a region, in order of preference (Hetzner by default); none for a
 * server the user owns.
 */
export function regionLocations(region: Region, provider: VpsProviderId = "hetzner"): string[] {
  return [...providerProfile(provider).regionLocations[region]];
}

/** What the server must provide and which components run on it. */
export interface Sizing {
  /** Minimum vCPUs. */
  vcpus: number;
  /** Minimum memory in GB. */
  memoryGb: number;
  /** Minimum disk in GB. */
  diskGb: number;
  /** The containers' memory limits added up (web, workers, cron, services), in MB. */
  limitsMb: number;
  /** The server's proxy (`target.edge`). */
  edge: EdgeProxy;
  /** The memory of the server's edge, in MB (`edgeMemoryMb`). */
  edgeMb: number;
  /** What runs next to the app. */
  components: Components;
  /** Containers that run next to the app on the server. */
  services: PlanService[];
  /** Services the app keeps using outside the server (sorted in schema order). */
  externalServices: ServiceKind[];
}

/**
 * What runs on the server, in a sentence: `the app`, `the app, a worker, cron jobs, Postgres and
 * Redis`.
 */
export function containersText(sizing: Pick<Sizing, "components">): string {
  const { processes, services } = sizing.components;
  const workers = processes.workers.filter((worker) => worker.enabled).length;
  const names = new Set(
    services
      .filter((service) => service.enabled)
      .map((service) =>
        service.kind === "postgres"
          ? "Postgres"
          : service.kind === "valkey"
            ? "Redis"
            : serviceSpec(service.kind).title,
      ),
  );
  return listText([
    "the app",
    ...(workers === 0 ? [] : [workers === 1 ? "a worker" : plural(workers, "worker")]),
    ...(processes.cron.some((job) => job.enabled) ? ["its cron jobs"] : []),
    ...names,
  ]);
}

/**
 * The plan's entries for Postgres (`db`) and, for an app on Redis, Valkey as a cache (`cache`), at
 * the catalog's versions and memory limits.
 */
export function selfHostedServices(run: { postgres: boolean; redis: boolean }): PlanService[] {
  return [
    ...(run.postgres
      ? [
          {
            name: "db",
            kind: "postgres",
            version: "17",
            memoryMb: 512,
            enabled: true,
            options: {},
            reason: "The app uses PostgreSQL.",
            licence: "PostgreSQL",
          } as const,
        ]
      : []),
    ...(run.redis
      ? [
          {
            name: "cache",
            kind: "valkey",
            version: "8",
            memoryMb: 128,
            enabled: true,
            options: { mode: "cache" },
            reason: "The app uses Redis; Valkey is its open-source fork.",
            licence: "BSD-3-Clause",
          } as const,
        ]
      : []),
  ];
}

/** Base (vCPU, GB RAM) for the app by expected monthly users. */
const APP_SIZE: Record<UserScale, readonly [number, number]> = {
  "<1k": [1, 2],
  "1k-10k": [2, 4],
  "10k-100k": [4, 8],
  ">100k": [8, 16],
};

/** Extra (vCPU, GB RAM) for a self-hosted Postgres container. */
const POSTGRES_SIZE: Record<UserScale, readonly [number, number]> = {
  "<1k": [1, 2],
  "1k-10k": [2, 4],
  "10k-100k": [2, 8],
  ">100k": [2, 8],
};

const MIN_DISK_GB = 40;
const POSTGRES_DISK_GB = 20;
const REDIS_MEMORY_GB = 0.5;

/**
 * Free disk a server the user already owns needs for the app, without the operating system (which
 * is already installed there, unlike `MIN_DISK_GB` on a new cloud server): the app's images, its
 * updates and logs, plus the database's data with Postgres.
 */
const OWN_SERVER_APP_FREE_DISK_GB = 10;
const OWN_SERVER_POSTGRES_FREE_DISK_GB = 20;

/**
 * Inspected memory may sit a little below the nominal size (the kernel and firmware reserve some:
 * a "1 GB" server reports about 0.95 GB), so an own server is only called too small below this
 * share of the need.
 */
export const OWN_SERVER_MEMORY_TOLERANCE = 0.9;

/** Another OpsCrew app set up on a server the user owns, from its record and inspection. */
export interface ServerApp {
  name: string;
  /** The sum of its containers' memory limits (its record). */
  memoryMb: number;
  /** It runs a Cloudflare Tunnel connector of its own. */
  tunnel: boolean;
}

/** An app's memory on the server: its limits, and its tunnel connector's. */
function serverAppMb(app: ServerApp): number {
  return app.memoryMb + (app.tunnel ? CONNECTOR_MEMORY_MB : 0);
}

/**
 * Whether a server the user owns, with `serverMb` of inspected memory, holds this app's containers
 * (`appMb` of memory limits) next to the other OpsCrew apps' recorded limits (and their tunnel
 * connectors: the edge's figure includes one), OpsCrew's edge (`edgeMb`) and the system's reserve
 * (FR-1325, the same figures as on cloud servers): `refused` when they do not fit, a `warning` when less
 * than 15% stays free, each saying how much the other apps take; `undefined` when it fits, or
 * when inspection could not read the memory (the own-server option then records a placeholder
 * under 100 MB, and design warns about the server's size already). For an extra server `name`
 * (feature 018), `appMb` is this app's services there, and an `edgeMb` of 0 runs no edge.
 */
export function ownServerMemory(
  serverMb: number,
  appMb: number,
  others: readonly ServerApp[],
  edgeMb: number,
  name?: string,
): { refused?: { message: string; hint: string }; warning?: string } | undefined {
  if (serverMb < 100) return undefined;
  const othersMb = others.reduce((sum, app) => sum + serverAppMb(app), 0);
  const headroom = memoryHeadroom(serverMb, appMb + othersMb, edgeMb);
  if (!headroom.low) return undefined;
  const each = listText(
    others.map(
      (app) =>
        `"${app.name}" ${app.memoryMb} MB${app.tunnel ? ` and ${CONNECTOR_MEMORY_MB} MB for its tunnel connector` : ""}`,
    ),
  );
  const server = Math.round(serverMb);
  const noun = name === undefined ? "Your server" : `Server ${name}`;
  const edge = edgeMb > 0 ? ` and ${edgeMb} MB for OpsCrew's edge` : "";
  if (!headroom.fits) {
    const left = server - SYSTEM_RESERVE_MB - edgeMb;
    const taken =
      others.length === 0
        ? `${Math.max(0, left)} MB are left`
        : `the other OpsCrew ${others.length === 1 ? "app on it takes" : "apps on it take"} ${othersMb} MB of memory limits (${each}), which leaves ${Math.max(0, left - othersMb)} MB`;
    return {
      refused: {
        message: `${noun} has ${server} MB of memory. After ${SYSTEM_RESERVE_MB} MB for the system${edge}, ${taken}, and this app's ${name === undefined ? "containers" : "services there"} have ${appMb} MB of memory limits. ${name === undefined ? "Nothing was written." : "plan.yaml was not changed."}`,
        hint:
          name === undefined
            ? "Lower the memory limits in opscrew/plan.yaml (app.memoryMb, and those of the workers and services), add memory to the server, or remove an app from it, then run `opscrew design` again."
            : `Lower the memory limits of the services on server ${name} in opscrew/plan.yaml, add memory to the server, or place fewer services on it, then run \`opscrew design\` again.`,
      },
    };
  }
  const theirs =
    others.length === 0
      ? ""
      : ` and of the other OpsCrew ${others.length === 1 ? "app" : "apps"} on it (${othersMb} MB: ${each})`;
  return {
    warning: `${noun} keeps only ${Math.max(0, Math.round(headroom.free * 100))}% of its memory free after the memory limits of this app (${appMb} MB)${theirs}${edgeMb > 0 ? ", OpsCrew's edge and" : " and"} the system, so a container that grows can make the server run out of memory. Lower a memory limit in opscrew/plan.yaml, or add memory to the server.`,
  };
}

/**
 * A warning for each enabled service whose smallest comfortable server (the catalog's
 * `smallestServerMb`) is bigger than a server the user owns with `serverMb` of inspected memory,
 * by the same tolerance as the server's own size check. A server OpsCrew creates is always sized
 * to fit them.
 */
export function smallServerWarnings(services: readonly PlanService[], serverMb: number): string[] {
  const gb = (mb: number) => `${Math.round((mb / 1024) * 10) / 10}`;
  return services
    .filter((service) => service.enabled)
    .flatMap((service) => {
      const spec = serviceSpec(service.kind);
      const needs = spec.memory.smallestServerMb;
      if (serverMb >= needs * OWN_SERVER_MEMORY_TOLERANCE) return [];
      return [
        `${spec.title} (${service.name}) runs comfortably only on a server with at least ${gb(needs)} GB of memory, and yours has ${gb(serverMb)} GB, so it may slow down or stop when memory runs out. Add memory to the server, or turn the service off in opscrew/plan.yaml (enabled: false) and give the app a hosted ${spec.title}'s address instead.`,
      ];
    });
}

/** Free disk (GB) the app needs on a server the user already owns. */
export function ownServerFreeDiskGb(sizing: Pick<Sizing, "services">): number {
  return (
    OWN_SERVER_APP_FREE_DISK_GB +
    (serviceOf(sizing, "postgres") ? OWN_SERVER_POSTGRES_FREE_DISK_GB : 0)
  );
}

/**
 * Minimum server size for the app and what runs next to it (`components`, by default designed
 * from the facts and requirements alone): the plan.md sizing table by expected users (more with
 * Postgres and Redis), and at least the containers' memory limits plus OpsCrew's edge (`edge`'s
 * `edgeMemoryMb`) and the system's reserve (384 MB) (FR-1325), and at least the smallest
 * server of each service; with Dragonfly, at least 2 vCPUs.
 */
export function sizeFor(
  facts: ProjectFacts,
  requirements: Requirements,
  components: Components = designComponents({ facts, requirements }).components,
  edge: EdgeProxy = "caddy",
): Sizing {
  const { services } = components;
  const postgres = serviceOf(components, "postgres") !== undefined;
  const dragonfly = serviceOf(components, "dragonfly") !== undefined;
  const redis =
    dragonfly ||
    serviceOf(components, "valkey") !== undefined ||
    serviceOf(components, "redis") !== undefined;

  const users = requirements.expectedMonthlyUsers;
  let [vcpus, memoryGb] = APP_SIZE[users];
  if (facts.appKind === "static-spa") memoryGb = Math.max(1, memoryGb / 2);
  let diskGb = MIN_DISK_GB;
  if (postgres) {
    const [pgCpu, pgMemory] = POSTGRES_SIZE[users];
    vcpus += pgCpu;
    memoryGb += pgMemory;
    diskGb += POSTGRES_DISK_GB;
  }
  if (redis) memoryGb += REDIS_MEMORY_GB;
  // Dragonfly is offered on 2 vCPUs or more (FR-1321a).
  if (dragonfly) vcpus = Math.max(vcpus, DRAGONFLY_MIN_VCPUS);
  const limitsMb = appMemoryMb(components);
  const edgeMb = edgeMemoryMb(edge);
  const smallestServerMb = Math.max(
    0,
    ...services
      .filter((service) => service.enabled)
      .map((service) => serviceSpec(service.kind).memory.smallestServerMb),
  );
  memoryGb = Math.max(
    memoryGb,
    (limitsMb + edgeMb + SYSTEM_RESERVE_MB) / 1024,
    smallestServerMb / 1024,
  );

  return {
    vcpus,
    memoryGb,
    diskGb,
    limitsMb,
    edge,
    edgeMb,
    components,
    services: [...services],
    externalServices: [...components.externalServices],
  };
}
