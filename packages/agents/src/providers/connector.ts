import { digitaloceanConnector } from "@opscrew/connector-digitalocean";
import { hetznerConnector } from "@opscrew/connector-hetzner";
import type { VpsConnector, VpsProviderId } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import type { PhaseDeps } from "../context";
import { type OwnServerFacts, type OwnServerLogin, ownServerConnector } from "./own";

/** Waits used by a connector's snapshot polling (tests inject fakes), and a server the user owns. */
export interface VpsConnectorOptions {
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  /** `own` only: the inspected server, offered as the single unpriced option. */
  ownServer?: OwnServerFacts;
  /** `own` only: how OpsCrew logs in, described by `verifyCredentials`. */
  ownLogin?: OwnServerLogin;
}

/**
 * The connector for a VPS provider, built from the phase's environment, fetch and redactor. Phases
 * use this instead of importing a provider connector, so adding a provider changes one place.
 * A server the user owns gets {@link ownServerConnector} (no token, no API). Throws for an unknown
 * provider id, never falling back to another provider.
 */
export function vpsConnector(
  id: VpsProviderId,
  deps: Pick<PhaseDeps, "env" | "fetch" | "redactor" | "version">,
  options: VpsConnectorOptions = {},
): VpsConnector {
  const { ownServer, ownLogin, ...waits } = options;
  const common = {
    env: deps.env,
    fetch: deps.fetch,
    redactor: deps.redactor,
    version: deps.version,
    ...waits,
  };
  switch (id) {
    case "hetzner":
      return hetznerConnector(common);
    case "digitalocean":
      return digitaloceanConnector(common);
    case "own":
      return ownServerConnector({
        ...(ownServer !== undefined ? { facts: ownServer } : {}),
        ...(ownLogin !== undefined ? { login: ownLogin } : {}),
        ...(waits.now !== undefined ? { now: waits.now } : {}),
      });
    default:
      throw new OpsCrewError(
        "INVALID_INPUT",
        `OpsCrew does not know the server provider "${String(id satisfies never)}".`,
        {
          hint: "Use hetzner, digitalocean or own as the provider in opscrew/requirements.yaml and opscrew/plan.yaml.",
        },
      );
  }
}
