import { digitaloceanConnector } from "@opscrew/connector-digitalocean";
import { hetznerConnector } from "@opscrew/connector-hetzner";
import type { VpsConnector, VpsProviderId } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import type { PhaseDeps } from "../context";
import { ownServerNotYet } from "./own";

/** Waits used by a connector's snapshot polling (tests inject fakes). */
export interface VpsConnectorOptions {
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

/**
 * The connector for a VPS provider, built from the phase's environment, fetch and redactor. Phases
 * use this instead of importing a provider connector, so adding a provider changes one place.
 * Throws for a server the user owns ({@link ownServerNotYet}) and for an unknown provider id, never
 * falling back to another provider.
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
  switch (id) {
    case "hetzner":
      return hetznerConnector(common);
    case "digitalocean":
      return digitaloceanConnector(common);
    case "own":
      throw ownServerNotYet();
    default:
      throw new OpsCrewError(
        "INVALID_INPUT",
        `OpsCrew does not know the server provider "${String(id satisfies never)}".`,
        {
          hint: "Use hetzner or digitalocean as the provider in opscrew/requirements.yaml and opscrew/plan.yaml.",
        },
      );
  }
}
