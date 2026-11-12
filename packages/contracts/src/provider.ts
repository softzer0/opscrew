/**
 * The contract for a cloud server provider (ADR 0029): everything OpsCrew knows about one provider
 * it creates servers on, in one definition a provider package exports. Only plain data, regular
 * expressions and functions cross it, never a zod schema or a class instance, so a separately
 * installed package (028) can implement it with its own copies of its dependencies. OpsCrew
 * validates every definition it loads (`@opscrew/providers`) and everything it reads from one.
 *
 * A server the user owns (`own`), a Portainer, this computer and the server-less hosts are kinds of
 * target with flows of their own, not cloud server providers.
 */
import type { Currency } from "./common";
import type { VpsConnector } from "./connector";
import type { FetchLike } from "./io";

/** The contract version this OpsCrew reads; a definition of another version is refused. */
export const CLOUD_PROVIDER_CONTRACT_VERSION = 1;

/** What OpsCrew's redactor offers a connector: register a secret, mask text and values. */
export interface ProviderRedactor {
  addLiteral(value: string, label?: string): void;
  redact(text: string): string;
  redactDeep<T>(value: T): T;
}

/** What a provider's connector gets from OpsCrew. Tests inject fakes for every side effect. */
export interface ProviderConnectorDeps {
  env: Record<string, string | undefined>;
  fetch?: FetchLike;
  /** Shared redactor; the connector registers every credential it reads with it. */
  redactor?: ProviderRedactor;
  /** OpsCrew's version, for the User-Agent. */
  version?: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

/** A Terraform provider requirement: local name, registry source and version constraint. */
export interface ProviderRequirement {
  name: string;
  source: string;
  version: string;
}

/**
 * Prefix of a server module's root variables: none for `module "server"`, `previous_` for
 * `module "server_previous"`, `<name>_` for an extra server's `module "server_<name>"`.
 */
export type VariablePrefix = "" | `${string}_`;

/** One server module call the root module renders. */
export interface ModuleCall {
  prefix: VariablePrefix;
  /** An extra server's name: it is named `<app>-<name>` and serves no web traffic. */
  extra?: string;
  /**
   * An HCL expression for a resource the root module manages once for the app's servers on this
   * provider (DigitalOcean's app tag); absent, the server's own module manages it.
   */
  appTag?: string;
}

/** A secret-scanning rule for the provider's credential format (`opscrew scan`). */
export interface ProviderTokenRule {
  /** Stable rule id, for example `hcloud-token`. */
  id: string;
  title: string;
  severity: "critical" | "high" | "medium" | "low";
  /** Global regular expression; `group` selects the secret within a match. */
  pattern: RegExp;
  group?: number;
  description: string;
}

/** How the provider's credentials are set. */
export interface ProviderCredentials {
  /** The environment variables, in order. */
  envVars: readonly string[];
  /**
   * `any`: the first of `envVars` that is set is the token (Hetzner, DigitalOcean); `all`: every
   * one is needed (Contabo's client id, client secret, API user and API password).
   */
  mode: "any" | "all";
  /** Where the user creates them. */
  createUrl: string;
  /** Formats `opscrew scan` recognises; empty when the credentials have no recognisable shape. */
  tokenRules: readonly ProviderTokenRule[];
  /** Prefixes of variables that belong to the provider, for detection, for example `HCLOUD`. */
  envPrefixes: readonly string[];
  /** Engine log text naming the provider's API or resources, so a 403 is blamed on its token. */
  apiPattern: RegExp;
}

/** Where the provider has servers. Keys are OpsCrew's regions (`eu-central`, …), checked on load. */
export interface ProviderRegions {
  /** Locations per region, in order of preference (first available wins). */
  locations: Readonly<Record<string, readonly string[]>>;
  /** Display names of the locations OpsCrew offers. */
  locationNames: Readonly<Record<string, string>>;
  /** Why a region maps to a location outside it. */
  notes: Readonly<Record<string, string>>;
  /** Latitude and longitude of each location, for the delay estimates. */
  coordinates: Readonly<Record<string, readonly [number, number]>>;
}

/** How a server leaves the provider. */
export type ProviderRemoval =
  /** Deleted at once (Hetzner, DigitalOcean). */
  | { kind: "delete" }
  /**
   * Cancelled: the provider ends the contract at the end of its term and bills it until then
   * (Contabo). OpsCrew shuts the server down and shows the end date the provider answers.
   */
  | { kind: "cancel-at-term-end"; minimumTermMonths: number };

/** What the provider sells and how its servers live and leave. */
export interface ProviderOffering {
  currency: Currency;
  /** Ubuntu 24.04's image name or id at the provider. */
  defaultImage: string;
  /** Daily automated backups as a percentage of the server price (0 without them). */
  backupPercent: number;
  /** True when OpsCrew can turn on the provider's automated backups. */
  providerBackups: boolean;
  /** True when automated backups survive the server's deletion for a while. */
  backupsOutliveServer: boolean;
  /**
   * Whole-server snapshots: billed per GB a month, or included in the server's price up to the
   * count its offer names (`ComputeOffer.includedSnapshots`).
   */
  snapshots: { kind: "per-gb" } | { kind: "included" };
  /** True when a whole-server snapshot outlives the server (so one is worth taking before removal). */
  serverSnapshotsOutliveServer: boolean;
  /** True when the server can be protected against deletion (lifted before a teardown). */
  deleteProtection: boolean;
  /** True when a size change applies to the running server; false refuses it with a move instead. */
  resize: boolean;
  /** True when the provider leaves the server switched off after it refuses a smaller disk. */
  offAfterRefusedResize: boolean;
  removal: ProviderRemoval;
  /** Provider error text meaning the size is unavailable or out of stock in the location. */
  unavailable: RegExp;
  /** Provider error text meaning the account reached its server limit. */
  serverLimit: RegExp;
}

/** What the root module, the vendored server module and SecOps need. */
export interface ProviderTerraform {
  provider: ProviderRequirement;
  /** Resource type of the server, for example `hcloud_server`. */
  serverResourceType: string;
  /**
   * Resource type of the cloud firewall, or `<type>.<name>` for a general type: with
   * {@link connectorFirewall}, `terraform_data.firewall`.
   */
  firewallResourceType: string;
  /**
   * Whether the module only describes the firewall it wants and the connector applies it (ADR
   * 0029, D8): a `terraform_data.firewall` whose `input` is the module's `wanted_firewall` output
   * ({@link WantedFirewallOutput}). The connector then has `firewalls`.
   */
  connectorFirewall: boolean;
  /**
   * Files the provider caches its login in, relative to the user's home folder. The engine
   * removes them before and after every command (ADR 0029, D9). Empty for most providers.
   */
  homeCacheFiles: readonly string[];
  /**
   * True when the provider's Terraform cannot remove its server, so OpsCrew removes it through the
   * connector's server API (`cancelServer`), takes it out of the state and applies the rest of the
   * approved plan (ADR 0029, D10).
   */
  connectorRemoval: boolean;
  /**
   * Attributes the provider fills in from a relationship OpsCrew manages on the other resource
   * (Hetzner mirrors the server's `firewall_ids` into the firewall's `apply_to`); drift ignores
   * them.
   */
  mirroredAttributes: Readonly<Record<string, readonly string[]>>;
  /**
   * The server's attributes its module's `lifecycle.ignore_changes` lists, because changing them
   * would rebuild or reinstall the server (and attributes the provider never reads back); drift
   * doesn't report them.
   */
  lifecycleIgnored: readonly string[];
  /**
   * The vendored server module: its folder name and files (path within the folder → content),
   * without `cloud-init.yaml.tftpl`, which OpsCrew adds to every server module.
   */
  module: { name: string; files: Readonly<Record<string, string>> };
  /** The comment above the provider block, for example `Token from the HCLOUD_TOKEN …`. */
  credentialsComment: string;
  /** Whether the server module has a `delete_protection` switch. */
  deleteProtectionVariable: boolean;
  /** Root variable descriptions that name the provider. */
  descriptions: { location: string; serverType: string; backups: string };
  /**
   * Arguments of a server module call after `source`, in order (name, HCL value). The shared
   * variables (app name, deploy key, CIDRs) and the labels or tags are the same for every server.
   */
  moduleArguments(call: ModuleCall): readonly (readonly [string, string])[];
  /**
   * What the root module creates once for the app's extra servers when the app's server is not
   * there (the deploy key and, on DigitalOcean, the app's tag): HCL lines, and the expressions
   * each extra server's module gets.
   */
  extraShared: { resources: readonly string[]; sshKeyId: string; appTag?: string };
}

/**
 * A server module's `wanted_firewall` output with {@link ProviderTerraform.connectorFirewall}, as
 * HCL writes it: the firewall the connector makes (ADR 0029, D8).
 */
export interface WantedFirewallOutput {
  name: string;
  description: string;
  /** The servers it protects, by the provider's server id. */
  server_ids: string[];
  rules: {
    protocol: "tcp" | "udp" | "icmp";
    /** Ports or ranges (`"80"`, `"8000-8100"`); none for ICMP. */
    ports: string[];
    /** Sources; a family with no network holds one that matches nobody (`::1/128`). */
    ipv4: string[];
    ipv6: string[];
  }[];
}

/** A firewall rule in the plan, in Hetzner's shape (other providers' rules are read into it). */
export interface PlannedFirewallRule {
  direction?: string;
  protocol?: string;
  port?: string | null;
  source_ips?: string[];
}

/** A resource in a Terraform plan's JSON. */
export interface PlannedResourceJson {
  address: string;
  type: string;
  name: string;
  values: Record<string, unknown>;
  /** Attributes known only after apply. */
  unknown: Record<string, unknown>;
}

/** SecOps's checks of a plan for this provider's server and firewall. */
export interface ProviderSecOps {
  /** "server" or "Droplet". */
  noun: string;
  /** The firewall's inbound rules. */
  rules(firewall: PlannedResourceJson): PlannedFirewallRule[];
  /** True when one of `firewalls` is attached to `server`. */
  attached(
    server: PlannedResourceJson,
    firewalls: PlannedResourceJson[],
    planJson: unknown,
  ): boolean;
  attachedText: string;
  unattachedText: string;
  keylessText: string;
  backupsText: string;
}

/** Runbook texts (`opscrew/RUNBOOK.md`). */
export interface ProviderRunbookTexts {
  /** "Server" row, for example `Hetzner Cloud cx23 in nbg1`. */
  serverLabel(serverType: string, location: string): string;
  /** Where the user edits things by hand, for example "Hetzner Console". */
  console: string;
  backupsOnDatabaseCell: string;
  backupsOn: string;
  cloudFirewall: string;
  /** What `opscrew destroy` removes besides DNS, for the app named `app`. */
  deletes: (app: string) => string;
  /** Extra paragraph lines after "Connect to the server" (empty for none). */
  connectNote: readonly string[];
  snapshotReason: string;
  snapshotFirst: readonly string[];
  noSnapshot: readonly string[];
  deleteProtectionNote: readonly string[];
  /**
   * "What remains": `image` is the app's on GitHub Container Registry, `folder` the app's artefacts
   * folder, `backups` whether the plan has automated backups on.
   */
  whatRemains: (
    image: string,
    folder: string,
    workflowPath: string,
    backups: boolean,
  ) => readonly string[];
  hostKey: string;
}

/** Teardown texts (`opscrew destroy`). */
export interface ProviderDestroyTexts {
  /** Where the user manages servers and snapshots, for example `the Hetzner Cloud Console`. */
  console: string;
  /** How a snapshot is referred to, for example `Hetzner image 9001`. */
  snapshotRef(id: string): string;
  /** Snapshot pricing as a clause; never a fixed amount. */
  snapshotBilling: string;
  /** Snapshot pricing for the approval, for example `billed per GB per month`. */
  snapshotBilled: string;
  /** How the app's servers are found, for example `labelled managed-by=opscrew,app=shop`. */
  lookup(app: string): string;
  /** Hint when the credentials are missing; `command` is the command to run again. */
  tokenHint(command: string): string;
  /** Data lost with the server when backups are on and the provider deletes them with it. */
  deletedBackups?: string;
  /** What happens to the automatic backups when the provider keeps them after the deletion. */
  keptBackups?: string;
  /** "What remains" entry for automatic backups the provider keeps after the deletion. */
  keptBackupsRemaining?: string;
  /** The object-storage console's name, for buckets at this provider (absent without storage). */
  storageConsole?: string;
}

/** Everything the provider says to the user, by where it is said. */
export interface ProviderTexts {
  /**
   * How long the app is offline while the provider changes the server's size, as a sentence, for
   * example `The app is offline one to three minutes while …`. Present exactly when
   * `offering.resize` is true.
   */
  resizeOffline?: string;
  /** `opscrew rotate`: where the user deletes an old credential, a page or a console path. */
  rotate: { deleteToken: string };
  /** The interview's option. */
  interview: { label: string; hint: string };
  /** Design's wording. */
  design: {
    /** Noun in summaries, for example `DigitalOcean Droplet`. */
    summaryNoun: string;
    /** Appended to option titles, for example ` on DigitalOcean`. */
    titleSuffix: string;
    /** The variable that turns on live prices; absent when the provider has no price API. */
    livePricesVar?: string;
  };
  /** `opscrew init`'s help when the credentials are missing or wrong. */
  init: {
    /** How to create the credentials, naming the page and the variables. */
    fix: string;
    /**
     * For a provider whose API can't list a token's scopes: the scopes OpsCrew needs, appended to
     * `fix` as it is, so it starts with a space ("" for none).
     */
    scopeNote: string;
  };
  runbook: ProviderRunbookTexts;
  destroy: ProviderDestroyTexts;
  secops: ProviderSecOps;
}

/** One cloud server provider, as its package exports it (`definition`). */
export interface CloudProviderDefinition {
  /** {@link CLOUD_PROVIDER_CONTRACT_VERSION} at the time the package was built. */
  contractVersion: 1;
  /** Its id in plans and commands, for example `hetzner`. */
  id: string;
  /** For example `Hetzner Cloud`. */
  displayName: string;
  /** Short name, used in possessives, for example "Hetzner's price list". */
  name: string;
  /** What the provider calls a server: `server` or `Droplet`. */
  serverNoun: string;
  /** What the provider calls a server's size: `server type`, `size` or `plan`. */
  sizeNoun: string;
  /** The provider's web console. */
  consoleUrl: string;
  /** Where the user fixes account problems: a locked account, an unverified email, limits. */
  accountUrl: string;
  credentials: ProviderCredentials;
  /** The provider's connector: credentials, price catalogue and server API. */
  connector(deps: ProviderConnectorDeps): VpsConnector;
  regions: ProviderRegions;
  offering: ProviderOffering;
  terraform: ProviderTerraform;
  texts: ProviderTexts;
}
