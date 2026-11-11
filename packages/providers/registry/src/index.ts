/**
 * The built-in cloud server providers (ADR 0029): the one place OpsCrew reads provider facts from.
 * Every definition is validated when this module loads.
 */
import type { CloudProviderDefinition } from "@opscrew/contracts";
import { listText, OpsCrewError } from "@opscrew/core";
import { definition as contabo } from "@opscrew/provider-contabo";
import { definition as digitalocean } from "@opscrew/provider-digitalocean";
import { definition as hetzner } from "@opscrew/provider-hetzner";
import { validateCloudProvider } from "./validate";

/** The built-in cloud server providers, in order: Hetzner, DigitalOcean, Contabo. */
export const CLOUD_PROVIDERS: readonly CloudProviderDefinition[] = [
  hetzner,
  digitalocean,
  contabo,
].map(validateCloudProvider);

/**
 * Each cloud provider's credential variables and its name, for help texts: the first variable
 * (`HCLOUD_TOKEN for Hetzner Cloud`), or every variable of a set all of which are needed
 * (`A, B, C and D for Contabo`).
 */
export const CLOUD_CREDENTIALS: string = CLOUD_PROVIDERS.map(
  ({ credentials, displayName }) =>
    `${credentials.mode === "all" ? listText(credentials.envVars) : credentials.envVars[0]} for ${displayName}`,
).join(", ");

/** The definition of the cloud server provider `id`; throws `INVALID_INPUT` for any other id. */
export function cloudProvider(id: string): CloudProviderDefinition {
  const found = CLOUD_PROVIDERS.find((provider) => provider.id === id);
  if (found !== undefined) return found;
  throw new OpsCrewError("INVALID_INPUT", `OpsCrew does not create servers on "${id}".`, {
    hint: `Choose one of its cloud providers: ${listText(CLOUD_PROVIDERS.map((provider) => provider.id))}.`,
  });
}
