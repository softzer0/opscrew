/**
 * Network helpers of the own-server live test (`own-server.test.ts`): the throwaway Hetzner server
 * it creates outside OpsCrew, the Cloudflare resources OpsCrew creates for the app (listed, and
 * removed only when this run created them), GitHub pull requests and workflow runs, TCP and HTTPS
 * probes, and root SSH to the server with the test's own key. Nothing here prints; the test masks
 * everything it logs.
 */
import { Resolver } from "node:dns";
import { request as nodeHttpsRequest } from "node:https";
import { connect, type LookupFunction } from "node:net";
import type { CommandResult, CommandRunner } from "@opscrew/contracts";
import { type HetznerServerType, hetznerIpv6Address, serverCandidates } from "./own-support";

export const HETZNER_API = "https://api.hetzner.cloud/v1";
export const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";
export const GITHUB_API = "https://api.github.com";

export const minutes = (n: number) => n * 60_000;
export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** An API answer: the HTTP status and the parsed JSON body (`undefined` when empty or not JSON). */
export interface ApiResult {
  status: number;
  json: unknown;
}

/** A bearer-token JSON API call. Never throws for an HTTP error status; the caller checks it. */
export async function api(
  base: string,
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResult> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: base === GITHUB_API ? "application/vnd.github+json" : "application/json",
      "User-Agent": "opscrew-e2e",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: response.status, json };
}

/** Retries a delete for up to a minute until it succeeds or the thing is gone (404). */
export async function retryDelete(request: () => Promise<{ status: number }>): Promise<boolean> {
  for (let attempt = 0; attempt < 12; attempt++) {
    const deleted = await request();
    if (deleted.status < 300 || deleted.status === 404) return true;
    await sleep(5_000);
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// Hetzner: the throwaway server, created outside OpsCrew and always deleted by the test.

/** The throwaway server the test treats as the user's own. */
export interface ThrowawayServer {
  id: number;
  name: string;
  serverType: string;
  location: string;
  hourlyGross: number;
  ipv4: string;
  /** The server's own IPv6 address (`…::1` of its `/64`), when it has one. */
  ipv6?: string;
  /** The `/64` network, without the length. */
  ipv6Network?: string;
}

/** Labels on everything the test creates at Hetzner; cleanup deletes only `run=<runId>`. */
export function hetznerLabels(runId: string): Record<string, string> {
  return { "managed-by": "opscrew-e2e", run: runId };
}

/**
 * Creates the throwaway server: uploads the test's public key, then tries the cheapest x86 server
 * types in the nearby locations until Hetzner accepts one (Ubuntu 24.04, IPv4 and IPv6), and waits
 * until it runs. `onKey` and `onServer` record the ids at once, so cleanup finds them even when a
 * later step fails.
 */
export async function createThrowawayServer(options: {
  token: string;
  runId: string;
  publicKey: string;
  locations: readonly string[];
  forcedType?: string;
  onKey: (id: number) => void;
  onServer: (id: number) => void;
  log: (message: string) => void;
}): Promise<ThrowawayServer> {
  const hetzner = (method: string, path: string, body?: unknown) =>
    api(HETZNER_API, options.token, method, path, body);
  const name = `opscrew-e2e-own-${options.runId}`;
  const labels = hetznerLabels(options.runId);

  const key = await hetzner("POST", "/ssh_keys", {
    name,
    public_key: options.publicKey,
    labels,
  });
  const keyId = (key.json as { ssh_key?: { id: number } } | undefined)?.ssh_key?.id;
  if (key.status !== 201 || keyId === undefined) {
    throw new Error(`Hetzner refused the test's SSH key (HTTP ${key.status}).`);
  }
  options.onKey(keyId);

  const types = await hetzner("GET", "/server_types?per_page=50");
  const list = (types.json as { server_types?: HetznerServerType[] } | undefined)?.server_types;
  if (types.status !== 200 || list === undefined) {
    throw new Error(`Could not list Hetzner server types (HTTP ${types.status}).`);
  }
  const candidates = serverCandidates(list, options.locations, options.forcedType).slice(0, 8);
  if (candidates.length === 0) {
    throw new Error(
      `No x86 server type${options.forcedType ? ` named ${options.forcedType}` : ""} is offered in ${options.locations.join(", ")}.`,
    );
  }
  const refusals: string[] = [];
  for (const candidate of candidates) {
    options.log(
      `creating a ${candidate.serverType} server in ${candidate.location} (${candidate.hourlyGross.toFixed(4)} EUR an hour)`,
    );
    const created = await hetzner("POST", "/servers", {
      name,
      server_type: candidate.serverType,
      image: "ubuntu-24.04",
      location: candidate.location,
      ssh_keys: [keyId],
      labels,
      public_net: { enable_ipv4: true, enable_ipv6: true },
      start_after_create: true,
    });
    const server = (created.json as { server?: { id: number } } | undefined)?.server;
    if (created.status === 201 && server !== undefined) {
      options.onServer(server.id);
      return { ...(await waitUntilRunning(hetzner, server.id, options.log)), name, ...candidate };
    }
    const error = (created.json as { error?: { code?: string } } | undefined)?.error?.code;
    refusals.push(`${candidate.serverType} in ${candidate.location}: ${error ?? created.status}`);
  }
  throw new Error(`Hetzner created no server: ${refusals.join("; ")}.`);
}

async function waitUntilRunning(
  hetzner: (method: string, path: string) => Promise<ApiResult>,
  id: number,
  log: (message: string) => void,
): Promise<{ id: number; ipv4: string; ipv6?: string; ipv6Network?: string }> {
  log("waiting for the server to run (up to 5 minutes)");
  const deadline = Date.now() + minutes(5);
  while (Date.now() < deadline) {
    const got = await hetzner("GET", `/servers/${id}`);
    const server = (
      got.json as
        | {
            server?: {
              status: string;
              public_net: { ipv4?: { ip: string } | null; ipv6?: { ip: string } | null };
            };
          }
        | undefined
    )?.server;
    const ipv4 = server?.public_net.ipv4?.ip;
    if (server?.status === "running" && ipv4 !== undefined) {
      const network = server.public_net.ipv6?.ip;
      return {
        id,
        ipv4,
        ...(network === undefined
          ? {}
          : {
              ipv6: hetznerIpv6Address(network),
              ipv6Network: network.replace(/\/\d+$/, ""),
            }),
      };
    }
    await sleep(5_000);
  }
  throw new Error("The throwaway server did not reach the running state within 5 minutes.");
}

/**
 * Deletes the throwaway server and SSH key: the known ids plus anything labelled with this run
 * (never anything else), then checks that nothing with the run's label is left. Returns problems.
 */
export async function deleteThrowaway(options: {
  token: string;
  runId: string;
  serverId?: number;
  keyId?: number;
}): Promise<string[]> {
  const hetzner = (method: string, path: string) => api(HETZNER_API, options.token, method, path);
  const selector = encodeURIComponent(`managed-by=opscrew-e2e,run=${options.runId}`);
  const problems: string[] = [];
  for (const kind of ["servers", "ssh_keys"] as const) {
    const listed = await hetzner("GET", `/${kind}?label_selector=${selector}`);
    const ids = new Set(
      ((listed.json as Record<string, { id: number }[]> | undefined)?.[kind] ?? []).map(
        (item) => item.id,
      ),
    );
    const known = kind === "servers" ? options.serverId : options.keyId;
    if (known !== undefined) ids.add(known);
    for (const id of ids) {
      if (!(await retryDelete(() => hetzner("DELETE", `/${kind}/${id}`)))) {
        problems.push(`Hetzner did not delete ${kind} ${id}`);
      }
    }
    // A deleted server can be listed for a little while as Hetzner removes it: wait up to 2 minutes.
    let remaining: { id: number }[] = [];
    for (let attempt = 0; attempt < 12; attempt++) {
      const left = await hetzner("GET", `/${kind}?label_selector=${selector}`);
      if (left.status !== 200) {
        remaining = [{ id: -1 }];
      } else {
        remaining = (left.json as Record<string, { id: number }[]> | undefined)?.[kind] ?? [];
        if (remaining.length === 0) break;
      }
      await sleep(10_000);
    }
    if (remaining.length > 0) {
      const what = kind === "servers" ? "server(s)" : "SSH key(s)";
      problems.push(
        `${remaining.length} ${what} labelled run=${options.runId} may be left; check the Hetzner project`,
      );
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// Cloudflare: what OpsCrew creates for the app, found by name (see modules/cloudflare-*).

/** The Cloudflare zone of the test hostname and its account. */
export interface CloudflareZone {
  id: string;
  name: string;
  accountId: string;
}

interface Named {
  id: string;
  name: string;
}

/** Everything OpsCrew may have created in Cloudflare for the app. */
export interface CloudflareAppResources {
  records: (Named & { type: string })[];
  tunnels: Named[];
  apps: Named[];
  policies: Named[];
  serviceTokens: Named[];
  /**
   * Every ruleset of the zone (any name), so the snapshot before the run holds them all;
   * `undefined` when the token could not list them (then none is ever deleted).
   */
  rulesets?: ZoneRuleset[];
}

/** A zone ruleset as Cloudflare lists it (the list has no rules; the single read has them). */
export interface ZoneRuleset {
  id: string;
  name: string;
  kind?: string;
  phase?: string;
  rules?: { expression?: string }[];
}

/** The entrypoint phases of the `cloudflare-dns` module's rulesets. */
const OPSCREW_RULESET_PHASES = new Set(["http_config_settings", "http_request_firewall_custom"]);

/** The hostnames a rule expression matches on: `http.host in {"a" "b"}` and `http.host eq "a"`. */
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

/**
 * Whether a zone ruleset is one the `cloudflare-dns` module renders for this run: a zone
 * entrypoint of its phases, named `OpsCrew …`, with at least one rule, and every rule's expression
 * matching on hostnames that are all the run's. Anything else (the user's rulesets, another app's,
 * a rule for the whole zone) is never this run's.
 */
export function rulesetOfRun(ruleset: Omit<ZoneRuleset, "id">, hostnames: readonly string[]) {
  if (ruleset.kind !== "zone" || !OPSCREW_RULESET_PHASES.has(ruleset.phase ?? "")) return false;
  if (!ruleset.name.startsWith("OpsCrew ")) return false;
  const rules = ruleset.rules ?? [];
  if (rules.length === 0) return false;
  const ours = new Set(hostnames.map((host) => host.toLowerCase()));
  return rules.every((rule) => {
    const hosts = expressionHosts(rule.expression ?? "");
    return hosts.length > 0 && hosts.every((host) => ours.has(host));
  });
}

/** A Cloudflare API client for one token. */
export class Cloudflare {
  constructor(private readonly token: string) {}

  call(method: string, path: string, body?: unknown): Promise<ApiResult> {
    return api(CLOUDFLARE_API, this.token, method, path, body);
  }

  /** Every result of a paginated list (`page`, `per_page`, `result_info.total_pages`). */
  async list<T>(path: string): Promise<T[]> {
    const results: T[] = [];
    for (let page = 1; page <= 50; page++) {
      const separator = path.includes("?") ? "&" : "?";
      const got = await this.call("GET", `${path}${separator}page=${page}&per_page=50`);
      const body = got.json as
        | { success?: boolean; result?: T[]; result_info?: { total_pages?: number } }
        | undefined;
      if (got.status !== 200 || body?.success !== true) {
        throw new Error(
          `Cloudflare refused to list ${path.split("?")[0]} (HTTP ${got.status}); check the token's permissions in docs/e2e.md.`,
        );
      }
      results.push(...(body.result ?? []));
      const pages = body.result_info?.total_pages;
      if (pages === undefined || page >= pages) break;
    }
    return results;
  }

  /** The zone that holds `hostname` (the longest matching zone name). */
  async zoneOf(hostname: string): Promise<CloudflareZone> {
    const labels = hostname.replace(/\.$/, "").split(".");
    for (let i = 0; i < labels.length - 1; i++) {
      const name = labels.slice(i).join(".");
      const zones = await this.list<{ id: string; name: string; account: { id: string } }>(
        `/zones?name=${encodeURIComponent(name)}`,
      );
      const zone = zones.find((z) => z.name === name);
      if (zone !== undefined) return { id: zone.id, name: zone.name, accountId: zone.account.id };
    }
    throw new Error(`No Cloudflare zone of this token holds ${hostname}.`);
  }

  /**
   * What OpsCrew creates for `app` (modules/cloudflare-dns, -tunnel and -access): DNS records on
   * `hostnames`, the tunnel `opscrew-<app>`, the Access applications and policies
   * `OpsCrew SSH|Portainer|deploy (<app>)`, the service token `OpsCrew deploy (<app>)` and the
   * zone's rulesets (all of them, for the snapshot; `removeCreated` deletes only the run's). Never
   * the Zero Trust organization.
   */
  async appResources(
    zone: CloudflareZone,
    app: string,
    hostnames: readonly string[],
  ): Promise<CloudflareAppResources> {
    const records = (
      await this.list<Named & { type: string }>(`/zones/${zone.id}/dns_records`)
    ).filter((record) => hostnames.includes(record.name));
    const account = `/accounts/${zone.accountId}`;
    const tunnels = await this.list<Named>(
      `${account}/cfd_tunnel?is_deleted=false&name=${encodeURIComponent(`opscrew-${app}`)}`,
    );
    const appNames = [`OpsCrew SSH (${app})`, `OpsCrew Portainer (${app})`];
    const policyNames = [`OpsCrew deploy (${app})`, `OpsCrew Portainer (${app})`];
    const apps = (await this.list<Named>(`${account}/access/apps`)).filter((a) =>
      appNames.includes(a.name),
    );
    const policies = (await this.list<Named>(`${account}/access/policies`)).filter((p) =>
      policyNames.includes(p.name),
    );
    const serviceTokens = (await this.list<Named>(`${account}/access/service_tokens`)).filter(
      (t) => t.name === `OpsCrew deploy (${app})`,
    );
    const listed = await this.call("GET", `/zones/${zone.id}/rulesets`);
    const rulesets = (listed.json as { success?: boolean; result?: ZoneRuleset[] } | undefined)
      ?.result;
    return {
      records,
      tunnels: tunnels.filter((t) => t.name === `opscrew-${app}`),
      apps,
      policies,
      serviceTokens,
      ...(listed.status === 200 && Array.isArray(rulesets) ? { rulesets } : {}),
    };
  }

  /**
   * Deletes the resources in `now` whose ids are not in `before` (so only what this run created):
   * Access applications, then policies and service tokens, then DNS records, then the zone's
   * OpsCrew rulesets whose rules name only the run's `hostnames` (`rulesetOfRun`; each deleted one
   * is logged by name), then tunnels (their connections first). Returns what could not be deleted.
   */
  async removeCreated(
    zone: CloudflareZone,
    now: CloudflareAppResources,
    before: CloudflareAppResources,
    run: { hostnames: readonly string[]; log: (message: string) => void },
  ): Promise<string[]> {
    const fresh = <T extends Named>(items: T[], old: T[]) =>
      items.filter((item) => !old.some((o) => o.id === item.id));
    const account = `/accounts/${zone.accountId}`;
    const problems: string[] = [];
    const remove = async (what: string, path: string) => {
      if (!(await retryDelete(() => this.call("DELETE", path)))) problems.push(what);
    };
    for (const app of fresh(now.apps, before.apps)) {
      await remove(`Access application "${app.name}"`, `${account}/access/apps/${app.id}`);
    }
    for (const policy of fresh(now.policies, before.policies)) {
      await remove(`Access policy "${policy.name}"`, `${account}/access/policies/${policy.id}`);
    }
    for (const token of fresh(now.serviceTokens, before.serviceTokens)) {
      await remove(`service token "${token.name}"`, `${account}/access/service_tokens/${token.id}`);
    }
    for (const record of fresh(now.records, before.records)) {
      await remove(
        `DNS ${record.type} record ${record.name}`,
        `/zones/${zone.id}/dns_records/${record.id}`,
      );
    }
    problems.push(...(await this.removeRulesetsOfRun(zone, now, before, run)));
    for (const tunnel of fresh(now.tunnels, before.tunnels)) {
      await this.call("DELETE", `${account}/cfd_tunnel/${tunnel.id}/connections`);
      await remove(`tunnel "${tunnel.name}"`, `${account}/cfd_tunnel/${tunnel.id}`);
    }
    return problems;
  }

  /**
   * The zone rulesets this run created (absent from `before`, `rulesetOfRun` on their rules),
   * deleted and logged by name. Without a listing before the run nothing is deleted.
   */
  private async removeRulesetsOfRun(
    zone: CloudflareZone,
    now: CloudflareAppResources,
    before: CloudflareAppResources,
    run: { hostnames: readonly string[]; log: (message: string) => void },
  ): Promise<string[]> {
    if (before.rulesets === undefined) return [];
    if (now.rulesets === undefined) return ["the zone's rulesets (Cloudflare did not list them)"];
    const old = new Set(before.rulesets.map((ruleset) => ruleset.id));
    const problems: string[] = [];
    for (const listed of now.rulesets) {
      if (old.has(listed.id) || !listed.name.startsWith("OpsCrew ")) continue;
      const path = `/zones/${zone.id}/rulesets/${listed.id}`;
      const read = await this.call("GET", path);
      const ruleset = (read.json as { result?: ZoneRuleset } | undefined)?.result;
      if (read.status !== 200 || ruleset === undefined) {
        problems.push(`ruleset "${listed.name}" (Cloudflare did not show its rules)`);
        continue;
      }
      if (!rulesetOfRun(ruleset, run.hostnames)) continue;
      if (await retryDelete(() => this.call("DELETE", path))) {
        run.log(`deleted the zone ruleset "${listed.name}" this run created`);
      } else {
        problems.push(`ruleset "${listed.name}"`);
      }
    }
    return problems;
  }
}

// ---------------------------------------------------------------------------------------------
// GitHub: the throwaway repository's pull requests and deploy runs.

/** A GitHub API client for the throwaway repository. */
export class GitHubRepo {
  constructor(
    private readonly token: string,
    readonly name: string,
  ) {}

  call(method: string, path: string, body?: unknown): Promise<ApiResult> {
    return api(GITHUB_API, this.token, method, path, body);
  }

  /**
   * GETs `path` and reads the plain text it redirects to (a job's log answers with a redirect to
   * a signed URL on another host). The token goes only to the API, never to the redirected host.
   * `text` is empty unless `status` is 200; callers must not print it (it may hold masked values).
   */
  async redirectedText(
    path: string,
    fetchImpl: typeof fetch = fetch,
  ): Promise<{ status: number; text: string }> {
    const first = await fetchImpl(`${GITHUB_API}${path}`, {
      method: "GET",
      redirect: "manual",
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "opscrew-e2e",
      },
    });
    const location = first.headers.get("location");
    if (first.status < 300 || first.status >= 400 || location === null) {
      const text = await first.text();
      return { status: first.status, text: first.status === 200 ? text : "" };
    }
    await first.body?.cancel();
    const second = await fetchImpl(new URL(location, GITHUB_API).toString(), {
      method: "GET",
      headers: { "User-Agent": "opscrew-e2e" },
    });
    const text = await second.text();
    return { status: second.status, text: second.status === 200 ? text : "" };
  }

  /** Closes every open pull request and deletes every branch but `main` (as live.test.ts does). */
  async reset(): Promise<void> {
    const pulls = await this.call("GET", `/repos/${this.name}/pulls?state=open&per_page=100`);
    for (const pull of (pulls.json as { number: number }[] | undefined) ?? []) {
      await this.call("PATCH", `/repos/${this.name}/pulls/${pull.number}`, { state: "closed" });
    }
    const branches = await this.call("GET", `/repos/${this.name}/branches?per_page=100`);
    for (const branch of (branches.json as { name: string }[] | undefined) ?? []) {
      if (branch.name === "main") continue;
      const ref = branch.name.split("/").map(encodeURIComponent).join("/");
      await this.call("DELETE", `/repos/${this.name}/git/refs/heads/${ref}`);
    }
  }

  /** The open pull request from `head` (a branch of this repository), if there is one. */
  async openPullRequest(head: string): Promise<number | undefined> {
    const [owner] = this.name.split("/");
    const list = await this.call(
      "GET",
      `/repos/${this.name}/pulls?state=open&head=${owner}:${encodeURIComponent(head)}`,
    );
    return (list.json as { number: number }[] | undefined)?.[0]?.number;
  }

  /**
   * Squash-merges pull request `number` once GitHub has computed its mergeability (it refuses a
   * merge with 405 until then) and returns the merge commit on `main`.
   */
  async merge(number: number): Promise<string> {
    for (let attempt = 0; attempt < 12; attempt++) {
      const state = await this.call("GET", `/repos/${this.name}/pulls/${number}`);
      if ((state.json as { mergeable?: boolean | null } | undefined)?.mergeable === true) break;
      await sleep(5_000);
    }
    let merged: ApiResult = { status: 0, json: undefined };
    for (let attempt = 0; attempt < 4; attempt++) {
      merged = await this.call("PUT", `/repos/${this.name}/pulls/${number}/merge`, {
        merge_method: "squash",
      });
      if (merged.status !== 405) break;
      await sleep(5_000);
    }
    const sha = (merged.json as { sha?: string } | undefined)?.sha;
    if (merged.status !== 200 || sha === undefined) {
      throw new Error(`GitHub did not merge pull request #${number} (HTTP ${merged.status}).`);
    }
    return sha;
  }

  /** Starts the deploy workflow on `main` (`workflow_dispatch`). */
  async dispatchDeploy(): Promise<void> {
    const started = await this.call(
      "POST",
      `/repos/${this.name}/actions/workflows/opscrew-deploy.yml/dispatches`,
      { ref: "main" },
    );
    if (started.status !== 204) {
      throw new Error(`GitHub did not start the deploy workflow (HTTP ${started.status}).`);
    }
  }

  /**
   * Waits for the deploy workflow run of `headSha` (and `event`, created at or after `since`) to
   * complete and returns it with its jobs' conclusions. A run of an earlier pass never counts.
   */
  async waitForDeploy(
    filter: { headSha: string; event?: string; since?: Date },
    timeoutMs = minutes(30),
  ): Promise<{
    id: number;
    conclusion: string | null;
    jobs: { name: string; conclusion: string | null }[];
  }> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const runs = await this.call(
        "GET",
        `/repos/${this.name}/actions/workflows/opscrew-deploy.yml/runs?head_sha=${filter.headSha}&per_page=20`,
      );
      const run = (
        runs.json as
          | {
              workflow_runs?: {
                id: number;
                event: string;
                status: string;
                conclusion: string | null;
                created_at: string;
              }[];
            }
          | undefined
      )?.workflow_runs?.find(
        (item) =>
          (filter.event === undefined || item.event === filter.event) &&
          (filter.since === undefined ||
            new Date(item.created_at).getTime() >= filter.since.getTime() - 5_000),
      );
      if (run?.status === "completed") {
        const jobs = await this.call("GET", `/repos/${this.name}/actions/runs/${run.id}/jobs`);
        const list =
          (jobs.json as { jobs?: { name: string; conclusion: string | null }[] } | undefined)
            ?.jobs ?? [];
        return {
          id: run.id,
          conclusion: run.conclusion,
          jobs: list.map((job) => ({ name: job.name, conclusion: job.conclusion })),
        };
      }
      await sleep(20_000);
    }
    throw new Error(`The deploy workflow run did not finish within ${timeoutMs / 60_000} minutes.`);
  }

  /** Title and body of every pull request opened at or after `since`. */
  async pullRequestTexts(since: Date): Promise<{ number: number; text: string }[]> {
    const texts: { number: number; text: string }[] = [];
    for (let page = 1; page <= 20; page++) {
      const pulls = await this.call(
        "GET",
        `/repos/${this.name}/pulls?state=all&per_page=100&page=${page}`,
      );
      if (pulls.status !== 200)
        throw new Error(`Could not list pull requests (HTTP ${pulls.status}).`);
      const list = pulls.json as {
        number: number;
        title: string;
        body: string | null;
        created_at: string;
      }[];
      for (const pull of list) {
        if (new Date(pull.created_at) >= since) {
          texts.push({ number: pull.number, text: `${pull.title}\n${pull.body ?? ""}` });
        }
      }
      if (list.length < 100) break;
    }
    return texts;
  }
}

// ---------------------------------------------------------------------------------------------
// Probes from this computer.

/** True when a TCP connection to `host:port` is established within `timeoutMs`. */
export function canConnect(host: string, port: number, timeoutMs = 5_000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

const publicResolver = new Resolver();
publicResolver.setServers(["1.1.1.1", "1.0.0.1"]);

/** The IPv4 addresses of `hostname` from Cloudflare's public resolver (no local cache). */
export function resolveIpv4(hostname: string): Promise<string[]> {
  return new Promise((resolve) => {
    publicResolver.resolve4(hostname, (error, addresses) => resolve(error ? [] : addresses));
  });
}

/** `dns.lookup` through Cloudflare's public resolver (IPv4 only), for `https.request`. */
const publicLookup = ((
  hostname: string,
  options: { all?: boolean },
  callback: (error: Error | null, address?: unknown, family?: number) => void,
) => {
  publicResolver.resolve4(hostname, (error, addresses) => {
    const first = addresses?.[0];
    if (error || first === undefined) {
      callback(error ?? new Error("the name has no IPv4 address"));
    } else if (options.all === true) {
      callback(
        null,
        addresses.map((address) => ({ address, family: 4 })),
      );
    } else {
      callback(null, first, 4);
    }
  });
}) as unknown as LookupFunction;

/** An HTTPS answer: status, headers and body. */
export interface HttpsAnswer {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/**
 * An HTTPS request. Names are resolved through Cloudflare's public resolver (so a just-changed
 * DNS record is seen at once), except `localhost`. `insecure` accepts a self-signed certificate
 * and is allowed only for `localhost` (Portainer through the SSH tunnel). Rejects on network
 * errors and after `timeoutMs`.
 */
export function httpsRequest(
  url: string,
  options: {
    method?: string;
    body?: string;
    headers?: Record<string, string>;
    insecure?: boolean;
    timeoutMs?: number;
  } = {},
): Promise<HttpsAnswer> {
  const target = new URL(url);
  const local = target.hostname === "localhost" || target.hostname === "127.0.0.1";
  if (options.insecure === true && !local) {
    throw new Error("Only localhost may be reached without checking its certificate.");
  }
  return new Promise((resolve, reject) => {
    const req = nodeHttpsRequest(
      target,
      {
        method: options.method ?? "GET",
        headers: { "User-Agent": "opscrew-e2e", ...options.headers },
        rejectUnauthorized: options.insecure !== true,
        timeout: options.timeoutMs ?? 15_000,
        ...(local ? {} : { lookup: publicLookup }),
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          if (body.length < 100_000) body += chunk;
        });
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body }),
        );
        response.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("The request timed out.")));
    req.on("error", reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

/**
 * Polls `check` every `intervalMs` until it returns a value, or throws after `timeoutMs` naming
 * `what` (a function is called only then, so it can say what was seen by that time) and the last
 * error `check` threw (an error only means "not yet"). `abort` is asked before each try: a message
 * from it stops the wait at once (for example when the process being waited for has exited).
 */
export async function waitFor<T>(
  what: string | (() => string),
  timeoutMs: number,
  check: () => Promise<T | undefined>,
  intervalMs = 10_000,
  abort?: () => string | undefined,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: string | undefined;
  for (;;) {
    const stop = abort?.();
    if (stop !== undefined) throw new Error(stop);
    const value = await check().catch((error: unknown) => {
      last = error instanceof Error ? error.message : String(error);
      return undefined;
    });
    if (value !== undefined) return value;
    if (Date.now() >= deadline) {
      const name = typeof what === "function" ? what() : what;
      const time =
        timeoutMs >= 60_000 ? `${Math.round(timeoutMs / 60_000)} minutes` : `${timeoutMs} ms`;
      throw new Error(
        `Gave up after ${time}: ${name}.${last === undefined ? "" : ` Last problem: ${last}`}`,
      );
    }
    await sleep(intervalMs);
  }
}

// ---------------------------------------------------------------------------------------------
// Root SSH to the throwaway server with the test's own key.

/** Root's SSH login on the throwaway server, as the user would use it. */
export class RootShell {
  constructor(
    private readonly runner: CommandRunner,
    private readonly options: {
      host: string;
      keyFile: string;
      knownHostsFile: string;
      env: Record<string, string | undefined>;
    },
  ) {}

  /** Runs `command` as root; resolves with the result (exit code 255: SSH itself failed). */
  run(command: string, timeoutMs = minutes(2)): Promise<CommandResult> {
    return this.runner.run(
      "ssh",
      [
        "-i",
        this.options.keyFile,
        "-o",
        "IdentitiesOnly=yes",
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        `UserKnownHostsFile=${this.options.knownHostsFile}`,
        "-o",
        "ConnectTimeout=15",
        "-o",
        "ServerAliveInterval=15",
        `root@${this.options.host}`,
        command,
      ],
      { env: this.options.env, timeoutMs },
    );
  }

  /** Runs `command` as root and returns its output; throws (with its stderr) when it fails. */
  async ok(command: string, timeoutMs = minutes(2)): Promise<string> {
    const result = await this.run(command, timeoutMs);
    if (result.exitCode !== 0) {
      throw new Error(
        `\`${command}\` as root failed (exit ${result.exitCode}): ${result.stderr.trim().slice(-500)}`,
      );
    }
    return result.stdout.trim();
  }
}
