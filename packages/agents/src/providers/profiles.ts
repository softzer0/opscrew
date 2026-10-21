import type { VpsProviderId } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { wrongTarget } from "@opscrew/iac-templates";
import type {
  CloudProvider,
  DeployPlan,
  DeployProvider,
  Region,
  Requirements,
} from "@opscrew/plan-schema";

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
  /**
   * True when OpsCrew can turn on the provider's automated backups and snapshots. False for a
   * server the user owns: its backups are the user's responsibility.
   */
  providerBackups: boolean;
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
  providerBackups: true,
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
  providerBackups: true,
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

const NO_REGIONS: Readonly<Record<Region, readonly string[]>> = {
  "eu-central": [],
  "eu-north": [],
  "us-east": [],
  "us-west": [],
  "ap-southeast": [],
};

/** Matches no text: a server the user owns has no provider errors to recognise. */
const NEVER = /(?!)/;

/**
 * A server the user already owns. OpsCrew neither creates nor deletes it, so it has no API token,
 * console, account page, regions, prices, delete protection or provider backups, and no server or
 * cloud firewall resource in the infrastructure code. Those fields are empty (or never match)
 * here; phases check `id === "own"` instead of relying on them.
 */
const OWN: ProviderProfile = {
  id: "own",
  displayName: "Your own server",
  serverNoun: "server",
  tokenVars: [],
  tokenUrl: "",
  consoleUrl: "",
  accountUrl: "",
  serverResourceType: "",
  firewallResourceType: "",
  deleteProtection: false,
  defaultImage: "",
  currency: "EUR",
  backupPercent: 0,
  backupsOutliveServer: false,
  providerBackups: false,
  regionLocations: NO_REGIONS,
  locationNames: {},
  regionNotes: {},
  unavailable: NEVER,
  serverLimit: NEVER,
  mirroredAttributes: {},
};

/** The environment variable holding the Portainer access token (never stored by OpsCrew). */
export const PORTAINER_TOKEN_VAR = "PORTAINER_API_KEY";

/**
 * What the phases need to know about a Portainer the user already runs (`portainer`). OpsCrew
 * creates no server there: there is no catalogue to choose from, no price, no provider backups,
 * and OpsCrew never changes the host; it deploys the app as stacks through Portainer's API.
 */
export interface PortainerProfile {
  id: "portainer";
  /** `My existing Portainer`. */
  displayName: string;
  /** Environment variables holding the Portainer access token: only `PORTAINER_API_KEY`. */
  tokenVars: readonly string[];
}

const PORTAINER: PortainerProfile = {
  id: "portainer",
  displayName: "My existing Portainer",
  tokenVars: [PORTAINER_TOKEN_VAR],
};

const PROFILES: Readonly<Record<VpsProviderId, ProviderProfile>> = {
  hetzner: HETZNER,
  digitalocean: DIGITALOCEAN,
  own: OWN,
};

/**
 * Every cloud provider OpsCrew creates servers on (with an API token), Hetzner first. A server the
 * user already owns (`own`) is not one of them.
 */
export const VPS_PROVIDERS: readonly CloudProvider[] = ["hetzner", "digitalocean"];

/**
 * The provider's profile, including `own` ("Your own server") and `portainer` ("My existing
 * Portainer", see {@link PortainerProfile}).
 */
export function providerProfile(id: "portainer"): PortainerProfile;
export function providerProfile(id: VpsProviderId): ProviderProfile;
export function providerProfile(
  id: VpsProviderId | "portainer",
): ProviderProfile | PortainerProfile {
  if (id === "portainer") return PORTAINER;
  const profile = PROFILES[id];
  if (profile === undefined) {
    throw new OpsCrewError("INVALID_INPUT", `OpsCrew does not know the server provider "${id}".`, {
      hint: "Use hetzner, digitalocean, own or portainer as the provider in opscrew/requirements.yaml and opscrew/plan.yaml.",
    });
  }
  return profile;
}

/**
 * `provider` when the app runs on one server; a Portainer or localhost target here is a bug in
 * OpsCrew.
 */
function serverProvider(provider: DeployProvider): VpsProviderId {
  if (provider === "portainer" || provider === "localhost") {
    throw wrongTarget(
      `This step only applies to an app on one server (Hetzner Cloud, DigitalOcean or a server you own), not to ${provider === "portainer" ? "an app in your existing Portainer" : "an app on this computer (the localhost target)"}.`,
    );
  }
  return provider;
}

/** The provider of a plan whose app runs on one server. */
export function planProvider(plan: Pick<DeployPlan, "target">): VpsProviderId {
  return serverProvider(plan.target.provider);
}

/** The provider the user asked for, when the app runs on one server. */
export function requestedProvider(requirements: Pick<Requirements, "provider">): VpsProviderId {
  return serverProvider(requirements.provider);
}

/**
 * The region the user asked for, which picks a cloud provider's location. A server the user owns
 * stays where it is: `undefined` for it (a region in its requirements is ignored). Throws
 * `ARTIFACT_INVALID` when a cloud provider's requirements have none (the schema requires one there).
 */
export function requestedRegion(
  requirements: Pick<Requirements, "provider" | "region">,
): Region | undefined {
  const provider = requestedProvider(requirements);
  if (provider === "own") return undefined;
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
