import type { VpsProviderId } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import type { CloudProvider, DeployPlan, Region, Requirements } from "@opscrew/plan-schema";
import { ownServerNotYet } from "./own";

/** What the phases need to know about a VPS provider, so none of them imports its connector. */
export interface ProviderProfile {
  id: VpsProviderId;
  /** For example `Hetzner Cloud`. */
  displayName: string;
  /** What the provider calls the server: `server` or `Droplet`. */
  serverNoun: string;
  /** Environment variables holding the API token, checked in order. */
  tokenVars: readonly string[];
  /** Where the user creates the token. */
  tokenUrl: string;
  /** The provider's web console. */
  consoleUrl: string;
  /** Where the user fixes account problems: a locked account, an unverified email, limits. */
  accountUrl: string;
  /** Terraform resource type of the server, for example `hcloud_server`. */
  serverResourceType: string;
  /** Terraform resource type of the cloud firewall. */
  firewallResourceType: string;
  /** True when the server can be protected against deletion (lifted before a teardown). */
  deleteProtection: boolean;
  /** Ubuntu 24.04 image name. */
  defaultImage: string;
  /** Currency of the provider's prices. */
  currency: "EUR" | "USD";
  /** Daily automated backups as a percentage of the server price. */
  backupPercent: number;
  /** True when automated backups survive the server's deletion for a while. */
  backupsOutliveServer: boolean;
  /** Locations per region, in order of preference (first available wins). */
  regionLocations: Readonly<Record<Region, readonly string[]>>;
  /** Display names of the locations OpsCrew offers. */
  locationNames: Readonly<Record<string, string>>;
  /** Why a region maps to a location outside it. */
  regionNotes: Readonly<Partial<Record<Region, string>>>;
  /** Provider error text meaning the size is unavailable or out of stock in the location. */
  unavailable: RegExp;
  /** Provider error text meaning the account reached its server limit. */
  serverLimit: RegExp;
  /**
   * Attributes the provider fills in from a relationship OpsCrew manages on the other resource
   * (Hetzner mirrors the server's `firewall_ids` into the firewall's `apply_to`). They change on
   * refresh without anyone touching the console, so `opscrew drift` does not report them; a real
   * change still shows on the resource OpsCrew manages the relationship on. Read-only values the
   * cloud maintains itself (status, counts, timestamps) need no entry: drift takes them from the
   * provider schema.
   */
  mirroredAttributes: Readonly<Record<string, readonly string[]>>;
}

const HETZNER: ProviderProfile = {
  id: "hetzner",
  displayName: "Hetzner Cloud",
  serverNoun: "server",
  tokenVars: ["HCLOUD_TOKEN"],
  tokenUrl: "https://console.hetzner.cloud/",
  consoleUrl: "https://console.hetzner.cloud/",
  accountUrl: "https://console.hetzner.cloud/",
  serverResourceType: "hcloud_server",
  firewallResourceType: "hcloud_firewall",
  deleteProtection: true,
  defaultImage: "ubuntu-24.04",
  currency: "EUR",
  backupPercent: 20,
  backupsOutliveServer: false,
  regionLocations: {
    "eu-central": ["nbg1", "fsn1"],
    "eu-north": ["hel1"],
    "us-east": ["ash"],
    "us-west": ["hil"],
    "ap-southeast": ["sin"],
  },
  locationNames: {
    nbg1: "Nuremberg",
    fsn1: "Falkenstein",
    hel1: "Helsinki",
    ash: "Ashburn",
    hil: "Hillsboro",
    sin: "Singapore",
  },
  regionNotes: {},
  unavailable:
    /resource_unavailable|out of stock|unsupported location|error during placement|(?<!service )unavailable/i,
  serverLimit: /resource_limit_exceeded|server limit/i,
  mirroredAttributes: { hcloud_firewall: ["apply_to"] },
};

const DIGITALOCEAN: ProviderProfile = {
  id: "digitalocean",
  displayName: "DigitalOcean",
  serverNoun: "Droplet",
  tokenVars: ["DIGITALOCEAN_TOKEN", "DIGITALOCEAN_ACCESS_TOKEN"],
  tokenUrl: "https://cloud.digitalocean.com/account/api/tokens",
  consoleUrl: "https://cloud.digitalocean.com/",
  accountUrl: "https://cloud.digitalocean.com/account",
  serverResourceType: "digitalocean_droplet",
  firewallResourceType: "digitalocean_firewall",
  deleteProtection: false,
  defaultImage: "ubuntu-24-04-x64",
  currency: "USD",
  backupPercent: 30,
  backupsOutliveServer: true,
  regionLocations: {
    "eu-central": ["fra1", "ams3"],
    "eu-north": ["ams3"],
    "us-east": ["nyc3", "nyc1", "atl1"],
    "us-west": ["sfo3"],
    "ap-southeast": ["sgp1"],
  },
  locationNames: {
    fra1: "Frankfurt",
    ams3: "Amsterdam",
    lon1: "London",
    nyc1: "New York",
    nyc3: "New York",
    atl1: "Atlanta",
    sfo3: "San Francisco",
    tor1: "Toronto",
    sgp1: "Singapore",
    blr1: "Bangalore",
    syd1: "Sydney",
  },
  regionNotes: {
    "eu-north":
      "DigitalOcean has no data centre in northern Europe, so OpsCrew uses Amsterdam, the closest one.",
  },
  unavailable:
    /(size|image|region) is not available|not available in (this|the selected) region|(?<!service (temporarily )?)unavailable|out of stock/i,
  serverLimit: /droplet limit|droplet quota|exceed(s|ed)? (your|the) droplet/i,
  mirroredAttributes: {},
};

const PROFILES: Readonly<Record<CloudProvider, ProviderProfile>> = {
  hetzner: HETZNER,
  digitalocean: DIGITALOCEAN,
};

/** Every VPS provider OpsCrew supports, Hetzner first. */
export const VPS_PROVIDERS: readonly VpsProviderId[] = ["hetzner", "digitalocean"];

/** The provider's profile; throws {@link ownServerNotYet} for a server the user owns. */
export function providerProfile(id: VpsProviderId): ProviderProfile {
  if (id === "own") throw ownServerNotYet();
  return PROFILES[id];
}

/** The provider of a plan. */
export function planProvider(plan: Pick<DeployPlan, "target">): VpsProviderId {
  return plan.target.provider;
}

/** The provider the user asked for; requirements written before feature 004 mean Hetzner. */
export function requestedProvider(
  requirements: Pick<Requirements, "provider"> | undefined,
): VpsProviderId {
  return requirements?.provider ?? "hetzner";
}

/**
 * The region the user asked for, which picks a cloud provider's location. A server the user owns
 * has no region: throws {@link ownServerNotYet} for it. Throws `ARTIFACT_INVALID` when a cloud
 * provider's requirements have none (the schema requires one there).
 */
export function requestedRegion(requirements: Pick<Requirements, "provider" | "region">): Region {
  const provider = requestedProvider(requirements);
  if (provider === "own") throw ownServerNotYet();
  if (requirements.region === undefined) {
    throw new OpsCrewError(
      "ARTIFACT_INVALID",
      `opscrew/requirements.yaml names no region, which ${providerProfile(provider).displayName} needs to pick a location.`,
      { hint: "Run `opscrew interview` again and answer where most of your users are." },
    );
  }
  return requirements.region;
}

/** The provider whose token is set, when exactly one provider has a token. */
export function providerFromTokens(
  env: Readonly<Record<string, string | undefined>>,
): VpsProviderId | undefined {
  const withToken = VPS_PROVIDERS.filter((id) =>
    providerProfile(id).tokenVars.some((name) => (env[name] ?? "").trim() !== ""),
  );
  return withToken.length === 1 ? withToken[0] : undefined;
}
