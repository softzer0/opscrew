/**
 * `opscrew snapshot offsite on|off` (US6, FR-2407; T2756): the encrypted copy of each snapshot off
 * the server (`snapshots.offsite`): in a bucket of its own, which provision then plans (approved by
 * its hash, D9), or in the user's own S3-compatible bucket or a folder on the user's own machine
 * over SFTP, which OpsCrew never creates, empties or deletes. The servers or the Portainer stack
 * upload to it. Only the plan changes here.
 */
import { formatMoney, listText, OpsCrewError } from "@opscrew/core";
import { OFFSITE_PREFIX, offsiteFolder, offsitePlace, STORAGE_NAMES } from "@opscrew/iac-templates";
import {
  type BackupsBucketProvider,
  backupsBucketOf,
  type DeployPlan,
  type SnapshotOffsite,
  snapshotOffsiteOf,
} from "@opscrew/plan-schema";
import { z } from "zod";
import type { PhaseDeps } from "../context";
import { HETZNER_STORAGE_LOCATIONS, storagePrice, storageRegionAt } from "../design/storage";
import { NOTHING_CHANGED } from "../promote/shared";
import {
  backupsCreateFile,
  backupsStateFile,
  OFFSITE_KEY_VARS,
  OFFSITE_SFTP_KEY_VAR,
} from "../provision/storage";
import { planFile } from "../runners/words";
import { HOST_KEY_FINGERPRINT, hostKeyFingerprint, scanHostKeys } from "../shared";
import { readValidJson } from "../shared/files";
import { type SnapshotRun, snapshotRun } from "./run";
import {
  provisionLine,
  requireSettingsPlace,
  type SnapshotSettingChange,
  withSnapshotSetting,
  writeSnapshotSetting,
} from "./settings";

/**
 * Where the off-server copies go: a bucket OpsCrew plans (`r2`, `hetzner`, `digitalocean`), the
 * user's own S3-compatible bucket (`s3`), or a folder on the user's own machine over SFTP (`sftp`).
 */
export type OffsiteProvider = SnapshotOffsite["provider"];

/** `opscrew snapshot offsite on`'s flags. */
export interface OffsiteOnOptions {
  /** `--to`: where the copies go. */
  to: OffsiteProvider;
  /**
   * `--region`: the bucket's region at Hetzner or DigitalOcean (default: the app's server's
   * location, where that provider has object storage), or of the user's own bucket (default
   * `us-east-1`). R2 picks its own.
   */
  region?: string;
  /** `--days <n>`: how long each copy is kept (default: the plan's, else 90). */
  days?: number;
  /** `--endpoint <url>`, with `--to s3`: the bucket's S3 address, `https://…`. */
  endpoint?: string;
  /** `--bucket <name>`, with `--to s3`: the user's bucket, which exists. */
  bucket?: string;
  /** `--host <host>`, with `--to sftp`: the machine. */
  host?: string;
  /** `--port <port>`, with `--to sftp`: its SSH port (default 22). */
  port?: number;
  /** `--user <user>`, with `--to sftp`: the account the server logs in as. */
  user?: string;
  /** `--path <folder>`, with `--to sftp`: the account's folder for the copies, absolute. */
  path?: string;
  /**
   * `--host-key SHA256:…`, with `--to sftp`: the machine's host key fingerprint, which confirms the
   * key it presents without a terminal.
   */
  hostKey?: string;
}

/** Each flag of {@link OffsiteOnOptions} besides `--to` and `--days`, as the user types it. */
const FLAG_NAMES = {
  region: "--region",
  endpoint: "--endpoint",
  bucket: "--bucket",
  host: "--host",
  port: "--port",
  user: "--user",
  path: "--path",
  hostKey: "--host-key",
} as const;
type Flag = keyof typeof FLAG_NAMES;

/** The flags each `--to` takes, and the ones it needs. */
const FLAGS_OF: Readonly<Record<"bucket" | "s3" | "sftp", { takes: Flag[]; needs: Flag[] }>> = {
  bucket: { takes: ["region"], needs: [] },
  s3: { takes: ["endpoint", "bucket", "region"], needs: ["endpoint", "bucket"] },
  sftp: { takes: ["host", "port", "user", "path", "hostKey"], needs: ["host", "user", "path"] },
};

/** What the flags `--to s3` and `--to sftp` need are, in words, for the stop that misses them. */
const NEEDED_WORDS = {
  s3: "your bucket's S3 address (https://…) and its name",
  sftp: "the machine, the account the server logs in as, and its folder for the copies",
} as const;

/** True when the copies go to a bucket OpsCrew plans (`r2`, `hetzner`, `digitalocean`). */
function plannedBucket(to: OffsiteProvider): to is BackupsBucketProvider {
  return to !== "s3" && to !== "sftp";
}

/**
 * Stops before any change on a flag `--to` doesn't take, or one it needs that is missing.
 * @throws OpsCrewError `INVALID_INPUT`.
 */
function checkFlags(run: SnapshotRun, options: OffsiteOnOptions): void {
  const { to } = options;
  const kind = plannedBucket(to) ? "bucket" : to;
  const { takes, needs } = FLAGS_OF[kind];
  const flags = (names: Flag[]) => names.map((name) => FLAG_NAMES[name]);
  const given = (Object.keys(FLAG_NAMES) as Flag[]).filter((name) => options[name] !== undefined);
  // R2 says itself why --region does not apply ({@link regionFor}).
  const extra = given.filter(
    (name) => !takes.includes(name) && !(to === "r2" && name === "region"),
  );
  if (extra.length > 0) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `${listText(flags(extra))} ${extra.length === 1 ? "does" : "do"} not apply to --to ${to}. ${NOTHING_CHANGED}`,
      {
        hint: `Leave ${extra.length === 1 ? "it" : "them"} out: --to ${to} takes ${listText([...flags(takes), "--days"])}.`,
      },
    );
  }
  const missing = needs.filter((name) => options[name] === undefined);
  if (missing.length > 0 && (to === "s3" || to === "sftp")) {
    const example =
      to === "s3"
        ? "--endpoint https://<your provider's S3 address> --bucket <name>"
        : "--host <host> --user <user> --path /<folder>";
    throw new OpsCrewError(
      "INVALID_INPUT",
      `\`opscrew snapshot offsite on --to ${to}\` needs ${listText(flags(needs))}: ${NEEDED_WORDS[to]}. ${listText(flags(missing))} ${missing.length === 1 ? "is" : "are"} missing. ${NOTHING_CHANGED}`,
      { hint: `Run \`opscrew snapshot offsite on --to ${to} ${example}${run.flags}\`.` },
    );
  }
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
 * shows: the bucket's own price, which the copies add to only beyond what it includes. The user's
 * own bucket or machine is priced by nobody here: its provider bills it.
 */
export function offsitePriceText(provider: OffsiteProvider): string {
  if (!plannedBucket(provider)) {
    return `OpsCrew prices nothing for it: the copies go to your own ${provider === "s3" ? "bucket" : "machine"}, and its provider bills what they store.`;
  }
  const price = storagePrice(provider, { storageGb: 0, egressGbPerMonth: 0 });
  return `Expected cost: ${formatMoney(price)}/month at ${STORAGE_NAMES[provider]}, plus what the copies store beyond what that includes.${price.note === undefined ? "" : ` ${price.note}`}`;
}

/** The off-server copy in words: `the private bucket shop-staging-backups on Cloudflare R2, each copy kept 90 days`. */
export function offsiteText(plan: Pick<DeployPlan, "snapshots" | "app" | "environment">): string {
  const offsite = snapshotOffsiteOf(plan);
  if (offsite === undefined) return "off";
  return `${offsitePlace(plan, offsite)}, each copy kept ${offsite.days} days`;
}

/**
 * The bucket's region: `region` at Hetzner (where it has object storage) or DigitalOcean, else
 * the plan's while the provider stays the same, else the app's server's location where `to` has
 * object storage there; none for R2.
 * @throws OpsCrewError `INVALID_INPUT` for `--region` with R2, a Hetzner location without object
 * storage, and when no region is given or known.
 */
function regionFor(run: SnapshotRun, to: BackupsBucketProvider, region: string | undefined) {
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
  const current = backupsBucketOf(plan);
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

/** What to compare an SFTP machine's host key with, in every host key stop. */
const CHECK_ON_MACHINE =
  "Compare it with the fingerprint the machine shows: `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on it, or its provider's panel.";

/**
 * The SFTP machine's host key (`<type> <base64>`), read with `ssh-keyscan` and confirmed: by
 * `--host-key` (its fingerprint), else the key the plan pins for the same host and port, else the
 * user's approval in a terminal, which shows its fingerprint. A key that differs from the one
 * given or pinned stops.
 * @throws OpsCrewError `INVALID_INPUT` for a `--host-key` that is no fingerprint,
 * `COMMAND_FAILED` when the machine does not answer, `PHASE_PRECONDITION` for another key or
 * nobody to confirm it, `APPROVAL_REFUSED`. Nothing is written then.
 */
async function confirmedHostKey(
  run: SnapshotRun,
  input: { host: string; port: number; given?: string; pinned?: string },
): Promise<string> {
  const { deps } = run;
  const { host, port, given } = input;
  const where = `${host} (port ${port})`;
  if (given !== undefined && !HOST_KEY_FINGERPRINT.test(given)) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `--host-key must be the machine's host key fingerprint as \`ssh-keygen -lf\` prints it: SHA256: and 43 letters, digits, + or /. ${NOTHING_CHANGED}`,
      { hint: CHECK_ON_MACHINE },
    );
  }
  const keys = await scanHostKeys({ host, port, runner: deps.runner });
  const first = keys[0];
  if (first === undefined) {
    throw new OpsCrewError(
      "COMMAND_FAILED",
      `OpsCrew could not reach SSH at ${where}, so it could not read the machine's host key. ${NOTHING_CHANGED}`,
      {
        hint: "Check --host and --port, and that this computer can reach the machine, then try again.",
      },
    );
  }
  const presented = keys.map((key) => `${key.type} ${key.fingerprint}`).join(", ");
  const wanted = given ?? input.pinned;
  const again = `opscrew snapshot offsite on --to sftp --host ${host}${port === 22 ? "" : ` --port ${port}`} --user <user> --path <folder>${run.flags}`;
  if (wanted !== undefined) {
    const chosen = keys.find((key) => key.fingerprint === wanted);
    if (chosen !== undefined) return `${chosen.type} ${chosen.key}`;
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      given !== undefined
        ? `The machine at ${where} presented ${presented}, not the fingerprint you gave (${given}). ${NOTHING_CHANGED}`
        : `The host key of the machine at ${where} changed since you confirmed it (confirmed: ${input.pinned}; now: ${presented}). ${NOTHING_CHANGED}`,
      {
        hint: `${CHECK_ON_MACHINE} If its key really changed, run \`${again} --host-key <the new fingerprint>\`. Otherwise someone may be intercepting the connection.`,
      },
    );
  }
  if (!deps.interactive) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `The machine's host key must be confirmed before OpsCrew trusts it: ${where} presents ${first.type} ${first.fingerprint}. ${NOTHING_CHANGED}`,
      {
        hint: `${CHECK_ON_MACHINE} If it matches, run \`${again} --host-key ${first.fingerprint}\`, or run the command in a terminal to confirm it there.`,
      },
    );
  }
  // The title is audited: it names no address (the details, shown only in the terminal, do).
  const decision = await deps.approvals.request({
    kind: "remote-exec",
    title: "Trust the SSH host key of the machine for the off-server copies",
    details: [
      `The off-server copies go to the machine at ${where}. It presents this host key:`,
      `  ${first.type} ${first.fingerprint}`,
      ...(keys.length > 1
        ? [
            "Other keys it offers:",
            ...keys.slice(1).map((key) => `  ${key.type} ${key.fingerprint}`),
          ]
        : []),
      CHECK_ON_MACHINE,
      "Approve only if the fingerprints match. The plan then pins the key, and the copies go only to a machine that presents it.",
    ].join("\n"),
  });
  if (!decision.approved) {
    throw new OpsCrewError(
      "APPROVAL_REFUSED",
      `You did not confirm the machine's host key, so OpsCrew changed nothing.`,
      { hint: `${CHECK_ON_MACHINE} Then run the command again and confirm it.` },
    );
  }
  return `${first.type} ${first.key}`;
}

/** `value` without a trailing slash, unless it is all there is. */
function trimSlash(value: string): string {
  return value.length > 1 ? value.replace(/\/+$/, "") : value;
}

/**
 * `snapshots.offsite` for the user's own S3-compatible bucket (`--to s3`): its https:// endpoint,
 * its name and region.
 * @throws OpsCrewError `INVALID_INPUT` for an endpoint that is not https://.
 */
function ownBucket(options: OffsiteOnOptions) {
  const endpoint = trimSlash(options.endpoint?.trim() ?? "");
  if (!/^https:\/\//i.test(endpoint)) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `--endpoint must be an https:// address: the server sends the bucket's key there, never over plain http. ${NOTHING_CHANGED}`,
      {
        hint: "Give your provider's https:// S3 endpoint, such as https://s3.eu-central-1.wasabisys.com.",
      },
    );
  }
  const region = options.region?.trim();
  return {
    provider: "s3" as const,
    endpoint,
    bucket: options.bucket?.trim() ?? "",
    ...(region === undefined ? {} : { region }),
  };
}

/** A host key that stands in while the other fields are checked, before any connection. */
const UNCONFIRMED_KEY = "ssh-ed25519 AAAA";

/**
 * `snapshots.offsite` for a folder on the user's own machine over SFTP (`--to sftp`): its host,
 * port, user and absolute folder, checked by the plan schema before OpsCrew connects there (a
 * host is never read as `ssh-keyscan`'s option), then its host key, confirmed
 * ({@link confirmedHostKey}).
 * @throws OpsCrewError `INVALID_INPUT` for a relative folder or a value the schema refuses, and as
 * {@link confirmedHostKey}.
 */
async function ownMachine(run: SnapshotRun, options: OffsiteOnOptions, days: number) {
  const path = trimSlash(options.path?.trim() ?? "");
  if (!path.startsWith("/")) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `--path must be an absolute folder on the machine, such as /backups or /home/<user>/backups: a relative one would depend on where the account starts. ${NOTHING_CHANGED}`,
      { hint: "Give the folder from the machine's root, starting with /." },
    );
  }
  const host = options.host?.trim() ?? "";
  const machine = {
    provider: "sftp" as const,
    host,
    ...(options.port === undefined ? {} : { port: options.port }),
    user: options.user?.trim() ?? "",
    path,
    days,
  };
  withSnapshotSetting(
    run.plan,
    "offsite",
    { ...machine, hostKey: UNCONFIRMED_KEY },
    "copy the snapshots off the server",
  );
  const port = options.port ?? 22;
  const current = snapshotOffsiteOf(run.plan);
  const pinned =
    current?.provider === "sftp" && current.host === host && current.port === port
      ? hostKeyFingerprint(current.hostKey.split(" ")[1] ?? "")
      : undefined;
  const hostKey = await confirmedHostKey(run, {
    host,
    port,
    ...(options.hostKey === undefined ? {} : { given: options.hostKey.trim() }),
    ...(pinned === undefined ? {} : { pinned }),
  });
  return { ...machine, hostKey };
}

/** What `opscrew provision` does next for the copies at `to`, after "Run `opscrew provision` to". */
function provisionDoes(to: OffsiteProvider, user: string | undefined): string {
  if (plannedBucket(to)) {
    return "create the bucket after you approve its plan; it asks for the bucket's access key, which you create";
  }
  return to === "s3"
    ? `put the bucket's key on the server and check that it can write there; it asks for the key, which you create (in a script: ${OFFSITE_KEY_VARS.accessKeyId} and ${OFFSITE_KEY_VARS.secretAccessKey})`
    : `put the private key the file in ${OFFSITE_SFTP_KEY_VAR} holds on the server and check that it can write there; first add its public half to ~/.ssh/authorized_keys of ${user} on the machine`;
}

/**
 * `opscrew snapshot offsite on` (FR-2407, T2756): `snapshots.offsite` in the plan of the
 * environment `deps` belong to, written through the plan-writing path, with how long each copy is
 * kept (`--days`, the plan's, or 90):
 * - `--to r2|hetzner|digitalocean`: the bucket `<app>-<env>-backups` OpsCrew plans (or the one the
 *   plan names) and its region ({@link regionFor});
 * - `--to s3`: the user's own bucket, at its https:// endpoint ({@link ownBucket});
 * - `--to sftp`: a folder on the user's own machine, its host key confirmed ({@link ownMachine}).
 * The lines say what changed, the expected monthly cost or that OpsCrew prices nothing
 * ({@link offsitePriceText}), where the copies made so far stay when the place changes, and to run
 * provision.
 * @throws OpsCrewError `PHASE_PRECONDITION` for a site, a preview environment, this computer or an
 * environment without data, for R2 without a domain on Cloudflare, and for another bucket while
 * OpsCrew's exists; `INVALID_INPUT` for a flag `--to` doesn't take or needs, a region refused and a
 * value the plan schema refuses; as {@link confirmedHostKey}. Nothing is written then.
 */
export async function snapshotOffsiteOn(
  deps: PhaseDeps,
  options: OffsiteOnOptions,
): Promise<SnapshotSettingChange> {
  const run = await snapshotRun(deps);
  const { plan, flags } = run;
  const what = "copy the snapshots off the server";
  requireSettingsPlace(run, "offsite", what);
  checkFlags(run, options);
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
  const current = snapshotOffsiteOf(plan);
  const days = options.days ?? current?.days ?? 90;
  let value: NonNullable<NonNullable<DeployPlan["snapshots"]>["offsite"]>;
  if (to === "s3") {
    value = { ...ownBucket(options), days };
  } else if (to === "sftp") {
    value = await ownMachine(run, options, days);
  } else {
    const region = regionFor(run, to, options.region);
    const bucket = backupsBucketOf(plan)?.bucket ?? backupsBucketName(plan);
    await requireSameBucket(run, {
      provider: to,
      bucket,
      ...(region === undefined ? {} : { region }),
    });
    value = { provider: to, bucket, ...(region === undefined ? {} : { region }), days };
  }
  const after = withSnapshotSetting(plan, "offsite", value, what);
  const copy = snapshotOffsiteOf(after) as SnapshotOffsite;
  const before = current === undefined ? undefined : offsitePlace(plan, current);
  const place = offsitePlace(after, copy);
  return writeSnapshotSetting(
    run,
    after,
    [
      `The copy of ${run.environment}'s snapshots off the server (snapshots.offsite in ${planFile(plan)}): ${offsiteText(plan)} → ${offsiteText(after)}.`,
      ...(copy.provider === "sftp"
        ? [
            `The machine's host key, which you confirmed: ${copy.hostKey.split(" ")[0]} ${hostKeyFingerprint(copy.hostKey.split(" ")[1] ?? "")}; the copies go only to a machine that presents it.`,
          ]
        : []),
      "Each snapshot taken by hand or on the schedule is encrypted to the recovery copy's age key before it leaves the machine that holds the data, so only your key opens the copies.",
      offsitePriceText(to),
      ...(before !== undefined && before !== place
        ? [
            `The copies made so far stay in ${before}: OpsCrew never deletes them, and \`opscrew restore --from offsite\` reads only ${place} from now on.`,
          ]
        : []),
      provisionLine(run, provisionDoes(to, copy.provider === "sftp" ? copy.user : undefined)),
    ],
    `The copy of ${run.environment}'s snapshots off the server is already ${offsiteText(plan)}.`,
  );
}

/** Where to delete a bucket by hand at `provider`. */
const CONSOLES: Readonly<Record<BackupsBucketProvider, string>> = {
  r2: "Cloudflare's dashboard (R2 Object Storage)",
  hetzner: "the Hetzner Console (Object Storage)",
  digitalocean: "the DigitalOcean control panel (Spaces Object Storage)",
};

/** A backups bucket as the plan, the backups root's marker or its state names it. */
interface KnownBucket {
  bucket: string;
  /** `s3` when only the state names it, at Hetzner or DigitalOcean (both through S3). */
  provider: BackupsBucketProvider | "s3";
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
 * `snapshots.offsite` when OpsCrew plans it (`backupsBucketOf`), else the one the backups root's marker or state still names after
 * `snapshot offsite off`; undefined without one.
 */
async function existingBucket(run: SnapshotRun): Promise<KnownBucket | undefined> {
  const named = (o: { provider: BackupsBucketProvider; bucket: string; region: string }) => ({
    provider: o.provider,
    bucket: o.bucket,
    ...(o.provider === "r2" ? {} : { region: o.region }),
  });
  const current = backupsBucketOf(run.plan);
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
 * What stays after the copies are turned off, in a sentence: the bucket or folder and the copies
 * in it (D9: OpsCrew never deletes them), when they expire, and how to delete them.
 */
function copiesStayText(plan: Pick<DeployPlan, "app" | "environment">, offsite: SnapshotOffsite) {
  switch (offsite.provider) {
    case "s3":
      return `Your bucket ${offsite.bucket} and the copies in it stay: OpsCrew never deletes them, and with no more uploads nothing deletes the old ones. To delete them, delete the folder ${OFFSITE_PREFIX}/ in the bucket with your provider's console.`;
    case "sftp":
      return `The folder ${offsiteFolder(plan, offsite)} on ${offsite.host} and the copies in it stay: OpsCrew never deletes them, and with no more uploads nothing deletes the old ones. To delete them, delete that folder on the machine.`;
    default:
      // Spaces gets no lifecycle rule: the servers delete the old copies after each upload.
      return `The bucket ${offsite.bucket} and the copies in it stay: OpsCrew never deletes them${offsite.provider === "digitalocean" ? ", and with no more uploads nothing deletes the old ones" : `, and ${STORAGE_NAMES[offsite.provider]} expires each copy after ${offsite.days} days`}. To delete them sooner, empty and delete the bucket in ${CONSOLES[offsite.provider]}.`;
  }
}

/**
 * `opscrew snapshot offsite off`: `snapshots.offsite` removed from the plan, so no new copy is
 * uploaded. The bucket or folder and its copies stay (D9: OpsCrew never deletes them); the lines
 * say so, when they expire and how to delete them, and to run provision.
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
          copiesStayText(plan, offsite),
          provisionLine(run, "stop the uploads"),
        ];
  return writeSnapshotSetting(
    run,
    after,
    lines,
    `The copy of ${run.environment}'s snapshots off the server is already off.`,
  );
}
