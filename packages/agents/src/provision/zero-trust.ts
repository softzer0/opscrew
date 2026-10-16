import { CLOUDFLARE_TOKEN_PERMISSIONS, CloudflareClient } from "@opscrew/connector-cloudflare";
import { OpsCrewError } from "@opscrew/core";
import { zeroTrustAuthDomain } from "@opscrew/iac-templates";
import type { PhaseDeps } from "../context";

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

/**
 * The read-only Cloudflare Access lookups made before rendering Access: the account's Zero Trust
 * organization and its login methods (a `CloudflareClient` or a test fake).
 */
export type ZeroTrustApi = Pick<CloudflareClient, "accessOrganization" | "accessIdentityProviders">;

/** Cloudflare's client over `CLOUDFLARE_API_TOKEN` (registered with the redactor) for the Access lookups. */
export function cloudflareZeroTrust(
  deps: Pick<PhaseDeps, "env" | "fetch" | "redactor" | "version">,
): ZeroTrustApi {
  const token = deps.env.CLOUDFLARE_API_TOKEN?.trim();
  if (!token) {
    throw new OpsCrewError(
      "CREDENTIALS_MISSING",
      "No Cloudflare token found: set CLOUDFLARE_API_TOKEN.",
      {
        hint: `Create a Cloudflare API token at https://dash.cloudflare.com/profile/api-tokens with ${tunnelTokenPermissions()}, set CLOUDFLARE_API_TOKEN to it, then run the command again.`,
      },
    );
  }
  deps.redactor.addLiteral(token, "CLOUDFLARE_API_TOKEN");
  return new CloudflareClient({ token, fetch: deps.fetch, version: deps.version });
}

/**
 * Whether this configuration creates (and then keeps managing) the account's Zero Trust
 * organization, which Cloudflare Access needs: yes when the account has none, when the last
 * rendered configuration created it (`previous`, from the committed `terraform.tfvars.json`, so a
 * re-run never removes it), or when its team domain is the one OpsCrew gives an organization it
 * creates for this zone. An organization the user set up stays theirs.
 */
export async function createZeroTrustOrganization(input: {
  api: Pick<ZeroTrustApi, "accessOrganization">;
  accountId: string;
  zone: string;
  previous?: boolean;
}): Promise<boolean> {
  const organization = await input.api.accessOrganization(input.accountId);
  if (organization === undefined) return true;
  if (input.previous === true) return true;
  return organization.authDomain.toLowerCase() === zeroTrustAuthDomain(input.zone).toLowerCase();
}
