/** The app's directory, where the deploy workflow keeps OpsCrew's runtime files. */
export const APP_DIR = "/srv/app";

/**
 * Runtime files OpsCrew renders into the repository and the deploy workflow copies to
 * {@link APP_DIR} unchanged: inspection reads their SHA-256 (never their content).
 */
export const HASHED_RUNTIME_FILES = ["compose.yaml", "Caddyfile"] as const;

/**
 * Files the deploy workflow writes in {@link APP_DIR} from secrets or from the deploy itself
 * (`app.env`, `db.env`: the app's and the database's secrets; `.env`: the running image).
 * Inspection reads only whether they exist, their owner and their mode: never their content and
 * never a checksum, since OpsCrew cannot render the same bytes without the secrets.
 */
export const SECRET_RUNTIME_FILES = [".env", "app.env", "db.env"] as const;

/** Every runtime file inspection looks at in {@link APP_DIR}. */
export const RUNTIME_FILE_NAMES = [...HASHED_RUNTIME_FILES, ...SECRET_RUNTIME_FILES] as const;
export type RuntimeFileName = (typeof RUNTIME_FILE_NAMES)[number];

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

/** The Cloudflare Tunnel connector: its own Compose project, token in `tunnel.env` beside it. */
export const TUNNEL_DIR = `${ADDONS_ROOT}/cloudflared`;
export const TUNNEL_PROJECT = "opscrew-tunnel";

/** In tunnel mode the app's Caddy publishes only this port on 127.0.0.1. */
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

/** The content of OpsCrew's sshd drop-in for the sshd step's parameters. */
export function sshdDropIn(p: {
  permitRootLogin: string;
  disablePasswords: boolean;
  kbdInteractiveOff: boolean;
}): string {
  return [
    SSHD_HEADER,
    `PermitRootLogin ${p.permitRootLogin}`,
    ...(p.disablePasswords ? ["PasswordAuthentication no"] : []),
    ...(p.kbdInteractiveOff ? ["KbdInteractiveAuthentication no"] : []),
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
