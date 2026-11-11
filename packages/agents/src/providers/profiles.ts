import type { Money, VpsProviderId } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { wrongTarget } from "@opscrew/iac-templates";
import {
  type CloudProvider,
  CloudProviderSchema,
  type DeployPlan,
  type DeployProvider,
  onOneServer,
  type Region,
  RegionSchema,
  type Requirements,
  type ServerlessProvider,
} from "@opscrew/plan-schema";
import { CLOUD_PROVIDERS, cloudProvider } from "@opscrew/providers";
import { z } from "zod";

/** What the phases need to know about a VPS provider, so none of them imports its connector. */
export interface ProviderProfile {
  id: VpsProviderId;
  /** For example `Hetzner Cloud`. */
  displayName: string;
  /** What the provider calls the server: `server` or `Droplet`. */
  serverNoun: string;
  /** Environment variables holding the API token, checked in order. */
  tokenVars: readonly string[];
  /**
   * How {@link tokenVars} are read: `any`, the first one set is the token; `all`, they are a set
   * of credentials and every one is needed.
   */
  tokenMode: "any" | "all";
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

/** A definition's locations per region, read with OpsCrew's regions (ADR 0029). */
const RegionLocationsSchema = z.record(RegionSchema, z.array(z.string()));

/** A cloud provider's profile, read from its definition in the registry (ADR 0029). */
function cloudProfile(id: CloudProvider): ProviderProfile {
  const definition = cloudProvider(id);
  const { credentials, regions, offering, terraform } = definition;
  return {
    id,
    displayName: definition.displayName,
    serverNoun: definition.serverNoun,
    tokenVars: credentials.envVars,
    tokenMode: credentials.mode,
    tokenUrl: credentials.createUrl,
    consoleUrl: definition.consoleUrl,
    accountUrl: definition.accountUrl,
    serverResourceType: terraform.serverResourceType,
    firewallResourceType: terraform.firewallResourceType,
    deleteProtection: offering.deleteProtection,
    defaultImage: offering.defaultImage,
    currency: offering.currency,
    backupPercent: offering.backupPercent,
    backupsOutliveServer: offering.backupsOutliveServer,
    providerBackups: offering.providerBackups,
    regionLocations: RegionLocationsSchema.parse(regions.locations),
    locationNames: regions.locationNames,
    regionNotes: regions.notes,
    unavailable: offering.unavailable,
    serverLimit: offering.serverLimit,
    mirroredAttributes: terraform.mirroredAttributes,
  };
}

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
  tokenMode: "any",
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

/**
 * Every cloud provider OpsCrew creates servers on (with an API token), in the registry's order,
 * Hetzner first. A server the user already owns (`own`) is not one of them.
 */
export const VPS_PROVIDERS: readonly CloudProvider[] = CLOUD_PROVIDERS.map(({ id }) =>
  CloudProviderSchema.parse(id),
);

/** The cloud provider when nothing names one (no answer, no token): the registry's first. */
export const DEFAULT_CLOUD_PROVIDER: CloudProvider = CloudProviderSchema.parse(VPS_PROVIDERS[0]);

const PROFILES: ReadonlyMap<VpsProviderId, ProviderProfile> = new Map([
  ...VPS_PROVIDERS.map((id) => [id, cloudProfile(id)] as const),
  ["own", OWN] as const,
]);

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
  const profile = PROFILES.get(id);
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

/** What the environment holds of a credential (see {@link credentialVars}). */
export interface CredentialVars {
  /** The variables holding it, once it is complete: the first one set, or every one of a set. */
  set?: readonly string[];
  /** The variables still to set: none once it is complete, else the first one, or a set's unset. */
  missing: readonly string[];
}

/**
 * What `env` holds of a credential read from `vars`: with `any`, the first of them that is set is
 * the token; with `all`, they are a set and every one is needed, so the unset ones are missing.
 */
export function credentialVars(
  vars: readonly string[],
  mode: "any" | "all",
  env: Readonly<Record<string, string | undefined>>,
): CredentialVars {
  const isSet = (name: string) => (env[name] ?? "").trim() !== "";
  if (mode === "all") {
    const missing = vars.filter((name) => !isSet(name));
    return missing.length === 0 ? { set: vars, missing } : { missing };
  }
  const first = vars.find(isSet);
  return first === undefined ? { missing: vars.slice(0, 1) } : { set: [first], missing: [] };
}

/** {@link credentialVars} of a provider's credentials (`tokenVars`, `tokenMode`). */
export function providerCredentials(
  profile: Pick<ProviderProfile, "tokenVars" | "tokenMode">,
  env: Readonly<Record<string, string | undefined>>,
): CredentialVars {
  return credentialVars(profile.tokenVars, profile.tokenMode, env);
}

/**
 * The provider whose credentials are set, when exactly one provider has them: its token, or every
 * credential of a provider that needs a set of them.
 */
export function providerFromTokens(
  env: Readonly<Record<string, string | undefined>>,
): VpsProviderId | undefined {
  const withToken = VPS_PROVIDERS.filter(
    (id) => providerCredentials(providerProfile(id), env).set !== undefined,
  );
  return withToken.length === 1 ? withToken[0] : undefined;
}
