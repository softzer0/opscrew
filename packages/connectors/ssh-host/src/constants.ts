import { sha256Hex } from "@opscrew/core";

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

/**
 * The parent of each app's GitHub Actions runner, deploy's (0750): made at first boot on the
 * servers OpsCrew creates, and by the runner step's root part on a server the user owns.
 */
export const RUNNERS_DIR = "/srv/runners";

/**
 * The folder of an app's GitHub Actions runner, owned by deploy (0750), which runs it. The host
 * plan's app already names the environment (`<app>-<env>` for every environment but prod).
 */
export function runnerDir(app: string): string {
  return `${RUNNERS_DIR}/${app}`;
}

/** The systemd user unit (deploy's, in `~/.config/systemd/user`) that runs an app's runner. */
export function runnerUnit(app: string): string {
  return `opscrew-runner-${app}.service`;
}

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

/**
 * OpsCrew's monitoring add-ons, each one per server: Beszel and Grafana Alloy (feature 017), and
 * the self-hosted monitoring stack (feature 020).
 */
export const ADDON_KINDS = ["beszel", "alloy", "monitoring"] as const;
export type AddonKind = (typeof ADDON_KINDS)[number];

/** The parent of the add-ons' folders on a server the user owns (root's, 0700). */
export const ADDONS_DIR = `${ADDONS_ROOT}/addons`;
/** The parent of the add-ons' folders on a server OpsCrew created (the deploy user's). */
export const CLOUD_ADDONS_DIR = "/home/deploy/opscrew/addons";

/**
 * An add-on's folder: its Compose file and configuration as `renderAddon` renders them, its
 * secret files and its data, all the deploy user's (the add-on's containers run as that user;
 * the monitoring stack's run as their images' own users, and its Grafana password file is root's).
 * `runAs: "root"` is a server the user owns, `"login"` one OpsCrew created.
 */
export function addonDir(kind: AddonKind, runAs: "root" | "login"): string {
  return `${runAs === "root" ? ADDONS_DIR : CLOUD_ADDONS_DIR}/${kind}`;
}

/**
 * Each add-on's names: as users know it (`name`, in refusals), what runs on the server (`runs`, in
 * plan titles and step messages) and its `opscrew addon` name (`command`).
 */
export const ADDON_NAMES: Readonly<
  Record<AddonKind, { name: string; runs: string; command: string }>
> = {
  beszel: { name: "Beszel", runs: "Beszel", command: "beszel" },
  alloy: { name: "Grafana Cloud (Grafana Alloy)", runs: "Grafana Alloy", command: "grafana-cloud" },
  monitoring: {
    name: "OpsCrew's monitoring",
    runs: "the monitoring stack",
    command: "monitoring",
  },
};

/** Each add-on's Compose project, on every server. */
export const ADDON_PROJECTS: Readonly<Record<AddonKind, string>> = {
  beszel: "opscrew-beszel",
  alloy: "opscrew-alloy",
  monitoring: "opscrew-monitoring",
};

/**
 * Grafana's admin password in the monitoring stack's folder: root's, `0640`, read by Grafana
 * (user 472, group 0) through its group. Not `…password`: the redactor would take the Compose
 * file's mount line for a labelled secret.
 */
export const GRAFANA_ADMIN_CREDENTIAL = "grafana_admin_credential";

/**
 * The whole Postgres data source of the monitoring login, beside Alloy's Compose file, the deploy
 * user's `0600` (Alloy runs as that user).
 */
export const POSTGRES_MONITOR_CREDENTIAL = "postgres_monitor_credential";

/**
 * Alloy's secret files, which inspection never hashes: Grafana Cloud's token, then the monitoring
 * login's data source.
 */
export const ALLOY_SECRET_FILES = [
  "grafana_cloud_credential",
  POSTGRES_MONITOR_CREDENTIAL,
] as const;

/** Where an Alloy sends: Grafana Cloud, the self-hosted monitoring stack, or both. */
export const ALLOY_DESTINATIONS = ["grafanaCloud", "monitoring"] as const;
export type AlloyDestination = (typeof ALLOY_DESTINATIONS)[number];

/** The file in Alloy's folder that names its destinations (not secret; inspection reads it). */
export const ALLOY_DESTINATIONS_FILE = ".opscrew-destinations";

/**
 * The file in Alloy's folder that names the Postgres host its monitoring login's data source
 * reaches (not secret; inspection reads it instead of the data source).
 */
export const ALLOY_POSTGRES_HOST_FILE = ".opscrew-postgres-host";

/** The text in Beszel's rendered `config.yml` that the host step replaces with the agent token. */
// biome-ignore lint/suspicious/noTemplateCurlyInString: the placeholder is literal text.
export const BESZEL_TOKEN_PLACEHOLDER = "${BESZEL_TOKEN}";

/** The app's masking file Alloy reads (in the app's folder; the deploy job writes its values). */
export function maskFilePath(app: string): string {
  return `${appDirs(app).app}/mask.re`;
}

/** The masking file's content until the deploy job writes the app's values: it never matches. */
export const EMPTY_MASK = "[^\\s\\S]";

/**
 * The comment that marks a scheduled check's key in the deploy user's authorized_keys, followed
 * by its repository (`opscrew-check:<owner>/<repo>`): each repository has its own key.
 */
export const CHECK_KEY_COMMENT = "opscrew-check:";

/** The check key's comment for a repository (`owner/repo`). */
export function checkKeyComment(repository: string): string {
  return `${CHECK_KEY_COMMENT}${repository}`;
}

/**
 * The only command the check's key can run (OpenSSH's forced command), whatever the client asks.
 * It only reads, and it is one line with no `"`, as it sits inside `command="..."`. It prints
 * `df -P -B1 /`, then the line `scheduled` (an older OpsCrew's key, which ran only `df`, prints
 * none), then, for each app folder with a scheduled snapshot's log
 * (`.snapshots/scheduled.log`, feature 024), lines that start with `scheduled <app> `:
 * - `at <seconds>`: when the log was last written, in Unix seconds;
 * - `id <id>`: the log's last scheduled snapshot id line, which `snapshot.sh` prints once the
 *   snapshot is taken; none without one;
 * - `after <n>`: how many non-empty lines follow it (all of them without one);
 * - `running`: a snapshot is being taken (a `.partial` folder while the app's start lock is held).
 *
 * Nothing else of the log. `CHECK_COMMAND` in `@opscrew/iac-templates`' `check.mjs` is a copy,
 * which the server's own runner runs, and its `scheduledLog` the same reading of a log's lines.
 */
export const CHECK_KEY_COMMAND = [
  "df -P -B1 / && echo scheduled &&",
  `for d in ${APPS_DIR}/*/; do`,
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the shell's parameter expansion.
  "a=${d%/}; a=${a##*/};",
  "case $a in *[!a-z0-9-]*) continue;; esac;",
  "l=$d.snapshots/scheduled.log;",
  "test -f $l || continue;",
  "echo scheduled $a at $(stat -c %Y $l);",
  "m=$(grep -nE '^[0-9]{8}T[0-9]{6}Z$' $l | tail -n 1);",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the shell's parameter expansion.
  "test -z $m || echo scheduled $a id ${m#*:};",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the shell's parameter expansion.
  "echo scheduled $a after $(tail -n +$((${m%%:*}+1)) $l | grep -c '[^[:space:]]');",
  "for p in $d.snapshots/*.partial; do",
  "if test -d $p; then flock -n $d.start.lock true || echo scheduled $a running; fi;",
  "break;",
  "done;",
  "done",
].join(" ");

/**
 * A repository's check key line in authorized_keys, as the spike tested it under OpsCrew's sshd
 * settings: `restrict` turns off terminals and forwarding, and the forced command runs only
 * {@link CHECK_KEY_COMMAND}. `publicKey` is `<type> <base64>`, `repository` is `owner/repo`.
 */
export function checkKeyLine(publicKey: string, repository: string): string {
  return `restrict,command="${CHECK_KEY_COMMAND}" ${publicKey} ${checkKeyComment(repository)}`;
}

/**
 * `text` as a literal in both an ERE (`grep -E`) and a JavaScript RegExp: a backslash before each
 * character that is special in either. `]` and `}` are literal in both when no `[` or `{` opens
 * them, and newer GNU greps warn about a backslash before them.
 */
function literalRe(text: string): string {
  return text.replace(/[\\^$.|?*+()[{]/g, "\\$&");
}

/**
 * ERE (and JavaScript RegExp) for a check key line in OpsCrew's form, of any repository, with
 * exactly {@link CHECK_KEY_COMMAND}: the deploy-key step keeps it. A line with another command (an
 * older OpsCrew's) is no check key: the deploy-key step removes it, and the check-key step writes
 * the line again.
 */
export const CHECK_KEY_LINE_RE = `^restrict,command="${literalRe(CHECK_KEY_COMMAND)}" [^ ]+ [^ ]+ ${CHECK_KEY_COMMENT}[^ ]+$`;

/** The recipe file that is the preview command, the only one written runnable (0755). */
export const PREVIEW_COMMAND_FILE = "bin/opscrew-preview";

/**
 * A preview environment's command (feature 022), `/srv/apps/<app>/bin/opscrew-preview` in its
 * recipe folder: the preview key's forced command, and what the deploy user's cron runs for idle
 * previews.
 */
export function previewCommand(app: string): string {
  return `${appDirs(app).app}/${PREVIEW_COMMAND_FILE}`;
}

/**
 * The end of the app's line for scheduled snapshots in the deploy user's crontab (feature 024),
 * which the deploy writes: a copy of the tag in `@opscrew/iac-templates`' `workflow/snapshots.ts`.
 * Matched only at the end of the line, so `shop`'s never matches `shop-admin`'s.
 */
export function snapshotScheduleTag(app: string): string {
  return ` # opscrew-snapshots ${app}`;
}

/**
 * The app's snapshots (feature 024), `/srv/apps/<app>/.snapshots`: data, which a teardown keeps
 * unless it deletes the app's data. A copy of `SNAPSHOTS_DIR` in `@opscrew/iac-templates`'
 * `workflow/snapshots.ts`.
 */
export function snapshotsDir(app: string): string {
  return `${appDirs(app).app}/.snapshots`;
}

/**
 * The files of a recipe's folder that a recipe leaves out: the preview values and the preview
 * command's log. No recipe file takes their names, and inspection never reads them.
 */
export const RECIPE_LEFT_OUT: readonly string[] = ["values.env", "previews.log"];

/** `find`'s tests that skip {@link RECIPE_LEFT_OUT} in a recipe's folder (`find .` from it). */
export const RECIPE_LEFT_OUT_FIND = RECIPE_LEFT_OUT.map((name) => `! -path ./${name}`).join(" ");

/**
 * The comment that marks a preview environment's key in the deploy user's authorized_keys,
 * followed by its repository and app (`opscrew-preview:<owner>/<repo>:<app>`).
 */
export const PREVIEW_KEY_COMMENT = "opscrew-preview:";

/** The preview key's comment for a repository (`owner/repo`) and a preview environment's app. */
export function previewKeyComment(repository: string, app: string): string {
  return `${PREVIEW_KEY_COMMENT}${repository}:${app}`;
}

/**
 * A preview environment's key line in authorized_keys: `restrict` turns off terminals and
 * forwarding, and whatever it asks, the server runs only the app's preview command, which reads
 * the request from `SSH_ORIGINAL_COMMAND`. `publicKey` is `<type> <base64>`.
 */
export function previewKeyLine(publicKey: string, repository: string, app: string): string {
  return `restrict,command="${previewCommand(app)}" ${publicKey} ${previewKeyComment(repository, app)}`;
}

/** ERE for a preview key line in OpsCrew's form, of any app: the deploy-key step keeps it. */
export const PREVIEW_KEY_LINE_RE = `^restrict,command="${APPS_DIR}/[a-z0-9][a-z0-9-]*/${PREVIEW_COMMAND_FILE}" [^ ]+ [^ ]+ ${PREVIEW_KEY_COMMENT}[^ ]+$`;

/**
 * The deploy user's cron line that removes a preview environment's idle previews, hourly at a
 * minute from the app's name (1 to 59, so apps on one server spread out and none runs at 0).
 */
export function previewCronLine(app: string): string {
  const minute = 1 + (Number.parseInt(sha256Hex(app).slice(0, 8), 16) % 59);
  return `${minute} * * * * ${previewCommand(app)} gc`;
}

/**
 * Largest file of a preview recipe the adapter accepts. Its files reach the server on the apply's
 * standard input, not in the script.
 */
export const MAX_RECIPE_FILE_BYTES = 64 * 1024;

/** Largest set of preview values (`values.env`) the adapter accepts. */
export const MAX_PREVIEW_VALUES_BYTES = 64 * 1024;

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
/**
 * The private network's rules: its WireGuard port, SSH on its interface, and the host's own Docker
 * networks to its private address.
 */
export const UFW_NETWORK_COMMENT = "opscrew-network";
export const UFW_NETWORK_SSH_COMMENT = "opscrew-network-ssh";
export const UFW_NETWORK_LOCAL_COMMENT = "opscrew-network-local";

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

/**
 * Largest file of the monitoring stack the adapter accepts (its dashboards). Its files reach the
 * server on the apply's standard input, not in the script, so they need not fit in one argument.
 */
export const MAX_STACK_FILE_BYTES = 256 * 1024;

/** Largest script the adapter sends (well under Linux's 128 KiB per-argument limit). */
export const MAX_SCRIPT_BYTES = 100 * 1024;
