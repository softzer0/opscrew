/**
 * Self-hosted monitoring in `opscrew destroy` (US5 #4, US7 #2–#3). The environment's own servers
 * lose what monitoring installed with them: a server OpsCrew created is deleted (the monitoring
 * server too, by its typed name), and on the user's own the teardown host plan removes Alloy and
 * the stack this app owns. What lives elsewhere is handled here: the owner of a shared monitoring
 * server is refused while others send to it, and a sender leaves that server.
 */
import type { ApprovalRecord } from "@opscrew/contracts";
import type { DeployPlan } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { commandFlags } from "../environments/choice";
import { requireNoSenders } from "../monitoring/repository";
import { otherServer } from "../network/owner";
import { leaveMonitoringServer } from "../provision/monitoring";
import { monitoringValues } from "../provision/secrets";
import { COMMAND } from "./common";
import type { DestroyServices } from "./types";

/**
 * Stops before any check or change while other deployed environments send their figures and logs
 * to this environment's monitoring server (FR-2024), naming them.
 * @throws OpsCrewError `PHASE_PRECONDITION` saying to turn monitoring off there first.
 */
export async function requireNoMonitoringSenders(deps: PhaseDeps, plan: DeployPlan) {
  const flag = await commandFlags(deps.paths.root, deps.paths.environment, deps.paths.app);
  await requireNoSenders(deps, plan, {
    to: "this environment's monitoring server",
    after: "Deleting it would leave them sending nowhere.",
    again: `\`${COMMAND}${flag}\``,
  });
}

/**
 * A sender leaves the monitoring server another environment owns, over that owner's login, after
 * the typed confirmations and before anything of this environment is deleted: the stack without
 * this environment's network, then its interface and filter there, each approved by its hash
 * (`leaveMonitoringServer`), then says how to join it again. Returns their approvals; none when
 * this computer recorded no such server for the environment, or its owner was torn down.
 */
export async function leaveSharedMonitoring(
  deps: PhaseDeps,
  plan: DeployPlan,
  services: DestroyServices,
): Promise<ApprovalRecord[]> {
  const owner = (await monitoringValues(deps))?.owner;
  const flag = await commandFlags(deps.paths.root, deps.paths.environment, deps.paths.app);
  const outcomes = await leaveMonitoringServer(deps, plan, {
    services: { remote: services.remote, serverHost: services.serverHost },
    ownRun: undefined,
    extraOwn: [],
    planOnly: false,
    command: `${COMMAND}${flag}`,
    phase: "provision",
  });
  if (owner !== undefined && outcomes.length > 0) {
    deps.reporter.info(
      `This environment no longer sends to ${otherServer(owner)}; \`opscrew provision${flag}\` adds it again if you stop here.`,
    );
  }
  return outcomes.flatMap((outcome) => (outcome.approval === undefined ? [] : [outcome.approval]));
}
