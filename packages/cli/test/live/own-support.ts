/**
 * Pure helpers of the own-server live test (`own-server.test.ts`): reading plan hashes from CLI
 * output, choosing the throwaway Hetzner server, reading `ufw status` and `ss` output, splitting
 * the printed SSH tunnel command and masking the server's address and secrets in everything the
 * test prints. No network, no processes; unit-tested in `own-server.test.ts`.
 */
import { createHash } from "node:crypto";
import { Redactor } from "@opscrew/core";

/** The variables the own-server live test needs; each missing one is named in the skip message. */
export const OWN_E2E_VARIABLES = [
  "OPSCREW_E2E_OWN_SERVER",
  "OPSCREW_E2E_HCLOUD_TOKEN",
  "OPSCREW_E2E_GITHUB_REPO",
  "OPSCREW_E2E_GITHUB_TOKEN",
  "OPSCREW_E2E_CLOUDFLARE_TOKEN",
  "OPSCREW_E2E_DOMAIN",
] as const;

/** The variables of {@link OWN_E2E_VARIABLES} that are not set (`OPSCREW_E2E_OWN_SERVER` must be `1`). */
export function missingVariables(env: Record<string, string | undefined>): string[] {
  return OWN_E2E_VARIABLES.filter((name) =>
    name === "OPSCREW_E2E_OWN_SERVER" ? env[name] !== "1" : (env[name] ?? "").trim() === "",
  ).map((name) => (name === "OPSCREW_E2E_OWN_SERVER" ? `${name}=1` : name));
}

/** Every distinct plan hash a run names with `--approve <hash>` (in order of appearance). */
export function approveHashes(output: string): string[] {
  const hashes: string[] = [];
  for (const [, hash] of output.matchAll(/--approve ([0-9a-f]{64})\b/g)) {
    if (hash !== undefined && !hashes.includes(hash)) hashes.push(hash);
  }
  return hashes;
}

/** The hash of the host plan a run showed (`Host plan hash: <hash>`), the last one when several. */
export function hostPlanHash(output: string): string | undefined {
  const all = [...output.matchAll(/Host plan hash: ([0-9a-f]{64})\b/g)];
  return all.at(-1)?.[1];
}

/** The SHA-256 fingerprint of an SSH public key blob (base64), as `ssh-keygen -l` prints it. */
export function sshFingerprint(keyBase64: string): string {
  const digest = createHash("sha256").update(Buffer.from(keyBase64, "base64")).digest("base64");
  return `SHA256:${digest.replace(/=+$/, "")}`;
}

/** The Ed25519 key in `ssh-keyscan` output (`host ssh-ed25519 <base64>`), if the server sent one. */
export function ed25519FromKeyscan(output: string): string | undefined {
  for (const line of output.split(/\r?\n/)) {
    const [, type, key] = line.trim().split(/\s+/);
    if (type === "ssh-ed25519" && key !== undefined && /^[A-Za-z0-9+/]+={0,3}$/.test(key)) {
      return key;
    }
  }
  return undefined;
}

/** The fingerprint in `ssh-keygen -lf <file>` output (`256 SHA256:… comment (ED25519)`). */
export function fingerprintFromKeygen(output: string): string | undefined {
  return /\bSHA256:[A-Za-z0-9+/]{43}\b/.exec(output)?.[0];
}

/** Hetzner locations near each interview region, nearest first. */
export const REGION_LOCATIONS: Readonly<Record<string, readonly string[]>> = {
  "eu-central": ["nbg1", "fsn1", "hel1"],
  "us-east": ["ash"],
  "us-west": ["hil"],
  "ap-southeast": ["sin"],
};

/** The fields of a Hetzner server type (`GET /server_types`) the test reads. */
export interface HetznerServerType {
  name: string;
  architecture: string;
  memory: number;
  deprecated?: boolean | null;
  deprecation?: unknown;
  prices: { location: string; price_hourly: { gross: string } }[];
}

/** A server type in a location, with its gross hourly price. */
export interface ServerCandidate {
  serverType: string;
  location: string;
  hourlyGross: number;
}

/**
 * The x86 server types that are not deprecated and have a price in one of `locations`, cheapest
 * first (then by location preference, then by name). `forced` keeps only that type.
 */
export function serverCandidates(
  types: readonly HetznerServerType[],
  locations: readonly string[],
  forced?: string,
): ServerCandidate[] {
  const candidates: (ServerCandidate & { rank: number })[] = [];
  for (const type of types) {
    if (type.architecture !== "x86") continue;
    if (type.deprecated === true || (type.deprecation ?? null) !== null) continue;
    if (forced !== undefined && type.name !== forced) continue;
    for (const price of type.prices) {
      const rank = locations.indexOf(price.location);
      const hourlyGross = Number(price.price_hourly.gross);
      if (rank === -1 || !Number.isFinite(hourlyGross)) continue;
      candidates.push({ serverType: type.name, location: price.location, hourlyGross, rank });
    }
  }
  candidates.sort(
    (a, b) =>
      a.hourlyGross - b.hourlyGross || a.rank - b.rank || a.serverType.localeCompare(b.serverType),
  );
  return candidates.map(({ serverType, location, hourlyGross }) => ({
    serverType,
    location,
    hourlyGross,
  }));
}

/** The server's own IPv6 address in a Hetzner `/64` network (`2001:db8:1:2::/64` → `…::1`). */
export function hetznerIpv6Address(network: string): string {
  return network.replace(/\/\d+$/, "").replace(/::$/, "::1");
}

/** `ufw status` read as rules: whether ufw is active and every allowed rule that is not SSH. */
export function ufwRulesBeyondSsh(
  status: string,
  sshPort = 22,
): { active: boolean; rules: number; others: string[] } {
  const active = /^Status:\s*active\s*$/m.test(status);
  const ssh = new Set([`${sshPort}/tcp`, `${sshPort}`, "OpenSSH"]);
  const others: string[] = [];
  let rules = 0;
  for (const line of status.split(/\r?\n/)) {
    const match = /^(.+?)\s{2,}(ALLOW|LIMIT|DENY|REJECT)(?: (IN|OUT|FWD))?\s{2,}(.+)$/.exec(
      line.trim(),
    );
    if (match === null) continue;
    const [, to = "", action = "", direction] = match;
    if (to === "To" || to.startsWith("--")) continue;
    rules++;
    if (action === "DENY" || action === "REJECT" || direction === "OUT") continue;
    const port = to.replace(/\s*\(v6\)$/, "").trim();
    if (direction === "FWD" || !ssh.has(port)) others.push(line.trim());
  }
  return { active, rules, others };
}

/**
 * The listening sockets on ports 80 and 443 that `ss -ltnuH` shows on IPv6 or on every address
 * (`[::]:80`, `*:443`, `[2001:db8::1]:80`); empty when the site is published on IPv4 only.
 */
export function webListenersBeyondIpv4(ss: string): string[] {
  const found: string[] = [];
  for (const line of ss.split(/\r?\n/)) {
    const local = line.trim().split(/\s+/)[4];
    if (local === undefined) continue;
    if (/^(\[[^\]]*\]|\*)(%[^:]+)?:(80|443)$/.test(local)) found.push(local);
  }
  return found;
}

/**
 * Splits a printed command line into its arguments: whitespace separates them, `"…"` groups
 * (with `\"` for a quote inside); backslashes elsewhere stay as they are (Windows paths).
 */
export function splitCommand(command: string): string[] {
  const args: string[] = [];
  let current = "";
  let started = false;
  let quoted = false;
  for (let i = 0; i < command.length; i++) {
    const char = command[i] as string;
    if (quoted) {
      if (char === "\\" && command[i + 1] === '"') {
        current += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
      } else {
        current += char;
      }
    } else if (char === '"') {
      quoted = true;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) args.push(current);
      current = "";
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (quoted) throw new Error("The command has an unclosed quote.");
  if (started) args.push(current);
  return args;
}

/**
 * Masks the throwaway server's addresses and every secret the test knows (the private keys, the
 * tunnel token, the Access service token, the Portainer password) in text the test prints, then
 * applies OpsCrew's redaction rules. Short values (an IPv4 address can have 7 characters) are
 * masked too, which the shared redactor skips on purpose.
 */
export class Scrubber {
  private readonly redactor = new Redactor();
  private readonly literals = new Map<string, string>();

  /** Masks `value` (trimmed; empty values are ignored) as `[<label>]` from now on. */
  add(value: string | undefined, label: string): void {
    const literal = value?.trim() ?? "";
    if (literal === "") return;
    this.literals.set(literal, `[${label}]`);
    this.redactor.addLiteral(literal, label);
    // Multi-line secrets (private keys) are also masked line by line.
    for (const line of literal.split(/\r?\n/)) {
      if (line.trim().length >= 16) this.literals.set(line.trim(), `[${label}]`);
    }
  }

  /** `text` with every known value masked. */
  readonly scrub = (text: string): string => {
    let out = text;
    const literals = [...this.literals].sort(([a], [b]) => b.length - a.length);
    for (const [literal, replacement] of literals) out = out.split(literal).join(replacement);
    return this.redactor.redact(out);
  };

  /** Every masked value with its label, for leak searches; print only the labels. */
  entries(): { label: string; value: string }[] {
    return [...this.literals].map(([value, label]) => ({ label: label.slice(1, -1), value }));
  }
}

/**
 * How many lines of CLI output name one of the server's `addresses` outside the mentions that show
 * it on purpose, on this computer only: `deploy@<address>` in the Portainer SSH tunnel command
 * (a line with `-L <port>:127.0.0.1:<port>`, also inside `--json`) and "server at <address>" or
 * "server at [<address>]" in the host key and reachability messages. Those mentions are cut out of
 * the line first; any address left in the rest counts. Never returns the lines themselves.
 */
export function addressLinesOutsidePurpose(output: string, addresses: readonly string[]): number {
  const longestFirst = [...addresses].filter((a) => a !== "").sort((a, b) => b.length - a.length);
  const known = longestFirst.map((value) => ({ label: "address", value }));
  let count = 0;
  for (const line of output.split(/\r?\n/)) {
    let rest = line;
    const tunnel = /-L \d+:127\.0\.0\.1:\d+ deploy@/.test(line);
    for (const address of longestFirst) {
      if (tunnel) rest = rest.split(`deploy@${address}`).join("deploy@");
      rest = rest.split(`server at [${address}]`).join("server at []");
      rest = rest.split(`server at ${address}`).join("server at ");
    }
    if (leakedLabels(rest, known).length > 0) count++;
  }
  return count;
}

/** The sentence T916's `--plan-only` prints under a plan that also needs the app's name. */
export const REMOVAL_SENTENCE =
  "This plan deletes or replaces resources, so applying it also needs the app's name";

/**
 * The approval a `provision --plan-only` output asks for when its plan deletes something (the
 * first apply of a switch to or from the tunnel): the hashes and app name from the printed
 * command (`opscrew provision --approve <hash> [--yes] --confirm <app>`). `undefined` when the
 * output has no such plan; throws when it has the sentence but no command to take them from.
 */
export function removalApproval(output: string): { hashes: string[]; app: string } | undefined {
  if (!output.includes(REMOVAL_SENTENCE)) return undefined;
  for (const line of output.split(/\r?\n/)) {
    const command = /^\s*opscrew provision (.*--confirm (\S+).*)$/.exec(line);
    const hashes = approveHashes(line);
    if (command?.[2] !== undefined && hashes.length > 0) return { hashes, app: command[2] };
  }
  throw new Error(`The plan needs the app's name, but there is no printed command with --confirm.`);
}

/** The `/64` prefix of a Hetzner IPv6 network in both written forms (`…::` and `…:`). */
export function ipv6PrefixForms(network: string): string[] {
  const prefix = network.replace(/\/\d+$/, "");
  return prefix.endsWith("::") ? [prefix, prefix.slice(0, -1)] : [prefix];
}

/**
 * The values of an env file (`NAME=value`, `export NAME="value"`; comments and blank lines
 * skipped) that are at least `minLength` characters long: shorter ones would match ordinary text.
 */
export function envFileValues(text: string, minLength = 8): string[] {
  const values: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.*)$/.exec(raw);
    if (match === null || raw.trim().startsWith("#")) continue;
    const value = (match[1] ?? "").trim().replace(/^(['"])(.*)\1$/, "$2");
    if (value.length >= minLength) values.push(value);
  }
  return values;
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * The labels of the known values that occur in `text` (never the values themselves). An IPv4
 * address counts only as a whole address (`10.1.2.3` is not found in `110.1.2.34`).
 */
export function leakedLabels(
  text: string,
  known: readonly { label: string; value: string }[],
): string[] {
  const occurs = (value: string) =>
    IPV4.test(value)
      ? new RegExp(`(?<![\\d.])${value.replaceAll(".", "\\.")}(?![\\d])`).test(text)
      : text.includes(value);
  const labels = known.filter(({ value }) => occurs(value)).map(({ label }) => label);
  return [...new Set(labels)];
}
