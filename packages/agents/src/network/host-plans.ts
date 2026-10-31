import {
  type HostFacts,
  type HostPlan,
  planNetwork,
  planPublicSsh,
} from "@opscrew/connector-ssh-host";
import { type DeployPlan, networkInterface } from "@opscrew/plan-schema";
import { serverNetworkInputs } from "./inputs";
import { networkSteps, type ServerNetworkFacts } from "./steps";

/**
 * The private network's host plan of the server `name` (`planNetwork`), as provision and drift
 * plan it from the server's facts: its `network` step from `networkSteps` (peers with `endpoints`,
 * SSH let in on `sshPort`), whose `localPorts` are the TCP ports the app's services publish on its
 * private address, and its `network-filter` step for each port published there, the dashboards'
 * too on the app's server when it hosts this app `alone` (`serverNetworkInputs`).
 * @throws Error when the plan has no network or the server is not on it.
 */
export function networkHostPlan(
  plan: DeployPlan,
  name: string,
  facts: HostFacts,
  input: Pick<ServerNetworkFacts, "endpoints" | "sshPort"> & { alone: boolean },
  command: string,
): HostPlan {
  const { published, localPorts } = serverNetworkInputs(plan, name, input.alone);
  const steps = networkSteps(plan, name, {
    endpoints: input.endpoints,
    wireguardInterfaces: facts.wireguardInterfaces,
    published,
    sshPort: input.sshPort,
  });
  return planNetwork(
    facts,
    { app: plan.app.name, network: { ...steps.network, localPorts }, filter: steps.filter },
    command,
  );
}

/**
 * The `public-ssh` host plan of the server `name` (`planPublicSsh`) on its network interface:
 * public SSH on `sshPort` closed, or opened (`open`) to `allowedCidrs`.
 * @throws Error when the server is not on the plan's private network.
 */
export function publicSshHostPlan(
  plan: Pick<DeployPlan, "app" | "network">,
  name: string,
  facts: HostFacts,
  input: {
    open: boolean;
    allowedCidrs: string[];
    sshPort: number;
    /** The server is one OpsCrew created (not the user's own). */
    cloudServer: boolean;
    command: string;
  },
): HostPlan {
  const member = plan.network?.members.find((m) => m.name === name);
  if (member === undefined) throw new Error(`Server "${name}" is not on the private network.`);
  const { open, allowedCidrs, sshPort, cloudServer, command } = input;
  return planPublicSsh(
    facts,
    {
      app: plan.app.name,
      publicSsh: { open, interface: networkInterface(member), allowedCidrs, sshPort, cloudServer },
    },
    command,
  );
}
