/**
 * The app's servers as `opscrew vpn` changes them (feature 018, US3): the servers a device peers
 * with, and how each one's private network host plan reaches it.
 */
import {
  applyHostPlan,
  type HostFacts,
  inspectHost,
  otherActiveApps,
} from "@opscrew/connector-ssh-host";
import type { PhaseName, RemoteExec } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { IMAGES } from "@opscrew/iac-templates";
import { type DeployPlan, onOneServer } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { hasPublicAddress, type KeyMaker, type ReadNetworkServices } from "../network";
import type { NetworkServer } from "../provision/network";
import { type HostAdapterApi, hasDeployment, serverLogin, serverRemote } from "../shared";
import { appServers } from "../status/servers";

/** The phase `opscrew vpn` audits its host plans under. */
export const VPN_PHASE: PhaseName = "secure";

/** The services of `opscrew vpn`; each defaults to the real one, fakes in tests. */
export interface VpnServices {
  /** The login's shell on a server, by server name (default `serverRemote`). */
  remote?: (server: string) => Promise<RemoteExec>;
  /** Inspection and apply (default the host adapter's `inspectHost` and `applyHostPlan`). */
  host?: {
    inspect(remote: RemoteExec, options: { rootImage?: string }): Promise<HostFacts>;
    apply: HostAdapterApi["apply"];
  };
  /** Makes WireGuard key pairs (default Node's x25519). */
  keys?: KeyMaker;
  /** Reads WireGuard on the servers for `vpn list` (default the host adapter's `readWireGuard`). */
  readWireGuard?: ReadNetworkServices["readWireGuard"];
}

/**
 * Stops before any change unless the app runs on servers that exist: a cloud server or the user's
 * own (devices join no other target's network), deployed.
 */
export function requireServers(plan: DeployPlan): void {
  if (!onOneServer(plan.target.provider)) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `Devices join the private network of an app on a cloud server or your own server, and this app runs on ${plan.target.provider}. Nothing was changed.`,
      {
        hint: "Use `opscrew vpn` with an app deployed to Hetzner, DigitalOcean or your own server.",
      },
    );
  }
  if (!hasDeployment(plan)) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      "The app has no servers yet, so no device can join their private network. Nothing was changed.",
      { hint: "Run `opscrew provision` first, then add the device." },
    );
  }
}

/** The app's servers a device peers with: those with a public address, `app` first. */
export function deviceServers(plan: DeployPlan): string[] {
  return appServers(plan).filter((name) => hasPublicAddress(plan, name));
}

/**
 * How the private network's host plan reaches the server `name`, inspected read-only now: the
 * login's shell (the admin login on the user's own server, `deploy` on one OpsCrew created, which
 * becomes root through Docker in the pinned Caddy image), with the login's SSH port. The server
 * hosts this app alone when OpsCrew created it, or when no other OpsCrew app is active on it.
 */
export async function networkServer(
  deps: PhaseDeps,
  plan: DeployPlan,
  name: string,
  services: VpnServices,
): Promise<NetworkServer> {
  const login = await serverLogin(deps, plan, name);
  const remote = (await services.remote?.(name)) ?? (await serverRemote(deps, plan, name));
  const host = services.host ?? { inspect: inspectHost, apply: applyHostPlan };
  const rootImage = login.own ? undefined : IMAGES.caddy.ref;
  deps.reporter.step(`Inspecting server ${name} (read-only)`);
  const facts = await host.inspect(remote, rootImage === undefined ? {} : { rootImage });
  await deps.audit.append({
    kind: "remote-exec",
    actor: "opscrew",
    action: `inspect host as ${login.own ? "the admin login" : "deploy"} (read-only)`,
    phase: VPN_PHASE,
    target: `server ${name}`,
    decision: "allow",
  });
  return {
    name,
    remote,
    facts,
    apply: host.apply,
    // The network's steps change no SSH setting the host adapter guards.
    verifyLogin: async () => true,
    sshPort: login.port,
    alone: !login.own || otherActiveApps(facts.apps, plan.app.name).length === 0,
    ...(rootImage !== undefined ? { rootImage } : {}),
  };
}
