/**
 * A fake server for the host adapter's tests: a `RemoteExec` that keeps a model of the server
 * (packages, files, users, sshd, ufw, containers, timers) and answers OpsCrew's fixed scripts by
 * their `# opscrew-host: <name>` header and quoted parameters. Every call is recorded so tests can
 * check which commands ran, what reached stdin, and that each script passes `sh -n`.
 */
import type { CommandResult, RemoteExec } from "@opscrew/contracts";
import { sha256Hex as sha256 } from "@opscrew/core";
import {
  AUTO_UPGRADES_FILE,
  BACKUP_DIR,
  DOCKER_DAEMON_JSON,
  DOCKER_DAEMON_JSON_PATH,
  FAIL2BAN_JAIL_PATH,
  HASHED_RUNTIME_FILES,
  MARKER_PATH,
  PORTAINER_DIR,
  PORTAINER_PROJECT,
  READY_FLAG,
  RECORD_PATH,
  RUNTIME_FILE_NAMES,
  SSHD_BACKUP,
  SSHD_DROP_IN,
  SSHD_HEADER,
  TUNNEL_DIR,
  TUNNEL_PROJECT,
} from "../constants";
import { EXIT_MARK, SECTION_MARK } from "../parse";
import { WEB_FILTER_DROP_IN, WEB_FILTER_SCRIPT, WEB_FILTER_UNIT } from "../web-filter";

/** One address family's filter state: OpsCrew's chain (null when absent) and DOCKER-USER. */
export interface FakeWebRules {
  chain: string[] | null;
  /** DOCKER-USER exists. */
  dockerUser: boolean;
  /** Rules of DOCKER-USER, in order, as iptables-save prints them. */
  dockerUserRules: string[];
}

/** OpsCrew's jump for one published port, as iptables-save prints it. */
export function fakeJump(proto: string, port: string | number): string {
  return `-A DOCKER-USER -p ${proto} -m conntrack --ctstate DNAT --ctorigdstport ${port} --ctdir ORIGINAL -j OPSCREW-WEB`;
}

const JUMPS = [fakeJump("tcp", 80), fakeJump("tcp", 443), fakeJump("udp", 443)];

export const OS_PRESETS = {
  "ubuntu-22.04": {
    id: "ubuntu",
    versionId: "22.04",
    codename: "jammy",
    pretty: "Ubuntu 22.04.5 LTS",
    idLike: "debian",
  },
  "ubuntu-24.04": {
    id: "ubuntu",
    versionId: "24.04",
    codename: "noble",
    pretty: "Ubuntu 24.04.3 LTS",
    idLike: "debian",
  },
  "ubuntu-26.04": {
    id: "ubuntu",
    versionId: "26.04",
    codename: "resolute",
    pretty: "Ubuntu 26.04 LTS",
    idLike: "debian",
  },
  "debian-12": {
    id: "debian",
    versionId: "12",
    codename: "bookworm",
    pretty: "Debian GNU/Linux 12 (bookworm)",
    idLike: "",
  },
  "debian-13": {
    id: "debian",
    versionId: "13",
    codename: "trixie",
    pretty: "Debian GNU/Linux 13 (trixie)",
    idLike: "",
  },
  "ubuntu-20.04": {
    id: "ubuntu",
    versionId: "20.04",
    codename: "focal",
    pretty: "Ubuntu 20.04.6 LTS",
    idLike: "debian",
  },
  "linuxmint-22": {
    id: "linuxmint",
    versionId: "22",
    codename: "wilma",
    pretty: "Linux Mint 22",
    idLike: "ubuntu debian",
  },
} as const;

export type OsPreset = keyof typeof OS_PRESETS;

export interface FakeListener {
  proto: "tcp" | "udp";
  address: string;
  port: number;
  process: string;
}

export interface FakeContainer {
  name: string;
  project: string;
  ports: string;
  stopped?: boolean;
}

interface UfwRule {
  rule: string;
  comment: string | null;
}

export interface FakeCall {
  command: string;
  input?: string;
  /** Script name from the header, or "" for commands that are not OpsCrew scripts. */
  name: string;
  script: string;
  params: Record<string, string>;
  sudo: boolean;
}

export interface FakeHostOptions {
  os?: OsPreset;
  arch?: "amd64" | "arm64" | "armhf";
  login?: string;
  sudo?: "nopasswd" | "password" | "none";
}

const MACHINE = { amd64: "x86_64", arm64: "aarch64", armhf: "armv7l" } as const;

/** Reverses `shellQuote`: the text between the outer quotes, with `'\''` turned back into `'`. */
function unquote(quoted: string): string {
  if (!quoted.startsWith("'") || !quoted.endsWith("'")) throw new Error(`not quoted: ${quoted}`);
  return quoted.slice(1, -1).replaceAll("'\\''", "'");
}

export function scriptParams(script: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const line of script.split("\n")) {
    const match = /^([A-Z][A-Z0-9_]*)=('(?:[^']|'\\'')*')$/.exec(line);
    if (match?.[1] && match[2]) params[match[1]] = unquote(match[2]);
  }
  return params;
}

function result(stdout = "", exitCode = 0, stderr = ""): CommandResult {
  return { exitCode, stdout, stderr };
}

function fail(message: string, code = 3): CommandResult {
  return result("", code, `opscrew: ${message}\n`);
}

export class FakeHost implements RemoteExec {
  readonly host = "203.0.113.10";
  readonly calls: FakeCall[] = [];

  // identity and platform
  login: string;
  sudo: "nopasswd" | "password" | "none";
  os: { id: string; versionId: string; codename: string; pretty: string; idLike: string };
  arch: string;
  systemd = true;
  flock = true;
  /** `ip -o addr show scope global` lines (a home server behind NAT by default). */
  addresses = [
    "2: eth0    inet 192.168.1.20/24 brd 192.168.1.255 scope global dynamic eth0\\       valid_lft 86000sec preferred_lft 86000sec",
    "3: docker0    inet 172.17.0.1/16 brd 172.17.255.255 scope global docker0\\       valid_lft forever preferred_lft forever",
  ];
  memoryBytes = 4 * 1024 ** 3;
  diskFreeBytes = 60 * 1024 ** 3;

  // sshd: the main config, an optional drop-in read before OpsCrew's, and the include line
  sshdBase = {
    port: [22],
    passwordAuthentication: true,
    kbdInteractiveAuthentication: false,
    permitRootLogin: "yes",
    authenticationMethods: "any",
    allowUsers: [] as string[],
    allowGroups: [] as string[],
    allowTcpForwarding: "yes",
    authorizedKeysCommand: "none",
  };
  sshdIncludesDropIns = true;
  sshdEarlierDropIn: Record<string, string> | null = null;
  sshdTestFails = false;
  sshdReloads = 0;

  files = new Map<string, string>();
  packages = new Map<string, string>([
    ["curl", "8.5.0-2ubuntu10"],
    ["unattended-upgrades", "2.9.1"],
  ]);
  /** The distribution's own 20auto-upgrades (Ubuntu turns automatic updates on by default). */
  distroAutoUpgrades = false;
  snapDocker = false;
  /** A docker binary that no package installed (manual or static install). */
  strayDocker = false;
  dockerRunning = false;
  /** Major version Docker's repository offers. */
  dockerRepoMajor = 29;
  ufwActive = false;
  /** Docker's firewall backend (`docker info` FirewallBackend.Driver) and its IPv6 filtering. */
  dockerFirewall: "iptables" | "nftables" = "iptables";
  /** OpsCrew's web filter unit. */
  webFilterUnit = { enabled: false, active: false };
  web4: FakeWebRules = { chain: null, dockerUser: false, dockerUserRules: [] };
  webFilterLog: string[] = [];
  ufwRules: UfwRule[] = [];
  ufwLog: string[] = [];
  firewalld = false;
  nftablesService = false;
  iptables = "";
  ip6tables = "";
  nft = "";
  listeners: FakeListener[] = [
    { proto: "tcp", address: "0.0.0.0", port: 22, process: "sshd" },
    { proto: "tcp", address: "[::]", port: 22, process: "sshd" },
    { proto: "udp", address: "127.0.0.53%lo", port: 53, process: "systemd-resolve" },
    { proto: "udp", address: "0.0.0.0", port: 68, process: "systemd-network" },
  ];
  containers: FakeContainer[] = [];
  volumes = new Map<string, number>();
  /** Directory services on the nsswitch passwd line (sss, ldap, ...). */
  nssSources: string[] = [];
  /** Directory PAM modules in use (pam_sss, ...). */
  pamModules: string[] = [];
  dpkgInterrupted = false;
  /** dockerd flags in its systemd unit. */
  dockerdFlags: string[] = [];
  swarm = false;
  /** /etc/default/ufw policies. */
  ufwDefaults = { incoming: "deny", outgoing: "allow", routed: "deny" };
  users = new Map<string, { uid: number; password: boolean; keys: string[]; groups: string[] }>();
  dirs = new Map<string, { owner: string; group: string; mode: string; entries: number }>();
  /** Files in /srv/app by name (the deploy workflow's copies), with owner, group and mode. */
  appFiles = new Map<
    string,
    { content: string; owner: string; group: string; mode: string; kind?: "link" | "other" }
  >();
  portainerAdmin = false;
  /** `systemctl is-enabled unattended-upgrades`. */
  upgradesServiceEnabled = true;
  fail2banActive = false;
  /** The user's own fail2ban sshd jail (without OpsCrew's jail file). */
  fail2banOwnJail = false;
  dockerRestarts = 0;
  dockerReloads = 0;
  tunnelRecreates = 0;
  /** Pending dead-man switches: step -> restore. */
  timers = new Map<string, () => void>();
  armedSeconds: number[] = [];

  // failure injection
  /** Script names that exit non-zero (with an `opscrew:` message). */
  failScripts = new Map<string, string>();
  /** Calls (by script name) on which the connection drops; removed after it fires once. */
  dropOn = new Set<string>();
  /** The dead-man fires before OpsCrew can cancel it. */
  fireBeforeCancel = false;
  /** The apply of this script echoes its stdin to stderr and fails (a misbehaving server). */
  echoStdinOn: string | null = null;

  constructor(options: FakeHostOptions = {}) {
    this.os = { ...OS_PRESETS[options.os ?? "ubuntu-24.04"] };
    this.arch = options.arch ?? "amd64";
    this.login = options.login ?? "root";
    this.sudo = options.sudo ?? "nopasswd";
    // Ubuntu ships ufw (inactive); Debian does not.
    if (this.os.id === "ubuntu") this.packages.set("ufw", "0.36.2");
    this.users.set("root", { uid: 0, password: true, keys: ["ssh-ed25519 AAAAadmin admin@laptop"], groups: ["root"] });
    if (this.login !== "root") {
      this.users.set(this.login, {
        uid: 1000,
        password: true,
        keys: ["ssh-ed25519 AAAAadmin admin@laptop"],
        groups: [this.login, "sudo"],
      });
    }
  }

  /** Scripts that ran, by name, in order. */
  names(): string[] {
    return this.calls.map((call) => call.name);
  }

  /** Every script text this fake has seen. */
  scripts(): string[] {
    return [...new Set(this.calls.map((call) => call.script))];
  }

  async run(command: string, options: { timeoutMs?: number; input?: string } = {}): Promise<CommandResult> {
    let sudo = false;
    let rest = command;
    if (rest.startsWith("sudo -n ")) {
      sudo = true;
      rest = rest.slice("sudo -n ".length);
    }
    if (!rest.startsWith("sh -c ")) throw new Error(`unexpected command: ${command}`);
    const script = unquote(rest.slice("sh -c ".length));
    const name = /^# opscrew-host: (\S+)/.exec(script)?.[1] ?? "";
    const params = scriptParams(script);
    const call: FakeCall = { command, name, script, params, sudo };
    if (options.input !== undefined) call.input = options.input;
    this.calls.push(call);

    if (this.dropOn.has(name)) {
      this.dropOn.delete(name);
      throw new Error("ssh: connection reset by peer");
    }
    if (sudo && this.sudo !== "nopasswd") {
      return result("", 1, "sudo: a password is required\n");
    }
    const root = sudo || this.login === "root";
    const failure = this.failScripts.get(name);
    if (failure !== undefined) return fail(failure);
    if (this.echoStdinOn === name) return result("", 1, `got: ${options.input ?? ""}`);
    return this.handle(name, params, root, options.input ?? "");
  }

  // -------------------------------------------------------------------------------------------
  // model helpers

  private installed(name: string): boolean {
    return this.packages.has(name);
  }

  private dockerMajor(): number {
    const version = this.packages.get("docker-ce");
    return version ? Number.parseInt(version.replace(/^\d+:/, ""), 10) : 0;
  }

  private group(name: string): boolean {
    if (name === "docker") return this.installed("docker-ce") || this.installed("docker.io");
    return [...this.users.values()].some((user) => user.groups.includes(name));
  }

  /** Effective sshd settings: an earlier drop-in, then OpsCrew's, then the main file. */
  effectiveSshd() {
    const values: Record<string, string> = {};
    const apply = (settings: Record<string, string>) => {
      for (const [key, value] of Object.entries(settings)) values[key] ??= value;
    };
    if (this.sshdIncludesDropIns && this.sshdEarlierDropIn) apply(this.sshdEarlierDropIn);
    const dropIn = this.files.get(SSHD_DROP_IN);
    if (this.sshdIncludesDropIns && dropIn !== undefined) {
      const settings: Record<string, string> = {};
      for (const line of dropIn.split("\n")) {
        const match = /^(\w+)\s+(\S+)$/.exec(line.trim());
        if (match?.[1] && match[2] && !line.startsWith("#")) settings[match[1].toLowerCase()] = match[2];
      }
      apply(settings);
    }
    apply({
      permitrootlogin: this.sshdBase.permitRootLogin,
      passwordauthentication: this.sshdBase.passwordAuthentication ? "yes" : "no",
      kbdinteractiveauthentication: this.sshdBase.kbdInteractiveAuthentication ? "yes" : "no",
    });
    return values;
  }

  private sshdT(): string {
    const eff = this.effectiveSshd();
    const root = eff.permitrootlogin === "prohibit-password" ? "without-password" : eff.permitrootlogin;
    return [
      ...this.sshdBase.port.map((port) => `port ${port}`),
      "addressfamily any",
      "listenaddress [::]:22",
      `permitrootlogin ${root}`,
      "pubkeyauthentication yes",
      `passwordauthentication ${eff.passwordauthentication}`,
      `kbdinteractiveauthentication ${eff.kbdinteractiveauthentication}`,
      "usepam yes",
      `authenticationmethods ${this.sshdBase.authenticationMethods}`,
      "authorizedkeysfile .ssh/authorized_keys .ssh/authorized_keys2",
      `authorizedkeyscommand ${this.sshdBase.authorizedKeysCommand}`,
      `allowtcpforwarding ${this.sshdBase.allowTcpForwarding}`,
      ...this.sshdBase.allowUsers.map((user) => `allowusers ${user}`),
      ...this.sshdBase.allowGroups.map((group) => `allowgroups ${group}`),
    ].join("\n");
  }

  private ufwAdded(): string {
    if (this.ufwRules.length === 0) return "Added user rules (see 'ufw status' for running firewall):\n(None)";
    return [
      "Added user rules (see 'ufw status' for running firewall):",
      ...this.ufwRules.map((rule) => `ufw ${rule.rule}${rule.comment ? ` comment '${rule.comment}'` : ""}`),
    ].join("\n");
  }

  private ufwDefaultsText(): string {
    const word = { allow: "ACCEPT", deny: "DROP", reject: "REJECT" } as Record<string, string>;
    return [
      `DEFAULT_INPUT_POLICY="${word[this.ufwDefaults.incoming]}"`,
      `DEFAULT_OUTPUT_POLICY="${word[this.ufwDefaults.outgoing]}"`,
      `DEFAULT_FORWARD_POLICY="${word[this.ufwDefaults.routed]}"`,
    ].join("\n");
  }

  private hasRule(rule: string): boolean {
    return this.ufwRules.some((existing) => existing.rule === `allow ${rule}`);
  }

  private dropInOk(p: Record<string, string>): boolean {
    const dropIn = this.files.get(SSHD_DROP_IN);
    return dropIn !== undefined && sha256(dropIn) === p.DROPIN_SHA256;
  }

  private autoUpgradesOn(): boolean {
    return this.installed("unattended-upgrades") && (this.distroAutoUpgrades || this.files.has(AUTO_UPGRADES_FILE));
  }

  private fail2banOk(p: Record<string, string>): boolean {
    const jail = this.files.get(FAIL2BAN_JAIL_PATH);
    return this.fail2banActive && jail !== undefined && sha256(jail) === p.JAIL_SHA256;
  }

  private running(project: string): boolean {
    return this.containers.some((container) => container.project === project);
  }

  private deployKeyOk(key: string): boolean {
    const deploy = this.users.get("deploy");
    return (
      deploy !== undefined &&
      deploy.keys.length === 1 &&
      deploy.keys[0] === key &&
      deploy.groups.includes("docker")
    );
  }

  private markerOk(marker: string): boolean {
    return this.files.get(MARKER_PATH) === marker;
  }

  private dirOk(path: string): boolean {
    const dir = this.dirs.get(path);
    return dir !== undefined && dir.owner === "deploy" && dir.group === "deploy" && dir.mode === "750";
  }

  private removeProject(project: string, volumes: boolean): void {
    this.containers = this.containers.filter((container) => container.project !== project);
    if (volumes) this.volumes.delete(project);
    // docker-proxy listeners go with the last container that published their port.
    this.listeners = this.listeners.filter(
      (listener) =>
        listener.process !== "docker-proxy" ||
        this.containers.some((container) => container.ports.includes(`:${listener.port}->`)),
    );
  }

  private removeUnder(dir: string): void {
    for (const path of [...this.files.keys()]) if (path.startsWith(`${dir}/`)) this.files.delete(path);
  }

  // -------------------------------------------------------------------------------------------
  // inspection output

  private inspection(root: boolean): string {
    const sections: [string, string, number][] = [];
    const add = (name: string, text: string, exit = 0) => sections.push([name, text, exit]);
    const users = [...this.users.entries()];
    add("whoami", this.login);
    add(
      "os-release",
      [
        `PRETTY_NAME="${this.os.pretty}"`,
        `NAME="${this.os.id === "ubuntu" ? "Ubuntu" : this.os.id}"`,
        `VERSION_ID="${this.os.versionId}"`,
        `VERSION_CODENAME=${this.os.codename}`,
        `ID=${this.os.id}`,
        ...(this.os.idLike ? [`ID_LIKE="${this.os.idLike}"`] : []),
        ...(this.os.id === "ubuntu" ? [`UBUNTU_CODENAME=${this.os.codename}`] : []),
      ].join("\n"),
    );
    add("dpkg-arch", this.arch);
    add("uname", MACHINE[this.arch as keyof typeof MACHINE] ?? this.arch);
    add("nproc", "2");
    add(
      "free",
      [
        "               total        used        free      shared  buff/cache   available",
        `Mem:      ${this.memoryBytes}   1000000000   500000000     1000000  1000000000  ${this.memoryBytes - 1_000_000_000}`,
        "Swap:              0           0           0",
      ].join("\n"),
    );
    add(
      "df",
      `Filesystem     1-blocks       Used   Available Capacity Mounted on\n/dev/sda1   80000000000 20000000000 ${this.diskFreeBytes} 25% /`,
    );
    add("systemd", "", this.systemd ? 0 : 1);
    add("flock", this.flock ? "/usr/bin/flock" : "", this.flock ? 0 : 1);
    add("addresses", this.addresses.join("\n"));
    add("sshd", root ? this.sshdT() : "", root ? 0 : 1);
    add("sshd-include", this.sshdIncludesDropIns ? "Include /etc/ssh/sshd_config.d/*.conf" : "", this.sshdIncludesDropIns ? 0 : 1);
    const dropIn = this.files.get(SSHD_DROP_IN);
    add("sshd-dropin", dropIn ?? "", dropIn === undefined ? 1 : 0);
    add("logins-nss", `passwd:         files systemd${this.nssSources.map((s) => ` ${s}`).join("")}`);
    add("logins-pam", this.pamModules.join("\n"), this.pamModules.length > 0 ? 0 : 1);
    add("dpkg-interrupted", this.dpkgInterrupted ? "0001" : "", this.dpkgInterrupted ? 0 : 0);
    add(
      "listeners",
      this.listeners
        .map(
          (l) =>
            `${l.proto}   ${l.proto === "tcp" ? "LISTEN" : "UNCONN"} 0      4096   ${l.address}:${l.port}   0.0.0.0:*    users:(("${l.process}",pid=100,fd=3))`,
        )
        .join("\n"),
    );
    const unit = (name: string, active: boolean) => `${name} ${active ? "active" : "inactive"}`;
    add(
      "units",
      [
        unit("firewalld", this.firewalld),
        unit("nftables", this.nftablesService),
        unit("docker", this.dockerRunning),
        unit("fail2ban", this.fail2banActive),
      ].join("\n"),
    );
    const daemon = this.files.get(DOCKER_DAEMON_JSON_PATH);
    add("docker-daemon", daemon ?? "", daemon === undefined ? 1 : 0);
    const jail = this.files.get(FAIL2BAN_JAIL_PATH);
    add("fail2ban-jail", jail ?? "", jail === undefined ? 1 : 0);
    const sshdJail = this.fail2banActive && (jail !== undefined || this.fail2banOwnJail);
    add("fail2ban-sshd", sshdJail ? "Status for the jail: sshd" : "", sshdJail ? 0 : 255);
    add("upgrades-enabled", this.upgradesServiceEnabled ? "enabled" : "disabled");
    add("ready", "", this.files.has(READY_FLAG) ? 0 : 1);
    if (this.installed("ufw")) {
      add("ufw-status", `Status: ${this.ufwActive ? "active" : "inactive"}`);
      add("ufw-added", this.ufwAdded());
      add("ufw-defaults", this.ufwDefaultsText());
    } else {
      add("ufw-status", "", 127);
      add("ufw-added", "", 127);
      add("ufw-defaults", "", 2);
    }
    const save4 = this.iptablesSave(this.iptables, this.web4);
    const save6 = this.ip6tables;
    add("iptables", save4, save4 ? 0 : 127);
    add("ip6tables", save6, save6 ? 0 : 127);
    add("nft", this.nft, this.nft ? 0 : 127);
    add("snap-docker", this.snapDocker ? "Name Version Rev Tracking Publisher Notes\ndocker 27.2.0 2963 latest/stable canonical** -" : "", this.snapDocker ? 0 : 1);
    add(
      "packages",
      [...this.packages.entries()].map(([name, version]) => `${name}|install ok installed|${version}`).join("\n"),
      1,
    );
    const anyDocker = this.installed("docker-ce") || this.installed("docker.io") || this.snapDocker || this.strayDocker || this.installed("podman-docker");
    add(
      "docker-cli",
      this.installed("podman-docker") ? "podman version 4.9.3" : anyDocker ? "Docker version 28.5.1, build e180ab8" : "",
      anyDocker ? 0 : 127,
    );
    const engine = this.packages.get("docker-ce")?.replace(/^\d+:/, "").replace(/-.*/, "");
    add("docker-server", this.dockerRunning && engine ? engine : "", this.dockerRunning ? 0 : 1);
    add("docker-compose", this.installed("docker-compose-plugin") ? "2.39.4" : "", this.installed("docker-compose-plugin") ? 0 : 1);
    add("docker-buildx", this.installed("docker-buildx-plugin") ? "github.com/docker/buildx v0.29.1" : "", this.installed("docker-buildx-plugin") ? 0 : 1);
    const sources = [...this.files.keys()].filter((path) => path.startsWith("/etc/apt/sources.list.d/docker"));
    add("docker-sources", sources.join("\n"), sources.length > 0 ? 2 : 2);
    add(
      "containers",
      this.dockerRunning
        ? this.containers
            .map((c) => `${c.name}|${c.project}|${c.stopped ? "" : c.ports}|${c.stopped ? "exited" : "running"}`)
            .join("\n")
        : "",
      this.dockerRunning ? 0 : 1,
    );
    add(
      "volumes",
      this.dockerRunning
        ? [...this.volumes.entries()].flatMap(([project, count]) => Array(count).fill(project)).join("\n")
        : "",
      this.dockerRunning ? 0 : 1,
    );
    add("docker-exec", `ExecStart={ path=/usr/bin/dockerd ; argv[]=/usr/bin/dockerd -H fd:// ${this.dockerdFlags.join(" ")} }`);
    add("docker-swarm", this.dockerRunning ? (this.swarm ? "active" : "inactive") : "", this.dockerRunning ? 0 : 1);
    add(
      "users",
      users
        .filter(([, user]) => user.uid === 0 || user.uid >= 1000)
        .map(([name, user]) => `${name}:${user.uid}:${root && user.password ? "pw" : "nopw"}:${user.keys.length > 0 ? "keys" : "nokeys"}`)
        .join("\n"),
    );
    const deploy = this.users.get("deploy");
    add("deploy", deploy ? deploy.groups.join(" ") : "", deploy ? 0 : 2);
    add("deploy-keys", deploy ? deploy.keys.join("\n") : "", deploy && deploy.keys.length > 0 ? 0 : 1);
    add(
      "dirs",
      ["/srv/app", "/srv/data"]
        .map((path) => {
          const dir = this.dirs.get(path);
          return dir ? `${path} dir ${dir.owner} ${dir.group} ${dir.mode} ${dir.entries}` : `${path} absent`;
        })
        .join("\n"),
    );
    add(
      "runtime-files",
      RUNTIME_FILE_NAMES.map((name) => {
        const file = this.appFiles.get(name);
        if (file === undefined) return `${name} absent`;
        if (file.kind !== undefined) return `${name} ${file.kind}`;
        const hashed = (HASHED_RUNTIME_FILES as readonly string[]).includes(name);
        return `${name} file ${file.owner} ${file.group} ${file.mode} ${hashed ? sha256(file.content) : "-"}`;
      }).join("\n"),
    );
    const periodic = this.autoUpgradesOn() ? "1" : "0";
    add(
      "apt-periodic",
      `APT::Periodic::Update-Package-Lists "${periodic}";\nAPT::Periodic::Unattended-Upgrade "${periodic}";`,
    );
    const marker = this.files.get(MARKER_PATH);
    add("marker", marker ?? "", marker === undefined ? 1 : 0);
    const record = this.files.get(RECORD_PATH);
    add("record", record ?? "", record === undefined ? 1 : 0);
    add(
      "pending-undo",
      ["sshd", "ufw"].map((step) => `${step} ${this.timers.has(step) ? "active" : "inactive"}`).join("\n"),
    );
    const addon = (name: string, dir: string, secret: string) => {
      const compose = this.files.get(`${dir}/compose.yaml`);
      if (compose === undefined) return `${name} absent`;
      const id = this.files.get(`${dir}/tunnel.id`)?.trim() || "-";
      return `${name} installed ${sha256(compose)} ${this.files.get(`${dir}/${secret}`) ? "yes" : "no"} ${id}`;
    };
    add(
      "addons",
      [addon("tunnel", TUNNEL_DIR, "tunnel.env"), addon("portainer", PORTAINER_DIR, "admin_password")].join("\n"),
    );
    const fileLine = (name: string, path: string) => {
      const content = this.files.get(path);
      return `file ${name} ${content === undefined ? "-" : sha256(content)}`;
    };
    add(
      "web-filter",
      [
        fileLine("script", WEB_FILTER_SCRIPT),
        fileLine("unit", WEB_FILTER_UNIT),
        fileLine("dropin", WEB_FILTER_DROP_IN),
        `enabled ${this.webFilterUnit.enabled ? "enabled" : "disabled"}`,
        `active ${this.webFilterUnit.active ? "active" : "inactive"}`,
      ].join("\n"),
    );
    add(
      "docker-firewall",
      this.dockerRunning ? `{"Driver":"${this.dockerFirewall}"}` : "",
      this.dockerRunning ? 0 : 1,
    );
    return sections
      .map(([name, text, exit]) => `\n${SECTION_MARK}${name}\n${text}\n${EXIT_MARK}${exit}`)
      .join("\n");
  }

  /** `iptables-save`: the given text plus Docker's DOCKER-USER and OpsCrew's chain. */
  private iptablesSave(base: string, rules: FakeWebRules): string {
    const dockerUser = (this.dockerRunning && this.dockerFirewall === "iptables") || rules.dockerUser;
    if (!dockerUser && rules.chain === null) return base;
    const filter = [
      "*filter",
      ...(dockerUser ? [":DOCKER-USER - [0:0]"] : []),
      ...(rules.chain !== null ? [":OPSCREW-WEB - [0:0]"] : []),
      ...(dockerUser ? rules.dockerUserRules : []),
      ...(rules.chain ?? []),
      "COMMIT",
    ];
    return [base, ...filter].filter((line) => line !== "").join("\n");
  }

  private webRulesOk(rules: FakeWebRules, nets: string): boolean {
    const list = nets.split(" ").filter(Boolean);
    const expected = [...list.map((net) => `-A OPSCREW-WEB -s ${net} -j RETURN`), "-A OPSCREW-WEB -j DROP"];
    return (
      rules.chain !== null &&
      rules.chain.join("\n") === expected.join("\n") &&
      JUMPS.every((jump) => rules.dockerUserRules.slice(0, 3).includes(jump))
    );
  }

  private webFilterOk(p: Record<string, string>): boolean {
    const is = (path: string, sum: string | undefined) => {
      const content = this.files.get(path);
      return content !== undefined && sha256(content) === sum;
    };
    return (
      is(WEB_FILTER_SCRIPT, p.SCRIPT_SHA256) &&
      is(WEB_FILTER_UNIT, p.UNIT_SHA256) &&
      is(WEB_FILTER_DROP_IN, p.DROPIN_SHA256) &&
      this.webFilterUnit.enabled &&
      this.webFilterUnit.active &&
      this.webRulesOk(this.web4, p.IPV4 ?? "")
    );
  }

  private installWebRules(rules: FakeWebRules, nets: string): void {
    rules.chain = [
      ...nets
        .split(" ")
        .filter(Boolean)
        .map((net) => `-A OPSCREW-WEB -s ${net} -j RETURN`),
      "-A OPSCREW-WEB -j DROP",
    ];
    rules.dockerUser = true;
    if (!JUMPS.every((jump) => rules.dockerUserRules.slice(0, 3).includes(jump))) {
      rules.dockerUserRules = [...JUMPS, ...rules.dockerUserRules.filter((line) => !JUMPS.includes(line))];
    }
  }

  private removeWebRules(rules: FakeWebRules): void {
    rules.dockerUserRules = rules.dockerUserRules.filter((line) => !JUMPS.includes(line));
    rules.chain = null;
  }

  // -------------------------------------------------------------------------------------------
  // script handlers

  private check(inPlace: boolean, prev: Record<string, string | boolean> = {}): CommandResult {
    const lines = Object.entries(prev).map(([key, value]) => `prev.${key}=${value}`);
    lines.push(`state=${inPlace ? "in-place" : "change"}`);
    return result(`${lines.join("\n")}\n`);
  }

  private verify(ok: boolean, params: Record<string, string>): CommandResult {
    return ok ? result() : fail(params.VERIFY_FAILED ?? "verify failed", 5);
  }

  private sshdConfigOk(params: Record<string, string>): boolean {
    const eff = this.effectiveSshd();
    if (eff.permitrootlogin !== params.ROOT_LOGIN) return false;
    if (params.PASSWORDS_OFF === "true" && eff.passwordauthentication !== "no") return false;
    if (params.KBD_OFF === "true" && eff.kbdinteractiveauthentication !== "no") return false;
    return true;
  }

  private ufwOk(params: Record<string, string>): boolean {
    if (!this.installed("ufw") || !this.ufwActive || this.timers.has("ufw")) return false;
    const words = (value: string | undefined) => (value ?? "").split(" ").filter(Boolean);
    for (const port of words(params.SSH_PORTS)) if (!this.hasRule(`${port}/tcp`)) return false;
    for (const rule of words(params.WEB_ADD)) if (!this.hasRule(rule)) return false;
    if (params.WEB !== "true") {
      for (const rule of words(params.WEB_RULES)) {
        if (this.ufwRules.some((r) => r.rule === `allow ${rule}` && r.comment === params.WEB_COMMENT)) return false;
      }
    }
    if (params.DENY_INCOMING === "true" && this.ufwDefaults.incoming === "allow") return false;
    return true;
  }

  private tunnelOk(params: Record<string, string>): boolean {
    const compose = this.files.get(`${params.DIR}/compose.yaml`);
    return (
      Boolean(this.files.get(`${params.DIR}/tunnel.env`)) &&
      this.files.get(`${params.DIR}/tunnel.id`)?.trim() === params.TUNNEL_ID &&
      compose !== undefined &&
      sha256(compose) === params.COMPOSE_SHA256 &&
      this.running(params.PROJECT ?? "")
    );
  }

  private portainerOk(params: Record<string, string>): boolean {
    const compose = this.files.get(`${params.DIR}/compose.yaml`);
    return (
      compose !== undefined &&
      sha256(compose) === params.FINAL_SHA256 &&
      !this.files.has(`${params.DIR}/admin_password`) &&
      this.running(params.PROJECT ?? "")
    );
  }

  private removedOk(params: Record<string, string>): boolean {
    const project = params.PROJECT ?? "";
    if ([...this.files.keys()].some((path) => path.startsWith(`${params.DIR}/`))) return false;
    if (this.running(project)) return false;
    if (params.DELETE_DATA === "true" && (this.volumes.get(project) ?? 0) > 0) return false;
    return true;
  }

  private handle(name: string, p: Record<string, string>, root: boolean, input: string): CommandResult {
    switch (name) {
      case "privilege":
        if (this.login === "root") return result("root\n");
        if (this.sudo === "nopasswd") return result("sudo\n");
        return result(this.sudo === "password" ? "sudo-password\n" : "none\n");
      case "inspect":
        return result(this.inspection(root));
      case "record.read":
        return result(this.files.get(RECORD_PATH) ?? "");
      case "record.write":
        this.files.set(RECORD_PATH, p.RECORD ?? "");
        return result();
      case "marker.read":
        return result(this.files.get(MARKER_PATH) ?? "");
    }
    const loginAddon = name.startsWith("portainer") || name.startsWith("tunnel-connector");
    if (!root && !(loginAddon && p.RUN_AS === "login")) {
      return result("", 1, "Permission denied\n");
    }
    const deadMan = /^deadman\.(arm|cancel|trigger)\.(sshd|ufw)$/.exec(name);
    if (deadMan?.[1] && deadMan[2]) return this.deadMan(deadMan[1], deadMan[2], p);
    switch (name) {
      // docker
      case "docker.check": {
        const ok =
          this.dockerMajor() >= Number(p.MIN_MAJOR) &&
          this.installed("docker-compose-plugin") &&
          this.installed("docker-buildx-plugin") &&
          this.dockerRunning;
        return this.check(ok, {
          engine: this.packages.get("docker-ce") ?? "absent",
          repository: [...this.files.keys()].some((f) => f.startsWith("/etc/apt/sources.list.d/docker")) ? "present" : "absent",
        });
      }
      case "docker.apply": {
        if (this.os.id !== p.DISTRO) return fail(`This server no longer runs ${p.DISTRO}; inspect it again.`);
        if (![...this.files.keys()].some((f) => f.startsWith("/etc/apt/sources.list.d/docker"))) {
          this.files.set(
            "/etc/apt/sources.list.d/docker.sources",
            `Types: deb\nURIs: https://download.docker.com/linux/${p.DISTRO}\nSuites: ${this.os.codename}\nComponents: stable\nArchitectures: ${this.arch}\nSigned-By: /etc/apt/keyrings/docker.asc\n`,
          );
          this.packages.set("ca-certificates", "20240203");
          this.packages.set("curl", "8.5.0");
        }
        const version = `5:${this.dockerRepoMajor}.0.1-1~${this.os.id}.${this.os.versionId}~${this.os.codename}`;
        for (const pkg of (p.PACKAGES ?? "").split(" ")) this.packages.set(pkg, pkg === "docker-ce" ? version : "1.0");
        this.dockerRunning = true;
        if (this.dockerRepoMajor < Number(p.MIN_MAJOR)) {
          return fail(`Docker's repository did not offer Docker Engine ${p.MIN_MAJOR} or newer for this release.`);
        }
        return result();
      }
      case "docker.verify":
        return this.verify(
          this.dockerMajor() >= Number(p.MIN_MAJOR) && this.installed("docker-compose-plugin") && this.dockerRunning,
          p,
        );

      // deploy user
      case "deploy-user.check":
        return this.check(this.deployKeyOk(p.PUBLIC_KEY ?? ""), {
          existed: this.users.has("deploy"),
          dockerGroup: this.users.get("deploy")?.groups.includes("docker") ?? false,
        });
      case "deploy-user.apply": {
        if (!this.group("docker")) return fail("The docker group is missing; Docker must be installed first.");
        let deploy = this.users.get("deploy");
        if (deploy === undefined) {
          deploy = { uid: 1001, password: false, keys: [], groups: ["deploy"] };
          this.users.set("deploy", deploy);
        }
        // Exactly the current key: older keys are revoked.
        deploy.keys = [p.PUBLIC_KEY ?? ""];
        if (!deploy.groups.includes("docker")) deploy.groups.push("docker");
        return result();
      }
      case "deploy-user.verify":
        return this.verify(this.deployKeyOk(p.PUBLIC_KEY ?? ""), p);
      case "deploy-user.undo.check":
        return this.check(!this.users.has("deploy"), { existed: this.users.has("deploy") });
      case "deploy-user.undo.apply":
        this.users.delete("deploy");
        return result();
      case "deploy-user.undo.verify":
        return this.verify(!this.users.has("deploy"), p);

      // sshd
      case "sshd.check":
        return this.check(this.sshdConfigOk(p) && this.dropInOk(p) && !this.timers.has("sshd"), {
          dropIn: this.files.has(SSHD_DROP_IN) ? "present" : "absent",
          permitRootLogin: this.effectiveSshd().permitrootlogin ?? "",
          passwordAuthentication: this.effectiveSshd().passwordauthentication ?? "",
        });
      case "sshd.apply": {
        const current = this.files.get(SSHD_DROP_IN);
        if (current !== undefined && !this.files.has(SSHD_BACKUP) && !current.startsWith(SSHD_HEADER)) {
          this.files.set(SSHD_BACKUP, current);
        }
        this.files.set(SSHD_DROP_IN, Buffer.from(p.DROPIN_B64 ?? "", "base64").toString("utf8"));
        if (this.sshdTestFails) {
          this.timers.get("sshd")?.();
          return fail("The new SSH settings did not pass sshd -t, so OpsCrew put the previous ones back.", 4);
        }
        if (!this.sshdConfigOk(p)) {
          this.timers.get("sshd")?.();
          return fail("Another SSH setting takes precedence over the file OpsCrew writes.", 4);
        }
        this.sshdReloads += 1;
        return result();
      }
      case "sshd.verify":
        return this.verify(this.sshdConfigOk(p) && this.dropInOk(p) && !this.timers.has("sshd"), p);
      case "sshd.undo.check": {
        const backup = this.files.get(SSHD_BACKUP);
        const done = backup !== undefined ? this.files.get(SSHD_DROP_IN) === backup : !this.files.has(SSHD_DROP_IN);
        return this.check(done && !this.timers.has("sshd"), { dropIn: this.files.has(SSHD_DROP_IN) ? "present" : "absent" });
      }
      case "sshd.undo.apply": {
        const backup = this.files.get(SSHD_BACKUP);
        if (backup !== undefined) this.files.set(SSHD_DROP_IN, backup);
        else this.files.delete(SSHD_DROP_IN);
        this.sshdReloads += 1;
        return result();
      }
      case "sshd.undo.verify": {
        const backup = this.files.get(SSHD_BACKUP);
        const done = backup !== undefined ? this.files.get(SSHD_DROP_IN) === backup : !this.files.has(SSHD_DROP_IN);
        return this.verify(done && !this.timers.has("sshd"), p);
      }

      // ufw
      // web-filter
      case "web-filter.check":
        return this.check(this.webFilterOk(p), { installed: this.files.has(WEB_FILTER_SCRIPT) });
      case "web-filter.verify":
        return this.verify(this.webFilterOk(p), p);
      case "web-filter.apply": {
        const daemon = this.files.get(DOCKER_DAEMON_JSON_PATH) ?? "";
        if (this.dockerFirewall === "nftables" || /"firewall-backend"\s*:\s*"nftables"/.test(daemon)) {
          return fail("Docker is set to its nftables firewall backend.");
        }
        const decode = (value: string | undefined) => Buffer.from(value ?? "", "base64").toString("utf8");
        this.files.set(WEB_FILTER_SCRIPT, decode(p.SCRIPT_B64));
        this.files.set(WEB_FILTER_UNIT, decode(p.UNIT_B64));
        this.installWebRules(this.web4, p.IPV4 ?? "");
        this.files.set(WEB_FILTER_DROP_IN, decode(p.DROPIN_B64));
        this.webFilterUnit = { enabled: true, active: true };
        this.webFilterLog.push(`install ${p.IPV4}`);
        return result();
      }
      case "web-filter.remove.check":
      case "web-filter.remove.verify": {
        const ok =
          !this.files.has(WEB_FILTER_SCRIPT) &&
          !this.files.has(WEB_FILTER_UNIT) &&
          !this.files.has(WEB_FILTER_DROP_IN) &&
          this.web4.chain === null;
        return name.endsWith("check") ? this.check(ok) : this.verify(ok, p);
      }
      case "web-filter.remove.apply":
        this.files.delete(WEB_FILTER_DROP_IN);
        this.webFilterUnit = { enabled: false, active: false };
        this.removeWebRules(this.web4);
        this.files.delete(WEB_FILTER_UNIT);
        this.files.delete(WEB_FILTER_SCRIPT);
        this.webFilterLog.push("remove");
        return result();

      case "ufw.install.apply":
        if (!this.installed("ufw")) {
          this.packages.set("ufw", "0.36.2");
          this.ufwLog.push("install");
        }
        return result();
      case "ufw.check":
        return this.check(this.ufwOk(p), {
          installed: this.installed("ufw"),
          active: this.ufwActive,
          rules: this.ufwRules.map((rule) => rule.rule).join(","),
          defaultIncoming: this.installed("ufw") ? this.ufwDefaults.incoming : "",
          defaultOutgoing: this.installed("ufw") ? this.ufwDefaults.outgoing : "",
          defaultRouted: this.installed("ufw") ? this.ufwDefaults.routed : "",
        });
      case "ufw.apply": {
        if (!this.installed("ufw")) return fail("ufw is not installed.");
        const words = (value: string | undefined) => (value ?? "").split(" ").filter(Boolean);
        for (const port of words(p.SSH_PORTS)) {
          if (!this.hasRule(`${port}/tcp`)) {
            this.ufwRules.push({ rule: `allow ${port}/tcp`, comment: p.SSH_COMMENT ?? null });
            this.ufwLog.push(`allow ${port}/tcp`);
          }
        }
        for (const rule of words(p.WEB_ADD)) {
          if (!this.hasRule(rule)) {
            this.ufwRules.push({ rule: `allow ${rule}`, comment: p.WEB_COMMENT ?? null });
            this.ufwLog.push(`allow ${rule}`);
          }
        }
        if (p.WEB !== "true") {
          for (const rule of words(p.WEB_RULES)) {
            const before = this.ufwRules.length;
            this.ufwRules = this.ufwRules.filter((r) => !(r.rule === `allow ${rule}` && r.comment === p.WEB_COMMENT));
            if (this.ufwRules.length !== before) this.ufwLog.push(`delete allow ${rule}`);
          }
        }
        if (p.DENY_INCOMING === "true" && this.ufwDefaults.incoming === "allow") {
          this.ufwDefaults = { ...this.ufwDefaults, incoming: "deny" };
          this.ufwLog.push("default deny incoming");
        }
        if (p.ENABLE === "true" && !this.ufwActive) {
          this.ufwDefaults = { ...this.ufwDefaults, incoming: "deny", outgoing: "allow" };
          this.ufwActive = true;
          this.ufwLog.push("enable");
        }
        return result();
      }
      case "ufw.verify":
        return this.verify(this.ufwOk(p), p);
      case "ufw.undo.check":
      case "ufw.undo.verify": {
        const removeRules = (p.REMOVE_RULES ?? "").split(" ").filter(Boolean);
        const ok =
          !this.installed("ufw") ||
          (!removeRules.some((rule) => this.hasRule(rule)) &&
            !(p.DISABLE === "true" && this.ufwActive) &&
            !(p.DEFAULT_INCOMING && p.DEFAULT_INCOMING !== this.ufwDefaults.incoming) &&
            !(p.DEFAULT_OUTGOING && p.DEFAULT_OUTGOING !== this.ufwDefaults.outgoing) &&
            !(p.DEFAULT_ROUTED && p.DEFAULT_ROUTED !== this.ufwDefaults.routed) &&
            !this.timers.has("ufw"));
        return name.endsWith("check") ? this.check(ok, { active: this.ufwActive }) : this.verify(ok, p);
      }
      case "ufw.undo.apply": {
        for (const rule of (p.REMOVE_RULES ?? "").split(" ").filter(Boolean)) {
          this.ufwRules = this.ufwRules.filter((r) => r.rule !== `allow ${rule}`);
          this.ufwLog.push(`delete allow ${rule}`);
        }
        if (p.DEFAULT_INCOMING) this.ufwDefaults.incoming = p.DEFAULT_INCOMING;
        if (p.DEFAULT_OUTGOING) this.ufwDefaults.outgoing = p.DEFAULT_OUTGOING;
        if (p.DEFAULT_ROUTED) this.ufwDefaults.routed = p.DEFAULT_ROUTED;
        if (p.DISABLE === "true") {
          this.ufwActive = false;
          this.ufwLog.push("disable");
        }
        return result();
      }
      case "ufw.undo-package.apply":
        this.packages.delete("ufw");
        this.ufwRules = [];
        return result();

      // unattended-upgrades
      case "unattended-upgrades.check":
        return this.check(this.autoUpgradesOn() && this.upgradesServiceEnabled, {
          installed: this.installed("unattended-upgrades"),
          file: this.files.has(AUTO_UPGRADES_FILE) ? "present" : "absent",
          serviceEnabled: this.upgradesServiceEnabled,
        });
      case "unattended-upgrades.apply":
        if (!this.installed("unattended-upgrades")) {
          this.packages.set("unattended-upgrades", "2.9.1");
          this.upgradesServiceEnabled = false;
        }
        if (!this.autoUpgradesOn()) {
          this.files.set(AUTO_UPGRADES_FILE, 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n');
        }
        this.upgradesServiceEnabled = true;
        return result();
      case "unattended-upgrades.verify":
        return this.verify(this.autoUpgradesOn() && this.upgradesServiceEnabled, p);
      case "unattended-upgrades.undo.check":
      case "unattended-upgrades.undo.verify": {
        const ok =
          !this.files.has(AUTO_UPGRADES_FILE) &&
          !(p.REMOVE_PACKAGE === "true" && this.installed("unattended-upgrades")) &&
          !(p.DISABLE_SERVICE === "true" && this.upgradesServiceEnabled);
        return name.endsWith("check") ? this.check(ok) : this.verify(ok, p);
      }
      case "unattended-upgrades.undo.apply":
        this.files.delete(AUTO_UPGRADES_FILE);
        if (p.DISABLE_SERVICE === "true") this.upgradesServiceEnabled = false;
        if (p.REMOVE_PACKAGE === "true") this.packages.delete("unattended-upgrades");
        return result();

      // docker daemon settings
      case "docker-daemon.check":
        return this.check(this.files.has(DOCKER_DAEMON_JSON_PATH) || this.dockerdFlags.length > 0 || this.swarm, {
          file: this.files.has(DOCKER_DAEMON_JSON_PATH) ? "present" : "absent",
        });
      case "docker-daemon.apply":
        if (this.files.has(DOCKER_DAEMON_JSON_PATH)) return result();
        this.files.set(DOCKER_DAEMON_JSON_PATH, Buffer.from(p.CONTENT_B64 ?? "", "base64").toString("utf8"));
        if (this.containers.length === 0) this.dockerRestarts += 1;
        else this.dockerReloads += 1;
        return result();
      case "docker-daemon.verify":
        return this.verify(this.files.has(DOCKER_DAEMON_JSON_PATH), p);
      case "docker-daemon.undo.check":
      case "docker-daemon.undo.verify": {
        const ok = this.files.get(DOCKER_DAEMON_JSON_PATH) !== DOCKER_DAEMON_JSON;
        return name.endsWith("check") ? this.check(ok) : this.verify(ok, p);
      }
      case "docker-daemon.undo.apply":
        if (this.files.get(DOCKER_DAEMON_JSON_PATH) === DOCKER_DAEMON_JSON) {
          this.files.delete(DOCKER_DAEMON_JSON_PATH);
          this.dockerReloads += 1;
        }
        return result();

      // fail2ban
      case "fail2ban.check":
        return this.check(this.fail2banOk(p), {
          installed: this.installed("fail2ban"),
          active: this.fail2banActive,
          jail: this.files.has(FAIL2BAN_JAIL_PATH) ? "present" : "absent",
        });
      case "fail2ban.apply":
        this.packages.set("fail2ban", "1.0.2");
        this.packages.set("python3-systemd", "235");
        this.files.set(FAIL2BAN_JAIL_PATH, Buffer.from(p.JAIL_B64 ?? "", "base64").toString("utf8"));
        this.fail2banActive = true;
        return result();
      case "fail2ban.verify":
        return this.verify(this.fail2banOk(p), p);
      case "fail2ban.undo.check":
      case "fail2ban.undo.verify": {
        const ok =
          !this.files.has(FAIL2BAN_JAIL_PATH) &&
          !(p.REMOVE_PACKAGE === "true" && this.installed("fail2ban")) &&
          !(p.DISABLE_SERVICE === "true" && this.fail2banActive);
        return name.endsWith("check") ? this.check(ok) : this.verify(ok, p);
      }
      case "fail2ban.undo.apply":
        this.files.delete(FAIL2BAN_JAIL_PATH);
        if (p.REMOVE_PACKAGE === "true") {
          this.packages.delete("fail2ban");
          this.fail2banActive = false;
        } else if (p.DISABLE_SERVICE === "true") {
          this.fail2banActive = false;
        }
        return result();

      // runtime dirs
      case "runtime-dirs.check":
        return this.check(this.dirOk("/srv/app") && this.dirOk("/srv/data"), {
          app: this.dirs.has("/srv/app") ? "present" : "absent",
          data: this.dirs.has("/srv/data") ? "present" : "absent",
        });
      case "runtime-dirs.apply":
        for (const path of (p.DIRS ?? "").split(" ")) {
          const existing = this.dirs.get(path);
          this.dirs.set(path, { owner: "deploy", group: "deploy", mode: "750", entries: existing?.entries ?? 0 });
        }
        return result();
      case "runtime-dirs.verify":
        return this.verify(this.dirOk("/srv/app") && this.dirOk("/srv/data"), p);
      case "runtime-dirs.teardown.check":
      case "runtime-dirs.teardown.verify": {
        const ok =
          !this.running(p.APP ?? "") &&
          (this.dirs.get("/srv/app")?.entries ?? 0) === 0 &&
          !(p.DELETE_DATA === "true" && (this.dirs.get("/srv/data")?.entries ?? 0) > 0);
        return name.endsWith("check") ? this.check(ok, { appFiles: String(this.dirs.get("/srv/app")?.entries ?? 0) }) : this.verify(ok, p);
      }
      case "runtime-dirs.teardown.apply": {
        this.removeProject(p.APP ?? "", p.DELETE_DATA === "true");
        const app = this.dirs.get("/srv/app");
        if (app) app.entries = 0;
        this.appFiles.clear();
        const data = this.dirs.get("/srv/data");
        if (data && p.DELETE_DATA === "true") data.entries = 0;
        return result();
      }
      case "runtime-dirs.undo.check":
      case "runtime-dirs.undo.verify": {
        const ok = !(p.DIRS ?? "").split(" ").some((path) => this.dirs.get(path)?.entries === 0);
        return name.endsWith("check") ? this.check(ok) : this.verify(ok, p);
      }
      case "runtime-dirs.undo.apply":
        for (const path of (p.DIRS ?? "").split(" ")) if (this.dirs.get(path)?.entries === 0) this.dirs.delete(path);
        return result();

      // app marker
      case "app-marker.check":
        return this.check(this.markerOk(p.MARKER ?? "") && this.files.has(READY_FLAG), {
          marker: this.files.has(MARKER_PATH) ? "present" : "absent",
        });
      case "app-marker.apply": {
        const current = this.files.get(MARKER_PATH);
        if (current !== undefined && current !== p.MARKER) return fail("Another OpsCrew app is already on this server.");
        this.files.set(MARKER_PATH, p.MARKER ?? "");
        this.files.set(READY_FLAG, "");
        return result();
      }
      case "app-marker.verify":
        return this.verify(this.markerOk(p.MARKER ?? "") && this.files.has(READY_FLAG), p);
      case "app-marker.teardown.check":
        return this.check(!this.files.has(MARKER_PATH));
      case "app-marker.teardown.apply":
        this.files.delete(MARKER_PATH);
        return result();
      case "app-marker.teardown.verify":
        return this.verify(!this.files.has(MARKER_PATH), p);
      case "app-marker.undo.check":
        return this.check(
          ![...this.files.keys()].some((path) => path.startsWith("/etc/opscrew/")) && !this.files.has(READY_FLAG),
        );
      case "app-marker.undo.apply":
        if (this.files.has(MARKER_PATH)) return fail("An OpsCrew app is still on this server; remove it first.");
        this.files.delete(READY_FLAG);
        this.removeUnder("/etc/opscrew");
        return result();
      case "app-marker.undo.verify":
        return this.verify(
          ![...this.files.keys()].some((path) => path.startsWith("/etc/opscrew/")) && !this.files.has(READY_FLAG),
          p,
        );

      // tunnel connector
      case "tunnel-connector.check":
        return this.check(this.tunnelOk(p), { installed: this.files.has(`${p.DIR}/compose.yaml`) });
      case "tunnel-connector.apply": {
        const token = input.split("\n")[0] ?? "";
        if (token !== "") {
          if (/[^A-Za-z0-9+/=_.-]/.test(token)) return fail("The tunnel token has unexpected characters, so it was not written.");
          this.files.set(`${p.DIR}/tunnel.env`, `TUNNEL_TOKEN=${token}\n`);
          if (this.running(p.PROJECT ?? "")) this.tunnelRecreates += 1;
        } else if (p.NEEDS_TOKEN === "true" || !this.files.get(`${p.DIR}/tunnel.env`)) {
          return fail("No tunnel token arrived on standard input, so the tunnel connector was not set up.");
        }
        this.files.set(`${p.DIR}/tunnel.id`, `${p.TUNNEL_ID}\n`);
        this.files.set(`${p.DIR}/compose.yaml`, Buffer.from(p.COMPOSE_B64 ?? "", "base64").toString("utf8"));
        if (!this.running(p.PROJECT ?? "")) {
          this.containers.push({ name: `${p.PROJECT}-cloudflared-1`, project: p.PROJECT ?? "", ports: "" });
        }
        return result();
      }
      case "tunnel-connector.verify":
        return this.verify(this.tunnelOk(p), p);
      case "tunnel-connector.remove.check":
      case "portainer.remove.check":
        return this.check(this.removedOk(p));
      case "tunnel-connector.remove.apply":
      case "portainer.remove.apply":
        this.removeProject(p.PROJECT ?? "", p.DELETE_DATA === "true");
        this.removeUnder(p.DIR ?? "");
        return result();
      case "tunnel-connector.remove.verify":
      case "portainer.remove.verify":
        return this.verify(this.removedOk(p), p);

      // portainer
      case "portainer.check":
        return this.check(this.portainerOk(p), { installed: this.files.has(`${p.DIR}/compose.yaml`) });
      case "portainer.apply": {
        const password = input.split("\n")[0] ?? "";
        const dir = p.DIR ?? "";
        if (password !== "") {
          this.files.set(`${dir}/admin_password`, password);
          this.files.set(`${dir}/compose.yaml`, Buffer.from(p.INITIAL_B64 ?? "", "base64").toString("utf8"));
          this.portainerAdmin = true;
        } else if (p.NEEDS_PASSWORD === "true") {
          return fail("No Portainer admin password arrived on standard input, so Portainer was not set up.");
        } else {
          this.files.set(`${dir}/compose.yaml`, Buffer.from(p.FINAL_B64 ?? "", "base64").toString("utf8"));
        }
        if (!this.running(p.PROJECT ?? "")) {
          this.containers.push({ name: `${p.PROJECT}-portainer-1`, project: p.PROJECT ?? "", ports: "127.0.0.1:9443->9443/tcp" });
        }
        this.volumes.set(p.PROJECT ?? "", 1);
        if (!this.portainerAdmin) {
          this.removeProject(p.PROJECT ?? "", false);
          this.files.delete(`${dir}/admin_password`);
          return fail(
            password === ""
              ? "Portainer has data on this server but no admin account, and no admin password reached the server, so OpsCrew stopped it. Run opscrew portainer disable --delete-data and turn Portainer on again."
              : "Portainer started without an admin account, so OpsCrew stopped it.",
          );
        }
        this.files.set(`${dir}/compose.yaml`, Buffer.from(p.FINAL_B64 ?? "", "base64").toString("utf8"));
        this.files.delete(`${dir}/admin_password`);
        return result();
      }
      case "portainer.verify":
        return this.verify(this.portainerOk(p), p);

      case "package-repair.check":
        return this.check(!this.dpkgInterrupted, { interrupted: true });
      case "package-repair.apply":
        this.dpkgInterrupted = false;
        return result();
      case "package-repair.verify":
        return this.verify(!this.dpkgInterrupted, p);

      case "docker.keep.check":
        return this.check(true);
    }
    throw new Error(`fake host: unknown script ${name}`);
  }

  private deadMan(action: string, step: string, p: Record<string, string>): CommandResult {
    if (action === "arm") {
      this.timers.get(step)?.();
      this.armedSeconds.push(Number(p.DELAY));
      if (step === "sshd") {
        const before = this.files.get(SSHD_DROP_IN);
        this.timers.set("sshd", () => {
          if (before === undefined) this.files.delete(SSHD_DROP_IN);
          else this.files.set(SSHD_DROP_IN, before);
          this.sshdReloads += 1;
          this.timers.delete("sshd");
        });
      } else {
        const active = this.ufwActive;
        const rules = this.ufwRules.map((rule) => ({ ...rule }));
        const defaults = { ...this.ufwDefaults };
        this.timers.set("ufw", () => {
          this.ufwActive = active;
          this.ufwRules = rules;
          this.ufwDefaults = defaults;
          this.ufwLog.push("restored");
          this.timers.delete("ufw");
        });
      }
      return result("armed\n");
    }
    if (action === "cancel") {
      if (this.fireBeforeCancel) {
        this.timers.get(step)?.();
        return result("fired\n");
      }
      const pending = this.timers.has(step);
      this.timers.delete(step);
      return result(pending ? "cancelled\n" : "fired\n");
    }
    this.timers.get(step)?.();
    return result("restored\n");
  }
}

/** Puts the app's runtime on the fake (as a deploy would): containers and files. */
export function deployApp(fake: FakeHost, app: string, access: "public" | "tunnel" = "public"): void {
  fake.containers.push(
    { name: `${app}-app-1`, project: app, ports: "" },
    {
      name: `${app}-caddy-1`,
      project: app,
      ports: access === "public" ? "0.0.0.0:80->80/tcp, [::]:80->80/tcp, 0.0.0.0:443->443/tcp" : "127.0.0.1:18080->80/tcp",
    },
  );
  if (access === "public") {
    fake.listeners.push(
      { proto: "tcp", address: "0.0.0.0", port: 80, process: "docker-proxy" },
      { proto: "tcp", address: "0.0.0.0", port: 443, process: "docker-proxy" },
    );
  } else {
    fake.listeners.push({ proto: "tcp", address: "127.0.0.1", port: 18080, process: "docker-proxy" });
  }
  const appDir = fake.dirs.get("/srv/app");
  if (appDir) {
    appDir.entries = 4;
    const file = (content: string, mode: string) => ({ content, owner: "deploy", group: "deploy", mode });
    fake.appFiles.set("compose.yaml", file(`name: ${app}\nservices: {}\n`, "644"));
    fake.appFiles.set("Caddyfile", file(":80 {\n}\n", "644"));
    fake.appFiles.set(".env", file("APP_IMAGE=ghcr.io/acme/shop@sha256:0\n", "644"));
    fake.appFiles.set("app.env", file("NODE_ENV=production\n", "600"));
  }
  const dataDir = fake.dirs.get("/srv/data");
  if (dataDir) dataDir.entries = 1;
}

export { BACKUP_DIR };
