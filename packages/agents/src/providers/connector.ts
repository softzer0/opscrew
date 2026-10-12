import { digitaloceanConnector } from "@opscrew/connector-digitalocean";
import { hetznerConnector } from "@opscrew/connector-hetzner";
import type { VpsConnector, VpsProviderId } from "@opscrew/contracts";
import type { PhaseDeps } from "../context";

/** Waits used by a connector's snapshot polling (tests inject fakes). */
export interface VpsConnectorOptions {
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

/**
 * The connector for a VPS provider, built from the phase's environment, fetch and redactor. Phases
 * use this instead of importing a provider connector, so adding a provider changes one place.
 */
export function vpsConnector(
  id: VpsProviderId,
  deps: Pick<PhaseDeps, "env" | "fetch" | "redactor" | "version">,
  options: VpsConnectorOptions = {},
): VpsConnector {
  const common = {
    env: deps.env,
    fetch: deps.fetch,
    redactor: deps.redactor,
    version: deps.version,
    ...options,
  };
  return id === "digitalocean" ? digitaloceanConnector(common) : hetznerConnector(common);
}
