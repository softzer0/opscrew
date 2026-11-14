import type { IsoDateTime, Money } from "./common";

export type ProviderId =
  | "hetzner"
  | "cloudflare"
  | "github"
  | "digitalocean"
  /** Contabo (026): a cloud server provider whose servers are cancelled at the end of their term. */
  | "contabo"
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
  /** A one-time fee charged when the server is created (Contabo's smallest plan on a monthly term). */
  setupFee?: Money;
  /** Whole-server snapshots included in the price, where the provider includes them (Contabo). */
  includedSnapshots?: number;
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
  /** True when snapshots are included in the server's price up to its offer's `includedSnapshots`. */
  snapshotsIncluded?: boolean;
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
export type VpsProviderId = Extract<ProviderId, "hetzner" | "digitalocean" | "contabo" | "own">;

/** A server OpsCrew created for an app, as the provider reports it. */
export interface AppServer {
  /** Provider id as a string (both providers use numbers on the wire). */
  id: string;
  name: string;
  /** Provider status, for example `running` (Hetzner) or `active` (DigitalOcean). */
  status: string;
  /**
   * When a cancelled server's contract ends (ISO 8601), at a provider that cancels at the end of
   * the term instead of deleting (Contabo). Absent while the server is not cancelled.
   */
  cancelledUntil?: string;
  /**
   * True when only the server's name matched: the provider's label or tag was never attached, as
   * after a create that stopped halfway at a provider that tags after creating (Contabo). OpsCrew
   * takes such a server over only after its own provision stopped mid-apply.
   */
  nameOnly?: boolean;
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
  /** ISO 8601 time the provider created it. */
  createdAt: string;
  /** Size in GB as the provider bills it; absent while the provider doesn't know it yet. */
  sizeGb?: number;
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
  /**
   * Cancels the server at the end of its term through the provider's API, for a provider whose
   * Terraform cannot (`terraform.connectorRemoval`, ADR 0029 D10), and resolves with the day its
   * contract ends (`2026-12-11`). A server already cancelled resolves with its end date and is not
   * cancelled again. Destroy-grade.
   */
  cancelServer?(serverId: string): Promise<string>;
}

/** An inbound rule the connector writes into a firewall: it accepts. */
export interface WantedFirewallRule {
  protocol: "tcp" | "udp" | "icmp";
  /** Ports or ranges (`"80"`, `"8000-8100"`); none for ICMP. */
  ports: readonly string[];
  /** Sources; a family with no network holds one that matches nobody (`::1/128`). */
  ipv4: readonly string[];
  ipv6: readonly string[];
}

/** The firewall a server module wants (its `wanted_firewall` output, ADR 0029 D8). */
export interface WantedFirewall {
  name: string;
  description: string;
  /** The servers it protects, by the provider's server id. */
  serverIds: readonly string[];
  rules: readonly WantedFirewallRule[];
}

/**
 * A provider's firewalls, applied through the connector because its Terraform provider cannot
 * manage them (ADR 0029, D8). The provider's own rules (Contabo's "Block all traffic") are never
 * compared, written or deleted.
 */
export interface FirewallApi {
  /**
   * Makes the firewall named `wanted.name` exactly `wanted`: creates it, or sets its description
   * and rules and adds and removes servers, then waits until each server is protected. Returns
   * what it changed, in plain English; none when nothing differed.
   */
  sync(wanted: WantedFirewall): Promise<string[]>;
  /** How the firewall named `wanted.name` differs from `wanted`, in plain English; none if alike. */
  differences(wanted: WantedFirewall): Promise<string[]>;
  /** Deletes the firewall named `name`; false when there was none. Destroy-grade. */
  remove(name: string): Promise<boolean>;
}

/**
 * A provider's automated backups of a server, turned on through its API because its Terraform
 * cannot (Contabo's Auto Backup, 027 research R15). No call turns them off: the provider's panel
 * does that.
 */
export interface ProviderBackupsApi {
  /**
   * Turns on the automated backups of the server `serverId`, a paid add-on. Mutating: only after
   * an approved plan names it. Resolves with nothing once the provider took it, and with `refused`
   * when the provider answered with a client error (a status below 500), so nothing was turned on;
   * rejects when the outcome is unknown (no answer, a lost connection, a 5xx).
   */
  turnOn(serverId: string): Promise<{ refused: string } | undefined>;
}

/** An object storage at a provider that sells one per region and account (Contabo). */
export interface ProviderObjectStorage {
  /** The provider's id of the storage. */
  id: string;
  /** The provider's region of the storage, for example `EU`. */
  region: string;
  /** Its S3 endpoint, with `https://` and no trailing slash. */
  s3Url: string;
  /** When a cancelled storage ends (`2026-12-11`); absent while it is not cancelled. */
  cancelledUntil?: string;
}

/** A storage's S3 key pair. Never logged, printed, or written to Terraform state. */
export interface ObjectStorageKey {
  accessKeyId: string;
  secretAccessKey: string;
}

/**
 * Object storage ordered through a provider's API, for a provider whose Terraform cannot manage it
 * (Contabo: its object storage cannot be imported). OpsCrew never cancels one: a storage serves
 * every bucket of the account in its region. Buckets are made over S3 with the storage's key,
 * never through this API.
 */
export interface ObjectStorageApi {
  /**
   * The account's storage in `region` (one per region) whose contract has not ended, if any. It
   * fails rather than answer none when the account has a storage in a region it cannot name.
   */
  find(region: string): Promise<ProviderObjectStorage | undefined>;
  /**
   * Orders a storage of `sizeTb` TB in `region` and resolves once the provider reports it ready,
   * with its S3 endpoint; it is billed from then on. Resolves with `refused` when the provider
   * answered the order with a client error (a status below 500), so nothing was ordered; rejects
   * when the outcome is unknown (no answer, a lost connection, a 5xx) or the storage did not
   * become ready. Mutating: only after an approved plan.
   */
  order(request: {
    region: string;
    sizeTb: number;
    displayName: string;
  }): Promise<{ ordered: ProviderObjectStorage } | { refused: string }>;
  /** The S3 key the provider made with the storage `storageId`. Registered with the redactor. */
  key(storageId: string): Promise<ObjectStorageKey>;
}

/** A VPS provider connector: credentials, price catalogue and server API. */
export interface VpsConnector extends Connector {
  /** True when a token is set (it may still be invalid). */
  readonly configured: boolean;
  catalog(): ComputeCatalog;
  /** Undefined when no token is set. */
  readonly servers: ServerSnapshotApi | undefined;
  /**
   * The firewalls, for a provider with `terraform.connectorFirewall` (ADR 0029, D8); undefined
   * when no token is set and for every other provider.
   */
  readonly firewalls?: FirewallApi | undefined;
  /**
   * The automated backups, for a provider with `terraform.connectorBackups`; undefined when no
   * token is set and for every other provider.
   */
  readonly backups?: ProviderBackupsApi | undefined;
  /**
   * Object storage through the provider's API, for a provider that sells it that way (Contabo);
   * undefined when no token is set and for every other provider.
   */
  readonly objectStorage?: ObjectStorageApi | undefined;
}
