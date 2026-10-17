import { CLOUDFLARE_TOKEN_PERMISSIONS } from "@opscrew/connector-cloudflare";

/**
 * Cloudflare token permissions a Cloudflare Tunnel with Access needs on top of
 * {@link CLOUDFLARE_TOKEN_PERMISSIONS} (research R3), named as in the dashboard's token builder.
 */
export const CLOUDFLARE_TUNNEL_PERMISSIONS = [
  "Account → Cloudflare Tunnel → Edit",
  "Account → Access: Apps and Policies → Edit",
  "Account → Access: Service Tokens → Edit",
  "Account → Access: Organizations, Identity Providers, and Groups → Edit",
] as const;

/** Every permission a plan with a Cloudflare Tunnel needs, for hints. */
export function tunnelTokenPermissions(): string {
  return [...CLOUDFLARE_TOKEN_PERMISSIONS, ...CLOUDFLARE_TUNNEL_PERMISSIONS].join(", ");
}
