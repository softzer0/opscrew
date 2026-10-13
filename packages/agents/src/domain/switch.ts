import type { DsRecord, Registrar, RegistrarId } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
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

/** What the switch needs: the run, the Cloudflare account of the zone and the zone calls. */
export interface SwitchContext {
  deps: PhaseDeps;
  /** The Cloudflare account the zone lives in. */
  account: DomainAccount;
  /** `services.zonesFor(registrarId)`: stand-ins when the registrar runs in its sandbox. */
  zones: DomainZoneApi;
}

/** The domain and the registrar that holds it. */
export interface SwitchTarget {
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
   * dashboard link (the API cannot publish it); `pending` Cloudflare has no DS record yet;
   * `skipped` stand-in zones (registrar sandbox).
   */
  outcome: "added" | "already" | "manual" | "pending" | "skipped";
}

export interface ActivationResult {
  requested: boolean;
  reason?: string;
}

export interface SwitchResult {
  zone: DomainZone;
  nameservers: NameserverSwitch;
  ds: DsPublication;
  activation: ActivationResult;
  /** True only when the DS record is published at the registry through the registrar's API. */
  dnssec: boolean;
}

/** `key tag 2371, algorithm 13, digest type 2, digest ABCDEF…`: a DS record to add by hand. */
export function dsRecordText(ds: DsRecord): string {
  return `key tag ${ds.keyTag}, algorithm ${ds.algorithm}, digest type ${ds.digestType}, digest ${ds.digest}`;
}

/** `a and b`, `a, b and c`. */
function listText(items: readonly string[]): string {
  return items.length <= 1
    ? items.join("")
    : `${items.slice(0, -1).join(", ")} and ${items.at(-1) ?? ""}`;
}

/** Hostnames normalised for comparison: trimmed, lower case, without a trailing dot. */
export function hosts(names: readonly string[]): string[] {
  return names.map((n) => n.trim().toLowerCase().replace(/\.$/, "")).filter((n) => n !== "");
}

/** True when both lists hold the same (normalised) hostnames, in any order. */
export function sameHosts(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((n) => right.has(n));
}

function sameDs(a: DsRecord, b: DsRecord): boolean {
  return (
    a.keyTag === b.keyTag &&
    a.algorithm === b.algorithm &&
    a.digestType === b.digestType &&
    a.digest.replace(/\s+/g, "").toLowerCase() === b.digest.replace(/\s+/g, "").toLowerCase()
  );
}

/** The domain's zone in the account (`createZone` reuses an existing zone in that account). */
export async function ensureZone(
  ctx: SwitchContext,
  target: Pick<SwitchTarget, "domain" | "registrarId">,
): Promise<DomainZone> {
  const { deps, account, zones } = ctx;
  const zone = await zones.createZone(account.id, target.domain);
  if (zones.simulated !== true) {
    await auditDomain(
      deps,
      "ensure zone",
      target.domain,
      `zone ${zone.id} in account ${account.id} (domain at ${REGISTRAR_NAMES[target.registrarId]})`,
    );
  }
  return zone;
}

/**
 * Points the domain's nameservers at the zone through the registrar's API (skipped when they
 * already do). Where the API cannot change nameservers, shows them with the dashboard link.
 */
export async function pointToZone(
  ctx: SwitchContext,
  target: SwitchTarget & { zone: DomainZone },
): Promise<NameserverSwitch> {
  const { deps } = ctx;
  const { domain, registrar, registrarId, zone } = target;
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
 * publish DS records, shows the values with the dashboard link. Stand-in zones skip it all.
 */
export async function publishDs(
  ctx: SwitchContext,
  target: SwitchTarget & { zone: DomainZone },
): Promise<DsPublication> {
  const { deps, zones } = ctx;
  const { domain, registrar, registrarId, zone } = target;
  if (zones.simulated === true) return { outcome: "skipped" };
  const name = REGISTRAR_NAMES[registrarId];
  const on = zones.dnssecEnabled === undefined ? false : await zones.dnssecEnabled(zone.id);
  if (!on) {
    await zones.enableDnssec(zone.id);
    await auditDomain(deps, "enable DNSSEC", domain, `zone ${zone.id} (domain at ${name})`);
  }
  const ds = zones.dsRecord === undefined ? undefined : await zones.dsRecord(zone.id);
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
  deps.reporter.warn(
    `${name}'s API cannot publish DNSSEC records, so add this DS record for ${domain} in ${name}'s dashboard (${registrarLinks(registrarId, deps.env).domains}) to turn DNSSEC on: ${dsRecordText(ds)}.`,
  );
  return { ds, outcome: "manual" };
}

/**
 * Asks Cloudflare to check the zone's nameservers now (not for an active zone or stand-ins). Too
 * soon or failing is fine: Cloudflare keeps checking on its own.
 */
export async function requestActivation(
  ctx: SwitchContext,
  target: Pick<SwitchTarget, "domain" | "registrarId"> & { zone: DomainZone },
): Promise<ActivationResult> {
  const { deps, zones } = ctx;
  const { domain, zone } = target;
  if (zones.simulated === true || zones.activationCheck === undefined) {
    return { requested: false, reason: "no activation check for these zones" };
  }
  if (zone.status === "active") return { requested: false, reason: "the zone is already active" };
  try {
    const result = await zones.activationCheck(zone.id);
    await auditDomain(
      deps,
      "zone activation check",
      domain,
      `zone ${zone.id} (domain at ${REGISTRAR_NAMES[target.registrarId]}): ${result.requested ? "requested" : "not requested now"}`,
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
 * nameservers → DS record (or the values and the link) → activation check. Resumable: run it again
 * after any failure.
 */
export async function switchToCloudflare(
  ctx: SwitchContext,
  target: SwitchTarget,
): Promise<SwitchResult> {
  const zone = await ensureZone(ctx, target);
  const nameservers = await pointToZone(ctx, { ...target, zone });
  const ds = await publishDs(ctx, { ...target, zone });
  const activation = await requestActivation(ctx, { ...target, zone });
  return {
    zone,
    nameservers,
    ds,
    activation,
    dnssec: ds.outcome === "added" || ds.outcome === "already",
  };
}
