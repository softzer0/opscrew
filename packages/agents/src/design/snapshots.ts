/**
 * Design's snapshots (FR-2410, 024 plan.md 8.): on the user's own server, their Portainer or a
 * cloud provider that offers no automated backups through OpsCrew, where no provider backs the data
 * up, design proposes scheduled snapshots with the encrypted copy off the server when the interview
 * says the data matters, as it turns on a cloud provider's backups.
 */
import {
  type CloudProvider,
  type DeployPlan,
  type DeployProvider,
  isCloudProvider,
  isHostingTarget,
  isServerlessTarget,
  type Requirements,
} from "@opscrew/plan-schema";
import { providerProfile } from "../providers";
import { dataServers } from "../snapshot/hosts";
import { backupsBucketName, offsitePriceText, offsiteText } from "../snapshot/offsite";
import { scheduleText } from "../snapshot/schedule";

/**
 * True where no provider backs the app's data up, so OpsCrew's snapshots are proposed for it: the
 * user's own server, Portainer, and a cloud provider without automated backups through OpsCrew
 * (`offering.providerBackups` false).
 */
export function noProviderBackups(provider: DeployProvider): boolean {
  return (
    provider === "own" ||
    provider === "portainer" ||
    (isCloudProvider(provider) && !providerProfile(provider).providerBackups)
  );
}

/** What design says of a cloud provider that offers no automated backups through OpsCrew. */
export function noProviderBackupsText(provider: CloudProvider): string {
  return `${providerProfile(provider).displayName} offers no automatic backups through OpsCrew: OpsCrew's own snapshots of the app's data (\`opscrew snapshot\`) cover it instead.`;
}

/** True on the targets where design proposes snapshots ({@link noProviderBackups}). */
function ownsData(plan: Pick<DeployPlan, "target">): boolean {
  return noProviderBackups(plan.target.provider);
}

/**
 * `plan` with its `snapshots`:
 * - on the same kind of target, the previous plan's (the user's, through `opscrew snapshot
 *   schedule|offsite`);
 * - after a change of target, the previous plan's off-server copy, whose bucket does not depend on
 *   the target, wherever snapshots can be (not this computer, a site, a hosting account or a
 *   preview environment);
 * - and on an own server or a Portainer whose data matters (`dataCriticality` not `none`), with
 *   data to snapshot, design's proposal: weekly, the last 4 kept, and when the plan has no copy,
 *   one kept 90 days in the bucket `<app>-<env>-backups` on Cloudflare R2 when the domain is there
 *   (the other providers need a region, which only the user knows here).
 */
export function withDesignedSnapshots(
  plan: DeployPlan,
  previous: DeployPlan | undefined,
  requirements: Pick<Requirements, "dataCriticality">,
): DeployPlan {
  const { snapshots: _fresh, ...rest } = plan;
  if (previous !== undefined && previous.target.provider === plan.target.provider) {
    return previous.snapshots === undefined ? rest : { ...rest, snapshots: previous.snapshots };
  }
  // A hosting account's snapshots are dumps the agent on the account takes (ADR 0030 D5).
  const allowed =
    plan.target.provider !== "localhost" &&
    !isServerlessTarget(plan.target) &&
    !isHostingTarget(plan.target) &&
    plan.environment?.previews === undefined;
  const kept = allowed ? previous?.snapshots?.offsite : undefined;
  const proposed =
    allowed &&
    ownsData(plan) &&
    requirements.dataCriticality !== "none" &&
    dataServers(plan).length > 0;
  const r2 = plan.dns.provider === "cloudflare" && plan.dns.domain !== undefined;
  const offsite =
    kept ??
    (proposed && r2
      ? { provider: "r2" as const, bucket: backupsBucketName(plan), days: 90 }
      : undefined);
  const snapshots = {
    ...(proposed ? { schedule: { every: "weekly", keep: 4 } } : {}),
    ...(offsite === undefined ? {} : { offsite }),
  };
  return Object.keys(snapshots).length === 0 ? rest : { ...rest, snapshots };
}

/**
 * What design says of the plan's snapshots: the schedule and the off-server copy with its expected
 * cost, and on an own server or Portainer with a schedule but no copy, how to add one; its
 * commands carry `flags` (` --app …`/` --env …`).
 */
export function snapshotDesignLines(plan: DeployPlan, flags: string): string[] {
  const { snapshots } = plan;
  if (snapshots === undefined) return [];
  const where = plan.target.provider === "portainer" ? "the Portainer host" : "the server";
  const lines: string[] = [];
  if (snapshots.schedule !== undefined) {
    lines.push(
      `Scheduled snapshots of the app's data (snapshots.schedule): ${scheduleText(plan)}, on ${where}; \`opscrew snapshot schedule off${flags}\` turns them off.`,
    );
  }
  if (snapshots.offsite !== undefined) {
    lines.push(
      `An encrypted copy of each snapshot off ${where} (snapshots.offsite): ${offsiteText(plan)}. ${offsitePriceText(snapshots.offsite.provider)}`,
    );
  } else if (ownsData(plan)) {
    lines.push(
      `The snapshots stay on ${where}, so losing it loses them too: \`opscrew snapshot offsite on --to hetzner --region <region>${flags}\` (or \`--to digitalocean\`) keeps an encrypted copy elsewhere.`,
    );
  }
  return lines;
}
