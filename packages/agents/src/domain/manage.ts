import type { ApprovalRequest, Money, RegisteredDomain, Registrar } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import type { PhaseDeps } from "../context";
import {
  auditDomain,
  formatDate,
  formatMoney,
  requireCloudflareToken,
  resolveAccount,
} from "./common";
import { readProjectFiles, registeredName, syncPlanRegistration } from "./project";
import { purchaseRecordPath, readPurchaseRecord } from "./record";
import { type ResolvedDomainServices, resolveDomainServices } from "./services";
import type { DomainStatusOptions, DomainStatusResult, SetAutoRenewOptions } from "./types";

/**
 * The yearly renewal price Cloudflare quotes for the domain's extension, when the live check
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

/** The `domain-settings` approval for turning auto-renew on or off (the domain typed to approve). */
export function autoRenewApproval(
  domain: string,
  info: RegisteredDomain,
  on: boolean,
  renewal: Money | undefined,
): ApprovalRequest {
  const expires = formatDate(info.expiresAt);
  const price =
    renewal === undefined
      ? "the renewal price Cloudflare shows for the domain in its dashboard"
      : `${formatMoney(renewal)} per year`;
  const details = on
    ? [
        `Auto-renew: off → on`,
        `Expires: ${expires}`,
        `Next renewal: up to 30 days before ${expires}, Cloudflare charges ${price} to your account's default payment method.`,
        "Renewals cannot be refunded; turn auto-renew off again before then to stop it.",
      ]
    : [
        `Auto-renew: on → off`,
        `Expires: ${expires}`,
        `Renewal price: ${price}`,
        `Nothing renews ${domain} automatically any more: it stops working on ${expires} unless you renew it in the Cloudflare dashboard or turn auto-renew on again, and an expired domain can be lost.`,
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

/** Whether DNSSEC is on for the zone, when the zone calls can tell; else undefined. */
async function dnssecState(services: ResolvedDomainServices, name: string) {
  if (services.zones.dnssecEnabled === undefined) return undefined;
  const zone = await services.zones.findZone(name);
  if (zone === undefined || zone.name.toLowerCase() !== name) return false;
  return services.zones.dnssecEnabled(zone.id);
}

function renewalNote(info: RegisteredDomain): string {
  const expires = formatDate(info.expiresAt);
  return info.autoRenew
    ? `${info.domain} renews automatically up to 30 days before ${expires}. Turn that off with \`opscrew domain auto-renew off\`.`
    : `Auto-renew is off: ${info.domain} stops working on ${expires} unless you renew it. Turn it on with \`opscrew domain auto-renew on\`.`;
}

/**
 * `opscrew domain status`: registrar, expiry, auto-renew, lock, privacy and DNSSEC of the
 * project's domain, read live (DNSSEC from the zone when the zone calls can tell, else from the
 * plan). Without a domain in the project it says so; it also reports an unfinished purchase.
 */
export async function domainStatus(
  deps: PhaseDeps,
  options: DomainStatusOptions = {},
): Promise<DomainStatusResult> {
  const files = await readProjectFiles(deps);
  const record = await readPurchaseRecord(purchaseRecordPath(deps.paths)).catch(
    (error: unknown) => {
      deps.reporter.warn(error instanceof Error ? error.message : String(error));
      return undefined;
    },
  );
  const pending =
    record === undefined
      ? {}
      : { pendingPurchase: { domain: record.domain, requestedAt: record.requestedAt } };
  const finishPending =
    record === undefined
      ? []
      : [
          `A purchase of ${record.domain} started on ${formatDate(record.requestedAt, record.requestedAt)} has not finished. Run \`opscrew domain buy ${record.domain}\` to finish it.`,
        ];
  const name = registeredName(files);
  if (name === undefined) {
    return {
      ...pending,
      next: [
        ...finishPending,
        "This project has no domain yet. Find one with `opscrew domain search <name>`, or use one you own with `opscrew dns --domain <domain>`.",
      ],
    };
  }

  const target = await connect(deps, name, options);
  const info = await target.registrar.getDomain(name);
  if (info === undefined) {
    return {
      ...pending,
      next: [
        ...finishPending,
        `${name} is not registered with Cloudflare Registrar on this account, so OpsCrew cannot show its registration. Manage it where you bought it.`,
      ],
    };
  }
  const live = await dnssecState(target.services, name);
  const dnssec = live ?? files.plan?.dns.registration?.dnssec;
  return {
    domain: info,
    ...(dnssec === undefined ? {} : { dnssec }),
    ...pending,
    next: [
      ...finishPending,
      renewalNote(info),
      ...(dnssec === false
        ? [
            `DNSSEC is off for ${name}. Run \`opscrew domain buy ${name}\` to turn it on: OpsCrew does not buy the domain again, and it lists every change and asks before making it.`,
          ]
        : []),
    ],
  };
}

/**
 * `opscrew domain auto-renew on|off`: changes auto-renew of the project's domain after a
 * `domain-settings` approval that shows the next renewal date and price, then records it in
 * `plan.dns.registration`. Refusal stops with `APPROVAL_REFUSED`; nothing changes.
 */
export async function setDomainAutoRenew(
  deps: PhaseDeps,
  options: SetAutoRenewOptions,
): Promise<DomainStatusResult> {
  const files = await readProjectFiles(deps);
  const name = registeredName(files);
  if (name === undefined) {
    throw new OpsCrewError("PHASE_PRECONDITION", "This project has no domain yet.", {
      hint: "Buy one with `opscrew domain buy <domain>`, then try again.",
    });
  }
  const target = await connect(deps, name, options);
  const current = await target.registrar.getDomain(name);
  if (current === undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `${name} is not registered with Cloudflare Registrar on this account, so OpsCrew cannot change its auto-renew.`,
      { hint: "Change it where you bought the domain, or pass the right account with --account." },
    );
  }
  const dnssec = files.plan?.dns.registration?.dnssec;
  const result = (info: RegisteredDomain): DomainStatusResult => ({
    domain: info,
    ...(dnssec === undefined ? {} : { dnssec }),
    next: [renewalNote(info)],
  });
  if (current.autoRenew === options.on) {
    deps.reporter.info(`Auto-renew is already ${options.on ? "on" : "off"} for ${name}.`);
    await syncPlanRegistration(deps, files.plan, current);
    return result(current);
  }

  const decision = await deps.approvals.request(
    autoRenewApproval(name, current, options.on, await renewalPrice(target.registrar, name)),
  );
  if (!decision.approved) {
    throw new OpsCrewError(
      "APPROVAL_REFUSED",
      `Auto-renew was not changed: it stays ${current.autoRenew ? "on" : "off"} for ${name}.`,
      {
        hint: `Run \`opscrew domain auto-renew ${options.on ? "on" : "off"}\` again to change it.`,
      },
    );
  }
  const updated = await target.registrar.setAutoRenew(name, options.on);
  await auditDomain(deps, "set auto-renew", name, `auto-renew ${options.on ? "on" : "off"}`);
  await syncPlanRegistration(deps, files.plan, updated);
  deps.reporter.success(`Auto-renew is now ${updated.autoRenew ? "on" : "off"} for ${name}.`);
  return result(updated);
}
