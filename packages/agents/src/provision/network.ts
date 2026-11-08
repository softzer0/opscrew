/**
 * The private network's host plans in provision (feature 018, ADR 0022): one per server of the
 * app, `app` first, each with the `network` and `network-filter` steps, shown with the server's
 * name and approved by its own hash.
 */
import type { HostFacts } from "@opscrew/connector-ssh-host";
import type { PhaseName, RemoteExec } from "@opscrew/contracts";
import type { DeployPlan } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { networkPlanInputs, networkPlanStep } from "../network";
import { approveAndApplyHostPlan, type HostAdapterApi, type HostPlanOutcome } from "../shared";

/** One of the app's servers, as its network host plan reaches it. */
export interface NetworkServer {
  /** `app`, or an extra server's name. */
  name: string;
  /** The login's shell: `deploy` on a server OpsCrew created, the admin login on the user's own. */
  remote: RemoteExec;
  /** What inspection found there just now. */
  facts: HostFacts;
  /** The host adapter's apply, with the root image bound on a server OpsCrew created. */
  apply: HostAdapterApi["apply"];
  /** Opens new SSH connections, for the host adapter after an SSH or firewall change. */
  verifyLogin: () => Promise<boolean>;
  /** The port sshd listens on (`networkSshPort`), which the network lets in on its interface. */
  sshPort: number;
  /** The server hosts this app alone (always so on a server OpsCrew created). */
  alone: boolean;
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
 * Each server's private network host plan (`networkHostPlan`, as drift plans it, with the endpoints
 * this computer knows), in `servers`' order. Each goes through {@link approveAndApplyHostPlan}:
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
  const inputs = await networkPlanInputs(deps, plan);
  for (const server of input.servers) {
    const step = networkPlanStep(deps, plan, server, inputs, {
      command,
      phase: input.phase,
      ...(input.planOnly === true ? { planOnly: true } : {}),
    });
    outcomes.set(server.name, await approveAndApplyHostPlan(deps, step));
  }
  return outcomes;
}
