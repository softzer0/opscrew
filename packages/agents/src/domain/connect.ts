import { isAbsolute, resolve } from "node:path";
import type { DsRecord, RegisteredDomain, Registrar, RegistrarDnsRecord } from "@opscrew/contracts";
import { listText, OpsCrewError, plural } from "@opscrew/core";
import type { DeployPlan } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { requireNoMoveInProgress } from "../provision/guard";
import { shellWord } from "../shared/apply-command";
import {
  auditDomain,
  errorText,
  parseHostName,
  requireCloudflareToken,
  resolveAccount,
  toIsoDateTime,
  unfinished,
} from "./common";
import { readBindFile } from "./connect-bind";
import { lookupPublishedDs } from "./connect-dns";
import {
  type CopyPlan,
  copyPlan,
  createLines,
  managedText,
  missingFromZone,
  recordText,
  zoneRecordText,
} from "./connect-plan";
import {
  type ConnectState,
  connectStatePath,
  dsWaitSeconds,
  laterSwitch,
  REMOVAL_MARGIN_SECONDS,
  readConnectState,
  removeConnectState,
  writeConnectState,
} from "./connect-state";
import type { ConnectDomainOptions, ConnectDomainResult } from "./connect-types";
import {
  approveDomainSwitch,
  nextProjectStep,
  type ProjectFiles,
  projectChanges,
  projectLines,
  readProjectFiles,
  recordDomain,
} from "./project";
import { formatTime } from "./purchase";
import {
  OTHER_REGISTRAR_IDS,
  type OtherRegistrarId,
  parseRegistrarId,
  REGISTRAR_ENV,
  REGISTRAR_NAMES,
  registrarLinks,
} from "./registrars";
import { type ResolvedDomainServices, resolveDomainServices } from "./services";
import {
  dsRecordText,
  ensureZone,
  hosts,
  pointToZone,
  publishDs,
  requestActivation,
  type SwitchContext,
  sameDs,
  sameHosts,
} from "./switch";
import type { DomainZone, ZoneDsRecord } from "./types";

/**
 * `opscrew domain connect` (feature 007, US2): moves a domain the user already owns at Porkbun,
 * Namecheap or GoDaddy onto Cloudflare DNS without losing its records.
 *
 * Each run reads the current state and does only what is missing, so it is resumable:
 * 1. Finds the registrar (`--registrar`, else the one configured account that owns the domain).
 * 2. Reads the nameservers (already on the zone: DNSSEC and the project files are left), the old
 *    DS records (the registrar's API and a public lookup; both must show none before a switch)
 *    and the current records (registrar DNS, else a BIND file or Cloudflare's scan, whose pending
 *    zone is approved on its own first).
 * 3. Builds the copy plan (records already in the zone are left out; zone records the current DNS
 *    lacks are listed, and clashing ones stop the run) and asks one typed `domain-settings`
 *    approval listing the zone, the records (and those not copied), the old DS removal and the
 *    nameserver switch. Refused: nothing changes. Every approved record must be in the zone before
 *    anything else changes.
 * 4. In order (SC-703): zone → records → old DS removal (then stops and waits for the DS TTL) →
 *    nameservers → activation check → project files. Old DS records the API cannot remove stop
 *    the run before any change.
 * 5. Later runs on a connected domain whose zone is active turn DNSSEC on after a typed approval;
 *    stale DS records there are reported with the registrar's dashboard link.
 */

/** Everything one connect run needs (and what moving the DNS needs, `SwitchContext`). */
interface ConnectContext extends SwitchContext {
  services: ResolvedDomainServices;
  registrarId: OtherRegistrarId;
  stateFile: string;
  state: ConnectState | undefined;
  /** This run's command with the options that matter on a later run (for hints). */
  command: string;
}

/** The DS records published for the domain now. */
interface DsReading {
  /** What the registrar's API lists (registrars with DNSSEC in their API). */
  api?: DsRecord[];
  /** What the public DNS shows. */
  public: DsRecord[];
  /** Both combined: before the switch, every one of them is an old DS record. */
  records: DsRecord[];
  /** The public answer's TTL: how long its copy of the records has left (seconds). */
  ttlSeconds?: number;
  /** When they were read. */
  at: Date;
}

/** The domain's current records and where they came from. */
interface RecordSource {
  records: RegistrarDnsRecord[];
  /** `Porkbun's DNS`, `the file zone.txt` …, for the approval. */
  from: string;
  /** Short form for the audit log. */
  audit: string;
  /** `at Porkbun`, `in zone.txt` …: where the current records are, for the approval. */
  where: string;
  /** The zone created (or found) for Cloudflare's scan. */
  zone?: DomainZone;
  /** True when this run created that zone after its own approval. */
  zoneCreated?: boolean;
}

const NOT_RECORDED = { plan: false, requirements: false };

function hoursText(seconds: number): string {
  return plural(Math.ceil(seconds / 3600), "hour");
}

/**
 * `opscrew domain connect <domain>`, with the options the user gave that a later run needs too
 * (`--registrar`, `--records-file`, `--account`), quoted for a POSIX shell.
 */
function commandOf(
  domain: string,
  options: Pick<ConnectDomainOptions, "registrar" | "recordsFile" | "account"> = {},
): string {
  const parts = [`opscrew domain connect ${domain}`];
  if (options.registrar !== undefined) parts.push(`--registrar ${options.registrar}`);
  if (options.recordsFile !== undefined) {
    parts.push(`--records-file ${shellWord(options.recordsFile.replaceAll("\\", "/"))}`);
  }
  if (options.account !== undefined) parts.push(`--account ${shellWord(options.account)}`);
  return parts.join(" ");
}

function nameOf(ctx: Pick<ConnectContext, "registrarId">): string {
  return REGISTRAR_NAMES[ctx.registrarId];
}

function linkOf(ctx: Pick<ConnectContext, "deps" | "registrarId">): string {
  return registrarLinks(ctx.registrarId, ctx.deps.env).domains;
}

/** Lower-case, validated domain name (ASCII; internationalized names in their `xn--` form). */
function parseConnectDomain(input: string): string {
  if ([...input.trim()].some((c) => c.charCodeAt(0) > 127)) {
    throw new OpsCrewError("INVALID_INPUT", `"${input.trim()}" has letters outside a to z.`, {
      hint: "Give the name in its ASCII form (starting with xn--), as your registrar shows it.",
    });
  }
  return parseHostName(input);
}

/**
 * Moves a domain the user already owns onto Cloudflare DNS: copies its records into a zone, then
 * switches the nameservers at the registrar (see the module comment for the steps and the order).
 */
export async function connectDomain(
  deps: PhaseDeps,
  options: ConnectDomainOptions,
): Promise<ConnectDomainResult> {
  const domain = parseConnectDomain(options.domain);
  const requested =
    options.registrar === undefined ? undefined : parseRegistrarId(options.registrar);
  if (requested === "cloudflare") {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `Domains registered at Cloudflare always use Cloudflare DNS, so there is nothing to connect for ${domain}.`,
      {
        hint: `To use ${domain} for this project, run \`opscrew domain buy ${domain}\`: for a domain already on your Cloudflare account it buys nothing and only sets it up.`,
      },
    );
  }
  // The domain's zone lives at Cloudflare.
  requireCloudflareToken(deps, `OpsCrew moves the DNS of ${domain} into a Cloudflare zone`);
  const services = resolveDomainServices(deps, options.services);
  const files = await readProjectFiles(deps);
  if (files.plan !== undefined) requireNoMoveInProgress(files.plan);
  const stateFile = connectStatePath(deps.paths);
  const state = await readConnectState(stateFile);
  if (state !== undefined && state.domain !== domain) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `OpsCrew is still connecting ${state.domain}: it waits for that domain's old DNSSEC records to expire before it switches its nameservers. It connects one domain at a time, so it did not start on ${domain}.`,
      {
        hint: `Run \`${commandOf(state.domain)}\` to finish that first. If you no longer want to connect ${state.domain}, delete ${stateFile}, and connect it later only once 48 hours have passed since its DS records were removed.`,
      },
    );
  }

  const { registrarId, registrar } = await findRegistrar(
    deps,
    services,
    domain,
    requested ?? state?.registrar,
  );
  const account = resolveAccount(await services.accounts(), options.account);
  const ctx: ConnectContext = {
    deps,
    services,
    domain,
    registrarId,
    registrar,
    account,
    zones: services.zonesFor(registrarId),
    stateFile,
    state,
    command: commandOf(domain, options),
  };
  const getNameservers = requireNameserverApi(ctx);
  const existing = await ownZone(ctx);
  const name = nameOf(ctx);
  deps.reporter.step(`Reading the nameservers and DNSSEC records of ${domain} at ${name}…`);
  const current = hosts(await getNameservers(domain));
  if (existing !== undefined && sameHosts(current, hosts(existing.nameServers ?? []))) {
    return alreadyConnected(ctx, existing);
  }
  if (
    existing === undefined &&
    current.length > 0 &&
    current.every((n) => n.endsWith(".ns.cloudflare.com"))
  ) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `The nameservers of ${domain} already point at Cloudflare (${listText(current)}), but this token sees no zone for ${domain} in the account ${account.name} (${account.id}). Nothing was changed.`,
      {
        hint: `The zone is probably in another Cloudflare account: set CLOUDFLARE_API_TOKEN to a token for that account (and pass --account), then run \`${commandOf(domain)}\` again.`,
      },
    );
  }

  // Old DS records: the registrar's API and the public DNS must both show none before a switch.
  const ds = await readDs(ctx);
  const listed = ds.api ?? [];
  if (listed.length > 0 && !canRemoveDs(ctx)) return dsMustGoFirst(ctx, ds, existing);
  if (listed.length === 0 && ds.public.length > 0) {
    // The registry still publishes them (or resolvers still cache them): after a removal (or once
    // a run saw them gone), wait; otherwise they are old DS records the API does not list, removed
    // in the dashboard.
    const removed = ctx.state !== undefined && ctx.state.dsSeen === undefined;
    return removed ? stillPublished(ctx, ds, existing) : dsMustGoFirst(ctx, ds, existing);
  }
  if (ds.records.length === 0) {
    const waiting = await waitForOldDs(ctx, existing);
    if (waiting !== undefined) return waiting;
  }
  const source = await currentRecords(ctx, options.recordsFile, current, existing);
  return copyAndSwitch(ctx, { files, existing, current, ds, source });
}

/**
 * The registrar holding the domain: the given one (`--registrar`, or the one an earlier run used;
 * its later calls fail plainly when it does not hold the domain), else the one configured account
 * that owns it, asked in parallel.
 */
async function findRegistrar(
  deps: PhaseDeps,
  services: ResolvedDomainServices,
  domain: string,
  given: OtherRegistrarId | undefined,
): Promise<{ registrarId: OtherRegistrarId; registrar: Registrar }> {
  if (given !== undefined) return { registrarId: given, registrar: services.otherRegistrar(given) };
  const ids = services
    .configuredRegistrars()
    .filter((id): id is OtherRegistrarId => id !== "cloudflare");
  const envHelp = OTHER_REGISTRAR_IDS.map(
    (id) => `${REGISTRAR_ENV[id].join(" and ")} for ${REGISTRAR_NAMES[id]}`,
  ).join(", ");
  if (ids.length === 0) {
    throw new OpsCrewError(
      "CREDENTIALS_MISSING",
      `No registrar other than Cloudflare is set up, so OpsCrew cannot find ${domain} and change its nameservers.`,
      {
        hint: `Set the API credentials of the registrar that holds ${domain} (${envHelp}), then run \`${commandOf(domain)}\` again. Domains registered at Cloudflare already use Cloudflare DNS.`,
      },
    );
  }
  const names = ids.map((id) => REGISTRAR_NAMES[id]);
  deps.reporter.step(
    `Looking for ${domain} in your ${listText(names)} account${ids.length === 1 ? "" : "s"}…`,
  );
  const answers = await Promise.all(
    ids.map(async (id) => {
      try {
        const registrar = services.otherRegistrar(id);
        if (registrar.ownsDomain === undefined) {
          return { id, registrar, owns: false, error: "its API cannot list domains" };
        }
        return { id, registrar, owns: await registrar.ownsDomain(domain) };
      } catch (error) {
        return { id, owns: false, error: errorText(deps, error) };
      }
    }),
  );
  const owners = answers.filter((a) => a.owns && a.registrar !== undefined);
  const [owner] = owners;
  if (owners.length === 1 && owner?.registrar !== undefined) {
    return { registrarId: owner.id, registrar: owner.registrar };
  }
  if (owners.length > 1) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `${domain} is in more than one of your registrar accounts (${listText(owners.map((o) => REGISTRAR_NAMES[o.id]))}), so OpsCrew does not know which one holds it.`,
      {
        hint: `Pass the registrar that holds it, for example \`${commandOf(domain)} --registrar ${owner?.id ?? "porkbun"}\`.`,
      },
    );
  }
  const failed = answers.flatMap((a) =>
    a.error === undefined ? [] : [`${REGISTRAR_NAMES[a.id]} could not be checked (${a.error})`],
  );
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    `${domain} is not in any configured registrar account: OpsCrew looked in your ${listText(names)} account${ids.length === 1 ? "" : "s"}.${failed.length === 0 ? "" : ` ${listText(failed)}.`} Nothing was changed.`,
    {
      hint: `If another account or registrar holds ${domain}, set its API credentials (${envHelp}), or pass the registrar with --registrar (porkbun, namecheap or godaddy). Then run \`${commandOf(domain)}\` again. Domains registered at Cloudflare already use Cloudflare DNS.`,
    },
  );
}

/** `getNameservers`, or a stop when the registrar's API cannot change nameservers. */
function requireNameserverApi(ctx: ConnectContext): (domain: string) => Promise<string[]> {
  const { registrar, domain } = ctx;
  const getNameservers = registrar.getNameservers?.bind(registrar);
  if (
    !registrar.capabilities.nameservers ||
    getNameservers === undefined ||
    registrar.setNameservers === undefined
  ) {
    const name = nameOf(ctx);
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `${name}'s API cannot change nameservers, so OpsCrew cannot move ${domain} to Cloudflare there. Nothing was changed.`,
      {
        hint: `Add ${domain} to Cloudflare in its dashboard (https://dash.cloudflare.com, Add a domain), check the records it finds, then set the nameservers of ${domain} at ${linkOf(ctx)}.`,
      },
    );
  }
  return getNameservers;
}

/** The domain's zone in this account, if there is one. A zone in another account stops the run. */
async function ownZone(ctx: ConnectContext): Promise<DomainZone | undefined> {
  const { zones, account, domain } = ctx;
  const zone = await zones.findZone(domain);
  if (zone?.accountId !== undefined && zone.accountId !== account.id) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `A Cloudflare zone for ${domain} already exists in another Cloudflare account (${zone.accountId}), not in ${account.name} (${account.id}). Nothing was changed.`,
      {
        hint: `Run \`${ctx.command} --account ${zone.accountId}\` to use that zone, or delete it in that account first.`,
      },
    );
  }
  return zone;
}

function canRemoveDs(ctx: ConnectContext): boolean {
  return ctx.registrar.capabilities.dnssec && ctx.registrar.removeDsRecord !== undefined;
}

/** Adds the records `extra` has and `list` lacks (same DS record: see `sameDs`). */
function unionDs(list: readonly DsRecord[], extra: readonly DsRecord[]): DsRecord[] {
  const all = [...list];
  for (const record of extra) if (!all.some((r) => sameDs(r, record))) all.push(record);
  return all;
}

/**
 * The DS records published now: what the registrar's API lists (registrars with DNSSEC in their
 * API) and what the public DNS shows, combined. A failed public lookup stops the run: OpsCrew
 * never switches nameservers on a guess.
 */
async function readDs(ctx: ConnectContext): Promise<DsReading> {
  const { registrar, domain, deps } = ctx;
  const at = deps.clock.now();
  const api =
    registrar.capabilities.dnssec && registrar.listDsRecords !== undefined
      ? await registrar.listDsRecords(domain)
      : undefined;
  const published = await lookupPublishedDs(deps.fetch, domain);
  return {
    api,
    public: published.records,
    records: unionDs(api ?? [], published.records),
    ttlSeconds: published.ttlSeconds,
    at,
  };
}

/**
 * When the old DS records are gone from the public DNS at the earliest (milliseconds): when the
 * copy the public answer showed expires, and never before `after`.
 */
function publicGoneAt(ds: DsReading, after: Date): number {
  const expires =
    ds.public.length > 0 && ds.ttlSeconds !== undefined
      ? ds.at.getTime() + ds.ttlSeconds * 1000
      : after.getTime();
  return Math.max(after.getTime(), expires);
}

/** The wait for these DS records: their TTL within 24 and 48 hours, never shorter than noted. */
function waitFor(ctx: ConnectContext, ds: DsReading): number {
  return Math.max(dsWaitSeconds(ds.ttlSeconds), ctx.state?.waitSeconds ?? 0);
}

/**
 * The switch time once the old DS records were removed through the API (or are no longer listed
 * there) at `at`: the wait after the public DNS's copy expires, plus an hour in case the registry
 * publishes them a little longer, never earlier than the note says.
 */
function switchAfterRemoval(ctx: ConnectContext, ds: DsReading, at: Date): string {
  const wait = waitFor(ctx, ds) + REMOVAL_MARGIN_SECONDS;
  return laterSwitch(ctx.state, publicGoneAt(ds, at) + wait * 1000);
}

/**
 * The note while old DS records OpsCrew did not remove are published: when they were first seen
 * and the wait that starts once a run sees them gone.
 */
function seenState(ctx: ConnectContext, zone: DomainZone | undefined, ds: DsReading): ConnectState {
  return {
    domain: ctx.domain,
    registrar: ctx.registrarId,
    zoneId: zone?.id,
    dsSeen: ctx.state?.dsSeen ?? ctx.deps.clock.now().toISOString(),
    switchAfter: ctx.state?.switchAfter,
    waitSeconds: waitFor(ctx, ds),
  };
}

function result(
  ctx: ConnectContext,
  fields: Partial<ConnectDomainResult> & Pick<ConnectDomainResult, "outcome" | "next">,
): ConnectDomainResult {
  return {
    domain: ctx.domain,
    registrar: ctx.registrarId,
    nameservers: [],
    copied: 0,
    dnssec: false,
    recorded: NOT_RECORDED,
    ...fields,
  };
}

function zoneFields(
  zone: DomainZone | undefined,
): Pick<ConnectDomainResult, "zoneId" | "nameservers"> {
  return { zoneId: zone?.id, nameservers: hosts(zone?.nameServers ?? []) };
}

/**
 * Old DS records the registrar's API cannot remove (or does not even list, while the public DNS
 * shows them): stops before any change, notes when they were seen and says how to remove them.
 */
async function dsMustGoFirst(
  ctx: ConnectContext,
  ds: DsReading,
  zone: DomainZone | undefined,
): Promise<ConnectDomainResult> {
  const { deps, domain } = ctx;
  const name = nameOf(ctx);
  const seen = seenState(ctx, zone, ds);
  await writeConnectState(ctx.stateFile, seen);
  const why =
    (ds.api ?? []).length > 0
      ? `${name}'s API cannot remove them`
      : canRemoveDs(ctx)
        ? `${name}'s API does not list them, so OpsCrew cannot remove them through it`
        : `${name}'s API cannot remove them`;
  deps.reporter.warn(
    `${domain} has DNSSEC (DS) records for its current DNS provider. Switching the nameservers while they are published would take ${domain} offline, and ${why}, so OpsCrew stopped before changing anything.`,
  );
  return result(ctx, {
    outcome: "waiting-for-ds",
    ...zoneFields(zone),
    next: [
      `Remove the DS records of ${domain} in ${name}'s dashboard (${linkOf(ctx)}): ${ds.records.map(dsRecordText).join("; ")}. This turns DNSSEC off at the current DNS provider; ${domain} keeps working without it.`,
      `Then run \`${ctx.command}\` again: it notes when the records are gone and tells you when to run it again to switch the nameservers (${hoursText(seen.waitSeconds)} later, once resolvers have forgotten them). It asks before changing anything.`,
    ],
  });
}

/**
 * After a removal, the registrar's API lists no old DS record but the public DNS still shows one
 * (the registry still publishes it, or resolvers still cache it): the switch time moves out to
 * the wait after that copy expires, and the run waits.
 */
async function stillPublished(
  ctx: ConnectContext,
  ds: DsReading,
  zone: DomainZone | undefined,
): Promise<ConnectDomainResult> {
  const { deps, domain } = ctx;
  const name = nameOf(ctx);
  const state = {
    ...(ctx.state as ConnectState),
    switchAfter: switchAfterRemoval(ctx, ds, ds.at),
    waitSeconds: waitFor(ctx, ds),
  };
  await writeConnectState(ctx.stateFile, state);
  deps.reporter.warn(
    `The public DNS still shows old DNSSEC (DS) records of ${domain} (${ds.public.map(dsRecordText).join("; ")}), so OpsCrew does not switch the nameservers yet. Nothing was changed.`,
  );
  return result(ctx, {
    outcome: "waiting-for-ds",
    ...zoneFields(zone),
    waitUntil: state.switchAfter,
    next: [
      `Run \`${ctx.command}\` again after ${formatTime(state.switchAfter)}; it switches the nameservers once neither ${name}'s API nor the public DNS shows an old DS record and resolvers have had time to forget them. If the public DNS still shows them then, remove them in ${name}'s dashboard (${linkOf(ctx)}).`,
    ],
  });
}

/**
 * Neither the registrar's API nor the public DNS shows an old DS record. When earlier runs saw or
 * removed some, the switch waits until the note's switch time (the first run that sees records
 * OpsCrew did not remove gone sets it to the noted wait from then); returns the `waiting-for-ds`
 * result until then, undefined once nothing has to wait.
 */
async function waitForOldDs(
  ctx: ConnectContext,
  zone: DomainZone | undefined,
): Promise<ConnectDomainResult | undefined> {
  const { deps, domain, state } = ctx;
  if (state === undefined) return undefined;
  const now = deps.clock.now();
  let switchAfter = state.switchAfter;
  if (state.dsSeen !== undefined || switchAfter === undefined) {
    // Gone since the last run: resolvers may hold them for the whole wait from now on.
    switchAfter = laterSwitch(state, now.getTime() + state.waitSeconds * 1000);
    await writeConnectState(ctx.stateFile, { ...state, dsSeen: undefined, switchAfter });
    deps.reporter.info(
      `The old DNSSEC (DS) records of ${domain} are gone from the registry and the public DNS.`,
    );
  }
  if (now.getTime() >= Date.parse(switchAfter)) return undefined;
  const until = formatTime(switchAfter);
  deps.reporter.warn(
    `OpsCrew waits before it switches the nameservers of ${domain}: resolvers may remember its old DNSSEC records until about ${until}, and switching earlier could take ${domain} offline for visitors whose resolver checks DNSSEC. Nothing was changed.`,
  );
  return result(ctx, {
    outcome: "waiting-for-ds",
    ...zoneFields(zone),
    waitUntil: switchAfter,
    next: [
      `Run \`${ctx.command}\` again after ${until} to switch the nameservers to Cloudflare; it shows what changes and asks first. Until then ${domain} keeps working on its current DNS.`,
    ],
  });
}

/** The domain's current records: a BIND file, the registrar's DNS or Cloudflare's scan. */
async function currentRecords(
  ctx: ConnectContext,
  recordsFile: string | undefined,
  current: readonly string[],
  zone: DomainZone | undefined,
): Promise<RecordSource> {
  const { deps, domain, registrar } = ctx;
  const name = nameOf(ctx);
  if (recordsFile !== undefined && recordsFile.trim() !== "") {
    const label = recordsFile.trim();
    const path = isAbsolute(label) ? label : resolve(deps.paths.root, label);
    deps.reporter.step(`Reading the records of ${domain} from ${label}…`);
    const records = await readBindFile(path, domain, undefined, label);
    return { records, from: `the file ${label}`, audit: "a BIND file", where: `in ${label}` };
  }
  if (registrar.capabilities.records && registrar.listRecords !== undefined) {
    deps.reporter.step(`Reading the DNS records of ${domain} at ${name}…`);
    const records = await registrar.listRecords(domain);
    if (records !== undefined) {
      return { records, from: `${name}'s DNS`, audit: `${name}'s DNS`, where: `at ${name}` };
    }
  }
  const where = `${name} does not serve the DNS records of ${domain} (its nameservers are ${listText([...current]) || "not set"})`;
  if (!deps.interactive) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `${where}, so OpsCrew cannot read them through ${name}, and without a terminal it cannot ask before it creates a zone for Cloudflare's record scan. Nothing was changed.`,
      {
        hint: `Export the records from your current DNS provider as a BIND zone file and run \`${ctx.command} --records-file <file>\`, or run the command in an interactive terminal to review Cloudflare's scan.`,
      },
    );
  }
  return scanRecords(ctx, where, zone);
}

/**
 * Cloudflare's scan of the public DNS. The scan needs the zone: creating the pending zone (nothing
 * live changes) is its own typed approval first.
 */
async function scanRecords(
  ctx: ConnectContext,
  where: string,
  zone: DomainZone | undefined,
): Promise<RecordSource> {
  const { deps, domain, account, zones } = ctx;
  if (zone === undefined) {
    const decision = await deps.approvals.request({
      kind: "domain-settings",
      title: `Create a Cloudflare zone for ${domain} to scan its current records`,
      details: [
        `${where}, so OpsCrew cannot read them through ${nameOf(ctx)}. Cloudflare can scan the public DNS for them instead.`,
        `Cloudflare zone: OpsCrew creates a zone for ${domain} in the account ${account.name} (${account.id}) and asks Cloudflare to scan the records ${domain} has now. Nothing is added to the zone yet: OpsCrew shows the records it found and asks again before it copies any.`,
        "Nothing live changes: the zone stays pending until the nameservers point at it, which is part of the next approval.",
        `The scan finds common names only. To copy exactly what your DNS provider serves, refuse and run \`${ctx.command} --records-file <file>\` with a BIND zone file exported from it.`,
      ].join("\n"),
      // Typed in a terminal; `--yes` never grants it.
      confirmPhrase: domain,
    });
    if (!decision.approved) {
      throw new OpsCrewError(
        "APPROVAL_REFUSED",
        `OpsCrew did not create a zone for ${domain}; nothing was changed.`,
        {
          hint: `Export the records from your current DNS provider as a BIND zone file and run \`${ctx.command} --records-file <file>\`, or run \`${ctx.command}\` again and type ${domain} to let Cloudflare scan them.`,
        },
      );
    }
  }
  const scanned = await afterApproval(ctx, async () => {
    const found = zone ?? (await ensureZone(ctx));
    deps.reporter.step(`Cloudflare is scanning the public DNS records of ${domain}…`);
    return { zone: found, records: await zones.scanRecords(found.id) };
  });
  return {
    records: scanned.records,
    from: "Cloudflare's scan of the public DNS (it finds common names only; check that nothing is missing)",
    audit: "Cloudflare's scan",
    where: "in the public DNS",
    zone: scanned.zone,
    zoneCreated: zone === undefined,
  };
}

/**
 * The copy plan, the one typed approval, then zone → records → (old DS, stop) → switch. Zone
 * records that clash with the current records stop the run before the approval.
 */
async function copyAndSwitch(
  ctx: ConnectContext,
  input: {
    files: ProjectFiles;
    existing: DomainZone | undefined;
    current: string[];
    ds: DsReading;
    source: RecordSource;
  },
): Promise<ConnectDomainResult> {
  const { deps, domain, zones } = ctx;
  const { source, ds } = input;
  const known = source.zone ?? input.existing;
  const inZone = known === undefined ? [] : await zones.listRecords(known.id);
  const plan = copyPlan(source.records, domain, inZone);
  if (plan.clashes.length > 0) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `The Cloudflare zone of ${domain} already has records that clash with its current DNS, so OpsCrew changed nothing: ${plan.clashes.join("; ")}.`,
      {
        hint: `Delete the clashing record in the Cloudflare dashboard (https://dash.cloudflare.com, ${domain} → DNS → Records) to keep the current one, or change the current record ${source.where} to match the zone's. Then run \`${ctx.command}\` again.`,
      },
    );
  }
  const removeDs = (ds.api ?? []).length > 0;
  const decision = await deps.approvals.request({
    kind: "domain-settings",
    title: removeDs
      ? `Copy the DNS records of ${domain} to Cloudflare and remove its old DNSSEC records`
      : `Move the DNS of ${domain} to Cloudflare`,
    details: approvalDetails(ctx, { ...input, zone: known, plan, removeDs }),
    // Typed in a terminal, `--confirm <domain>` in scripts; `--yes` never grants it.
    confirmPhrase: domain,
  });
  if (!decision.approved) {
    throw new OpsCrewError(
      "APPROVAL_REFUSED",
      source.zoneCreated === true
        ? `${domain} was not moved to Cloudflare. OpsCrew only created the pending zone for the scan, which nothing live uses.`
        : `${domain} was not moved to Cloudflare; OpsCrew changed nothing.`,
      { hint: refusedHint(ctx, decision.reason, "move it") },
    );
  }
  return afterApproval(ctx, () => applyConnect(ctx, { source, ds, plan, removeDs }));
}

/** What to do after a refused typed approval (mistyped, or no terminal and no `--confirm`). */
function refusedHint(ctx: ConnectContext, reason: string | undefined, what: string): string {
  const { deps, domain } = ctx;
  if (reason === "confirmation phrase did not match") {
    return `To ${what}, run \`${ctx.command}\` again and type ${domain} exactly when asked.`;
  }
  return deps.interactive
    ? `Run \`${ctx.command}\` again when you want to ${what}.`
    : `To ${what} without a terminal, run \`${ctx.command} --confirm ${domain}\`; or run it in an interactive terminal.`;
}

/**
 * Runs the changes after an approval. A failure says that the next run continues where this one
 * stopped (every step checks what is done first).
 */
async function afterApproval<T>(
  ctx: ConnectContext,
  apply: () => Promise<T>,
  what = `moving ${ctx.domain} to Cloudflare`,
): Promise<T> {
  try {
    return await apply();
  } catch (error) {
    throw unfinished(
      ctx.deps,
      error,
      `OpsCrew could not finish ${what}`,
      `\`${ctx.command}\` again: it checks what is done and continues from there.`,
    );
  }
}

/**
 * Creates the approved records and confirms that the zone has every one of them (the batch
 * answer counts them; when the count differs, the zone is listed again). Returns how many were
 * created; stops before anything else changes when one is missing.
 */
async function copyRecords(
  ctx: ConnectContext,
  zone: DomainZone,
  plan: CopyPlan,
  source: RecordSource,
): Promise<number> {
  const { deps, domain, zones } = ctx;
  if (plan.create.length === 0) return 0;
  deps.reporter.step(
    `Copying ${plural(plan.create.length, "record")} into the Cloudflare zone of ${domain}…`,
  );
  const copied = await zones.createRecords(zone.id, plan.create);
  const types = [...new Set(plan.create.map((r) => r.type))].join(", ");
  await auditDomain(
    deps,
    "copy DNS records",
    domain,
    `${plural(copied, "record")} (${types}) from ${source.audit} into zone ${zone.id}`,
  );
  if (copied === plan.create.length) return copied;
  const missing = missingFromZone(plan.create, await zones.listRecords(zone.id));
  if (missing.length > 0) {
    throw new OpsCrewError(
      "PROVIDER_ERROR",
      `Cloudflare confirmed ${copied} of the ${plural(plan.create.length, "record")}, and the zone lacks ${missing.map(recordText).join(", ")}, so OpsCrew changed nothing else (the nameservers still point at the current DNS)`,
      { hint: "Check the zone in the Cloudflare dashboard (https://dash.cloudflare.com)." },
    );
  }
  return plan.create.length;
}

/** The approved changes, in order: zone → records → (old DS removal, stop) → switch → files. */
async function applyConnect(
  ctx: ConnectContext,
  input: { source: RecordSource; ds: DsReading; plan: CopyPlan; removeDs: boolean },
): Promise<ConnectDomainResult> {
  const { deps, domain } = ctx;
  const { source, ds, plan, removeDs } = input;
  const zone =
    source.zoneCreated === true && source.zone !== undefined ? source.zone : await ensureZone(ctx);
  const copied = await copyRecords(ctx, zone, plan, source);
  if (removeDs) return removeOldDs(ctx, { zone, ds, copied });

  const switched = await pointToZone(ctx, zone);
  const activation = await requestActivation(ctx, zone);
  if (ctx.state !== undefined) await removeConnectState(ctx.stateFile);
  const files = await readProjectFiles(deps);
  const project = await recordProject(ctx, files, false);
  const name = nameOf(ctx);
  await auditDomain(
    deps,
    "connect domain",
    domain,
    `${name}: zone ${zone.id}; ${plural(copied, "record")} copied; nameservers ${switched.outcome}; activation check ${activation.requested ? "requested" : "not requested"}`,
  );
  // No success line here: the result (outcome, records copied, nameservers) is the summary the
  // CLI prints, so the user reads it once.
  const next: string[] = [];
  if (!activation.skipped) {
    next.push(
      `Cloudflare activates the zone for ${domain} once the registry publishes the new nameservers, usually within an hour and sometimes up to 48 hours; it re-checks the nameservers on its own. Until then some visitors still reach the old DNS, which serves the same records.`,
    );
  }
  if (plan.skipped.length > 0) {
    next.push(
      `Recreate in Cloudflare what OpsCrew did not copy, if you still need it: ${plan.skipped.map((s) => s.reason).join(" ")}`,
    );
  }
  if (plan.proxied.length > 0) {
    next.push(
      `Cloudflare proxies ${plan.proxied.map(zoneRecordText).join(", ")}: only web traffic reaches these names. Turn proxying off for them in Cloudflare if mail, SSH or other services use them.`,
    );
  }
  // A zone that is never activated (stand-in zones) never gets DNSSEC either.
  if (!activation.skipped) next.push(dnssecLater(ctx));
  next.push(projectStep(ctx, files, project));
  return result(ctx, {
    outcome: "connected",
    zoneId: zone.id,
    nameservers: switched.nameservers,
    copied,
    recorded: project.recorded,
    next,
  });
}

/** The approval text of the copy and switch. */
function approvalDetails(
  ctx: ConnectContext,
  input: {
    files: ProjectFiles;
    zone: DomainZone | undefined;
    current: string[];
    ds: DsReading;
    source: RecordSource;
    plan: CopyPlan;
    removeDs: boolean;
  },
): string {
  const { deps, domain, account } = ctx;
  const { zone, current, ds, source, plan, removeDs } = input;
  const name = nameOf(ctx);
  const lines = [
    `Domain: ${domain} (registered at ${name})`,
    `Cloudflare account: ${account.name} (${account.id})`,
    source.zoneCreated === true && zone !== undefined
      ? `Cloudflare zone: ${zone.id}, created for the scan (pending; nothing live uses it until the nameservers point at it).`
      : zone !== undefined
        ? `Cloudflare zone: ${zone.id}, already in this account (${zone.status ?? "pending"}); OpsCrew uses it.`
        : `Cloudflare zone: OpsCrew creates one for ${domain} in this account. It stays pending, and nothing live uses it, until the nameservers point at it.`,
    `Current records: ${plural(source.records.length, "record")} read from ${source.from}.`,
  ];
  const create = createLines(plan, source.records, domain);
  if (create.length > 0) {
    lines.push(
      `Records OpsCrew creates in the zone (${create.length}):`,
      ...create.map((l) => `  ${l}`),
    );
  } else {
    lines.push("Records OpsCrew creates in the zone: none.");
  }
  if (plan.present > 0) {
    lines.push(`Already in the zone, not created again: ${plural(plan.present, "record")}.`);
  }
  if (plan.extra.length > 0) {
    lines.push(
      `Already in the Cloudflare zone, not ${source.where}; these are also served after the switch (${plan.extra.length}):`,
      ...plan.extra.map((r) => `  ${zoneRecordText(r)}${r.proxied === true ? " (proxied)" : ""}`),
    );
  }
  if (plan.proxied.length > 0) {
    lines.push(
      `Proxied by Cloudflare (${plan.proxied.length}); only web traffic reaches these names; mail, SSH and other services through them stop working until proxying is turned off in Cloudflare:`,
      ...plan.proxied.map((r) => `  ${zoneRecordText(r)}`),
    );
  }
  if (create.length === 0 && plan.present === 0 && plan.extra.length === 0) {
    lines.push(
      `No records to copy were found, so after the switch ${domain} has no DNS records at Cloudflare (no website, no email) until you add them.`,
    );
  }
  const managed = managedText(plan, domain);
  if (managed !== undefined) {
    lines.push(`Not copied because Cloudflare manages its own: ${managed}.`);
  }
  if (plan.skipped.length > 0) {
    lines.push(
      `Not copied (${plan.skipped.length}); these stop working when the nameservers switch unless you recreate them:`,
      ...plan.skipped.map((s) => `  - ${s.reason}`),
    );
  }
  const zoneNs = hosts(zone?.nameServers ?? []);
  const to = zoneNs.length > 0 ? listText(zoneNs) : "the zone's Cloudflare nameservers";
  if (removeDs) {
    const listed = ds.api ?? [];
    const switchAfter = switchAfterRemoval(ctx, ds, deps.clock.now());
    lines.push(
      `Old DNSSEC (DS) records at ${name} (${listed.length}), removed through ${name}'s API in this run:`,
      ...listed.map((record) => `  - ${dsRecordText(record)}`),
      `Switching nameservers while resolvers still remember these records would take ${domain} offline, so this run removes them and does not switch the nameservers. Removing them turns DNSSEC off at the current DNS provider; ${domain} keeps working without it.`,
      `Nameservers at ${name}: not changed in this run. Run \`${ctx.command}\` again after ${formatTime(switchAfter)} (at least ${hoursText(waitFor(ctx, ds))} after the public DNS stops showing the old records, plus an hour in case the registry publishes them a little longer) to switch them from ${listText(current) || "none"} to ${to}; it checks that neither ${name}'s API nor the public DNS shows them and asks again first.`,
    );
    return lines.join("\n");
  }
  lines.push(
    `Nameservers at ${name}: ${listText(current) || "none"} → ${zoneNs.length > 0 ? to : `${to} (Cloudflare assigns them when it creates the zone)`}.`,
  );
  if (current.length > 0 && current.every((n) => n.endsWith(".ns.cloudflare.com"))) {
    lines.push(
      `${domain} uses other Cloudflare nameservers today (probably a zone in another Cloudflare account); after the switch, that zone no longer serves ${domain}.`,
    );
  }
  lines.push(
    "Then OpsCrew asks Cloudflare to check the nameservers. The switch reaches most resolvers within an hour or two and all of them within 48 hours; meanwhile some visitors still reach the old DNS, which keeps serving the same records.",
    `DNSSEC: turned on in a later run, once Cloudflare has activated the zone (run \`${ctx.command}\` again then).`,
    ...projectLines(input.files, domain, "switch"),
  );
  return lines.join("\n");
}

/**
 * After the approval: removes the old DS records the registrar's API lists, notes the switch time
 * (the wait after the public DNS's copy expires), and stops before the switch. A note is written
 * before the first removal, so an interrupted run still waits.
 */
async function removeOldDs(
  ctx: ConnectContext,
  input: { zone: DomainZone; ds: DsReading; copied: number },
): Promise<ConnectDomainResult> {
  const { deps, domain } = ctx;
  const { zone, ds, copied } = input;
  const name = nameOf(ctx);
  const seen = seenState(ctx, zone, ds);
  await writeConnectState(ctx.stateFile, seen);
  await removeDsRecords(ctx, ds.api ?? [], `before switching to zone ${zone.id}`);
  const switchAfter = laterSwitch(seen, Date.parse(switchAfterRemoval(ctx, ds, deps.clock.now())));
  const removed: ConnectState = {
    domain,
    registrar: ctx.registrarId,
    zoneId: zone.id,
    switchAfter,
    waitSeconds: seen.waitSeconds,
  };
  await writeConnectState(ctx.stateFile, removed);
  const until = formatTime(switchAfter);
  deps.reporter.success(
    `OpsCrew copied ${plural(copied, "record")} into the Cloudflare zone of ${domain} and removed its old DNSSEC records at ${name}.`,
  );
  deps.reporter.warn(
    `The nameservers of ${domain} are not switched yet: resolvers may remember the old DNSSEC records until about ${until}, and switching earlier could take ${domain} offline.`,
  );
  return result(ctx, {
    outcome: "waiting-for-ds",
    ...zoneFields(zone),
    copied,
    waitUntil: switchAfter,
    next: [
      `Run \`${ctx.command}\` again after ${until} to switch the nameservers to Cloudflare; it checks that the old DNSSEC records are gone, shows what changes and asks first. Until then ${domain} keeps working on its current DNS, without DNSSEC.`,
    ],
  });
}

/** The next step about DNSSEC once the zone is active. */
function dnssecLater(ctx: ConnectContext): string {
  const { registrar } = ctx;
  const name = nameOf(ctx);
  const how =
    registrar.capabilities.dnssec && registrar.addDsRecord !== undefined
      ? `OpsCrew then adds the zone's DS record at ${name}`
      : `OpsCrew then turns DNSSEC on and shows the DS record to add at ${linkOf(ctx)} (${name}'s API cannot publish it)`;
  return `Once Cloudflare shows the zone as active, run \`${ctx.command}\` again to turn DNSSEC on: ${how}. It asks first.`;
}

/**
 * The nameservers already point at the zone: nothing to copy or switch. Requests the activation
 * check while the zone is pending; checks the published DS records against the zone's (stale ones
 * break DNSSEC and are reported); once the zone is active, turns DNSSEC on (typed approval);
 * records the project files.
 */
async function alreadyConnected(
  ctx: ConnectContext,
  zone: DomainZone,
): Promise<ConnectDomainResult> {
  const { deps, domain } = ctx;
  const name = nameOf(ctx);
  deps.reporter.info(
    `The nameservers of ${domain} at ${name} already point at its Cloudflare zone, so there is nothing to copy or switch.`,
  );
  if (ctx.state !== undefined) await removeConnectState(ctx.stateFile);
  const next: string[] = [];
  const active = zone.status === "active";
  if (!active && !(await requestActivation(ctx, zone)).skipped) {
    next.push(
      `Cloudflare activates the zone for ${domain} once the registry publishes its nameservers, usually within an hour and sometimes up to 48 hours; it re-checks them on its own.`,
      dnssecLater(ctx),
    );
  }
  const step = await dnssecStep(ctx, zone, active);
  next.push(...step.next);
  const files = await readProjectFiles(deps);
  const project = await recordProject(ctx, files, step.published);
  next.push(projectStep(ctx, files, project));
  return result(ctx, {
    outcome: step.changed ? "dnssec-published" : "already-connected",
    ...zoneFields(zone),
    dnssec: project.dnssec,
    recorded: project.recorded,
    next,
  });
}

/** What the DNSSEC step did. */
interface DnssecStep {
  /** True when this run turned DNSSEC on (and published the DS record or showed it). */
  changed: boolean;
  /** Whether the zone's DS record is published at the registry; undefined when unknown. */
  published?: boolean;
  next: string[];
}

/** DNSSEC of a zone the domain points at, and the DS records the registry publishes for it. */
interface DnssecState {
  on: boolean;
  zoneDs?: ZoneDsRecord;
  /** The API's and the public DNS's DS records combined; undefined when neither could be read. */
  published?: DsRecord[];
  /** Published DS records that do not match the zone's: they break validating resolvers. */
  stale: DsRecord[];
  /** What could not be checked, in plain English (also reported as warnings). */
  warnings: string[];
}

/**
 * The zone's DNSSEC and the published DS records (registrar API and public DNS). With DNSSEC off
 * for the zone, every published DS record is stale; with DNSSEC on but the zone's DS record
 * unreadable, none is called stale and a warning says it could not be checked. Undefined when
 * the zone calls set no DNSSEC up (stand-in zones).
 */
async function dnssecState(
  ctx: ConnectContext,
  zone: DomainZone,
): Promise<DnssecState | undefined> {
  const { deps, domain, zones, registrar } = ctx;
  const on = await zones.dnssecEnabled(zone.id);
  if (on === "skipped") return undefined;
  const zoneDs = on ? await zones.dsRecord(zone.id) : undefined;
  const warnings: string[] = [];
  const unread = (where: string, error: unknown) =>
    warnings.push(
      `OpsCrew could not read the DNSSEC (DS) records of ${domain} ${where} (${errorText(deps, error)}), so it did not check them against the Cloudflare zone; run \`${ctx.command}\` again later.`,
    );
  let api: DsRecord[] | undefined;
  if (registrar.capabilities.dnssec && registrar.listDsRecords !== undefined) {
    try {
      api = await registrar.listDsRecords(domain);
    } catch (error) {
      unread(`through ${nameOf(ctx)}'s API`, error);
    }
  }
  let shown: DsRecord[] | undefined;
  try {
    shown = (await lookupPublishedDs(deps.fetch, domain)).records;
  } catch (error) {
    unread("in the public DNS", error);
  }
  const published =
    api === undefined && shown === undefined ? undefined : unionDs(api ?? [], shown ?? []);
  let stale: DsRecord[] = [];
  if (published !== undefined && published.length > 0) {
    if (!on) {
      stale = published;
    } else if (zoneDs === undefined) {
      warnings.push(
        `DNSSEC is on for the Cloudflare zone of ${domain}, but Cloudflare did not return its DS record, so OpsCrew could not check the DS records published for ${domain} (${published.map(dsRecordText).join("; ")}) against it; run \`${ctx.command}\` again later.`,
      );
    } else {
      stale = published.filter((r) => !sameDs(r, zoneDs));
    }
  }
  for (const warning of warnings) deps.reporter.warn(warning);
  return { on, zoneDs, published, stale, warnings };
}

/**
 * DNSSEC for a domain that points at the zone. Stale DS records (not the zone's) are reported
 * with the registrar's dashboard link. For an active zone: nothing when the zone's DS record is
 * published; the DS values to add by hand when DNSSEC is on and the API cannot publish them;
 * otherwise, after a typed approval, `publishDs` (turns DNSSEC on, adds the DS record or shows
 * it).
 */
async function dnssecStep(
  ctx: ConnectContext,
  zone: DomainZone,
  active: boolean,
): Promise<DnssecStep> {
  const { deps, domain, registrar } = ctx;
  const name = nameOf(ctx);
  const link = linkOf(ctx);
  const state = await dnssecState(ctx, zone);
  if (state === undefined) return { changed: false, next: [] };
  const { on, zoneDs, published, stale, warnings } = state;
  const zonePublished =
    published === undefined
      ? undefined
      : zoneDs !== undefined && published.some((r) => sameDs(r, zoneDs));
  const api = registrar.capabilities.dnssec && registrar.addDsRecord !== undefined;
  const next: string[] = [...warnings];
  if (stale.length > 0) {
    const warning = `${domain} has DNSSEC (DS) records at ${name} that do not match its Cloudflare zone: ${stale.map(dsRecordText).join("; ")}. Until they are removed in ${name}'s dashboard (${link}), ${domain} may fail to resolve for visitors whose resolver checks DNSSEC.`;
    deps.reporter.warn(warning);
    next.push(warning);
  }
  const unchanged = { changed: false, published: zonePublished, next };
  if (!active || zonePublished === true) return unchanged;
  if (on && zoneDs === undefined) {
    next.push(
      `Cloudflare has not produced the DS record of ${domain} yet; run \`${ctx.command}\` again in a few minutes.`,
    );
    return unchanged;
  }
  if (on && !api) {
    // Nothing to change at Cloudflare; the registry gets the DS record by hand.
    next.push(
      `Add this DS record for ${domain} at ${link} to turn DNSSEC on: ${dsRecordText(zoneDs as ZoneDsRecord)}. Then run \`${ctx.command}\` again to record it in the plan.`,
    );
    return unchanged;
  }

  const decision = await deps.approvals.request({
    kind: "domain-settings",
    title: `Turn on DNSSEC for ${domain}`,
    details: [
      `Domain: ${domain} (registered at ${name}; its DNS is served by the active Cloudflare zone ${zone.id})`,
      on
        ? "Cloudflare zone: DNSSEC is on already."
        : `Cloudflare zone: OpsCrew turns DNSSEC on, so Cloudflare signs the records of ${domain}.`,
      api
        ? `${name}: OpsCrew adds the zone's DS record at the registry through ${name}'s API, so resolvers check the signatures.`
        : `${name}'s API cannot publish DS records, so OpsCrew shows the zone's DS record to add at ${link}; DNSSEC is in force once you add it.`,
      `Should the zone ever be deleted or moved while the DS record stays at ${name}, resolvers that check DNSSEC cannot resolve ${domain} until the DS record is removed there.`,
    ].join("\n"),
    // Typed in a terminal, `--confirm <domain>` in scripts; `--yes` never grants it.
    confirmPhrase: domain,
  });
  if (!decision.approved) {
    next.push(`DNSSEC stays off for ${domain}. ${refusedHint(ctx, decision.reason, "turn it on")}`);
    return unchanged;
  }

  const ds = await afterApproval(ctx, () => publishDs(ctx, zone), `updating DNSSEC for ${domain}`);
  switch (ds.outcome) {
    case "added":
    case "already":
      deps.reporter.success(`DNSSEC is on for ${domain}: its DS record is published at ${name}.`);
      return { changed: true, published: true, next };
    case "manual":
      if (ds.ds !== undefined) {
        next.push(
          `Add this DS record for ${domain} at ${link} to turn DNSSEC on: ${dsRecordText(ds.ds)}. Then run \`${ctx.command}\` again to record it in the plan.`,
        );
      }
      return { changed: true, published: false, next };
    case "pending":
      next.push(
        `Run \`${ctx.command}\` again in a few minutes to publish the DS record of ${domain}.`,
      );
      return { changed: true, published: false, next };
    default:
      // `skipped` or `later`: nothing was published.
      return unchanged;
  }
}

/** Removes DS records through the registrar's API (one call per key tag), each audited. */
async function removeDsRecords(
  ctx: ConnectContext,
  records: readonly DsRecord[],
  why: string,
): Promise<void> {
  const { deps, domain, registrar } = ctx;
  const remove = registrar.removeDsRecord?.bind(registrar);
  if (records.length === 0 || remove === undefined) return;
  deps.reporter.step(`Removing DNSSEC (DS) records of ${domain} at ${nameOf(ctx)}…`);
  for (const keyTag of new Set(records.map((ds) => ds.keyTag))) {
    await remove(domain, keyTag);
    const removed = records
      .filter((ds) => ds.keyTag === keyTag)
      .map((ds) => `algorithm ${ds.algorithm}, digest type ${ds.digestType}`)
      .join("; ");
    await auditDomain(
      deps,
      "remove DS record",
      domain,
      `${nameOf(ctx)}: key tag ${keyTag} (${removed}), ${why}`,
    );
  }
}

/** What recording the domain in the project files did. */
interface ProjectRecord {
  recorded: { plan: boolean; requirements: boolean };
  hostname: string;
  /** DNSSEC as the plan records it. */
  dnssec: boolean;
  /** The other domain the project keeps (the user refused to replace it). */
  keptDomain?: string;
}

/** The registration details for the plan; plain fallbacks when the registrar does not give them. */
async function registrationInfo(ctx: ConnectContext): Promise<RegisteredDomain> {
  const { deps, domain, registrar, registrarId } = ctx;
  let info: RegisteredDomain | undefined;
  let why = "it did not return them";
  try {
    info = await registrar.getDomain(domain);
  } catch (error) {
    why = errorText(deps, error);
  }
  if (info !== undefined) return { ...info, registrar: registrarId };
  deps.reporter.warn(
    `OpsCrew could not read the registration details of ${domain} from ${nameOf(ctx)} (${why}), so the plan records auto-renew and WHOIS privacy as off; check them at ${linkOf(ctx)}.`,
  );
  return { domain, registrar: registrarId, autoRenew: false, privacy: false };
}

/** True when the plan already records exactly this registration (nothing to write). */
function planUpToDate(
  plan: DeployPlan,
  ctx: ConnectContext,
  hostname: string,
  info: RegisteredDomain,
  dnssec: boolean,
): boolean {
  const { dns } = plan;
  const reg = dns.registration;
  return (
    dns.provider === "cloudflare" &&
    dns.domain === hostname &&
    dns.zone === ctx.domain &&
    reg !== undefined &&
    reg.registrar === ctx.registrarId &&
    reg.dnssec === dnssec &&
    reg.autoRenew === info.autoRenew &&
    reg.privacy === (info.privacy ?? true) &&
    reg.expiresAt === toIsoDateTime(info.expiresAt) &&
    reg.registeredAt === toIsoDateTime(info.createdAt)
  );
}

/**
 * Records the domain in `opscrew/plan.yaml` (`dns.zone`, `dns.registration` with the registrar)
 * and `opscrew/requirements.yaml`, as buying does; files that already record it are left alone.
 * Another domain in the project is only replaced after a `repo-write` approval (refused: kept).
 */
async function recordProject(
  ctx: ConnectContext,
  files: ProjectFiles,
  published: boolean | undefined,
): Promise<ProjectRecord> {
  const { deps, domain } = ctx;
  const changes = projectChanges(files, domain);
  const { hostname } = changes;
  const dnssec = published ?? files.plan?.dns.registration?.dnssec ?? false;
  if (files.plan === undefined && files.requirements === undefined) {
    return { recorded: NOT_RECORDED, hostname, dnssec };
  }
  const info = await registrationInfo(ctx);
  const plan =
    files.plan !== undefined && !planUpToDate(files.plan, ctx, hostname, info, dnssec)
      ? files.plan
      : undefined;
  const requirements =
    files.requirements !== undefined &&
    !(files.requirements.domain === hostname && files.requirements.dnsProvider === "cloudflare")
      ? files.requirements
      : undefined;
  const already = {
    plan: files.plan !== undefined && plan === undefined,
    requirements: files.requirements !== undefined && requirements === undefined,
  };
  if (plan === undefined && requirements === undefined) {
    return { recorded: already, hostname, dnssec };
  }
  if (
    changes.replaces !== undefined &&
    !(await approveDomainSwitch(deps, files, domain, changes, {
      done: `${domain} now uses Cloudflare DNS`,
      stays: "stays on Cloudflare",
    }))
  ) {
    return { recorded: NOT_RECORDED, hostname, dnssec, keptDomain: changes.replaces };
  }
  const written = await recordDomain(
    deps,
    { plan, requirements },
    { domain, hostname, info, dnssec },
  );
  return {
    recorded: {
      plan: written.plan || already.plan,
      requirements: written.requirements || already.requirements,
    },
    hostname,
    dnssec,
  };
}

/** The project's next step after connecting (and a warning when another domain was kept). */
function projectStep(ctx: ConnectContext, files: ProjectFiles, project: ProjectRecord): string {
  return nextProjectStep(ctx.deps, files, {
    domain: ctx.domain,
    hostname: project.hostname,
    keptDomain: project.keptDomain,
    stays: "stays on Cloudflare DNS",
  });
}
