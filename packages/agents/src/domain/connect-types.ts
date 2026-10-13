import type { RegistrarId } from "@opscrew/contracts";
import type { DomainServices } from "./types";

export interface ConnectDomainOptions {
  /** A domain the user already owns at a configured registrar. */
  domain: string;
  /** The registrar holding it (default: found among the configured registrars). */
  registrar?: RegistrarId;
  /** A BIND zone file with the current records, when the registrar does not host the DNS. */
  recordsFile?: string;
  /** Cloudflare account id when the token sees several. */
  account?: string;
  services?: DomainServices;
}

export interface ConnectDomainResult {
  domain: string;
  registrar: RegistrarId;
  zoneId: string;
  /** The Cloudflare nameservers the domain now points at. */
  nameservers: string[];
  /** Records copied into the Cloudflare zone. */
  copied: number;
  /** Plain-English next steps for the CLI to print. */
  next: string[];
}
