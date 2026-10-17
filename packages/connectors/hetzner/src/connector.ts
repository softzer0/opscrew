import type {
  ComputeCatalog,
  CredentialCheck,
  CredentialRequirement,
  FetchLike,
  ServerSnapshotApi,
  VpsConnector,
} from "@opscrew/contracts";
import { errorText, Redactor } from "@opscrew/core";
import { HetznerCatalog, StaticHetznerCatalog } from "./catalog";
import { HETZNER_TOKEN_HINT, HetznerClient } from "./client";
import { hetznerServerApi } from "./servers";

/** Credentials OpsCrew needs for Hetzner Cloud. */
export const HETZNER_CREDENTIALS: CredentialRequirement = {
  envVars: ["HCLOUD_TOKEN"],
  description:
    "A Hetzner Cloud project API token with Read & Write permission, created in the project that should hold your servers.",
  scopes: ["Read & Write"],
  createUrl: "https://console.hetzner.cloud/",
};

export interface HetznerConnectorOptions {
  env: Record<string, string | undefined>;
  fetch?: FetchLike;
  /** Shared redactor; a private one is created when omitted. The token is always registered. */
  redactor?: Redactor;
  baseUrl?: string;
  version?: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

/** The Hetzner connector plus access to its client and catalogue. */
export interface HetznerConnector extends VpsConnector {
  readonly id: "hetzner";
  /** True when `HCLOUD_TOKEN` is set (it may still be invalid). */
  readonly configured: boolean;
  /** Server lookup and snapshots, or `undefined` when `HCLOUD_TOKEN` is not set. */
  readonly servers: ServerSnapshotApi | undefined;
  /** Typed API client, or `undefined` when `HCLOUD_TOKEN` is not set. */
  readonly client: HetznerClient | undefined;
  /** Live catalogue when a token is set, otherwise the dated static catalogue. */
  catalog(): ComputeCatalog;
}

/** Creates the Hetzner Cloud connector: credential check, catalogue and server API. */
export function hetznerConnector(options: HetznerConnectorOptions): HetznerConnector {
  const token = options.env.HCLOUD_TOKEN?.trim() || undefined;
  const redactor = options.redactor ?? new Redactor();
  if (token !== undefined) redactor.addLiteral(token, "HCLOUD_TOKEN");
  const client =
    token === undefined
      ? undefined
      : new HetznerClient({
          token,
          ...(options.fetch && { fetch: options.fetch }),
          ...(options.baseUrl && { baseUrl: options.baseUrl }),
          ...(options.version && { version: options.version }),
          ...(options.sleep && { sleep: options.sleep }),
          now: () => (options.now ?? (() => new Date()))().getTime(),
        });
  let catalog: ComputeCatalog | undefined;

  return {
    id: "hetzner",
    displayName: "Hetzner Cloud",
    credentials: HETZNER_CREDENTIALS,
    configured: client !== undefined,
    client,
    servers: client === undefined ? undefined : hetznerServerApi(client),
    catalog: () => {
      catalog ??=
        client === undefined
          ? new StaticHetznerCatalog()
          : new HetznerCatalog(client, options.now ? { now: options.now } : {});
      return catalog;
    },
    async verifyCredentials(): Promise<CredentialCheck> {
      if (client === undefined) {
        return { ok: false, message: `HCLOUD_TOKEN is not set. ${HETZNER_TOKEN_HINT}` };
      }
      try {
        await client.verifyToken();
        return { ok: true, message: "The Hetzner Cloud API token works." };
      } catch (error) {
        const message = errorText(error, "Could not check the Hetzner Cloud API token.");
        return { ok: false, message: redactor.redact(message) };
      }
    },
  };
}
