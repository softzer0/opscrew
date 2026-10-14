/**
 * Parsers for the output of the fixed, read-only inspection commands. They never throw on odd
 * output: unknown lines are ignored and missing values fall back to "unknown" defaults, which
 * the planner treats conservatively.
 */
import type { DirFact, Listener } from "./facts";

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
export function parseOsRelease(text: string): {
  id: string;
  idLike: string;
  versionId: string;
  codename: string;
  prettyName: string;
} {
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
    idLike: (values.get("ID_LIKE") ?? "").toLowerCase(),
    versionId: values.get("VERSION_ID") ?? "",
    codename: values.get("UBUNTU_CODENAME") || values.get("VERSION_CODENAME") || "",
    prettyName: values.get("PRETTY_NAME") ?? "",
  };
}

function toNumber(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

/** `free -b`: total and available memory in bytes. */
export function parseFree(text: string): { total: number; available: number } {
  for (const line of linesOf(text)) {
    if (!line.startsWith("Mem:")) continue;
    const cols = line.split(/\s+/);
    // Mem: total used free shared buff/cache available
    return { total: toNumber(cols[1]), available: toNumber(cols[6] ?? cols[3]) };
  }
  return { total: 0, available: 0 };
}

/** `df -P -B1 /`: size and available bytes of the root filesystem. */
export function parseDf(text: string): { size: number; available: number } {
  const rows = linesOf(text).filter((line) => !line.startsWith("Filesystem"));
  const cols = rows[rows.length - 1]?.split(/\s+/) ?? [];
  return { size: toNumber(cols[1]), available: toNumber(cols[3]) };
}

export interface SshdSettings {
  ports: number[];
  passwordAuthentication: boolean;
  kbdInteractiveAuthentication: boolean;
  permitRootLogin: string;
  authenticationMethods: string;
  allowUsers: string[];
  allowGroups: string[];
  denyUsers: string[];
  denyGroups: string[];
  authorizedKeysCommand: boolean;
  /** `yes`, `all`, `local`, `remote` or `no` (global value, without Match blocks). */
  allowTcpForwarding: string;
}

/** `sshd -T`: the effective settings OpsCrew cares about; null when the output is unusable. */
export function parseSshdT(text: string): SshdSettings | null {
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
  return {
    ports: [...new Set(ports)].sort((a, b) => a - b),
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
export function parseUfwAdded(text: string): { rule: string; comment: string | null }[] {
  const rules: { rule: string; comment: string | null }[] = [];
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

/** Docker Engine version from a Debian package version (`5:28.5.1-1~ubuntu.24.04~noble`). */
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
export function parseContainers(
  text: string,
): { name: string; project: string; ports: string; running: boolean }[] {
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
export function parseUfwDefaults(
  text: string,
): { incoming: string; outgoing: string; routed: string } | null {
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
export function parseUsers(
  text: string,
): { name: string; uid: number; password: boolean; keys: boolean }[] {
  return linesOf(text).flatMap((line) => {
    const [name, uid, pw, keys] = line.split(":");
    const id = Number.parseInt(uid ?? "", 10);
    if (!name || !Number.isInteger(id)) return [];
    return [{ name, uid: id, password: pw === "pw", keys: keys === "keys" }];
  });
}

/** Lines `<path> absent|link|other` or `<path> dir <owner> <group> <mode> <entries>`. */
export function parseDirs(text: string, paths: readonly string[]): DirFact[] {
  const found = new Map<string, DirFact>();
  for (const line of linesOf(text)) {
    const [path, kind, owner, group, mode, entries] = line.split(/\s+/);
    if (!path || !paths.includes(path)) continue;
    if (kind === "dir") {
      found.set(path, {
        path,
        kind: "dir",
        owner: owner ?? "",
        group: group ?? "",
        mode: mode ?? "",
        entries: Number.parseInt(entries ?? "0", 10) || 0,
      });
    } else if (kind === "link" || kind === "other" || kind === "absent") {
      found.set(path, { path, kind });
    }
  }
  return paths.map((path) => found.get(path) ?? { path, kind: "absent" });
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

/** True for an address other machines on the internet can reach (not private or link-local). */
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
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254)
  );
}

/** `ip -o addr show scope global`: global addresses of real interfaces. */
export function parseAddresses(
  text: string,
): { interface: string; family: "ipv4" | "ipv6"; address: string; public: boolean }[] {
  const found: { interface: string; family: "ipv4" | "ipv6"; address: string; public: boolean }[] =
    [];
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
  composeSha256: string | null;
  secretFile: boolean;
  tunnelId: string | null;
}

/**
 * Lines `<addon> absent` or `<addon> installed <sha256 of compose.yaml> <secret yes|no> <tunnel
 * id or ->`.
 */
export function parseAddons(text: string): Map<string, AddonLine> {
  const addons = new Map<string, AddonLine>();
  for (const line of linesOf(text)) {
    const [name, state, sum, secret, id] = line.split(/\s+/);
    if (!name || state !== "installed") continue;
    addons.set(name, {
      composeSha256: sum && /^[0-9a-f]{64}$/.test(sum) ? sum : null,
      secretFile: secret === "yes",
      tunnelId: id && /^[0-9A-Fa-f-]{8,64}$/.test(id) ? id : null,
    });
  }
  return addons;
}
