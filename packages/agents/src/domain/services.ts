import { CloudflareClient, CloudflareRegistrar } from "@opscrew/connector-cloudflare";
import type { Registrar, RegistrarId } from "@opscrew/contracts";
import { OpsCrewError, realSleep } from "@opscrew/core";
import type { PhaseDeps } from "../context";
import { domainTokenMissing, requireCloudflareToken } from "./common";
import {
  configuredRegistrars,
  hasEnv,
  type OtherRegistrarId,
  REGISTRAR_IDS,
  REGISTRAR_NAMES,
  registrarFor,
  registrarSandbox,
} from "./registrars";
import type {
  DomainAccount,
  DomainExtension,
  DomainServices,
  DomainZone,
  DomainZoneApi,
} from "./types";

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

/** The stand-in zone of `name`: pending, with the stand-in nameservers. */
function standInZone(name: string): DomainZone {
  return { id: "sandbox", name, status: "pending", nameServers: [...SANDBOX_NAMESERVERS] };
}

/**
 * Stand-in zone calls for registrar sandboxes: every domain has a pending zone with the stand-in
 * nameservers, nothing is created at Cloudflare, the DNSSEC steps and the activation check answer
 * that they are skipped, and records are counted but not stored.
 */
export const SANDBOX_ZONES: DomainZoneApi = {
  findZone: async (name) => standInZone(name),
  createZone: async (_accountId, name) => standInZone(name),
  enableDnssec: async () => {},
  dnssecEnabled: async () => "skipped",
  dsRecord: async () => undefined,
  activationCheck: async () => ({
    requested: false,
    reason: "a registrar sandbox has no Cloudflare zone",
    skipped: true,
  }),
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
 * The real Cloudflare collaborators, built from `CLOUDFLARE_API_TOKEN` with the run's `fetch`.
 * Zones are created only in the given account (`createZone` reuses an existing zone only when it
 * belongs to that account). `OPSCREW_CLOUDFLARE_REGISTRAR_SANDBOX=1` (tests only) sends registrar
 * calls to Cloudflare's sandbox and uses the stand-in zones, as the sandbox has no zones; the
 * project files are still updated.
 */
export function defaultDomainServices(deps: PhaseDeps): CloudflareDomainServices {
  const token = requireCloudflareToken(deps);
  const sandbox = registrarSandbox("cloudflare", deps.env);
  const client = new CloudflareClient({
    token,
    fetch: deps.fetch,
    version: deps.version,
    registrarSandbox: sandbox,
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
            return { keyTag, algorithm, digestType, digest, ds };
          },
          activationCheck: (zoneId) => client.activationCheck(zoneId),
          listRecords: (zoneId) => client.listDnsRecords(zoneId),
          createRecords: async (zoneId, records) =>
            (await client.batchCreateRecords(zoneId, records)).length,
          scanRecords: (zoneId) => client.scanDnsRecords(zoneId),
        },
  };
}

const noToken = async (): Promise<never> => {
  throw domainTokenMissing();
};

/**
 * Cloudflare collaborators for a command that may run without Cloudflare (search, status and
 * auto-renew at another registrar) when `CLOUDFLARE_API_TOKEN` is not set: each call stops with
 * what to set.
 */
const WITHOUT_CLOUDFLARE: CloudflareDomainServices = {
  accounts: noToken,
  registrar: () => {
    throw domainTokenMissing();
  },
  extension: async () => undefined,
  zones: {
    findZone: noToken,
    createZone: noToken,
    enableDnssec: noToken,
    dnssecEnabled: noToken,
    dsRecord: noToken,
    activationCheck: noToken,
    listRecords: noToken,
    createRecords: noToken,
    scanRecords: noToken,
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

/**
 * Fills the missing collaborators with the Cloudflare defaults (built only when one is missing).
 * Other registrars are the given ones (tests), else built from the environment once per run.
 */
export function resolveDomainServices(
  deps: PhaseDeps,
  given: DomainServices = {},
  options: ResolveOptions = {},
): ResolvedDomainServices {
  const { accounts, registrar, extension, zones } = given;
  const cloudflare: CloudflareDomainServices =
    accounts && registrar && extension && zones
      ? { accounts, registrar, extension, zones }
      : options.requireCloudflare === false && !hasEnv(deps.env, "CLOUDFLARE_API_TOKEN")
        ? WITHOUT_CLOUDFLARE
        : defaultDomainServices(deps);
  const resolvedZones = zones ?? cloudflare.zones;
  const built = new Map<OtherRegistrarId, Registrar>();
  return {
    accounts: accounts ?? cloudflare.accounts,
    registrar: registrar ?? cloudflare.registrar,
    extension: extension ?? cloudflare.extension,
    zones: resolvedZones,
    zonesFor: (id) =>
      zones === undefined && id !== "cloudflare" && registrarSandbox(id, deps.env)
        ? SANDBOX_ZONES
        : resolvedZones,
    otherRegistrar: (id) => {
      if (given.registrars !== undefined) {
        const other = given.registrars[id];
        if (other !== undefined) return other;
        throw new OpsCrewError("CREDENTIALS_MISSING", `${REGISTRAR_NAMES[id]} is not set up.`);
      }
      let other = built.get(id);
      if (other === undefined) {
        other = registrarFor(id, deps);
        built.set(id, other);
      }
      return other;
    },
    configuredRegistrars: () => {
      if (given.registrars === undefined) return configuredRegistrars(deps.env);
      const withCloudflare = registrar !== undefined || hasEnv(deps.env, "CLOUDFLARE_API_TOKEN");
      return REGISTRAR_IDS.filter((id) =>
        id === "cloudflare" ? withCloudflare : given.registrars?.[id] !== undefined,
      );
    },
    sleep: given.sleep ?? realSleep,
    now: given.now ?? (() => performance.now()),
    randomUUID: given.randomUUID ?? (() => globalThis.crypto.randomUUID()),
  };
}
