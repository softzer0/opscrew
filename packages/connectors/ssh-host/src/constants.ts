/** Docker Engine 28.0.0 keeps ports published on 127.0.0.1 unreachable from the local network. */
export const MIN_DOCKER_MAJOR = 28;

/** Packages OpsCrew installs from Docker's apt repository. */
export const DOCKER_PACKAGES =
  "docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin";

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
