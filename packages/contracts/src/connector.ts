import type { IsoDateTime, Money } from "./common";
import type { AnyToolDefinition } from "./runtime";

export type ProviderId =
  | "hetzner"
  | "cloudflare"
  | "github"
  | "digitalocean"
  | "aws"
  | "gcp"
  | "azure"
  | "contabo"
  | "namecheap";

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
  missingScopes?: string[];
}

/** A typed adapter for one provider. Reads are free; writes go through the approval gate. */
export interface Connector {
  readonly id: ProviderId;
  readonly displayName: string;
  readonly credentials: CredentialRequirement;
  verifyCredentials(): Promise<CredentialCheck>;
  /** In-process tools exposed to agents and the MCP server. */
  tools(): AnyToolDefinition[];
}

export interface ComputeLocation {
  /** Provider location id, for example `nbg1`. */
  id: string;
  /** Display name, for example `Nuremberg`. */
  name: string;
  country: string;
  city?: string;
  /** Provider network zone or region group, for example `eu-central`. */
  networkZone?: string;
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
  hourly?: Money;
  pricesIncludeVat: boolean;
  includedTrafficTb?: number;
  deprecated: boolean;
  available: boolean;
  recommended?: boolean;
  /** `live` when read from the provider API now; `static` when from a dated fallback table. */
  source: "live" | "static";
  asOf: IsoDateTime;
}

/** Location-dependent extra costs used by cost estimates. */
export interface ProviderExtras {
  ipv4Monthly?: Money;
  /** Automated backups as a percentage of the server price, for example 20. */
  backupPercent?: number;
  volumePerGbMonthly?: Money;
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
