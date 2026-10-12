import type {
  AnyToolDefinition,
  ComputeCatalog,
  CredentialCheck,
  CredentialRequirement,
  ServerSnapshotApi,
  ToolDefinition,
  VpsConnector,
} from "@opscrew/contracts";
import { isUserFacingError, Redactor } from "@opscrew/core";
import { z } from "zod";
import { HetznerCatalog, StaticHetznerCatalog } from "./catalog";
import { type FetchLike, HetznerClient } from "./client";
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

/** Creates the Hetzner Cloud connector (credential check and read-only catalogue tools). */
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
  const getCatalog = (): ComputeCatalog => {
    catalog ??=
      client === undefined
        ? new StaticHetznerCatalog()
        : new HetznerCatalog(client, options.now ? { now: options.now } : {});
    return catalog;
  };

  const sourceNote = (): string =>
    client === undefined
      ? `Static Hetzner price table dated ${new StaticHetznerCatalog().asOf.slice(0, 10)} (HCLOUD_TOKEN not set; availability not checked). Prices are net EUR excluding VAT and IPv4.`
      : "Live data from the Hetzner Cloud API. Prices are net EUR excluding VAT and IPv4.";

  const run = async (produce: () => Promise<unknown>) => {
    try {
      const data = await produce();
      return { text: redactor.redact(`${sourceNote()}\n${JSON.stringify(data, null, 2)}`) };
    } catch (error) {
      const message = isUserFacingError(error)
        ? `${error.message}${error.hint ? ` ${error.hint}` : ""}`
        : `Unexpected error: ${error instanceof Error ? error.message : String(error)}`;
      return { text: redactor.redact(message), isError: true };
    }
  };

  const listLocations: ToolDefinition<z.ZodObject<Record<string, never>>> = {
    name: "hetzner_list_locations",
    description: "List Hetzner Cloud locations (id, city, country, network zone). Read-only.",
    inputSchema: z.object({}),
    mutates: false,
    handler: () => run(() => getCatalog().listLocations()),
  };

  const offersInput = z.object({
    location: z
      .string()
      .optional()
      .describe("Hetzner location id such as nbg1, fsn1, hel1, ash, hil or sin. Omit for all."),
  });
  const listOffers: ToolDefinition<typeof offersInput> = {
    name: "hetzner_list_offers",
    description:
      "List Hetzner Cloud server offers with vCPU, memory, disk, monthly net price, availability and deprecation for one or all locations. Read-only.",
    inputSchema: offersInput,
    mutates: false,
    handler: (input) => run(() => getCatalog().listOffers(input.location)),
  };

  return {
    id: "hetzner",
    displayName: "Hetzner Cloud",
    credentials: HETZNER_CREDENTIALS,
    configured: client !== undefined,
    client,
    servers: client === undefined ? undefined : hetznerServerApi(client),
    catalog: getCatalog,
    async verifyCredentials(): Promise<CredentialCheck> {
      if (client === undefined) {
        return {
          ok: false,
          message:
            "HCLOUD_TOKEN is not set. Create a Read & Write API token in the Hetzner Cloud Console (your project → Security → API tokens) and set it as HCLOUD_TOKEN.",
        };
      }
      try {
        await client.verifyToken();
        return { ok: true, message: "The Hetzner Cloud API token works." };
      } catch (error) {
        const message = isUserFacingError(error)
          ? `${error.message}${error.hint ? ` ${error.hint}` : ""}`
          : "Could not check the Hetzner Cloud API token.";
        return { ok: false, message: redactor.redact(message) };
      }
    },
    tools(): AnyToolDefinition[] {
      return [listLocations, listOffers];
    },
  };
}
