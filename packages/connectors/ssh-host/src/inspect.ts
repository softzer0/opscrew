// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are shell and Go templates, not JavaScript templates.
import type { RemoteExec } from "@opscrew/contracts";
import { canonicalJson, isRecord, OpsCrewError } from "@opscrew/core";
import {
  ADDON_KINDS,
  ADDON_PROJECTS,
  APP_RECORDS_DIR,
  APPS_DIR,
  addonDir,
  CHECK_KEY_COMMENT,
  CHECK_KEY_LINE_RE,
  DATA_DIR,
  DOCKER_DAEMON_JSON,
  DOCKER_DAEMON_JSON_PATH,
  EDGE_DIR,
  FAIL2BAN_JAIL_PATH,
  HASHED_RUNTIME_FILES,
  HOST_SYSCTL_KEYS,
  PORTAINER_DIR,
  PORTAINER_PROJECT,
  READY_FLAG,
  RECORD_PATH,
  RUNNERS_DIR,
  RUNTIME_FILE_NAMES,
  SECRET_RUNTIME_FILES,
  SHARED_DIRS,
  SSHD_DROP_IN,
  SYSCTL_FILE,
  TUNNELS_DIR,
  tunnelProject,
} from "./constants";
import {
  type HostFacts,
  HostFactsSchema,
  HostRecordSchema,
  type RunnerFacts,
  RunnerFactsSchema,
  type WebFilterFacts,
} from "./facts";
import { foreignFirewalls } from "./firewall";
import { NETWORK_DROP_IN, WIREGUARD_DIR } from "./network";
import {
  NETWORK_FILTER_SCRIPT_PREFIX,
  NETWORK_FILTER_UNIT,
  networkFilterChain,
  networkFilterDropInPath,
  networkFilterService,
} from "./network-filter";
import {
  dockerdFlags,
  EXIT_MARK,
  engineVersion,
  linesOf,
  parseAddons,
  parseAddresses,
  parseAppRecords,
  parseAptPeriodic,
  parseAvx,
  parseContainers,
  parseDf,
  parseDirs,
  parseDockerUserChain,
  parseDpkg,
  parseFree,
  parseIpv4Routes,
  parseNetworkState,
  parseNsswitchPasswd,
  parseOpensshVersion,
  parseOsRelease,
  parsePairs,
  parseRunners,
  parseRuntimeFiles,
  parseSs,
  parseSshdT,
  parseSysctl,
  parseUfwAdded,
  parseUfwDefaults,
  parseUsers,
  parseWebFilterChain,
  parseWireguardLinks,
  SECTION_MARK,
  type Section,
  splitSections,
  udpPorts,
} from "./parse";
import { callOptions, type RemoteCall, rootCall } from "./privilege";
import { asLogin, asRoot, buildScript } from "./shell";
import {
  SSH_FIREWALL_FUNCTIONS,
  SSH_FIREWALL_RULES,
  SSH_FIREWALL_SERVICE,
  SSH_FIREWALL_UNIT,
} from "./ssh-firewall";
import { AppNameSchema } from "./types";
import {
  WEB_FILTER_DROP_IN,
  WEB_FILTER_SCRIPT,
  WEB_FILTER_SERVICE,
  WEB_FILTER_UNIT,
} from "./web-filter";

/** Packages whose state inspection reads (Docker's, the conflicting ones and OpsCrew's tools). */
export const INSPECTED_PACKAGES = [
  "docker-ce",
  "docker-ce-cli",
  "containerd.io",
  "docker-compose-plugin",
  "docker-buildx-plugin",
  "docker.io",
  "docker-compose",
  "docker-compose-v2",
  "docker-doc",
  "podman-docker",
  "containerd",
  "runc",
  "ufw",
  "unattended-upgrades",
  "curl",
  "fail2ban",
] as const;

/** Distribution packages Docker lists as conflicting with Docker Engine. */
export const CONFLICTING_PACKAGES = [
  "docker.io",
  "docker-compose",
  "docker-compose-v2",
  "docker-doc",
  "podman-docker",
  "containerd",
  "runc",
] as const;

const USERS_SNIPPET = `akf=$(sshd -T 2>/dev/null | awk '$1 == "authorizedkeysfile" { $1 = ""; sub(/^ /, ""); print }')
[ -n "$akf" ] || akf='.ssh/authorized_keys .ssh/authorized_keys2'
pwusers=$(getent shadow 2>/dev/null | awk -F: '$2 != "" && $2 !~ /^[!*]/ { print $1 }')
getent passwd | while IFS=: read -r name _x uid _g _c home shell; do
  case "$shell" in ''|*/nologin|*/false|*/sync|*/halt|*/shutdown) continue ;; esac
  case "$uid" in ''|*[!0-9]*) continue ;; esac
  if [ "$uid" -ne 0 ] && { [ "$uid" -lt 1000 ] || [ "$uid" -eq 65534 ]; }; then continue; fi
  pw=nopw
  if printf '%s\\n' "$pwusers" | grep -qxF -- "$name"; then pw=pw; fi
  keys=nokeys
  set -f
  for pat in $akf; do
    f=$(printf '%s' "$pat" | sed -e "s|%h|$home|g" -e "s|%u|$name|g" -e "s|%U|$uid|g" -e 's|%%|%|g')
    case "$f" in /*) ;; *) f="$home/$f" ;; esac
    if [ -s "$f" ]; then keys=keys; fi
  done
  set +f
  printf '%s:%s:%s:%s\\n' "$name" "$uid" "$pw" "$keys"
done`;

/** `app_name <name>`: the name is an OpsCrew app name (anything else is never printed). */
const APP_NAME_FN = `app_name() {
  case "$1" in ''|-*|*[!a-z0-9-]*) return 1 ;; esac
  [ "\${#1}" -le 41 ]
}`;

/**
 * The shared folders and the runners' parent, then each app's folder in /srv/apps and /srv/data
 * (never through a link).
 */
const DIRS_SNIPPET = `${APP_NAME_FN}
dir_line() {
  if [ -L "$1" ]; then echo "$1 link"
  elif [ -d "$1" ]; then echo "$1 dir $(stat -c '%U %G %a' "$1") $(ls -A "$1" | wc -l)"
  elif [ -e "$1" ]; then echo "$1 other"
  else echo "$1 absent"; fi
}
for d in ${SHARED_DIRS.join(" ")} ${RUNNERS_DIR}; do dir_line "$d"; done
for parent in ${APPS_DIR} ${DATA_DIR}; do
  if [ -L "$parent" ] || [ ! -d "$parent" ]; then continue; fi
  for d in "$parent"/*; do
    app_name "\${d##*/}" || continue
    if [ -e "$d" ] || [ -L "$d" ]; then dir_line "$d"; fi
  done
done`;

/**
 * OpsCrew's runtime files of each app with a folder (`/srv/apps/<app>`), the app's site on the
 * shared edge included (the site file of the edge's proxy: `/srv/edge/sites/<app>.conf` when the
 * edge's Compose file is stamped nginx, `<app>.caddy` otherwise), then each service's
 * `<service>.env` found in the app's folder: kind, owner, group and mode of each, and the SHA-256
 * of the rendered ones only. Never prints a file's content, never hashes a file that
 * holds secrets, and never follows a symbolic link (an app folder that is a link, or /srv/apps
 * itself, is skipped; a site under a linked edge folder is reported as a link).
 */
export const RUNTIME_FILES_SNIPPET = `${APP_NAME_FN}
site_ext=caddy
if [ ! -L "${EDGE_DIR}" ] && [ -f "${EDGE_DIR}/compose.yaml" ] && [ ! -L "${EDGE_DIR}/compose.yaml" ] &&
  grep -q '^x-opscrew-edge-proxy: *nginx *$' "${EDGE_DIR}/compose.yaml"; then site_ext=conf; fi
if [ -d "${APPS_DIR}" ] && [ ! -L "${APPS_DIR}" ]; then
  for d in "${APPS_DIR}"/*; do
    app=\${d##*/}
    app_name "$app" || continue
    if [ -L "$d" ] || [ ! -d "$d" ]; then continue; fi
    for f in ${RUNTIME_FILE_NAMES.join(" ")}; do
      p="$d/$f"
      if [ "$f" = site ]; then
        p="${EDGE_DIR}/sites/$app.$site_ext"
        if [ -L "${EDGE_DIR}" ] || [ -L "${EDGE_DIR}/sites" ]; then echo "$app $f link"; continue; fi
      fi
      if [ -L "$p" ]; then echo "$app $f link"
      elif [ -f "$p" ]; then
        sum=-
        case "$f" in ${HASHED_RUNTIME_FILES.join("|")}) sum=$(sha256sum "$p" | cut -d ' ' -f 1) ;; esac
        echo "$app $f file $(stat -c '%U %G %a' "$p") \${sum:--}"
      elif [ -e "$p" ]; then echo "$app $f other"
      else echo "$app $f absent"; fi
    done
    for p in "$d"/*.env; do
      f=\${p##*/}
      case "$f" in ${SECRET_RUNTIME_FILES.join("|")}) continue ;; esac
      case "\${f%.env}" in [a-z]*) ;; *) continue ;; esac
      case "\${f%.env}" in *[!a-z0-9-]*) continue ;; esac
      if [ -L "$p" ]; then echo "$app $f link"
      elif [ -f "$p" ]; then echo "$app $f file $(stat -c '%U %G %a' "$p") -"
      elif [ -e "$p" ]; then echo "$app $f other"; fi
    done
  done
fi`;

/**
 * The kernel settings a host plan may raise: `live <key> <value>` for each, and `file <key>
 * <value>` for each line of OpsCrew's file in /etc/sysctl.d.
 */
export const SYSCTL_SNIPPET = `for k in ${HOST_SYSCTL_KEYS.join(" ")}; do printf 'live %s %s\\n' "$k" "$(sysctl -n "$k" 2>/dev/null)"; done
if [ -f ${SYSCTL_FILE} ] && [ ! -L ${SYSCTL_FILE} ]; then sed -n 's/^\\([a-z0-9_.]*\\) = \\([0-9]*\\)$/file \\1 \\2/p' ${SYSCTL_FILE}; fi`;

/** Each app's record on one line, after its name (records hold no secrets). */
const APPS_SNIPPET = `${APP_NAME_FN}
for f in "${APP_RECORDS_DIR}"/*.json; do
  if [ -L "$f" ] || [ ! -f "$f" ]; then continue; fi
  name=\${f##*/}
  name=\${name%.json}
  app_name "$name" || continue
  printf '%s ' "$name"
  tr '\\r\\n' '  ' < "$f"
  echo
done`;

/** Portainer, and each app's tunnel connector (`tunnel:<app>`) in its folder of /srv/opscrew/cloudflared. */
const ADDONS_SNIPPET = `${APP_NAME_FN}
addon() {
  if [ -f "$2/compose.yaml" ]; then
    sum=$(sha256sum "$2/compose.yaml" | cut -d ' ' -f 1)
    secret=no
    if [ -s "$2/$3" ]; then secret=yes; fi
    id=$(head -n 1 "$2/tunnel.id" 2>/dev/null) || id=''
    echo "$1 installed \${sum:--} $secret \${id:--}"
  else
    echo "$1 absent"
  fi
}
if [ -d "${TUNNELS_DIR}" ] && [ ! -L "${TUNNELS_DIR}" ]; then
  for d in "${TUNNELS_DIR}"/*; do
    app_name "\${d##*/}" || continue
    if [ -L "$d" ] || [ ! -d "$d" ]; then continue; fi
    addon "tunnel:\${d##*/}" "$d" tunnel.env
  done
fi
addon portainer ${PORTAINER_DIR} admin_password
# The monitoring add-ons: "kept" is a folder without its Compose file (Beszel's history kept).
monitor() {
  if [ -L "$2" ] || [ ! -d "$2" ]; then echo "$1 absent"; return 0; fi
  state=kept
  sum=-
  if [ -f "$2/compose.yaml" ]; then
    state=installed
    sum=$(sha256sum "$2/compose.yaml" | cut -d ' ' -f 1)
  fi
  data=no
  if [ -d "$2/data" ]; then data=yes; fi
  echo "$1 $state \${sum:--} $data -"
}
${ADDON_KINDS.map((kind) => `monitor ${kind} ${addonDir(kind, "root")}`).join("\n")}`;

/**
 * Each app's GitHub Actions runner in its folder of /srv/runners: whether it registered, the
 * state of deploy's user service `opscrew-runner-<app>.service`, its version, and the label and
 * repository OpsCrew registered it with (in its own `.opscrew-runner`: the runner's `.runner`
 * holds no labels), and the SHA-256 of its unit in deploy's home. The service's state and the version (from the runner's own binary) are read as
 * deploy, its owner: through `runuser` when inspection runs as root, directly when the login is
 * deploy (a server OpsCrew created). Not yet checked on a real server (spike item 4): `.runner`,
 * and that `--version` prints only the version.
 */
const RUNNERS_SNIPPET = `${APP_NAME_FN}
if [ "$(id -u)" = 0 ]; then as_deploy() { runuser -u deploy -- "$@"; }; else as_deploy() { "$@"; }; fi
uid=$(id -u deploy 2>/dev/null) || uid=''
units="$(getent passwd deploy | cut -d: -f6)/.config/systemd/user"
if [ -n "$uid" ] && [ -d "${RUNNERS_DIR}" ] && [ ! -L "${RUNNERS_DIR}" ]; then
  for d in "${RUNNERS_DIR}"/*; do
    app_name "\${d##*/}" || continue
    if [ -L "$d" ] || [ ! -d "$d" ]; then continue; fi
    registered=no
    if [ -f "$d/.runner" ]; then registered=yes; fi
    state=$(as_deploy env XDG_RUNTIME_DIR="/run/user/$uid" systemctl --user is-active "opscrew-runner-\${d##*/}.service" 2>/dev/null) || true
    version=''
    if [ -x "$d/bin/Runner.Listener" ]; then
      version=$(as_deploy timeout 30 "$d/bin/Runner.Listener" --version </dev/null 2>/dev/null | tail -n 1) || version=''
    fi
    label=$(sed -n 's/^label=//p' "$d/.opscrew-runner" 2>/dev/null) || label=''
    url=$(sed -n 's/^url=//p' "$d/.opscrew-runner" 2>/dev/null) || url=''
    unit=-
    if [ -f "$units/opscrew-runner-\${d##*/}.service" ]; then
      unit=$(sha256sum "$units/opscrew-runner-\${d##*/}.service" | cut -d ' ' -f 1)
    fi
    echo "\${d##*/} $registered \${state:-inactive} \${version:--} \${label:--} \${url:--} $unit"
  done
fi`;

/** OpsCrew's web filter: its files' SHA-256 and its unit's state. */
const WEB_FILTER_SNIPPET = `for f in script:${WEB_FILTER_SCRIPT} unit:${WEB_FILTER_UNIT} dropin:${WEB_FILTER_DROP_IN}; do
  if [ -f "\${f#*:}" ]; then echo "file \${f%%:*} $(sha256sum "\${f#*:}" | cut -d ' ' -f 1)"; else echo "file \${f%%:*} -"; fi
done
echo "enabled $(systemctl is-enabled ${WEB_FILTER_SERVICE} 2>/dev/null)"
echo "active $(systemctl is-active ${WEB_FILTER_SERVICE} 2>/dev/null)"`;

/** OpsCrew's SSH firewall: nft, its files, its unit and its table (see `parseSshFirewall`). */
const SSH_FIREWALL_SNIPPET = `${SSH_FIREWALL_FUNCTIONS}
if command -v nft >/dev/null 2>&1; then echo 'nft yes'; else echo 'nft no'; fi
for f in rules:${SSH_FIREWALL_RULES} unit:${SSH_FIREWALL_UNIT}; do
  if [ -f "\${f#*:}" ]; then echo "file \${f%%:*} $(sha256sum "\${f#*:}" | cut -d ' ' -f 1)"; else echo "file \${f%%:*} -"; fi
done
echo "enabled $(systemctl is-enabled ${SSH_FIREWALL_SERVICE} 2>/dev/null)"
echo "table $(nft_table)"`;

/**
 * OpsCrew's private networks, as the `network` step checks them (see `parseNetworkState`): the
 * drop-in's SHA-256, and for each interface with a configuration its SHA-256, its key file's
 * public key (never the key), its unit, addresses and peers. Root only.
 */
const NETWORK_SNIPPET = `# The file's SHA-256, or - when it is missing.
sum_or_dash() { if [ -f "$1" ]; then sha256sum "$1" | cut -d ' ' -f 1; else echo -; fi; }
# Whether the unit $2 is enabled and active: "$1 enabled yes|no", then "$1 active yes|no".
unit_state() {
  if [ "$(systemctl is-enabled "$2")" = enabled ]; then echo "$1 enabled yes"; else echo "$1 enabled no"; fi
  if systemctl is-active --quiet "$2"; then echo "$1 active yes"; else echo "$1 active no"; fi
}
echo "dropin $(sum_or_dash ${NETWORK_DROP_IN})"
for conf in ${WIREGUARD_DIR}/wg-opscrew*.conf; do
  [ -f "$conf" ] || continue
  name=\${conf##*/}
  name=\${name%.conf}
  case "\${name#wg-opscrew}" in ''|*[!0-9]*) continue ;; esac
  echo "iface $name config $(sum_or_dash "$conf")"
  pub=$(wg pubkey < "${WIREGUARD_DIR}/$name.key") || pub=''
  echo "iface $name key \${pub:--}"
  unit_state "iface $name" "wg-quick@$name.service"
  ip -4 -o addr show dev "$name" | awk -v name="$name" '{ print "iface " name " address " $4 }'
  wg show "$name" peers | sed "s/^/iface $name peer /"
done
echo "filterunit $(sum_or_dash ${NETWORK_FILTER_UNIT})"
for script in ${NETWORK_FILTER_SCRIPT_PREFIX}wg-opscrew*; do
  [ -f "$script" ] || continue
  name=\${script#${NETWORK_FILTER_SCRIPT_PREFIX}}
  case "\${name#wg-opscrew}" in ''|*[!0-9]*) continue ;; esac
  echo "filter $name script $(sum_or_dash "$script")"
  echo "filter $name dropin $(sum_or_dash "${networkFilterDropInPath("$name")}")"
  unit_state "filter $name" "${networkFilterService("$name")}"
  if iptables -w -C DOCKER-USER -j "${networkFilterChain("$name")}" 2>/dev/null; then echo "filter $name jump yes"; else echo "filter $name jump no"; fi
  iptables -w -S "${networkFilterChain("$name")}" 2>/dev/null | sed "s/^/filter $name rule /"
done`;

/** Directory services that log users in without local passwords or keys OpsCrew can see. */
const DIRECTORY_PAM = "pam_(sss|ldap|krb5|winbind)";
const PAM_FILES = [
  "/etc/pam.d/common-auth",
  "/etc/pam.d/common-account",
  "/etc/pam.d/sshd",
  "/etc/pam.d/system-auth",
  "/etc/pam.d/password-auth",
];

/** Read-only inspection commands, one section each. */
export const INSPECT_SECTIONS: readonly (readonly [string, string])[] = [
  // Under sudo, SUDO_USER names the login that ran it.
  ["whoami", `printf '%s\\n' "\${SUDO_USER:-$(id -un)}"`],
  ["os-release", "cat /etc/os-release"],
  ["dpkg-arch", "dpkg --print-architecture"],
  ["uname", "uname -m"],
  ["nproc", "nproc"],
  ["cpu-flags", "grep -m1 -E '^flags[[:space:]]*:' /proc/cpuinfo"],
  ["free", "free -b"],
  ["df", "df -P -B1 /"],
  ["systemd", "test -d /run/systemd/system"],
  ["flock", "command -v flock"],
  ["addresses", "ip -o addr show scope global"],
  ["sshd", "sshd -T"],
  ["openssh", "ssh -V 2>&1"],
  [
    "sshd-include",
    "grep -Eis '^[[:space:]]*include[[:space:]].*sshd_config\\.d/' /etc/ssh/sshd_config",
  ],
  ["sshd-dropin", `cat ${SSHD_DROP_IN}`],
  ["logins-nss", "grep -E '^[[:space:]]*passwd:' /etc/nsswitch.conf"],
  [
    "logins-pam",
    `grep -hE '^[[:space:]]*[^#[:space:]].*${DIRECTORY_PAM}\\.so' ${PAM_FILES.join(" ")} | grep -oE '${DIRECTORY_PAM}' | sort -u`,
  ],
  ["dpkg-interrupted", "ls -A /var/lib/dpkg/updates"],
  ["listeners", "ss -H -ltnup"],
  // The private network's facts, read without root: the WireGuard interfaces and the routes.
  ["wireguard", "ip -o link show type wireguard"],
  ["routes", "ip -4 route show"],
  [
    "units",
    `for u in firewalld nftables docker fail2ban; do printf '%s %s\\n' "$u" "$(systemctl is-active "$u" 2>/dev/null)"; done`,
  ],
  ["docker-daemon", `cat ${DOCKER_DAEMON_JSON_PATH}`],
  ["fail2ban-jail", `cat ${FAIL2BAN_JAIL_PATH}`],
  ["fail2ban-sshd", "fail2ban-client status sshd"],
  ["upgrades-enabled", "systemctl is-enabled unattended-upgrades"],
  ["ready", `test -f ${READY_FLAG}`],
  ["ufw-status", "ufw status"],
  ["ufw-added", "ufw show added"],
  ["ufw-defaults", "grep -E '^DEFAULT_(INPUT|OUTPUT|FORWARD)_POLICY=' /etc/default/ufw"],
  ["iptables", "iptables-save"],
  ["ip6tables", "ip6tables-save"],
  ["nft", "nft list ruleset"],
  ["snap-docker", "snap list docker"],
  [
    "packages",
    `dpkg-query -W -f='\${Package}|\${Status}|\${Version}\\n' ${INSPECTED_PACKAGES.join(" ")}`,
  ],
  // Client-only commands; everything that talks to dockerd waits for docker_up so a stopped
  // daemon is never started by docker.socket just because OpsCrew looked.
  ["docker-cli", "docker --version"],
  ["docker-server", "docker_up && docker version --format '{{.Server.Version}}'"],
  ["docker-compose", "docker compose version --short"],
  ["docker-buildx", "docker buildx version"],
  ["docker-exec", "systemctl show -p ExecStart -p Environment docker"],
  ["docker-swarm", "docker_up && docker info --format '{{.Swarm.LocalNodeState}}'"],
  [
    "docker-sources",
    "grep -ls 'download.docker.com' /etc/apt/sources.list /etc/apt/sources.list.d/*",
  ],
  [
    "containers",
    `docker_up && docker ps -a --format '{{.Names}}|{{.Label "com.docker.compose.project"}}|{{.Ports}}|{{.State}}'`,
  ],
  ["volumes", `docker_up && docker volume ls --format '{{.Label "com.docker.compose.project"}}'`],
  ["users", USERS_SNIPPET],
  ["deploy", "getent passwd deploy >/dev/null && id -nG deploy"],
  [
    "deploy-keys",
    `h=$(getent passwd deploy | cut -d: -f6) && [ -n "$h" ] && cat "$h/.ssh/authorized_keys"`,
  ],
  ["dirs", DIRS_SNIPPET],
  ["runtime-files", RUNTIME_FILES_SNIPPET],
  ["sysctl", SYSCTL_SNIPPET],
  [
    "apt-periodic",
    "apt-config dump | grep -E '^APT::Periodic::(Update-Package-Lists|Unattended-Upgrade) '",
  ],
  ["apps", APPS_SNIPPET],
  ["record", `cat ${RECORD_PATH}`],
  [
    "pending-undo",
    `for u in sshd ufw ssh-firewall; do printf '%s %s\\n' "$u" "$(systemctl is-active "opscrew-undo-$u.timer" 2>/dev/null)"; done`,
  ],
  ["addons", ADDONS_SNIPPET],
  ["runners", RUNNERS_SNIPPET],
  ["web-filter", WEB_FILTER_SNIPPET],
  ["docker-firewall", "docker_up && docker info --format '{{json .FirewallBackend}}'"],
  ["ssh-connection", `${SSH_FIREWALL_FUNCTIONS}\nssh_connection`],
  ["ssh-firewall", SSH_FIREWALL_SNIPPET],
];

/** A read-only script of `sections`, each printed under its mark (a failing one never stops the rest). */
function sectionsScript(name: string, sections: readonly (readonly [string, string])[]): string {
  const body = sections
    .map(
      ([section, command]) =>
        `printf '\\n${SECTION_MARK}%s\\n' '${section}'\n{\n${command}\n} 2>/dev/null\nprintf '\\n${EXIT_MARK}%s\\n' "$?"`,
    )
    .join("\n");
  const helpers = "docker_up() { systemctl is-active --quiet docker 2>/dev/null; }";
  return buildScript(name, {}, `${helpers}\n${body}`, { tolerant: true });
}

/** The single read-only inspection script (tolerant: a failing probe never stops the others). */
export function inspectScript(): string {
  return sectionsScript("inspect", INSPECT_SECTIONS);
}

/**
 * The sections {@link inspectRunners} reads: the server's architecture, the runners, and whether
 * the server's first boot made `/srv/runners` deploy's and lets deploy linger.
 */
const RUNNER_SECTIONS = [
  ...INSPECT_SECTIONS.filter(([name]) => name === "dpkg-arch" || name === "runners"),
  [
    "runners-prepared",
    `[ -d "${RUNNERS_DIR}" ] && [ ! -L "${RUNNERS_DIR}" ] && [ -w "${RUNNERS_DIR}" ] && [ -e /var/lib/systemd/linger/deploy ]`,
  ],
] as const;

/** The read-only script of {@link inspectRunners}. */
export function inspectRunnersScript(): string {
  return sectionsScript("runners.inspect", RUNNER_SECTIONS);
}

/**
 * The read-only script `inspectHost` runs as root (as the apply does: root, sudo or Docker) for
 * the private networks' state and ufw's added rules.
 */
export function networkInspectScript(): string {
  return sectionsScript("network.inspect", [
    ["network", NETWORK_SNIPPET],
    ...INSPECT_SECTIONS.filter(([name]) => name === "ufw-added"),
  ]);
}

/** Read-only: the apps' records, as the inspection prints them (see {@link parseAppRecords}). */
export function readAppsScript(): string {
  return buildScript("apps.read", {}, APPS_SNIPPET, { tolerant: true });
}

/**
 * Read-only probe: how the admin login becomes root. Prints root, sudo, docker (neither root nor
 * passwordless sudo, but `docker info` works: the login is in the docker group), sudo-password or
 * none. A stopped Docker is never started by the probe.
 */
export function privilegeProbeScript(): string {
  return buildScript(
    "privilege",
    {},
    `if [ "$(id -u)" = 0 ]; then echo root; exit 0; fi
if command -v sudo >/dev/null 2>&1; then
  # stdout alone decides: sudo may warn on stderr ("unable to resolve host") and still work.
  out=$(sudo -n sh -c 'id -u' 2>/dev/null < /dev/null) || out=''
  if [ "$(printf '%s\\n' "$out" | tail -n 1)" = 0 ]; then echo sudo; exit 0; fi
fi
if systemctl is-active --quiet docker 2>/dev/null && docker info >/dev/null 2>&1; then echo docker; exit 0; fi
if command -v sudo >/dev/null 2>&1; then
  # stderr only tells a password prompt from a refusal. sudo says "a password is required";
  # sudo-rs (Ubuntu 25.10+) says "interactive authentication is required".
  err=$(sudo -n true 2>&1 >/dev/null < /dev/null) || true
  case "$err" in
    *password*|*authentication*) echo sudo-password; exit 0 ;;
  esac
fi
echo none`,
    { tolerant: true },
  );
}

async function run(remote: RemoteExec, call: RemoteCall, timeoutMs: number) {
  try {
    return await remote.run(call.command, callOptions(call, timeoutMs));
  } catch (error) {
    throw new OpsCrewError("COMMAND_FAILED", "OpsCrew could not run its checks on the server.", {
      hint: "Check that the server is reachable over SSH with your key, then try again.",
      cause: error,
    });
  }
}

/** Runs the privilege probe; `root`, `sudo`, `docker`, `sudo-password` or `none`. */
export async function probePrivilege(remote: RemoteExec): Promise<HostFacts["privilege"]> {
  const result = await run(remote, { command: asLogin(privilegeProbeScript()) }, 60_000);
  const answer = linesOf(result.stdout).pop();
  return answer === "root" || answer === "sudo" || answer === "docker" || answer === "sudo-password"
    ? answer
    : "none";
}

function section(sections: Map<string, Section>, name: string): Section {
  return sections.get(name) ?? { text: "", exit: 127 };
}

function ok(sections: Map<string, Section>, name: string): string {
  const found = section(sections, name);
  return found.exit === 0 ? found.text : "";
}

/** Whether `/etc/docker/daemon.json` is absent, OpsCrew's settings (as JSON), or the user's. */
function daemonJson(found: Section): "absent" | "opscrew" | "other" {
  if (found.exit !== 0) return "absent";
  const ours = canonicalJson(JSON.parse(DOCKER_DAEMON_JSON));
  const theirs = parseJson(found.text, (value) => canonicalJson(value));
  return theirs === ours ? "opscrew" : "other";
}

function parseJson<T>(text: string, parse: (value: unknown) => T | undefined): T | undefined {
  try {
    return parse(JSON.parse(text));
  } catch {
    return undefined;
  }
}

/**
 * How Docker filters its published ports, from `/etc/docker/daemon.json`, its unit's command line
 * and environment (`systemctl show -p ExecStart -p Environment docker`) and `docker info`
 * (`FirewallBackend`, Docker 28.2+): iptables (the default), its nftables backend, or not at all
 * (`iptables: false`).
 */
export function dockerFirewall(input: { daemonJson: Section; execStart: string; info: string }): {
  backend: "iptables" | "nftables" | "off";
} {
  const settings =
    input.daemonJson.exit === 0
      ? (parseJson(input.daemonJson.text, (value) => (isRecord(value) ? value : undefined)) ?? {})
      : {};
  const flags = input.execStart;
  const driver = /"Driver"\s*:\s*"([a-z+]+)"/.exec(input.info)?.[1] ?? "";
  const nftables =
    settings["firewall-backend"] === "nftables" ||
    /--firewall-backend[= ]nftables\b/.test(flags) ||
    /\bDOCKER_FIREWALL_BACKEND=nftables\b/.test(flags) ||
    driver.startsWith("nftables");
  const off = settings.iptables === false || /--iptables[= ]false\b/.test(flags);
  return { backend: nftables ? "nftables" : off ? "off" : "iptables" };
}

/** `$SSH_CONNECTION` (`<address> <port> <server address> <server port>`), null when unreadable. */
function parseSshConnection(text: string): HostFacts["sshClient"] {
  const [address, , , port] = text.trim().split(/\s+/);
  const number = Number(port);
  return address && Number.isInteger(number) && number > 0 && number < 65536
    ? { address, port: number }
    : null;
}

/** OpsCrew's SSH firewall, from its section (see `SSH_FIREWALL_SNIPPET`). */
function parseSshFirewall(text: string): HostFacts["sshFirewall"] {
  const values = new Map<string, string>();
  for (const line of linesOf(text)) {
    const [kind = "", ...rest] = line.split(" ");
    const value = rest.join(" ");
    if (kind === "file") values.set(rest[0] ?? "", rest[1] ?? "");
    else values.set(kind, value);
  }
  const hash = (name: string) => {
    const value = values.get(name);
    return value !== undefined && /^[0-9a-f]{64}$/.test(value) ? value : null;
  };
  return {
    nft: values.get("nft") === "yes",
    table: values.get("table") || null,
    files: { rules: hash("rules"), unit: hash("unit") },
    enabled: values.get("enabled") === "enabled",
  };
}

/** OpsCrew's web filter files and unit state, from its section. */
function webFilterFiles(text: string): Pick<WebFilterFacts, "files" | "enabled" | "active"> {
  const values = new Map<string, string>();
  for (const line of linesOf(text)) {
    const [kind, name, value] = line.split(/\s+/);
    if (kind === "file" && name && value) values.set(name, value);
    else if ((kind === "enabled" || kind === "active") && name) values.set(kind, name);
  }
  const hash = (name: string) => {
    const value = values.get(name);
    return value !== undefined && /^[0-9a-f]{64}$/.test(value) ? value : null;
  };
  return {
    files: { script: hash("script"), unit: hash("unit"), dropIn: hash("dropin") },
    enabled: values.get("enabled") === "enabled",
    active: values.get("active") === "active",
  };
}

/** Builds `HostFacts` from the inspection output. Exported for tests. */
export function factsFromOutput(output: string, privilege: HostFacts["privilege"]): HostFacts {
  const sections = splitSections(output);
  const os = parseOsRelease(ok(sections, "os-release"));
  const units = parsePairs(section(sections, "units").text);
  const packages = parseDpkg(section(sections, "packages").text);

  const sshdSettings = parseSshdT(ok(sections, "sshd"));
  const dropIn = section(sections, "sshd-dropin");
  const sshd = sshdSettings && {
    ...sshdSettings,
    dropInIncluded: section(sections, "sshd-include").exit === 0,
    dropIn: dropIn.exit === 0 ? dropIn.text : null,
    version: parseOpensshVersion(section(sections, "openssh").text),
  };

  const ufwStatus = section(sections, "ufw-status");
  const ufw: HostFacts["firewall"]["ufw"] = !packages.has("ufw")
    ? "absent"
    : /^Status:\s*active\b/m.test(ufwStatus.text)
      ? "active"
      : "inactive";

  const text = (name: string) => section(sections, name).text;
  const containers = parseContainers(ok(sections, "containers"));
  const volumeProjects = [...new Set(linesOf(ok(sections, "volumes")))];
  const addons = parseAddons(text("addons"));
  const deployKeys = linesOf(ok(sections, "deploy-keys")).filter((line) => !line.startsWith("#"));
  const checkLine = new RegExp(CHECK_KEY_LINE_RE);
  const addon = (name: string, project: string) => {
    const found = addons.get(name);
    return {
      installed: found?.installed ?? false,
      composeSha256: found?.composeSha256 ?? null,
      running: containers.some((container) => container.project === project && container.running),
      secretFile: found?.secretFile ?? false,
      dataVolume: volumeProjects.includes(project),
      tunnelId: found?.tunnelId ?? null,
    };
  };
  const nss = parseNsswitchPasswd(ok(sections, "logins-nss"));
  const pam = linesOf(ok(sections, "logins-pam"));
  const directoryLogins = [
    ...nss.map((source) => `${source} in /etc/nsswitch.conf`),
    ...pam.map((module) => `${module} in PAM`),
    ...(sshdSettings?.authorizedKeysCommand ? ["sshd's AuthorizedKeysCommand"] : []),
  ];

  const dockerCli = ok(sections, "docker-cli");
  const repoVersion = packages.get("docker-ce");
  let kind: HostFacts["docker"]["kind"] = "absent";
  if (section(sections, "snap-docker").exit === 0) kind = "snap";
  else if (packages.has("podman-docker") || /podman/i.test(dockerCli)) kind = "podman";
  else if (repoVersion !== undefined) kind = "docker-repo";
  else if (packages.has("docker.io")) kind = "distro";
  else if (section(sections, "docker-cli").exit === 0) kind = "other";
  // The package version (`5:28.5.1-1~ubuntu.24.04~noble`), else what the daemon reports.
  const version = engineVersion(
    kind === "docker-repo" ? (repoVersion ?? "") : ok(sections, "docker-server"),
  );

  const record = section(sections, "record");
  const recordValue =
    record.exit === 0
      ? parseJson(record.text, (value) => HostRecordSchema.safeParse(value).data)
      : undefined;
  const pending = parsePairs(text("pending-undo"));
  const deploy = section(sections, "deploy");
  const listeners = parseSs(text("listeners"));

  const facts = {
    user: ok(sections, "whoami").trim(),
    privilege,
    os,
    arch: ok(sections, "dpkg-arch").trim(),
    machine: ok(sections, "uname").trim(),
    cpus: Number.parseInt(ok(sections, "nproc").trim(), 10) || 0,
    avx: parseAvx(ok(sections, "cpu-flags")),
    memoryBytes: parseFree(ok(sections, "free")),
    diskFreeBytes: parseDf(ok(sections, "df")),
    systemd: section(sections, "systemd").exit === 0,
    flock: section(sections, "flock").exit === 0,
    addresses: parseAddresses(ok(sections, "addresses")),
    sshd,
    listeners,
    wireguardInterfaces: parseWireguardLinks(ok(sections, "wireguard")),
    udpPortsInUse: udpPorts(listeners),
    ipv4Routes: parseIpv4Routes(ok(sections, "routes")),
    firewall: {
      ufw,
      ufwRules: parseUfwAdded(text("ufw-added")),
      ufwDefaults: parseUfwDefaults(ok(sections, "ufw-defaults")),
      foreign: foreignFirewalls({
        units,
        ufwActive: ufw === "active",
        iptables: ok(sections, "iptables"),
        ip6tables: ok(sections, "ip6tables"),
        nft: ok(sections, "nft"),
      }),
    },
    docker: {
      kind,
      version,
      running: units.get("docker") === "active",
      composePlugin:
        packages.has("docker-compose-plugin") || section(sections, "docker-compose").exit === 0,
      buildxPlugin:
        packages.has("docker-buildx-plugin") || section(sections, "docker-buildx").exit === 0,
      conflicting: CONFLICTING_PACKAGES.filter((name) => packages.has(name)),
      // grep -l exits 2 when one of the files is missing, even with matches.
      sources: linesOf(text("docker-sources")),
      daemonFlags: dockerdFlags(ok(sections, "docker-exec")),
      swarm: ok(sections, "docker-swarm").trim() === "active",
    },
    containers,
    volumeProjects,
    directoryLogins,
    dpkgInterrupted: linesOf(ok(sections, "dpkg-interrupted")).length > 0,
    loginUsers: parseUsers(text("users")),
    deployUser:
      deploy.exit === 0
        ? {
            groups: linesOf(deploy.text).flatMap((line) => line.split(/\s+/)),
            keys: deployKeys.filter((line) => !checkLine.test(line)),
            checkKeys: deployKeys
              .filter((line) => checkLine.test(line))
              .map((line) =>
                line.slice(line.lastIndexOf(CHECK_KEY_COMMENT) + CHECK_KEY_COMMENT.length),
              ),
          }
        : null,
    packages: {
      ufw: packages.has("ufw"),
      unattendedUpgrades: packages.has("unattended-upgrades"),
      curl: packages.has("curl"),
      fail2ban: packages.has("fail2ban"),
    },
    autoUpgrades: parseAptPeriodic(text("apt-periodic")),
    autoUpgradesService: text("upgrades-enabled").trim() === "enabled",
    dockerDaemonJson: daemonJson(section(sections, "docker-daemon")),
    fail2ban: {
      active: units.get("fail2ban") === "active",
      jail: section(sections, "fail2ban-jail").exit === 0 ? text("fail2ban-jail") : null,
      sshdJail: section(sections, "fail2ban-sshd").exit === 0,
    },
    ready: section(sections, "ready").exit === 0,
    dirs: parseDirs(text("dirs")),
    runtimeFiles: parseRuntimeFiles(text("runtime-files")),
    sysctl: parseSysctl(text("sysctl")),
    apps: parseAppRecords(text("apps")),
    record: recordValue ?? null,
    recordDamaged: record.exit === 0 && recordValue === undefined,
    pendingUndo: {
      sshd: pending.get("sshd") === "active",
      ufw: pending.get("ufw") === "active",
      sshFirewall: pending.get("ssh-firewall") === "active",
    },
    tunnels: [...addons.keys()]
      .filter((name) => name.startsWith("tunnel:"))
      .map((name) => name.slice("tunnel:".length))
      .filter((app) => AppNameSchema.safeParse(app).success)
      .sort()
      .map((app) => ({ app, ...addon(`tunnel:${app}`, tunnelProject(app)) })),
    portainer: addon("portainer", PORTAINER_PROJECT),
    addons: {
      beszel: addon("beszel", ADDON_PROJECTS.beszel),
      alloy: addon("alloy", ADDON_PROJECTS.alloy),
    },
    runners: parseRunners(text("runners")),
    webFilter: {
      ...dockerFirewall({
        daemonJson: section(sections, "docker-daemon"),
        execStart: ok(sections, "docker-exec"),
        info: ok(sections, "docker-firewall"),
      }),
      ...webFilterFiles(text("web-filter")),
      rules4: {
        chain: parseWebFilterChain(ok(sections, "iptables")),
        dockerUser: parseDockerUserChain(ok(sections, "iptables")),
      },
    },
    sshClient: parseSshConnection(ok(sections, "ssh-connection")),
    sshFirewall: parseSshFirewall(text("ssh-firewall")),
  };
  const parsed = HostFactsSchema.safeParse(facts);
  if (!parsed.success) {
    throw new OpsCrewError("INTERNAL", "OpsCrew could not make sense of the server's answers.", {
      hint: "Run the command again; if it keeps failing, report it with the server's OS version.",
      cause: parsed.error,
    });
  }
  return parsed.data;
}

/**
 * Inspects the server with fixed, read-only commands (as root, through `sudo -n` when the login
 * is not root). Never changes the server. When the login cannot become root that way (`docker`
 * included: inspection never runs through Docker) the facts are partial and `privilege` says
 * why; `planHost` then refuses with a plain finding. The private networks' state (`network`) is
 * read as root the way the apply becomes root: as root, through `sudo -n`, or through Docker
 * when `options.rootImage` (the `docker` privilege's image, as `ApplyOptions.rootImage`) is
 * given, which then reads ufw's rules (`firewall.ufwRules`) too.
 */
export async function inspectHost(
  remote: RemoteExec,
  options: { rootImage?: string } = {},
): Promise<HostFacts> {
  const privilege = await probePrivilege(remote);
  const script = inspectScript();
  const command =
    privilege === "root" || privilege === "sudo" ? asRoot(privilege, script) : asLogin(script);
  const result = await run(remote, { command }, 180_000);
  if (!result.stdout.includes(SECTION_MARK)) {
    throw new OpsCrewError("COMMAND_FAILED", "OpsCrew could not read the server's state.", {
      hint: "Check that the login has a POSIX shell (sh, bash or zsh) and try again.",
    });
  }
  const facts = factsFromOutput(result.stdout, privilege);
  if (
    privilege === "sudo-password" ||
    privilege === "none" ||
    (privilege === "docker" && options.rootImage === undefined)
  ) {
    return facts;
  }
  // The private networks, read as root the way the apply becomes root.
  const call = rootCall(privilege, networkInspectScript(), undefined, options.rootImage);
  const read = await run(remote, call, 180_000);
  if (!read.stdout.includes(SECTION_MARK)) {
    throw new OpsCrewError(
      "COMMAND_FAILED",
      "OpsCrew could not read the private network's state on the server.",
      {
        hint: "Check that the server is reachable, and that Docker runs on it when OpsCrew becomes root through Docker, then try again.",
      },
    );
  }
  const sections = splitSections(read.stdout);
  const network = parseNetworkState(section(sections, "network").text);
  // Through Docker, ufw's rules are read only here: the other facts are read as the login.
  if (privilege !== "docker") return { ...facts, network };
  const ufwRules = parseUfwAdded(section(sections, "ufw-added").text);
  return { ...facts, network, firewall: { ...facts.firewall, ufwRules } };
}

/**
 * Reads the apps' GitHub Actions runners, the server's architecture, and whether its first boot
 * prepared what a runner needs from root, as the login itself with no root: the deploy user on a
 * server OpsCrew created (Hetzner, DigitalOcean), for `planRunner`. Read-only.
 */
export async function inspectRunners(remote: RemoteExec): Promise<RunnerFacts> {
  const result = await run(remote, { command: asLogin(inspectRunnersScript()) }, 120_000);
  if (!result.stdout.includes(SECTION_MARK)) {
    throw new OpsCrewError("COMMAND_FAILED", "OpsCrew could not read the runner on the server.", {
      hint: "Check that the server is reachable over SSH as deploy, then try again.",
    });
  }
  const sections = splitSections(result.stdout);
  const parsed = RunnerFactsSchema.safeParse({
    arch: ok(sections, "dpkg-arch").trim(),
    runners: parseRunners(section(sections, "runners").text),
    prepared: section(sections, "runners-prepared").exit === 0,
  });
  if (!parsed.success) {
    throw new OpsCrewError("INTERNAL", "OpsCrew could not make sense of the server's answers.", {
      hint: "Run the command again; if it keeps failing, report it with the server's OS version.",
      cause: parsed.error,
    });
  }
  return parsed.data;
}
