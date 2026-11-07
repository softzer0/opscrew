/**
 * Design's snapshots (FR-2410, 024 plan.md 8.): on the user's own server or their Portainer, where
 * no provider backs the data up, design proposes scheduled snapshots with the encrypted copy off
 * the server when the interview says the data matters, as it turns on a cloud provider's backups.
 */
import type { DeployPlan, Requirements } from "@opscrew/plan-schema";
import { dataServers } from "../snapshot/hosts";
import { backupsBucketName, offsitePriceText, offsiteText } from "../snapshot/offsite";
import { scheduleText } from "../snapshot/schedule";

/** True on the targets where design proposes snapshots: the user's own server or Portainer. */
function ownsData(plan: Pick<DeployPlan, "target">): boolean {
  return plan.target.provider === "own" || plan.target.provider === "portainer";
}

/**
 * `plan` with its `snapshots`: the previous plan's on the same kind of target (the user's,
 * through `opscrew snapshot schedule|offsite`), else design's proposal on an own server or a
 * Portainer whose data matters (`dataCriticality` not `none`), outside a preview environment and
 * with data to snapshot: weekly, the last 4 kept, and the copy kept 90 days in the bucket
 * `<app>-<env>-backups` on Cloudflare R2 when the domain is there (the other providers need a
 * region, which only the user knows here), else none.
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
  const proposed =
    ownsData(plan) &&
    requirements.dataCriticality !== "none" &&
    plan.environment?.previews === undefined &&
    dataServers(plan).length > 0;
  if (!proposed) return rest;
  const r2 = plan.dns.provider === "cloudflare" && plan.dns.domain !== undefined;
  return {
    ...rest,
    snapshots: {
      schedule: { every: "weekly", keep: 4 },
      ...(r2 ? { offsite: { provider: "r2", bucket: backupsBucketName(plan), days: 90 } } : {}),
    },
  };
}

/**
 * What design says of the plan's snapshots: the schedule and the off-server copy with its expected
 * cost, and on an own server or Portainer with a schedule but no copy, how to add one.
 */
export function snapshotDesignLines(plan: DeployPlan): string[] {
  const { snapshots } = plan;
  if (snapshots === undefined) return [];
  const where = plan.target.provider === "portainer" ? "the Portainer host" : "the server";
  const lines: string[] = [];
  if (snapshots.schedule !== undefined) {
    lines.push(
      `Scheduled snapshots of the app's data (snapshots.schedule): ${scheduleText(plan)}, on ${where}; \`opscrew snapshot schedule off\` turns them off.`,
    );
  }
  if (snapshots.offsite !== undefined) {
    lines.push(
      `An encrypted copy of each snapshot off ${where} (snapshots.offsite): ${offsiteText(plan)}. ${offsitePriceText(snapshots.offsite.provider)}`,
    );
  } else if (ownsData(plan)) {
    lines.push(
      `The snapshots stay on ${where}, so losing it loses them too: \`opscrew snapshot offsite on --to hetzner --region <region>\` (or \`--to digitalocean\`) keeps an encrypted copy elsewhere.`,
    );
  }
  return lines;
}
