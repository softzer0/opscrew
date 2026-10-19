import type { VpsProviderId } from "@opscrew/contracts";
import { listText, plural } from "@opscrew/core";
import { serviceSpec } from "@opscrew/iac-templates";
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
import { appMemoryMb, EDGE_MEMORY_MB, SYSTEM_RESERVE_MB } from "../shared/memory";
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
 * Postgres and Redis), and at least the containers' memory limits plus OpsCrew's edge (128 MB) and
 * the system's reserve (384 MB) (FR-1325), and at least the smallest server of each service.
 */
export function sizeFor(
  facts: ProjectFacts,
  requirements: Requirements,
  components: Components = designComponents({ facts, requirements }).components,
): Sizing {
  const { services } = components;
  const postgres = serviceOf(components, "postgres") !== undefined;
  const redis = serviceOf(components, "valkey") !== undefined;

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
  const limitsMb = appMemoryMb(components);
  const smallestServerMb = Math.max(
    0,
    ...services
      .filter((service) => service.enabled)
      .map((service) => serviceSpec(service.kind).memory.smallestServerMb),
  );
  memoryGb = Math.max(
    memoryGb,
    (limitsMb + EDGE_MEMORY_MB + SYSTEM_RESERVE_MB) / 1024,
    smallestServerMb / 1024,
  );

  return {
    vcpus,
    memoryGb,
    diskGb,
    limitsMb,
    components,
    services: [...services],
    externalServices: [...components.externalServices],
  };
}
