import type {
  CloudProviderDefinition,
  ModuleCall,
  PlannedFirewallRule,
  PlannedResourceJson,
  ProviderSecOps,
} from "@opscrew/contracts";
import { isRecord, listText } from "@opscrew/core";
import { CONTABO_CREDENTIALS_HINT, CONTABO_CREDENTIALS_URL, CONTABO_ENV } from "./client";
import { contaboConnector } from "./connector";
import { MODULE_FILES } from "./generated/module";

const ENV_VARS = Object.values(CONTABO_ENV);
const PANEL = "Contabo's Customer Control Panel";
const SECURITY_PAGE = `${PANEL} (${CONTABO_CREDENTIALS_URL}, Account → Security)`;

/**
 * Ubuntu 24.04's image id at Contabo. The Terraform provider takes an image by id only (its
 * `contabo_image` data source needs the id too). `GET /v1/compute/images` lists it as the standard
 * image `ubuntu-24.04` (research R6).
 */
const UBUNTU_24_04_IMAGE_ID = "d64d5c6c-9dda-4e38-8174-0ee282474d8a";

const COMMON_ARGUMENTS = {
  sshKey: ["ssh_public_key", "var.deploy_ssh_public_key"],
  sshCidrs: ["ssh_allowed_cidrs", "var.ssh_allowed_cidrs"],
  // biome-ignore lint/suspicious/noTemplateCurlyInString: HCL interpolation, not JavaScript.
  appTag: ["app_tag", '"opscrew-app:${var.app_name}"'],
} as const;

/** The server's name: the app's, or `<app>-<name>` for an extra server. */
function nameArgument({ extra }: ModuleCall): readonly [string, string] {
  return ["name", extra === undefined ? "var.app_name" : `"\${var.app_name}-${extra}"`];
}

/** The web's CIDRs, only on the server that serves the web (not on an extra server). */
function httpArguments({ extra }: ModuleCall): (readonly [string, string])[] {
  return extra === undefined ? [["http_allowed_cidrs", "var.http_allowed_cidrs"]] : [];
}

/**
 * The firewall the module describes for the connector to apply (ADR 0029, D8): its `input` is the
 * module's `wanted_firewall` output.
 */
const FIREWALL = "terraform_data.firewall";

/** Resource address without `count`/`for_each` keys: `module.a[0].x.y["k"]` becomes `module.a.x.y`. */
function configAddress(address: string): string {
  return address.replace(/\[[^\]]*\]/g, "");
}

/**
 * Instance addresses (without instance keys) that each `terraform_data.firewall` references in
 * its `input` (in its `server_ids`), read from the plan's `configuration` section. Instance ids
 * are unknown before apply, so these references are the only way to see the attachment on a
 * first plan.
 */
function firewallInstanceReferences(planJson: unknown): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const walk = (module: unknown, prefix: string) => {
    if (!isRecord(module)) return;
    for (const resource of Array.isArray(module.resources) ? module.resources : []) {
      if (!isRecord(resource) || resource.address !== FIREWALL) continue;
      const expressions = isRecord(resource.expressions) ? resource.expressions : {};
      const input = isRecord(expressions.input) ? expressions.input : {};
      const instances = new Set<string>();
      for (const reference of strings(input.references)) {
        const target = configAddress(reference).replace(/\.id$/, "");
        if (/^contabo_instance\.[^.]+$/.test(target)) instances.add(`${prefix}${target}`);
      }
      out.set(`${prefix}${FIREWALL}`, instances);
    }
    const calls = isRecord(module.module_calls) ? module.module_calls : {};
    for (const [name, call] of Object.entries(calls)) {
      if (isRecord(call)) walk(call.module, `${prefix}module.${name}.`);
    }
  };
  if (isRecord(planJson) && isRecord(planJson.configuration)) {
    walk(planJson.configuration.root_module, "");
  }
  return out;
}

/** A list attribute's strings, or none. */
function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** The wanted firewall in a `terraform_data.firewall`'s `input`, as far as the plan knows it. */
function wantedFirewall(resource: PlannedResourceJson): Record<string, unknown> {
  return isRecord(resource.values.input) ? resource.values.input : {};
}

/**
 * The wanted firewall's rules, in the Hetzner rule shape: one rule per port (none means every
 * port), its IPv4 and IPv6 sources together. Contabo reads an empty list as any source, so an
 * empty family reads as `0.0.0.0/0` or `::/0`.
 */
function contaboInboundRules(resource: PlannedResourceJson): PlannedFirewallRule[] {
  const rules = wantedFirewall(resource).rules;
  return (Array.isArray(rules) ? rules : []).filter(isRecord).flatMap((rule) => {
    const ipv4 = strings(rule.ipv4);
    const ipv6 = strings(rule.ipv6);
    const sources = [
      ...(ipv4.length === 0 ? ["0.0.0.0/0"] : ipv4),
      ...(ipv6.length === 0 ? ["::/0"] : ipv6),
    ];
    const protocol = typeof rule.protocol === "string" ? rule.protocol : "";
    const ports = strings(rule.ports);
    return (ports.length === 0 ? [""] : ports).map((port) => ({
      direction: "in",
      protocol,
      port,
      source_ips: sources,
    }));
  });
}

/** SecOps's checks of a plan's Contabo instances and the firewalls the connector applies. */
const SECOPS: ProviderSecOps = {
  noun: "server",
  rules: contaboInboundRules,
  attached: (server, firewalls, planJson) => {
    const id = server.values.id;
    const target = configAddress(server.address);
    const references = firewallInstanceReferences(planJson);
    return firewalls.some((firewall) => {
      const ids = strings(wantedFirewall(firewall).server_ids);
      if (typeof id === "string" && id !== "" && ids.includes(id)) return true;
      return references.get(configAddress(firewall.address))?.has(target) ?? false;
    });
  },
  attachedText: "The server is attached to a Contabo firewall.",
  unattachedText:
    "No Contabo firewall lists this server, so every port is reachable from the internet. Attach the OpsCrew firewall.",
  keylessText:
    "The server has no SSH key; Contabo would set up a login with a password instead. Add the deploy key.",
  backupsText:
    "Contabo has no automated backups OpsCrew turns on; OpsCrew's own snapshots cover the data.",
};

/** Contabo, as OpsCrew creates Cloud VPS servers there (ADR 0029). */
export const definition: CloudProviderDefinition = {
  contractVersion: 1,
  id: "contabo",
  displayName: "Contabo",
  name: "Contabo",
  serverNoun: "server",
  sizeNoun: "plan",
  consoleUrl: "https://new.contabo.com/",
  accountUrl: "https://new.contabo.com/",
  credentials: {
    envVars: ENV_VARS,
    mode: "all",
    createUrl: CONTABO_CREDENTIALS_URL,
    // Contabo's client id, secret, API user and password have no recognisable format.
    tokenRules: [],
    envPrefixes: ["CNTB", "CONTABO"],
    apiPattern: /api\.contabo\.com|auth\.contabo\.com|contabo_/i,
  },
  connector: (deps) => contaboConnector(deps),
  regions: {
    locations: {
      "eu-central": ["EU"],
      "eu-north": ["EU"],
      "us-east": ["US-east"],
      "us-west": ["US-west"],
      "ap-southeast": ["SIN"],
    },
    locationNames: {
      EU: "Germany",
      "US-east": "New York",
      "US-west": "Seattle",
      SIN: "Singapore",
    },
    notes: {
      "eu-north":
        "Contabo has no location in the Nordics, so OpsCrew uses its EU region in Germany, the nearest one.",
    },
    // Contabo's page names no city for its five German data centres; Nuremberg stands for them.
    coordinates: {
      EU: [49.4521, 11.0767],
      "US-east": [40.7128, -74.006],
      "US-west": [47.6062, -122.3321],
      SIN: [1.3521, 103.8198],
    },
  },
  offering: {
    currency: "EUR",
    defaultImage: UBUNTU_24_04_IMAGE_ID,
    backupPercent: 0,
    providerBackups: false,
    backupsOutliveServer: false,
    snapshots: { kind: "included" },
    serverSnapshotsOutliveServer: false,
    deleteProtection: false,
    resize: false,
    offAfterRefusedResize: false,
    removal: { kind: "cancel-at-term-end", minimumTermMonths: 1 },
    // Unverified: Contabo documents no wording for these; the spike (T2613) checks them.
    unavailable:
      /out of stock|sold out|not available in (this|the) region|(product|region) is not available|(?<!service (temporarily )?)unavailable/i,
    serverLimit: /instance limit|limit of instances|maximum number of instances|instance quota/i,
  },
  terraform: {
    provider: { name: "contabo", source: "contabo/contabo", version: "~> 0.1.44" },
    serverResourceType: "contabo_instance",
    firewallResourceType: FIREWALL,
    connectorFirewall: true,
    connectorRemoval: true,
    homeCacheFiles: [".cache/contabo/terraform/token"],
    mirroredAttributes: {},
    lifecycleIgnored: ["add_ons", "default_user", "image_id", "period", "ssh_keys", "user_data"],
    module: { name: "contabo-vps", files: MODULE_FILES },
    credentialsComment: `Credentials from the ${listText(ENV_VARS)} environment variables (never stored in files or state).`,
    deleteProtectionVariable: false,
    descriptions: {
      location: "Contabo region.",
      serverType: "Contabo product id of the plan.",
      backups: "Contabo has no automated backups OpsCrew turns on; always false.",
    },
    moduleArguments: (call) => [
      nameArgument(call),
      ["location", `var.${call.prefix}location`],
      ["server_type", `var.${call.prefix}server_type`],
      ["image", `var.${call.prefix}image`],
      COMMON_ARGUMENTS.sshKey,
      COMMON_ARGUMENTS.sshCidrs,
      ...httpArguments(call),
      COMMON_ARGUMENTS.appTag,
      // The app's tag another module or the root holds; without one, this module creates it.
      ...(call.appTag === undefined ? [] : ([["app_tag_id", call.appTag]] as const)),
    ],
    extraShared: {
      resources: [
        "# The deploy key and the app's tag of the app's servers on Contabo, kept here so that removing a",
        "# server never deletes them. The servers get their ids through coalesce, whose result is known",
        "# not to be null before apply, so their own key's and tag's counts are known.",
        'resource "contabo_secret" "deploy" {',
        // biome-ignore lint/suspicious/noTemplateCurlyInString: HCL interpolation, not JavaScript.
        '  name  = "${var.app_name}-deploy"',
        '  type  = "ssh"',
        "  value = var.deploy_ssh_public_key",
        "}",
        "",
        'resource "contabo_tag" "app" {',
        // biome-ignore lint/suspicious/noTemplateCurlyInString: HCL interpolation, not JavaScript.
        '  name  = "opscrew-app:${var.app_name}"',
        '  color = "#0A78C3"',
        "}",
        "",
      ],
      sshKeyId: "coalesce(contabo_secret.deploy.id)",
      appTag: "coalesce(contabo_tag.app.id)",
    },
  },
  texts: {
    rotate: { deleteToken: SECURITY_PAGE },
    interview: {
      label: "Contabo",
      hint: "cheap servers in Germany, the US and Singapore; monthly contracts, a removal ends at the end of the term; prices in EUR",
    },
    design: { summaryNoun: "Contabo server", titleSuffix: " on Contabo" },
    init: {
      fix: `Create the API credentials in ${SECURITY_PAGE}: the client id, the client secret, the API user (your login email) and the API password. Set them as ${listText(ENV_VARS)}. Contabo has no scoped keys, so they reach your whole account.`,
      scopeNote: "",
    },
    runbook: {
      serverLabel: (type, location) => `Contabo ${type} in ${location}`,
      console: "the Contabo Customer Control Panel",
      backupsOnDatabaseCell: "Contabo has no automated backups OpsCrew turns on",
      backupsOn:
        "Contabo has no automated backups OpsCrew turns on. OpsCrew's own snapshots of the data keep an encrypted copy off the server.",
      cloudFirewall: "the Contabo firewall",
      deletes: (app) =>
        `the firewall, SSH key and app tag (\`opscrew-app:${app}\`), and cancels the server: Contabo ends its contract at the end of the current term and bills it until then, and OpsCrew shuts it down now`,
      connectNote: [],
      snapshotReason: "the app keeps data on the server",
      snapshotFirst: [
        "OpsCrew offers its own snapshot of the data first,",
        "  with its encrypted copy off the server. Contabo's snapshots of the server go with it when its term ends, so",
        "  OpsCrew's copy is the one that stays.",
      ],
      noSnapshot: [
        "- **Snapshot:** this app keeps no database on the server, so OpsCrew does not offer a snapshot before cancelling",
        "  it. Contabo's snapshots of the server go with it when its term ends.",
      ],
      deleteProtectionNote: [
        "- **No delete protection:** Contabo has no delete protection. Cancelling the server in the Customer Control Panel",
        "  ends its contract at the end of the term, when its disk and snapshots go; `opscrew destroy` is the safe way,",
        "  because it shows the plan and the end of the term, offers a snapshot and asks for the typed name first.",
      ],
      whatRemains: (image, folder, workflowPath) => [
        "- **What remains:** the server until the end of its term (Contabo bills it until then; it is shut down, and you",
        "  can start it again in the Customer Control Panel; its disk and its Contabo snapshots go when the term ends),",
        `  the container images in GitHub Container Registry (\`${image}\`), and the files in this repository`,
        `  (\`${folder}/\` and \`${workflowPath}\`).`,
      ],
      hostKey: "the server's host key",
    },
    destroy: {
      console: "the Contabo Customer Control Panel",
      snapshotRef: (id) => `Contabo snapshot ${id}`,
      snapshotBilling:
        "Contabo includes snapshots in the server's price, up to the number its plan allows, and they go with the server when its term ends",
      snapshotBilled:
        "included in the server's price up to its plan's limit, and gone when the server's term ends",
      lookup: (app) =>
        `tagged opscrew-app:${app}, or with no OpsCrew tag and named ${app} or ${app}-…`,
      tokenHint: (command) => `${CONTABO_CREDENTIALS_HINT} Then run \`${command}\` again.`,
    },
    secops: SECOPS,
  },
};
