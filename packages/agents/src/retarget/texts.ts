import type { ApprovalRequest, VpsProviderId } from "@opscrew/contracts";
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
