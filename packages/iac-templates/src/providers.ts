import { OpsCrewError } from "@opscrew/core";
import type { CloudProvider, DeployTarget, PortainerDeployTarget } from "@opscrew/plan-schema";
import type { ProviderRequirement } from "./infra/hcl";

/**
 * The plain error for code reached with a target it does not handle. Every renderer is called
 * for the targets it knows, so this is a bug in OpsCrew.
 */
export function wrongTarget(message: string): OpsCrewError {
  return new OpsCrewError("PHASE_PRECONDITION", message, {
    hint: "This is a bug in OpsCrew: please report it with the command you ran.",
  });
}

/**
 * `target` when OpsCrew creates the server (Hetzner Cloud, DigitalOcean): a plan's target, a
 * server of a move layout, or just `{ provider }`. Throws {@link wrongTarget} for a server the
 * user owns, a Portainer target and the localhost target.
 */
export function cloudTarget<T extends Pick<DeployTarget, "provider">>(
  target: T,
): T & { provider: CloudProvider } {
  if (
    target.provider === "own" ||
    target.provider === "portainer" ||
    target.provider === "localhost"
  ) {
    throw wrongTarget(
      `This step only applies to servers OpsCrew creates on Hetzner Cloud or DigitalOcean, not to ${NOT_CLOUD[target.provider]}.`,
    );
  }
  return target as T & { provider: CloudProvider };
}

/** How {@link cloudTarget} names a target that is not a cloud server. */
const NOT_CLOUD = {
  own: "a server you already own",
  portainer: "an app in your existing Portainer",
  localhost: "an app on this computer (the localhost target)",
} as const;

/** `target` when the app runs in the user's existing Portainer; throws {@link wrongTarget} otherwise. */
export function portainerTarget(target: DeployTarget): PortainerDeployTarget {
  if (target.provider !== "portainer") {
    throw wrongTarget(
      "This step only applies to an app OpsCrew deploys into your existing Portainer.",
    );
  }
  return target;
}

/**
 * Provider-specific wording and HCL pieces for the rendered root module and the runbook. Hetzner
 * entries reproduce the text OpsCrew rendered before DigitalOcean support, byte for byte.
 */
export interface ProviderText {
  /** Short name used in possessives, for example "Hetzner's price list". */
  name: string;
  /** "server" or "Droplet". */
  serverNoun: string;
  /** Runbook "Server" row, for example `Hetzner Cloud cx23 in nbg1`. */
  serverLabel(serverType: string, location: string): string;
  /** Where the user edits things by hand, for example "Hetzner Console". */
  console: string;
  /** Vendored module directory of the server module. */
  module: string;
  /** Terraform provider local name, registry source and version constraint. */
  terraformProvider: ProviderRequirement;
  /** Environment variable the Terraform provider reads its token from. */
  tokenVar: string;
  /** Whether the server module has a `delete_protection` switch. */
  deleteProtection: boolean;
  /** Root variable descriptions that name the provider. */
  descriptions: { location: string; serverType: string; backups: string };
  /**
   * Arguments of a server module call after `source`, in order (name, value). `prefix` selects
   * the root variables of that server: `""` for `module "server"`, `"previous_"` for
   * `module "server_previous"`. The shared variables (app name, deploy key, CIDRs) and the labels
   * or tags are the same for both servers.
   */
  moduleArguments(prefix: VariablePrefix): readonly (readonly [string, string])[];
  /** Runbook texts. */
  runbook: {
    backupsOnDatabaseCell: string;
    backupsOn: string;
    cloudFirewall: string;
    /** What `opscrew destroy` deletes besides DNS, for the app named `app`. */
    deletes: (app: string) => string;
    /** Extra paragraph lines after "Connect to the server" (empty for none). */
    connectNote: readonly string[];
    snapshotReason: string;
    snapshotFirst: readonly string[];
    noSnapshot: readonly string[];
    deleteProtectionNote: readonly string[];
    /** "What remains" bullet; `backups` is whether the plan has automated backups on. */
    whatRemains: (repo: string, workflowPath: string, backups: boolean) => readonly string[];
    hostKey: string;
  };
}

/** Prefix of a server module's root variables: none for `module "server"`. */
export type VariablePrefix = "" | "previous_";

const COMMON_ARGUMENTS = {
  name: ["name", "var.app_name"],
  sshKey: ["ssh_public_key", "var.deploy_ssh_public_key"],
  sshCidrs: ["ssh_allowed_cidrs", "var.ssh_allowed_cidrs"],
  httpCidrs: ["http_allowed_cidrs", "var.http_allowed_cidrs"],
} as const;

/** Wording and HCL pieces of each provider OpsCrew creates servers on. */
export const PROVIDER_TEXT: Record<CloudProvider, ProviderText> = {
  hetzner: {
    name: "Hetzner",
    serverNoun: "server",
    serverLabel: (type, location) => `Hetzner Cloud ${type} in ${location}`,
    console: "Hetzner Console",
    module: "hetzner-vps",
    terraformProvider: { name: "hcloud", source: "hetznercloud/hcloud", version: "~> 1.70" },
    tokenVar: "HCLOUD_TOKEN",
    deleteProtection: true,
    descriptions: {
      location: "Hetzner Cloud location.",
      serverType: "Hetzner Cloud server type.",
      backups: "Hetzner automated backups.",
    },
    moduleArguments: (prefix) => [
      COMMON_ARGUMENTS.name,
      ["location", `var.${prefix}location`],
      ["server_type", `var.${prefix}server_type`],
      ["image", `var.${prefix}image`],
      ["backups", `var.${prefix}backups`],
      ["delete_protection", `var.${prefix}delete_protection`],
      COMMON_ARGUMENTS.sshKey,
      COMMON_ARGUMENTS.sshCidrs,
      COMMON_ARGUMENTS.httpCidrs,
      ["labels", '{ "managed-by" = "opscrew", app = var.app_name }'],
    ],
    runbook: {
      backupsOnDatabaseCell: "Hetzner automated backups are on",
      backupsOn:
        "Hetzner takes a backup of the whole server every day and keeps the last seven (Hetzner Console → your server → Backups).",
      cloudFirewall: "the Hetzner firewall",
      deletes: () => "the server, its firewall and SSH key",
      connectNote: [],
      snapshotReason: "automated backups are on for this server",
      snapshotFirst: [
        "OpsCrew takes a Hetzner snapshot of the server",
        "  before deleting it (skip it with `--no-snapshot`). Hetzner's automated backups are deleted together with",
        "  the server, so the snapshot is the only copy that remains.",
      ],
      noSnapshot: [
        "- **Snapshot:** this app keeps no database on the server and backups are off, so OpsCrew does not take a snapshot",
        "  before deleting the server. Hetzner's automated backups would be deleted together with the server.",
      ],
      deleteProtectionNote: [],
      whatRemains: (repo, workflowPath) => [
        "- **What remains:** the snapshot, if one was taken (Hetzner bills it per GB per month at the rate listed on",
        "  https://www.hetzner.com/cloud until you delete it in Hetzner Console → Snapshots), the container images in",
        `  GitHub Container Registry (\`ghcr.io/${repo}\`), and the files in this repository (\`opscrew/\` and`,
        `  \`${workflowPath}\`).`,
      ],
      hostKey: "the server's host key",
    },
  },
  digitalocean: {
    name: "DigitalOcean",
    serverNoun: "Droplet",
    serverLabel: (type, location) => `DigitalOcean Droplet ${type} in ${location}`,
    console: "the DigitalOcean control panel",
    module: "digitalocean-droplet",
    terraformProvider: {
      name: "digitalocean",
      source: "digitalocean/digitalocean",
      version: "~> 2.106",
    },
    tokenVar: "DIGITALOCEAN_TOKEN",
    deleteProtection: false,
    descriptions: {
      location: "DigitalOcean region.",
      serverType: "DigitalOcean Droplet size.",
      backups: "DigitalOcean daily backups.",
    },
    moduleArguments: (prefix) => [
      COMMON_ARGUMENTS.name,
      ["region", `var.${prefix}location`],
      ["size", `var.${prefix}server_type`],
      ["image", `var.${prefix}image`],
      ["backups", `var.${prefix}backups`],
      COMMON_ARGUMENTS.sshKey,
      COMMON_ARGUMENTS.sshCidrs,
      COMMON_ARGUMENTS.httpCidrs,
      // biome-ignore lint/suspicious/noTemplateCurlyInString: HCL interpolation, not JavaScript.
      ["app_tag", '"opscrew-app:${var.app_name}"'],
      ["shared_tags", '["managed-by:opscrew"]'],
    ],
    runbook: {
      backupsOnDatabaseCell: "DigitalOcean daily backups are on",
      backupsOn:
        "DigitalOcean takes a backup of the whole Droplet every day (control panel at https://cloud.digitalocean.com/ → your Droplet → Backups). Each backup expires four weeks after it was taken, also after the Droplet is deleted.",
      cloudFirewall: "the DigitalOcean cloud firewall",
      deletes: (app) => `the Droplet, its firewall, SSH key and app tag (\`opscrew-app:${app}\`)`,
      connectNote: [
        "The web Droplet Console in the DigitalOcean control panel cannot log in as root (root SSH login is disabled and",
        "only `deploy` may log in); the Recovery Console still works if you ever need it.",
        "",
      ],
      snapshotReason: "daily backups are on for this Droplet",
      snapshotFirst: [
        "OpsCrew takes a DigitalOcean snapshot of the Droplet",
        "  before deleting it (skip it with `--no-snapshot`). DigitalOcean keeps daily backups after the Droplet is deleted,",
        "  but each one expires four weeks after it was taken, so the snapshot is the only copy that stays.",
      ],
      noSnapshot: [
        "- **Snapshot:** this app keeps no database on the Droplet and backups are off, so OpsCrew does not take a snapshot",
        "  before deleting the Droplet.",
      ],
      deleteProtectionNote: [
        "- **No delete protection:** DigitalOcean has no delete protection for Droplets. Deleting the Droplet in the",
        "  control panel removes it and its data immediately; `opscrew destroy` is the safe way, because it shows the plan,",
        "  offers a snapshot and asks for the typed name first.",
      ],
      whatRemains: (repo, workflowPath, backups) => [
        "- **What remains:** the snapshot, if one was taken (DigitalOcean bills it per GB per month at the rate listed on",
        "  https://www.digitalocean.com/pricing until you delete it in the control panel at https://cloud.digitalocean.com/),",
        ...(backups
          ? [
              "  the daily backups DigitalOcean already took (each is kept for up to four weeks after it was taken, then expires),",
            ]
          : []),
        "  the `managed-by:opscrew` tag (other OpsCrew apps in this account may use it), the container images in GitHub",
        `  Container Registry (\`ghcr.io/${repo}\`), and the files in this repository (\`opscrew/\` and \`${workflowPath}\`).`,
      ],
      hostKey: "the Droplet's host key",
    },
  },
};
