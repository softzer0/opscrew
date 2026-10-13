import { CloudflareClient, CloudflareRegistrar } from "@opscrew/connector-cloudflare";
import type { Registrar } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import type { PhaseDeps } from "../context";
import type { DomainAccount, DomainExtension, DomainServices, DomainZoneApi } from "./types";

/** The collaborators of a domain command with every default filled in. */
export interface ResolvedDomainServices {
  accounts: () => Promise<DomainAccount[]>;
  registrar: (accountId: string) => Registrar;
  extension: (accountId: string, tld: string) => Promise<DomainExtension | undefined>;
  zones: DomainZoneApi;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

/** The Cloudflare collaborators: accounts, the registrar of one account, extensions and zones. */
export type CloudflareDomainServices = Pick<
  ResolvedDomainServices,
  "accounts" | "registrar" | "extension" | "zones"
>;

/**
 * The real Cloudflare collaborators, built from `CLOUDFLARE_API_TOKEN` with the run's `fetch`
 * (the token is registered with the redactor, as the connector does). Zones are created only in
 * the given account (`createZone` reuses an existing zone only when it belongs to that account).
 */
export function defaultDomainServices(deps: PhaseDeps): CloudflareDomainServices {
  const token = deps.env.CLOUDFLARE_API_TOKEN?.trim();
  if (!token) {
    throw new OpsCrewError(
      "CREDENTIALS_MISSING",
      "No Cloudflare API token found. Set CLOUDFLARE_API_TOKEN to a token that can buy domains.",
      { hint: "Create one at https://dash.cloudflare.com/profile/api-tokens, then try again." },
    );
  }
  deps.redactor.addLiteral(token, "cloudflare-token");
  const client = new CloudflareClient({ token, fetch: deps.fetch, version: deps.version });
  return {
    accounts: () => client.listAccounts(),
    registrar: (accountId) => new CloudflareRegistrar(client, accountId),
    extension: async (accountId, tld) => {
      const found = await client.getExtension(accountId, tld);
      return found === undefined
        ? undefined
        : { contactExtensionsRequired: found.contactExtensionsRequired };
    },
    zones: {
      findZone: async (name) => {
        const zone = await client.findZone(name);
        return zone !== undefined && zone.name.toLowerCase() === name
          ? { id: zone.id, name: zone.name }
          : undefined;
      },
      createZone: async (accountId, name) => {
        const zone = await client.createZone(accountId, name);
        return { id: zone.id, name: zone.name };
      },
      enableDnssec: async (zoneId) => {
        await client.enableDnssec(zoneId);
      },
      dnssecEnabled: async (zoneId) => {
        const { status } = await client.getDnssec(zoneId);
        return status === "active" || status === "pending";
      },
    },
  };
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Fills the missing collaborators with the Cloudflare defaults (built only when needed). */
export function resolveDomainServices(
  deps: PhaseDeps,
  given: DomainServices = {},
): ResolvedDomainServices {
  const sleep = given.sleep ?? realSleep;
  const now = given.now ?? (() => performance.now());
  if (given.accounts && given.registrar && given.extension && given.zones) {
    return {
      accounts: given.accounts,
      registrar: given.registrar,
      extension: given.extension,
      zones: given.zones,
      sleep,
      now,
    };
  }
  const defaults = defaultDomainServices(deps);
  return {
    accounts: given.accounts ?? defaults.accounts,
    registrar: given.registrar ?? defaults.registrar,
    extension: given.extension ?? defaults.extension,
    zones: given.zones ?? defaults.zones,
    sleep,
    now,
  };
}
