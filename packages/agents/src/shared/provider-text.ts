import type { ProviderProfile } from "../providers";

/**
 * The provider's console for hints, for example `DigitalOcean console
 * (https://cloud.digitalocean.com/)`; write "in the …" before it.
 */
export function providerConsole(profile: Pick<ProviderProfile, "displayName" | "consoleUrl">) {
  return `${profile.displayName} console (${profile.consoleUrl})`;
}
