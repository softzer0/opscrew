import type { PhaseName } from "@opscrew/contracts";
import { OpsCrewError, plural } from "@opscrew/core";
import { type DeployPlan, networkInterface } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import type { NetworkServer } from "../provision/network";
import { GeneratedValuesSchema, generatedValuesFile } from "../shared/app-secrets";
import { readValidJson } from "../shared/files";
import {
  type ApprovedHostPlan,
  applyApprovedHostPlan,
  approveHostPlan,
  type HostPlanOutcome,
  type HostPlanStep,
} from "../shared/host-plan";
import { publicEndpoints } from "./endpoints";
import { networkHostPlan } from "./host-plans";

/** What every server's network host plan reads on this computer. */
export interface NetworkPlanInputs {
  /** The servers' public addresses, by name (`publicEndpoints`). */
  endpoints: Record<string, string>;
  /** The servers' private keys, by name (the generated values' `network`). */
  keys: Record<string, string>;
}

/** The servers' public addresses and private keys the network's host plans read. */
export async function networkPlanInputs(
  deps: PhaseDeps,
  plan: DeployPlan,
): Promise<NetworkPlanInputs> {
  return {
    endpoints: await publicEndpoints(deps, plan),
    keys: (await readValidJson(generatedValuesFile(deps), GeneratedValuesSchema))?.network ?? {},
  };
}

/**
 * The private network's host plan of `server` (`networkHostPlan`, as drift plans it, with the
 * endpoints this computer knows) as a step to show, approve by its hash and apply, titled with the
 * server's name. The server's private key is passed only when its facts say it lacks it or holds
 * another, and registered with the redactor.
 * @throws OpsCrewError `PHASE_PRECONDITION` when the server needs its key and this computer does
 * not have it; Error when the server is not on the network.
 */
export function networkPlanStep(
  deps: PhaseDeps,
  plan: DeployPlan,
  server: NetworkServer,
  inputs: NetworkPlanInputs,
  run: { command: string; phase: PhaseName; planOnly?: boolean },
): HostPlanStep {
  const { name, facts } = server;
  const member = plan.network?.members.find((m) => m.name === name);
  if (member === undefined) throw new Error(`Server "${name}" is not on the private network.`);
  const hostPlan = networkHostPlan(
    plan,
    name,
    facts,
    { endpoints: inputs.endpoints, sshPort: server.sshPort, alone: server.alone },
    run.command,
  );
  const held = facts.network?.interfaces.find((i) => i.name === networkInterface(member));
  const holds = held?.publicKey === member.publicKey;
  const key = holds ? undefined : inputs.keys[name];
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
  return {
    plan: hostPlan,
    remote: server.remote,
    apply: server.apply,
    verifyLogin: server.verifyLogin,
    title: `Apply the private network's host plan to server ${name} (${changes})`,
    server: `server ${name}`,
    planOf: `server ${name}`,
    upToDate: `The private network on server ${name} is as planned; nothing on it changes.`,
    command: run.command,
    phase: run.phase,
    ...(run.planOnly === true ? { planOnly: true } : {}),
    secrets: async () => (key === undefined ? {} : { wireguardKey: key }),
    applying: `Setting up the private network on server ${name}`,
  };
}

/**
 * Each server's private network host plan ({@link networkPlanStep}), in `servers`' order, applied
 * together: every plan shown and each approved by its own hash first, then all applied one right
 * after the other, so links between servers that change together drop only for the seconds
 * between two applies. Returns the outcomes by server name.
 * @throws OpsCrewError before any plan is shown when a server needs its key and this computer
 * does not have it; `APPROVAL_REFUSED` when a plan is not approved, with none of them applied.
 */
export async function applyNetworkPlansTogether(
  deps: PhaseDeps,
  input: {
    plan: DeployPlan;
    servers: readonly NetworkServer[];
    command: string;
    phase: PhaseName;
  },
): Promise<Map<string, HostPlanOutcome>> {
  const { plan, command, phase } = input;
  const inputs = await networkPlanInputs(deps, plan);
  const steps = input.servers.map((server) => ({
    name: server.name,
    step: {
      ...networkPlanStep(deps, plan, server, inputs, { command, phase }),
      refused: {
        message: `Server ${server.name}'s private network host plan was not approved, so OpsCrew applied none of the servers' host plans, and nothing on them was changed`,
        hint: `Run \`${command}\` again when you are ready (in a script: with --approve and each host plan's hash shown).`,
      },
    },
  }));
  const approved: { name: string; step: HostPlanStep; approval: ApprovedHostPlan }[] = [];
  for (const { name, step } of steps) {
    approved.push({ name, step, approval: await approveHostPlan(deps, step) });
  }
  const outcomes = new Map<string, HostPlanOutcome>();
  for (const { name, step, approval } of approved) {
    outcomes.set(name, await applyApprovedHostPlan(deps, step, approval));
  }
  return outcomes;
}
