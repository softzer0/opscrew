import type {
  ProjectFacts,
  Region,
  Requirements,
  ServiceKind,
  UserScale,
} from "@opscrew/plan-schema";
import { ServiceKindSchema } from "@opscrew/plan-schema";

/** Hetzner locations per region, in order of preference (first available wins). */
const REGION_LOCATIONS: Record<Region, readonly string[]> = {
  "eu-central": ["nbg1", "fsn1"],
  "eu-north": ["hel1"],
  "us-east": ["ash"],
  "us-west": ["hil"],
  "ap-southeast": ["sin"],
};

/** Display names of the Hetzner locations OpsCrew offers. */
export const LOCATION_NAMES: Readonly<Record<string, string>> = {
  nbg1: "Nuremberg",
  fsn1: "Falkenstein",
  hel1: "Helsinki",
  ash: "Ashburn",
  hil: "Hillsboro",
  sin: "Singapore",
};

/** Hetzner locations for a region, in order of preference. */
export function regionLocations(region: Region): string[] {
  return [...REGION_LOCATIONS[region]];
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
  services: { postgres: boolean; redis: boolean };
  /** Services the app keeps using outside the server (sorted in schema order). */
  externalServices: ServiceKind[];
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

  return { vcpus, memoryGb, diskGb, services: { postgres, redis }, externalServices };
}
