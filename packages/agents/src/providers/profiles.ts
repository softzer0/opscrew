import type { Money, VpsProviderId } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { wrongTarget } from "@opscrew/iac-templates";
import {
  type CloudProvider,
  type DeployPlan,
  type DeployProvider,
  onOneServer,
  type Region,
  type Requirements,
  type ServerlessProvider,
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

/**
 * What the phases need to know about this computer as the target (`localhost`): it is no
 * provider OpsCrew calls, so there is no token, no API and no price.
 */
export interface LocalhostProfile {
  id: "localhost";
  /** `This computer`. */
  displayName: string;
  /** None: the app runs in this computer's Docker. */
  tokenVars: readonly string[];
}

const LOCALHOST: LocalhostProfile = {
  id: "localhost",
  displayName: "This computer",
  tokenVars: [],
};

/**
 * What the phases need to know about Cloudflare's hosting (`cloudflare-workers`): no server, so no
 * catalogue or region; the deploy token's variable, and Cloudflare's published Workers plans and
 * limits with their sources and the day they were read (016's spike, result 8).
 */
export interface CloudflareHostingProfile {
  id: "cloudflare-workers";
  /** `Cloudflare (no server)`. */
  displayName: string;
  /**
   * The deploy token's variable: a token of its own holding only Account → Workers Scripts → Edit,
   * which `opscrew provision` stores as a GitHub secret for the deploy workflow (never OpsCrew's
   * own token, which can edit DNS).
   */
  deployTokenVar: string;
  plans: {
    /** The day the plans below were read. */
    asOf: string;
    /** Cloudflare's pricing and limits pages. */
    sources: readonly string[];
    /** Workers Paid: the monthly minimum per account. */
    paidMonthly: Money;
    /** What Workers Paid's minimum includes, and what more costs. */
    paidIncludes: string;
    /** Workers Free: requests a day to the Worker (static files are free and unlimited). */
    freeRequestsPerDay: number;
    /** Workers Free: CPU time per request, in milliseconds. */
    freeCpuMs: number;
    /** Files a version may have on Workers Free and Workers Paid. */
    files: { free: number; paid: number };
    /** The largest file, in MiB. */
    fileMiB: number;
  };
}

const CLOUDFLARE_HOSTING: CloudflareHostingProfile = {
  id: "cloudflare-workers",
  displayName: "Cloudflare (no server)",
  deployTokenVar: "OPSCREW_CLOUDFLARE_DEPLOY_TOKEN",
  plans: {
    asOf: "2026-10-23T00:00:00.000Z",
    sources: [
      "https://developers.cloudflare.com/workers/platform/pricing/",
      "https://developers.cloudflare.com/workers/platform/limits/",
    ],
    paidMonthly: { amount: 5, currency: "USD" },
    paidIncludes:
      "10 million requests (then $0.30 per million) and 30 million CPU-ms (then $0.02 per million) a month",
    freeRequestsPerDay: 100_000,
    freeCpuMs: 10,
    files: { free: 20_000, paid: 100_000 },
    fileMiB: 25,
  },
};

/**
 * What the phases need to know about GitHub Pages (`github-pages`): no server, no price, and
 * GitHub's published limits and terms with their sources and the day they were read.
 */
export interface GithubPagesProfile {
  id: "github-pages";
  /** `GitHub Pages (no server)`. */
  displayName: string;
  limits: {
    /** The day the limits below were read. */
    asOf: string;
    /** GitHub's Pages limits page and its terms for Pages. */
    sources: readonly string[];
    /** The largest site, in GB. */
    siteGb: number;
    /** The soft limit of traffic a month, in GB. */
    trafficGbPerMonth: number;
  };
}

const GITHUB_PAGES: GithubPagesProfile = {
  id: "github-pages",
  displayName: "GitHub Pages (no server)",
  limits: {
    asOf: "2026-10-23T00:00:00.000Z",
    sources: [
      "https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits",
      "https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features#pages",
    ],
    siteGb: 1,
    trafficGbPerMonth: 100,
  },
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
 * The provider's profile, including `own` ("Your own server"), `portainer` ("My existing
 * Portainer", see {@link PortainerProfile}), `localhost` ("This computer", see
 * {@link LocalhostProfile}) and the server-less targets (see {@link CloudflareHostingProfile} and
 * {@link GithubPagesProfile}), which are not in {@link VPS_PROVIDERS}.
 */
export function providerProfile(id: "portainer"): PortainerProfile;
export function providerProfile(id: "localhost"): LocalhostProfile;
export function providerProfile(id: "cloudflare-workers"): CloudflareHostingProfile;
export function providerProfile(id: "github-pages"): GithubPagesProfile;
export function providerProfile(
  id: ServerlessProvider,
): CloudflareHostingProfile | GithubPagesProfile;
export function providerProfile(id: VpsProviderId): ProviderProfile;
export function providerProfile(
  id: VpsProviderId | "portainer" | "localhost" | ServerlessProvider,
):
  | ProviderProfile
  | PortainerProfile
  | LocalhostProfile
  | CloudflareHostingProfile
  | GithubPagesProfile {
  if (id === "portainer") return PORTAINER;
  if (id === "localhost") return LOCALHOST;
  if (id === "cloudflare-workers") return CLOUDFLARE_HOSTING;
  if (id === "github-pages") return GITHUB_PAGES;
  const profile = PROFILES[id];
  if (profile === undefined) {
    throw new OpsCrewError("INVALID_INPUT", `OpsCrew does not know the server provider "${id}".`, {
      hint: "Use hetzner, digitalocean, own or portainer as the provider in opscrew/requirements.yaml and opscrew/plan.yaml.",
    });
  }
  return profile;
}

/**
 * `provider` when the app runs on one server; any other target here (a Portainer, this computer,
 * a server-less target) is a bug in OpsCrew.
 */
function serverProvider(provider: DeployProvider): VpsProviderId {
  if (onOneServer(provider)) return provider;
  throw wrongTarget(
    `This step only applies to an app on one server (Hetzner Cloud, DigitalOcean or a server you own), not to ${NOT_ON_SERVER[provider]}.`,
  );
}

/** How {@link serverProvider} names a target that is not one server. */
const NOT_ON_SERVER = {
  portainer: "an app in your existing Portainer",
  localhost: "an app on this computer (the localhost target)",
  "cloudflare-workers": "an app on Cloudflare's hosting",
  "github-pages": "a site on GitHub Pages",
} as const satisfies Record<Exclude<DeployProvider, VpsProviderId>, string>;

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
