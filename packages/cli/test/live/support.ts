/**
 * Pure helpers of the live tests on a throwaway server (`own-server.test.ts`,
 * `portainer-target.test.ts`): their variables, reading plan hashes and checklists from CLI
 * output, choosing the throwaway Hetzner server, reading `ufw status` and `ss` output, splitting
 * the printed SSH tunnel command, OpsCrew's shared Cloudflare rules in the zone (feature 011) and
 * the cleanup's leftover decision, and masking the server's address and secrets in everything the
 * tests print. No network, no processes; the safety and leak helpers are unit-tested in
 * `support.test.ts`.
 */
import { parseKeyscan } from "@opscrew/agents";
import {
  SHARED_RULES,
  SharedRecordSchema,
  type SharedRuleRef,
} from "@opscrew/connector-cloudflare";
import { Redactor } from "@opscrew/core";

/** The variables both server live tests need besides their gate. */
export const SERVER_E2E_VARIABLES = [
  "OPSCREW_E2E_HCLOUD_TOKEN",
  "OPSCREW_E2E_GITHUB_REPO",
  "OPSCREW_E2E_GITHUB_TOKEN",
  "OPSCREW_E2E_CLOUDFLARE_TOKEN",
  "OPSCREW_E2E_DOMAIN",
] as const;

/** `gate=1` when the gate is not `1`, then every name in `names` that is not set. */
export function missingVariables(
  env: Record<string, string | undefined>,
  gate: string,
  names: readonly string[],
): string[] {
  return [
    ...(env[gate] === "1" ? [] : [`${gate}=1`]),
    ...names.filter((name) => (env[name] ?? "").trim() === ""),
  ];
}

/**
 * The run's own hostname, one level below the zone: `e2e-<runId>.<zone>`, or
 * `e2e-<runId>-<app>.<zone>` for the run's second app (`app` `b`). The zone is
 * `OPSCREW_E2E_DOMAIN` without its first label when it has more than two labels
 * (`e2e.example.com` → `example.com`), else `OPSCREW_E2E_DOMAIN` itself (already the apex). Each
 * run asks Let's Encrypt for a certificate on new names (it issues only 5 per week for the same
 * names), and one level below the zone stays under Cloudflare's free edge certificate (`*.<zone>`).
 */
export function runHostname(domain: string, runId: string, app?: string): string {
  const labels = domain.trim().toLowerCase().replace(/\.$/, "").split(".");
  const zone = labels.length > 2 ? labels.slice(1) : labels;
  const id = runId.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (id === "" || zone.some((label) => label === "")) {
    throw new Error(`Cannot derive a hostname for this run from "${domain}" and "${runId}".`);
  }
  return [`e2e-${id}${app === undefined ? "" : `-${app}`}`, ...zone].join(".");
}

// ---------------------------------------------------------------------------------------------
// OpsCrew's shared Cloudflare rules (contracts/cloudflare-shared.md of feature 011).

const SHARED_REFS = Object.keys(SHARED_RULES) as SharedRuleRef[];

/** A phase OpsCrew keeps one shared rule in. */
export type SharedPhase = (typeof SHARED_RULES)[SharedRuleRef]["phase"];

/**
 * A rule of a zone ruleset as Cloudflare's API returns it: the fields the tests read by name (it
 * holds more, all compared by {@link userRules}).
 */
export interface ZoneRule {
  id: string;
  ref?: string;
  description?: string;
  expression?: string;
  action?: string;
  action_parameters?: unknown;
  enabled?: boolean;
  /** Changed by Cloudflare on its own whenever the ruleset changes. */
  version?: string;
  last_updated?: string;
}

/** The zone's entrypoint ruleset of each of OpsCrew's phases; `undefined` where it has none. */
export type ZoneEntrypoints = Record<SharedPhase, { id: string; rules: ZoneRule[] } | undefined>;

/** The hostnames of OpsCrew's rule of each ref, sorted; `undefined` where there is no such rule. */
export type SharedHosts = Record<SharedRuleRef, string[] | undefined>;

/** The hostnames one app has in each of OpsCrew's shared rules. */
export type AppRules = Partial<Record<SharedRuleRef, readonly string[]>>;

/** The hostnames a rule expression matches on (`http.host in {"a" "b"}`, `http.host eq "a"`), lower case. */
function expressionHosts(expression: string): string[] {
  const hosts: string[] = [];
  for (const set of expression.matchAll(/http\.host\s+in\s+\{([^}]*)\}/g)) {
    for (const host of (set[1] ?? "").matchAll(/"([^"]*)"/g)) hosts.push(host[1] ?? "");
  }
  for (const one of expression.matchAll(/http\.host\s+(?:eq|==)\s+"([^"]*)"/g)) {
    hosts.push(one[1] ?? "");
  }
  return hosts.map((host) => host.toLowerCase());
}

const sortedUnique = (hosts: readonly string[]) =>
  [...new Set(hosts.map((host) => host.toLowerCase()))].sort();

const isShared = (rule: ZoneRule) => SHARED_REFS.includes(rule.ref as SharedRuleRef);

/** The hostnames OpsCrew's rule of each ref lists now (found by its `ref`, never by its name). */
export function sharedRuleHosts(entrypoints: ZoneEntrypoints): SharedHosts {
  const hosts = {} as SharedHosts;
  for (const ref of SHARED_REFS) {
    const rule = entrypoints[SHARED_RULES[ref].phase]?.rules.find((item) => item.ref === ref);
    hosts[ref] =
      rule === undefined ? undefined : sortedUnique(expressionHosts(rule.expression ?? ""));
  }
  return hosts;
}

/**
 * The zone's rules OpsCrew did not create, per phase and in their order, each as the JSON of the
 * whole rule Cloudflare returns, without only the `version` and `last_updated` it changes on its
 * own whenever the ruleset changes: two equal snapshots mean byte-identical rules in the same order.
 */
export function userRules(entrypoints: ZoneEntrypoints): Record<SharedPhase, string[]> {
  const snapshot = {} as Record<SharedPhase, string[]>;
  for (const ref of SHARED_REFS) {
    const { phase } = SHARED_RULES[ref];
    snapshot[phase] = (entrypoints[phase]?.rules ?? [])
      .filter((rule) => !isShared(rule))
      .map(({ version, last_updated, ...rest }) => JSON.stringify(rest));
  }
  return snapshot;
}

/**
 * What OpsCrew's rule of each ref must list with only one live test in the zone: the hostnames it
 * listed before the run plus each of the run's live apps' (`apps`), sorted; `undefined` (no rule)
 * when that is none. So "OpsCrew's rules are gone" is expected only of rules that listed no other
 * hostname before the run.
 */
export function expectedSharedHosts(before: SharedHosts, apps: readonly AppRules[]): SharedHosts {
  const expected = {} as SharedHosts;
  for (const ref of SHARED_REFS) {
    const hosts = sortedUnique([...(before[ref] ?? []), ...apps.flatMap((app) => app[ref] ?? [])]);
    expected[ref] = hosts.length > 0 ? hosts : undefined;
  }
  return expected;
}

/**
 * The shared rules an app's hostnames (its domain, and `www.` when it serves that too) belong in,
 * as the user guide says: the probe block for every app except one in a Portainer without the
 * Cloudflare Tunnel; strict TLS for every app except one served through a tunnel or in a Portainer.
 */
export function appRules(plan: {
  target: { provider: string; access?: string; web?: { mode: string } };
  dns: { provider: string; domain?: string | undefined; www: boolean };
}): AppRules {
  const { target, dns } = plan;
  if (dns.provider !== "cloudflare" || dns.domain === undefined) return {};
  const hosts = dns.www ? [dns.domain, `www.${dns.domain}`] : [dns.domain];
  if (target.provider === "portainer") {
    return target.web?.mode === "tunnel" ? { "opscrew-block-probes": hosts } : {};
  }
  if (target.provider === "own" && target.access === "tunnel") {
    return { "opscrew-block-probes": hosts };
  }
  return { "opscrew-block-probes": hosts, "opscrew-strict-tls": hosts };
}

/** The description of the rules of the user's own a run seeds, unique to the run. */
export function seededDescription(runId: string): string {
  return `OpsCrew E2E: a rule of the user's own, seeded by run ${runId}`;
}

/**
 * The leftover decision of the cleanup for one of the zone's entrypoint rulesets: the rules this
 * run seeded (described `seeded`, when it seeded any) go, and so does an OpsCrew rule (by `ref`)
 * that lists only the run's `hostnames`; one that lists them next to other hostnames is reported
 * and kept (the cleanup never edits a rule). The ruleset itself goes only when the run created it
 * and nothing is left in it.
 */
export function rulesCleanup(
  rules: readonly ZoneRule[],
  run: { hostnames: readonly string[]; seeded?: string; createdByRun: boolean },
): { deletes: { id: string; what: string }[]; problems: string[]; deleteEntrypoint: boolean } {
  const ours = new Set(run.hostnames.map((host) => host.toLowerCase()));
  const deletes: { id: string; what: string }[] = [];
  const problems: string[] = [];
  for (const rule of rules) {
    if (run.seeded !== undefined && rule.description === run.seeded) {
      deletes.push({ id: rule.id, what: "the rule of the user's own this run seeded" });
      continue;
    }
    if (!isShared(rule)) continue;
    const hosts = sortedUnique(expressionHosts(rule.expression ?? ""));
    const left = hosts.filter((host) => ours.has(host));
    if (left.length === 0) continue;
    if (left.length === hosts.length) {
      deletes.push({
        id: rule.id,
        what: `OpsCrew's rule ${rule.ref}, which still listed only this run's ${left.join(", ")}`,
      });
    } else {
      problems.push(
        `OpsCrew's rule ${rule.ref} still lists this run's ${left.join(", ")} next to other hostnames (not changed; remove them from its list in the Cloudflare dashboard)`,
      );
    }
  }
  return {
    deletes,
    problems,
    deleteEntrypoint: run.createdByRun && deletes.length === rules.length,
  };
}

/**
 * Whether an HTTP answer is Cloudflare's block page: HTTP 403 from Cloudflare's edge (`cf-ray`)
 * with the page's "you have been blocked", or its error 1020 or "access denied".
 */
export function blockedByCloudflare(answer: {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}): boolean {
  return (
    answer.status === 403 &&
    answer.headers["cf-ray"] !== undefined &&
    /you have been blocked|error code:?\s*1020|access denied/i.test(answer.body)
  );
}

/**
 * What is wrong with one version of `.opscrew/cloudflare.json` for the leak search: it must hold
 * only the zone's id, hostnames and phases (OpsCrew's schema, unknown keys refused), and none of
 * the `known` values. Names labels, never values.
 */
export function cloudflareRecordProblems(
  text: string,
  known: readonly { label: string; value: string }[],
): string[] {
  const problems: string[] = [];
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  if (!SharedRecordSchema.safeParse(json).success) {
    problems.push(".opscrew/cloudflare.json holds more than the zone's id, hostnames and phases");
  }
  const found = leakedLabels(text, known);
  if (found.length > 0) problems.push(`.opscrew/cloudflare.json contains: ${found.join(", ")}`);
  return problems;
}

/** Every distinct plan hash a run names with `--approve <hash>` (in order of appearance). */
export function approveHashes(output: string): string[] {
  const hashes: string[] = [];
  for (const [, hash] of output.matchAll(/--approve ([0-9a-f]{64})\b/g)) {
    if (hash !== undefined && !hashes.includes(hash)) hashes.push(hash);
  }
  return hashes;
}

/** The last hash a run showed after `<label>: ` (`Host plan hash`, `Stack plan hash`). */
export function printedHash(output: string, label: string): string | undefined {
  return [...output.matchAll(new RegExp(`${label}: ([0-9a-f]{64})\\b`, "g"))].at(-1)?.[1];
}

/** The sentence `--plan-only` prints under a plan that also needs the app's name. */
const REMOVAL_SENTENCE =
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

/** The Ed25519 key in `ssh-keyscan` output (`host ssh-ed25519 <base64>`), if the server sent one. */
export function ed25519FromKeyscan(output: string): string | undefined {
  for (const line of parseKeyscan(output)) {
    const [, type, key] = line.split(/\s+/);
    if (type === "ssh-ed25519" && key !== undefined) return key;
  }
  return undefined;
}

/** The fingerprint in `ssh-keygen -lf <file>` output (`256 SHA256:… comment (ED25519)`). */
export function fingerprintFromKeygen(output: string): string | undefined {
  return /\bSHA256:[A-Za-z0-9+/]{43}\b/.exec(output)?.[0];
}

/** The fields of a Hetzner server type (`GET /server_types`) the tests read. */
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

/** The `/64` prefix of a Hetzner IPv6 network in both written forms (`…::` and `…:`). */
export function ipv6PrefixForms(network: string): string[] {
  const prefix = network.replace(/\/\d+$/, "");
  return prefix.endsWith("::") ? [prefix, prefix.slice(0, -1)] : [prefix];
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
 * Masks the throwaway server's addresses and every secret the test knows (the private keys,
 * tokens, passwords) in text the test prints, then applies OpsCrew's redaction rules. Short values
 * (an IPv4 address can have 7 characters) are masked too, which the shared redactor skips on
 * purpose.
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

  /** The first value masked as `label`, or "" (for the few places the test must send one). */
  value(label: string): string {
    return this.entries().find((entry) => entry.label === label)?.value ?? "";
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

/**
 * The titles of the checks an `opscrew init` checklist marks as failed (`  ✗ <title> — <message>`),
 * in order. Warnings (`!`), passes and skips are not listed.
 */
export function failedInitChecks(output: string): string[] {
  const titles: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const title = /^\s*✗ (.+?) — /.exec(line)?.[1]?.trim();
    if (title !== undefined && title !== "") titles.push(title);
  }
  return titles;
}

/** Minutes and seconds in words (`3 min 5 s`). */
export function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}
