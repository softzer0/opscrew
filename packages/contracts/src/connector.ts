import type { IsoDateTime, Money } from "./common";

export type ProviderId =
  | "hetzner"
  | "cloudflare"
  | "github"
  | "digitalocean"
  /** A server the user already owns, reached over SSH (no provider API). */
  | "own"
  /**
   * A Portainer the user already runs: OpsCrew deploys the app as Portainer stacks and never
   * creates, sizes or prices a server, so it is not a {@link VpsProviderId}.
   */
  | "portainer";

/** What credentials a connector needs and how to create them with the least privilege. */
export interface CredentialRequirement {
  /** Environment variables checked in order, for example `["HCLOUD_TOKEN"]`. */
  envVars: string[];
  /** Plain-English description of the token to create. */
  description: string;
  /** Minimal scopes/permissions, for example `["Zone:DNS:Edit", "Zone:Read"]`. */
  scopes: string[];
  /** Where the user creates the token. */
  createUrl: string;
}

export interface CredentialCheck {
  ok: boolean;
  /** Account, project or user the token belongs to, when the API reveals it. */
  identity?: string;
  /** Plain-English result, safe to show. */
  message: string;
}

/** A typed adapter for one provider. Reads are free; writes go through the approval gate. */
export interface Connector {
  readonly id: ProviderId;
  readonly displayName: string;
  readonly credentials: CredentialRequirement;
  verifyCredentials(): Promise<CredentialCheck>;
}

export interface ComputeLocation {
  /** Provider location id, for example `nbg1`. */
  id: string;
  /** Display name, for example `Nuremberg`. */
  name: string;
  country: string;
}

/** One purchasable server size in one location. */
export interface ComputeOffer {
  provider: ProviderId;
  /** Provider's type name, for example `cpx22`. */
  id: string;
  description?: string;
  vcpus: number;
  memoryGb: number;
  diskGb: number;
  cpuType: "shared" | "dedicated";
  architecture: "x86" | "arm";
  location: string;
  monthly: Money;
  pricesIncludeVat: boolean;
  deprecated: boolean;
  available: boolean;
  /** `live` when read from the provider API now; `static` when from a dated fallback table. */
  source: "live" | "static";
  asOf: IsoDateTime;
}

/** Location-dependent extra costs used by cost estimates. */
export interface ProviderExtras {
  ipv4Monthly?: Money;
  /** Automated backups as a percentage of the server price, for example 20. */
  backupPercent?: number;
  trafficPerTb?: Money;
  pricesIncludeVat: boolean;
  source: "live" | "static";
  asOf: IsoDateTime;
}

/** Live (or dated static) price and availability catalogue for a compute provider. */
export interface ComputeCatalog {
  readonly provider: ProviderId;
  listLocations(): Promise<ComputeLocation[]>;
  /** Offers for one location, or all locations when omitted. */
  listOffers(location?: string): Promise<ComputeOffer[]>;
  extras(location: string): Promise<ProviderExtras>;
}

/**
 * Targets OpsCrew deploys a single server to (`vps-compose` mode): Hetzner Cloud, DigitalOcean, or
 * a server the user already owns (`own`, which OpsCrew never creates or deletes). An existing
 * Portainer (`portainer`) is not one: there is no server to create, size or price.
 */
export type VpsProviderId = Extract<ProviderId, "hetzner" | "digitalocean" | "own">;

/** A server OpsCrew created for an app, as the provider reports it. */
export interface AppServer {
  /** Provider id as a string (both providers use numbers on the wire). */
  id: string;
  name: string;
  /** Provider status, for example `running` (Hetzner) or `active` (DigitalOcean). */
  status: string;
}

export interface SnapshotRequest {
  /** Snapshot name shown in the provider console (DigitalOcean); Hetzner uses `description`. */
  name: string;
  description: string;
  /** Applied where the provider supports labels on images (Hetzner); otherwise ignored. */
  labels: Record<string, string>;
  /** Give up waiting after this long (default 15 minutes). */
  timeoutMs?: number;
}

/** Server lookup and snapshots, used before a teardown. The snapshot only adds a resource. */
export interface ServerSnapshotApi {
  /** Servers labelled or tagged as created by OpsCrew for `app`. */
  findAppServers(app: string): Promise<AppServer[]>;
  /** Snapshots the server and resolves when the provider reports it complete. */
  snapshotServer(serverId: string, request: SnapshotRequest): Promise<{ snapshotId: string }>;
}

/** A VPS provider connector: credentials, price catalogue and server API. */
export interface VpsConnector extends Connector {
  readonly id: VpsProviderId;
  /** True when a token is set (it may still be invalid). */
  readonly configured: boolean;
  catalog(): ComputeCatalog;
  /** Undefined when no token is set. */
  readonly servers: ServerSnapshotApi | undefined;
}
