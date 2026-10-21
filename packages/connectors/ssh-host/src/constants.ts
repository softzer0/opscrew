/** The parent of each app's folder: its Compose project and env files (see {@link appDirs}). */
export const APPS_DIR = "/srv/apps";
/** The parent of each app's data folder. */
export const DATA_DIR = "/srv/data";
/** The shared edge every app on the server sits behind (Caddy and kamal-proxy). */
export const EDGE_DIR = "/srv/edge";
/**
 * The edge's Compose project, and the network every app's web service joins. No app may use the
 * name.
 */
export const EDGE_PROJECT = "opscrew-edge";

/** The folders the apps share, which the `runtime-dirs` step creates for the deploy user. */
export const SHARED_DIRS = [EDGE_DIR, APPS_DIR, DATA_DIR] as const;

/** An app's own folders: `/srv/apps/<app>` (Compose project, env files) and `/srv/data/<app>`. */
export function appDirs(app: string): { app: string; data: string } {
  return { app: `${APPS_DIR}/${app}`, data: `${DATA_DIR}/${app}` };
}

/**
 * Runtime files OpsCrew renders into the repository and the deploy workflow copies to the server
 * unchanged: the app's Compose file in its folder, and its site on the shared edge (`site`, see
 * {@link runtimeFilePath}). Inspection reads their SHA-256 (never their content).
 */
export const HASHED_RUNTIME_FILES = ["compose.yaml", "site"] as const;

/**
 * Files the deploy workflow writes in every app's folder from secrets or from the deploy itself
 * (`app.env`: the app's secrets; `.env`: the running image). Inspection reads only whether they
 * exist, their owner and their mode: never their content and never a checksum, since OpsCrew
 * cannot render the same bytes without the secrets.
 */
export const SECRET_RUNTIME_FILES = [".env", "app.env"] as const;

/** The runtime files inspection always reports for each app, `absent` when missing. */
export const RUNTIME_FILE_NAMES = [...HASHED_RUNTIME_FILES, ...SECRET_RUNTIME_FILES] as const;

/**
 * A runtime file inspection reports: one of {@link RUNTIME_FILE_NAMES}, or the env file of one of
 * the app's services with secrets (`<service>.env`, which the deploy workflow writes, `db.env`
 * for Postgres), reported when it is there, by presence, owner and mode only.
 */
export type RuntimeFileName = (typeof RUNTIME_FILE_NAMES)[number] | `${string}.env`;

/** The kernel settings a host plan may raise for the apps' services (each a minimum). */
export const HOST_SYSCTL_KEYS = ["vm.max_map_count"] as const;
/** OpsCrew's file of those settings, which keeps them after a restart. */
export const SYSCTL_FILE = "/etc/sysctl.d/90-opscrew.conf";

/** Where an app's runtime file is: its site on the shared edge, the others in the app's folder. */
export function runtimeFilePath(app: string, name: RuntimeFileName): string {
  return name === "site" ? `${EDGE_DIR}/sites/${app}.caddy` : `${appDirs(app).app}/${name}`;
}

/** Where OpsCrew keeps its records and backups on the server (root only). */
export const OPSCREW_DIR = "/etc/opscrew";
/** What OpsCrew changed on the server, the values it replaced, and the apps on it. */
export const RECORD_PATH = `${OPSCREW_DIR}/host.json`;
/** Each app's record: `<APP_RECORDS_DIR>/<app>.json`. */
export const APP_RECORDS_DIR = `${OPSCREW_DIR}/apps`;
/** The dead-man switch's undo scripts, saved state, locks and marks. */
export const DEAD_MAN_DIR = `${OPSCREW_DIR}/deadman`;
/** Files OpsCrew replaced, kept for `opscrew destroy --undo-host`. */
export const BACKUP_DIR = `${OPSCREW_DIR}/backup`;

/** OpsCrew's sshd drop-in, and the user's own file of that name from before OpsCrew. */
export const SSHD_DROP_IN = "/etc/ssh/sshd_config.d/10-opscrew.conf";
export const SSHD_BACKUP = `${BACKUP_DIR}/10-opscrew.conf`;

/** OpsCrew's apt settings for automatic security updates. */
export const AUTO_UPGRADES_FILE = "/etc/apt/apt.conf.d/21opscrew-auto-upgrades";

/** Where package steps write apt's output (root only; no secrets ever reach apt). */
export const APT_LOG = "/var/log/opscrew/apt.log";

/** Docker Engine 28.0.0 keeps ports published on 127.0.0.1 unreachable from the local network. */
export const MIN_DOCKER_MAJOR = 28;

/** Packages OpsCrew installs from Docker's apt repository. */
export const DOCKER_PACKAGES =
  "docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin";

/**
 * OpsCrew's Docker daemon settings, the same as on servers it creates (cloud-init): log rotation,
 * no-new-privileges and live-restore. Written only when the server has no daemon.json.
 */
export const DOCKER_DAEMON_JSON_PATH = "/etc/docker/daemon.json";
export const DOCKER_DAEMON_JSON = `{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" },
  "no-new-privileges": true,
  "live-restore": true
}
`;

/** OpsCrew's fail2ban jail for SSH (journald backend: Debian 12+ has no /var/log/auth.log). */
export const FAIL2BAN_JAIL_PATH = "/etc/fail2ban/jail.d/opscrew.local";

/** The jail file for the given SSH ports. */
export function fail2banJail(ports: readonly number[]): string {
  return [
    "# Managed by OpsCrew: brute-force protection for SSH.",
    "[sshd]",
    "enabled = true",
    `port = ${ports.join(",")}`,
    "backend = systemd",
    "maxretry = 5",
    "bantime = 1h",
    "",
  ].join("\n");
}

/** Set once the host setup finished (the same flag cloud-init sets; `opscrew secure` reads it). */
export const READY_FLAG = "/var/lib/opscrew-ready";

/** Root-owned directory for OpsCrew's add-on Compose projects on servers the user owns. */
export const ADDONS_ROOT = "/srv/opscrew";

/** The parent of each app's Cloudflare Tunnel connector on a server the user owns. */
export const TUNNELS_DIR = `${ADDONS_ROOT}/cloudflared`;

/**
 * The folder of an app's Cloudflare Tunnel connector on a server the user owns: its Compose file,
 * its token in `tunnel.env` (root only) and its tunnel's id in `tunnel.id`.
 */
export function tunnelDir(app: string): string {
  return `${TUNNELS_DIR}/${app}`;
}

/** The Compose project of an app's Cloudflare Tunnel connector, on every server. */
export function tunnelProject(app: string): string {
  return `${app}-tunnel`;
}

/** In tunnel mode the shared edge's Caddy publishes only this port on 127.0.0.1. */
export const TUNNEL_APP_PORT = 18080;

/** Portainer CE: its own Compose project; on servers the user owns it lives under /srv/opscrew. */
export const PORTAINER_DIR = `${ADDONS_ROOT}/portainer`;
export const PORTAINER_PROJECT = "opscrew-portainer";
export const PORTAINER_REPOSITORY = "portainer/portainer-ce";

/** Portainer listens only on the server itself. */
export const PORTAINER_PORT = 9443;

/** Seconds before the server undoes an SSH or firewall change on its own. */
export const DEFAULT_DEAD_MAN_SECONDS = 180;

/** First line of OpsCrew's sshd drop-in. */
export const SSHD_HEADER =
  "# Managed by OpsCrew. `opscrew destroy --undo-host` puts the previous setting back.";

/** sshd's moduli file (an openssh-server conffile, never changed). */
export const SSHD_MODULI = "/etc/ssh/moduli";
/** OpsCrew's copy of it with only the groups of 3072 bits and more, read through `ModuliFile`. */
export const SSHD_MODULI_FILE = "/etc/ssh/moduli.opscrew";

/** The `awk` program that keeps only the moduli of 3072 bits and more (research R8). */
export const MODULI_FILTER = "$5 >= 3071";

/** The ECDSA host key algorithms a pinned host key may have. */
export const ECDSA_HOST_KEY_TYPES = [
  "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521",
] as const;
export type EcdsaHostKeyType = (typeof ECDSA_HOST_KEY_TYPES)[number];

/**
 * The content of OpsCrew's sshd drop-in for the sshd step's parameters: the login settings, and
 * the key exchanges, ciphers, MACs and host key algorithms of ssh-audit's Ubuntu 24.04 guide
 * (research R8). The user-key types (`PubkeyAcceptedAlgorithms` and the like) stay as they are,
 * so other accounts' ECDSA or FIDO keys keep working.
 */
export function sshdDropIn(p: {
  permitRootLogin: string;
  disablePasswords: boolean;
  kbdInteractiveOff: boolean;
  /** sshd knows `ModuliFile` (OpenSSH 8.6 and later), so it reads {@link SSHD_MODULI_FILE}. */
  moduliFile: boolean;
  /** The pinned host key's ECDSA algorithm, which keeps the ECDSA host key offered. */
  ecdsaHostKey?: EcdsaHostKeyType | undefined;
}): string {
  return [
    SSHD_HEADER,
    `PermitRootLogin ${p.permitRootLogin}`,
    ...(p.disablePasswords ? ["PasswordAuthentication no"] : []),
    ...(p.kbdInteractiveOff ? ["KbdInteractiveAuthentication no"] : []),
    "KexAlgorithms sntrup761x25519-sha512@openssh.com,curve25519-sha256,curve25519-sha256@libssh.org,diffie-hellman-group18-sha512,diffie-hellman-group-exchange-sha256,diffie-hellman-group16-sha512",
    "Ciphers chacha20-poly1305@openssh.com,aes256-gcm@openssh.com,aes256-ctr,aes192-ctr,aes128-gcm@openssh.com,aes128-ctr",
    "MACs hmac-sha2-512-etm@openssh.com,hmac-sha2-256-etm@openssh.com,umac-128-etm@openssh.com",
    "HostKey /etc/ssh/ssh_host_ed25519_key",
    "HostKey /etc/ssh/ssh_host_rsa_key",
    ...(p.ecdsaHostKey ? ["HostKey /etc/ssh/ssh_host_ecdsa_key"] : []),
    `HostKeyAlgorithms sk-ssh-ed25519-cert-v01@openssh.com,ssh-ed25519-cert-v01@openssh.com,rsa-sha2-512-cert-v01@openssh.com,rsa-sha2-256-cert-v01@openssh.com,sk-ssh-ed25519@openssh.com,ssh-ed25519,rsa-sha2-512,rsa-sha2-256${p.ecdsaHostKey ? `,${p.ecdsaHostKey}` : ""}`,
    ...(p.moduliFile ? [`ModuliFile ${SSHD_MODULI_FILE}`] : []),
    "",
  ].join("\n");
}

/** ufw rule comments that mark rules OpsCrew added. */
export const UFW_SSH_COMMENT = "opscrew-ssh";
export const UFW_WEB_COMMENT = "opscrew-web";

/** Web rules OpsCrew opens in public mode (HTTP, HTTPS and HTTP/3). */
export const WEB_RULES = ["80/tcp", "443/tcp", "443/udp"] as const;

/** Supported operating systems: the Ubuntu LTS and Debian stable releases Docker supports. */
export const SUPPORTED_OS: Readonly<Record<string, readonly string[]>> = {
  ubuntu: ["22.04", "24.04", "26.04"],
  debian: ["12", "13"],
};

export const SUPPORTED_ARCH = ["amd64", "arm64"] as const;

/**
 * Largest Compose file the adapter accepts from the caller. Scripts travel as one shell argument,
 * and Linux limits a single argument to 128 KiB; two base64 Compose files must fit with room.
 */
export const MAX_COMPOSE_BYTES = 16 * 1024;

/** Largest script the adapter sends (well under Linux's 128 KiB per-argument limit). */
export const MAX_SCRIPT_BYTES = 100 * 1024;
