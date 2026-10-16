import type { RegistrarId } from "@opscrew/contracts";
import type { DomainServices } from "./types";

export interface ConnectDomainOptions {
  /** A domain the user already owns at a configured registrar. */
  domain: string;
  /** The registrar holding it (default: found among the configured registrars). */
  registrar?: RegistrarId;
  /**
   * A BIND zone file with the current records (relative paths start at the project root). Used
   * instead of the registrar's DNS records; needed without a terminal when the registrar does not
   * host the DNS.
   */
  recordsFile?: string;
  /** Cloudflare account id when the token sees several. */
  account?: string;
  services?: DomainServices;
}

/**
 * What `connectDomain` did:
 * - `connected`: records copied (when missing) and the nameservers switched in this run;
 * - `waiting-for-ds`: old DNSSEC (DS) records block the switch: removed in this run (or earlier)
 *   and resolvers may still remember them until `waitUntil` (at least 24 hours after the
 *   removal), or they must be removed in the registrar's dashboard first (no `waitUntil`); the
 *   nameservers were not switched;
 * - `dnssec-published`: already connected; this run turned DNSSEC on for the active zone after a
 *   typed approval and published its DS record (or showed it to add by hand);
 * - `already-connected`: the nameservers already pointed at the zone; nothing was switched (stale
 *   DS records that do not match the zone are reported in `next`, with the registrar's dashboard).
 */
export type ConnectDomainOutcome =
  | "connected"
  | "waiting-for-ds"
  | "dnssec-published"
  | "already-connected";

export interface ConnectDomainResult {
  outcome: ConnectDomainOutcome;
  domain: string;
  registrar: RegistrarId;
  /** The Cloudflare zone, once there is one. */
  zoneId?: string;
  /** The zone's Cloudflare nameservers (empty before the zone exists). */
  nameservers: string[];
  /** Records this run created in the zone. */
  copied: number;
  /** True when the zone's DS record is published at the registry (DNSSEC in force). */
  dnssec: boolean;
  /** `waiting-for-ds`: when the nameservers can be switched (ISO time). */
  waitUntil?: string;
  /** Which project files record the domain after this run. */
  recorded: { plan: boolean; requirements: boolean };
  /** Plain-English next steps for the CLI to print. */
  next: string[];
}
