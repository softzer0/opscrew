import type {
  AppServer,
  ComputeCatalog,
  CredentialCheck,
  CredentialRequirement,
  FetchLike,
  ServerSnapshotApi,
  SnapshotRequest,
  VpsConnector,
} from "@opscrew/contracts";
import { errorText, OpsCrewError, Redactor, realSleep } from "@opscrew/core";
import { DigitalOceanCatalog, StaticDigitalOceanCatalog } from "./catalog";
import {
  DIGITALOCEAN_SCOPES,
  DIGITALOCEAN_TOKEN_URL,
  type DigitalOceanAccount,
  DigitalOceanClient,
  type DigitalOceanSnapshot,
  SCOPE_HINT,
} from "./client";

/** Credentials OpsCrew needs for DigitalOcean: one custom-scoped API token. */
export const DIGITALOCEAN_CREDENTIALS: CredentialRequirement = {
  envVars: ["DIGITALOCEAN_TOKEN", "DIGITALOCEAN_ACCESS_TOKEN"],
  description:
    "A DigitalOcean personal access token with custom scopes (only the ones listed), created in the team that should hold your Droplets.",
  scopes: [...DIGITALOCEAN_SCOPES],
  createUrl: DIGITALOCEAN_TOKEN_URL,
};

/** Tag every OpsCrew-created Droplet carries. */
const MANAGED_TAG = "managed-by:opscrew";
/** Tag naming the app a Droplet belongs to. */
const appTag = (app: string) => `opscrew-app:${app}`;
const ACCOUNT_URL = "https://cloud.digitalocean.com/account";
const DEFAULT_SNAPSHOT_TIMEOUT_MS = 15 * 60_000;
/** Extra reads of the snapshot list after the action completes (the list can lag behind). */
const SNAPSHOT_LOOKUP_RETRIES = 3;
const SNAPSHOT_LOOKUP_POLL_MS = 5_000;

export interface DigitalOceanConnectorOptions {
  env: Record<string, string | undefined>;
  fetch?: FetchLike;
  /** Shared redactor; a private one is created when omitted. The token is always registered. */
  redactor?: Redactor;
  baseUrl?: string;
  version?: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

/** The DigitalOcean connector plus access to its client. */
export interface DigitalOceanConnector extends VpsConnector {
  readonly id: "digitalocean";
  /** Typed API client, or `undefined` when no token is set. */
  readonly client: DigitalOceanClient | undefined;
}

/**
 * Creates the DigitalOcean connector: credential check, live (or dated static) catalogue, and
 * Droplet lookup and snapshots. The token comes from `DIGITALOCEAN_TOKEN`, else
 * `DIGITALOCEAN_ACCESS_TOKEN`, and is registered with the redactor.
 */
export function digitaloceanConnector(
  options: DigitalOceanConnectorOptions,
): DigitalOceanConnector {
  const found = readToken(options.env);
  const redactor = options.redactor ?? new Redactor();
  if (found !== undefined) redactor.addLiteral(found.token, found.envVar);
  const now = options.now ?? (() => new Date());
  const client =
    found === undefined
      ? undefined
      : new DigitalOceanClient({
          token: found.token,
          ...(options.fetch && { fetch: options.fetch }),
          ...(options.baseUrl && { baseUrl: options.baseUrl }),
          ...(options.version && { version: options.version }),
          ...(options.sleep && { sleep: options.sleep }),
          now: () => now().getTime(),
        });

  let catalog: ComputeCatalog | undefined;

  return {
    id: "digitalocean",
    displayName: "DigitalOcean",
    credentials: DIGITALOCEAN_CREDENTIALS,
    configured: client !== undefined,
    client,
    servers: client === undefined ? undefined : serverApi(client, options.sleep ?? realSleep),
    catalog: () => {
      catalog ??=
        client === undefined
          ? new StaticDigitalOceanCatalog()
          : new DigitalOceanCatalog(client, options.now ? { now: options.now } : {});
      return catalog;
    },
    async verifyCredentials(): Promise<CredentialCheck> {
      if (client === undefined) {
        return {
          ok: false,
          message: `DIGITALOCEAN_TOKEN is not set. ${SCOPE_HINT}`,
        };
      }
      let account: DigitalOceanAccount;
      try {
        account = await client.getAccount();
      } catch (error) {
        const message = errorText(error, "Could not check the DigitalOcean API token.");
        return { ok: false, message: redactor.redact(message) };
      }
      return redactor.redactDeep(accountCheck(account));
    },
  };
}

function readToken(
  env: Record<string, string | undefined>,
): { token: string; envVar: string } | undefined {
  for (const envVar of DIGITALOCEAN_CREDENTIALS.envVars) {
    const token = env[envVar]?.trim();
    if (token) return { token, envVar };
  }
  return undefined;
}

/** Turns the account into a credential check; never mentions the account's email address. */
function accountCheck(account: DigitalOceanAccount): CredentialCheck {
  const identity = identityOf(account);
  const status = withoutEmail(account.status_message?.trim() ?? "", account.email);
  const reason = status ? `: ${status}` : ".";
  if (account.status === "locked") {
    return {
      ok: false,
      identity,
      message: `The DigitalOcean account is locked${reason} Resolve it in the DigitalOcean control panel (${ACCOUNT_URL}), then try again.`,
    };
  }
  if (account.email_verified === false) {
    return {
      ok: false,
      identity,
      message: `The DigitalOcean account's email address is not verified. Verify it from DigitalOcean's email or the control panel (${ACCOUNT_URL}), then try again.`,
    };
  }
  if (account.status === "active") {
    return { ok: true, identity, message: "The DigitalOcean API token works." };
  }
  if (account.status === "warning") {
    return {
      ok: true,
      identity,
      message: `The DigitalOcean API token works, but DigitalOcean shows a warning on the account${reason} Check ${ACCOUNT_URL}.`,
    };
  }
  return {
    ok: true,
    identity,
    message: `The DigitalOcean API token works; DigitalOcean reports the account status "${account.status}"${reason} Check ${ACCOUNT_URL} if provisioning fails.`,
  };
}

/** The team name, or a neutral label; never the email address. */
function identityOf(account: DigitalOceanAccount): string {
  const team = account.team?.name?.trim();
  if (team && !team.includes("@")) return team;
  return account.team ? "team account" : "personal account";
}

function withoutEmail(text: string, email: string | null | undefined): string {
  return email ? text.split(email).join("your email address") : text;
}

/** Droplet lookup by OpsCrew's tags and snapshots through Droplet actions. */
function serverApi(
  client: DigitalOceanClient,
  sleep: (ms: number) => Promise<void>,
): ServerSnapshotApi {
  return {
    async findAppServers(app: string): Promise<AppServer[]> {
      const droplets = await client.listDropletsByTag(appTag(app));
      return droplets
        .filter((droplet) => droplet.tags?.includes(MANAGED_TAG) === true)
        .map((droplet) => ({ id: droplet.id, name: droplet.name, status: droplet.status }));
    },

    async snapshotServer(
      serverId: string,
      request: SnapshotRequest,
    ): Promise<{ snapshotId: string }> {
      if (!/^\d+$/.test(serverId)) {
        throw new OpsCrewError("INVALID_INPUT", `Not a DigitalOcean Droplet id: ${serverId}.`, {
          hint: "Pass the numeric Droplet id reported by findAppServers.",
        });
      }
      const action = await client.snapshotDroplet(serverId, request.name);
      const done = await client.waitForAction(action.id, {
        timeoutMs: request.timeoutMs ?? DEFAULT_SNAPSHOT_TIMEOUT_MS,
      });
      const startedAt = Date.parse(done.started_at ?? action.started_at ?? "");
      let snapshot: DigitalOceanSnapshot | undefined;
      for (let attempt = 0; ; attempt++) {
        const snapshots = await client.listDropletSnapshots(serverId);
        snapshot = newest(
          snapshots.filter(
            (s) => s.name === request.name && !createdBefore(s.created_at, startedAt),
          ),
        );
        if (snapshot !== undefined || attempt >= SNAPSHOT_LOOKUP_RETRIES) break;
        await sleep(SNAPSHOT_LOOKUP_POLL_MS);
      }
      if (snapshot === undefined) {
        // The action completed, so the snapshot most likely exists (and is billed). Taking another
        // one would add a second snapshot, so the hint never suggests simply trying again.
        throw new OpsCrewError(
          "PROVIDER_ERROR",
          `DigitalOcean finished the snapshot of Droplet ${serverId}, but OpsCrew could not find a snapshot named "${request.name}" in the Droplet's snapshot list. The snapshot was most likely created.`,
          {
            hint: "Check the Droplet's Snapshots tab in the DigitalOcean control panel (https://cloud.digitalocean.com/droplets) before taking another snapshot.",
          },
        );
      }
      return { snapshotId: snapshot.id };
    },
  };
}

/** True when both times are known and the snapshot was created before the action started. */
function createdBefore(createdAt: string | null | undefined, startedAt: number): boolean {
  const created = Date.parse(createdAt ?? "");
  return !Number.isNaN(created) && !Number.isNaN(startedAt) && created < startedAt;
}

/** The most recently created snapshot (the last listed one when dates are missing). */
function newest(snapshots: DigitalOceanSnapshot[]): DigitalOceanSnapshot | undefined {
  let best: DigitalOceanSnapshot | undefined;
  let bestTime = Number.NEGATIVE_INFINITY;
  for (const snapshot of snapshots) {
    const time = Date.parse(snapshot.created_at ?? "");
    const value = Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
    if (best === undefined || value >= bestTime) {
      best = snapshot;
      bestTime = value;
    }
  }
  return best;
}
