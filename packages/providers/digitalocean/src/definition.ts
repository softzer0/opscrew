import type { CloudProviderDefinition, ModuleCall } from "@opscrew/contracts";
import { TOKEN_PATTERNS } from "@opscrew/core";
import { DIGITALOCEAN_CREDENTIALS, digitaloceanConnector } from "./connector";
import { MODULE_FILES } from "./generated/module";
import { SECOPS } from "./secops";

const DISPLAY_NAME = "DigitalOcean";
const TOKEN_VARS = ["DIGITALOCEAN_TOKEN", "DIGITALOCEAN_ACCESS_TOKEN"] as const;
const TOKEN_URL = DIGITALOCEAN_CREDENTIALS.createUrl;
const CONSOLE = "the DigitalOcean control panel";
/** The price page: snapshot texts link to it instead of quoting a rate, so they never go stale. */
const PRICING_URL = "https://www.digitalocean.com/pricing";
const SCOPES = DIGITALOCEAN_CREDENTIALS.scopes.join(", ");

const COMMON_ARGUMENTS = {
  sshKey: ["ssh_public_key", "var.deploy_ssh_public_key"],
  sshCidrs: ["ssh_allowed_cidrs", "var.ssh_allowed_cidrs"],
} as const;

/** The Droplet's name: the app's, or `<app>-<name>` for an extra Droplet. */
function nameArgument({ extra }: ModuleCall): readonly [string, string] {
  return ["name", extra === undefined ? "var.app_name" : `"\${var.app_name}-${extra}"`];
}

/** The web's CIDRs, only on the Droplet that serves the web (not on an extra Droplet). */
function httpArguments({ extra }: ModuleCall): (readonly [string, string])[] {
  return extra === undefined ? [["http_allowed_cidrs", "var.http_allowed_cidrs"]] : [];
}

/** DigitalOcean, as OpsCrew creates Droplets there (ADR 0029). */
export const definition: CloudProviderDefinition = {
  contractVersion: 1,
  id: "digitalocean",
  displayName: DISPLAY_NAME,
  name: "DigitalOcean",
  serverNoun: "Droplet",
  sizeNoun: "size",
  consoleUrl: "https://cloud.digitalocean.com/",
  accountUrl: "https://cloud.digitalocean.com/account",
  credentials: {
    envVars: TOKEN_VARS,
    mode: "any",
    createUrl: TOKEN_URL,
    tokenRules: [
      {
        id: "digitalocean-token",
        title: "DigitalOcean API token",
        severity: "critical",
        pattern: TOKEN_PATTERNS["digitalocean-token"],
        description:
          "A DigitalOcean API token is written in this file. Depending on its scopes it can create, change and delete Droplets, firewalls and other resources in your DigitalOcean team.",
      },
    ],
    envPrefixes: ["DIGITALOCEAN"],
    apiPattern: /api\.digitalocean\.com|digitalocean_/i,
  },
  connector: (deps) => digitaloceanConnector(deps),
  regions: {
    locations: {
      "eu-central": ["fra1", "ams3"],
      "eu-north": ["ams3"],
      "us-east": ["nyc3", "nyc1", "atl1"],
      "us-west": ["sfo3"],
      "ap-southeast": ["sgp1"],
    },
    locationNames: {
      fra1: "Frankfurt",
      ams3: "Amsterdam",
      lon1: "London",
      nyc1: "New York",
      nyc3: "New York",
      atl1: "Atlanta",
      sfo3: "San Francisco",
      tor1: "Toronto",
      sgp1: "Singapore",
      blr1: "Bangalore",
      syd1: "Sydney",
    },
    notes: {
      "eu-north":
        "DigitalOcean has no data centre in northern Europe, so OpsCrew uses Amsterdam, the closest one.",
    },
    coordinates: {
      nyc1: [40.7128, -74.006],
      nyc2: [40.7128, -74.006],
      nyc3: [40.7128, -74.006],
      sfo2: [37.7749, -122.4194],
      sfo3: [37.7749, -122.4194],
      tor1: [43.6532, -79.3832],
      atl1: [33.749, -84.388],
      ric1: [37.5407, -77.436],
      mkc1: [39.0997, -94.5786],
      mem1: [35.1495, -90.049],
      ams3: [52.3676, 4.9041],
      lon1: [51.5074, -0.1278],
      fra1: [50.1109, 8.6821],
      sgp1: [1.3521, 103.8198],
      blr1: [12.9716, 77.5946],
      syd1: [-33.8688, 151.2093],
    },
  },
  offering: {
    currency: "USD",
    defaultImage: "ubuntu-24-04-x64",
    backupPercent: 30,
    providerBackups: true,
    backupsOutliveServer: true,
    snapshots: { kind: "per-gb" },
    serverSnapshotsOutliveServer: true,
    deleteProtection: false,
    resize: true,
    offAfterRefusedResize: false,
    removal: { kind: "delete" },
    unavailable:
      /(size|image|region) is not available|not available in (this|the selected) region|(?<!service (temporarily )?)unavailable|out of stock/i,
    serverLimit: /droplet limit|droplet quota|exceed(s|ed)? (your|the) droplet/i,
  },
  terraform: {
    provider: {
      name: "digitalocean",
      source: "digitalocean/digitalocean",
      version: "~> 2.106",
    },
    serverResourceType: "digitalocean_droplet",
    firewallResourceType: "digitalocean_firewall",
    connectorFirewall: false,
    connectorRemoval: false,
    homeCacheFiles: [],
    mirroredAttributes: {},
    lifecycleIgnored: ["image", "ssh_keys", "user_data"],
    module: { name: "digitalocean-droplet", files: MODULE_FILES },
    credentialsComment:
      "Token from the DIGITALOCEAN_TOKEN environment variable (never stored in files or state).",
    deleteProtectionVariable: false,
    descriptions: {
      location: "DigitalOcean region.",
      serverType: "DigitalOcean Droplet size.",
      backups: "DigitalOcean daily backups.",
    },
    moduleArguments: (call) => [
      nameArgument(call),
      ["region", `var.${call.prefix}location`],
      ["size", `var.${call.prefix}server_type`],
      ["image", `var.${call.prefix}image`],
      ["backups", `var.${call.prefix}backups`],
      COMMON_ARGUMENTS.sshKey,
      COMMON_ARGUMENTS.sshCidrs,
      ...httpArguments(call),
      // One place manages the app's tag; the app's other Droplets get it by name from there.
      ...(call.appTag === undefined
        ? ([
            // biome-ignore lint/suspicious/noTemplateCurlyInString: HCL interpolation, not JavaScript.
            ["app_tag", '"opscrew-app:${var.app_name}"'],
            ["shared_tags", '["managed-by:opscrew"]'],
          ] as const)
        : ([["shared_tags", `[${call.appTag}, "managed-by:opscrew"]`]] as const)),
    ],
    extraShared: {
      resources: [
        "# The deploy key and the app's tag of the app's Droplets, kept here so that removing a Droplet",
        "# never deletes them (DigitalOcean refuses the same key twice). The Droplets get the key's id",
        "# through coalesce, whose result is known not to be null before apply, so their own key's count",
        "# is known.",
        'resource "digitalocean_ssh_key" "deploy" {',
        // biome-ignore lint/suspicious/noTemplateCurlyInString: HCL interpolation, not JavaScript.
        '  name       = "${var.app_name}-deploy"',
        "  public_key = var.deploy_ssh_public_key",
        "}",
        "",
        'resource "digitalocean_tag" "app" {',
        // biome-ignore lint/suspicious/noTemplateCurlyInString: HCL interpolation, not JavaScript.
        '  name = "opscrew-app:${var.app_name}"',
        "}",
        "",
      ],
      sshKeyId: "coalesce(digitalocean_ssh_key.deploy.id)",
      appTag: "digitalocean_tag.app.name",
    },
  },
  texts: {
    resizeOffline:
      "The app is offline while DigitalOcean resizes the Droplet: about a minute per GB of disk in use, often less; its addresses stay the same",
    rotate: { deleteToken: TOKEN_URL },
    interview: {
      label: "DigitalOcean",
      hint: "use your DigitalOcean account; data centres in Germany, the Netherlands, the US and Singapore; prices in USD",
    },
    design: {
      summaryNoun: "DigitalOcean Droplet",
      titleSuffix: " on DigitalOcean",
      livePricesVar: TOKEN_VARS[0],
    },
    init: {
      fix: `Create a personal access token with custom scopes at ${TOKEN_URL}, select these scopes (${SCOPES}), and set ${TOKEN_VARS[0]} to it.`,
      scopeNote: ` ${DISPLAY_NAME} cannot report which scopes a token has, so make sure it has these (${SCOPES}).`,
    },
    runbook: {
      serverLabel: (type, location) => `DigitalOcean Droplet ${type} in ${location}`,
      console: CONSOLE,
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
      whatRemains: (image, folder, workflowPath, backups) => [
        "- **What remains:** the snapshot, if one was taken (DigitalOcean bills it per GB per month at the rate listed on",
        "  https://www.digitalocean.com/pricing until you delete it in the control panel at https://cloud.digitalocean.com/),",
        ...(backups
          ? [
              "  the daily backups DigitalOcean already took (each is kept for up to four weeks after it was taken, then expires),",
            ]
          : []),
        "  the `managed-by:opscrew` tag (other OpsCrew apps in this account may use it), the container images in GitHub",
        `  Container Registry (\`${image}\`), and the files in this repository (\`${folder}/\` and \`${workflowPath}\`).`,
      ],
      hostKey: "the Droplet's host key",
    },
    destroy: {
      console: CONSOLE,
      snapshotRef: (id) => `DigitalOcean snapshot ${id}`,
      snapshotBilling: `DigitalOcean bills snapshots per GB per month at the rate listed on ${PRICING_URL}`,
      snapshotBilled: `billed per GB per month at the rate listed on ${PRICING_URL}`,
      lookup: (app) => `tagged opscrew-app:${app} and managed-by:opscrew`,
      tokenHint: (command) =>
        `Create a custom-scoped token at ${TOKEN_URL}, then set it as ${TOKEN_VARS[0]} and run \`${command}\` again.`,
      keptBackups:
        "DigitalOcean keeps the Droplet's automatic backups until they expire, four weeks after they were taken",
      keptBackupsRemaining:
        "The Droplet's automatic backups. DigitalOcean keeps them until they expire, four weeks after they were taken; you can delete them earlier in the DigitalOcean control panel.",
      storageConsole: "the DigitalOcean control panel (Spaces Object Storage)",
    },
    secops: SECOPS,
  },
};
