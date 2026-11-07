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
  /** A whole-server snapshot per GB per month, where the provider publishes the rate. */
  snapshotPerGbMonth?: Money;
  /** When the snapshot rate was read, where that differs from `asOf` (a dated published rate). */
  snapshotRateAsOf?: IsoDateTime;
  pricesIncludeVat: boolean;
  source: "live" | "static";
  asOf: IsoDateTime;
}

/** Live (or dated static) price and availability catalogue for a compute provider. */
export interface ComputeCatalog {
  readonly provider: ProviderId;
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

/** A whole-server snapshot, as the provider reports it. */
export interface ServerSnapshot {
  /** Provider image or snapshot id as a string. */
  id: string;
  /** The snapshot's name (DigitalOcean) or description (Hetzner). */
  name: string;
  /** ISO 8601 time the provider created it. */
  createdAt: string;
  /** Size in GB as the provider bills it; absent while the provider doesn't know it yet. */
  sizeGb?: number;
  /** The snapshot's labels where the provider has them (Hetzner); empty otherwise. */
  labels: Record<string, string>;
}

/**
 * Server lookup, snapshots and rebuilds: a snapshot before a teardown, and whole-server snapshots
 * taken, listed, deleted and restored by command. Taking one only adds a resource.
 */
export interface ServerSnapshotApi {
  /** Servers labelled or tagged as created by OpsCrew for `app`. */
  findAppServers(app: string): Promise<AppServer[]>;
  /** Snapshots the server and resolves when the provider reports it complete. */
  snapshotServer(serverId: string, request: SnapshotRequest): Promise<{ snapshotId: string }>;
  /** The server's snapshots OpsCrew took, oldest first. */
  listSnapshots(serverId: string): Promise<ServerSnapshot[]>;
  /** Deletes a snapshot and resolves when the provider reports it gone. Destroy-grade. */
  deleteSnapshot(snapshotId: string): Promise<void>;
  /**
   * Rebuilds the server in place from the snapshot, keeping its id and addresses, and resolves
   * when the provider reports it done. Destroy-grade: the server's disk is replaced. Any password
   * the provider answers with is dropped, never returned or logged.
   */
  rebuild(serverId: string, snapshotId: string): Promise<void>;
  /**
   * Shuts the server down gracefully (ACPI) and resolves when the provider reports it off. Fails
   * plainly when it is not off within the wait; it never forces the power off.
   */
  powerOff(serverId: string): Promise<void>;
  /** Powers the server on and resolves when the provider reports it done. */
  powerOn(serverId: string): Promise<void>;
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
