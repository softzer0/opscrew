import type { DeployPlan, SnapshotOffsite } from "@opscrew/plan-schema";
import { type PinArch, TOOLS, toolDownloadUrl } from "./pins";
import { STORAGE_NAMES } from "./prices";
import { shellQuote } from "./runtime/services";

/**
 * The folder every object of the off-server copy is under (`backups/<id>/<file>.age`, 024 plan.md
 * 1.), which the `backups` root's lifecycle rule expires; in the user's own bucket or SFTP folder,
 * under the environment's own folder ({@link offsiteRoot}). Servers and Portainer upload under it.
 */
export const OFFSITE_PREFIX = "backups";

/**
 * rclone's S3 provider (`RCLONE_CONFIG_*_PROVIDER`) for each off-server copy's bucket: the user's
 * own S3-compatible bucket (`s3`) is `Other`, which signs as AWS does and needs only the endpoint.
 */
export const RCLONE_PROVIDERS = {
  r2: "Cloudflare",
  hetzner: "Hetzner",
  digitalocean: "DigitalOcean",
  s3: "Other",
} as const;

/**
 * rclone's settings of the remote `offsite` that `copy` (`snapshots.offsite`) names, as
 * `RCLONE_CONFIG_OFFSITE_*` variables, none of them secret:
 * - a bucket: S3, its provider and region, and no bucket check (the bucket exists: rclone never
 *   tries to create it); the endpoint and the key come from where each copy runs
 *   ({@link offsiteLogin});
 * - an SFTP machine: its host, port and user, its host key pinned (`host_keys`: a machine that
 *   presents another key is refused), and no shell (`shell_type none`: rclone runs no command
 *   there, only SFTP); the private key comes from where each copy runs.
 */
export function rcloneSettings(
  copy:
    | { provider: keyof typeof RCLONE_PROVIDERS; region: string }
    | Pick<
        Extract<SnapshotOffsite, { provider: "sftp" }>,
        "provider" | "host" | "port" | "user" | "hostKey"
      >,
): Record<string, string> {
  if (copy.provider === "sftp") {
    return {
      RCLONE_CONFIG_OFFSITE_TYPE: "sftp",
      RCLONE_CONFIG_OFFSITE_HOST: copy.host,
      RCLONE_CONFIG_OFFSITE_PORT: String(copy.port),
      RCLONE_CONFIG_OFFSITE_USER: copy.user,
      RCLONE_CONFIG_OFFSITE_HOST_KEYS: copy.hostKey,
      RCLONE_CONFIG_OFFSITE_SHELL_TYPE: "none",
    };
  }
  return {
    RCLONE_CONFIG_OFFSITE_TYPE: "s3",
    RCLONE_CONFIG_OFFSITE_PROVIDER: RCLONE_PROVIDERS[copy.provider],
    RCLONE_CONFIG_OFFSITE_REGION: copy.region,
    RCLONE_CONFIG_OFFSITE_NO_CHECK_BUCKET: "true",
  };
}

/**
 * The variables of the off-server copy (`snapshots.offsite`), set like the services' secrets: in
 * Portainer the stack's, on a server the lines of its `offsite.env`. A bucket's S3 endpoint and
 * key, or an SFTP machine's private key (`sshKey`, on one line, its line ends written `\n` as
 * rclone's `key_pem` reads it), and the recovery copy's age recipient. Which ones a copy has:
 * {@link offsiteVariables}.
 */
export const PORTAINER_OFFSITE_VARIABLES = {
  endpoint: "OPSCREW_OFFSITE_ENDPOINT",
  accessKeyId: "OPSCREW_OFFSITE_ACCESS_KEY_ID",
  secretAccessKey: "OPSCREW_OFFSITE_SECRET_ACCESS_KEY",
  sshKey: "OPSCREW_OFFSITE_SSH_KEY",
  recipient: "OPSCREW_OFFSITE_RECIPIENT",
} as const;

/**
 * The rclone settings each copy reads from {@link PORTAINER_OFFSITE_VARIABLES}, by setting: a
 * bucket's endpoint and key, or an SFTP machine's private key (`key_pem`).
 */
export function offsiteLogin(copy: Pick<SnapshotOffsite, "provider">): Record<string, string> {
  const v = PORTAINER_OFFSITE_VARIABLES;
  if (copy.provider === "sftp") return { RCLONE_CONFIG_OFFSITE_KEY_PEM: v.sshKey };
  return {
    RCLONE_CONFIG_OFFSITE_ENDPOINT: v.endpoint,
    RCLONE_CONFIG_OFFSITE_ACCESS_KEY_ID: v.accessKeyId,
    RCLONE_CONFIG_OFFSITE_SECRET_ACCESS_KEY: v.secretAccessKey,
  };
}

/** The variables `copy` needs: its login's ({@link offsiteLogin}) and the age recipient. */
export function offsiteVariables(copy: Pick<SnapshotOffsite, "provider">): string[] {
  return [...Object.values(offsiteLogin(copy)), PORTAINER_OFFSITE_VARIABLES.recipient];
}

/**
 * The environment's name for its off-server copies, `<app>-<env>` (`shop-prod` for prod,
 * `shop-staging` for staging: another environment's app is already named `<app>-<env>`): the folder
 * of its copies in the user's own bucket or SFTP folder, so two apps or environments sharing one
 * never mix their copies, and the start of the backups bucket's name.
 */
export function offsiteFolderName(plan: Pick<DeployPlan, "app" | "environment">): string {
  return `${plan.app.name}${plan.environment === undefined ? "-prod" : ""}`;
}

/**
 * Where the copies are, as rclone names it: `offsite:<bucket>/backups` in the bucket OpsCrew plans
 * (one per environment), `offsite:<bucket>/<app>-<env>/backups` in the user's own bucket, and
 * `offsite:<path>/<app>-<env>/backups` on an SFTP machine ({@link offsiteFolderName}). Each copy is
 * `<id>/<file>.age` under it.
 */
export function offsiteRoot(
  plan: Pick<DeployPlan, "app" | "environment">,
  copy: SnapshotOffsite,
): string {
  const folder = `${offsiteFolderName(plan)}/${OFFSITE_PREFIX}`;
  switch (copy.provider) {
    case "sftp":
      return `offsite:${copy.path === "/" ? "" : copy.path}/${folder}`;
    case "s3":
      return `offsite:${copy.bucket}/${folder}`;
    default:
      return `offsite:${copy.bucket}/${OFFSITE_PREFIX}`;
  }
}

/** The folder of the copies in rclone's path, as {@link offsiteRoot} without `offsite:`. */
export function offsiteFolder(
  plan: Pick<DeployPlan, "app" | "environment">,
  copy: SnapshotOffsite,
): string {
  return offsiteRoot(plan, copy).slice("offsite:".length);
}

/**
 * Where `copy`'s copies are, in words, with no secret: `the private bucket shop-staging-backups on
 * Cloudflare R2`, `your bucket shop-backups at https://s3.example.com (us-east-1)`, `the folder
 * /backups/shop-prod/backups on backup.example.com`.
 */
export function offsitePlace(
  plan: Pick<DeployPlan, "app" | "environment">,
  copy: SnapshotOffsite,
): string {
  switch (copy.provider) {
    case "s3":
      return `your bucket ${copy.bucket} at ${copy.endpoint} (${copy.region})`;
    case "sftp":
      return `the folder ${offsiteFolder(plan, copy)} on ${copy.host}${copy.port === 22 ? "" : ` (port ${copy.port})`}`;
    default:
      return `the private bucket ${copy.bucket} on ${STORAGE_NAMES[copy.provider]}${copy.provider === "r2" ? "" : ` (${copy.region})`}`;
  }
}

/**
 * The command that deletes the copies under `root` older than `snapshots.offsite.days`, where the
 * storage expires nothing itself (DigitalOcean Spaces, the user's own bucket or SFTP machine). On
 * an SFTP machine it then removes the folders that left empty (`rmdirs`, which leaves every folder
 * that still holds a file), in braces, so a caller can follow it with `||`.
 */
export function offsiteRetention(
  copy: Pick<SnapshotOffsite, "provider" | "days">,
  root: string,
): string {
  const old = `rclone delete --min-age ${copy.days}d ${shellQuote(root)}`;
  return copy.provider === "sftp"
    ? `{ ${old} && rclone rmdirs --leave-root ${shellQuote(root)}; }`
    : old;
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
