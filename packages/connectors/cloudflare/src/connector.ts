import type { AnyToolDefinition, Connector, CredentialCheck, FetchLike } from "@opscrew/contracts";
import { Redactor } from "@opscrew/core";
import { z } from "zod";
import { CLOUDFLARE_TOKEN_PERMISSIONS, CloudflareClient } from "./client";

export interface CloudflareConnectorOptions {
  env: Record<string, string | undefined>;
  fetch: FetchLike;
  redactor?: Redactor;
  baseUrl?: string;
  version?: string;
  sleep?: (ms: number) => Promise<void>;
}

export interface CloudflareConnector extends Connector {
  /** Present when `CLOUDFLARE_API_TOKEN` is set. */
  readonly client: CloudflareClient | undefined;
}

/** Cloudflare connector: credential checks and read-only tools for agents and the MCP server. */
export function cloudflareConnector(options: CloudflareConnectorOptions): CloudflareConnector {
  const token = options.env.CLOUDFLARE_API_TOKEN?.trim() || undefined;
  const redactor = options.redactor ?? new Redactor();
  if (token) redactor.addLiteral(token, "cloudflare-token");
  const client = token
    ? new CloudflareClient({
        token,
        fetch: options.fetch,
        ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
        ...(options.version ? { version: options.version } : {}),
        ...(options.sleep ? { sleep: options.sleep } : {}),
      })
    : undefined;

  const safe = async (run: () => Promise<unknown>) => {
    try {
      return { text: redactor.redact(JSON.stringify(await run(), null, 2)) };
    } catch (error) {
      return {
        text: redactor.redact(error instanceof Error ? error.message : String(error)),
        isError: true,
      };
    }
  };
  const requireClient = () => {
    if (!client) throw new Error("CLOUDFLARE_API_TOKEN is not set.");
    return client;
  };

  const tools: AnyToolDefinition[] = [
    {
      name: "cloudflare_find_zone",
      description: "Find the Cloudflare zone that contains a domain (read-only).",
      inputSchema: z.object({ domain: z.string().min(3) }),
      mutates: false,
      handler: (input: { domain: string }) => safe(() => requireClient().findZone(input.domain)),
    },
    {
      name: "cloudflare_list_dns_records",
      description: "List DNS records of a Cloudflare zone, optionally for one name (read-only).",
      inputSchema: z.object({ zoneId: z.string().min(1), name: z.string().optional() }),
      mutates: false,
      handler: (input: { zoneId: string; name?: string }) =>
        safe(() =>
          requireClient().listDnsRecords(input.zoneId, input.name ? { name: input.name } : {}),
        ),
    },
  ];

  return {
    id: "cloudflare",
    displayName: "Cloudflare",
    credentials: {
      envVars: ["CLOUDFLARE_API_TOKEN"],
      description: "Cloudflare API token limited to the zone that holds your domain.",
      scopes: [...CLOUDFLARE_TOKEN_PERMISSIONS],
      createUrl: "https://dash.cloudflare.com/profile/api-tokens",
    },
    client,
    async verifyCredentials(): Promise<CredentialCheck> {
      if (!client) return { ok: false, message: "CLOUDFLARE_API_TOKEN is not set." };
      try {
        return await client.verifyToken();
      } catch (error) {
        return {
          ok: false,
          message: redactor.redact(error instanceof Error ? error.message : String(error)),
        };
      }
    },
    tools: () => tools,
  };
}
