import type { VpsProviderId } from "@opscrew/contracts";
import { listText } from "@opscrew/core";
import type {
  PlanService,
  ProjectFacts,
  Region,
  Requirements,
  ServiceKind,
  UserScale,
} from "@opscrew/plan-schema";
import { ServiceKindSchema, serviceOf } from "@opscrew/plan-schema";
import { providerProfile } from "../providers";

/**
 * A provider's locations for a region, in order of preference (Hetzner by default); none for a
 * server the user owns.
 */
export function regionLocations(region: Region, provider: VpsProviderId = "hetzner"): string[] {
  return [...providerProfile(provider).regionLocations[region]];
}

/** What the server must provide and which services run on it. */
export interface Sizing {
  /** Minimum vCPUs. */
  vcpus: number;
  /** Minimum memory in GB. */
  memoryGb: number;
  /** Minimum disk in GB. */
  diskGb: number;
  /** Containers that run next to the app on the server. */
  services: PlanService[];
  /** Services the app keeps using outside the server (sorted in schema order). */
  externalServices: ServiceKind[];
}

/** What runs on the server, in a sentence: `the app`, `the app, Postgres and Redis`. */
export function containersText(sizing: Pick<Sizing, "services">): string {
  return listText([
    "the app",
    ...(serviceOf(sizing, "postgres") ? ["Postgres"] : []),
    ...(serviceOf(sizing, "valkey") ? ["Redis"] : []),
  ]);
}

/**
 * The plan's entries for the services design runs: Postgres (`db`) and, for an app on Redis, Valkey
 * as a cache (`cache`), at the pinned major versions with conservative memory limits.
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

/** Service kinds that are hosted somewhere else when not run as a container. */
const EXTERNAL_KINDS: ReadonlySet<ServiceKind> = new Set([
  "postgres",
  "mysql",
  "mongodb",
  "redis",
  "supabase",
  "firebase",
  "s3",
  "stripe",
  "email",
]);

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
 * Minimum server size and service layout for the app (plan.md sizing table). Postgres is
 * self-hosted when the app uses it and the user did not keep `supabase` or `postgres` as an
 * external provider; Redis likewise unless `redis` is kept.
 */
export function sizeFor(facts: ProjectFacts, requirements: Requirements): Sizing {
  const used = new Set(facts.services.map((service) => service.kind));
  const keep = new Set(requirements.keepExternalServices);
  const postgres = used.has("postgres") && !keep.has("postgres") && !keep.has("supabase");
  const redis = used.has("redis") && !keep.has("redis");

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

  const external = new Set<ServiceKind>();
  for (const kind of [...used, ...keep]) if (EXTERNAL_KINDS.has(kind)) external.add(kind);
  if (postgres) {
    external.delete("postgres");
    external.delete("supabase");
  }
  if (redis) external.delete("redis");
  const externalServices = ServiceKindSchema.options.filter((kind) => external.has(kind));

  return {
    vcpus,
    memoryGb,
    diskGb,
    services: selfHostedServices({ postgres, redis }),
    externalServices,
  };
}
