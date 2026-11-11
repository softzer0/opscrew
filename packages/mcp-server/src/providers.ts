/**
 * The cloud server providers as the tools' texts name them, from the registry (ADR 0029), so a
 * provider added there is listed everywhere.
 */
import { listText, orText } from "@opscrew/core";
import { CLOUD_PROVIDERS } from "@opscrew/providers";

/** The cloud providers' ids, in the registry's order. */
export const CLOUD_IDS = CLOUD_PROVIDERS.map((provider) => provider.id);

/** The cloud providers' display names as a choice: `Hetzner Cloud or DigitalOcean`. */
export const CLOUD_NAMES = orText(CLOUD_PROVIDERS.map((provider) => provider.displayName));

/**
 * Each cloud provider's credential variables and its name: `HCLOUD_TOKEN for Hetzner Cloud`, or
 * every variable of a set all of which are needed: `A, B, C and D for Contabo`.
 */
export const CLOUD_CREDENTIALS = CLOUD_PROVIDERS.map(
  ({ credentials, displayName }) =>
    `${credentials.mode === "all" ? listText(credentials.envVars) : credentials.envVars[0]} for ${displayName}`,
).join(", ");
