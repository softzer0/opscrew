/**
 * The tunnel connectors a `tunnel-token` rotation restarts with the tunnel's new token (025 plan.md
 * 8., research R11), through the paths provision uses: on a server (the user's own in tunnel mode
 * or with a Portainer subdomain, a cloud server with a Portainer or Beszel subdomain), the
 * connector's host plan step, a one-step host plan (`planTunnelToken`) approved by its hash, whose
 * token reaches the server only on the host adapter's standard input and a file only its owner
 * reads; in the user's Portainer, the stacks' values, through one stack plan approved by its hash.
 */
import { planTunnelToken } from "@opscrew/connector-ssh-host";
import { OpsCrewError } from "@opscrew/core";
import { keepNewerPins, renderTunnelConnectorCompose } from "@opscrew/iac-templates";
import { APP_SERVER, type DeployPlan } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { commandFlags } from "../environments/choice";
import { CLOUD_TUNNEL_DIR } from "../portainer/settings";
import { type PortainerStacksSetup, portainerStacksFor } from "../provision/portainer-flow";
import type { ProvisionServices } from "../provision/types";
import { committedText } from "../shared/files";
import { approveAndApplyHostPlan } from "../shared/host-plan";
import { networkServer, VPN_PHASE, type VpnServices } from "../vpn/servers";
import type { TunnelConnectors, TunnelModule } from "./infra";

/**
 * The connector of the app's tunnel on its server: `restart` inspects the app's server
 * (read-only), then applies the connector's one-step host plan with the new token, approved by its
 * hash, which recreates the connector (a server runs one, so the tunnel pauses for that restart).
 * `command` is the rotation's, named when a plan is refused or fails.
 */
export function serverTunnelConnectors(
  deps: PhaseDeps,
  plan: DeployPlan,
  input: { command: string; services?: Pick<VpnServices, "remote" | "host"> },
): TunnelConnectors {
  return {
    // The host plan has one step, the connector's: nothing else of the server's setup changes.
    check: async () => {},
    restart: async (tunnels) => {
      const own = plan.target.provider === "own";
      const words = own ? "your server" : "the app's server";
      for (const tunnel of tunnels) {
        if (tunnel.module !== "tunnel") {
          throw new Error(`A server runs no connector of the tunnel ${tunnel.module}.`);
        }
        const server = await networkServer(deps, plan, APP_SERVER, input.services ?? {}, VPN_PHASE);
        // The Compose file as provision renders it, with the newer pins of the committed one.
        const rendered = renderTunnelConnectorCompose(plan);
        const compose = keepNewerPins(
          await committedText(deps.paths.root, [rendered.path]),
          rendered.content,
        );
        deps.redactor.addLiteral(tunnel.token, "tunnel-token");
        await approveAndApplyHostPlan(deps, {
          plan: planTunnelToken({
            app: plan.app.name,
            runAs: own ? "root" : "login",
            connector: {
              ...(own ? {} : { dir: CLOUD_TUNNEL_DIR }),
              compose,
              tunnelId: tunnel.tunnelId,
            },
          }),
          remote: server.remote,
          apply: server.apply,
          verifyLogin: server.verifyLogin,
          title: `Give the Cloudflare Tunnel connector on ${words} its new token`,
          server: words,
          planOf: words,
          upToDate: `The Cloudflare Tunnel connector on ${words} has its new token; nothing changes.`,
          command: input.command,
          phase: VPN_PHASE,
          secrets: async () => ({ tunnelToken: tunnel.token }),
          applying: `Restarting the Cloudflare Tunnel connector on ${words} with the new token`,
        });
      }
    },
  };
}

/** The root module's output each stack reads a tunnel's token from. */
const TOKEN_OUTPUTS: Readonly<Record<TunnelModule, string>> = {
  tunnel: "tunnel_token",
  portainer_tunnel: "portainer_tunnel_token",
};

/**
 * The connectors in the user's Portainer: the app's stack's (web mode `tunnel`) and the one in
 * front of the webhook (redeploy `cloudflare`). `check` refuses while the stack plan made with the
 * values this computer keeps today has changes, which the rotation's approval must not carry;
 * `restart` makes that stack plan with the new tokens (`portainerStacksFor`, as provision sets the
 * stacks up), shows it, asks its approval by its hash (`stack-apply`) and applies it: Portainer
 * recreates the connectors, the tokens sent only to Portainer, bound by their fingerprints.
 * `stacksFor` (tests) stands in for `portainerStacksFor`.
 */
export function portainerTunnelConnectors(
  deps: PhaseDeps,
  plan: DeployPlan,
  input: {
    command: string;
    services?: ProvisionServices;
    stacksFor?: () => Promise<PortainerStacksSetup>;
  },
): TunnelConnectors {
  const stacksFor =
    input.stacksFor ??
    (() =>
      portainerStacksFor(deps, plan, input.services ?? {}, {
        phase: "provision",
        command: input.command,
      }));
  return {
    check: async () => {
      const current = await stacksFor();
      const planned = await current.stacks.plan(current.outputs);
      if (planned.changes === 0) return;
      const { root, environment, app } = deps.paths;
      throw new OpsCrewError(
        "PHASE_PRECONDITION",
        `The app's stacks in your Portainer have changes besides the rotation's (${planned.changes} ${planned.changes === 1 ? "change" : "changes"} with the values this computer keeps; the stack plan is shown above), so OpsCrew doesn't rotate the tunnel's token yet. Nothing was changed.`,
        {
          hint: `Run \`opscrew provision${await commandFlags(root, environment, app)}\` first so the stacks are as the plan says, then run the command again.`,
        },
      );
    },
    restart: async (tunnels) => {
      const setup = await stacksFor();
      const outputs = { ...setup.outputs };
      for (const tunnel of tunnels) {
        deps.redactor.addLiteral(tunnel.token, "tunnel-token");
        outputs[TOKEN_OUTPUTS[tunnel.module]] = tunnel.token;
      }
      await setup.stacks.step(outputs, { planOnly: false });
    },
  };
}
