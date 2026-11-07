/**
 * `opscrew snapshot offsite on|off` (US6, FR-2407): the encrypted copy of each snapshot off the
 * server, in a bucket of its own (`snapshots.offsite`), which provision then plans (approved by its
 * hash, D9) and the servers or the Portainer stack upload to. Only the plan changes here.
 */
import { formatMoney, OpsCrewError } from "@opscrew/core";
import { STORAGE_NAMES } from "@opscrew/iac-templates";
import { type DeployPlan, snapshotOffsiteOf } from "@opscrew/plan-schema";
import { z } from "zod";
import type { PhaseDeps } from "../context";
import { HETZNER_STORAGE_LOCATIONS, storagePrice, storageRegionAt } from "../design/storage";
import { NOTHING_CHANGED } from "../promote/shared";
import { backupsCreateFile, backupsStateFile } from "../provision/storage";
import { planFile } from "../runners/words";
import { readValidJson } from "../shared/files";
import { type SnapshotRun, snapshotRun } from "./run";
import {
  provisionLine,
  requireSettingsPlace,
  type SnapshotSettingChange,
  withSnapshotSetting,
  writeSnapshotSetting,
} from "./settings";

/** Where the off-server copies go. */
export type OffsiteProvider = "r2" | "hetzner" | "digitalocean";

/** `opscrew snapshot offsite on`'s flags. */
export interface OffsiteOnOptions {
  /** `--to`: the provider of the bucket. */
  to: OffsiteProvider;
  /**
   * `--region`: the bucket's region at Hetzner or DigitalOcean (default: the app's server's
   * location, where that provider has object storage). R2 picks its own.
   */
  region?: string;
  /** `--days <n>`: how long each copy is kept (default: the plan's, else 90). */
  days?: number;
}

/**
 * The off-server copies' bucket of `plan`'s environment, `<app>-<env>-backups`: another
 * environment's app is already named `<app>-<env>` (design's `environmentNames`), prod's is not.
 */
export function backupsBucketName(plan: Pick<DeployPlan, "app" | "environment">): string {
  return `${plan.app.name}${plan.environment === undefined ? "-prod" : ""}-backups`;
}

/**
 * The expected monthly cost of the copies' bucket at `provider`, from the price data provision
 * shows: the bucket's own price, which the copies add to only beyond what it includes.
 */
export function offsitePriceText(provider: OffsiteProvider): string {
  const price = storagePrice(provider, { storageGb: 0, egressGbPerMonth: 0 });
  return `Expected cost: ${formatMoney(price)}/month at ${STORAGE_NAMES[provider]}, plus what the copies store beyond what that includes.${price.note === undefined ? "" : ` ${price.note}`}`;
}

/** The off-server copy in words: `the private bucket shop-staging-backups on Cloudflare R2, each copy kept 90 days`. */
export function offsiteText(plan: Pick<DeployPlan, "snapshots">): string {
  const offsite = snapshotOffsiteOf(plan);
  if (offsite === undefined) return "off";
  const region = offsite.provider === "r2" ? "" : ` (${offsite.region})`;
  return `the private bucket ${offsite.bucket} on ${STORAGE_NAMES[offsite.provider]}${region}, each copy kept ${offsite.days} days`;
}

/**
 * The bucket's region: `region` at Hetzner (where it has object storage) or DigitalOcean, else
 * the plan's while the provider stays the same, else the app's server's location where `to` has
 * object storage there; none for R2.
 * @throws OpsCrewError `INVALID_INPUT` for `--region` with R2, a Hetzner location without object
 * storage, and when no region is given or known.
 */
function regionFor(run: SnapshotRun, to: OffsiteProvider, region: string | undefined) {
  const { plan, flags } = run;
  const again = `\`opscrew snapshot offsite on --to ${to} --region <region>${flags}\``;
  if (to === "r2") {
    if (region === undefined) return undefined;
    throw new OpsCrewError(
      "INVALID_INPUT",
      `Cloudflare R2 picks the bucket's region itself, so --region does not apply. ${NOTHING_CHANGED}`,
      { hint: `Leave out --region: \`opscrew snapshot offsite on --to r2${flags}\`.` },
    );
  }
  const locations = HETZNER_STORAGE_LOCATIONS.join(", ");
  if (to === "hetzner" && region !== undefined && !HETZNER_STORAGE_LOCATIONS.includes(region)) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `Hetzner has no object storage in ${region}. ${NOTHING_CHANGED}`,
      { hint: `Choose one of ${locations}: ${again}.` },
    );
  }
  const { target } = plan;
  const known =
    target.provider === to && "location" in target
      ? storageRegionAt(to, target.location)
      : undefined;
  const current = snapshotOffsiteOf(plan);
  const kept = current?.provider === to ? current.region : undefined;
  const chosen = region ?? kept ?? known;
  if (chosen !== undefined) return chosen;
  throw new OpsCrewError(
    "INVALID_INPUT",
    `OpsCrew needs the bucket's region at ${STORAGE_NAMES[to]}: ${target.provider === to ? `it has no object storage where the app's server is (${"location" in target ? target.location : "here"})` : "the app's server is elsewhere"}. ${NOTHING_CHANGED}`,
    {
      hint:
        to === "hetzner"
          ? `Choose one of ${locations}: ${again}.`
          : `Choose a Spaces region, such as fra1, ams3 or nyc3: ${again}.`,
    },
  );
}

/**
 * `opscrew snapshot offsite on --to r2|hetzner|digitalocean` (FR-2407): `snapshots.offsite` in the
 * plan of the environment `deps` belong to: the bucket `<app>-<env>-backups` (or the one the plan
 * names), its region ({@link regionFor}) and how long each copy is kept (`--days`, the plan's, or
 * 90), written through the plan-writing path; the lines say what changed, the expected monthly cost
 * ({@link offsitePriceText}) and to run provision.
 * @throws OpsCrewError `PHASE_PRECONDITION` for a site, a preview environment, this computer or an
 * environment without data, and for R2 without a domain on Cloudflare; `INVALID_INPUT` for a
 * region refused and a value the plan schema refuses. Nothing is written then.
 */
export async function snapshotOffsiteOn(
  deps: PhaseDeps,
  options: OffsiteOnOptions,
): Promise<SnapshotSettingChange> {
  const run = await snapshotRun(deps);
  const { plan, flags } = run;
  const what = "copy the snapshots off the server";
  requireSettingsPlace(run, "offsite", what);
  const { to } = options;
  if (to === "r2" && (plan.dns.provider !== "cloudflare" || plan.dns.domain === undefined)) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `Cloudflare R2 needs the app's domain on Cloudflare, which gives OpsCrew the account to create the bucket in, and ${run.environment} has none. ${NOTHING_CHANGED}`,
      {
        hint: `Give the app a domain on Cloudflare (\`opscrew dns --domain <hostname>${flags}\`), or keep the copies at Hetzner or DigitalOcean (\`opscrew snapshot offsite on --to hetzner --region <region>${flags}\`).`,
      },
    );
  }
  const region = regionFor(run, to, options.region);
  const current = snapshotOffsiteOf(plan);
  const bucket = current?.bucket ?? backupsBucketName(plan);
  await requireSameBucket(run, {
    provider: to,
    bucket,
    ...(region === undefined ? {} : { region }),
  });
  const after = withSnapshotSetting(
    plan,
    "offsite",
    {
      provider: to,
      bucket,
      ...(region === undefined ? {} : { region }),
      days: options.days ?? current?.days ?? 90,
    },
    what,
  );
  return writeSnapshotSetting(
    run,
    after,
    [
      `The copy of ${run.environment}'s snapshots off the server (snapshots.offsite in ${planFile(plan)}): ${offsiteText(plan)} → ${offsiteText(after)}.`,
      "Each snapshot taken by hand or on the schedule is encrypted to the recovery copy's age key before it leaves the machine that holds the data, so only your key opens the copies.",
      offsitePriceText(to),
      provisionLine(
        run,
        "create the bucket after you approve its plan; it asks for the bucket's access key, which you create",
      ),
    ],
    `The copy of ${run.environment}'s snapshots off the server is already ${offsiteText(plan)}.`,
  );
}

/** Where to delete a bucket by hand at `provider`. */
const CONSOLES: Readonly<Record<OffsiteProvider, string>> = {
  r2: "Cloudflare's dashboard (R2 Object Storage)",
  hetzner: "the Hetzner Console (Object Storage)",
  digitalocean: "the DigitalOcean control panel (Spaces Object Storage)",
};

/** A backups bucket as the plan, the backups root's marker or its state names it. */
interface KnownBucket {
  bucket: string;
  /** `s3` when only the state names it, at Hetzner or DigitalOcean (both through S3). */
  provider: OffsiteProvider | "s3";
  /** Absent for R2, and where the state does not say. */
  region?: string;
}

const MarkerSchema = z.object({
  provider: z.enum(["r2", "hetzner", "digitalocean"]),
  bucket: z.string(),
  region: z.string(),
});

const StateSchema = z.object({
  resources: z.array(
    z.object({
      type: z.string(),
      instances: z.array(
        z.object({ attributes: z.object({ bucket: z.string(), name: z.string() }).partial() }),
      ),
    }),
  ),
});

/**
 * The backups bucket of `run`'s environment that exists or is being created: the plan's
 * `snapshots.offsite`, else the one the backups root's marker or state still names after
 * `snapshot offsite off`; undefined without one.
 */
async function existingBucket(run: SnapshotRun): Promise<KnownBucket | undefined> {
  const named = (o: { provider: OffsiteProvider; bucket: string; region: string }) => ({
    provider: o.provider,
    bucket: o.bucket,
    ...(o.provider === "r2" ? {} : { region: o.region }),
  });
  const current = snapshotOffsiteOf(run.plan);
  if (current !== undefined) return named(current);
  const marker = await readValidJson(backupsCreateFile(run.deps.paths), MarkerSchema);
  if (marker !== undefined) return named(marker);
  const state = await readValidJson(backupsStateFile(run.deps.paths), StateSchema);
  if (state === undefined) return undefined;
  for (const resource of state.resources) {
    if (resource.type !== "cloudflare_r2_bucket" && resource.type !== "aws_s3_bucket") continue;
    const attributes = resource.instances[0]?.attributes;
    const bucket = attributes?.bucket ?? attributes?.name;
    if (bucket === undefined) continue;
    return { bucket, provider: resource.type === "cloudflare_r2_bucket" ? "r2" : "s3" };
  }
  return undefined;
}

/**
 * Stops before any change when a backups bucket exists ({@link existingBucket}) and `wanted` is
 * another provider, region or bucket: OpsCrew never moves the copies' bucket.
 * @throws OpsCrewError `PHASE_PRECONDITION` with how to start on another bucket.
 */
async function requireSameBucket(run: SnapshotRun, wanted: KnownBucket): Promise<void> {
  const known = await existingBucket(run);
  if (known === undefined) return;
  const differs =
    known.bucket !== wanted.bucket ||
    (known.provider === "s3" ? wanted.provider === "r2" : known.provider !== wanted.provider) ||
    (known.region !== undefined && wanted.region !== undefined && known.region !== wanted.region);
  if (!differs) return;
  const { provider, region } = known;
  const where =
    provider === "s3"
      ? ""
      : ` on ${STORAGE_NAMES[provider]}${region === undefined ? "" : ` (${region})`}`;
  const records = `${backupsStateFile(run.deps.paths)}, and ${backupsCreateFile(run.deps.paths)} if it exists`;
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    `The copies of ${run.environment}'s snapshots are in the bucket ${known.bucket}${where}, and OpsCrew does not move that bucket or its copies. ${NOTHING_CHANGED}`,
    {
      hint: `To keep them in another bucket: first delete the bucket ${known.bucket} in ${provider === "s3" ? "its provider's console" : CONSOLES[provider]}, then delete OpsCrew's record of it (${records}), then run \`opscrew snapshot offsite on${run.flags}\` again.`,
    },
  );
}

/**
 * `opscrew snapshot offsite off`: `snapshots.offsite` removed from the plan, so no new copy is
 * uploaded. The bucket and its copies stay (D9: OpsCrew never deletes them); the lines say so,
 * when they expire and how to delete them, and to run provision.
 */
export async function snapshotOffsiteOff(deps: PhaseDeps): Promise<SnapshotSettingChange> {
  const run = await snapshotRun(deps);
  const { plan } = run;
  const offsite = snapshotOffsiteOf(plan);
  const after = withSnapshotSetting(plan, "offsite", undefined, "stop copying the snapshots");
  const lines =
    offsite === undefined
      ? []
      : [
          `The copy of ${run.environment}'s snapshots off the server (snapshots.offsite in ${planFile(plan)}): ${offsiteText(plan)} → off.`,
          // Spaces gets no lifecycle rule: the servers delete the old copies after each upload.
          `The bucket ${offsite.bucket} and the copies in it stay: OpsCrew never deletes them${offsite.provider === "digitalocean" ? ", and with no more uploads nothing deletes the old ones" : `, and ${STORAGE_NAMES[offsite.provider]} expires each copy after ${offsite.days} days`}. To delete them sooner, empty and delete the bucket in ${CONSOLES[offsite.provider]}.`,
          provisionLine(run, "stop the uploads"),
        ];
  return writeSnapshotSetting(
    run,
    after,
    lines,
    `The copy of ${run.environment}'s snapshots off the server is already off.`,
  );
}
