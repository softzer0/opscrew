import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { ownPlan, testPlan } from "../testing";
import { previewTestPlan } from "../testing/previews";
import { snapshotDesignLines, withDesignedSnapshots } from "./snapshots";

const important = { dataCriticality: "important" as const };
const SCHEDULE = { every: "weekly", keep: 4 };

describe("withDesignedSnapshots", () => {
  it("proposes the schedule on an own server whose data matters, and no copy without Cloudflare", () => {
    const plan = withDesignedSnapshots(ownPlan({ domain: null }), undefined, important);
    expect(plan.snapshots).toEqual({ schedule: SCHEDULE });
    expect(DeployPlanSchema.parse(plan)).toEqual(plan);
    expect(snapshotDesignLines(plan, "")).toEqual([
      "Scheduled snapshots of the app's data (snapshots.schedule): weekly, the last 4 kept, on the server; `opscrew snapshot schedule off` turns them off.",
      "The snapshots stay on the server, so losing it loses them too: `opscrew snapshot offsite on --to hetzner --region <region>` (or `--to digitalocean`) keeps an encrypted copy elsewhere.",
    ]);
    expect(snapshotDesignLines(plan, " --env staging")[0]).toContain(
      "`opscrew snapshot schedule off --env staging`",
    );
  });

  it("adds the copy on R2 with a domain on Cloudflare, priced", () => {
    const plan = withDesignedSnapshots(ownPlan(), undefined, { dataCriticality: "critical" });
    expect(plan.snapshots).toEqual({
      schedule: SCHEDULE,
      offsite: { provider: "r2", bucket: "shop-prod-backups", days: 90 },
    });
    expect(snapshotDesignLines(plan, "")[1]).toBe(
      "An encrypted copy of each snapshot off the server (snapshots.offsite): the private bucket shop-prod-backups on Cloudflare R2, each copy kept 90 days. Expected cost: $0.00/month at Cloudflare R2, plus what the copies store beyond what that includes.",
    );
  });

  it("proposes none on a cloud server, for data that matters little, without data or for previews", () => {
    const none = (plan: DeployPlan, criticality: "none" | "important" = "important") =>
      withDesignedSnapshots(plan, undefined, { dataCriticality: criticality }).snapshots;
    expect(none(testPlan())).toBeUndefined();
    expect(none(ownPlan(), "none")).toBeUndefined();
    expect(none(ownPlan({ postgres: false }))).toBeUndefined();
    expect(none(previewTestPlan({ own: true }))).toBeUndefined();
    expect(snapshotDesignLines(testPlan(), "")).toEqual([]);
  });

  it("keeps the previous plan's on the same target, set or off, and proposes after a move", () => {
    const offsite = { provider: "hetzner" as const, bucket: "shop-prod-backups", region: "fsn1" };
    const previous = { ...ownPlan(), snapshots: { offsite } };
    expect(withDesignedSnapshots(ownPlan(), previous, important).snapshots).toEqual({ offsite });
    expect(withDesignedSnapshots(ownPlan(), ownPlan(), important).snapshots).toBeUndefined();
    const cloud = { ...testPlan(), snapshots: { schedule: { every: "daily" } } };
    expect(withDesignedSnapshots(testPlan(), cloud, important).snapshots).toEqual(cloud.snapshots);
    expect(withDesignedSnapshots(ownPlan(), cloud, important).snapshots).toMatchObject({
      schedule: SCHEDULE,
    });
    // After a change of target the user's copy stays: its bucket doesn't depend on the target.
    const copied = { ...testPlan(), snapshots: { offsite } };
    expect(withDesignedSnapshots(ownPlan(), copied, important).snapshots).toEqual({
      schedule: SCHEDULE,
      offsite,
    });
    expect(withDesignedSnapshots(ownPlan(), copied, { dataCriticality: "none" }).snapshots).toEqual(
      { offsite },
    );
  });
});
