/**
 * Parsers for the output of the fixed, read-only inspection commands. They never throw on odd
 * output: unknown lines are ignored and missing values fall back to "unknown" defaults, which
 * the planner treats conservatively.
 */
import { sha256Hex } from "@opscrew/core";
import {
  APPS_DIR,
  DATA_DIR,
  HASHED_RUNTIME_FILES,
  RUNNERS_DIR,
  RUNTIME_FILE_NAMES,
  type RuntimeFileName,
  SHARED_DIRS,
} from "./constants";
import {
  type AppRecord,
  AppRecordSchema,
  type DirFact,
  type HostFacts,
  type Listener,
  type RunnerFact,
  type RuntimeFileFact,
  ServiceEnvFileSchema,
  type WebFilterRules,
} from "./facts";
import { runnerUnitText } from "./runner-unit";

/** Output of one inspection section: its text and the exit code of its command. */
export interface Section {
  text: string;
  exit: number;
}

export const SECTION_MARK = "@@opscrew-section ";
export const EXIT_MARK = "@@opscrew-exit ";

/** Splits the inspection script's output into its sections. */
export function splitSections(output: string): Map<string, Section> {
  const sections = new Map<string, Section>();
  let name: string | undefined;
  let lines: string[] = [];
  for (const raw of output.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.startsWith(SECTION_MARK)) {
      name = line.slice(SECTION_MARK.length).trim();
      lines = [];
      continue;
    }
    if (line.startsWith(EXIT_MARK) && name !== undefined) {
      while (lines.length > 0 && lines[lines.length - 1]?.trim() === "") lines.pop();
      const exit = Number.parseInt(line.slice(EXIT_MARK.length).trim(), 10);
      sections.set(name, { text: lines.join("\n"), exit: Number.isNaN(exit) ? 1 : exit });
      name = undefined;
      continue;
    }
    if (name !== undefined) lines.push(line);
  }
  return sections;
}

/** Non-empty, trimmed lines. */
export function linesOf(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/** `/etc/os-release` key/value pairs (quotes removed). */
export function parseOsRelease(text: string): HostFacts["os"] {
  const values = new Map<string, string>();
  for (const line of linesOf(text)) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line);
    if (!match?.[1]) continue;
    let value = match[2] ?? "";
    if (/^".*"$/.test(value) || /^'.*'$/.test(value)) value = value.slice(1, -1);
    values.set(match[1], value);
  }
  return {
    id: (values.get("ID") ?? "").toLowerCase(),
    versionId: values.get("VERSION_ID") ?? "",
    prettyName: values.get("PRETTY_NAME") ?? "",
  };
}

function toNumber(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

/** `free -b`: total memory in bytes. */
export function parseFree(text: string): number {
  for (const line of linesOf(text)) {
    if (!line.startsWith("Mem:")) continue;
    // Mem: total used free shared buff/cache available
    return toNumber(line.split(/\s+/)[1]);
  }
  return 0;
}

/** `df -P -B1 /`: available bytes of the root filesystem. */
export function parseDf(text: string): number {
  const rows = linesOf(text).filter((line) => !line.startsWith("Filesystem"));
  return toNumber(rows[rows.length - 1]?.split(/\s+/)[3]);
}

/** `ssh -V` (`OpenSSH_9.6p1 Ubuntu-3ubuntu13.14, OpenSSL ...`): `9.6`, or null. */
export function parseOpensshVersion(text: string): string | null {
  return /^OpenSSH_(\d+\.\d+)/m.exec(text)?.[1] ?? null;
}

/**
 * `sshd -T`: the effective settings OpsCrew cares about (`allowTcpForwarding` is the global value,
 * without Match blocks); null when the output is unusable.
 */
export function parseSshdT(
  text: string,
): Omit<NonNullable<HostFacts["sshd"]>, "dropInIncluded" | "dropIn" | "version"> | null {
  const values = new Map<string, string[]>();
  for (const line of linesOf(text)) {
    const space = line.indexOf(" ");
    if (space <= 0) continue;
    const key = line.slice(0, space).toLowerCase();
    const list = values.get(key) ?? [];
    list.push(line.slice(space + 1).trim());
    values.set(key, list);
  }
  const ports = (values.get("port") ?? [])
    .map((value) => Number.parseInt(value, 10))
    .filter((port) => Number.isInteger(port) && port > 0 && port < 65536);
  if (ports.length === 0) return null;
  const first = (key: string, fallback: string) => values.get(key)?.[0]?.toLowerCase() ?? fallback;
  const words = (key: string) => (values.get(key) ?? []).flatMap((value) => value.split(/\s+/));
  const rootLogin = first("permitrootlogin", "prohibit-password");
  // `listenaddress 0.0.0.0:2222` or `listenaddress [::]:22` (sshd -T always names the port).
  const listenPorts = (values.get("listenaddress") ?? [])
    .map((value) => Number.parseInt(/:(\d{1,5})(?:\s|$)/.exec(value)?.[1] ?? "", 10))
    .filter((port) => Number.isInteger(port) && port > 0 && port < 65536);
  return {
    ports: [...new Set(ports)].sort((a, b) => a - b),
    listenPorts: [...new Set(listenPorts)].sort((a, b) => a - b),
    passwordAuthentication: first("passwordauthentication", "yes") === "yes",
    kbdInteractiveAuthentication:
      first("kbdinteractiveauthentication", first("challengeresponseauthentication", "yes")) ===
      "yes",
    permitRootLogin: rootLogin === "without-password" ? "prohibit-password" : rootLogin,
    authenticationMethods: first("authenticationmethods", "any"),
    allowUsers: words("allowusers"),
    allowGroups: words("allowgroups"),
    denyUsers: words("denyusers"),
    denyGroups: words("denygroups"),
    authorizedKeysCommand: !["", "none"].includes(first("authorizedkeyscommand", "none")),
    allowTcpForwarding: first("allowtcpforwarding", "yes"),
  };
}

/** `ss -H -ltnup`: listening TCP and UDP sockets with the first process name. */
export function parseSs(text: string): Listener[] {
  const listeners: Listener[] = [];
  for (const line of linesOf(text)) {
    const cols = line.split(/\s+/);
    const proto = cols[0];
    if (proto !== "tcp" && proto !== "udp") continue;
    const local = cols[4] ?? "";
    const colon = local.lastIndexOf(":");
    if (colon < 0) continue;
    const port = Number.parseInt(local.slice(colon + 1), 10);
    if (!Number.isInteger(port)) continue;
    const process = /users:\(\("([^"]+)"/.exec(line)?.[1] ?? "";
    listeners.push({ proto, address: local.slice(0, colon), port, process });
  }
  return listeners;
}

/** True when a listening address is only reachable from the server itself. */
export function isLoopback(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  return (
    bare.startsWith("127.") ||
    bare === "::1" ||
    bare === "localhost" ||
    bare.startsWith("::ffff:127.")
  );
}

/** Lines of `name state` pairs (from `systemctl is-active` loops). */
export function parsePairs(text: string): Map<string, string> {
  const pairs = new Map<string, string>();
  for (const line of linesOf(text)) {
    const [name, ...rest] = line.split(/\s+/);
    if (name) pairs.set(name, rest.join(" "));
  }
  return pairs;
}

/** `ufw show added`: rules without the leading `ufw `, with their comment when present. */
export function parseUfwAdded(text: string): HostFacts["firewall"]["ufwRules"] {
  const rules: HostFacts["firewall"]["ufwRules"] = [];
  for (const line of linesOf(text)) {
    if (!line.startsWith("ufw ")) continue;
    const match = /^ufw (.*?)(?: comment '((?:[^'\\]|\\.)*)')?$/.exec(line);
    if (!match?.[1]) continue;
    rules.push({ rule: match[1].trim(), comment: match[2] ?? null });
  }
  return rules;
}

/** `dpkg-query -W -f='${Package}|${Status}|${Version}\n'`: installed packages and versions. */
export function parseDpkg(text: string): Map<string, string> {
  const installed = new Map<string, string>();
  for (const line of linesOf(text)) {
    const [name, status, version] = line.split("|");
    if (name && status && / installed$/.test(status)) installed.set(name, version ?? "");
  }
  return installed;
}

/**
 * Docker Engine version from a Debian package version (`5:28.5.1-1~ubuntu.24.04~noble`) or the
 * version the daemon reports (`28.5.1`).
 */
export function engineVersion(packageVersion: string): string | null {
  const match = /^(?:\d+:)?(\d+\.\d+\.\d+)/.exec(packageVersion.trim());
  return match?.[1] ?? null;
}

/** Major version number of `28.5.1`, or 0 when unknown. */
export function majorOf(version: string | null): number {
  const major = Number.parseInt(version ?? "", 10);
  return Number.isInteger(major) ? major : 0;
}

/**
 * `docker ps -a --format '{{.Names}}|{{.Label "com.docker.compose.project"}}|{{.Ports}}|{{.State}}'`
 * (all containers, running or not).
 */
export function parseContainers(text: string): HostFacts["containers"] {
  return linesOf(text).flatMap((line) => {
    const fields = line.split("|");
    const [name, project] = fields;
    if (!name) return [];
    const state = fields.length >= 4 ? (fields[fields.length - 1] ?? "") : "running";
    const ports = fields.slice(2, fields.length >= 4 ? -1 : undefined).join("|");
    return [{ name, project: project ?? "", ports, running: state === "running" }];
  });
}

/** Directory services on the `passwd:` line of `/etc/nsswitch.conf` (sss, ldap, winbind, nis). */
export function parseNsswitchPasswd(text: string): string[] {
  const line = linesOf(text).find((item) => /^passwd:/.test(item)) ?? "";
  const sources = line
    .replace(/^passwd:/, "")
    .replace(/\[[^\]]*\]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  return [...new Set(sources.filter((source) => /^(sss|ldap|winbind|nis|nisplus)$/.test(source)))];
}

const UFW_POLICY: Readonly<Record<string, string>> = {
  ACCEPT: "allow",
  DROP: "deny",
  REJECT: "reject",
};

/** `/etc/default/ufw` policies as ufw words (`allow`, `deny`, `reject`); null when unreadable. */
export function parseUfwDefaults(text: string): HostFacts["firewall"]["ufwDefaults"] {
  const value = (key: string) => {
    const match = new RegExp(`^DEFAULT_${key}_POLICY="?([A-Z]+)"?`, "m").exec(text);
    return match?.[1] ? UFW_POLICY[match[1]] : undefined;
  };
  const incoming = value("INPUT");
  const outgoing = value("OUTPUT");
  const routed = value("FORWARD");
  if (!incoming || !outgoing || !routed) return null;
  return { incoming, outgoing, routed };
}

/** dockerd flags in `systemctl show -p ExecStart docker` that daemon.json would also set. */
export function dockerdFlags(text: string): string[] {
  const found = text.match(/--(log-driver|log-opt|live-restore|no-new-privileges)\b/g) ?? [];
  return [...new Set(found)];
}

/** What a ufw rule (as in `ufw show added`, without `ufw `) does for a port. */
export interface UfwCoverage {
  /** The rule lets the port in (allow or limit, incoming). */
  covers: boolean;
  /** Only from some addresses (`from <source>` other than `any`). */
  limitedSource: boolean;
  /** A `limit` (rate-limited) rule. */
  rateLimited: boolean;
}

/** Port specs (`22`, `22/tcp`, `20:30/tcp`, `22,80/tcp`) and the protocol they apply to. */
function portSpecCovers(spec: string, port: number, proto: "tcp" | "udp"): boolean {
  const [ports = "", specProto] = spec.split("/");
  if (specProto !== undefined && specProto !== proto) return false;
  return ports.split(",").some((part) => {
    const [low, high] = part.split(":").map((value) => Number.parseInt(value, 10));
    if (low === undefined || Number.isNaN(low)) return false;
    return high === undefined || Number.isNaN(high) ? port === low : port >= low && port <= high;
  });
}

/** Application profiles and service names that mean SSH on port 22. */
const SSH_NAMES = new Set(["openssh", "ssh"]);

/**
 * Whether an added ufw rule lets `port/proto` in. Understands the simple syntax (`allow 22/tcp`,
 * `limit ssh`, `allow OpenSSH`) and the full one (`allow from 10.0.0.0/8 to any port 22 proto tcp`).
 */
export function ufwRuleCovers(rule: string, port: number, proto: "tcp" | "udp"): UfwCoverage {
  const none = { covers: false, limitedSource: false, rateLimited: false };
  const words = rule.trim().split(/\s+/);
  const action = words.shift();
  if (action !== "allow" && action !== "limit") return none;
  if (words[0] === "in") words.shift();
  if (words[0] === "out") return none;
  const rateLimited = action === "limit";
  if (!words.includes("from") && !words.includes("to") && !words.includes("on")) {
    const spec = words.join(" ");
    if (words.length !== 1) return none;
    const covers = SSH_NAMES.has(spec.toLowerCase())
      ? port === 22 && proto === "tcp"
      : portSpecCovers(spec, port, proto);
    return { covers, limitedSource: false, rateLimited };
  }
  const after = (key: string, from = 0) => {
    const index = words.indexOf(key, from);
    return index >= 0 ? words[index + 1] : undefined;
  };
  const ruleProto = after("proto");
  if (ruleProto !== undefined && ruleProto !== proto) return none;
  const toIndex = words.indexOf("to");
  const destPort = toIndex >= 0 ? after("port", toIndex) : undefined;
  const app = toIndex >= 0 ? after("app", toIndex) : undefined;
  let covers: boolean;
  if (destPort !== undefined) covers = portSpecCovers(destPort, port, proto);
  else if (app !== undefined) covers = SSH_NAMES.has(app.toLowerCase()) && port === 22;
  else covers = true; // no destination port: every port
  const fromIndex = words.indexOf("from");
  const source = fromIndex >= 0 ? words[fromIndex + 1] : undefined;
  // `from X port N`: only connections from that source port.
  const sourcePort = fromIndex >= 0 && words[fromIndex + 2] === "port";
  const destination = toIndex >= 0 ? words[toIndex + 1] : undefined;
  // A source address or port, a destination address other than `any`, or an interface
  // (`on eth0`) narrows the rule: it does not open the port to every address.
  const limitedSource =
    (source !== undefined && source !== "any") ||
    sourcePort ||
    (destination !== undefined && destination !== "any") ||
    words.includes("on");
  return { covers, limitedSource, rateLimited };
}

/**
 * True when a `docker ps` ports column publishes host `port`; on a non-loopback address only,
 * unless `anyAddress` is set.
 */
export function publishesPort(ports: string, port: number, anyAddress = false): boolean {
  return ports.split(",").some((mapping) => {
    const match = /^\s*(.*):(\d+)(?:-(\d+))?->/.exec(mapping);
    if (!match) return false;
    const low = Number(match[2]);
    const high = match[3] ? Number(match[3]) : low;
    return port >= low && port <= high && (anyAddress || !isLoopback(match[1] ?? ""));
  });
}

/** Lines `name:uid:pw|nopw:keys|nokeys` from the users snippet. */
export function parseUsers(text: string): HostFacts["loginUsers"] {
  return linesOf(text).flatMap((line) => {
    const [name, uid, pw, keys] = line.split(":");
    const id = Number.parseInt(uid ?? "", 10);
    if (!name || !Number.isInteger(id)) return [];
    return [{ name, uid: id, password: pw === "pw", keys: keys === "keys" }];
  });
}

/** An app name as the inspection prints it (the app name pattern; anything else is skipped). */
const APP_NAME_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;

/**
 * Lines `<path> absent|link|other` or `<path> dir <owner> <group> <mode> <entries>`: the shared
 * folders and the runners' parent, always listed (absent when not printed), then the apps'
 * folders in `/srv/apps` and `/srv/data` that exist, sorted by path.
 */
export function parseDirs(text: string): DirFact[] {
  const shared: readonly string[] = [...SHARED_DIRS, RUNNERS_DIR];
  const found = new Map<string, DirFact>();
  for (const line of linesOf(text)) {
    const [path, kind, owner, group, mode, entries] = line.split(/\s+/);
    if (!path) continue;
    const parent = path.slice(0, path.lastIndexOf("/"));
    const child =
      (parent === APPS_DIR || parent === DATA_DIR) &&
      APP_NAME_RE.test(path.slice(parent.length + 1));
    if (!shared.includes(path) && !child) continue;
    if (kind === "dir") {
      found.set(path, {
        path,
        kind: "dir",
        owner: owner ?? "",
        group: group ?? "",
        mode: mode ?? "",
        entries: Number.parseInt(entries ?? "0", 10) || 0,
      });
    } else if (kind === "link" || kind === "other" || (kind === "absent" && !child)) {
      found.set(path, { path, kind });
    }
  }
  const children = [...found.keys()].filter((path) => !shared.includes(path)).sort();
  return [
    ...shared.map((path) => found.get(path) ?? { path, kind: "absent" as const }),
    ...children.map((path) => found.get(path) as DirFact),
  ];
}

/**
 * The runtime files section: `<app> <name> file <owner> <group> <mode> <sha256|->`,
 * `<app> <name> link`, `<app> <name> other` or `<app> <name> absent`, for every file of
 * {@link RUNTIME_FILE_NAMES} in each app's folder, then for each service's `<service>.env` found
 * there. A checksum is kept only for the rendered files, never for a file that holds secrets.
 * Sorted by app, each app with every file of {@link RUNTIME_FILE_NAMES}, then its services' env
 * files by name.
 */
export function parseRuntimeFiles(text: string): RuntimeFileFact[] {
  const found = new Map<string, Map<RuntimeFileName, RuntimeFileFact>>();
  const names: readonly string[] = RUNTIME_FILE_NAMES;
  const hashed: readonly string[] = HASHED_RUNTIME_FILES;
  for (const line of linesOf(text)) {
    const [app, name, kind, owner, group, mode, sum] = line.split(/\s+/);
    if (!app || !APP_NAME_RE.test(app) || !name) continue;
    if (!names.includes(name) && !ServiceEnvFileSchema.safeParse(name).success) continue;
    const files = found.get(app) ?? new Map<RuntimeFileName, RuntimeFileFact>();
    found.set(app, files);
    const key = name as RuntimeFileName;
    if (kind === "file") {
      const sha256 =
        hashed.includes(name) && sum !== undefined && /^[0-9a-f]{64}$/.test(sum) ? sum : null;
      files.set(key, {
        app,
        name: key,
        kind: "file",
        owner: owner ?? "",
        group: group ?? "",
        mode: mode ?? "",
        sha256,
      });
    } else if (kind === "link" || kind === "other" || kind === "absent") {
      files.set(key, { app, name: key, kind, sha256: null });
    }
  }
  return [...found.keys()].sort().flatMap((app) => {
    const files = found.get(app) ?? new Map<RuntimeFileName, RuntimeFileFact>();
    const services = [...files.keys()].filter((name) => !names.includes(name)).sort();
    return [
      ...RUNTIME_FILE_NAMES.map(
        (name) => files.get(name) ?? { app, name, kind: "absent" as const, sha256: null },
      ),
      ...services.flatMap((name) => files.get(name) ?? []),
    ];
  });
}

/** The sysctl section: `live <key> <value>` and `file <key> <value>` lines, by key. */
export function parseSysctl(text: string): HostFacts["sysctl"] {
  const sysctl: HostFacts["sysctl"] = { live: {}, file: {} };
  for (const line of linesOf(text)) {
    const [where, key, value] = line.split(/\s+/);
    if ((where !== "live" && where !== "file") || !key || !/^\d+$/.test(value ?? "")) continue;
    sysctl[where][key] = Number(value);
  }
  return sysctl;
}

/**
 * The apps section: `<name> <the record's JSON on one line>` per file in /etc/opscrew/apps,
 * sorted by name. A record that is not valid, or names another app, is null (damaged).
 */
export function parseAppRecords(text: string): HostFacts["apps"] {
  const apps = new Map<string, AppRecord | null>();
  for (const line of linesOf(text)) {
    const space = line.indexOf(" ");
    const name = space < 0 ? line : line.slice(0, space);
    if (!APP_NAME_RE.test(name)) continue;
    let record: AppRecord | null = null;
    try {
      const parsed = AppRecordSchema.safeParse(JSON.parse(line.slice(space + 1)));
      if (parsed.success && parsed.data.app === name) record = parsed.data;
    } catch {
      record = null;
    }
    apps.set(name, record);
  }
  return [...apps.keys()].sort().map((name) => ({ name, record: apps.get(name) ?? null }));
}

/** The `flags` line of /proc/cpuinfo (x86) lists `avx`. */
export function parseAvx(text: string): boolean {
  const flags = /^flags\s*:(.*)$/m.exec(text)?.[1] ?? "";
  return flags.trim().split(/\s+/).includes("avx");
}

/** `apt-config dump` lines: both periodic settings are "1". */
export function parseAptPeriodic(text: string): boolean {
  const lines = linesOf(text);
  const value = (key: string) =>
    lines
      .filter((line) => line.startsWith(`${key} `))
      .map((line) => /"([^"]*)"/.exec(line)?.[1])
      .pop();
  return (
    value("APT::Periodic::Update-Package-Lists") === "1" &&
    value("APT::Periodic::Unattended-Upgrade") === "1"
  );
}

/** Interfaces whose addresses never reach the server from outside (container bridges, VPNs). */
const VIRTUAL_INTERFACE =
  /^(docker\d*|br-|veth|cni|flannel|cali|virbr|lxcbr|lxdbr|tailscale|wg|zt)/;

/**
 * True for an IPv4 or IPv6 address other machines on the internet can reach: not private,
 * loopback, link-local, shared (100.64.0.0/10) or in 0.0.0.0/8.
 */
export function isPublicAddress(address: string): boolean {
  if (address.includes(":")) {
    const lower = address.toLowerCase();
    return !(
      lower === "::1" ||
      /^f[cd][0-9a-f]{2}:/.test(lower) ||
      /^fe[89ab][0-9a-f]:/.test(lower)
    );
  }
  const [a = 0, b = 0] = address.split(".").map(Number);
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254)
  );
}

/** `ip -o addr show scope global`: global addresses of real interfaces. */
export function parseAddresses(text: string): HostFacts["addresses"] {
  const found: HostFacts["addresses"] = [];
  for (const line of linesOf(text)) {
    const match = /^\d+:\s+(\S+?)(?:@\S+)?\s+(inet6?)\s+([0-9a-fA-F.:]+)\//.exec(line);
    if (!match?.[1] || !match[2] || !match[3]) continue;
    if (VIRTUAL_INTERFACE.test(match[1])) continue;
    found.push({
      interface: match[1],
      family: match[2] === "inet" ? "ipv4" : "ipv6",
      address: match[3],
      public: isPublicAddress(match[3]),
    });
  }
  return found;
}

interface AddonLine {
  /** Its Compose file is there (`kept`: only its folder, with its data). */
  installed: boolean;
  composeSha256: string | null;
  secretFile: boolean;
  tunnelId: string | null;
}

/**
 * Lines `<addon> absent` or `<addon> installed|kept <sha256 of compose.yaml or -> <secret or data
 * yes|no> <tunnel id or ->`.
 */
export function parseAddons(text: string): Map<string, AddonLine> {
  const addons = new Map<string, AddonLine>();
  for (const line of linesOf(text)) {
    const [name, state, sum, secret, id] = line.split(/\s+/);
    if (!name || (state !== "installed" && state !== "kept")) continue;
    addons.set(name, {
      installed: state === "installed",
      composeSha256: sum && /^[0-9a-f]{64}$/.test(sum) ? sum : null,
      secretFile: secret === "yes",
      tunnelId: id && /^[0-9A-Fa-f-]{8,64}$/.test(id) ? id : null,
    });
  }
  return addons;
}

/**
 * The runners section: `<app> <yes|no> <systemctl is-active> <version|-> <label|-> <url|->
 * <unit sha256|->` for each app's runner (see `RUNNERS_SNIPPET`).
 */
export function parseRunners(text: string): RunnerFact[] {
  return linesOf(text).flatMap((line) => {
    const [app, registered, state, version, label, url, unit] = line.split(/\s+/);
    if (!app || !registered) return [];
    return [
      {
        app,
        registered: registered === "yes",
        active: state === "active",
        unitCurrent: unit === sha256Hex(runnerUnitText(app)),
        version: version && /^\d+\.\d+\.\d+$/.test(version) ? version : null,
        label: label && /^opscrew-[a-z0-9-]+$/.test(label) ? label : null,
        repositoryUrl:
          url && /^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(url) ? url : null,
      },
    ];
  });
}

/** The filter table of `iptables-save` (or `ip6tables-save`) output: its chain and rule lines. */
function filterTable(save: string): string[] {
  const lines: string[] = [];
  let inFilter = false;
  for (const line of linesOf(save)) {
    if (line.startsWith("*")) inFilter = line === "*filter";
    else if (line === "COMMIT") inFilter = false;
    else if (inFilter) lines.push(line);
  }
  return lines;
}

/**
 * OpsCrew's chain (`OPSCREW-WEB`) from `iptables-save` output: the networks that pass
 * (`-s <net> -j RETURN`, as {@link canonicalIpv4Cidr} gives them), whether the last rule drops
 * the rest, and how many other rules it has; null when the chain does not exist.
 */
export function parseWebFilterChain(save: string): WebFilterRules["chain"] {
  const lines = filterTable(save);
  if (!lines.some((line) => line.startsWith(":OPSCREW-WEB "))) return null;
  const rules = lines.filter((line) => line.startsWith("-A OPSCREW-WEB "));
  const sources: string[] = [];
  let other = 0;
  rules.forEach((line, index) => {
    const pass = /^-A OPSCREW-WEB -s (\S+) -j RETURN$/.exec(line);
    const network = pass?.[1] ? canonicalIpv4Cidr(pass[1]) : null;
    if (network !== null) sources.push(network);
    else if (!(index === rules.length - 1 && line === "-A OPSCREW-WEB -j DROP")) other += 1;
  });
  return { sources, dropsRest: rules.at(-1) === "-A OPSCREW-WEB -j DROP", other };
}

/** The connections the web filter guards, as `<proto>/<port>`. */
export const WEB_FILTER_PORTS = ["tcp/80", "tcp/443", "udp/443"] as const;

/** A `DOCKER-USER` rule that sends new connections to a published port to OpsCrew's chain. */
function webFilterJump(line: string): string | null {
  if (!line.startsWith("-A DOCKER-USER ") || !/ -j OPSCREW-WEB$/.test(line)) return null;
  const proto = / -p (tcp|udp)\b/.exec(line)?.[1];
  const port = / --ctorigdstport (\d{1,5})\b/.exec(line)?.[1];
  if (!/ --ctstate DNAT\b/.test(line) || !/ --ctdir ORIGINAL\b/.test(line)) return null;
  return proto && port ? `${proto}/${port}` : null;
}

/**
 * `DOCKER-USER` from `iptables-save` output: whether it exists, the `<proto>/<port>` of OpsCrew's
 * jumps that come before any other rule, and how many of OpsCrew's jumps it has.
 */
export function parseDockerUserChain(save: string): WebFilterRules["dockerUser"] {
  const lines = filterTable(save);
  if (!lines.some((line) => line.startsWith(":DOCKER-USER "))) {
    return { exists: false, leading: [], jumps: 0 };
  }
  const rules = lines.filter((line) => line.startsWith("-A DOCKER-USER "));
  const leading: string[] = [];
  for (const line of rules) {
    const jump = webFilterJump(line);
    if (jump === null) break;
    leading.push(jump);
  }
  return {
    exists: true,
    leading,
    jumps: rules.filter((line) => line.endsWith(" -j OPSCREW-WEB")).length,
  };
}

function ipv4Value(address: string): number | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(part) || Number(part) > 255) return null;
    value = value * 256 + Number(part);
  }
  return value;
}

/**
 * An IPv4 network in the form iptables prints it, so OpsCrew finds its rules again: host bits
 * cleared and no `/32` suffix. Null when `text` is not an IPv4 address or network.
 */
export function canonicalIpv4Cidr(text: string): string | null {
  const [address = "", prefixText, extra] = text.trim().split("/");
  if (extra !== undefined) return null;
  if (prefixText !== undefined && !/^\d{1,3}$/.test(prefixText)) return null;
  const value = ipv4Value(address);
  const prefix = prefixText === undefined ? 32 : Number(prefixText);
  if (value === null || prefix > 32) return null;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const network = (value & mask) >>> 0;
  const dotted = [24, 16, 8, 0].map((shift) => (network >>> shift) & 255).join(".");
  return prefix === 32 ? dotted : `${dotted}/${prefix}`;
}

/** The 128-bit value of an IPv6 address in hex groups (no embedded IPv4, no zone), or null. */
function ipv6Value(address: string): bigint | null {
  const halves = address.split("::");
  if (halves.length > 2) return null;
  const groups = (part: string | undefined) => (part ? part.split(":") : []);
  const head = groups(halves[0]);
  const tail = groups(halves[1]);
  if (![...head, ...tail].every((group) => /^[0-9A-Fa-f]{1,4}$/.test(group))) return null;
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const all = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  return all.reduce((value, group) => (value << 16n) | BigInt(Number.parseInt(group, 16)), 0n);
}

/** An IPv6 address as glibc's inet_ntop prints it (and nft): lower case, the longest zero run `::`. */
function ipv6Text(value: bigint): string {
  const groups = Array.from({ length: 8 }, (_, i) =>
    Number((value >> BigInt(112 - 16 * i)) & 0xffffn),
  );
  let best = { start: 0, length: 0 };
  for (let start = 0; start < 8; start += 1) {
    let end = start;
    while (end < 8 && groups[end] === 0) end += 1;
    if (end - start > best.length) best = { start, length: end - start };
  }
  const hex = groups.map((group) => group.toString(16));
  if (best.length < 2) return hex.join(":");
  const head = hex.slice(0, best.start).join(":");
  const tail = hex.slice(best.start + best.length).join(":");
  return `${head}::${tail}`;
}

/**
 * An SSH source (`harden.firewall.sshFrom` of a runner machine) in the form nft prints it, so
 * OpsCrew finds its rules again: an IPv4 or IPv6 address or network, host bits cleared, without
 * `/32` or `/128`. Null for anything else, for `/0` (every address), and for IPv6 addresses whose
 * first 80 bits are zero (IPv4-mapped and other special forms, which nft prints differently).
 */
export function canonicalSshSource(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.includes(":")) {
    const network = canonicalIpv4Cidr(trimmed);
    return network === null || network.endsWith("/0") ? null : network;
  }
  const [address = "", prefixText, extra] = trimmed.split("/");
  if (extra !== undefined) return null;
  if (prefixText !== undefined && !/^\d{1,3}$/.test(prefixText)) return null;
  const value = ipv6Value(address);
  const prefix = prefixText === undefined ? 128 : Number(prefixText);
  if (value === null || prefix < 1 || prefix > 128) return null;
  const network = (value >> BigInt(128 - prefix)) << BigInt(128 - prefix);
  if (network >> 48n === 0n) return null;
  const printed = ipv6Text(network);
  return prefix === 128 ? printed : `${printed}/${prefix}`;
}

/** The IPv4 or IPv6 `address` is in `network` (a source as {@link canonicalSshSource} gives it). */
export function networkHolds(network: string, address: string): boolean {
  const [base = "", prefixText] = network.split("/");
  const v6 = base.includes(":");
  if (v6 !== address.includes(":")) return false;
  const bits = v6 ? 128 : 32;
  const value = (text: string) => {
    if (v6) return ipv6Value(text);
    const v4 = ipv4Value(text);
    return v4 === null ? null : BigInt(v4);
  };
  const want = value(base);
  const have = value(address);
  if (want === null || have === null) return false;
  const shift = BigInt(bits - (prefixText === undefined ? bits : Number(prefixText)));
  return have >> shift === want >> shift;
}
