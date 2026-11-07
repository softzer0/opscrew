import { type PinArch, TOOLS, toolDownloadUrl } from "./pins";
import { shellQuote } from "./runtime/services";

/**
 * The prefix of every object of the off-server copy (`backups/<id>/<file>.age`, 024 plan.md 1.),
 * which the `backups` root's lifecycle rule expires. Servers and Portainer upload under it.
 */
export const OFFSITE_PREFIX = "backups";

/** rclone's S3 provider (`RCLONE_CONFIG_*_PROVIDER`) for each off-server copy's bucket. */
export const RCLONE_PROVIDERS = {
  r2: "Cloudflare",
  hetzner: "Hetzner",
  digitalocean: "DigitalOcean",
} as const;

/**
 * rclone's settings of the remote `offsite` that `copy` (`snapshots.offsite`) names, as
 * `RCLONE_CONFIG_OFFSITE_*` variables: S3, its provider and region, and no bucket check (the bucket
 * exists: rclone never tries to create it). The endpoint and the key come from where each copy
 * runs.
 */
export function rcloneSettings(copy: {
  provider: keyof typeof RCLONE_PROVIDERS;
  region: string;
}): Record<string, string> {
  return {
    RCLONE_CONFIG_OFFSITE_TYPE: "s3",
    RCLONE_CONFIG_OFFSITE_PROVIDER: RCLONE_PROVIDERS[copy.provider],
    RCLONE_CONFIG_OFFSITE_REGION: copy.region,
    RCLONE_CONFIG_OFFSITE_NO_CHECK_BUCKET: "true",
  };
}

/** Where `age_ok` unpacks the age binary for one run, in a one-off of the pinned rclone image. */
export const AGE_BINARY = "/tmp/age/age/age";

/**
 * The three sh functions, one line each, that make the pinned age ready at {@link AGE_BINARY} in a
 * one-off of the pinned rclone image (024 D10, research R7 S2), the release archive kept at
 * `/tools/age.tar.gz`: `age_ok` checks the archive against its pinned SHA-256 and unpacks the
 * binary for this run only; `age_fetch` fetches the archive with `rclone copyurl` into the tools
 * folder, then runs `age_ok`; `age_ready` runs `age_ok`, else `age_fetch`, and says so on stderr
 * when neither made age ready. Servers' `snapshot.sh` and Portainer's `offsite` service both run
 * them, `age_ready` before each use.
 */
export function ageFunctions(arch: PinArch): string[] {
  const fetch = [
    "rm -rf /tmp/age && mkdir /tmp/age",
    `rclone copyurl ${shellQuote(toolDownloadUrl("age", arch))} /tmp/age/age.tar.gz`,
    "mv /tmp/age/age.tar.gz /tools/age.tar.gz.new && mv /tools/age.tar.gz.new /tools/age.tar.gz",
    "age_ok",
  ];
  const ok = [
    `echo ${shellQuote(`${TOOLS.age.sha256[arch]}  /tools/age.tar.gz`)} | sha256sum -c -s`,
    "rm -rf /tmp/age && mkdir /tmp/age",
    "tar -xzf /tools/age.tar.gz -C /tmp/age age/age",
  ];
  return [
    `age_ok() { ${ok.join(" && ")}; }`,
    `age_fetch() { ${fetch.join(" && ")}; }`,
    "age_ready() { age_ok || age_fetch || { echo 'OpsCrew: age could not be fetched and checked against its pinned SHA-256.' >&2; return 1; }; }",
  ];
}
