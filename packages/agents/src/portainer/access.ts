import { CLOUDFLARE_API } from "@opscrew/connector-cloudflare";
import { OpsCrewError } from "@opscrew/core";
import { z } from "zod";
import type { PhaseDeps } from "../context";
import { tunnelTokenPermissions } from "../provision/zero-trust";

/** The read-only Cloudflare Access lookup the Portainer subdomain needs. */
export interface AccessLoginMethodsApi {
  /** Id of the account's one-time PIN login method, or `undefined` when it has none. */
  oneTimePin(accountId: string): Promise<string | undefined>;
}

const ProvidersSchema = z.looseObject({
  success: z.boolean().optional(),
  errors: z.array(z.looseObject({ message: z.string() })).optional(),
  result: z
    .array(z.looseObject({ id: z.string().min(1), type: z.string() }))
    .nullable()
    .optional(),
});

/**
 * {@link AccessLoginMethodsApi} over Cloudflare's API
 * (`GET /accounts/{id}/access/identity_providers`) with `CLOUDFLARE_API_TOKEN`. Read-only; the
 * token never appears in errors.
 */
export function cloudflareAccessLoginMethods(
  deps: Pick<PhaseDeps, "env" | "fetch" | "redactor" | "version">,
): AccessLoginMethodsApi {
  const hint = `Create a Cloudflare API token at https://dash.cloudflare.com/profile/api-tokens with ${tunnelTokenPermissions()}, set CLOUDFLARE_API_TOKEN to it, then run the command again.`;
  return {
    async oneTimePin(accountId) {
      const token = deps.env.CLOUDFLARE_API_TOKEN?.trim();
      if (!token) {
        throw new OpsCrewError(
          "CREDENTIALS_MISSING",
          "No Cloudflare token found: set CLOUDFLARE_API_TOKEN.",
          { hint },
        );
      }
      deps.redactor.addLiteral(token, "CLOUDFLARE_API_TOKEN");
      let response: Response;
      try {
        response = await deps.fetch(
          `${CLOUDFLARE_API}/accounts/${encodeURIComponent(accountId)}/access/identity_providers`,
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
          "OpsCrew could not reach Cloudflare to read the account's Access login methods.",
          { hint: "Check your internet connection, then run the command again.", cause: error },
        );
      }
      if (response.status === 401 || response.status === 403) {
        throw new OpsCrewError(
          "CREDENTIALS_INVALID",
          "Cloudflare refused to show the account's Access login methods, so the Cloudflare token is probably missing a permission Cloudflare Access needs.",
          { hint },
        );
      }
      const body = ProvidersSchema.safeParse(await response.json().catch(() => ({})));
      if (!body.success || body.data.success !== true || response.status >= 400) {
        const errors = body.success ? (body.data.errors ?? []).map((e) => e.message) : [];
        throw new OpsCrewError(
          "PROVIDER_ERROR",
          deps.redactor.redact(
            `Cloudflare could not list the account's Access login methods: ${errors.join("; ") || `HTTP ${response.status}`}.`,
          ),
          { hint: `Run the command again in a minute. If it keeps failing: ${hint}` },
        );
      }
      return (body.data.result ?? []).find((provider) => provider.type === "onetimepin")?.id;
    },
  };
}

/**
 * Which one-time PIN login method the Portainer Access application uses
 * (`RenderContext.cloudflare.oneTimePinIdentityProviderId`): `undefined` lets the configuration
 * create (and keep) its own.
 *
 * - The last render named one (`previous`, from the committed `terraform.tfvars.json`): keep it.
 * - The last render already served Portainer on a subdomain without naming one: the state holds
 *   OpsCrew's own (`one_time_pin[0]`), so leave it unset or the next plan would destroy it.
 * - Otherwise ask Cloudflare: an account has at most one such method, so an existing one (set up
 *   by the user or another project) is reused; none means OpsCrew creates it.
 */
export async function oneTimePinIdentityProvider(input: {
  previous: Record<string, unknown> | undefined;
  accountId: string;
  api: AccessLoginMethodsApi;
}): Promise<string | undefined> {
  const named = input.previous?.one_time_pin_identity_provider_id;
  if (typeof named === "string" && named !== "") return named;
  const served = input.previous?.portainer_hostname;
  if (typeof served === "string" && served !== "") return undefined;
  return input.api.oneTimePin(input.accountId);
}
