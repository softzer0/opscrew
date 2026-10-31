/**
 * Pure helpers of feature 018's live test (`split.test.ts`, docs/e2e.md "Split placement and the
 * private network"): its variables, the plan edits a user makes to place a service, and what the
 * test reads in OpsCrew's output (a link's state, design's estimate, the maintenance window, a
 * grant's connection details, the names a deletion needs typed), the device's configuration, the
 * firewalls' rules, the deploy pause variable and the run's outage. No network, no processes;
 * unit-tested in `split-support.test.ts`.
 */
import { posix } from "node:path";
import { sha256Hex } from "@opscrew/core";
import { parseDocument } from "yaml";

/** The test's gate. */
export const SPLIT_GATE = "OPSCREW_E2E_SPLIT";

/** What the pass needs besides its gate (the domain: the app is behind Cloudflare). */
export const SPLIT_VARIABLES = [
  "OPSCREW_E2E_HCLOUD_TOKEN",
  "OPSCREW_E2E_GITHUB_REPO",
  "OPSCREW_E2E_GITHUB_TOKEN",
  "OPSCREW_E2E_CLOUDFLARE_TOKEN",
  "OPSCREW_E2E_DOMAIN",
] as const;

/** The extra server's name in the plan (its resources are `<app>-data`). */
export const EXTRA_SERVER = "data";

/** The example's Postgres service (`examples/nextjs-postgres`). */
export const DATABASE = "db";

/** SC-1803: after a reboot the app answers again within 5 minutes. */
export const SC_1803_MS = 5 * 60_000;

/** SC-1804: a device reaches SSH on every server within a minute of bringing its tunnel up. */
export const SC_1804_MS = 60_000;

/**
 * `opscrew/plan.yaml`'s text with the service `service` placed on `server` (`undefined`: the
 * app's server, `services[].server` removed), and `added` in `servers` when no server of its name
 * is there yet, as a user edits the file. Comments and the order of keys are kept.
 * @throws Error when the plan has no service `service`.
 */
export function placeService(
  text: string,
  service: string,
  server: string | undefined,
  added?: { name: string; target?: Record<string, unknown> },
): string {
  const doc = parseDocument(text);
  const services = doc.toJS().services as { name?: string }[] | undefined;
  const index = (services ?? []).findIndex((entry) => entry.name === service);
  if (index < 0) throw new Error(`opscrew/plan.yaml has no service ${service}.`);
  if (server === undefined) doc.deleteIn(["services", index, "server"]);
  else doc.setIn(["services", index, "server"], server);
  if (added !== undefined) {
    const servers = (doc.toJS().servers ?? []) as { name?: string }[];
    if (!servers.some((entry) => entry.name === added.name)) {
      const entry = { name: added.name, ...(added.target ? { target: added.target } : {}) };
      if (doc.has("servers")) doc.addIn(["servers"], doc.createNode(entry));
      else doc.set("servers", doc.createNode([entry]));
    }
  }
  return doc.toString();
}

/**
 * The link from `from` to `to` in `opscrew status`' private network section (`  app to data: up,
 * last handshake …, round trip 0.6 ms`); `undefined` when the section has no such line.
 */
export function linkState(
  output: string,
  from: string,
  to: string,
): { up: boolean; roundTripMs?: number } | undefined {
  const line = new RegExp(`^\\s*${from} to ${to}: (up|down)\\b(.*)$`, "m").exec(output);
  if (line === null) return undefined;
  const ms = /round trip (\d+(?:\.\d+)?) ms/.exec(line[2] ?? "")?.[1];
  return { up: line[1] === "up", ...(ms === undefined ? {} : { roundTripMs: Number(ms) }) };
}

/** Design's estimated round trip of a query to the extra server (`waits about 2 ms`), in ms. */
export function estimatedRoundTrip(output: string): number | undefined {
  const ms = /waits about (\d+(?:\.\d+)?) ms/.exec(output)?.[1];
  return ms === undefined ? undefined : Number(ms);
}

/**
 * The maintenance window design or provision showed, in minutes: design's "maintenance window of
 * about 3 minutes" or the window approval's "about 3 minutes of downtime".
 */
export function windowMinutes(output: string): number | undefined {
  const match = /maintenance window of about (\d+) minutes|about (\d+) minutes of downtime/.exec(
    output,
  );
  const minutes = match?.[1] ?? match?.[2];
  return minutes === undefined ? undefined : Number(minutes);
}

/** The password and URL `opscrew vpn grant` printed once; `undefined` when it printed none. */
export function grantConnection(output: string): { password: string; url: string } | undefined {
  const password = /^\s*Password: (\S+)\s*$/m.exec(output)?.[1];
  const url = /URL for DBeaver and other graphical clients: (\S+)/.exec(output)?.[1];
  return password === undefined || url === undefined ? undefined : { password, url };
}

/** The device's private key in its WireGuard configuration (`PrivateKey = …`). */
export function devicePrivateKey(conf: string): string | undefined {
  return /^PrivateKey = (\S+)\s*$/m.exec(conf)?.[1];
}

/**
 * The CLI's project id for the repository at the POSIX path `root` (as `projectIdFor` makes it on
 * Linux): the folder under `OPSCREW_HOME/projects` the CLI in the device container reads, while
 * this computer's CLI reads the one of the repository's own path.
 */
export function containerProjectId(root: string): string {
  const slug = posix
    .basename(root)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${slug || "project"}-${sha256Hex(root).slice(0, 12)}`;
}

/**
 * The longest time the app did not answer in `samples` (in time order): from the first failed
 * sample of a run of failures to the next answer, or to the last sample while it still fails.
 */
export function longestOutage(samples: readonly { at: number; ok: boolean }[]): number {
  let longest = 0;
  let since: number | undefined;
  for (const sample of samples) {
    if (!sample.ok) {
      since ??= sample.at;
      longest = Math.max(longest, sample.at - since);
    } else if (since !== undefined) {
      longest = Math.max(longest, sample.at - since);
      since = undefined;
    }
  }
  return longest;
}

/** A cloud firewall's rule as Hetzner (`direction`, `port`) or DigitalOcean (`ports`) lists it. */
export interface FirewallRuleLike {
  direction?: string;
  protocol: string;
  port?: string | null;
  ports?: string;
}

/** The inbound rules as `<protocol>/<port>` (`icmp` alone), sorted, each once. */
export function firewallKeys(rules: readonly FirewallRuleLike[]): string[] {
  const keys = rules
    .filter((rule) => rule.direction === undefined || rule.direction === "in")
    .map((rule) =>
      rule.protocol === "icmp" ? "icmp" : `${rule.protocol}/${rule.port ?? rule.ports ?? ""}`,
    );
  return [...new Set(keys)].sort();
}

/**
 * When GitHub read `vars` in the deploy job's `if:`, from the job's conclusion in a run created
 * before the pause was set: skipped, so when the job started; run, so when the run was created.
 * `undefined` for any other conclusion (the run says nothing about it).
 */
export function pauseReadAt(
  conclusion: string | null,
): "when the job started" | "when the run was created" | undefined {
  if (conclusion === "skipped") return "when the job started";
  if (conclusion === "success") return "when the run was created";
  return undefined;
}

/** `OPSCREW_DEPLOY_PAUSED`'s value (`current`, OpsCrew's JSON) with the test's own entry `key`. */
export function pauseVariableWith(current: string | undefined, key: string, now: Date): string {
  const entries = current === undefined ? {} : (JSON.parse(current) as Record<string, unknown>);
  return JSON.stringify({ ...entries, [key]: { reason: "e2e", since: now.toISOString() } });
}

/**
 * The variable's value without the entry `key`: `undefined` when nothing else is left (delete the
 * variable), the value as it is when it is not JSON (left alone).
 */
export function pauseVariableWithout(current: string, key: string): string | undefined {
  let entries: Record<string, unknown>;
  try {
    entries = JSON.parse(current) as Record<string, unknown>;
  } catch {
    return current;
  }
  const { [key]: _ours, ...rest } = entries;
  return Object.keys(rest).length === 0 ? undefined : JSON.stringify(rest);
}

/** True when `measured` is within `factor` of `estimate` either way (SC-1808). */
export function withinFactor(estimate: number, measured: number, factor: number): boolean {
  return (
    measured > 0 && estimate > 0 && estimate / measured <= factor && measured / estimate <= factor
  );
}
