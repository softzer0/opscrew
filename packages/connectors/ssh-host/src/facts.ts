import { z } from "zod";
import { RUNTIME_FILE_NAMES } from "./constants";
import { AccessModeSchema, HostStepIdSchema } from "./types";

/** Version written to the host record (`opscrewVersion`). */
export const HOST_ADAPTER_VERSION = "0.1.0";

/**
 * `/etc/opscrew/apps/<app>.json`: one OpsCrew app on the server. No secrets (the deploy key is a
 * public key).
 */
export const AppRecordSchema = z.object({
  schemaVersion: z.literal(1),
  app: z.string(),
  /** The project folder the app belongs to: another project may not use the same name. */
  projectId: z.string(),
  /**
   * `active`: the app is set up here. `data-kept`: it was removed with its data kept (its data
   * folder and Compose volumes), so its name stays its project's; it holds no hostname, service,
   * memory or deploy key any more.
   */
  state: z.enum(["active", "data-kept"]),
  /** How the app is served (see {@link AccessModeSchema}); null when data-kept. */
  access: AccessModeSchema.nullable(),
  hostnames: z.array(z.string()),
  folders: z.object({ app: z.string(), data: z.string() }),
  composeProject: z.string(),
  services: z.array(z.string()),
  /** The sum of the memory limits of its containers, in MB. */
  memoryMb: z.number().int().nonnegative(),
  /** Its deploy key (a public key) in the deploy user's authorized_keys, "" when data-kept. */
  deployKey: z.string(),
});
export type AppRecord = z.infer<typeof AppRecordSchema>;

const PreviousSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));

export const HostRecordEntrySchema = z.object({
  step: HostStepIdSchema,
  /** `setup` entries hold the value OpsCrew replaced; teardown/undo entries are a trail. */
  purpose: z.enum(["setup", "teardown", "undo"]),
  at: z.string(),
  previous: PreviousSchema,
});
export type HostRecordEntry = z.infer<typeof HostRecordEntrySchema>;

/**
 * `/etc/opscrew/host.json`: the apps set up on the server (sorted), what OpsCrew changed on it
 * and the values it replaced. No secrets.
 */
export const HostRecordSchema = z.object({
  schemaVersion: z.literal(1),
  apps: z.array(z.string()),
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

const RuntimeFileSchema = z.object({
  /** The app whose folder (`/srv/apps/<app>`) holds the file. */
  app: z.string(),
  name: z.enum(RUNTIME_FILE_NAMES),
  /** `link` is a symbolic link (never followed), `other` neither a regular file nor a link. */
  kind: z.enum(["absent", "file", "link", "other"]),
  owner: z.string().optional(),
  group: z.string().optional(),
  /** Octal permission bits as `stat -c %a` prints them (`600`, `644`). */
  mode: z.string().optional(),
  /** SHA-256 of the file; only for {@link HASHED_RUNTIME_FILES}, otherwise null. */
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
});
export type RuntimeFileFact = z.infer<typeof RuntimeFileSchema>;

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

/** What the server says about Docker's firewall and OpsCrew's web filter (the `web-filter` step). */
export const WebFilterFactsSchema = z.object({
  /**
   * How Docker filters its published ports: with iptables (the default; `DOCKER-USER` exists), its
   * nftables backend (`firewall-backend: nftables`, no `DOCKER-USER`), or not at all (`iptables:
   * false`).
   */
  backend: z.enum(["iptables", "nftables", "off"]),
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

/** Facts about the server found by `inspectHost`; read-only, zod-validated. */
export const HostFactsSchema = z.object({
  /** The admin login OpsCrew connected as. */
  user: z.string(),
  privilege: z.enum(["root", "sudo", "sudo-password", "none"]),
  os: z.object({
    id: z.string(),
    versionId: z.string(),
    prettyName: z.string(),
  }),
  /** `dpkg --print-architecture` (amd64, arm64, ...), empty when unknown. */
  arch: z.string(),
  /** `uname -m`. */
  machine: z.string(),
  cpus: z.number().int().nonnegative(),
  /** The CPU flags in /proc/cpuinfo include `avx` (x86 only; MongoDB 5 and later need it). */
  avx: z.boolean(),
  memoryBytes: z.number().nonnegative(),
  diskFreeBytes: z.number().nonnegative(),
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
  /**
   * The shared folders (`/srv/edge`, `/srv/apps`, `/srv/data`, always listed), then every app's
   * folder found in `/srv/apps` and `/srv/data` (only those that exist).
   */
  dirs: z.array(DirSchema),
  /**
   * OpsCrew's runtime files in each app's folder (see {@link RUNTIME_FILE_NAMES}): checksums of
   * the rendered ones, only presence, owner and mode of the ones that hold secrets.
   */
  runtimeFiles: z.array(RuntimeFileSchema),
  /** Every OpsCrew app on the server, by name; `record` is null when its file is damaged. */
  apps: z.array(z.object({ name: z.string(), record: AppRecordSchema.nullable() })),
  record: HostRecordSchema.nullable(),
  recordDamaged: z.boolean(),
  /** Dead-man switches still waiting on the server (from an interrupted apply). */
  pendingUndo: z.object({ sshd: z.boolean(), ufw: z.boolean() }),
  tunnel: AddonSchema,
  portainer: AddonSchema,
  /** Docker's firewall and OpsCrew's web filter. */
  webFilter: WebFilterFactsSchema,
});

export type HostFacts = z.infer<typeof HostFactsSchema>;

/** The records of the apps on the server that could be read (`HostFacts["apps"]`). */
export function readableRecords(apps: HostFacts["apps"]): AppRecord[] {
  return apps.flatMap((app) => (app.record === null ? [] : [app.record]));
}

/** The apps set up on the server (not those removed with their data kept), other than `app`. */
export function otherActiveApps(apps: HostFacts["apps"], app: string): AppRecord[] {
  return readableRecords(apps).filter((record) => record.app !== app && record.state === "active");
}

/** What a plan assumes about the other apps (`HostPlan.otherApps`): by name, sorted. */
export function assumedApps(others: readonly AppRecord[]): { app: string; deployKey: string }[] {
  return others
    .map((record) => ({ app: record.app, deployKey: record.deployKey }))
    .sort((a, b) => a.app.localeCompare(b.app));
}
