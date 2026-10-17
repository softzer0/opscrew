import { zoneCandidates } from "@opscrew/connector-cloudflare";
import type {
  ApprovalRequest,
  Money,
  RegisteredDomain,
  Registrar,
  RegistrarId,
} from "@opscrew/contracts";
import { errorMessage, OpsCrewError } from "@opscrew/core";
import type { DeployPlan } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import {
  auditDomain,
  formatDate,
  formatMoney,
  requireCloudflareToken,
  resolveAccount,
} from "./common";
import { buyCommandOf } from "./links";
import {
  type ProjectFiles,
  readProjectFiles,
  recordRegistration,
  registeredName,
  registrationMissing,
  syncPlanRegistration,
} from "./project";
import { purchaseRecordPath, readPurchaseRecord } from "./record";
import {
  type OtherRegistrarId,
  parseRegistrarId,
  REGISTRAR_NAMES,
  registrarLinks,
} from "./registrars";
import { type ResolvedDomainServices, resolveDomainServices } from "./services";
import { dsRecordText } from "./switch";
import type { DomainStatusOptions, DomainStatusResult, SetAutoRenewOptions } from "./types";

/**
 * The yearly renewal price the registrar quotes for the domain's extension, when the live check
 * returns one (a registered domain may come back without prices). Never throws.
 */
export async function renewalPrice(
  registrar: Registrar,
  domain: string,
): Promise<Money | undefined> {
  try {
    const checks = await registrar.check([domain]);
    return checks.find((c) => c.domain.trim().toLowerCase() === domain)?.renewal;
  } catch {
    return undefined;
  }
}

/**
 * The `domain-settings` approval for turning auto-renew on or off (the domain typed to approve),
 * naming the registrar that charges the renewal (default Cloudflare).
 */
export function autoRenewApproval(
  domain: string,
  info: RegisteredDomain,
  on: boolean,
  renewal: Money | undefined,
  registrarId: RegistrarId = "cloudflare",
): ApprovalRequest {
  const name = REGISTRAR_NAMES[registrarId];
  const cloudflare = registrarId === "cloudflare";
  const expires = formatDate(info.expiresAt);
  const price =
    renewal === undefined
      ? `the renewal price ${name} shows for the domain in its dashboard`
      : `${formatMoney(renewal)} per year`;
  const details = on
    ? [
        `Auto-renew: off → on`,
        `Expires: ${expires}`,
        cloudflare
          ? `Next renewal: up to 30 days before ${expires}, Cloudflare charges ${price} to your account's default payment method.`
          : `Next renewal: before ${expires}, ${name} charges ${price} to your ${name} account (its balance or payment method).`,
        "Renewals cannot be refunded; turn auto-renew off again before then to stop it.",
      ]
    : [
        `Auto-renew: on → off`,
        `Expires: ${expires}`,
        `Renewal price: ${price}`,
        `Nothing renews ${domain} automatically any more: it stops working on ${expires} unless you renew it in the ${name} dashboard or turn auto-renew on again, and an expired domain can be lost.`,
      ];
  return {
    kind: "domain-settings",
    title: `Turn auto-renew ${on ? "on" : "off"} for ${domain}`,
    details: details.join("\n"),
    // Auto-renew means future charges: typed in a terminal, `--confirm <domain>` in scripts,
    // never granted by `--yes`.
    confirmPhrase: domain,
  };
}

/** Audits an auto-renew change, naming the registrar unless it is Cloudflare. */
export async function auditAutoRenew(
  deps: PhaseDeps,
  registrarId: RegistrarId,
  domain: string,
  on: boolean,
): Promise<void> {
  const what = `auto-renew ${on ? "on" : "off"}`;
  await auditDomain(
    deps,
    "set auto-renew",
    domain,
    registrarId === "cloudflare" ? what : `${REGISTRAR_NAMES[registrarId]}: ${what}`,
  );
}

interface Target {
  name: string;
  services: ResolvedDomainServices;
  registrar: Registrar;
}

/** Token, services, account and registrar for the project's domain. */
async function connect(
  deps: PhaseDeps,
  name: string,
  options: { account?: string; services?: DomainStatusOptions["services"] },
): Promise<Target> {
  requireCloudflareToken(deps);
  const services = resolveDomainServices(deps, options.services);
  const account = resolveAccount(await services.accounts(), options.account);
  return { name, services, registrar: services.registrar(account.id) };
}

/**
 * The registration on the account that holds the project's domain: the plan's zone when it names
 * one, else the domain itself or the nearest parent registered there (`app.shopapp.com` →
 * `shopapp.com`). Errors on the first name stop the run; a parent that cannot be read is skipped.
 */
async function findRegistration(
  registrar: Registrar,
  files: ProjectFiles,
  name: string,
): Promise<RegisteredDomain | undefined> {
  const names = files.plan?.dns.zone !== undefined ? [name] : zoneCandidates(name);
  for (const [index, candidate] of names.entries()) {
    try {
      const info = await registrar.getDomain(candidate);
      if (info !== undefined) return { ...info, domain: info.domain.trim().toLowerCase() };
    } catch (error) {
      if (index === 0) throw error;
    }
  }
  return undefined;
}

/**
 * Fills a missing `plan.dns.registration` for a domain registered on the account (bought before
 * the plan existed) after a `repo-write` approval. Returns next steps when it was not recorded.
 */
async function fillPlanRegistration(
  deps: PhaseDeps,
  plan: DeployPlan | undefined,
  info: RegisteredDomain,
  dnssec: boolean | undefined,
): Promise<string[]> {
  const registered = info.domain;
  if (plan === undefined || !registrationMissing(plan, registered)) return [];
  const zone = plan.dns.zone === undefined ? `, and dns.zone becomes ${registered}` : "";
  const decision = await deps.approvals.request({
    kind: "repo-write",
    title: `Record the registration of ${registered} in opscrew/plan.yaml`,
    details: [
      `${registered} is registered with Cloudflare Registrar on this account, but opscrew/plan.yaml does not record it (for example because it was bought before the plan existed).`,
      `opscrew/plan.yaml: dns.registration records the registrar, the registration and expiry dates, auto-renew (${info.autoRenew ? "on" : "off"}), WHOIS privacy and DNSSEC (${dnssec === true ? "on" : "off"})${zone}.`,
      "Nothing changes on Cloudflare.",
    ].join("\n"),
  });
  if (!decision.approved) {
    return [
      `opscrew/plan.yaml does not record the registration of ${registered} yet. Run \`opscrew domain status\` in a terminal and approve recording it.`,
    ];
  }
  await recordRegistration(deps, plan, { domain: registered, info, dnssec: dnssec === true });
  deps.reporter.info(`OpsCrew recorded the registration of ${registered} in opscrew/plan.yaml.`);
  return [];
}

/** Whether DNSSEC is on for the zone of `name` (off without a zone; see `dnssecEnabled`). */
async function zoneDnssec(
  services: ResolvedDomainServices,
  name: string,
): Promise<boolean | "skipped"> {
  const zone = await services.zones.findZone(name);
  return zone === undefined ? false : services.zones.dnssecEnabled(zone.id);
}

function renewalNote(info: RegisteredDomain): string {
  const expires = formatDate(info.expiresAt);
  return info.autoRenew
    ? `${info.domain} renews automatically up to 30 days before ${expires}. Turn that off with \`opscrew domain auto-renew off\`.`
    : `Auto-renew is off: ${info.domain} stops working on ${expires} unless you renew it. Turn it on with \`opscrew domain auto-renew on\`.`;
}

/** The registrar holding the project's domain: the option, else the plan's, else Cloudflare. */
function projectRegistrar(files: ProjectFiles, requested: RegistrarId | undefined): RegistrarId {
  if (requested !== undefined) return parseRegistrarId(requested);
  return files.plan?.dns.registration?.registrar ?? "cloudflare";
}

/**
 * `opscrew domain status`: registrar, expiry, auto-renew, lock, privacy and DNSSEC of the
 * project's domain, read live from the registrar that holds it (the plan's `dns.registration`
 * registrar, Cloudflare by default; DNSSEC from the zone when the zone calls can tell, else from
 * the plan). Without a domain in the project it says so; it also reports an unfinished purchase.
 * When the plan serves the app at a domain registered on the Cloudflare account (or a name inside
 * it) but records no `dns.registration` (bought before the plan existed), it fills it in after a
 * `repo-write` approval. For other registrars it says where to change what their API cannot.
 */
export async function domainStatus(
  deps: PhaseDeps,
  options: DomainStatusOptions = {},
): Promise<DomainStatusResult> {
  const files = await readProjectFiles(deps);
  const record = await readPurchaseRecord(purchaseRecordPath(deps.paths)).catch(
    (error: unknown) => {
      deps.reporter.warn(errorMessage(error));
      return undefined;
    },
  );
  const pendingPurchase =
    record === undefined ? undefined : { domain: record.domain, requestedAt: record.requestedAt };
  const finishPending =
    record === undefined
      ? []
      : [
          `A purchase of ${record.domain} started on ${formatDate(record.requestedAt, record.requestedAt)} has not finished. Run \`${buyCommandOf(record.domain, record.registrar)}\` to finish it.`,
        ];
  const name = registeredName(files);
  if (name === undefined) {
    return {
      pendingPurchase,
      next: [
        ...finishPending,
        "This project has no domain yet. Find one with `opscrew domain search <name>`, or use one you own with `opscrew dns --domain <domain>`.",
      ],
    };
  }

  const registrarId = projectRegistrar(files, options.registrar);
  if (registrarId !== "cloudflare") {
    return statusElsewhere(deps, files, {
      name,
      registrarId,
      options,
      pendingPurchase,
      finishPending,
    });
  }

  const target = await connect(deps, name, options);
  const info = await findRegistration(target.registrar, files, name);
  if (info === undefined) {
    return {
      pendingPurchase,
      next: [
        ...finishPending,
        `${name} is not registered with Cloudflare Registrar on this account, so OpsCrew cannot show its registration. Manage it where you bought it.`,
      ],
    };
  }
  const registered = info.domain;
  const live = await zoneDnssec(target.services, registered);
  // Zone calls that set no DNSSEC up (stand-in zones): the plan's value stands.
  const dnssec = live === "skipped" ? files.plan?.dns.registration?.dnssec : live;
  const notRecorded = await fillPlanRegistration(deps, files.plan, info, dnssec);
  return {
    domain: info,
    dnssec,
    pendingPurchase,
    next: [
      ...finishPending,
      renewalNote(info),
      ...(live === false
        ? [
            `DNSSEC is off for ${registered}. Run \`opscrew domain buy ${registered}\` to turn it on: OpsCrew does not buy the domain again, and it lists every change and asks before making it.`,
          ]
        : []),
      ...notRecorded,
    ],
  };
}

/** The adapter of another registrar, with services that do not need a Cloudflare token. */
function otherRegistrarTarget(
  deps: PhaseDeps,
  registrarId: OtherRegistrarId,
  given: DomainStatusOptions["services"],
): { services: ResolvedDomainServices; registrar: Registrar } {
  const services = resolveDomainServices(deps, given, { requireCloudflare: false });
  return { services, registrar: services.otherRegistrar(registrarId) };
}

/** Renewal note for a domain at another registrar, with the dashboard where the API cannot. */
function renewalNoteElsewhere(
  deps: PhaseDeps,
  info: RegisteredDomain,
  registrarId: OtherRegistrarId,
  autoRenewApi: boolean,
): string {
  if (autoRenewApi) {
    const expires = formatDate(info.expiresAt);
    return info.autoRenew
      ? `${info.domain} renews automatically before ${expires}. Turn that off with \`opscrew domain auto-renew off\`.`
      : renewalNote(info);
  }
  const name = REGISTRAR_NAMES[registrarId];
  const page = registrarLinks(registrarId, deps.env).domains;
  const expires = formatDate(info.expiresAt);
  return info.autoRenew
    ? `${info.domain} renews automatically before ${expires} (${name}'s setting). Turn that off at ${page}; ${name}'s API cannot change it.`
    : `Auto-renew is off: ${info.domain} stops working on ${expires} unless you renew it. Turn it on at ${page}; ${name}'s API cannot change it.`;
}

/** The zone's DS record from Cloudflare, when the token can read it; else undefined. */
async function zoneDs(services: ResolvedDomainServices, name: string) {
  try {
    const zone = await services.zones.findZone(name);
    return zone === undefined ? undefined : await services.zones.dsRecord(zone.id);
  } catch {
    return undefined;
  }
}

async function statusElsewhere(
  deps: PhaseDeps,
  files: ProjectFiles,
  context: {
    name: string;
    registrarId: OtherRegistrarId;
    options: DomainStatusOptions;
    pendingPurchase: DomainStatusResult["pendingPurchase"];
    finishPending: string[];
  },
): Promise<DomainStatusResult> {
  const { name, registrarId, options, pendingPurchase, finishPending } = context;
  const registrarName = REGISTRAR_NAMES[registrarId];
  const page = registrarLinks(registrarId, deps.env).domains;
  const { services, registrar } = otherRegistrarTarget(deps, registrarId, options.services);
  const found = await findRegistration(registrar, files, name);
  if (found === undefined) {
    return {
      pendingPurchase,
      next: [
        ...finishPending,
        `${name} is not registered in this ${registrarName} account, so OpsCrew cannot show its registration. Check ${page}, or set the ${registrarName} API keys of the account that holds it.`,
      ],
    };
  }
  const info: RegisteredDomain = { ...found, registrar: registrarId };
  const caps = registrar.capabilities;
  const dnssec = files.plan?.dns.registration?.dnssec;
  const next = [...finishPending, renewalNoteElsewhere(deps, info, registrarId, caps.autoRenew)];
  if (dnssec === false) {
    if (caps.dnssec) {
      // `connect` adds the DS record only once the zone is active (a DS record published earlier
      // would stop resolvers that check DNSSEC from resolving the domain).
      next.push(
        `DNSSEC is not published for ${info.domain}. Once Cloudflare shows its zone as active, run \`opscrew domain connect ${info.domain}\` to add the zone's DS record at ${registrarName}: it lists the change and asks before making it.`,
      );
    } else {
      const ds = services.configuredRegistrars().includes("cloudflare")
        ? await zoneDs(services, info.domain)
        : undefined;
      next.push(
        ds === undefined
          ? `DNSSEC is not published for ${info.domain}: ${registrarName}'s API cannot add DS records, so add the DS record Cloudflare shows for the zone (DNS → Settings → DNSSEC) at ${page}.`
          : `DNSSEC is not published for ${info.domain}: ${registrarName}'s API cannot add DS records, so add this DS record at ${page}: ${dsRecordText(ds)}.`,
      );
    }
  }
  return { domain: info, dnssec, pendingPurchase, next };
}

/**
 * `opscrew domain auto-renew on|off`: changes auto-renew of the project's domain after a
 * `domain-settings` approval that shows the next renewal date and price, then records it in
 * `plan.dns.registration`. Refusal stops with `APPROVAL_REFUSED`; nothing changes. A registrar
 * whose API cannot change auto-renew (Namecheap, GoDaddy) stops with its dashboard link before
 * anything is asked or changed.
 */
export async function setDomainAutoRenew(
  deps: PhaseDeps,
  options: SetAutoRenewOptions,
): Promise<DomainStatusResult> {
  const files = await readProjectFiles(deps);
  const projectName = registeredName(files);
  if (projectName === undefined) {
    throw new OpsCrewError("PHASE_PRECONDITION", "This project has no domain yet.", {
      hint: "Buy one with `opscrew domain buy <domain>`, then try again.",
    });
  }
  const registrarId = projectRegistrar(files, options.registrar);
  const target =
    registrarId === "cloudflare"
      ? await connect(deps, projectName, options)
      : { name: projectName, ...otherRegistrarTarget(deps, registrarId, options.services) };
  const registrarName = REGISTRAR_NAMES[registrarId];
  const onOff = options.on ? "on" : "off";
  if (registrarId !== "cloudflare" && !target.registrar.capabilities.autoRenew) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `${registrarName}'s API cannot change auto-renew, so OpsCrew did not turn it ${onOff} for ${projectName}. Nothing was changed.`,
      {
        hint: `Turn auto-renew ${onOff} for ${projectName} in the ${registrarName} dashboard (${registrarLinks(registrarId, deps.env).domains}).`,
      },
    );
  }
  const found = await findRegistration(target.registrar, files, projectName);
  if (found === undefined) {
    throw registrarId === "cloudflare"
      ? new OpsCrewError(
          "PHASE_PRECONDITION",
          `${projectName} is not registered with Cloudflare Registrar on this account, so OpsCrew cannot change its auto-renew.`,
          {
            hint: "Change it where you bought the domain, or pass the right account with --account.",
          },
        )
      : new OpsCrewError(
          "PHASE_PRECONDITION",
          `${projectName} is not registered in this ${registrarName} account, so OpsCrew cannot change its auto-renew.`,
          {
            hint: `Change it where you bought the domain, or set the ${registrarName} API keys of the account that holds it.`,
          },
        );
  }
  const current = { ...found, registrar: registrarId };
  const name = current.domain;
  const result = (info: RegisteredDomain): DomainStatusResult => ({
    domain: info,
    dnssec: files.plan?.dns.registration?.dnssec,
    next: [
      registrarId === "cloudflare"
        ? renewalNote(info)
        : renewalNoteElsewhere(deps, info, registrarId, true),
    ],
  });
  if (current.autoRenew === options.on) {
    deps.reporter.info(`Auto-renew is already ${onOff} for ${name}.`);
    await syncPlanRegistration(deps, files.plan, current);
    return result(current);
  }

  const decision = await deps.approvals.request(
    autoRenewApproval(
      name,
      current,
      options.on,
      await renewalPrice(target.registrar, name),
      registrarId,
    ),
  );
  if (!decision.approved) {
    throw new OpsCrewError(
      "APPROVAL_REFUSED",
      `Auto-renew was not changed: it stays ${current.autoRenew ? "on" : "off"} for ${name}.`,
      {
        hint: `Run \`opscrew domain auto-renew ${onOff}\` again to change it.`,
      },
    );
  }
  const changed = await target.registrar.setAutoRenew(name, options.on);
  const updated = { ...changed, registrar: registrarId };
  await auditAutoRenew(deps, registrarId, name, options.on);
  await syncPlanRegistration(deps, files.plan, updated);
  deps.reporter.success(`Auto-renew is now ${updated.autoRenew ? "on" : "off"} for ${name}.`);
  return result(updated);
}
