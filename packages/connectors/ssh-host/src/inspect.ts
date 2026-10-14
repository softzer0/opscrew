// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are shell and Go templates, not JavaScript templates.
import type { RemoteExec } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import {
  DOCKER_DAEMON_JSON,
  DOCKER_DAEMON_JSON_PATH,
  FAIL2BAN_JAIL_PATH,
  PORTAINER_DIR,
  PORTAINER_PROJECT,
  READY_FLAG,
  TUNNEL_DIR,
  TUNNEL_PROJECT,
} from "./constants";
import {
  AppMarkerSchema,
  type HostFacts,
  HostFactsSchema,
  HostRecordSchema,
  MARKER_PATH,
  RECORD_PATH,
  RUNTIME_DIRS,
  SSHD_DROP_IN,
} from "./facts";
import { foreignFirewalls } from "./firewall";
import { canonicalJson } from "./hash";
import {
  dockerdFlags,
  EXIT_MARK,
  engineVersion,
  linesOf,
  parseAddons,
  parseAddresses,
  parseAptPeriodic,
  parseContainers,
  parseDf,
  parseDirs,
  parseDpkg,
  parseFree,
  parseNsswitchPasswd,
  parseOsRelease,
  parsePairs,
  parseSs,
  parseSshdT,
  parseUfwAdded,
  parseUfwDefaults,
  parseUsers,
  SECTION_MARK,
  type Section,
  splitSections,
} from "./parse";
import { asLogin, asRoot, buildScript } from "./shell";

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

const DIRS_SNIPPET = `for d in ${RUNTIME_DIRS.join(" ")}; do
  if [ -L "$d" ]; then echo "$d link"
  elif [ -d "$d" ]; then echo "$d dir $(stat -c '%U %G %a' "$d") $(ls -A "$d" | wc -l)"
  elif [ -e "$d" ]; then echo "$d other"
  else echo "$d absent"; fi
done`;

const ADDONS_SNIPPET = `addon() {
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
addon tunnel ${TUNNEL_DIR} tunnel.env
addon portainer ${PORTAINER_DIR} admin_password`;

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
    `for u in nginx apache2 caddy traefik haproxy lighttpd firewalld nftables docker fail2ban; do printf '%s %s\\n' "$u" "$(systemctl is-active "$u" 2>/dev/null)"; done`,
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
  ["docker-exec", "systemctl show -p ExecStart docker"],
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
  [
    "apt-periodic",
    "apt-config dump | grep -E '^APT::Periodic::(Update-Package-Lists|Unattended-Upgrade) '",
  ],
  ["marker", `cat ${MARKER_PATH}`],
  ["record", `cat ${RECORD_PATH}`],
  [
    "pending-undo",
    `for u in sshd ufw; do printf '%s %s\\n' "$u" "$(systemctl is-active "opscrew-undo-$u.timer" 2>/dev/null)"; done`,
  ],
  ["addons", ADDONS_SNIPPET],
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

/** Builds `HostFacts` from the inspection output. Exported for tests. */
export function factsFromOutput(
  output: string,
  privilege: "root" | "sudo" | "sudo-password" | "none",
): HostFacts {
  const sections = splitSections(output);
  const os = parseOsRelease(ok(sections, "os-release"));
  const memory = parseFree(ok(sections, "free"));
  const disk = parseDf(ok(sections, "df"));
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
  const serverVersion = ok(sections, "docker-server").trim();
  const version =
    kind === "docker-repo"
      ? engineVersion(repoVersion ?? "")
      : /^\d+\.\d+\.\d+/.test(serverVersion)
        ? (/^\d+\.\d+\.\d+/.exec(serverVersion)?.[0] ?? null)
        : null;

  const marker = section(sections, "marker");
  const markerValue =
    marker.exit === 0
      ? parseJson(marker.text, (value) => AppMarkerSchema.safeParse(value).data)
      : undefined;
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
    memoryBytes: memory.total,
    memoryAvailableBytes: memory.available,
    diskFreeBytes: disk.available,
    diskTotalBytes: disk.size,
    systemd: section(sections, "systemd").exit === 0,
    flock: section(sections, "flock").exit === 0,
    addresses: parseAddresses(ok(sections, "addresses")),
    sshd,
    listeners: parseSs(text("listeners")),
    webServers: ["nginx", "apache2", "caddy", "traefik", "haproxy", "lighttpd"].filter(
      (unit) => units.get(unit) === "active",
    ),
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
    dirs: parseDirs(text("dirs"), RUNTIME_DIRS),
    marker: markerValue ?? null,
    markerDamaged: marker.exit === 0 && markerValue === undefined,
    record: recordValue ?? null,
    recordDamaged: record.exit === 0 && recordValue === undefined,
    pendingUndo: {
      sshd: pending.get("sshd") === "active",
      ufw: pending.get("ufw") === "active",
    },
    tunnel: addon("tunnel", TUNNEL_PROJECT),
    portainer: addon("portainer", PORTAINER_PROJECT),
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
