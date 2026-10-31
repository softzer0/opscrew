import { OpsCrewError } from "@opscrew/core";
import { DEPLOY_SECRETS, deploySecretName, edgeProxy } from "@opscrew/iac-templates";
import { APP_SERVER, type DeployPlan } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { setupGitHub } from "../provision/credentials";
import type { ProvisionServices } from "../provision/types";
import { isAppHealthy } from "../retarget/server-ops";
import { requireGitRepo, serverWords } from "../shared";
import { switchedEnv } from "./app-env";
import { resumeDeploys } from "./deploys";
import { moveShell, runningServices } from "./shells";
import { FINISH_COMMAND, finishSwitch, MOVE_COMMAND, moveWindow, saveMove } from "./window";

export { finishMove } from "./finish";

/**
 * Moves a live service between the app's servers (`plan.move`, FR-1809), resumable at each step;
 * provision calls it once everything else is set up:
 * - `started`: the rendered files run the service on both servers, and the deploy brings its new
 *   copy up, empty, on `move.to`. Until the new copy runs there, it says to merge the deployment
 *   files and run provision again; then the step is `deployed`.
 * - `deployed`: the maintenance window ({@link moveWindow}) takes the app to the new copy, and the
 *   step is `switched`.
 * - `switched`: the next render drops the old copy's container; `opscrew provision --finish-move`
 *   deletes its data. When the app answers, a deploy pause an interrupted window left is cleared;
 *   when it does not, the switch is finished (a window stopped before the app ran on the new copy).
 *
 * Returns the plan as written to `opscrew/plan.yaml`.
 * @throws OpsCrewError when the window is refused or fails (the app back on the old copy, or kept
 * on the new one once its settings use it); `PHASE_PRECONDITION`, changing nothing, at `switched`
 * when the app's settings on its server use the old copy again (both copies may hold writes).
 */
export async function runMove(
  deps: PhaseDeps,
  input: { plan: DeployPlan; services: ProvisionServices },
): Promise<DeployPlan> {
  const { services } = input;
  let { plan } = input;
  let move = plan.move;
  if (move === undefined) return plan;
  const [from, to] = [serverWords(move.from), serverWords(move.to)];
  const shell = (name: string) => moveShell(deps, plan, services, name);
  if (move.step === "switched") {
    const app = await shell(APP_SERVER);
    const env = await switchedEnv(deps, app, plan, move);
    if (!env.switched && env.after !== env.before) {
      // Copying again would drop what the app wrote to the new copy since the switch.
      throw new OpsCrewError(
        "PHASE_PRECONDITION",
        `${move.service} moved to ${to}, but the app's settings (app.env) on the app's server use its old copy on ${from} again: both copies may now hold writes the other lacks, so OpsCrew changes nothing.`,
        {
          hint: `To keep ${move.service} on ${to}, put the app's settings back on it (a deploy writes them from the GitHub secret ${deploySecretName(plan, DEPLOY_SECRETS.appEnv)}, which holds its address), then run \`${MOVE_COMMAND}\` again.`,
        },
      );
    }
    if (await isAppHealthy(app.remote, plan.app.port, plan.app.healthPath, edgeProxy(plan))) {
      // A window an earlier run was stopped in must not leave the deploys paused.
      const github = await setupGitHub(deps, await requireGitRepo(deps), services);
      await resumeDeploys(deps, github, plan);
      deps.reporter.info(
        `${move.service} runs on ${to}, and its old copy waits, stopped, on ${from}. Run \`${FINISH_COMMAND}\` to delete it, after you type ${move.service}.`,
      );
      return plan;
    }
    const run = { deps, plan, move, services, app };
    return finishSwitch({ ...run, from: await shell(move.from), to: await shell(move.to) }, env);
  }
  const target = await shell(move.to);
  if (move.step === "started") {
    if (!(await runningServices(target, plan)).includes(move.service)) {
      deps.reporter.info(
        `${move.service} moves to ${to} once the deploy has started its new copy there: merge the pull request with the deployment files, wait for the deploy to succeed, then run \`${MOVE_COMMAND}\` again.`,
      );
      return plan;
    }
    move = { ...move, step: "deployed" };
    plan = await saveMove(deps, plan, move);
    await deps.audit.append({
      kind: "phase",
      actor: "opscrew",
      action: "move deployed",
      phase: "provision",
      target: `server ${move.to}`,
      detail: `the new copy of ${move.service} runs on ${move.to}`,
    });
  }
  return moveWindow({
    deps,
    plan,
    move,
    services,
    app: await shell(APP_SERVER),
    from: await shell(move.from),
    to: target,
  });
}

/**
 * Before provision stores the deploy secrets, while a move waits for its switch (at `started` too:
 * the committed plan often says so): the app's settings on its server say where the app is, so
 * when an earlier window already switched them there, the plan records `switched` first, and
 * `OPSCREW_APP_ENV` and every later render use the new address (never the old copy's while the
 * server runs on the new one). Returns the plan, unchanged otherwise; the caller writes it once
 * the secret is stored.
 */
export async function recordSwitchedMove(
  deps: PhaseDeps,
  plan: DeployPlan,
  services: Pick<ProvisionServices, "remote">,
): Promise<DeployPlan> {
  const { move } = plan;
  if (move === undefined || move.step === "switched") return plan;
  const app = await moveShell(deps, plan, services, APP_SERVER);
  if (!(await switchedEnv(deps, app, plan, move)).switched) return plan;
  deps.reporter.info(
    `The app's settings on its server already use ${move.service} on ${serverWords(move.to)}: an earlier maintenance window switched them, so the move is recorded as switched.`,
  );
  await deps.audit.append({
    kind: "phase",
    actor: "opscrew",
    action: "move switched",
    phase: "provision",
    target: `server ${move.to}`,
    detail: `the app's settings on its server already use ${move.service} on ${move.to}`,
  });
  return { ...plan, move: { ...move, step: "switched" } };
}
