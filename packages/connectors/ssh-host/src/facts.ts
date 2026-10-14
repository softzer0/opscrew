import { z } from "zod";
import { HostStepIdSchema } from "./types";

/** Where OpsCrew keeps its marker, host record and backups on the server (root only). */
export const OPSCREW_DIR = "/etc/opscrew";
export const MARKER_PATH = `${OPSCREW_DIR}/app.json`;
export const RECORD_PATH = `${OPSCREW_DIR}/host.json`;
export const SSHD_DROP_IN = "/etc/ssh/sshd_config.d/10-opscrew.conf";
export const AUTO_UPGRADES_FILE = "/etc/apt/apt.conf.d/21opscrew-auto-upgrades";
export const RUNTIME_DIRS = ["/srv/app", "/srv/data"] as const;

/** Version written to the host record (`opscrewVersion`). */
export const HOST_ADAPTER_VERSION = "0.1.0";

export const AppMarkerSchema = z.object({ app: z.string(), projectId: z.string() });
export type AppMarker = z.infer<typeof AppMarkerSchema>;

const PreviousSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));

export const HostRecordEntrySchema = z.object({
  step: HostStepIdSchema,
  /** `setup` entries hold the value OpsCrew replaced; teardown/undo entries are a trail. */
  purpose: z.enum(["setup", "teardown", "undo"]),
  at: z.string(),
  previous: PreviousSchema,
});
export type HostRecordEntry = z.infer<typeof HostRecordEntrySchema>;

/** `/etc/opscrew/host.json`: what OpsCrew changed and the values it replaced. No secrets. */
export const HostRecordSchema = z.object({
  schemaVersion: z.literal(1),
  app: z.string(),
  projectId: z.string(),
  opscrewVersion: z.string(),
  changes: z.array(HostRecordEntrySchema),
});
export type HostRecord = z.infer<typeof HostRecordSchema>;

const ListenerSchema = z.object({
  proto: z.enum(["tcp", "udp"]),
  address: z.string(),
  port: z.number().int(),
  process: z.string(),
});
export type Listener = z.infer<typeof ListenerSchema>;

const DirSchema = z.object({
  path: z.string(),
  kind: z.enum(["absent", "dir", "link", "other"]),
  owner: z.string().optional(),
  group: z.string().optional(),
  mode: z.string().optional(),
  entries: z.number().int().optional(),
});
export type DirFact = z.infer<typeof DirSchema>;

const AddonSchema = z.object({
  /** OpsCrew's compose file for the add-on exists. */
  installed: z.boolean(),
  /** SHA-256 of that compose file, null when absent. */
  composeSha256: z.string().nullable(),
  /** A container of the add-on's Compose project is running. */
  running: z.boolean(),
  /** cloudflared: the token env file; Portainer: the one-time admin password file. */
  secretFile: z.boolean(),
  /** A volume of the add-on's Compose project exists (Portainer: an admin may already exist). */
  dataVolume: z.boolean(),
  /** Tunnel connector: the tunnel id recorded next to it (`tunnel.id`), null when absent. */
  tunnelId: z.string().nullable(),
});
export type AddonFact = z.infer<typeof AddonSchema>;

const WebFilterRulesSchema = z.object({
  /** OpsCrew's chain `OPSCREW-WEB`, null when it does not exist. */
  chain: z
    .object({ sources: z.array(z.string()), dropsRest: z.boolean(), other: z.number().int() })
    .nullable(),
  /** Docker's `DOCKER-USER` chain and OpsCrew's jumps from it. */
  dockerUser: z.object({
    exists: z.boolean(),
    leading: z.array(z.string()),
    jumps: z.number().int(),
  }),
});
export type WebFilterRules = z.infer<typeof WebFilterRulesSchema>;

const NO_WEB_FILTER_RULES: WebFilterRules = {
  chain: null,
  dockerUser: { exists: false, leading: [], jumps: 0 },
};

/** What the server says about Docker's firewall and OpsCrew's web filter (the `web-filter` step). */
export const WebFilterFactsSchema = z.object({
  /**
   * How Docker filters its published ports: with iptables (the default; `DOCKER-USER` exists), its
   * nftables backend (`firewall-backend: nftables`, no `DOCKER-USER`), or not at all (`iptables:
   * false`).
   */
  backend: z.enum(["iptables", "nftables", "off"]),
  /** Which of `iptables` and `iptables-restore` exist. */
  commands: z.array(z.string()),
  /** SHA-256 of OpsCrew's script, unit and Docker drop-in; null when the file is absent. */
  files: z.object({
    script: z.string().nullable(),
    unit: z.string().nullable(),
    dropIn: z.string().nullable(),
  }),
  /** `systemctl is-enabled` / `is-active` of `opscrew-web-filter.service`. */
  enabled: z.boolean(),
  active: z.boolean(),
  /** OpsCrew's IPv4 rules (the filter is IPv4 only: the site is not published on IPv6). */
  rules4: WebFilterRulesSchema,
});
export type WebFilterFacts = z.infer<typeof WebFilterFactsSchema>;

/** A server without OpsCrew's web filter whose Docker (if any) uses iptables. */
export const NO_WEB_FILTER: WebFilterFacts = {
  backend: "iptables",
  commands: [],
  files: { script: null, unit: null, dropIn: null },
  enabled: false,
  active: false,
  rules4: NO_WEB_FILTER_RULES,
};

/** Facts about the server found by `inspectHost`; read-only, zod-validated. */
export const HostFactsSchema = z.object({
  /** The admin login OpsCrew connected as. */
  user: z.string(),
  privilege: z.enum(["root", "sudo", "sudo-password", "none"]),
  os: z.object({
    id: z.string(),
    idLike: z.string(),
    versionId: z.string(),
    codename: z.string(),
    prettyName: z.string(),
  }),
  /** `dpkg --print-architecture` (amd64, arm64, ...), empty when unknown. */
  arch: z.string(),
  /** `uname -m`. */
  machine: z.string(),
  cpus: z.number().int().nonnegative(),
  memoryBytes: z.number().nonnegative(),
  memoryAvailableBytes: z.number().nonnegative(),
  diskFreeBytes: z.number().nonnegative(),
  diskTotalBytes: z.number().nonnegative(),
  systemd: z.boolean(),
  /** `flock` (util-linux) is there: the automatic undo and its cancel take turns with it. */
  flock: z.boolean(),
  /**
   * Global addresses of the server's real interfaces (not container bridges or VPNs), and whether
   * the internet could reach each one. Local state only: never write them to committed files.
   */
  addresses: z.array(
    z.object({
      interface: z.string(),
      family: z.enum(["ipv4", "ipv6"]),
      address: z.string(),
      public: z.boolean(),
    }),
  ),
  /** Effective sshd settings (`sshd -T`); null when they could not be read. */
  sshd: z
    .object({
      ports: z.array(z.number().int()),
      passwordAuthentication: z.boolean(),
      kbdInteractiveAuthentication: z.boolean(),
      /** Normalised: `without-password` is reported as `prohibit-password`. */
      permitRootLogin: z.string(),
      authenticationMethods: z.string(),
      allowUsers: z.array(z.string()),
      allowGroups: z.array(z.string()),
      denyUsers: z.array(z.string()),
      denyGroups: z.array(z.string()),
      authorizedKeysCommand: z.boolean(),
      /** Global `AllowTcpForwarding` (the Portainer tunnel command needs local forwarding). */
      allowTcpForwarding: z.string(),
      /** `/etc/ssh/sshd_config` includes `/etc/ssh/sshd_config.d/*.conf`. */
      dropInIncluded: z.boolean(),
      /** Content of OpsCrew's drop-in, null when absent. */
      dropIn: z.string().nullable(),
    })
    .nullable(),
  listeners: z.array(ListenerSchema),
  /** Active web server units (nginx, apache2, caddy, traefik, haproxy, lighttpd). */
  webServers: z.array(z.string()),
  firewall: z.object({
    ufw: z.enum(["absent", "inactive", "active"]),
    /** `ufw show added` rules without the `ufw ` prefix, e.g. `allow 22/tcp`. */
    ufwRules: z.array(z.object({ rule: z.string(), comment: z.string().nullable() })),
    /** Default policies from `/etc/default/ufw` (`allow`, `deny`, `reject`), null when unknown. */
    ufwDefaults: z
      .object({ incoming: z.string(), outgoing: z.string(), routed: z.string() })
      .nullable(),
    /** Plain descriptions of other firewalls found (firewalld, nftables, iptables rules). */
    foreign: z.array(z.string()),
  }),
  docker: z.object({
    kind: z.enum(["absent", "docker-repo", "snap", "podman", "distro", "other"]),
    /** Docker Engine version (`28.5.1`), null when unknown. */
    version: z.string().nullable(),
    running: z.boolean(),
    composePlugin: z.boolean(),
    buildxPlugin: z.boolean(),
    /** Installed packages Docker lists as conflicting with Docker Engine. */
    conflicting: z.array(z.string()),
    /** apt source files that point at download.docker.com. */
    sources: z.array(z.string()),
    /** dockerd flags in its unit (`--log-driver`, ...) that daemon.json would duplicate. */
    daemonFlags: z.array(z.string()),
    /** The node is part of an active Swarm (live-restore cannot be used). */
    swarm: z.boolean(),
  }),
  /** All containers (running or not) with their Compose project label. */
  containers: z.array(
    z.object({ name: z.string(), project: z.string(), ports: z.string(), running: z.boolean() }),
  ),
  /** Compose projects that own at least one volume. */
  volumeProjects: z.array(z.string()),
  /**
   * Ways users log in that OpsCrew cannot see keys or passwords for (directory services in
   * nsswitch or PAM, sshd's AuthorizedKeysCommand). Turning passwords off needs an explicit choice.
   */
  directoryLogins: z.array(z.string()),
  /** dpkg was interrupted (`/var/lib/dpkg/updates` is not empty). */
  dpkgInterrupted: z.boolean(),
  /** Login users (root and uid >= 1000 with a login shell). */
  loginUsers: z.array(
    z.object({
      name: z.string(),
      uid: z.number().int(),
      password: z.boolean(),
      keys: z.boolean(),
    }),
  ),
  deployUser: z.object({ groups: z.array(z.string()), keys: z.array(z.string()) }).nullable(),
  packages: z.object({
    ufw: z.boolean(),
    unattendedUpgrades: z.boolean(),
    curl: z.boolean(),
    fail2ban: z.boolean(),
  }),
  /** Effective `APT::Periodic::Update-Package-Lists` and `Unattended-Upgrade` are both "1". */
  autoUpgrades: z.boolean(),
  /** `systemctl is-enabled unattended-upgrades` says enabled (what `opscrew secure` checks). */
  autoUpgradesService: z.boolean(),
  /** `/etc/docker/daemon.json`: absent, OpsCrew's settings, or the user's own. */
  dockerDaemonJson: z.enum(["absent", "opscrew", "other"]),
  fail2ban: z.object({
    active: z.boolean(),
    /** Content of OpsCrew's jail file, null when absent. */
    jail: z.string().nullable(),
    /** An `sshd` jail is running (OpsCrew's or the user's own). */
    sshdJail: z.boolean(),
  }),
  /** `/var/lib/opscrew-ready` exists (the setup finished). */
  ready: z.boolean(),
  dirs: z.array(DirSchema),
  marker: AppMarkerSchema.nullable(),
  /** True when `/etc/opscrew/app.json` exists but could not be read as JSON. */
  markerDamaged: z.boolean(),
  record: HostRecordSchema.nullable(),
  recordDamaged: z.boolean(),
  /** Dead-man switches still waiting on the server (from an interrupted apply). */
  pendingUndo: z.object({ sshd: z.boolean(), ufw: z.boolean() }),
  tunnel: AddonSchema,
  portainer: AddonSchema,
  /**
   * Docker's firewall and OpsCrew's web filter. Inspection always reports it; absent (facts from
   * before the filter existed) reads as {@link NO_WEB_FILTER}.
   */
  webFilter: WebFilterFactsSchema.optional(),
});

export type HostFacts = z.infer<typeof HostFactsSchema>;

/** The web filter facts of `facts`, {@link NO_WEB_FILTER} when they are absent. */
export function webFilterFacts(facts: Pick<HostFacts, "webFilter">): WebFilterFacts {
  return facts.webFilter ?? NO_WEB_FILTER;
}
