// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are shell and Go templates, not JavaScript templates.
import type { RemoteExec } from "@opscrew/contracts";
import { canonicalJson, isRecord, OpsCrewError } from "@opscrew/core";
import {
  APP_RECORDS_DIR,
  APPS_DIR,
  DATA_DIR,
  DOCKER_DAEMON_JSON,
  DOCKER_DAEMON_JSON_PATH,
  EDGE_DIR,
  FAIL2BAN_JAIL_PATH,
  HASHED_RUNTIME_FILES,
  PORTAINER_DIR,
  PORTAINER_PROJECT,
  READY_FLAG,
  RECORD_PATH,
  RUNTIME_FILE_NAMES,
  SHARED_DIRS,
  SSHD_DROP_IN,
  TUNNELS_DIR,
  tunnelProject,
} from "./constants";
import { type HostFacts, HostFactsSchema, HostRecordSchema, type WebFilterFacts } from "./facts";
import { foreignFirewalls } from "./firewall";
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
  parseNsswitchPasswd,
  parseOsRelease,
  parsePairs,
  parseRuntimeFiles,
  parseSs,
  parseSshdT,
  parseUfwAdded,
  parseUfwDefaults,
  parseUsers,
  parseWebFilterChain,
  SECTION_MARK,
  type Section,
  splitSections,
} from "./parse";
import { asLogin, asRoot, buildScript } from "./shell";
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

/** The shared folders, then each app's folder in /srv/apps and /srv/data (never through a link). */
const DIRS_SNIPPET = `${APP_NAME_FN}
dir_line() {
  if [ -L "$1" ]; then echo "$1 link"
  elif [ -d "$1" ]; then echo "$1 dir $(stat -c '%U %G %a' "$1") $(ls -A "$1" | wc -l)"
  elif [ -e "$1" ]; then echo "$1 other"
  else echo "$1 absent"; fi
}
for d in ${SHARED_DIRS.join(" ")}; do dir_line "$d"; done
for parent in ${APPS_DIR} ${DATA_DIR}; do
  if [ -L "$parent" ] || [ ! -d "$parent" ]; then continue; fi
  for d in "$parent"/*; do
    app_name "\${d##*/}" || continue
    if [ -e "$d" ] || [ -L "$d" ]; then dir_line "$d"; fi
  done
done`;

/**
 * OpsCrew's runtime files of each app with a folder (`/srv/apps/<app>`), the app's site on the
 * shared edge (`/srv/edge/sites/<app>.caddy`) included: kind, owner, group and mode of each, and
 * the SHA-256 of the rendered ones only. Never prints a file's content, never hashes a file that
 * holds secrets, and never follows a symbolic link (an app folder that is a link, or /srv/apps
 * itself, is skipped; a site under a linked edge folder is reported as a link).
 */
export const RUNTIME_FILES_SNIPPET = `${APP_NAME_FN}
if [ -d "${APPS_DIR}" ] && [ ! -L "${APPS_DIR}" ]; then
  for d in "${APPS_DIR}"/*; do
    app=\${d##*/}
    app_name "$app" || continue
    if [ -L "$d" ] || [ ! -d "$d" ]; then continue; fi
    for f in ${RUNTIME_FILE_NAMES.join(" ")}; do
      p="$d/$f"
      if [ "$f" = site ]; then
        p="${EDGE_DIR}/sites/$app.caddy"
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
  done
fi`;

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
addon portainer ${PORTAINER_DIR} admin_password`;

/** OpsCrew's web filter: its files' SHA-256 and its unit's state. */
const WEB_FILTER_SNIPPET = `for f in script:${WEB_FILTER_SCRIPT} unit:${WEB_FILTER_UNIT} dropin:${WEB_FILTER_DROP_IN}; do
  if [ -f "\${f#*:}" ]; then echo "file \${f%%:*} $(sha256sum "\${f#*:}" | cut -d ' ' -f 1)"; else echo "file \${f%%:*} -"; fi
done
echo "enabled $(systemctl is-enabled ${WEB_FILTER_SERVICE} 2>/dev/null)"
echo "active $(systemctl is-active ${WEB_FILTER_SERVICE} 2>/dev/null)"`;

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
  [
    "apt-periodic",
    "apt-config dump | grep -E '^APT::Periodic::(Update-Package-Lists|Unattended-Upgrade) '",
  ],
  ["apps", APPS_SNIPPET],
  ["record", `cat ${RECORD_PATH}`],
  [
    "pending-undo",
    `for u in sshd ufw; do printf '%s %s\\n' "$u" "$(systemctl is-active "opscrew-undo-$u.timer" 2>/dev/null)"; done`,
  ],
  ["addons", ADDONS_SNIPPET],
  ["web-filter", WEB_FILTER_SNIPPET],
  ["docker-firewall", "docker_up && docker info --format '{{json .FirewallBackend}}'"],
];

/** The single read-only inspection script (tolerant: a failing probe never stops the others). */
export function inspectScript(): string {
  const body = INSPECT_SECTIONS.map(
    ([name, command]) =>
      `printf '\\n${SECTION_MARK}%s\\n' '${name}'\n{\n${command}\n} 2>/dev/null\nprintf '\\n${EXIT_MARK}%s\\n' "$?"`,
  ).join("\n");
  const helpers = "docker_up() { systemctl is-active --quiet docker 2>/dev/null; }";
  return buildScript("inspect", {}, `${helpers}\n${body}`, { tolerant: true });
}

/** Read-only: the apps' records, as the inspection prints them (see {@link parseAppRecords}). */
export function readAppsScript(): string {
  return buildScript("apps.read", {}, APPS_SNIPPET, { tolerant: true });
}

/** Read-only probe: how the admin login becomes root. Prints root, sudo, sudo-password or none. */
export function privilegeProbeScript(): string {
  return buildScript(
    "privilege",
    {},
    `if [ "$(id -u)" = 0 ]; then echo root
elif command -v sudo >/dev/null 2>&1; then
  # stdout alone decides: sudo may warn on stderr ("unable to resolve host") and still work.
  out=$(sudo -n sh -c 'id -u' 2>/dev/null < /dev/null) || out=''
  if [ "$(printf '%s\\n' "$out" | tail -n 1)" = 0 ]; then echo sudo
  else
    # stderr only tells a password prompt from a refusal. sudo says "a password is required";
    # sudo-rs (Ubuntu 25.10+) says "interactive authentication is required".
    err=$(sudo -n true 2>&1 >/dev/null < /dev/null) || true
    case "$err" in
      *password*|*authentication*) echo sudo-password ;;
      *) echo none ;;
    esac
  fi
else echo none; fi`,
    { tolerant: true },
  );
}

async function run(remote: RemoteExec, command: string, timeoutMs: number) {
  try {
    return await remote.run(command, { timeoutMs });
  } catch (error) {
    throw new OpsCrewError("COMMAND_FAILED", "OpsCrew could not run its checks on the server.", {
      hint: "Check that the server is reachable over SSH with your key, then try again.",
      cause: error,
    });
  }
}

/** Runs the privilege probe; `root`, `sudo`, `sudo-password` or `none`. */
export async function probePrivilege(
  remote: RemoteExec,
): Promise<"root" | "sudo" | "sudo-password" | "none"> {
  const result = await run(remote, asLogin(privilegeProbeScript()), 60_000);
  const answer = linesOf(result.stdout).pop();
  if (answer === "root" || answer === "sudo" || answer === "sudo-password") return answer;
  return "none";
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
export function factsFromOutput(
  output: string,
  privilege: "root" | "sudo" | "sudo-password" | "none",
): HostFacts {
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
  const addon = (name: string, project: string) => {
    const found = addons.get(name);
    return {
      installed: found !== undefined,
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
    listeners: parseSs(text("listeners")),
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
            keys: linesOf(ok(sections, "deploy-keys")).filter((line) => !line.startsWith("#")),
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
    apps: parseAppRecords(text("apps")),
    record: recordValue ?? null,
    recordDamaged: record.exit === 0 && recordValue === undefined,
    pendingUndo: {
      sshd: pending.get("sshd") === "active",
      ufw: pending.get("ufw") === "active",
    },
    tunnels: [...addons.keys()]
      .filter((name) => name.startsWith("tunnel:"))
      .map((name) => name.slice("tunnel:".length))
      .filter((app) => AppNameSchema.safeParse(app).success)
      .sort()
      .map((app) => ({ app, ...addon(`tunnel:${app}`, tunnelProject(app)) })),
    portainer: addon("portainer", PORTAINER_PROJECT),
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
 * is not root). Never changes the server. When the login cannot become root the facts are
 * partial and `privilege` says why; `planHost` then refuses with a plain finding.
 */
export async function inspectHost(remote: RemoteExec): Promise<HostFacts> {
  const privilege = await probePrivilege(remote);
  const script = inspectScript();
  const command =
    privilege === "root" || privilege === "sudo" ? asRoot(privilege, script) : asLogin(script);
  const result = await run(remote, command, 180_000);
  if (!result.stdout.includes(SECTION_MARK)) {
    throw new OpsCrewError("COMMAND_FAILED", "OpsCrew could not read the server's state.", {
      hint: "Check that the login has a POSIX shell (sh, bash or zsh) and try again.",
    });
  }
  return factsFromOutput(result.stdout, privilege);
}
