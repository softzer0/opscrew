/**
 * Network helpers of the live tests: the throwaway Hetzner server they create outside OpsCrew
 * (with its own SSH key and, for the Portainer test, a firewall), the Cloudflare resources OpsCrew
 * creates for an app (listed, and removed only when this run created them), the zone's two
 * entrypoint rulesets with OpsCrew's shared rules and the rules the test seeds as the user's, the
 * account's Zero Trust pieces, the throwaway GitHub repository, the deployed image's blobs in GHCR,
 * TCP and HTTP probes, and root SSH to the server with the test's own key. Nothing here prints; the
 * tests mask everything they log.
 */
import { Resolver } from "node:dns";
import { request as nodeHttpRequest } from "node:http";
import { request as nodeHttpsRequest } from "node:https";
import { connect, type LookupFunction } from "node:net";
import { SHARED_RULES } from "@opscrew/connector-cloudflare";
import type { CommandResult, CommandRunner } from "@opscrew/contracts";
import {
  type DeployJob,
  type HetznerServerType,
  hetznerIpv6Address,
  rulesCleanup,
  type SharedPhase,
  serverCandidates,
  type ZoneEntrypoints,
  type ZoneRule,
} from "./support";

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

/** One inbound rule of a Hetzner Cloud firewall. */
export interface FirewallRule {
  direction: "in";
  protocol: "tcp" | "udp";
  port: string;
  source_ips: string[];
  description: string;
}

/** The ids of what the test created at Hetzner, recorded at once so cleanup finds them. */
export interface HetznerIds {
  serverId?: number;
  keyId?: number;
  firewallId?: number;
}

/**
 * Creates the throwaway server `name`: its firewall first when `firewall` is given, then the
 * test's public key, then the cheapest x86 server types in the nearby locations until Hetzner
 * accepts one (Ubuntu 24.04, IPv4 and IPv6), and waits until it runs. Each id goes into `ids` as
 * soon as Hetzner returns it, so cleanup finds it even when a later step fails. Everything carries
 * the labels `managed-by=opscrew-e2e` and `run=<runId>`; cleanup deletes only those.
 */
export async function createThrowawayServer(options: {
  token: string;
  runId: string;
  name: string;
  publicKey: string;
  locations: readonly string[];
  forcedType?: string;
  firewall?: readonly FirewallRule[];
  ids: HetznerIds;
  log: (message: string) => void;
}): Promise<ThrowawayServer> {
  const hetzner = (method: string, path: string, body?: unknown) =>
    api(HETZNER_API, options.token, method, path, body);
  const { name } = options;
  const labels = { "managed-by": "opscrew-e2e", run: options.runId };

  if (options.firewall !== undefined) {
    const firewall = await hetzner("POST", "/firewalls", {
      name,
      labels,
      rules: options.firewall,
    });
    const firewallId = (firewall.json as { firewall?: { id: number } } | undefined)?.firewall?.id;
    if (firewall.status !== 201 || firewallId === undefined) {
      throw new Error(`Hetzner refused the test's firewall (HTTP ${firewall.status}).`);
    }
    options.ids.firewallId = firewallId;
  }

  const key = await hetzner("POST", "/ssh_keys", { name, public_key: options.publicKey, labels });
  const keyId = (key.json as { ssh_key?: { id: number } } | undefined)?.ssh_key?.id;
  if (key.status !== 201 || keyId === undefined) {
    throw new Error(`Hetzner refused the test's SSH key (HTTP ${key.status}).`);
  }
  options.ids.keyId = keyId;

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
      ...(options.ids.firewallId === undefined
        ? {}
        : { firewalls: [{ firewall: options.ids.firewallId }] }),
      labels,
      public_net: { enable_ipv4: true, enable_ipv6: true },
      start_after_create: true,
    });
    const server = (created.json as { server?: { id: number } } | undefined)?.server;
    if (created.status === 201 && server !== undefined) {
      options.ids.serverId = server.id;
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
          : { ipv6: hetznerIpv6Address(network), ipv6Network: network.replace(/\/\d+$/, "") }),
      };
    }
    await sleep(5_000);
  }
  throw new Error("The throwaway server did not reach the running state within 5 minutes.");
}

/**
 * Deletes the throwaway server, its SSH key and its firewall: the known ids plus anything
 * labelled with this run (never anything else), then checks that no server or key with the run's
 * label is left. The firewall goes last: Hetzner frees it only once the server is gone. Returns
 * problems.
 */
export async function deleteThrowaway(options: {
  token: string;
  runId: string;
  ids: HetznerIds;
}): Promise<string[]> {
  const hetzner = (method: string, path: string) => api(HETZNER_API, options.token, method, path);
  const selector = encodeURIComponent(`managed-by=opscrew-e2e,run=${options.runId}`);
  const labelled = async (kind: string) => {
    const listed = await hetzner("GET", `/${kind}?label_selector=${selector}`);
    return ((listed.json as Record<string, { id: number }[]> | undefined)?.[kind] ?? []).map(
      (item) => item.id,
    );
  };
  const problems: string[] = [];
  for (const kind of ["servers", "ssh_keys"] as const) {
    const ids = new Set(await labelled(kind));
    const known = kind === "servers" ? options.ids.serverId : options.ids.keyId;
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
  const firewalls = new Set(await labelled("firewalls"));
  if (options.ids.firewallId !== undefined) firewalls.add(options.ids.firewallId);
  for (const id of firewalls) {
    // A firewall stays "in use" for a little while after its server is deleted.
    let deleted = false;
    for (let attempt = 0; attempt < 3 && !deleted; attempt++) {
      deleted = await retryDelete(() => hetzner("DELETE", `/firewalls/${id}`));
    }
    if (!deleted) problems.push(`Hetzner did not delete firewall ${id}`);
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// Cloudflare: what OpsCrew creates for the app, found by name (see modules/cloudflare-*), and
// what several OpsCrew apps share (feature 011): the zone's rules by `ref`, the Zero Trust pieces.

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

/** Everything OpsCrew may have created in Cloudflare for the app (the shared rules are the zone's). */
export interface CloudflareAppResources {
  records: (Named & { type: string })[];
  tunnels: Named[];
  apps: Named[];
  policies: Named[];
  serviceTokens: Named[];
}

/** The account's Zero Trust pieces several OpsCrew apps share: never deleted by an app's destroy. */
export interface ZeroTrust {
  /** The organization's team domain, when the account has one. */
  organization?: string;
  /** The ids of the account's one-time PIN logins. */
  oneTimePins: string[];
}

/** A rule of the user's own the test seeds into one of OpsCrew's phases. */
export interface SeededRule {
  description: string;
  expression: string;
  action: string;
  action_parameters?: Record<string, unknown>;
  enabled: boolean;
}

const SHARED_PHASES = Object.values(SHARED_RULES).map((rule) => rule.phase);

/**
 * What of the app is still in Cloudflare after a destroy: every DNS record on its hostnames, and
 * the tunnels, Access applications, policies and service tokens that were not there before the
 * run (by name). All lists are empty when the destroy removed everything.
 */
export function cloudflareLeft(
  now: CloudflareAppResources,
  before: CloudflareAppResources,
): Record<string, string[]> {
  const fresh = (items: Named[], old: Named[]) =>
    items.filter((item) => !old.some((o) => o.id === item.id)).map((item) => item.name);
  return {
    records: now.records.map((record) => `${record.type} ${record.name}`),
    tunnels: fresh(now.tunnels, before.tunnels),
    apps: fresh(now.apps, before.apps),
    policies: fresh(now.policies, before.policies),
    serviceTokens: fresh(now.serviceTokens, before.serviceTokens),
  };
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
   * What OpsCrew creates for `app` on a server or in a Portainer (modules/cloudflare-dns, -tunnel
   * and -access): DNS records on `hostnames`, the tunnels `opscrew-<app>` and
   * `opscrew-<app>-portainer`, the Access applications `OpsCrew SSH|Portainer|Portainer webhook
   * (<app>)`, the policies `OpsCrew deploy|Portainer (<app>)` and the service token `OpsCrew deploy
   * (<app>)`. Never the shared rules or the Zero Trust organization.
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
    const tunnels: Named[] = [];
    for (const name of [`opscrew-${app}`, `opscrew-${app}-portainer`]) {
      const found = await this.list<Named>(
        `${account}/cfd_tunnel?is_deleted=false&name=${encodeURIComponent(name)}`,
      );
      tunnels.push(...found.filter((tunnel) => tunnel.name === name));
    }
    const appNames = [
      `OpsCrew SSH (${app})`,
      `OpsCrew Portainer (${app})`,
      `OpsCrew Portainer webhook (${app})`,
    ];
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
    return { records, tunnels, apps, policies, serviceTokens };
  }

  /**
   * Deletes the resources in `now` whose ids are not in `before` (so only what this run created):
   * Access applications, then policies and service tokens, then DNS records, then tunnels (their
   * connections first). Returns what could not be deleted.
   */
  async removeCreated(
    zone: CloudflareZone,
    now: CloudflareAppResources,
    before: CloudflareAppResources,
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
    for (const tunnel of fresh(now.tunnels, before.tunnels)) {
      await this.call("DELETE", `${account}/cfd_tunnel/${tunnel.id}/connections`);
      await remove(`tunnel "${tunnel.name}"`, `${account}/cfd_tunnel/${tunnel.id}`);
    }
    return problems;
  }

  /**
   * The zone's entrypoint rulesets of OpsCrew's two phases with their rules, as Cloudflare
   * returns them; a phase without one (HTTP 404) is `undefined`. Throws on any other answer.
   */
  async sharedEntrypoints(zone: CloudflareZone): Promise<ZoneEntrypoints> {
    const entrypoints = {} as ZoneEntrypoints;
    for (const phase of SHARED_PHASES) {
      const read = await this.call("GET", `/zones/${zone.id}/rulesets/phases/${phase}/entrypoint`);
      const result = (read.json as { result?: { id?: string; rules?: ZoneRule[] } } | undefined)
        ?.result;
      if (read.status === 404) {
        entrypoints[phase] = undefined;
      } else if (read.status === 200 && typeof result?.id === "string") {
        entrypoints[phase] = { id: result.id, rules: result.rules ?? [] };
      } else {
        throw new Error(
          `Cloudflare did not show the zone's ${phase} rules (HTTP ${read.status}); check the token's Zone WAF and Config Rules permissions in docs/e2e.md.`,
        );
      }
    }
    return entrypoints;
  }

  /**
   * Adds `rule`, as a user would, to the zone's entrypoint ruleset of `phase`: appended with
   * `POST …/rules` when the zone has one, or the entrypoint created with only that rule (`PUT`)
   * when Cloudflare answers 404.
   */
  async seedRule(zone: CloudflareZone, phase: SharedPhase, rule: SeededRule): Promise<void> {
    const entrypoint = `/zones/${zone.id}/rulesets/phases/${phase}/entrypoint`;
    const read = await this.call("GET", entrypoint);
    const id = (read.json as { result?: { id?: string } } | undefined)?.result?.id;
    const written =
      read.status === 404
        ? await this.call("PUT", entrypoint, { rules: [rule] })
        : read.status === 200 && id !== undefined
          ? await this.call("POST", `/zones/${zone.id}/rulesets/${id}/rules`, rule)
          : read;
    if (written.status !== 200) {
      const message = (written.json as { errors?: { message?: string }[] } | undefined)?.errors?.[0]
        ?.message;
      throw new Error(
        `Cloudflare did not take the test's own rule in ${phase} (HTTP ${written.status}${message ? `: ${message.slice(0, 200)}` : ""}).`,
      );
    }
  }

  /**
   * The cleanup of the zone's two entrypoint rulesets (`rulesCleanup`): deletes the rules this run
   * seeded (described `seeded`, when it seeded any) and OpsCrew's rules (by `ref`) that list only
   * the run's `hostnames`, each logged, then a ruleset that was not there before the run (`before`)
   * when a fresh read finds it empty. Returns problems: an OpsCrew rule listing the run's hostnames
   * next to others, a ruleset of the run that holds a rule again, and what Cloudflare did not
   * delete.
   */
  async removeRulesOfRun(
    zone: CloudflareZone,
    before: ZoneEntrypoints,
    run: { hostnames: readonly string[]; seeded?: string; log: (message: string) => void },
  ): Promise<string[]> {
    const now = await this.sharedEntrypoints(zone);
    const problems: string[] = [];
    for (const phase of SHARED_PHASES) {
      const entrypoint = now[phase];
      if (entrypoint === undefined) continue;
      const decision = rulesCleanup(entrypoint.rules, {
        hostnames: run.hostnames,
        ...(run.seeded === undefined ? {} : { seeded: run.seeded }),
        createdByRun: before[phase] === undefined,
      });
      problems.push(...decision.problems);
      const ruleset = `/zones/${zone.id}/rulesets/${entrypoint.id}`;
      for (const rule of decision.deletes) {
        if (await retryDelete(() => this.call("DELETE", `${ruleset}/rules/${rule.id}`))) {
          run.log(`deleted ${rule.what} (${phase})`);
        } else {
          problems.push(`${rule.what} (${phase}): Cloudflare did not delete it`);
        }
      }
      if (!decision.deleteEntrypoint) continue;
      // Read again: a rule added since the first read keeps the ruleset.
      const left = (await this.sharedEntrypoints(zone))[phase];
      if (left === undefined) continue;
      if (left.rules.length > 0) {
        problems.push(
          `the zone's ${phase} ruleset, which this run created, holds ${left.rules.length} rule(s) that appeared during the cleanup (not deleted)`,
        );
      } else if (await retryDelete(() => this.call("DELETE", ruleset))) {
        run.log(`deleted the zone's ${phase} ruleset, which this run created`);
      } else {
        problems.push(`the zone's ${phase} ruleset, which this run created`);
      }
    }
    return problems;
  }

  /**
   * The account's Zero Trust organization and one-time PIN logins (none when Cloudflare answers
   * 404); any other answer than 200 throws.
   */
  async zeroTrust(accountId: string): Promise<ZeroTrust> {
    const account = `/accounts/${accountId}/access`;
    const organization = await this.call("GET", `${account}/organizations`);
    if (organization.status === 404) return { oneTimePins: [] };
    if (organization.status !== 200) {
      throw new Error(
        `Cloudflare did not show the account's Zero Trust organization (HTTP ${organization.status}); check the token's Access permissions and that Zero Trust is turned on (docs/e2e.md).`,
      );
    }
    const domain = (organization.json as { result?: { auth_domain?: string } | null } | undefined)
      ?.result?.auth_domain;
    if (!domain) return { oneTimePins: [] };
    const providers = await this.list<{ id: string; type: string }>(
      `${account}/identity_providers`,
    );
    return {
      organization: domain,
      oneTimePins: providers.filter((p) => p.type === "onetimepin").map((p) => p.id),
    };
  }
}

// ---------------------------------------------------------------------------------------------
// GitHub: the throwaway repository's pull requests and deploy runs.

/** A completed deploy workflow run and its jobs' conclusions. */
export interface DeployRun {
  id: number;
  conclusion: string | null;
  jobs: DeployJob[];
}

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

  /**
   * Closes every open pull request and deletes every branch but `main`, so branches and pull
   * requests of an earlier run never change this one. Throws, after trying every branch, when
   * GitHub kept one.
   */
  async reset(): Promise<void> {
    const pulls = await this.call("GET", `/repos/${this.name}/pulls?state=open&per_page=100`);
    for (const pull of (pulls.json as { number: number }[] | undefined) ?? []) {
      await this.call("PATCH", `/repos/${this.name}/pulls/${pull.number}`, { state: "closed" });
    }
    const branches = await this.call("GET", `/repos/${this.name}/branches?per_page=100`);
    const kept: string[] = [];
    for (const branch of (branches.json as { name: string }[] | undefined) ?? []) {
      if (branch.name === "main") continue;
      const ref = branch.name.split("/").map(encodeURIComponent).join("/");
      const deleted = await this.call("DELETE", `/repos/${this.name}/git/refs/heads/${ref}`);
      if (deleted.status !== 204) kept.push(`${branch.name} (HTTP ${deleted.status})`);
    }
    if (kept.length > 0) throw new Error(`GitHub did not delete the branches ${kept.join(", ")}.`);
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

  /** Opens a pull request from `head` to `main` and returns its number. */
  async createPullRequest(title: string, head: string): Promise<number> {
    const opened = await this.call("POST", `/repos/${this.name}/pulls`, {
      title,
      head,
      base: "main",
      body: "Opened by an OpsCrew live test.",
    });
    const number = (opened.json as { number?: number } | undefined)?.number;
    if (opened.status !== 201 || number === undefined) {
      throw new Error(`GitHub did not open the pull request "${title}" (HTTP ${opened.status}).`);
    }
    return number;
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
  ): Promise<DeployRun> {
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
          (
            jobs.json as
              | {
                  jobs?: {
                    name: string;
                    conclusion: string | null;
                    steps?: { conclusion: string | null }[];
                  }[];
                }
              | undefined
          )?.jobs ?? [];
        return {
          id: run.id,
          conclusion: run.conclusion,
          jobs: list.map((job) => ({
            name: job.name,
            conclusion: job.conclusion,
            steps: (job.steps ?? []).map((step) => ({ conclusion: step.conclusion })),
          })),
        };
      }
      await sleep(20_000);
    }
    throw new Error(`The deploy workflow run did not finish within ${timeoutMs / 60_000} minutes.`);
  }

  /** Title, body and opening time of every pull request of the repository (any state). */
  async pullRequestTexts(): Promise<{ number: number; text: string; createdAt: Date }[]> {
    const texts: { number: number; text: string; createdAt: Date }[] = [];
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
        texts.push({
          number: pull.number,
          text: `${pull.title}\n${pull.body ?? ""}`,
          createdAt: new Date(pull.created_at),
        });
      }
      if (list.length < 100) break;
    }
    return texts;
  }
}

// ---------------------------------------------------------------------------------------------
// GitHub Container Registry: the blobs of a deployed image.

const MANIFEST_TYPES = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

interface RegistryManifest {
  manifests?: { digest: string }[];
  config?: { digest: string };
  layers?: { digest: string }[];
}

/**
 * The blobs of `image` (`ghcr.io/<repository>@sha256:<hex>`) GHCR no longer has, each as
 * `<digest> (HTTP <status>)`: the config and layers of every manifest its index lists (the
 * platform images and the attestations), asked for through the registry API with the login
 * `user`/`password` as a pull on a computer without any of its layers would, without downloading
 * them. A missing manifest throws.
 */
export async function ghcrMissingBlobs(
  image: string,
  user: string,
  password: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  const [, repository, digest] =
    /^ghcr\.io\/([a-z0-9._/-]+)@(sha256:[0-9a-f]{64})$/.exec(image) ?? [];
  if (repository === undefined || digest === undefined) {
    throw new Error(`${image} is not a GHCR digest reference.`);
  }
  const basic = Buffer.from(`${user}:${password}`).toString("base64");
  const login = await fetchImpl(
    `https://ghcr.io/token?service=ghcr.io&scope=${encodeURIComponent(`repository:${repository}:pull`)}`,
    {
      headers: { Authorization: `Basic ${basic}`, "User-Agent": "opscrew-e2e" },
      signal: AbortSignal.timeout(30_000),
    },
  );
  const token = login.ok ? ((await login.json()) as { token?: string }).token : undefined;
  if (token === undefined) {
    throw new Error(`GHCR refused the read token for ${repository} (HTTP ${login.status}).`);
  }
  const headers = { Authorization: `Bearer ${token}`, "User-Agent": "opscrew-e2e" };
  const v2 = `https://ghcr.io/v2/${repository}`;
  const manifest = async (ref: string): Promise<RegistryManifest> => {
    const got = await fetchImpl(`${v2}/manifests/${ref}`, {
      headers: { ...headers, Accept: MANIFEST_TYPES },
      signal: AbortSignal.timeout(30_000),
    });
    if (!got.ok)
      throw new Error(`GHCR has no manifest ${ref} of ${repository} (HTTP ${got.status}).`);
    return (await got.json()) as RegistryManifest;
  };
  const top = await manifest(digest);
  const images =
    top.manifests === undefined
      ? [top]
      : await Promise.all(top.manifests.map((child) => manifest(child.digest)));
  const blobs = new Set(
    images.flatMap((item) => [
      ...(item.config === undefined ? [] : [item.config.digest]),
      ...(item.layers ?? []).map((layer) => layer.digest),
    ]),
  );
  const missing: string[] = [];
  for (const blob of blobs) {
    // GHCR answers a blob with a redirect to its storage.
    const got = await fetchImpl(`${v2}/blobs/${blob}`, {
      method: "HEAD",
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    if (got.status !== 200 && (got.status < 300 || got.status >= 400)) {
      missing.push(`${blob} (HTTP ${got.status})`);
    }
  }
  return missing;
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

/** An HTTP answer: status, headers and body. */
export interface HttpAnswer {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/**
 * An HTTP or HTTPS request. Names are resolved through Cloudflare's public resolver (so a
 * just-changed DNS record is seen at once), except `localhost`. `insecure` accepts a self-signed
 * certificate and is allowed only for `localhost` (Portainer through the SSH tunnel). Rejects on
 * network errors and after `timeoutMs`.
 */
export function httpRequest(
  url: string,
  options: {
    method?: string;
    body?: string;
    headers?: Record<string, string>;
    insecure?: boolean;
    timeoutMs?: number;
  } = {},
): Promise<HttpAnswer> {
  const target = new URL(url);
  const local = target.hostname === "localhost" || target.hostname === "127.0.0.1";
  if (options.insecure === true && !local) {
    throw new Error("Only localhost may be reached without checking its certificate.");
  }
  const send = target.protocol === "http:" ? nodeHttpRequest : nodeHttpsRequest;
  return new Promise((resolve, reject) => {
    const req = send(
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

/**
 * Waits up to 5 minutes until `url` (a hostname behind Cloudflare Access) refuses a request
 * without the service token: 401 or 403, or a redirect to the Access login. Returns the status.
 */
export function waitForAccessRefusal(url: string): Promise<number> {
  return waitFor(`${new URL(url).hostname} behind Cloudflare Access`, minutes(5), async () => {
    const answer = await httpRequest(url);
    const location = String(answer.headers.location ?? "");
    return [401, 403].includes(answer.status) ||
      (answer.status >= 300 && answer.status < 400 && location.includes("cloudflareaccess.com"))
      ? answer.status
      : undefined;
  });
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
