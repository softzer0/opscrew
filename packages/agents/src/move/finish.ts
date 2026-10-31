import { OpsCrewError } from "@opscrew/core";
import { IMAGES } from "@opscrew/iac-templates";
import {
  APP_SERVER,
  type DeployPlan,
  DeployPlanSchema,
  readArtifact,
  servicesOn,
} from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { withPlacement } from "../provision/servers";
import type { ProvisionServices } from "../provision/types";
import { serverWords, writePlanIfChanged } from "../shared";
import { failureDetail, switchedEnv } from "./app-env";
import { moveShell } from "./shells";
import { FINISH_COMMAND, MOVE_COMMAND } from "./window";

/**
 * The fixed command that deletes the old copy of `service` on its server, as `deploy`: its
 * container when one is left, then its data folder `/srv/data/<app>/<service>`, as root in a
 * throwaway container of the pinned Caddy image with no network (the folder belongs to the
 * service's own user, and deploy has no sudo).
 */
function deleteOldCopy(plan: DeployPlan, service: string): string {
  const app = plan.app.name;
  return [
    `ids=$(docker ps -aq --filter label=com.docker.compose.project=${app} --filter label=com.docker.compose.service=${service})`,
    `{ [ -z "$ids" ] || docker rm -f $ids > /dev/null; }`,
    `docker run --rm --network none --user 0:0 --entrypoint rm -v /srv/data/${app}:/d ${IMAGES.caddy.ref} -rf /d/${service}`,
  ].join(" && ");
}

/**
 * `plan` once the moved service's old copy is gone: no `move`, `deployment.placement` as the
 * services are placed, and the server it left out of `servers` and the network when it runs
 * nothing else (the next provision deletes it, after its own typed confirmation).
 */
function finished(plan: DeployPlan, from: string, leaves: boolean): DeployPlan {
  const { move: _done, ...rest } = plan;
  if (!leaves) return withPlacement(rest);
  const { servers: _servers, ...others } = rest;
  const servers = (plan.servers ?? []).filter((server) => server.name !== from);
  return withPlacement(
    DeployPlanSchema.parse({
      ...others,
      ...(servers.length > 0 ? { servers } : {}),
      ...(plan.network !== undefined
        ? {
            network: {
              ...plan.network,
              members: plan.network.members.filter((member) => member.name !== from),
            },
          }
        : {}),
    }),
  );
}

/**
 * `opscrew provision --finish-move`: deletes the old copy of the service a move switched to another
 * server (FR-1809), after an `allowDestroy` approval and the typed service name: its container
 * when one is left and its data folder on `move.from`, by a fixed command. Then `move` is cleared
 * and `deployment.placement` updated in `opscrew/plan.yaml`; a server that runs nothing else
 * leaves `servers`, and the next provision deletes it after its typed name.
 * @throws OpsCrewError `PHASE_PRECONDITION`, before any change, without a move, while its step
 * is not `switched`, or while the app's settings on its server use the old copy;
 * `APPROVAL_REFUSED` without the approval and the typed name; `COMMAND_FAILED`
 * when the deletion fails (the plan keeps the move).
 */
export async function finishMove(
  deps: PhaseDeps,
  services: Pick<ProvisionServices, "remote">,
): Promise<DeployPlan> {
  const plan = await readArtifact("plan", deps.paths.files.plan);
  const { move } = plan;
  if (move === undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      "No service is moving between the app's servers, so there is no old copy to delete.",
      { hint: "Run `opscrew status` to see where each service runs." },
    );
  }
  const { service } = move;
  const [from, to] = [serverWords(move.from), serverWords(move.to)];
  if (move.step !== "switched") {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `The app still uses ${service} on ${from}: its move to ${to} has not switched yet, so OpsCrew keeps it. Nothing was deleted.`,
      {
        hint: `Run \`${MOVE_COMMAND}\` to continue the move; once the app runs on the new copy, run \`${FINISH_COMMAND}\`.`,
      },
    );
  }
  // The app's settings on its server decide: the old copy goes only once the app uses the new one.
  const app = await moveShell(deps, plan, services, APP_SERVER);
  const env = await switchedEnv(deps, app, plan, move);
  if (!env.switched && env.after !== env.before) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `The app's settings (app.env) on the app's server use ${service}'s old copy on ${from}, not the one on ${to}, so OpsCrew keeps the old copy. Nothing was deleted.`,
      {
        hint: `Run \`${MOVE_COMMAND}\`: it moves the app to the new copy first. Then run \`${FINISH_COMMAND}\`.`,
      },
    );
  }
  const leaves = move.from !== APP_SERVER && servicesOn(plan, move.from).length === 0;
  const next = finished(plan, move.from, leaves);
  const command = deleteOldCopy(plan, service);
  const approval = await deps.approvals.request({
    kind: "remote-exec",
    title: `Delete the old copy of ${service} and its data on ${from}`,
    details: [
      `${service} runs on ${to} now. Its old copy on ${from} is deleted for good: its container, if one is left, and its data folder /srv/data/${plan.app.name}/${service}.`,
      `On ${from}, as deploy:`,
      `  ${command}`,
      `In opscrew/plan.yaml, move is cleared and deployment.placement records ${service} on ${move.to}.`,
      ...(leaves
        ? [
            `Server ${move.from} runs nothing else, so it leaves servers: the next \`${MOVE_COMMAND}\` deletes it, after you type its name.`,
          ]
        : []),
    ].join("\n"),
    allowDestroy: true,
    confirmPhrase: service,
  });
  if (!approval.approved) {
    throw new OpsCrewError(
      "APPROVAL_REFUSED",
      `The old copy of ${service} on ${from} was not deleted${approval.reason !== undefined ? `: ${approval.reason}` : ""}.`,
      { hint: `Run \`${FINISH_COMMAND}\` again and type ${service} to confirm.` },
    );
  }
  deps.reporter.step(`Deleting the old copy of ${service} on ${from}`);
  const shell = await moveShell(deps, plan, services, move.from);
  const result = await shell.remote.run(command, { timeoutMs: 5 * 60_000 });
  if (result.exitCode !== 0) {
    throw new OpsCrewError(
      "COMMAND_FAILED",
      `Could not delete the old copy of ${service} on ${from}${failureDetail(result, deps.redactor)}.`,
      {
        hint: `Check that ${from} is reachable and Docker runs there, then run \`${FINISH_COMMAND}\` again.`,
      },
    );
  }
  await deps.audit.append({
    kind: "remote-exec",
    actor: "opscrew",
    action: `delete the old copy of ${service}`,
    phase: "provision",
    target: `server ${move.from}`,
    decision: "approved",
    detail: `its container and its data folder; ${service} runs on ${move.to}`,
  });
  await writePlanIfChanged(deps, next);
  deps.reporter.success(`Deleted the old copy of ${service} on ${from}; it runs on ${to}.`);
  deps.reporter.info(
    leaves
      ? `Run \`${MOVE_COMMAND}\` to publish the plan: it deletes server ${move.from}, which runs nothing now, after you type its name.`
      : `Run \`${MOVE_COMMAND}\` to publish the plan.`,
  );
  return next;
}
