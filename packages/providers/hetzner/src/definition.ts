import type {
  CloudProviderDefinition,
  ModuleCall,
  PlannedFirewallRule,
  PlannedResourceJson,
} from "@opscrew/contracts";
import { isRecord } from "@opscrew/core";
import { HETZNER_TOKEN_HINT } from "./client";
import { HETZNER_CREDENTIALS, hetznerConnector } from "./connector";
import { MODULE_FILES } from "./generated/module";

/**
 * Hetzner's price page. Snapshot texts link to it instead of quoting a rate, so they never go
 * stale when the price changes.
 */
const HETZNER_PRICING_URL = "https://www.hetzner.com/cloud";

const COMMON_ARGUMENTS = {
  sshKey: ["ssh_public_key", "var.deploy_ssh_public_key"],
  sshCidrs: ["ssh_allowed_cidrs", "var.ssh_allowed_cidrs"],
} as const;

/** The server's name: the app's, or `<app>-<name>` for an extra server. */
function nameArgument({ extra }: ModuleCall): readonly [string, string] {
  return ["name", extra === undefined ? "var.app_name" : `"\${var.app_name}-${extra}"`];
}

/** The web's CIDRs, only on the server that serves the web (not on an extra server). */
function httpArguments({ extra }: ModuleCall): (readonly [string, string])[] {
  return extra === undefined ? [["http_allowed_cidrs", "var.http_allowed_cidrs"]] : [];
}

/** The `rule` blocks of an `hcloud_firewall`. */
function firewallRules(resource: PlannedResourceJson): PlannedFirewallRule[] {
  const rules = resource.values.rule;
  return Array.isArray(rules) ? rules.filter(isRecord).map((r) => r as PlannedFirewallRule) : [];
}

/** True when an attribute has a non-empty known value or will be set during apply. */
function isSet(resource: PlannedResourceJson, attribute: string): boolean {
  const value = resource.values[attribute];
  if (Array.isArray(value)) return value.length > 0 || resource.unknown[attribute] !== undefined;
  if (value !== undefined && value !== null && value !== "") return true;
  const unknown = resource.unknown[attribute];
  return unknown === true || (Array.isArray(unknown) && unknown.length > 0);
}

/** Hetzner Cloud as a cloud server provider (ADR 0029). */
export const definition: CloudProviderDefinition = {
  contractVersion: 1,
  id: "hetzner",
  displayName: "Hetzner Cloud",
  name: "Hetzner",
  serverNoun: "server",
  sizeNoun: "server type",
  consoleUrl: "https://console.hetzner.cloud/",
  accountUrl: "https://console.hetzner.cloud/",
  credentials: {
    envVars: HETZNER_CREDENTIALS.envVars,
    mode: "any",
    createUrl: HETZNER_CREDENTIALS.createUrl,
    tokenRules: [
      {
        id: "hcloud-token",
        title: "Hetzner Cloud API token",
        severity: "critical",
        pattern:
          /(?:hcloud|hetzner)[A-Za-z0-9_]{0,40}token["']?\s*(?::=|=>|[=:])\s*["']?([A-Za-z0-9]{64})(?![A-Za-z0-9])/gi,
        group: 1,
        description:
          "A Hetzner Cloud API token is written in this file. It can create, change and delete servers in your Hetzner project.",
      },
    ],
    envPrefixes: ["HCLOUD", "HETZNER"],
    apiPattern: /api\.hetzner\.cloud|hcloud_|token_readonly/i,
  },
  connector: (deps) => hetznerConnector(deps),
  regions: {
    locations: {
      "eu-central": ["nbg1", "fsn1"],
      "eu-north": ["hel1"],
      "us-east": ["ash"],
      "us-west": ["hil"],
      "ap-southeast": ["sin"],
    },
    locationNames: {
      nbg1: "Nuremberg",
      fsn1: "Falkenstein",
      hel1: "Helsinki",
      ash: "Ashburn",
      hil: "Hillsboro",
      sin: "Singapore",
    },
    notes: {},
    coordinates: {
      fsn1: [50.4779, 12.3713],
      nbg1: [49.4521, 11.0767],
      hel1: [60.1699, 24.9384],
      ash: [39.0438, -77.4874],
      hil: [45.5229, -122.9898],
      sin: [1.3521, 103.8198],
    },
  },
  offering: {
    currency: "EUR",
    defaultImage: "ubuntu-24.04",
    backupPercent: 20,
    providerBackups: true,
    backupsOutliveServer: false,
    snapshots: { kind: "per-gb" },
    serverSnapshotsOutliveServer: true,
    deleteProtection: true,
    resize: true,
    offAfterRefusedResize: true,
    removal: { kind: "delete" },
    unavailable:
      /resource_unavailable|out of stock|unsupported location|error during placement|(?<!service )unavailable/i,
    serverLimit: /resource_limit_exceeded|server limit/i,
  },
  terraform: {
    provider: { name: "hcloud", source: "hetznercloud/hcloud", version: "~> 1.70" },
    serverResourceType: "hcloud_server",
    firewallResourceType: "hcloud_firewall",
    mirroredAttributes: { hcloud_firewall: ["apply_to"] },
    module: { name: "hetzner-vps", files: MODULE_FILES },
    credentialsComment:
      "Token from the HCLOUD_TOKEN environment variable (never stored in files or state).",
    deleteProtectionVariable: true,
    descriptions: {
      location: "Hetzner Cloud location.",
      serverType: "Hetzner Cloud server type.",
      backups: "Hetzner automated backups.",
    },
    moduleArguments: (call) => [
      nameArgument(call),
      ["location", `var.${call.prefix}location`],
      ["server_type", `var.${call.prefix}server_type`],
      ["image", `var.${call.prefix}image`],
      ["backups", `var.${call.prefix}backups`],
      ["delete_protection", `var.${call.prefix}delete_protection`],
      COMMON_ARGUMENTS.sshKey,
      COMMON_ARGUMENTS.sshCidrs,
      ...httpArguments(call),
      ["labels", '{ "managed-by" = "opscrew", app = var.app_name }'],
    ],
    extraShared: {
      resources: [
        "# The deploy key of the app's servers on Hetzner Cloud, kept here so that removing a server",
        "# never deletes it (Hetzner refuses the same key twice). The servers get its id through",
        "# coalesce, whose result is known not to be null before apply, so their own key's count is known.",
        'resource "hcloud_ssh_key" "deploy" {',
        // biome-ignore lint/suspicious/noTemplateCurlyInString: HCL interpolation, not JavaScript.
        '  name       = "${var.app_name}-deploy"',
        "  public_key = var.deploy_ssh_public_key",
        '  labels     = { "managed-by" = "opscrew", app = var.app_name }',
        "}",
        "",
      ],
      sshKeyId: "coalesce(hcloud_ssh_key.deploy.id)",
    },
  },
  texts: {
    resizeOffline:
      "The app is offline one to three minutes while Hetzner Cloud restarts the server on its new type; its addresses stay the same",
    rotate: {
      deleteToken: `the Hetzner Cloud Console (${HETZNER_CREDENTIALS.createUrl} → your project → Security → API tokens)`,
    },
    interview: {
      label: "Hetzner Cloud",
      hint: "lowest prices; servers in Germany, Finland, the US and Singapore",
    },
    design: { summaryNoun: "server", titleSuffix: "", livePricesVar: "HCLOUD_TOKEN" },
    init: {
      fix: `Create a Read & Write API token in the Hetzner Cloud Console (${HETZNER_CREDENTIALS.createUrl} → your project → Security → API tokens) and set it as HCLOUD_TOKEN.`,
      scopeNote: "",
    },
    runbook: {
      serverLabel: (type, location) => `Hetzner Cloud ${type} in ${location}`,
      console: "Hetzner Console",
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
      whatRemains: (image, folder, workflowPath) => [
        "- **What remains:** the snapshot, if one was taken (Hetzner bills it per GB per month at the rate listed on",
        "  https://www.hetzner.com/cloud until you delete it in Hetzner Console → Snapshots), the container images in",
        `  GitHub Container Registry (\`${image}\`), and the files in this repository (\`${folder}/\` and`,
        `  \`${workflowPath}\`).`,
      ],
      hostKey: "the server's host key",
    },
    destroy: {
      console: "the Hetzner Cloud Console",
      snapshotRef: (id) => `Hetzner image ${id}`,
      snapshotBilling: `Hetzner bills snapshots per GB per month at the rate listed on ${HETZNER_PRICING_URL}`,
      snapshotBilled: `billed per GB per month at the rate listed on ${HETZNER_PRICING_URL}`,
      lookup: (app) => `labelled managed-by=opscrew,app=${app}`,
      tokenHint: () => HETZNER_TOKEN_HINT,
      deletedBackups: "Hetzner's automatic backups of the server",
      storageConsole: "the Hetzner Cloud Console (Object Storage)",
    },
    secops: {
      noun: "server",
      rules: firewallRules,
      attached: (server) => isSet(server, "firewall_ids"),
      attachedText: "The server is attached to a Hetzner Cloud firewall.",
      unattachedText:
        "The server has no firewall attached, so every port is reachable from the internet. Attach the OpsCrew firewall.",
      keylessText:
        "The server has no SSH key; Hetzner would create a root password. Add the deploy key.",
      backupsText: "Hetzner automated backups are enabled as the plan requires.",
    },
  },
};
