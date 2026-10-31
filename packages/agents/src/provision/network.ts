/**
 * The private network's host plans in provision (feature 018, ADR 0022): one per server of the
 * app, `app` first, each with the `network` and `network-filter` steps, shown with the server's
 * name and approved by its own hash.
 */
import { type HostFacts, planNetwork } from "@opscrew/connector-ssh-host";
import type { PhaseName, RemoteExec } from "@opscrew/contracts";
import { OpsCrewError, plural } from "@opscrew/core";
import type { DeployPlan } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { networkSteps, publicEndpoints, serverNetworkInputs } from "../network";
import {
  approveAndApplyHostPlan,
  type HostAdapterApi,
  type HostPlanOutcome,
  readValidJson,
} from "../shared";
import { GeneratedValuesSchema, generatedValuesFile } from "../shared/app-secrets";

/** One of the app's servers, as its network host plan reaches it. */
export interface NetworkServer {
  /** `app`, or an extra server's name. */
  name: string;
  /** The login's shell: `deploy` on a server OpsCrew created, the admin login on the user's own. */
  remote: RemoteExec;
  /** What inspection found there just now. */
  facts: HostFacts;
  apply: HostAdapterApi["apply"];
  /** Opens new SSH connections, for the host adapter after an SSH or firewall change. */
  verifyLogin: () => Promise<boolean>;
  /** The login's SSH port, which the network lets in on its interface (22 on a cloud server). */
  sshPort: number;
  /** The server hosts this app alone (always so on a server OpsCrew created). */
  alone: boolean;
  /** The pinned image root steps run in when the login becomes root through Docker (cloud). */
  rootImage?: string;
}

/** {@link applyNetworkPlans}' input. */
export interface NetworkPlansInput {
  plan: DeployPlan;
  /** The app's servers in order, `app` first. */
  servers: readonly NetworkServer[];
  planOnly?: boolean;
  command: string;
  phase: PhaseName;
}

/**
 * Each server's private network host plan (`planNetwork`), in `servers`' order: its `network` step
 * from `networkSteps` (peers with the endpoints this computer knows), whose `localPorts` are the
 * TCP ports the app's services publish on that server's private address, and its
 * `network-filter` step for each port published there (on the app's server also the dashboards'
 * when it hosts this app alone and the network has devices), as drift plans them
 * (`serverNetworkInputs`). Each goes through {@link approveAndApplyHostPlan}:
 * shown with the server's name, approved by its own hash and applied. The server's private key
 * (the generated values' `network`) is passed only when the facts say the server lacks it or holds
 * another. With `planOnly` each is only shown and saved. Returns the outcomes by server name.
 * @throws OpsCrewError `PHASE_PRECONDITION`, before that server's plan is shown, when the server
 * needs its key and this computer does not have it.
 */
export async function applyNetworkPlans(
  deps: PhaseDeps,
  input: NetworkPlansInput,
): Promise<Map<string, HostPlanOutcome>> {
  const { plan, command } = input;
  const outcomes = new Map<string, HostPlanOutcome>();
  if (plan.network === undefined) return outcomes;
  const endpoints = await publicEndpoints(deps, plan);
  const keys =
    (await readValidJson(generatedValuesFile(deps), GeneratedValuesSchema))?.network ?? {};
  for (const server of input.servers) {
    const { name, facts } = server;
    const member = plan.network.members.find((m) => m.name === name);
    if (member === undefined) throw new Error(`Server "${name}" is not on the private network.`);
    const { published, localPorts } = serverNetworkInputs(plan, name, server.alone);
    const steps = networkSteps(plan, name, {
      endpoints,
      wireguardInterfaces: facts.wireguardInterfaces,
      published,
      sshPort: server.sshPort,
    });
    const hostPlan = planNetwork(
      facts,
      { app: plan.app.name, network: { ...steps.network, localPorts }, filter: steps.filter },
      command,
    );
    const held = facts.network?.interfaces.find((i) => i.name === steps.network.interface);
    const holds = held?.publicKey === member.publicKey;
    const key = holds ? undefined : keys[name];
    if (!holds && key === undefined) {
      throw new OpsCrewError(
        "PHASE_PRECONDITION",
        `Server ${name} needs its private network key, and this computer does not have it. Nothing on server ${name} was changed.`,
        {
          hint: "Put OpsCrew's generated values back from your recovery copy (`opscrew secrets restore`) or from the computer that ran `opscrew design`, then run the command again.",
        },
      );
    }
    if (key !== undefined) deps.redactor.addLiteral(key, "network-key");
    const changes = plural(hostPlan.steps.filter((s) => s.state === "change").length, "change");
    const { rootImage } = server;
    const outcome = await approveAndApplyHostPlan(deps, {
      plan: hostPlan,
      remote: server.remote,
      apply:
        rootImage === undefined
          ? server.apply
          : (remote, applied, options) => server.apply(remote, applied, { ...options, rootImage }),
      verifyLogin: server.verifyLogin,
      title: `Apply the private network's host plan to server ${name} (${changes})`,
      server: `server ${name}`,
      planOf: `server ${name}`,
      upToDate: `The private network on server ${name} is as planned; nothing on it changes.`,
      command,
      phase: input.phase,
      ...(input.planOnly === true ? { planOnly: true } : {}),
      secrets: async () => (key === undefined ? {} : { wireguardKey: key }),
      applying: `Setting up the private network on server ${name}`,
    });
    outcomes.set(name, outcome);
  }
  return outcomes;
}
