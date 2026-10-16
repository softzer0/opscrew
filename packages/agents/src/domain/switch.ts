import type { DsRecord, Registrar, RegistrarId } from "@opscrew/contracts";
import { listText, normalizeHostName, OpsCrewError } from "@opscrew/core";
import type { PhaseDeps } from "../context";
import { auditDomain, errorText } from "./common";
import { capabilitiesOf, REGISTRAR_NAMES, registrarLinks } from "./registrars";
import type { DomainAccount, DomainZone, DomainZoneApi, ZoneDsRecord } from "./types";

/**
 * Moving a domain's DNS to Cloudflare at the registrar that holds it (feature 007): the zone, the
 * nameservers, DNSSEC and Cloudflare's activation check. Each step is idempotent and safe to repeat
 * (an existing zone is reused, nameservers already set and a DS record already published are
 * skipped), and each change is audited with the registrar's name, never with contact data. The
 * caller asks for the approval first; these functions change things right away.
 */

/** What the switch needs: the run, the domain, the registrar holding it and the zone calls. */
export interface SwitchContext {
  deps: PhaseDeps;
  /** The Cloudflare account the zone lives in. */
  account: DomainAccount;
  /** `services.zonesFor(registrarId)`: stand-ins when the registrar runs in its sandbox. */
  zones: DomainZoneApi;
  domain: string;
  registrarId: RegistrarId;
  registrar: Registrar;
}

/** What `pointToZone` did. */
export interface NameserverSwitch {
  /** The zone's nameservers (lower case, without a trailing dot). */
  nameservers: string[];
  /**
   * `set`: changed through the registrar's API now; `already`: they pointed at the zone before;
   * `manual`: the registrar's API cannot change them, so they were shown with the dashboard link.
   */
  outcome: "set" | "already" | "manual";
}

/** What `publishDs` did. */
export interface DsPublication {
  /** The zone's DS record, once Cloudflare has one. */
  ds?: ZoneDsRecord;
  /**
   * `added` through the registrar's API now; `already` published there; `manual` shown with the
   * dashboard link (the API cannot publish it); `pending` Cloudflare has no DS record yet.
   */
  outcome: "added" | "already" | "manual" | "pending";
}

/** DNSSEC left for later: the zone is not active yet (`opscrew domain connect` adds it then). */
export interface DsLater {
  outcome: "later";
}

export interface ActivationResult {
  requested: boolean;
  reason?: string;
}

export interface SwitchResult {
  zone: DomainZone;
  nameservers: NameserverSwitch;
  ds: DsPublication | DsLater;
  activation: ActivationResult;
  /** True only when the DS record is published at the registry through the registrar's API. */
  dnssec: boolean;
}

/** `key tag 2371, algorithm 13, digest type 2, digest ABCDEF…`: a DS record to add by hand. */
export function dsRecordText(ds: DsRecord): string {
  return `key tag ${ds.keyTag}, algorithm ${ds.algorithm}, digest type ${ds.digestType}, digest ${ds.digest}`;
}

/** Hostnames normalised for comparison (see `normalizeHostName`), blanks dropped. */
export function hosts(names: readonly string[]): string[] {
  return names.map(normalizeHostName).filter((n) => n !== "");
}

/** True when both lists hold the same (normalised) hostnames, in any order. */
export function sameHosts(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((n) => right.has(n));
}

/** True when both are the same DS record (the digest compared without spaces or case). */
export function sameDs(a: DsRecord, b: DsRecord): boolean {
  const digest = (d: DsRecord) => d.digest.replace(/\s+/g, "").toLowerCase();
  return (
    a.keyTag === b.keyTag &&
    a.algorithm === b.algorithm &&
    a.digestType === b.digestType &&
    digest(a) === digest(b)
  );
}

/** The domain's zone in the account (`createZone` reuses an existing zone in that account). */
export async function ensureZone(ctx: SwitchContext): Promise<DomainZone> {
  const { deps, account, zones, domain } = ctx;
  const zone = await zones.createZone(account.id, domain);
  await auditDomain(
    deps,
    "ensure zone",
    domain,
    `zone ${zone.id} in account ${account.id} (domain at ${REGISTRAR_NAMES[ctx.registrarId]})`,
  );
  return zone;
}

/**
 * Points the domain's nameservers at the zone through the registrar's API (skipped when they
 * already do). Where the API cannot change nameservers, shows them with the dashboard link.
 */
export async function pointToZone(ctx: SwitchContext, zone: DomainZone): Promise<NameserverSwitch> {
  const { deps, domain, registrar, registrarId } = ctx;
  const name = REGISTRAR_NAMES[registrarId];
  const nameservers = hosts(zone.nameServers ?? []);
  if (nameservers.length === 0) {
    throw new OpsCrewError(
      "PROVIDER_ERROR",
      `Cloudflare did not return the nameservers of the zone for ${domain}, so OpsCrew cannot point ${domain} at it.`,
      { hint: "Try again in a minute." },
    );
  }
  const caps = capabilitiesOf(registrar);
  if (caps.nameservers && registrar.getNameservers && registrar.setNameservers) {
    const current = hosts(await registrar.getNameservers(domain));
    if (sameHosts(current, nameservers)) {
      deps.reporter.info(`The nameservers of ${domain} at ${name} already point at Cloudflare.`);
      return { nameservers, outcome: "already" };
    }
    deps.reporter.step(
      `Pointing the nameservers of ${domain} at Cloudflare (${listText(nameservers)})…`,
    );
    await registrar.setNameservers(domain, nameservers);
    await auditDomain(
      deps,
      "set nameservers",
      domain,
      `${name}: ${nameservers.join(", ")} (zone ${zone.id}); before: ${current.join(", ") || "none"}`,
    );
    return { nameservers, outcome: "set" };
  }
  deps.reporter.warn(
    `${name}'s API cannot change nameservers, so set them yourself: in ${name}'s dashboard (${registrarLinks(registrarId, deps.env).domains}), set the nameservers of ${domain} to ${listText(nameservers)}.`,
  );
  return { nameservers, outcome: "manual" };
}

/**
 * Turns DNSSEC on for the zone (unless it is on) and publishes the zone's DS record at the
 * registry through the registrar's API (skipped when it is there already). Where the API cannot
 * publish DS records, returns the values (`manual`) for the caller to show with the dashboard
 * link.
 */
export async function publishDs(ctx: SwitchContext, zone: DomainZone): Promise<DsPublication> {
  const { deps, zones, domain, registrar, registrarId } = ctx;
  const name = REGISTRAR_NAMES[registrarId];
  if (!(await zones.dnssecEnabled(zone.id))) {
    await zones.enableDnssec(zone.id);
    await auditDomain(deps, "enable DNSSEC", domain, `zone ${zone.id} (domain at ${name})`);
  }
  const ds = await zones.dsRecord(zone.id);
  if (ds === undefined) {
    deps.reporter.warn(
      `Cloudflare has not produced the DS record of ${domain} yet, so DNSSEC is not published at ${name} yet.`,
    );
    return { outcome: "pending" };
  }
  const caps = capabilitiesOf(registrar);
  if (caps.dnssec && registrar.addDsRecord) {
    const published = registrar.listDsRecords ? await registrar.listDsRecords(domain) : [];
    if (published.some((r) => sameDs(r, ds))) return { ds, outcome: "already" };
    const { keyTag, algorithm, digestType, digest } = ds;
    await registrar.addDsRecord(domain, { keyTag, algorithm, digestType, digest });
    await auditDomain(
      deps,
      "add DS record",
      domain,
      `${name}: key tag ${keyTag}, algorithm ${algorithm}, digest type ${digestType} (zone ${zone.id})`,
    );
    return { ds, outcome: "added" };
  }
  // The caller shows the values with the dashboard link (once, in its next steps).
  return { ds, outcome: "manual" };
}

/**
 * Asks Cloudflare to check the zone's nameservers now (not for an active zone). Too soon or
 * failing is fine: Cloudflare keeps checking on its own.
 */
export async function requestActivation(
  ctx: SwitchContext,
  zone: DomainZone,
): Promise<ActivationResult> {
  const { deps, zones, domain } = ctx;
  if (zone.status === "active") return { requested: false, reason: "the zone is already active" };
  try {
    const result = await zones.activationCheck(zone.id);
    await auditDomain(
      deps,
      "zone activation check",
      domain,
      `zone ${zone.id} (domain at ${REGISTRAR_NAMES[ctx.registrarId]}): ${result.requested ? "requested" : "not requested now"}`,
    );
    return result;
  } catch (error) {
    const reason = errorText(deps, error);
    deps.reporter.warn(
      `Cloudflare could not start an activation check for ${domain} now (${reason}); it checks the nameservers on its own.`,
    );
    return { requested: false, reason };
  }
}

/**
 * The whole switch after a purchase (or for a domain already in the account), in order: zone →
 * nameservers → DS record (or the values) → activation check. Resumable: run it again after any
 * failure. `publishDs: false` leaves DNSSEC alone (`later`): a domain that may be live gets its DS
 * record only once its zone is active, through `opscrew domain connect`.
 */
export async function switchToCloudflare(
  ctx: SwitchContext,
  options: { publishDs: boolean },
): Promise<SwitchResult> {
  const zone = await ensureZone(ctx);
  const nameservers = await pointToZone(ctx, zone);
  const ds: DsPublication | DsLater = options.publishDs
    ? await publishDs(ctx, zone)
    : { outcome: "later" };
  const activation = await requestActivation(ctx, zone);
  return {
    zone,
    nameservers,
    ds,
    activation,
    dnssec: ds.outcome === "added" || ds.outcome === "already",
  };
}
