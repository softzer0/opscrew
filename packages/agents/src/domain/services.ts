import { CloudflareClient, CloudflareRegistrar } from "@opscrew/connector-cloudflare";
import type { Registrar, RegistrarId } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import type { PhaseDeps } from "../context";
import {
  configuredRegistrars,
  type OtherRegistrarId,
  REGISTRAR_IDS,
  REGISTRAR_NAMES,
  registrarFor,
  registrarSandbox,
} from "./registrars";
import type { DomainAccount, DomainExtension, DomainServices, DomainZoneApi } from "./types";

/** The collaborators of a domain command with every default filled in. */
export interface ResolvedDomainServices {
  accounts: () => Promise<DomainAccount[]>;
  registrar: (accountId: string) => Registrar;
  extension: (accountId: string, tld: string) => Promise<DomainExtension | undefined>;
  zones: DomainZoneApi;
  /**
   * The zone calls for a domain bought or managed at `registrar`: stand-ins when that registrar
   * runs in its sandbox (the sandbox domain does not exist, so Cloudflare cannot add its zone),
   * else `zones`.
   */
  zonesFor: (registrar: RegistrarId) => DomainZoneApi;
  /** The adapter of another registrar (built once per run); stops when it is not set up. */
  otherRegistrar: (id: OtherRegistrarId) => Registrar;
  /** Registrars with credentials, Cloudflare first. */
  configuredRegistrars: () => RegistrarId[];
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** A new idempotency key for a purchase. */
  randomUUID: () => string;
}

/** Nameservers the stand-in zones report (real Cloudflare names, so registrar sandboxes accept them). */
export const SANDBOX_NAMESERVERS: readonly string[] = [
  "ada.ns.cloudflare.com",
  "bob.ns.cloudflare.com",
];

/**
 * Stand-in zone calls for registrar sandboxes: nothing is created at Cloudflare, DNSSEC stays off,
 * records are counted but not stored.
 */
export const SANDBOX_ZONES: DomainZoneApi = {
  simulated: true,
  findZone: async () => undefined,
  createZone: async (_accountId, name) => ({
    id: "sandbox",
    name,
    status: "pending",
    nameServers: [...SANDBOX_NAMESERVERS],
  }),
  enableDnssec: async () => {},
  dnssecEnabled: async () => false,
  dsRecord: async () => undefined,
  activationCheck: async () => ({ requested: false, reason: "sandbox: no Cloudflare zone exists" }),
  listRecords: async () => [],
  createRecords: async (_zoneId, records) => records.length,
  scanRecords: async () => [],
};

/** The Cloudflare collaborators: accounts, the registrar of one account, extensions and zones. */
export type CloudflareDomainServices = Pick<
  ResolvedDomainServices,
  "accounts" | "registrar" | "extension" | "zones"
>;

/**
 * The real Cloudflare collaborators, built from `CLOUDFLARE_API_TOKEN` with the run's `fetch`
 * (the token is registered with the redactor, as the connector does). Zones are created only in
 * the given account (`createZone` reuses an existing zone only when it belongs to that account).
 * `OPSCREW_CLOUDFLARE_REGISTRAR_SANDBOX=1` (tests only) sends registrar calls to Cloudflare's
 * sandbox and skips the zone and DNSSEC setup, which the sandbox does not cover (`zones.simulated`);
 * the project files are still updated.
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
  const sandbox = deps.env.OPSCREW_CLOUDFLARE_REGISTRAR_SANDBOX === "1";
  const client = new CloudflareClient({
    token,
    fetch: deps.fetch,
    version: deps.version,
    ...(sandbox ? { registrarSandbox: true } : {}),
  });
  if (sandbox) {
    deps.reporter.warn(
      "Using Cloudflare's registrar sandbox (OPSCREW_CLOUDFLARE_REGISTRAR_SANDBOX=1): purchases are simulated and the zone and DNSSEC setup is skipped, but OpsCrew still records the domain in the project files (opscrew/requirements.yaml and opscrew/plan.yaml). Unset it to buy real domains.",
    );
  }
  return {
    accounts: () => client.listAccounts(),
    registrar: (accountId) => new CloudflareRegistrar(client, accountId),
    extension: async (accountId, tld) => {
      const found = await client.getExtension(accountId, tld);
      return found === undefined
        ? undefined
        : { contactExtensionsRequired: found.contactExtensionsRequired };
    },
    zones: sandbox
      ? SANDBOX_ZONES
      : {
          findZone: async (name) => {
            const zone = await client.findZone(name);
            return zone !== undefined && zone.name.toLowerCase() === name ? zone : undefined;
          },
          createZone: (accountId, name) => client.createZone(accountId, name),
          enableDnssec: async (zoneId) => {
            await client.enableDnssec(zoneId);
          },
          dnssecEnabled: async (zoneId) => {
            const { status } = await client.getDnssec(zoneId);
            return status === "active" || status === "pending";
          },
          dsRecord: async (zoneId) => {
            const { keyTag, algorithm, digestType, digest, ds } = await client.getDnssec(zoneId);
            if (
              keyTag === undefined ||
              algorithm === undefined ||
              digestType === undefined ||
              digest === undefined
            ) {
              return undefined;
            }
            return { keyTag, algorithm, digestType, digest, ...(ds ? { ds } : {}) };
          },
          activationCheck: async (zoneId) => {
            const result = await client.activationCheck(zoneId);
            return result.requested
              ? { requested: true }
              : { requested: false, reason: result.reason };
          },
          listRecords: async (zoneId) =>
            (await client.listDnsRecords(zoneId)).map(
              ({ type, name, content, proxied, priority }) => ({
                type,
                name,
                content,
                ...(proxied === undefined ? {} : { proxied }),
                ...(priority === undefined ? {} : { priority }),
              }),
            ),
          createRecords: async (zoneId, records) =>
            (await client.batchCreateRecords(zoneId, records)).length,
          scanRecords: (zoneId) => client.scanDnsRecords(zoneId),
        },
  };
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Other registrars: the given ones (tests), else built from the environment once per run. */
function otherRegistrarServices(
  deps: PhaseDeps,
  given: DomainServices,
): Pick<ResolvedDomainServices, "otherRegistrar" | "configuredRegistrars"> {
  const built = new Map<OtherRegistrarId, Registrar>();
  return {
    otherRegistrar: (id) => {
      if (given.registrars !== undefined) {
        const registrar = given.registrars[id];
        if (registrar !== undefined) return registrar;
        throw new OpsCrewError("CREDENTIALS_MISSING", `${REGISTRAR_NAMES[id]} is not set up.`);
      }
      let registrar = built.get(id);
      if (registrar === undefined) {
        registrar = registrarFor(id, deps);
        built.set(id, registrar);
      }
      return registrar;
    },
    configuredRegistrars: () => {
      if (given.registrars === undefined) return configuredRegistrars(deps.env);
      const cloudflare =
        given.registrar !== undefined || (deps.env.CLOUDFLARE_API_TOKEN?.trim() ?? "") !== "";
      return REGISTRAR_IDS.filter((id) =>
        id === "cloudflare" ? cloudflare : given.registrars?.[id] !== undefined,
      );
    },
  };
}

/** Says that a Cloudflare call needs `CLOUDFLARE_API_TOKEN` (calls made without the token). */
function cloudflareTokenMissing(): OpsCrewError {
  return new OpsCrewError(
    "CREDENTIALS_MISSING",
    "No Cloudflare API token found. Set CLOUDFLARE_API_TOKEN to a token for your Cloudflare account.",
    { hint: "Create one at https://dash.cloudflare.com/profile/api-tokens, then try again." },
  );
}

/** Zone calls without a Cloudflare token: each one stops with what to set. */
const NO_CLOUDFLARE_ZONES: DomainZoneApi = {
  findZone: async () => {
    throw cloudflareTokenMissing();
  },
  createZone: async () => {
    throw cloudflareTokenMissing();
  },
  enableDnssec: async () => {
    throw cloudflareTokenMissing();
  },
};

export interface ResolveOptions {
  /**
   * False when the command may run without Cloudflare (search, status and auto-renew at another
   * registrar): without `CLOUDFLARE_API_TOKEN`, the Cloudflare collaborators then stop with what to
   * set only when they are used. Default true: a missing token stops right away.
   */
  requireCloudflare?: boolean;
}

/** Fills the missing collaborators with the Cloudflare defaults (built only when needed). */
export function resolveDomainServices(
  deps: PhaseDeps,
  given: DomainServices = {},
  options: ResolveOptions = {},
): ResolvedDomainServices {
  const sleep = given.sleep ?? realSleep;
  const now = given.now ?? (() => performance.now());
  const randomUUID = given.randomUUID ?? (() => globalThis.crypto.randomUUID());
  const others = { ...otherRegistrarServices(deps, given), sleep, now, randomUUID };
  const zonesFor =
    (zones: DomainZoneApi) =>
    (registrar: RegistrarId): DomainZoneApi =>
      given.zones === undefined &&
      registrar !== "cloudflare" &&
      registrarSandbox(registrar, deps.env)
        ? SANDBOX_ZONES
        : zones;
  if (given.accounts && given.registrar && given.extension && given.zones) {
    return {
      accounts: given.accounts,
      registrar: given.registrar,
      extension: given.extension,
      zones: given.zones,
      zonesFor: zonesFor(given.zones),
      ...others,
    };
  }
  if (options.requireCloudflare === false && !deps.env.CLOUDFLARE_API_TOKEN?.trim()) {
    const zones = given.zones ?? NO_CLOUDFLARE_ZONES;
    return {
      accounts:
        given.accounts ??
        (async () => {
          throw cloudflareTokenMissing();
        }),
      registrar:
        given.registrar ??
        (() => {
          throw cloudflareTokenMissing();
        }),
      extension: given.extension ?? (async () => undefined),
      zones,
      zonesFor: zonesFor(zones),
      ...others,
    };
  }
  const defaults = defaultDomainServices(deps);
  const zones = given.zones ?? defaults.zones;
  return {
    accounts: given.accounts ?? defaults.accounts,
    registrar: given.registrar ?? defaults.registrar,
    extension: given.extension ?? defaults.extension,
    zones,
    zonesFor: zonesFor(zones),
    ...others,
  };
}
