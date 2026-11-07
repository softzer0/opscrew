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
 * The two sh functions, one line each, that make the pinned age ready at `/tools/age` in a one-off
 * of the pinned rclone image (024 D10, research R7 S2): `age_ok` checks the binary against its
 * pinned SHA-256; `age_fetch` fetches the release archive with `rclone copyurl`, checks its
 * SHA-256, unpacks the binary and checks its SHA-256 before it is kept, and removes what it
 * fetched. Servers' `snapshot.sh` and Portainer's `offsite` service both run them.
 */
export function ageFunctions(arch: PinArch): string[] {
  const { sha256, binarySha256 } = TOOLS.age;
  const fetch = [
    "rm -rf /tmp/age && mkdir /tmp/age",
    `rclone copyurl ${shellQuote(toolDownloadUrl("age", arch))} /tmp/age/age.tar.gz`,
    `echo ${shellQuote(`${sha256[arch]}  /tmp/age/age.tar.gz`)} | sha256sum -c -s`,
    "tar -xzf /tmp/age/age.tar.gz -C /tmp/age age/age",
    `echo ${shellQuote(`${binarySha256[arch]}  /tmp/age/age/age`)} | sha256sum -c -s`,
    "mv /tmp/age/age/age /tools/age.new && mv /tools/age.new /tools/age",
  ];
  return [
    `age_ok() { echo ${shellQuote(`${binarySha256[arch]}  /tools/age`)} | sha256sum -c -s; }`,
    `age_fetch() { ${fetch.join(" && ")}; _age=$?; rm -rf /tmp/age; return "$_age"; }`,
  ];
}
