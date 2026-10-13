import type { ApprovalRequest, VpsProviderId } from "@opscrew/contracts";
import type { DeployPlan } from "@opscrew/plan-schema";
import { providerProfile } from "../providers";

/** Continues a move. */
export const RUN_COMMAND = "opscrew retarget";
/** Deletes the old server after the switch. */
export const FINISH_COMMAND = "opscrew retarget --finish";
/** Undoes a move before the switch. */
export const ABORT_COMMAND = "opscrew retarget --abort";

/** Start of the title of the maintenance window's `remote-exec` approval. */
export const MAINTENANCE_WINDOW_TITLE = "Maintenance window:";

/**
 * True for the maintenance window's approval request (a `remote-exec` request whose title starts
 * with {@link MAINTENANCE_WINDOW_TITLE}). A non-interactive CLI run approves exactly this request
 * when `--allow-downtime` was given, and nothing else.
 */
export function isMaintenanceWindowRequest(
  request: Pick<ApprovalRequest, "kind" | "title">,
): boolean {
  return request.kind === "remote-exec" && request.title.startsWith(MAINTENANCE_WINDOW_TITLE);
}

/** `opscrew retarget … --approve <hash>` with the flags a scripted run needs. */
export function approveCommand(base: string, planHash: string, flags: readonly string[] = []) {
  return [base, ...flags, "--approve", planHash].join(" ");
}

/** The provider's name and what it calls a server, e.g. `DigitalOcean` and `Droplet`. */
export function providerWords(provider: VpsProviderId): { name: string; noun: string } {
  const profile = providerProfile(provider);
  return { name: profile.displayName, noun: profile.serverNoun };
}

/** True when OpsCrew manages the app's DNS records (Cloudflare with a domain). */
export function managedDns(plan: Pick<DeployPlan, "dns">): boolean {
  return plan.dns.provider === "cloudflare" && plan.dns.domain !== undefined;
}

/**
 * True when the old app stays stopped beyond the maintenance window: a self-hosted database is
 * copied and OpsCrew does not manage DNS, so the app is offline until the user's own DNS change
 * (or, without a domain, the users' move to the new address) has taken effect.
 */
export function downtimeUntilDnsChange(plan: Pick<DeployPlan, "dns" | "services">): boolean {
  return plan.services.postgres && !managedDns(plan);
}

/** `until your DNS change has reached your users` (or, without a domain, the new address). */
export function untilSwitched(plan: Pick<DeployPlan, "dns">): string {
  return plan.dns.domain !== undefined
    ? "until your DNS change has reached your users"
    : "until your users use the new address";
}

/**
 * What the downtime means without OpsCrew-managed DNS and with a database to copy: it lasts for
 * the copy plus the user's DNS change, so lower the TTL first, and in scripts pass
 * `--allow-downtime --dns-switched` together only when the records are ready. Empty otherwise.
 */
export function manualSwitchDowntime(plan: Pick<DeployPlan, "dns" | "services">): string[] {
  if (!downtimeUntilDnsChange(plan)) return [];
  const domain = plan.dns.domain;
  if (domain === undefined) {
    return [
      "Without a domain, the downtime lasts for the copy plus the time your users need to switch to the new address: the app on the old server stays stopped from the copy on.",
      `In scripts, pass \`--allow-downtime --dns-switched\` together only when your users can switch right after the copy; with \`--allow-downtime\` alone the run stops after the copy, with the app offline, until you run \`${RUN_COMMAND} --dns-switched\`.`,
    ];
  }
  return [
    `Without OpsCrew-managed DNS, the downtime lasts for the copy plus your DNS change: the app on the old server stays stopped until the DNS records of ${domain} point to the new server and the change has reached your users.`,
    "Lower the TTL of those records beforehand (for example to 60 seconds), so the change reaches your users quickly.",
    `In scripts, pass \`--allow-downtime --dns-switched\` together only when the records are ready to change right after the copy; with \`--allow-downtime\` alone the run stops after the copy, with the app offline, until you change them and run \`${RUN_COMMAND} --dns-switched\`.`,
  ];
}

/** Rough maintenance window: two minutes plus one per started 100 MB copied through this computer. */
export function downtimeMinutes(databaseBytes: number): number {
  const hundredMb = 100 * 1024 * 1024;
  return 2 + Math.ceil(Math.max(0, databaseBytes) / hundredMb);
}

/** `52.4 MB`, `1.2 GB`: a database size in plain words. */
export function sizeText(bytes: number): string {
  const units = ["bytes", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return unit === 0 ? `${bytes} bytes` : `${value.toFixed(1)} ${units[unit]}`;
}

/** `1 resource` / `3 resources`. */
export function resourcesText(count: number): string {
  return `${count} resource${count === 1 ? "" : "s"}`;
}
