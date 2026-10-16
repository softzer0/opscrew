import type { ComputeLocation } from "@opscrew/contracts";

/**
 * Dated static fallback for DigitalOcean Droplet prices.
 *
 * Source: https://www.digitalocean.com/pricing/droplets (Basic, regular SSD), read 2026-10-12.
 * USD per month, excluding tax. Live API prices always win when a token works.
 */
export const STATIC_PRICES_AS_OF = "2026-10-12T00:00:00.000Z";

/**
 * Automated daily backups cost this percentage of the Droplet price (weekly would be 20). The API
 * does not return it, so even live estimates use this published rate and name its date.
 */
export const BACKUP_PERCENT = 30;
/**
 * Outbound transfer beyond the pooled allowance: USD 0.01 per GiB, so 10.24 per TiB. Published
 * rate (not in the API), like {@link BACKUP_PERCENT}.
 */
export const TRAFFIC_PER_TB_USD = 10.24;

/** Display names and countries of known Droplet regions; other regions are named by slug. */
export const REGION_NAMES: Readonly<Record<string, { city: string; country: string }>> = {
  fra1: { city: "Frankfurt", country: "DE" },
  ams3: { city: "Amsterdam", country: "NL" },
  lon1: { city: "London", country: "GB" },
  nyc1: { city: "New York", country: "US" },
  nyc2: { city: "New York", country: "US" },
  nyc3: { city: "New York", country: "US" },
  sfo2: { city: "San Francisco", country: "US" },
  sfo3: { city: "San Francisco", country: "US" },
  tor1: { city: "Toronto", country: "CA" },
  sgp1: { city: "Singapore", country: "SG" },
  blr1: { city: "Bangalore", country: "IN" },
  syd1: { city: "Sydney", country: "AU" },
  atl1: { city: "Atlanta", country: "US" },
};

/**
 * A location for a region slug. Unknown regions keep the slug (or the API's name) as their name
 * and an empty country, because OpsCrew does not know where they are.
 */
export function regionLocation(slug: string, apiName?: string | null): ComputeLocation {
  const known = REGION_NAMES[slug];
  if (known === undefined) return { id: slug, name: apiName || slug, country: "" };
  return { id: slug, name: known.city, country: known.country };
}

/** Droplet regions on 2026-10-12 (https://docs.digitalocean.com/platform/regional-availability/). */
export const STATIC_REGIONS: readonly string[] = [
  "nyc1",
  "nyc2",
  "nyc3",
  "sfo2",
  "sfo3",
  "ams3",
  "sgp1",
  "lon1",
  "fra1",
  "tor1",
  "blr1",
  "syd1",
  "atl1",
  "ric1",
  "mkc1",
  "mem1",
];

export interface StaticSize {
  slug: string;
  vcpus: number;
  memoryGb: number;
  diskGb: number;
  /** USD per month, excluding tax. */
  monthly: number;
}

/**
 * Basic (shared CPU) sizes, exactly as in research.md "Pricing". The $4 512 MiB size is too small
 * for Docker plus Postgres and is not offered; CPU-Optimized sizes come from the live API only.
 */
export const STATIC_SIZES: readonly StaticSize[] = [
  { slug: "s-1vcpu-1gb", vcpus: 1, memoryGb: 1, diskGb: 25, monthly: 6 },
  { slug: "s-1vcpu-2gb", vcpus: 1, memoryGb: 2, diskGb: 50, monthly: 12 },
  { slug: "s-2vcpu-2gb", vcpus: 2, memoryGb: 2, diskGb: 60, monthly: 18 },
  { slug: "s-2vcpu-4gb", vcpus: 2, memoryGb: 4, diskGb: 80, monthly: 24 },
  { slug: "s-4vcpu-8gb", vcpus: 4, memoryGb: 8, diskGb: 160, monthly: 48 },
];
