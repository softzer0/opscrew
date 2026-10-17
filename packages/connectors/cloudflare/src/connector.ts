import type { Connector, CredentialCheck, FetchLike } from "@opscrew/contracts";
import { errorText, Redactor } from "@opscrew/core";
import {
  CLOUDFLARE_REGISTRAR_PERMISSIONS,
  CLOUDFLARE_TOKEN_PAGE,
  CLOUDFLARE_TOKEN_PERMISSIONS,
  CloudflareClient,
} from "./client";

export interface CloudflareConnectorOptions {
  env: Record<string, string | undefined>;
  fetch: FetchLike;
  redactor?: Redactor;
  baseUrl?: string;
  version?: string;
  sleep?: (ms: number) => Promise<void>;
  /** Send registrar calls to Cloudflare's registrar sandbox. */
  registrarSandbox?: boolean;
}

export interface CloudflareConnector extends Connector {
  /** Present when `CLOUDFLARE_API_TOKEN` is set. */
  readonly client: CloudflareClient | undefined;
}

/** Cloudflare connector: the credential check and the API client. */
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
        ...(options.registrarSandbox ? { registrarSandbox: true } : {}),
      })
    : undefined;

  return {
    id: "cloudflare",
    displayName: "Cloudflare",
    credentials: {
      envVars: ["CLOUDFLARE_API_TOKEN"],
      description:
        "Cloudflare API token with the zone permissions below for the zone that holds your domain. Buying domains with OpsCrew is optional and also needs the permissions marked optional: then the zone permissions must cover all zones of the account, because a token limited to the zones you have today cannot set up a domain you buy (or add the new domain's zone to the token right after buying it).",
      scopes: [
        ...CLOUDFLARE_TOKEN_PERMISSIONS,
        ...CLOUDFLARE_REGISTRAR_PERMISSIONS.map((p) => `${p} (optional, for buying domains)`),
      ],
      createUrl: CLOUDFLARE_TOKEN_PAGE,
    },
    client,
    async verifyCredentials(): Promise<CredentialCheck> {
      if (!client) return { ok: false, message: "CLOUDFLARE_API_TOKEN is not set." };
      try {
        return await client.verifyToken();
      } catch (error) {
        return { ok: false, message: redactor.redact(errorText(error)) };
      }
    },
  };
}
