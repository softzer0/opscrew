import { CLOUDFLARE_API, CLOUDFLARE_TOKEN_PERMISSIONS } from "@opscrew/connector-cloudflare";
import { OpsCrewError } from "@opscrew/core";
import { zeroTrustAuthDomain } from "@opscrew/iac-templates";
import { z } from "zod";
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

/** The read-only Zero Trust lookup provision makes before rendering Cloudflare Access. */
export interface ZeroTrustApi {
  /**
   * The account's Zero Trust organization (its team domain), or `undefined` when the account has
   * none yet. Read-only.
   */
  organization(accountId: string): Promise<{ authDomain: string } | undefined>;
}

const EnvelopeSchema = z.looseObject({
  success: z.boolean().optional(),
  errors: z.array(z.looseObject({ code: z.number().optional(), message: z.string() })).optional(),
  result: z.unknown().optional(),
});

const OrganizationSchema = z.looseObject({ auth_domain: z.string().min(1) });

/** Cloudflare's answer when an account has no Zero Trust organization yet. */
const NO_ORGANIZATION = /not (?:been )?found|does not exist|no (?:zero trust )?organi[sz]ation/i;

/**
 * Cloudflare's answer (HTTP 403, error 9999) when the account never turned on Zero Trust; checked
 * before the permission errors so the user is not sent to fix a token that is fine.
 */
const ACCESS_NOT_ENABLED = /access\.api\.error\.not_enabled|access is not enabled/i;

function permissionHint(): string {
  return `Create a Cloudflare API token at https://dash.cloudflare.com/profile/api-tokens with ${tunnelTokenPermissions()}, set CLOUDFLARE_API_TOKEN to it, then run the command again.`;
}

/**
 * The Zero Trust lookup over Cloudflare's API (`GET /accounts/{id}/access/organizations`) with
 * `CLOUDFLARE_API_TOKEN`. Read-only; the token never appears in errors.
 */
export function cloudflareZeroTrust(
  deps: Pick<PhaseDeps, "env" | "fetch" | "redactor" | "version">,
): ZeroTrustApi {
  return {
    async organization(accountId) {
      const token = deps.env.CLOUDFLARE_API_TOKEN?.trim();
      if (!token) {
        throw new OpsCrewError(
          "CREDENTIALS_MISSING",
          "No Cloudflare token found: set CLOUDFLARE_API_TOKEN.",
          {
            hint: permissionHint(),
          },
        );
      }
      deps.redactor.addLiteral(token, "CLOUDFLARE_API_TOKEN");
      let response: Response;
      try {
        response = await deps.fetch(
          `${CLOUDFLARE_API}/accounts/${encodeURIComponent(accountId)}/access/organizations`,
          {
            headers: {
              Accept: "application/json",
              Authorization: `Bearer ${token}`,
              "User-Agent": `opscrew/${deps.version}`,
            },
          },
        );
      } catch (error) {
        throw new OpsCrewError(
          "PROVIDER_ERROR",
          "OpsCrew could not reach Cloudflare to read the account's Zero Trust settings.",
          {
            hint: "Check your internet connection, then run the command again.",
            cause: error,
          },
        );
      }
      const body = EnvelopeSchema.safeParse(await response.json().catch(() => ({})));
      const envelope = body.success ? body.data : {};
      if ((envelope.errors ?? []).some((e) => ACCESS_NOT_ENABLED.test(e.message))) {
        throw new OpsCrewError(
          "PHASE_PRECONDITION",
          "Cloudflare Access is not turned on for this Cloudflare account yet. OpsCrew needs it to protect the SSH hostname in tunnel mode and the Portainer subdomain. Nothing was changed.",
          {
            hint: "Open the Zero Trust dashboard at https://one.dash.cloudflare.com/, choose a team name and the Free plan, then run the command again.",
          },
        );
      }
      if (response.status === 404) return undefined;
      if (response.status === 401 || response.status === 403) {
        throw new OpsCrewError(
          "CREDENTIALS_INVALID",
          "Cloudflare refused to show the account's Zero Trust settings, so the Cloudflare token is probably missing a permission the tunnel and Access need.",
          { hint: permissionHint() },
        );
      }
      const errors = (envelope.errors ?? []).map((e) => e.message).join("; ");
      if (envelope.success === true && response.status < 400) {
        // Only an absent or null result means "no organization"; anything else must name its team
        // domain, or OpsCrew cannot tell whose organization it is (fail closed).
        if (envelope.result === undefined || envelope.result === null) return undefined;
        const organization = OrganizationSchema.safeParse(envelope.result);
        if (organization.success) return { authDomain: organization.data.auth_domain };
        throw new OpsCrewError(
          "PROVIDER_ERROR",
          "Cloudflare answered with a Zero Trust organization OpsCrew could not read (it names no team domain), so OpsCrew cannot tell whether to create one. Nothing was changed.",
          { hint: "Run the command again in a minute. If it keeps failing, report it." },
        );
      }
      if (NO_ORGANIZATION.test(errors)) return undefined;
      throw new OpsCrewError(
        "PROVIDER_ERROR",
        deps.redactor.redact(
          `Cloudflare could not read the account's Zero Trust settings: ${errors || `HTTP ${response.status}`}.`,
        ),
        { hint: `Run the command again in a minute. If it keeps failing: ${permissionHint()}` },
      );
    },
  };
}

/**
 * Whether this configuration creates (and then keeps managing) the account's Zero Trust
 * organization, which Cloudflare Access needs: yes when the account has none, when the last
 * rendered configuration created it (`previous`, from the committed `terraform.tfvars.json`, so a
 * re-run never removes it), or when its team domain is the one OpsCrew gives an organization it
 * creates for this zone. An organization the user set up stays theirs.
 */
export async function createZeroTrustOrganization(input: {
  api: ZeroTrustApi;
  accountId: string;
  zone: string;
  previous?: boolean;
}): Promise<boolean> {
  const organization = await input.api.organization(input.accountId);
  if (organization === undefined) return true;
  if (input.previous === true) return true;
  return organization.authDomain.toLowerCase() === zeroTrustAuthDomain(input.zone).toLowerCase();
}
