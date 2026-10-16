import type { CloudflareClient } from "@opscrew/connector-cloudflare";

/**
 * Which one-time PIN login method the Portainer Access application uses
 * (`RenderContext.cloudflare.oneTimePinIdentityProviderId`): `undefined` lets the configuration
 * create (and keep) its own.
 *
 * - The last render named one (`previous`, from the committed `terraform.tfvars.json`): keep it.
 * - The last render already served Portainer on a subdomain without naming one: the state holds
 *   OpsCrew's own (`one_time_pin[0]`), so leave it unset or the next plan would destroy it.
 * - Otherwise ask Cloudflare (read-only): an account has at most one such method, so an existing
 *   one (set up by the user or another project) is reused; none means OpsCrew creates it.
 */
export async function oneTimePinIdentityProvider(input: {
  previous: Record<string, unknown> | undefined;
  accountId: string;
  api: Pick<CloudflareClient, "accessIdentityProviders">;
}): Promise<string | undefined> {
  const named = input.previous?.one_time_pin_identity_provider_id;
  if (typeof named === "string" && named !== "") return named;
  const served = input.previous?.portainer_hostname;
  if (typeof served === "string" && served !== "") return undefined;
  const providers = await input.api.accessIdentityProviders(input.accountId);
  return providers.find((provider) => provider.type === "onetimepin")?.id;
}
